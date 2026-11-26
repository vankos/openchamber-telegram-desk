import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseManifestJson } from '@openchamber/sdk/schemas';

const root = resolve(import.meta.dirname, '..');
const failures = [];

const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const parsed = parseManifestJson(JSON.stringify(pkg));
check(parsed.ok, parsed.ok ? '' : `manifest: ${parsed.error?.message ?? JSON.stringify(parsed.error ?? parsed)}`);
if (!parsed.ok) {
  console.error(failures.join('\n'));
  process.exit(1);
}

const manifest = parsed.manifest;
check(manifest.apiVersion === 1, 'apiVersion must be 1');
check(Boolean(manifest.engines?.openchamber), 'engines.openchamber is required');
check(manifest.contributes?.panel?.id === 'telegram-desk', 'unexpected extension id');
check(manifest.contributes?.panel?.entry === 'panel/index.html', 'panel entry must be panel/index.html');
check(manifest.contributes?.service?.entry === 'service/main.js', 'service entry must be service/main.js');
check(manifest.contributes?.service?.runtime === 'host', 'service runtime must be host');
check(manifest.contributes?.service?.keepRunning === true, 'service.keepRunning must be true');
check(manifest.contributes?.service?.provides?.includes('opencode') === true, 'service must provide opencode reads');
check(manifest.contributes?.sessionControl?.answers === true, 'sessionControl.answers is required');
check(manifest.contributes?.sessionEvents?.content === true, 'sessionEvents.content is required');
check(manifest.contributes?.integration?.settings?.some((field) => field.id === 'bot-token' && field.secret === true), 'a secret bot-token setting is required');

const required = [
  'icon.svg',
  'panel/index.html',
  'panel/main.js',
  'panel/style.css',
  'service/main.js',
];
for (const file of required) check(existsSync(resolve(root, file)), `missing packaged file: ${file}`);

const html = readFileSync(resolve(root, 'panel/index.html'), 'utf8');
check(html.includes('src="./main.js"'), 'panel/index.html must load ./main.js');
const panel = readFileSync(resolve(root, 'panel/main.js'), 'utf8');
check(!/^\s*(import|export)\s/m.test(panel), 'panel/main.js must be a classic IIFE, not an ES module');

const service = readFileSync(resolve(root, 'service/main.js'), 'utf8');
check(service.includes("require('./app')"), 'service/main.js must bootstrap service/app.js');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Manifest and package are valid (${manifest.contributes.panel.id} v${pkg.version}).`);
