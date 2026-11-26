'use strict';

const { redactString } = require('./log');

class TelegramError extends Error {
  constructor(message, {
    method = '',
    code = 0,
    description = '',
    transient = false,
    retryAfter = null,
  } = {}) {
    super(redactString(message));
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
    this.description = redactString(description || message);
    this.transient = transient;
    this.retryAfter = retryAfter;
  }
}

const createTelegramClient = ({
  token = null,
  apiBase = process.env.TELEGRAM_DESK_API_BASE || 'https://api.telegram.org',
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) => {
  let botToken = token;
  const base = String(apiBase).replace(/\/+$/, '');

  const setToken = (next) => {
    botToken = next || null;
  };

  const call = async (method, params = {}, { timeoutMs, signal } = {}) => {
    if (!botToken) throw new TelegramError('Bot token is not configured', { method, code: 'NO_TOKEN', transient: false });
    const wait = timeoutMs ?? (method === 'getUpdates' ? 45_000 : 20_000);
    const payload = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) payload[key] = value;
    }
    const timeout = AbortSignal.timeout(wait);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response;
    try {
      response = await fetchImpl(`${base}/bot${botToken}/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw new TelegramError(`${method}: aborted`, { method, transient: true });
      throw new TelegramError(`${method}: network error`, { method, transient: true });
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (body && body.ok === true) return body.result;
    const code = Number(body?.error_code ?? response.status ?? 0);
    const description = String(body?.description ?? `HTTP ${response.status}`);
    const retryAfter = Number(body?.parameters?.retry_after ?? 0) || null;
    const transient = code === 429 || code >= 500 || response.status === 429 || response.status >= 500;
    throw new TelegramError(`${method}: ${description}`, {
      method,
      code,
      description,
      transient,
      retryAfter,
    });
  };

  const shouldFallbackToPlain = (error) => (
    error instanceof TelegramError
    && error.code === 400
    && /parse|entit|tag/i.test(error.description)
  );

  return {
    setToken,
    get token() {
      return botToken;
    },
    call,
    async getMe() {
      return call('getMe');
    },
    async getUpdates({ offset = 0, timeout = 30, allowedUpdates = ['message', 'callback_query'], signal = null } = {}) {
      const result = await call('getUpdates', {
        offset: Number.isFinite(offset) ? offset : 0,
        timeout,
        allowed_updates: allowedUpdates,
        limit: 100,
      }, { timeoutMs: (timeout + 15) * 1000, signal });
      return Array.isArray(result) ? result : [];
    },
    async sendMessage({
      chatId,
      text,
      plain = null,
      keyboard = null,
      replyToMessageId = null,
      disableNotification = false,
    }) {
      const payload = {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(disableNotification ? { disable_notification: true } : {}),
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      };
      try {
        return await call('sendMessage', payload);
      } catch (error) {
        if (!plain || !shouldFallbackToPlain(error)) throw error;
        const fallback = { ...payload, text: plain };
        delete fallback.parse_mode;
        return call('sendMessage', fallback);
      }
    },
    async editMessageText({
      chatId,
      messageId,
      text,
      plain = null,
      keyboard = null,
      timeoutMs = undefined,
    }) {
      const payload = {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : { reply_markup: { inline_keyboard: [] } }),
      };
      try {
        return await call('editMessageText', payload, { timeoutMs });
      } catch (error) {
        if (shouldFallbackToPlain(error) && plain) {
          const fallback = { ...payload, text: plain };
          delete fallback.parse_mode;
          try {
            return await call('editMessageText', fallback, { timeoutMs });
          } catch (fallbackError) {
            if (fallbackError instanceof TelegramError && /not modified/i.test(fallbackError.description)) return null;
            throw fallbackError;
          }
        }
        if (error instanceof TelegramError && /not modified/i.test(error.description)) return null;
        throw error;
      }
    },
    async editMessageReplyMarkup({ chatId, messageId, keyboard = [] }) {
      try {
        return await call('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (error) {
        if (error instanceof TelegramError && /not modified/i.test(error.description)) return null;
        throw error;
      }
    },
    async answerCallbackQuery({ callbackQueryId, text = '', showAlert = false }) {
      return call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text: String(text).slice(0, 200) } : {}),
        ...(showAlert ? { show_alert: true } : {}),
      }, { timeoutMs: 10_000 });
    },
    async sendChatAction({ chatId, action = 'typing' }) {
      return call('sendChatAction', { chat_id: chatId, action }, { timeoutMs: 10_000 });
    },
    async setMyCommands(commands) {
      return call('setMyCommands', { commands }, { timeoutMs: 10_000 });
    },
    clock,
  };
};

module.exports = {
  TelegramError,
  createTelegramClient,
};
