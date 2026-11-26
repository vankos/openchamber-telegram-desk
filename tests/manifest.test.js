'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const { parseManifestJson } = require('@openchamber/sdk/schemas');

const root = path.resolve(__dirname, '..');

test('the packaged manifest parses', () => {
  const parsed = parseManifestJson(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed.error));
  const manifest = parsed.manifest;
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.contributes.panel.id, 'telegram-desk');
  assert.equal(manifest.contributes.service.entry, 'service/main.js');
  assert.equal(manifest.contributes.service.keepRunning, true);
  assert.equal(manifest.contributes.sessionControl.answers, true);
  assert.equal(manifest.contributes.sessionEvents.content, true);
  assert.equal(manifest.contributes.integration.settings.find((field) => field.id === 'bot-token').secret, true);
});

test('all files the host checks at install exist', () => {
  for (const file of ['icon.svg', 'panel/index.html', 'panel/main.js', 'service/main.js']) {
    assert.equal(existsSync(path.join(root, file)), true, `missing ${file}`);
  }
  const html = readFileSync(path.join(root, 'panel/index.html'), 'utf8');
  assert.match(html, /src="\.\/main\.js"/);
  const panel = readFileSync(path.join(root, 'panel/main.js'), 'utf8');
  assert.ok(!/^\s*(import|export)\s/m.test(panel), 'panel bundle must be a classic IIFE');
});
