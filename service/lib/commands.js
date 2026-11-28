'use strict';

const {
  effectiveIds,
  isIdAllowed,
  isPrivateChat,
} = require('./allowlist');
const {
  formatStatus,
  formatSessions,
  formatDigest,
  formatHelp,
  formatStartHelp,
  formatPaired,
  formatAlreadyPaired,
  formatPairInvalid,
  formatSendSuccess,
  formatNewSession,
  formatStopResult,
  formatLeadNewBlocked,
  formatLeadPaused,
  formatLeadTargetOnly,
  formatReplySent,
  formatNoTarget,
  formatInvalidCommand,
  formatError,
} = require('./format');
const { normalizePairCode } = require('./ids');
const { safeError } = require('./log');

const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const parseCommand = (text) => {
  const value = String(text ?? '').trim();
  if (!value.startsWith('/')) return null;
  const [raw, ...rest] = value.split(/\s+/);
  const command = raw.toLowerCase().replace(/@[a-z0-9_]+$/i, '');
  return { command, args: rest, rest: value.slice(raw.length).trim() };
};

/**
 * `/send <target> <text>` where <target> may be a number, an id, an id prefix, or a
 * quoted title. The quoted form is what makes multi-word titles usable.
 */
const splitTarget = (args) => {
  if (!args.length) return { target: '', text: '' };
  const joined = args.join(' ');
  const quoted = /^"([^"]+)"\s+([\s\S]+)$/.exec(joined);
  if (quoted) return { target: quoted[1], text: quoted[2].trim() };
  const singleQuoted = /^'([^']+)'\s+([\s\S]+)$/.exec(joined);
  if (singleQuoted) return { target: singleQuoted[1], text: singleQuoted[2].trim() };
  return { target: args[0], text: args.slice(1).join(' ').trim() };
};

const splitStopTarget = (args) => {
  if (!args.length) return '';
  const joined = args.join(' ');
  const quoted = /^"([^"]+)"$/.exec(joined) ?? /^'([^']+)'$/.exec(joined);
  return quoted ? quoted[1] : args[0];
};

const START_ERRORS = {
  NO_DIRECTORY: 'Open a project in OpenChamber first, then try /new again.',
  NO_MODEL: 'No model is selected for new sessions. Pick one in OpenChamber settings, then try again.',
  NOT_GRANTED: 'Session control is not granted to Telegram Desk. Approve it in OpenChamber.',
  TOO_MANY_PROMPTS: 'OpenChamber limits a service to 60 prompts an hour. Try again later.',
  HOST_UNAVAILABLE: 'OpenChamber did not answer. Try again.',
};

const startErrorMessage = (error) => START_ERRORS[error?.code]
  ?? safeError(error).message
  ?? 'Could not start a session.';

const createCommands = ({
  store,
  host,
  opencode,
  sessionEvents,
  answerEngine,
  logger,
  getSettings = () => ({}),
  clock = Date.now,
}) => {
  const chatWindows = new Map();
  const withinChatRate = (chatId, limit = 20, windowMs = 60_000) => {
    const now = clock();
    const key = String(chatId);
    const attempts = (chatWindows.get(key) ?? []).filter((at) => at > now - windowMs);
    if (attempts.length >= limit) {
      chatWindows.set(key, attempts);
      return false;
    }
    attempts.push(now);
    chatWindows.set(key, attempts);
    return true;
  };

  const currentAllowlist = () => {
    const settings = getSettings() ?? {};
    const pairedIds = store.state.pairedIds;
    const settingsIds = settings.settingsAllowlist ?? [];
    return {
      settingsIds,
      pairedIds,
      effective: effectiveIds(settingsIds, pairedIds),
    };
  };

  const isAllowed = ({ userId, chatId }) => isIdAllowed(currentAllowlist().effective, { userId, chatId });

  const mergeSessions = async () => {
    const map = new Map();
    if (opencode?.available) {
      try {
        for (const session of await opencode.listSessions()) map.set(session.id, session);
      } catch (error) {
        logger?.debug('Could not list OpenCode sessions', { code: error?.code, status: error?.status });
      }
    }
    for (const session of Object.values(store.state.sessionRegistry)) {
      if (!session?.sessionId || map.has(session.sessionId)) continue;
      map.set(session.sessionId, {
        id: session.sessionId,
        title: session.title ?? null,
        parentId: session.parentId ?? null,
        directory: session.directory ?? null,
        updatedAt: session.updatedAt ?? 0,
      });
    }
    return [...map.values()];
  };

  const listSessions = async ({ includeSubagents = false, withStatus = true, limit = 20 } = {}) => {
    const all = await mergeSessions();
    const filtered = all
      .filter((session) => includeSubagents || session.parentId == null)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit);
    if (!withStatus) return filtered;

    const pending = sessionEvents.pendingCounts();
    let active = null;
    if (opencode?.available && typeof opencode.listActiveSessionIds === 'function') {
      try {
        active = await opencode.listActiveSessionIds();
      } catch {
        active = null;
      }
    }
    const needHostStatus = active === null && host?.available;
    const statuses = await mapLimit(filtered, 5, async (session, index) => {
      if ((pending.bySession.get(session.id) ?? 0) > 0) return 'waiting';
      const registry = store.state.sessionRegistry[session.id];
      if (registry?.status === 'failed') return 'failed';
      if (active?.has(session.id)) return 'busy';
      if (needHostStatus && index < 8) {
        try {
          const result = await host.sessions.status(session.id);
          if (result?.status === 'waiting' || result?.status === 'busy' || result?.status === 'idle') return result.status;
        } catch {
          // fall back to the registry
        }
      }
      return registry?.status ?? 'idle';
    });
    return filtered.map((session, index) => ({
      ...session,
      status: statuses[index],
      pendingCount: pending.bySession.get(session.id) ?? 0,
    }));
  };

  const leadSession = () => store.leadSession();

  const leadEntry = async () => {
    const lead = leadSession();
    if (!lead.sessionId) return null;
    const sessions = await listSessions({ withStatus: true, limit: 100 });
    const found = sessions.find((session) => session.id === lead.sessionId);
    if (found) return found;
    const registry = store.state.sessionRegistry[lead.sessionId] ?? {};
    const pending = sessionEvents.pendingCounts(lead.sessionId).bySession.get(lead.sessionId) ?? 0;
    return {
      id: lead.sessionId,
      title: lead.title ?? registry.title ?? lead.sessionId,
      parentId: registry.parentId ?? null,
      directory: registry.directory ?? null,
      updatedAt: registry.updatedAt ?? 0,
      status: pending > 0 ? 'waiting' : (registry.status ?? 'idle'),
      pendingCount: pending,
    };
  };

  const leadTarget = (session) => ({
    id: session.id,
    title: session.title ?? store.state.leadSessionTitle ?? session.id,
  });

  const resolveSession = async (target, chatId) => {
    const value = String(target ?? '').trim().replace(/^[#@]/, '');
    if (!value) return { error: 'A session is required.' };
    const sessions = await listSessions({ includeSubagents: true, withStatus: false, limit: 100 });
    if (!sessions.length) return { error: 'No sessions are known yet. Open one in OpenChamber or use /new <task>.' };
    if (/^\d+$/.test(value)) {
      const ids = store.lastSessionList(chatId);
      const id = ids[Number(value) - 1];
      const found = id ? sessions.find((session) => session.id === id) : null;
      if (found) return { session: found };
      return { error: `No session number ${value} in the last list. Run /sessions first.` };
    }
    const exact = sessions.find((session) => session.id === value);
    if (exact) return { session: exact };
    if (value.length >= 4) {
      const prefixed = sessions.filter((session) => session.id.startsWith(value) || session.id.startsWith(`ses_${value}`));
      if (prefixed.length === 1) return { session: prefixed[0] };
      if (prefixed.length > 1) {
        return { error: `Session prefix “${value}” is ambiguous: ${prefixed.slice(0, 5).map((s) => s.id).join(', ')}` };
      }
    }
    if (/^ses_[A-Za-z0-9]+$/.test(value)) {
      return {
        session: {
          id: value,
          title: store.state.sessionRegistry[value]?.title ?? value,
          directory: store.state.sessionRegistry[value]?.directory ?? null,
          updatedAt: store.state.sessionRegistry[value]?.updatedAt ?? 0,
        },
      };
    }
    const lower = value.toLowerCase();
    const exactTitle = sessions.filter((session) => (session.title ?? '').trim().toLowerCase() === lower);
    if (exactTitle.length === 1) return { session: exactTitle[0] };
    if (exactTitle.length > 1) {
      return { error: `That title matches ${exactTitle.length} sessions. Use an ID prefix from /sessions.` };
    }
    const byTitle = sessions.filter((session) => (session.title ?? '').toLowerCase().includes(lower));
    if (byTitle.length === 1) return { session: byTitle[0] };
    if (byTitle.length > 1) {
      return { error: `That title matches ${byTitle.length} sessions. Use an ID prefix from /sessions.` };
    }
    return { error: `Session “${value}” was not found. Try /sessions.` };
  };

  const reply = (formatted) => ({ text: formatted.text, plain: formatted.plain });

  const sendToSession = async (session, text) => {
    await host.sessions.send(session.id, text);
    store.watchSession(session.id);
    await sessionEvents.closeFormsForSession(session.id, 'Closed because a message arrived from Telegram.');
    return reply(formatSendSuccess(session.title ?? session.id));
  };

  const sendWithLead = async (lead, text) => {
    try {
      return await sendToSession({ id: lead.sessionId, title: lead.title }, text);
    } catch (error) {
      logger?.warn('sessions.send failed', { code: error?.code, status: error?.status });
      return reply(formatError(safeError(error).message ?? 'Could not send to OpenChamber.'));
    }
  };

  const handlePairing = ({ chatId, userId, isPrivate, code, botUsername }) => {
    if (!isPrivate) return null;
    if (!store.pairAttempt(chatId, 8, 10 * 60 * 1000)) return null;
    if (isAllowed({ userId, chatId })) return reply(formatAlreadyPaired({ botUsername }));
    if (!code) return reply(formatStartHelp({ configured: Boolean(getSettings()?.tokenPresent), botUsername }));
    const normalized = normalizePairCode(code);
    if (!store.consumePairCode(normalized)) return reply(formatPairInvalid());
    store.addPairedId(chatId);
    if (Number.isSafeInteger(userId) && userId !== chatId) store.addPairedId(userId);
    if (store.state.primaryChatId === null) store.setPrimaryChat(chatId);
    logger?.info('Telegram chat paired', { chatId, userId });
    return reply(formatPaired({ chatId, botUsername }));
  };

  const handleReply = async ({ chatId, userId, replyToMessageId, text }) => {
    const route = store.messageRoute(chatId, replyToMessageId);
    if (!route) return reply(formatNoTarget());
    const lead = leadSession();
    if (lead.sessionId) {
      if (route.formKey) {
        const form = store.state.forms[route.formKey];
        if (!form || form.sessionId !== lead.sessionId) {
          if (form && !form.closed) {
            await sessionEvents.closeForm(form, 'This question belongs to a session that is not the Telegram lead.');
          }
          return reply(formatError('That question belongs to a session that is not the Telegram lead. Send the text to the lead instead.'));
        }
        if (!form.closed) {
          const outcome = await answerEngine.answerWithText(form, text);
          if (outcome.ok) {
            return reply({
              text: outcome.updated
                ? '✅ Saved. Finish the remaining fields or press Submit.'
                : '✅ Answer sent to OpenChamber.',
              plain: outcome.updated
                ? 'Saved. Finish the remaining fields or press Submit.'
                : 'Answer sent to OpenChamber.',
            });
          }
          return reply(formatError(outcome.error));
        }
      }
      try {
        return await sendToSession({ id: lead.sessionId, title: lead.title }, text);
      } catch (error) {
        logger?.warn('Could not send a reply to the lead', { code: error?.code, status: error?.status });
        return reply(formatError(safeError(error).message ?? 'Could not reach OpenChamber.'));
      }
    }
    if (route.formKey) {
      const form = store.state.forms[route.formKey];
      if (form && !form.closed) {
        const outcome = await answerEngine.answerWithText(form, text);
        if (outcome.ok) {
          return reply({
            text: outcome.updated
              ? '✅ Saved. Finish the remaining fields or press Submit.'
              : '✅ Answer sent to OpenChamber.',
            plain: outcome.updated
              ? 'Saved. Finish the remaining fields or press Submit.'
              : 'Answer sent to OpenChamber.',
          });
        }
        return reply(formatError(outcome.error));
      }
    }
    if (!route.sessionId) return reply(formatNoTarget());
    const session = { id: route.sessionId, title: route.sessionTitle };
    try {
      return await sendToSession(session, text);
    } catch (error) {
      logger?.warn('Could not send a reply to a session', { code: error?.code, status: error?.status });
      return reply(formatError(safeError(error).message ?? 'Could not reach OpenChamber.'));
    }
  };

  const handleCommand = async ({ chatId, userId, command, args, rest, messageId }) => {
    const lead = leadSession();
    if (lead.paused && ['/status', '/sessions', '/new', '/send', '/stop', '/digest'].includes(command)) {
      return reply(formatLeadPaused());
    }
    switch (command) {
      case '/help':
        return reply(formatHelp());
      case '/status': {
        const sessions = lead.sessionId
          ? [await leadEntry()].filter(Boolean)
          : await listSessions({ withStatus: true, limit: 25 });
        return reply(formatStatus({ sessions, now: clock() }));
      }
      case '/sessions': {
        const sessions = lead.sessionId
          ? [await leadEntry()].filter(Boolean)
          : await listSessions({ withStatus: true, limit: 25 });
        store.setLastSessionList(chatId, sessions.map((session) => session.id));
        return reply(formatSessions({ sessions, now: clock() }));
      }
      case '/new': {
        if (lead.sessionId) {
          return reply(formatLeadNewBlocked({ title: lead.title, sessionId: lead.sessionId }));
        }
        const task = String(rest ?? '').trim();
        if (!task) return reply(formatError('Usage: /new <task>'));
        if (typeof host?.sessions?.start !== 'function') {
          return reply(formatError('This OpenChamber version cannot start sessions. Update OpenChamber to 2.8 or newer.'));
        }
        try {
          // A service gets no context directory from the host, so use the project of
          // the most recently updated top-level session.
          const recent = await listSessions({ withStatus: false, limit: 1 });
          const directory = recent[0]?.directory;
          if (!directory) {
            return reply(formatError('No project is known yet. Open a project or a session in OpenChamber first.'));
          }
          const started = await host.sessions.start({ prompt: task, directory });
          const sessionId = typeof started?.sessionId === 'string' ? started.sessionId : '';
          if (!sessionId) return reply(formatError('OpenChamber did not return the new session.'));
          store.touchSession(sessionId, { status: 'busy', directory: started.directory ?? directory });
          store.watchSession(sessionId);
          return {
            ...reply(formatNewSession({ sessionId, directory: started.directory ?? directory })),
            sessionId,
            sessionTitle: store.state.sessionRegistry[sessionId]?.title ?? null,
          };
        } catch (error) {
          logger?.warn('sessions.start failed', { code: error?.code, status: error?.status });
          return reply(formatError(startErrorMessage(error)));
        }
      }
      case '/send': {
        const { target, text } = splitTarget(args);
        if (lead.sessionId) {
          const wholeText = String(rest ?? '').trim() || [target, text].filter(Boolean).join(' ').trim();
          if (!wholeText) return reply(formatError('Usage: /send <text>'));
          if (args.length <= 1) return sendWithLead(lead, wholeText);
          const resolved = await resolveSession(target, chatId);
          if (resolved.session) {
            if (resolved.session.id === lead.sessionId) return sendWithLead(lead, text);
            return reply(formatLeadTargetOnly({ title: lead.title, sessionId: lead.sessionId }));
          }
          // A bare text that happens to start with a word is the default target: the lead.
          if (/^\d+$/.test(target.replace(/^[#@]/, '')) || /^ses_/.test(target)) {
            return reply(formatError(resolved.error));
          }
          return sendWithLead(lead, wholeText);
        }
        if (!target || !text) return reply(formatError('Usage: /send <session> <text>'));
        const resolved = await resolveSession(target, chatId);
        if (!resolved.session) return reply(formatError(resolved.error));
        try {
          return await sendToSession(resolved.session, text);
        } catch (error) {
          logger?.warn('sessions.send failed', { code: error?.code, status: error?.status });
          return reply(formatError(safeError(error).message ?? 'Could not send to OpenChamber.'));
        }
      }
      case '/stop': {
        const target = splitStopTarget(args);
        if (lead.sessionId) {
          let session = leadTarget(await leadEntry());
          if (target) {
            const resolved = await resolveSession(target, chatId);
            if (!resolved.session) return reply(formatError(resolved.error));
            if (resolved.session.id !== lead.sessionId) {
              return reply(formatLeadTargetOnly({ title: lead.title, sessionId: lead.sessionId }));
            }
            session = resolved.session;
          }
          try {
            const result = await host.sessions.stop(session.id);
            if (result?.stopped) store.touchSession(session.id, { status: 'idle' });
            return reply(formatStopResult({ title: session.title ?? session.id, stopped: result?.stopped === true }));
          } catch (error) {
            logger?.warn('sessions.stop failed', { code: error?.code, status: error?.status });
            return reply(formatError(safeError(error).message ?? 'Could not stop the session.'));
          }
        }
        if (!target) return reply(formatError('Usage: /stop <session>'));
        const resolved = await resolveSession(target, chatId);
        if (!resolved.session) return reply(formatError(resolved.error));
        try {
          const result = await host.sessions.stop(resolved.session.id);
          if (result?.stopped) store.touchSession(resolved.session.id, { status: 'idle' });
          return reply(formatStopResult({ title: resolved.session.title ?? resolved.session.id, stopped: result?.stopped === true }));
        } catch (error) {
          logger?.warn('sessions.stop failed', { code: error?.code, status: error?.status });
          return reply(formatError(safeError(error).message ?? 'Could not stop the session.'));
        }
      }
      case '/digest': {
        const sessions = lead.sessionId
          ? [await leadEntry()].filter(Boolean)
          : await listSessions({ withStatus: true, limit: 25 });
        const pending = sessionEvents.pendingCounts(lead.sessionId ?? null);
        const recentEvents = lead.sessionId
          ? store.state.recentEvents.filter((event) => event.sessionId === lead.sessionId)
          : store.state.recentEvents;
        const since = store.lastDigest(chatId);
        store.setLastDigest(chatId, clock());
        return reply(formatDigest({
          sessions,
          pending,
          recentEvents,
          since,
          now: clock(),
        }));
      }
      case '/unpair': {
        const before = currentAllowlist().effective;
        store.removePairedId(chatId);
        if (Number.isSafeInteger(userId)) store.removePairedId(userId);
        const after = currentAllowlist().effective;
        const stillAllowed = isIdAllowed(after, { userId, chatId });
        return reply(formatError(stillAllowed
          ? 'This chat was removed from pairing but is still allowed by the extension settings.'
          : 'This chat is no longer paired.'));
      }
      default:
        return reply(formatInvalidCommand());
    }
  };

  const handleMessage = async ({
    chatId,
    userId,
    text,
    isPrivate,
    chatType,
    replyToMessageId = null,
    botUsername = null,
  }) => {
    const parsed = parseCommand(text);
    const command = parsed?.command ?? null;
    const privateChat = isPrivate ?? isPrivateChat({ type: chatType });
    if (command === '/start' || command === '/pair') {
      return handlePairing({
        chatId,
        userId,
        isPrivate: privateChat,
        code: parsed.rest || parsed.args[0] || '',
        botUsername,
      });
    }
    if (!isAllowed({ userId, chatId })) return null;
    if (!withinChatRate(chatId)) return null;
    if (command) {
      return handleCommand({
        chatId,
        userId,
        command,
        args: parsed.args,
        rest: parsed.rest,
        messageId: null,
      });
    }
    if (replyToMessageId) {
      return handleReply({ chatId, userId, replyToMessageId, text });
    }
    return {
      ...reply(formatNoTarget()),
      quiet: false,
    };
  };

  return {
    handleMessage,
    handleReply,
    handleCommand,
    listSessions,
    resolveSession,
    isAllowed,
    currentAllowlist,
  };
};

module.exports = {
  createCommands,
  parseCommand,
  mapLimit,
};
