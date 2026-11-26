'use strict';

const { safeError } = require('./log');

const createOutbox = ({
  store,
  telegram,
  logger,
  clock = Date.now,
  onDelivered = null,
  onFailed = null,
  isChatAllowed = () => true,
} = {}) => {
  let activeDrain = null;

  const finish = (item, delivery, detail = null) => {
    if (item.eventId) store.updateRecent(item.eventId, { delivery, ...(detail ? { detail } : {}) });
    if (delivery === 'failed') store.bump('errors');
    if (delivery === 'failed') onFailed?.(item, detail);
  };

  const deliver = async (item) => {
    const message = await telegram.sendMessage({
      chatId: item.chatId,
      text: item.text,
      plain: item.plain,
      keyboard: item.keyboard,
      replyToMessageId: item.replyToMessageId,
      disableNotification: item.kind === 'finish',
    });
    const messageId = message?.message_id;
    if (item.sessionId && Number.isSafeInteger(messageId)) {
      store.recordMessage(item.chatId, messageId, {
        sessionId: item.sessionId,
        sessionTitle: item.sessionTitle,
        kind: item.kind,
        formKey: item.formKey,
      });
    }
    if (item.formKey) {
      const form = store.state.forms[item.formKey];
      if (form) {
        form.messageId = Number.isSafeInteger(messageId) ? messageId : form.messageId;
        form.chatId = item.chatId;
        form.updatedAt = clock();
      }
    }
    if (item.permissionRef) {
      const permission = Object.values(store.state.permissions).find((entry) => entry.ref === item.permissionRef);
      if (permission) {
        permission.messageId = Number.isSafeInteger(messageId) ? messageId : permission.messageId;
        permission.chatId = item.chatId;
      }
    }
    store.removeOutbox(item.id);
    store.bump('sent');
    finish(item, 'sent');
    onDelivered?.(item, message);
  };

  const drain = () => {
    if (activeDrain) return activeDrain;
    const current = (async () => {
      try {
        for (const item of store.dueOutbox(clock())) {
          if (!isChatAllowed(item.chatId)) {
            store.removeOutbox(item.id);
            finish(item, 'failed', 'chat was removed from the allowlist');
            logger?.warn('Dropped an outbox item for a chat that is no longer allowed', { eventId: item.eventId });
            continue;
          }
          try {
            await deliver(item);
          } catch (error) {
            if (error?.code === 'NO_TOKEN') {
              store.updateOutbox(item.id, { nextAt: clock() + 30_000, lastError: 'no bot token configured' });
              continue;
            }
            if (error?.code === 401) {
              store.updateOutbox(item.id, { nextAt: clock() + 60_000, lastError: 'bot token was rejected' });
              continue;
            }
            const attempts = (item.attempts ?? 0) + 1;
            const transient = error?.transient === true;
            if (!transient || attempts >= 8) {
              store.removeOutbox(item.id);
              const detail = safeError(error);
              finish(item, 'failed', detail.description ?? detail.message ?? 'send failed');
              logger?.warn('Dropped an outbox item', {
                kind: item.kind,
                eventId: item.eventId,
                attempts,
                code: error?.code,
                description: error?.description,
              });
              continue;
            }
            const waitSeconds = error?.retryAfter || Math.min(60, 2 ** attempts);
            store.updateOutbox(item.id, {
              attempts,
              nextAt: clock() + waitSeconds * 1000,
              lastError: error?.description ?? 'transient send failure',
            });
            logger?.debug('Outbox send will retry', { kind: item.kind, attempts, waitSeconds });
          }
        }
      } finally {
        await store.flush();
      }
    })();
    activeDrain = current;
    void current.finally(() => {
      if (activeDrain === current) activeDrain = null;
    }).catch(() => {});
    return current;
  };

  return {
    enqueue(item) {
      const entry = store.addOutbox(item);
      void drain();
      return entry;
    },
    drain,
    get size() {
      return store.state.outbox.length;
    },
  };
};

module.exports = {
  createOutbox,
};
