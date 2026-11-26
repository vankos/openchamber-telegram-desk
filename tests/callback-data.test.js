'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encodeCallback, parseCallback, CALLBACK_LIMIT, callbackFits } = require('../service/lib/callback-data');

test('round-trips a question callback', () => {
  const value = encodeCallback('q', 'ab12cd34ef');
  assert.equal(value, 'td1:q:ab12cd34ef');
  assert.deepEqual(parseCallback(value), { kind: 'q', ref: 'ab12cd34ef', action: null });
});

test('round-trips a permission callback with an action', () => {
  const value = encodeCallback('p', 'ab12cd34ef', 'a');
  assert.equal(value, 'td1:p:ab12cd34ef:a');
  assert.deepEqual(parseCallback(value), { kind: 'p', ref: 'ab12cd34ef', action: 'a' });
});

test('rejects unknown kinds and malformed refs', () => {
  assert.throws(() => encodeCallback('z', 'ab12cd34ef'));
  assert.throws(() => encodeCallback('q', 'short'));
  assert.throws(() => encodeCallback('q', 'UPPER12345'));
  assert.equal(parseCallback('td1:z:ab12cd34ef'), null);
  assert.equal(parseCallback('nope'), null);
  assert.equal(parseCallback(''), null);
});

test('always fits Telegram 64-byte callback_data', () => {
  const value = encodeCallback('p', 'abcdefghijklmnop', 'd');
  assert.ok(Buffer.byteLength(value) <= CALLBACK_LIMIT);
  assert.ok(callbackFits(value));
  assert.equal(callbackFits('x'.repeat(65)), false);
});

test('rejects over-long payloads', () => {
  assert.equal(parseCallback('x'.repeat(65)), null);
});
