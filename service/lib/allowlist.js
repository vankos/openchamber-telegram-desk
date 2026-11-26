'use strict';

const parseAllowlist = (input) => {
  if (typeof input !== 'string' || !input.trim()) return { ids: [], invalid: [] };
  const tokens = input.split(/[\s,;]+/).map((token) => token.trim()).filter(Boolean);
  const ids = [];
  const invalid = [];
  for (const token of tokens) {
    if (!/^-?\d{1,20}$/.test(token)) {
      invalid.push(token);
      continue;
    }
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value === 0) {
      invalid.push(token);
      continue;
    }
    if (!ids.includes(value)) ids.push(value);
  }
  return { ids, invalid };
};

const effectiveIds = (settingsIds = [], pairedIds = []) => {
  const values = [];
  for (const id of [...settingsIds, ...pairedIds]) {
    if (!Number.isSafeInteger(id) || id === 0) continue;
    if (!values.includes(id)) values.push(id);
  }
  return values;
};

const isIdAllowed = (ids, { userId, chatId }) => {
  const set = ids instanceof Set ? ids : new Set(ids);
  return (Number.isSafeInteger(userId) && set.has(userId))
    || (Number.isSafeInteger(chatId) && set.has(chatId));
};

const choosePrimaryChat = ({ current, pairedIds = [], settingsIds = [], effective = [] }) => {
  const allowed = new Set(effective);
  if (Number.isSafeInteger(current) && allowed.has(current)) return current;
  for (const id of [...pairedIds, ...settingsIds]) {
    if (Number.isSafeInteger(id) && allowed.has(id)) return id;
  }
  return null;
};

const isPrivateChat = (chat) => chat?.type === 'private';

module.exports = {
  parseAllowlist,
  effectiveIds,
  isIdAllowed,
  choosePrimaryChat,
  isPrivateChat,
};
