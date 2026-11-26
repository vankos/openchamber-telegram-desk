'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSettings, maskToken } = require('../service/lib/settings');

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

test('normalizes the bot token and allowlist', () => {
  const settings = normalizeSettings({
    'bot-token': ` ${TOKEN} `,
    allowlist: '100, -200, nope',
    notify: 'active',
  });
  assert.equal(settings.botToken, TOKEN);
  assert.equal(settings.tokenPresent, true);
  assert.equal(settings.tokenLooksValid, true);
  assert.deepEqual(settings.settingsAllowlist, [100, -200]);
  assert.deepEqual(settings.invalidAllowlist, ['nope']);
  assert.equal(settings.notifySetting, 'active');
});

test('defaults turn notifications to all', () => {
  assert.equal(normalizeSettings({}).notifySetting, 'all');
  assert.equal(normalizeSettings({ notify: 'nonsense' }).notifySetting, 'all');
});

test('marks malformed tokens without exposing them', () => {
  const settings = normalizeSettings({ 'bot-token': 'definitely-not-a-token' });
  assert.equal(settings.botToken, null);
  assert.equal(settings.tokenPresent, true);
  assert.equal(settings.tokenLooksValid, false);
});

test('maskToken shows only the numeric bot id', () => {
  assert.equal(maskToken(TOKEN), '123456:…');
  assert.equal(maskToken(''), '');
});
