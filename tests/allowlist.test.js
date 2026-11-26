'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAllowlist,
  effectiveIds,
  isIdAllowed,
  choosePrimaryChat,
  isPrivateChat,
} = require('../service/lib/allowlist');

test('parses comma and whitespace separated numeric IDs', () => {
  assert.deepEqual(parseAllowlist('123, 456\n-789;123'), {
    ids: [123, 456, -789],
    invalid: [],
  });
});

test('rejects non-numeric and unsafe IDs', () => {
  const parsed = parseAllowlist('@name, 0, 123, 99999999999999999999');
  assert.deepEqual(parsed.ids, [123]);
  assert.equal(parsed.invalid.length, 3);
});

test('effective list deduplicates settings and paired IDs', () => {
  assert.deepEqual(effectiveIds([1, 2], [2, 3]), [1, 2, 3]);
  assert.deepEqual(effectiveIds([], []), []);
});

test('a user or a chat ID can allow a message', () => {
  const ids = [10, -100];
  assert.equal(isIdAllowed(ids, { userId: 10, chatId: 999 }), true);
  assert.equal(isIdAllowed(ids, { userId: 999, chatId: -100 }), true);
  assert.equal(isIdAllowed(ids, { userId: 999, chatId: 999 }), false);
});

test('primary chat prefers an allowed current chat, then paired, then settings', () => {
  assert.equal(choosePrimaryChat({ current: 2, pairedIds: [3], settingsIds: [1], effective: [1, 2, 3] }), 2);
  assert.equal(choosePrimaryChat({ current: 9, pairedIds: [3], settingsIds: [1], effective: [1, 3] }), 3);
  assert.equal(choosePrimaryChat({ current: null, pairedIds: [], settingsIds: [1], effective: [1] }), 1);
  assert.equal(choosePrimaryChat({ current: 9, pairedIds: [], settingsIds: [], effective: [] }), null);
});

test('private chat detection', () => {
  assert.equal(isPrivateChat({ type: 'private' }), true);
  assert.equal(isPrivateChat({ type: 'group' }), false);
  assert.equal(isPrivateChat(null), false);
});
