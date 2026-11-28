'use strict';

const { encodeCallback } = require('./callback-data');
const { randomRef } = require('./ids');
const {
  clip,
  formatPermission,
  formatTurnFinished,
  formatTurnFailed,
  formatQuestionUnavailable,
  formatPageQuestion,
  formatLeadRemoved,
} = require('./format');
const {
  createFormState,
  formKey,
  renderForm,
  renderDismissed,
} = require('./forms');
const { safeError } = require('./log');

const EVENT_TYPES = new Set([
  'turn-finished',
  'turn-failed',
  'permission-asked',
  'question-asked',
  'turn-started',
  'session-created',
  'session-archived',
  'session-deleted',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string';
const isNullableString = (value) => value === null || typeof value === 'string';

const validateSessionEvent = (body) => {
  if (typeof body === 'string') {
    try {
      return validateSessionEvent(JSON.parse(body));
    } catch {
      return null;
    }
  }
  if (!isObject(body) || body.v !== 1 || !isString(body.requestId) || !body.requestId) return null;
  const event = body.event;
  if (!isObject(event)) return null;
  if (!isString(event.id) || !event.id) return null;
  if (!isString(event.type) || !EVENT_TYPES.has(event.type)) return null;
  if (!Number.isFinite(event.at)) return null;
  if (!isObject(event.session) || !isString(event.session.id) || !event.session.id) return null;
  if (!isNullableString(event.session.parentId)) return null;
  if (!isObject(event.project) || !isNullableString(event.project.directory)) return null;
  if (!Array.isArray(event.linked)) return null;
  if (event.permission !== undefined && (!isObject(event.permission) || !isString(event.permission.requestId))) return null;
  if (event.question !== undefined) {
    if (!isObject(event.question) || !['form', 'page'].includes(event.question.kind) || !isString(event.question.id)) return null;
  }
  if (body.content !== undefined) {
    if (!isObject(body.content) || body.content.type !== event.type) return null;
  }
  if (event.type === 'permission-asked' && !event.permission) return null;
  if (event.type === 'question-asked' && !event.question) return null;
  return body;
};

const createSessionEvents = ({
  store,
  host,
  telegram,
  outbox,
  logger,
  getSettings = () => ({ notifySetting: 'all' }),
  clock = Date.now,
}) => {
  const registerRefs = (refs) => {
    for (const { ref, payload } of refs) store.addRef(ref, payload);
  };

  const currentMode = () => {
    const preference = store.state.preferences.notifyMode;
    if (['all', 'active', 'off'].includes(preference)) return preference;
    const setting = getSettings()?.notifySetting;
    return ['all', 'active', 'off'].includes(setting) ? setting : 'all';
  };

  const primary = () => store.state.primaryChatId;

  const recordEvent = (request) => store.recordRecent({
    id: request.event.id,
    type: request.event.type,
    sessionId: request.event.session.id,
    sessionTitle: request.content?.sessionTitle ?? null,
    at: request.event.at,
    delivery: 'received',
  });

  const markDelivery = (request, delivery, detail = null) => {
    store.updateRecent(request.event.id, { delivery, ...(detail ? { detail } : {}) });
  };

  const enqueue = (request, payload) => {
    const chatId = primary();
    if (!chatId) {
      markDelivery(request, 'failed', 'no primary chat');
      return false;
    }
    outbox.enqueue({
      eventId: request.event.id,
      chatId,
      text: payload.text ?? payload.parts?.[0]?.text ?? '',
      plain: payload.plain ?? payload.parts?.[0]?.plain ?? null,
      parts: payload.parts ?? null,
      rich: payload.rich ?? null,
      keyboard: payload.keyboard ?? null,
      sessionId: request.event.session.id,
      sessionTitle: request.content?.sessionTitle ?? null,
      formKey: payload.formKey ?? null,
      permissionRef: payload.permissionRef ?? null,
      kind: payload.kind ?? 'event',
    });
    markDelivery(request, 'queued');
    return true;
  };

  const upsertSession = (request) => {
    const event = request.event;
    const status = event.type === 'turn-started' ? 'busy'
      : event.type === 'turn-finished' ? 'idle'
        : event.type === 'turn-failed' ? 'failed'
          : (event.type === 'question-asked' || event.type === 'permission-asked') ? 'waiting'
            : undefined;
    const current = store.state.sessionRegistry[event.session.id] ?? {};
    const title = request.content?.sessionTitle ?? current.title ?? null;
    store.touchSession(event.session.id, {
      title,
      parentId: event.session.parentId,
      directory: event.project.directory,
      ...(status ? { status } : {}),
    });
    if (store.state.leadSessionId === event.session.id && title) store.setLeadTitle(title);
  };

  const handleQuestionForm = async (request, ask) => {
    const key = formKey(request.event.session.id, ask.id);
    const existing = store.state.forms[key];
    const form = existing ?? createFormState({
      sessionId: request.event.session.id,
      sessionTitle: request.content?.sessionTitle ?? null,
      chatId: primary(),
    }, ask);
    form.title = clip(ask.title || form.title, 300);
    form.sessionTitle = request.content?.sessionTitle ?? form.sessionTitle;
    form.fields = createFormState({
      sessionId: request.event.session.id,
      sessionTitle: request.content?.sessionTitle ?? null,
    }, ask).fields;
    if (existing?.closed) {
      form.answers = {};
      form.messageId = null;
      form.closed = false;
    }
    form.updatedAt = clock();
    store.state.forms[key] = form;
    store.watchSession(form.sessionId);
    store.touchSession(form.sessionId, { status: 'waiting' });

    const rendered = renderForm(form);
    registerRefs(rendered.refs);

    if (form.messageId && form.chatId) {
      try {
        await telegram.editMessageText({
          chatId: form.chatId,
          messageId: form.messageId,
          text: rendered.text,
          plain: rendered.plain,
          keyboard: rendered.keyboard,
          timeoutMs: 6000,
        });
        store.recordMessage(form.chatId, form.messageId, {
          sessionId: form.sessionId,
          sessionTitle: form.sessionTitle,
          kind: 'form',
          formKey: key,
        });
        markDelivery(request, 'sent');
        store.touch();
        return;
      } catch (error) {
        logger?.warn('Could not edit a question card; sending a new one', { code: error?.code });
        form.messageId = null;
      }
    }

    enqueue(request, {
      text: rendered.text,
      plain: rendered.plain,
      keyboard: rendered.keyboard,
      formKey: key,
      kind: 'form',
    });
  };

  const handlePermission = (request) => {
    const requestId = request.event.permission?.requestId;
    if (!requestId) return;
    const existing = Object.values(store.state.permissions).find((entry) => entry.requestId === requestId && !entry.closed);
    if (existing) return;

    const content = request.content;
    const ref = randomRef(10);
    const chatId = primary();
    if (!chatId) {
      markDelivery(request, 'failed', 'no primary chat');
      return;
    }
    const card = formatPermission({
      sessionTitle: content?.sessionTitle ?? request.content?.sessionTitle ?? request.event.session.id,
      action: content?.action ?? 'unknown',
      resources: content?.resources ?? [],
      message: content?.message ?? null,
    });
    const keyboard = [[
      { text: '✅ Allow once', callback_data: encodeCallback('p', ref, 'a') },
      { text: '⛔ Deny', callback_data: encodeCallback('p', ref, 'd') },
    ]];
    store.state.permissions[requestId] = {
      ref,
      sessionId: request.event.session.id,
      requestId,
      action: content?.action ?? 'unknown',
      chatId,
      messageId: null,
      closed: false,
      at: clock(),
    };
    store.addRef(ref, {
      kind: 'permission',
      sessionId: request.event.session.id,
      requestId,
      action: content?.action ?? 'unknown',
    });
    store.watchSession(request.event.session.id);
    store.touchSession(request.event.session.id, { status: 'waiting' });
    enqueue(request, {
      text: card.text,
      plain: card.plain,
      keyboard,
      permissionRef: ref,
      kind: 'permission',
    });
  };

  const notifyAllowed = (request) => {
    if (currentMode() === 'off') return { ok: false, reason: 'notify mode is off' };
    if (request.event.session.parentId) return { ok: false, reason: 'subagent session' };
    if (currentMode() === 'active' && !store.isWatched(request.event.session.id)) {
      return { ok: false, reason: 'session is not active' };
    }
    const now = clock();
    const recent = store.state.recentEvents.filter((entry) => entry.id !== request.event.id);
    const sameSession = recent.some((entry) => entry.sessionId === request.event.session.id
      && (entry.type === 'turn-finished' || entry.type === 'turn-failed')
      && now - (entry.at ?? 0) < 20_000);
    if (sameSession) return { ok: false, reason: 'per-session cooldown' };
    const globalRecent = recent.filter((entry) => (entry.type === 'turn-finished' || entry.type === 'turn-failed')
      && now - (entry.at ?? 0) < 60_000);
    if (globalRecent.length >= 10) return { ok: false, reason: 'global rate limit' };
    return { ok: true };
  };

  const handleTurnFinished = (request) => {
    store.touchSession(request.event.session.id, { status: 'idle' });
    const allowed = notifyAllowed(request);
    if (!allowed.ok) {
      markDelivery(request, 'suppressed', allowed.reason);
      return;
    }
    const card = formatTurnFinished({
      sessionTitle: request.content?.sessionTitle ?? request.event.session.id,
      reply: request.content?.reply ?? '',
      replyTruncated: request.content?.replyTruncated === true,
    });
    enqueue(request, { ...card, kind: 'finish' });
  };

  const handleTurnFailed = (request) => {
    store.touchSession(request.event.session.id, { status: 'failed' });
    const allowed = notifyAllowed(request);
    if (!allowed.ok) {
      markDelivery(request, 'suppressed', allowed.reason);
      return;
    }
    const card = formatTurnFailed({
      sessionTitle: request.content?.sessionTitle ?? request.event.session.id,
      error: request.content?.error ?? { type: 'error', message: 'The turn failed.' },
    });
    enqueue(request, { ...card, kind: 'failure' });
  };

  const handlePageQuestion = (request, ask) => {
    store.watchSession(request.event.session.id);
    store.touchSession(request.event.session.id, { status: 'waiting' });
    const card = formatPageQuestion({
      sessionTitle: request.content?.sessionTitle ?? request.event.session.id,
      pageTitle: ask.title,
    });
    enqueue(request, { ...card, kind: 'page' });
  };

  const SESSION_DELETED_NOTE = 'The session was deleted in OpenChamber.';
  const SESSION_ARCHIVED_NOTE = 'The session was archived in OpenChamber.';
  const NOT_LEAD_NOTE = 'This session is not the Telegram lead.';

  const closeSessionCards = async (sessionId, note = SESSION_DELETED_NOTE) => {
    const closing = [];
    for (const form of Object.values(store.state.forms)) {
      if (form?.sessionId === sessionId && !form.closed) closing.push(closeForm(form, note));
    }
    for (const permission of Object.values(store.state.permissions)) {
      if (permission?.sessionId === sessionId && !permission.closed) closing.push(closePermission(permission, note));
    }
    // The host waits 10 s for an event answer; edit the cards together rather than one
    // Telegram round-trip at a time. Each edit has its own 6 s timeout.
    await Promise.allSettled(closing);
  };

  /**
   * The bound lead is gone. Drop its queued cards, close its open cards, clear the
   * binding and tell the primary chat to choose a new lead. Delivery stays paused
   * until someone picks another session; nothing is auto-selected. The binding is
   * re-checked after the awaited card edits: a panel bind or clear that lands while
   * this runs must win.
   */
  const removeLead = async ({
    sessionId,
    title = null,
    reason = 'deleted',
    eventId = null,
    offline = false,
    onDelivery = null,
  }) => {
    const previous = store.leadSession();
    if (previous.sessionId !== sessionId) return { removed: false, changed: true };
    store.forgetSession(sessionId);
    store.state.outbox = store.state.outbox.filter((item) => item.sessionId !== sessionId);
    store.touch();
    await closeSessionCards(sessionId, reason === 'archived' ? SESSION_ARCHIVED_NOTE : SESSION_DELETED_NOTE);
    if (store.state.leadSessionId !== sessionId || store.state.leadSetAt !== previous.setAt) {
      return { removed: false, changed: true };
    }
    store.clearLeadSession({ paused: true });
    const chatId = primary();
    if (!chatId) {
      onDelivery?.('failed', 'no primary chat');
      return { removed: true, queued: false };
    }
    const card = formatLeadRemoved({
      title: title ?? previous.title,
      sessionId,
      reason,
      offline,
    });
    outbox.enqueue({
      eventId,
      chatId,
      text: card.text,
      plain: card.plain,
      kind: 'event',
    });
    onDelivery?.('queued');
    return { removed: true, queued: true };
  };

  const removeLeadForEvent = (request, reason) => removeLead({
    sessionId: request.event.session.id,
    title: store.leadSession().title,
    reason,
    eventId: request.event.id,
    onDelivery: (delivery, detail) => markDelivery(request, delivery, detail),
  });

  // Used by startup validation, where no session event exists to mark as delivered.
  const removeLeadSession = (options = {}) => removeLead(options);

  /**
   * Registry, watch, outbox and open cards of a session that no longer exists. This
   * runs for every `session-deleted`, including non-lead sessions under a lead and
   * every deletion while delivery is paused; only the notification is gated.
   */
  const cleanupDeletedSession = async (sessionId) => {
    // Remove it from /sessions at once. Queued cards are dropped first: they belong to a
    // session that no longer exists and must not arrive after the deletion.
    store.forgetSession(sessionId);
    store.state.outbox = store.state.outbox.filter((item) => item.sessionId !== sessionId);
    store.touch();
    // Open cards stay in state (their refs and message routes are untouched) but close
    // with a note, so an old button press is a clear no-op instead of a failed answer.
    await closeSessionCards(sessionId);
  };

  const handleSessionDeleted = async (request) => {
    const sessionId = request.event.session.id;
    if (store.state.leadSessionId === sessionId) {
      await removeLeadForEvent(request, 'deleted');
      return;
    }
    await cleanupDeletedSession(sessionId);
    markDelivery(request, 'ignored', 'session removed');
  };

  const handleSessionArchived = async (request) => {
    const sessionId = request.event.session.id;
    if (store.state.leadSessionId !== sessionId) {
      markDelivery(request, 'ignored');
      return;
    }
    await removeLeadForEvent(request, 'archived');
  };

  /**
   * Keep delivery consistent with the current binding: queued cards for other
   * sessions are dropped, and (on a fresh bind) their open cards close with a note.
   * Called after loading state and after the panel binds a lead.
   */
  const enforceLead = async ({ closeCards = false } = {}) => {
    const leadSessionId = store.state.leadSessionId;
    if (!leadSessionId) return 0;
    const before = store.state.outbox.length;
    store.state.outbox = store.state.outbox.filter((item) => !item.sessionId || item.sessionId === leadSessionId);
    if (store.state.outbox.length !== before) store.touch();
    if (closeCards) {
      const closing = [];
      for (const form of Object.values(store.state.forms)) {
        if (form?.sessionId && form.sessionId !== leadSessionId && !form.closed) {
          closing.push(closeForm(form, NOT_LEAD_NOTE));
        }
      }
      for (const permission of Object.values(store.state.permissions)) {
        if (permission?.sessionId && permission.sessionId !== leadSessionId && !permission.closed) {
          closing.push(closePermission(permission, NOT_LEAD_NOTE));
        }
      }
      await Promise.allSettled(closing);
    }
    return before - store.state.outbox.length;
  };

  const handle = async (body) => {
    const request = validateSessionEvent(body);
    if (!request) return { ok: false, error: 'invalid session event' };
    if (store.hasSeenEvent(request.event.id)) return { ok: true, duplicate: true };
    store.markEventSeen(request.event.id);
    store.bump('events');
    recordEvent(request);

    // With a lead, everything from another session is ignored before any handler can
    // create a form, permission, ref, outbox item or registry entry. A paused binding
    // (the lead was deleted or archived) ignores every event until a new lead is chosen.
    // The one exception is session-deleted: a deleted session must leave the registry
    // and stop receiving cards even when it is not the lead, so cleanup runs first and
    // only delivery/notification stays gated.
    const leadSessionId = store.state.leadSessionId;
    const paused = !leadSessionId && store.state.leadPaused === true;
    if (paused || (leadSessionId && request.event.session.id !== leadSessionId)) {
      if (request.event.type === 'session-deleted') {
        await cleanupDeletedSession(request.event.session.id);
      }
      const detail = paused ? 'lead removed, delivery paused' : 'not the Telegram lead';
      markDelivery(request, 'ignored', detail);
      store.bump('ignored');
      await store.flush();
      return { ok: true, ignored: true };
    }

    // A deleted session must not be touched into the registry by this event.
    if (request.event.type !== 'session-deleted') upsertSession(request);

    try {
      switch (request.event.type) {
        case 'question-asked': {
          const ask = request.content?.ask;
          if (!ask || !request.event.question?.id) {
            const card = formatQuestionUnavailable({
              sessionTitle: request.content?.sessionTitle ?? request.event.session.id,
            });
            enqueue(request, { ...card, kind: 'question' });
            break;
          }
          const normalizedAsk = ask.id ? ask : { ...ask, id: request.event.question.id };
          if (normalizedAsk.kind === 'form') await handleQuestionForm(request, normalizedAsk);
          else handlePageQuestion(request, normalizedAsk);
          break;
        }
        case 'permission-asked':
          handlePermission(request);
          break;
        case 'turn-finished':
          handleTurnFinished(request);
          break;
        case 'turn-failed':
          handleTurnFailed(request);
          break;
        case 'session-deleted':
          await handleSessionDeleted(request);
          break;
        case 'session-archived':
          await handleSessionArchived(request);
          break;
        case 'turn-started':
        case 'session-created':
          markDelivery(request, 'ignored');
          break;
        default:
          break;
      }
    } catch (error) {
      store.bump('errors');
      markDelivery(request, 'failed', safeError(error).message ?? 'handler failed');
      logger?.error('Session event handling failed', { type: request.event.type, error: safeError(error) });
      return { ok: false, error: 'event handling failed' };
    }
    await store.flush();
    return { ok: true };
  };

  const pendingCounts = (sessionId = null) => {
    const bySession = new Map();
    let questions = 0;
    let permissions = 0;
    for (const form of Object.values(store.state.forms)) {
      if (!form || form.closed) continue;
      if (sessionId !== null && form.sessionId !== sessionId) continue;
      questions += 1;
      bySession.set(form.sessionId, (bySession.get(form.sessionId) ?? 0) + 1);
    }
    for (const permission of Object.values(store.state.permissions)) {
      if (!permission || permission.closed) continue;
      if (sessionId !== null && permission.sessionId !== sessionId) continue;
      permissions += 1;
      bySession.set(permission.sessionId, (bySession.get(permission.sessionId) ?? 0) + 1);
    }
    return { questions, permissions, bySession };
  };

  const closeForm = async (form, note = 'Question closed in OpenChamber.') => {
    form.closed = true;
    form.updatedAt = clock();
    const key = `${form.sessionId}:${form.formId}`;
    store.state.outbox = store.state.outbox.filter((item) => item.formKey !== key);
    if (form.messageId && form.chatId) {
      const rendered = renderDismissed(form, note);
      try {
        await telegram.editMessageText({
          chatId: form.chatId,
          messageId: form.messageId,
          text: rendered.text,
          plain: rendered.plain,
          keyboard: [],
          timeoutMs: 6000,
        });
      } catch (error) {
        logger?.debug('Could not edit a closed form card', { code: error?.code });
      }
    }
    store.touch();
  };

  const closeFormsForSession = async (sessionId, note) => {
    for (const form of Object.values(store.state.forms)) {
      if (form.sessionId === sessionId && !form.closed) await closeForm(form, note);
    }
  };

  const findPermissionByRef = (ref) => {
    const payload = store.getRef(ref);
    if (!payload || payload.kind !== 'permission') return null;
    return store.state.permissions[payload.requestId] ?? null;
  };

  const closePermission = async (permission, note = 'Permission already settled.') => {
    permission.closed = true;
    if (permission.messageId && permission.chatId) {
      const text = `🔐 <b>Permission request</b>\n<i>${note}</i>`;
      try {
        await telegram.editMessageText({
          chatId: permission.chatId,
          messageId: permission.messageId,
          text,
          plain: `Permission request\n${note}`,
          keyboard: [],
          timeoutMs: 6000,
        });
      } catch (error) {
        logger?.debug('Could not edit a permission card', { code: error?.code });
      }
    }
    store.touch();
  };

  return {
    handle,
    pendingCounts,
    enforceLead,
    removeLeadSession,
    closeForm,
    closeFormsForSession,
    findPermissionByRef,
    closePermission,
    currentMode,
  };
};

module.exports = {
  EVENT_TYPES,
  validateSessionEvent,
  createSessionEvents,
};
