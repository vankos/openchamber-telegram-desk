'use strict';

const { parseAllowlist } = require('./allowlist');

const BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
const NOTIFY_MODES = new Set(['all', 'active', 'off']);

const normalizeSettings = (raw = {}) => {
  const token = typeof raw['bot-token'] === 'string' ? raw['bot-token'].trim() : '';
  const allowlist = parseAllowlist(raw.allowlist ?? '');
  const notifyRaw = String(raw.notify ?? '').trim().toLowerCase();
  const notifySetting = NOTIFY_MODES.has(notifyRaw) ? notifyRaw : 'all';
  return {
    botToken: BOT_TOKEN_PATTERN.test(token) ? token : null,
    tokenPresent: Boolean(token),
    tokenLooksValid: BOT_TOKEN_PATTERN.test(token),
    settingsAllowlist: allowlist.ids,
    invalidAllowlist: allowlist.invalid,
    notifySetting,
  };
};

const maskToken = (token) => {
  if (!token) return '';
  const [id] = String(token).split(':');
  return `${id}:…`;
};

module.exports = {
  BOT_TOKEN_PATTERN,
  NOTIFY_MODES,
  normalizeSettings,
  maskToken,
};
