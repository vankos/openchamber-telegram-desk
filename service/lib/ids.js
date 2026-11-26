'use strict';

const crypto = require('node:crypto');

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REF_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

const randomFrom = (alphabet, length) => {
  const bytes = crypto.randomBytes(length);
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[bytes[index] % alphabet.length];
  }
  return value;
};

const randomRef = (length = 10) => randomFrom(REF_ALPHABET, length);

const randomPairCode = () => randomFrom(PAIR_ALPHABET, 8);

const normalizePairCode = (value) => String(value ?? '')
  .toUpperCase()
  .replace(/[\s-]+/g, '')
  .trim();

const formatPairCode = (code) => {
  const normalized = normalizePairCode(code);
  return normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
};

const shortSessionId = (sessionId) => {
  const value = String(sessionId ?? '');
  return value.length <= 16 ? value : `${value.slice(0, 16)}…`;
};

const timingSafeEqual = (left, right) => {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length !== b.length) {
    // Compare against itself to keep the timing independent of the failed length.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
};

module.exports = {
  randomRef,
  randomPairCode,
  normalizePairCode,
  formatPairCode,
  shortSessionId,
  timingSafeEqual,
};
