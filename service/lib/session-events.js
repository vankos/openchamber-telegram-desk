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
      text: payload.text,
      plain: payload.plain,
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
    store.touchSession(event.session.id, {
      title: request.content?.sessionTitle ?? current.title ?? null,
      parentId: event.session.parentId,
      directory: event.project.directory,
      ...(status ? { status } : {}),
    });
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

  const handle = async (body) => {
    const request = validateSessionEvent(body);
    if (!request) return { ok: false, error: 'invalid session event' };
    if (store.hasSeenEvent(request.event.id)) return { ok: true, duplicate: true };
    store.markEventSeen(request.event.id);
    store.bump('events');
    recordEvent(request);
    upsertSession(request);

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
        case 'turn-started':
        case 'session-created':
        case 'session-archived':
        case 'session-deleted':
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

  const pendingCounts = () => {
    const bySession = new Map();
    let questions = 0;
    let permissions = 0;
    for (const form of Object.values(store.state.forms)) {
      if (!form || form.closed) continue;
      questions += 1;
      bySession.set(form.sessionId, (bySession.get(form.sessionId) ?? 0) + 1);
    }
    for (const permission of Object.values(store.state.permissions)) {
      if (!permission || permission.closed) continue;
      permissions += 1;
      bySession.set(permission.sessionId, (bySession.get(permission.sessionId) ?? 0) + 1);
    }
    return { questions, permissions, bySession };
  };

  const closeForm = async (form, note = 'Question closed in OpenChamber.') => {
    form.closed = true;
    form.updatedAt = clock();
    if (form.messageId && form.chatId) {
      const rendered = renderDismissed(form, note);
      try {
        await telegram.editMessageText({
          chatId: form.chatId,
          messageId: form.messageId,
          text: rendered.text,
          plain: rendered.plain,
          keyboard: [],
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
