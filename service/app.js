'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('./lib/store');
const { createLogger, safeError, silentLogger } = require('./lib/log');
const { createHostClient } = require('./lib/host');
const { createOpenCodeClient } = require('./lib/opencode');
const { createTelegramClient } = require('./lib/telegram');
const { createOutbox } = require('./lib/outbox');
const { createSessionEvents, validateSessionEvent } = require('./lib/session-events');
const { createAnswerEngine } = require('./lib/answers');
const { createCommands } = require('./lib/commands');
const { normalizeSettings } = require('./lib/settings');
const { effectiveIds, choosePrimaryChat } = require('./lib/allowlist');
const { parseCallback } = require('./lib/callback-data');
const { timingSafeEqual, randomPairCode, formatPairCode } = require('./lib/ids');
const { formatTestMessage, formatError } = require('./lib/format');

const PACKAGE_VERSION = require('../package.json').version;
const PAIR_TTL_MS = 10 * 60 * 1000;
const BODY_LIMIT = 2 * 1024 * 1024;

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

const readBody = (req, limit = BODY_LIMIT) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body is too large');
      error.status = 413;
      reject(error);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const parseJson = (text) => {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const createDeskService = ({
  env = process.env,
  dataDir = env.OPENCHAMBER_SERVICE_DATA_DIR || env.TELEGRAM_DESK_DATA_DIR || path.join(os.tmpdir(), 'telegram-desk'),
  fetchImpl = globalThis.fetch,
  logger = createLogger(),
  clock = Date.now,
  startLoops = true,
  hostOverride = null,
  opencodeOverride = null,
  telegramOverride = null,
} = {}) => {
  const log = logger ?? silentLogger;
  const insecure = env.TELEGRAM_DESK_ALLOW_INSECURE === '1';
  const serviceToken = env.OPENCHAMBER_SERVICE_TOKEN || '';
  if (!insecure && !serviceToken) {
    throw new Error('OPENCHAMBER_SERVICE_TOKEN is missing');
  }

  const store = new Store({ dir: dataDir, clock, logger: log });
  const host = hostOverride ?? createHostClient({
    callbackUrl: env.OPENCHAMBER_HOST_CALLBACK_URL,
    token: serviceToken,
    fetchImpl,
    clock,
  });
  const opencode = opencodeOverride ?? createOpenCodeClient({
    baseUrl: env.OPENCHAMBER_OPENCODE_URL,
    token: serviceToken,
    fetchImpl,
  });
  const telegram = telegramOverride ?? createTelegramClient({
    apiBase: env.TELEGRAM_DESK_API_BASE || 'https://api.telegram.org',
    fetchImpl,
    clock,
  });

  let settings = normalizeSettings({});
  let settingsReadAt = 0;
  let settingsReady = false;
  let settingsReading = null;
  let botInfo = null;
  let botConfigureAt = 0;
  let configNoteAt = 0;
  let configNoteShown = false;
  let lastPollAt = 0;
  let lastError = null;
  let lastTestAt = 0;
  let startedAt = clock();
  let stopping = false;
  let server = null;
  let actualPort = null;
  let pollController = null;
  const timers = [];
  let outbox = null;
  let sessionEvents = null;
  let answerEngine = null;
  let commands = null;

  outbox = createOutbox({
    store,
    telegram,
    logger: log,
    clock,
    isChatAllowed: (chatId) => {
      if (!settingsReady) return true;
      return effectiveIds(settings.settingsAllowlist, store.state.pairedIds).includes(chatId);
    },
    onDelivered: () => {
      // The panel polls /status; no push is required.
    },
  });

  sessionEvents = createSessionEvents({
    store,
    host,
    telegram,
    outbox,
    logger: log,
    getSettings: () => settings,
    clock,
  });

  answerEngine = createAnswerEngine({ store, host, telegram, logger: log, clock });

  commands = createCommands({
    store,
    host,
    opencode,
    sessionEvents,
    answerEngine,
    logger: log,
    getSettings: () => settings,
    clock,
  });

  const authorize = (req) => {
    if (insecure) return true;
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    return timingSafeEqual(match[1], serviceToken);
  };

  const sendJson = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
    });
    res.end(data);
  };

  const recomputePrimary = () => {
    const effective = effectiveIds(settings.settingsAllowlist, store.state.pairedIds);
    const primary = choosePrimaryChat({
      current: store.state.primaryChatId,
      pairedIds: store.state.pairedIds,
      settingsIds: settings.settingsAllowlist,
      effective,
    });
    if (primary !== store.state.primaryChatId) store.setPrimaryChat(primary);
    return primary;
  };

  const configureBot = async () => {
    if (!settings.botToken) return;
    if (botConfigureAt && clock() - botConfigureAt < 60_000) return;
    botConfigureAt = clock();
    try {
      const info = await telegram.getMe();
      botInfo = {
        id: info?.id ?? null,
        username: info?.username ?? null,
        firstName: info?.first_name ?? null,
      };
      await telegram.setMyCommands([
        { command: 'start', description: 'Pair this chat with a code' },
        { command: 'status', description: 'Sessions waiting, busy or idle' },
        { command: 'sessions', description: 'Recent sessions and IDs' },
        { command: 'send', description: 'Send a message to a session' },
        { command: 'stop', description: 'Stop a running session turn' },
        { command: 'digest', description: 'Summary since the last digest' },
        { command: 'help', description: 'Commands and reply routing' },
      ]).catch((error) => log.debug('Could not set bot commands', { code: error?.code }));
      lastError = null;
      log.info('Telegram bot connected', { username: botInfo.username });
    } catch (error) {
      lastError = safeError(error);
      log.warn('Telegram getMe failed', { code: error?.code, status: error?.status });
    }
  };

  const setConfigurationNote = (message) => {
    if (!host.available) return;
    const now = clock();
    if (message) {
      if (configNoteShown && now - configNoteAt < 10 * 60 * 1000) return;
      configNoteShown = true;
      configNoteAt = now;
    } else {
      if (!configNoteShown) return;
      configNoteShown = false;
      configNoteAt = 0;
    }
    void host.needsConfiguration(message).catch((error) => {
      log.debug('Could not set the extension configuration note', { code: error?.code });
    });
  };

  const refreshSettings = async ({ force = false } = {}) => {
    if (!host.available) return false;
    if (!force && settingsReadAt && clock() - settingsReadAt < 10_000) return true;
    if (settingsReading) return settingsReading;
    settingsReading = (async () => {
      try {
        const raw = await host.readSettings();
        const next = normalizeSettings(raw);
        const tokenChanged = next.botToken !== settings.botToken;
        settings = next;
        settingsReadAt = clock();
        settingsReady = true;
        if (tokenChanged) {
          telegram.setToken(next.botToken);
          botInfo = null;
          botConfigureAt = 0;
          if (next.botToken) void configureBot();
        }
        if (next.botToken) {
          setConfigurationNote(null);
        } else if (next.tokenPresent) {
          setConfigurationNote('The bot token saved in Settings → Integrations does not look like a Telegram bot token. Fix it and save again.');
        } else {
          setConfigurationNote('Add a Telegram bot token in Settings → Integrations → Telegram Desk → Bot token.');
        }
        if (next.invalidAllowlist.length) {
          log.warn('Some allowlist entries are not numeric and were ignored', { count: next.invalidAllowlist.length });
        }
        recomputePrimary();
        return true;
      } catch (error) {
        settingsReady = false;
        lastError = safeError(error);
        log.warn('Could not read extension settings', { code: error?.code, status: error?.status });
        return false;
      } finally {
        settingsReading = null;
      }
    })();
    return settingsReading;
  };

  const getStatus = () => {
    const pending = sessionEvents.pendingCounts();
    const effective = effectiveIds(settings.settingsAllowlist, store.state.pairedIds);
    const pairCode = store.activePairCode();
    return {
      ok: true,
      version: PACKAGE_VERSION,
      configured: Boolean(settings.botToken),
      token: {
        present: settings.tokenPresent,
        looksValid: settings.tokenLooksValid,
      },
      bot: botInfo,
      service: {
        startedAt,
        uptimeMs: clock() - startedAt,
        settingsReady,
        hostAvailable: Boolean(host.available),
        opencodeAvailable: Boolean(opencode.available),
        lastPollAt,
        lastError,
        outbox: outbox.size,
      },
      allowlist: {
        settings: settings.settingsAllowlist,
        paired: store.state.pairedIds,
        effective,
        primaryChatId: store.state.primaryChatId,
        invalid: settings.invalidAllowlist,
      },
      pairing: pairCode ? { code: formatPairCode(pairCode.code), expiresAt: pairCode.expiresAt } : null,
      preferences: {
        notifyMode: sessionEvents.currentMode(),
        override: store.state.preferences.notifyMode,
        setting: settings.notifySetting,
      },
      pending: {
        questions: pending.questions,
        permissions: pending.permissions,
        bySession: Object.fromEntries(pending.bySession),
      },
      events: store.state.recentEvents.slice(-20).reverse(),
      stats: { ...store.state.stats },
    };
  };

  const handleTest = async () => {
    const now = clock();
    if (lastTestAt && now - lastTestAt < 10_000) {
      return { status: 429, body: { ok: false, error: 'Wait a few seconds before testing again.' } };
    }
    lastTestAt = now;
    if (!settings.botToken) {
      return { status: 400, body: { ok: false, error: 'Add a bot token in Settings → Integrations → Telegram Desk → Bot token.' } };
    }
    const effective = effectiveIds(settings.settingsAllowlist, store.state.pairedIds);
    if (!effective.length) {
      return { status: 400, body: { ok: false, error: 'No allowed chats. Pair a chat first.' } };
    }
    const card = formatTestMessage({ now });
    const results = [];
    for (const chatId of effective.slice(0, 5)) {
      try {
        const message = await telegram.sendMessage({ chatId, text: card.text, plain: card.plain });
        results.push({ chatId, ok: true, messageId: message?.message_id ?? null });
      } catch (error) {
        results.push({ chatId, ok: false, error: safeError(error).description ?? safeError(error).message ?? 'send failed' });
      }
    }
    return { status: 200, body: { ok: results.some((item) => item.ok), results } };
  };

  const handlePairCode = () => {
    const code = randomPairCode();
    store.setPairCode(code, PAIR_TTL_MS);
    return {
      ok: true,
      configured: Boolean(settings.botToken),
      code: formatPairCode(code),
      rawCode: code,
      expiresAt: store.activePairCode()?.expiresAt ?? clock() + PAIR_TTL_MS,
      instructions: 'Send /start CODE to the bot in a private chat.',
    };
  };

  const handleNotifyMode = (body) => {
    const mode = String(body?.mode ?? '').trim();
    if (!['all', 'active', 'off'].includes(mode)) {
      return { status: 400, body: { ok: false, error: 'mode must be all, active or off' } };
    }
    store.setNotifyPreference(mode);
    return { status: 200, body: { ok: true, mode } };
  };

  const handleAllowlistRemove = (body) => {
    const id = Number(body?.id);
    if (!Number.isSafeInteger(id)) return { status: 400, body: { ok: false, error: 'id must be a Telegram numeric ID' } };
    store.removePairedId(id);
    recomputePrimary();
    return { status: 200, body: { ok: true, status: getStatus() } };
  };

  const handleHttp = async (req, res) => {
    if (!authorize(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request' });
      return;
    }
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (pathname === '/health' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        version: PACKAGE_VERSION,
        ready: true,
        configured: Boolean(settings.botToken),
      });
      return;
    }
    if (pathname === '/status' && method === 'GET') {
      sendJson(res, 200, getStatus());
      return;
    }
    if (pathname === '/test' && method === 'POST') {
      const result = await handleTest();
      sendJson(res, result.status, result.body);
      return;
    }
    if (pathname === '/pair/code' && method === 'POST') {
      sendJson(res, 200, handlePairCode());
      return;
    }
    if (pathname === '/notify-mode' && method === 'POST') {
      const body = parseJson(await readBody(req));
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'invalid json' });
        return;
      }
      const result = handleNotifyMode(body);
      sendJson(res, result.status, result.body);
      return;
    }
    if (pathname === '/allowlist/remove' && method === 'POST') {
      const body = parseJson(await readBody(req));
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'invalid json' });
        return;
      }
      const result = handleAllowlistRemove(body);
      sendJson(res, result.status, result.body);
      return;
    }
    if (pathname === '/session-events' && method === 'POST') {
      const body = parseJson(await readBody(req));
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'invalid json' });
        return;
      }
      if (!validateSessionEvent(body)) {
        sendJson(res, 400, { ok: false, error: 'invalid session event' });
        return;
      }
      const result = await sessionEvents.handle(body);
      if (!result.ok) {
        sendJson(res, 200, { ok: false, error: result.error ?? 'event rejected' });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  };

  const handleMessageUpdate = async (message) => {
    if (!message?.chat || !message.from || message.from.is_bot) return;
    if (typeof message.text !== 'string' || !message.text.trim()) return;
    const repliedFrom = message.reply_to_message?.from;
    const isOurBot = Boolean(repliedFrom?.is_bot) && (
      !botInfo
      || repliedFrom.id === botInfo.id
      || (botInfo.username && String(repliedFrom.username).toLowerCase() === botInfo.username.toLowerCase())
    );
    const replyTo = isOurBot ? message.reply_to_message.message_id : null;
    const result = await commands.handleMessage({
      chatId: message.chat.id,
      userId: message.from.id,
      text: message.text,
      isPrivate: message.chat.type === 'private',
      chatType: message.chat.type,
      replyToMessageId: replyTo,
      botUsername: botInfo?.username ?? null,
    });
    if (!result) return;
    try {
      await telegram.sendMessage({
        chatId: message.chat.id,
        text: result.text,
        plain: result.plain,
      });
    } catch (error) {
      log.warn('Could not send a Telegram reply', { code: error?.code, status: error?.status });
    }
  };

  const callbackWindows = new Map();
  const withinCallbackRate = (chatId, limit = 30, windowMs = 60_000) => {
    const now = clock();
    const key = String(chatId);
    const attempts = (callbackWindows.get(key) ?? []).filter((at) => at > now - windowMs);
    if (attempts.length >= limit) {
      callbackWindows.set(key, attempts);
      return false;
    }
    attempts.push(now);
    callbackWindows.set(key, attempts);
    return true;
  };

  const followUp = async (chatId, text) => {
    try {
      await telegram.sendMessage({ chatId, text: text.text, plain: text.plain });
    } catch (error) {
      log.debug('Could not send a callback follow-up', { code: error?.code });
    }
  };

  const handleCallbackUpdate = async (query) => {
    const callbackId = query?.id;
    const chatId = query?.message?.chat?.id;
    const userId = query?.from?.id;
    if (!callbackId || !Number.isSafeInteger(chatId)) return;

    if (!commands.isAllowed({ userId, chatId })) {
      await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'Not allowed', showAlert: false }).catch(() => {});
      return;
    }
    if (!withinCallbackRate(chatId)) {
      await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'Too many presses. Wait a minute.' }).catch(() => {});
      return;
    }
    if (store.callbackOutcome(callbackId)) {
      await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'Already handled' }).catch(() => {});
      return;
    }
    const parsed = parseCallback(query.data);
    if (!parsed) {
      await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'This button is not supported.' }).catch(() => {});
      return;
    }
    const payload = store.getRef(parsed.ref);
    if (!payload) {
      await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'This button has expired.' }).catch(() => {});
      return;
    }

    let form = null;
    if (payload.kind !== 'permission') {
      form = store.state.forms[`${payload.sessionId}:${payload.formId}`] ?? null;
      if (form && form.chatId && form.chatId !== chatId) {
        await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'Not allowed' }).catch(() => {});
        return;
      }
    } else {
      const permission = store.state.permissions[payload.requestId] ?? null;
      if (!permission || permission.ref !== parsed.ref) {
        await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'This button has expired.' }).catch(() => {});
        return;
      }
      if (permission.chatId && permission.chatId !== chatId) {
        await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'Not allowed' }).catch(() => {});
        return;
      }
      if (!['a', 'd'].includes(parsed.action)) {
        await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: 'This button is not supported.' }).catch(() => {});
        return;
      }
    }

    // Stop the Telegram spinner before the host round-trip.
    await telegram.answerCallbackQuery({ callbackQueryId: callbackId, text: '' }).catch(() => {});

    let outcome = { ok: false, error: 'Unknown action' };
    try {
      if (payload.kind === 'permission') {
        const permission = store.state.permissions[payload.requestId] ?? { closed: true };
        outcome = await answerEngine.answerPermission(permission, parsed.action === 'a' ? 'allow' : 'deny');
      } else if (payload.kind === 'question') {
        outcome = await answerEngine.chooseOption(payload);
      } else if (payload.kind === 'submit') {
        outcome = form ? await answerEngine.submitForm(form) : { ok: false, stale: true, error: 'This question is no longer open.' };
      } else if (payload.kind === 'dismiss') {
        outcome = form ? await answerEngine.dismissForm(form) : { ok: false, stale: true, error: 'This question is no longer open.' };
      }
    } catch (error) {
      outcome = { ok: false, error: safeError(error).message ?? 'The action failed.' };
      log.warn('Callback action failed', { kind: payload.kind, code: error?.code });
    }

    store.markCallback(callbackId, outcome.stale ? 'stale' : outcome.ok ? 'answered' : 'error');
    if (!outcome.ok && !outcome.stale && outcome.error) {
      const formatted = formatError(outcome.error);
      await followUp(chatId, formatted);
    }
    await store.flush();
  };

  const processUpdate = async (update) => {
    if (!update || typeof update !== 'object') return;
    if (update.message) {
      await handleMessageUpdate(update.message);
      return;
    }
    if (update.callback_query) {
      await handleCallbackUpdate(update.callback_query);
    }
  };

  const handleTelegramUpdate = async (update) => {
    if (!update || !Number.isFinite(update.update_id)) return;
    if (store.hasSeenUpdate(update.update_id)) {
      if (update.update_id + 1 > store.state.offset) store.setOffset(update.update_id + 1);
      return;
    }
    await processUpdate(update);
    store.markUpdateSeen(update.update_id);
    store.setOffset(update.update_id + 1);
    await store.flush();
  };

  const pollLoop = async () => {
    while (!stopping) {
      await refreshSettings();
      if (!settings.botToken) {
        await sleep(3000, pollController?.signal);
        continue;
      }
      if (!botInfo && !stopping) {
        // Configure later; do not block polling on getMe.
        void configureBot();
      }
      try {
        pollController = new AbortController();
        const updates = await telegram.getUpdates({
          offset: store.state.offset,
          timeout: 30,
          signal: pollController.signal,
        });
        lastPollAt = clock();
        lastError = null;
        for (const update of updates) {
          if (stopping) break;
          try {
            await handleTelegramUpdate(update);
          } catch (error) {
            lastError = safeError(error);
            log.warn('Could not process a Telegram update', { code: error?.code, status: error?.status });
            break;
          }
        }
        await store.flush();
      } catch (error) {
        if (stopping) break;
        lastError = safeError(error);
        log.warn('Telegram long poll failed', {
          code: error?.code,
          status: error?.status,
          retryAfter: error?.retryAfter ?? undefined,
        });
        const waitMs = (error?.code === 409 || error?.code === 401)
          ? 30_000
          : (error?.retryAfter ? Math.min(60, error.retryAfter) * 1000 : 5000);
        await sleep(waitMs, pollController?.signal);
      }
    }
  };

  const start = async () => {
    await store.load();
    startedAt = clock();
    recomputePrimary();

    server = http.createServer((req, res) => {
      void handleHttp(req, res).catch((error) => {
        log.error('HTTP request failed', { code: error?.code, status: error?.status });
        if (!res.headersSent) sendJson(res, error?.status === 413 ? 413 : 500, { ok: false, error: 'internal error' });
        else res.end();
      });
    });
    const port = Number(env.OPENCHAMBER_SERVICE_PORT || 0);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    actualPort = server.address().port;
    log.info('Telegram Desk service listening', { port: actualPort, version: PACKAGE_VERSION });

    if (startLoops) {
      void refreshSettings({ force: true });
      const settingsTimer = setInterval(() => void refreshSettings(), 15_000);
      const outboxTimer = setInterval(() => void outbox.drain(), 2000);
      const pruneTimer = setInterval(() => store.prune(), 5 * 60 * 1000);
      for (const timer of [settingsTimer, outboxTimer, pruneTimer]) timer.unref?.();
      timers.push(settingsTimer, outboxTimer, pruneTimer);
      void pollLoop();
    }
    return { port: actualPort };
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    pollController?.abort();
    for (const timer of timers.splice(0)) clearInterval(timer);
    if (server) {
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await closed;
      server = null;
    }
    await store.flush();
  };

  return {
    start,
    stop,
    getStatus,
    handleTelegramUpdate,
    processUpdate,
    refreshSettings,
    get port() {
      return actualPort;
    },
    get server() {
      return server;
    },
    store,
    settings: () => settings,
    outbox,
    sessionEvents,
    answerEngine,
    commands,
    getBotInfo: () => botInfo,
  };
};

module.exports = {
  createDeskService,
  readBody,
  parseJson,
  PACKAGE_VERSION,
};
