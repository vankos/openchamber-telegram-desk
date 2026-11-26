#!/usr/bin/env node
// Real Telegram connectivity check. Never put the token in chat; set it locally:
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
// On PowerShell:
//   $env:TELEGRAM_BOT_TOKEN="..."; $env:TELEGRAM_CHAT_ID="123"; npm run smoke:telegram

const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? '';
const apiBase = (process.env.TELEGRAM_DESK_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

const redact = (value) => String(value ?? '')
  .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
  .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');

const call = async (method, payload = {}) => {
  const response = await fetch(`${apiBase}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!body?.ok) {
    const description = body?.description || `HTTP ${response.status}`;
    throw new Error(redact(`${method}: ${description}`));
  }
  return body.result;
};

const main = async () => {
  if (!token) {
    console.log('TELEGRAM_BOT_TOKEN is not set. Set it locally, not in chat:');
    console.log('  PowerShell: $env:TELEGRAM_BOT_TOKEN="<token>"; $env:TELEGRAM_CHAT_ID="<chat id>"; npm run smoke:telegram');
    return;
  }
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    console.error('TELEGRAM_BOT_TOKEN does not look like a BotFather token.');
    process.exitCode = 1;
    return;
  }
  const me = await call('getMe');
  console.log(`Bot: @${me.username ?? me.first_name ?? me.id}`);
  if (!chatId) {
    console.log('TELEGRAM_CHAT_ID is not set; connectivity only. Set it to send one test message.');
    return;
  }
  if (!/^-?\d+$/.test(chatId)) {
    console.error('TELEGRAM_CHAT_ID must be a numeric Telegram chat id.');
    process.exitCode = 1;
    return;
  }
  const message = await call('sendMessage', {
    chat_id: Number(chatId),
    text: '<b>Telegram Desk smoke test</b>\nThe bot can reach this chat. Open the Telegram Desk panel to pair it and check the service.',
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
  console.log(`Message sent: ${message.message_id}`);
};

main().catch((error) => {
  console.error(redact(error?.message ?? error));
  process.exitCode = 1;
});
