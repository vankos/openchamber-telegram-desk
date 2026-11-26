'use strict';

const CALLBACK_PREFIX = 'td1';
const CALLBACK_LIMIT = 64;
const CALLBACK_KINDS = new Set(['q', 's', 'x', 'p', 'r']);
const CALLBACK_ACTIONS = new Set(['a', 'd', 't', 'f']);

/**
 * Telegram caps callback_data at 64 bytes. Full session/form ids do not fit, so the
 * payload is a version, a kind, an opaque ref stored in state, and an optional action.
 */
const encodeCallback = (kind, ref, action = null) => {
  if (!CALLBACK_KINDS.has(kind)) throw new TypeError(`Unknown callback kind: ${kind}`);
  if (!/^[a-z0-9]{6,16}$/.test(String(ref))) throw new TypeError('Callback ref must be 6-16 lower-case alphanumerics');
  if (action !== null && !CALLBACK_ACTIONS.has(action)) throw new TypeError(`Unknown callback action: ${action}`);
  const value = `${CALLBACK_PREFIX}:${kind}:${ref}${action ? `:${action}` : ''}`;
  if (Buffer.byteLength(value, 'utf8') > CALLBACK_LIMIT) throw new RangeError('callback_data exceeds 64 bytes');
  return value;
};

const parseCallback = (value) => {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > CALLBACK_LIMIT) return null;
  const match = /^td1:([qspxr]):([a-z0-9]{6,16})(?::([ad])?)?$/.exec(value);
  if (!match) return null;
  const [, kind, ref, action] = match;
  if (action && !CALLBACK_ACTIONS.has(action)) return null;
  return { kind, ref, action: action ?? null };
};

const callbackFits = (value) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= CALLBACK_LIMIT;

module.exports = {
  CALLBACK_LIMIT,
  encodeCallback,
  parseCallback,
  callbackFits,
};
