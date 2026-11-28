'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOpenCodeClient, normalizeSession } = require('../service/lib/opencode');

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('normalizes OpenCode session records', () => {
  assert.deepEqual(normalizeSession({
    id: 'ses_1',
    title: 'Fix',
    parentID: null,
    directory: '/repo',
    time: { created: 10, updated: 20 },
  }), {
    id: 'ses_1',
    title: 'Fix',
    parentId: null,
    directory: '/repo',
    updatedAt: 20,
    archived: false,
  });
  assert.equal(normalizeSession(null), null);
  assert.equal(normalizeSession({ title: 'no id' }), null);
});

test('lists sessions newest first, drops archived items and sends the bearer', async () => {
  const calls = [];
  const client = createOpenCodeClient({
    baseUrl: 'http://127.0.0.1:4096',
    token: 'service-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json([
        { id: 'ses_old', title: 'Old', time: { updated: 10 } },
        { id: 'ses_new', title: 'New', time: { updated: 30 } },
        { id: 'ses_archived', title: 'Gone', time: { updated: 40, archived: 50 } },
      ]);
    },
  });
  const sessions = await client.listSessions();
  assert.deepEqual(sessions.map((session) => session.id), ['ses_new', 'ses_old']);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer service-secret');
});

test('findArchivedSession returns an archived record while listSessions hides it', async () => {
  const calls = [];
  const client = createOpenCodeClient({
    baseUrl: 'http://127.0.0.1:4096',
    token: 'service-secret',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return json([
        { id: 'ses_new', title: 'New', time: { updated: 30 } },
        { id: 'ses_archived', title: 'Gone', time: { updated: 40, archived: 50 } },
      ]);
    },
  });
  assert.deepEqual(await client.findArchivedSession('ses_archived'), {
    id: 'ses_archived',
    title: 'Gone',
    parentId: null,
    directory: null,
    updatedAt: 40,
    archived: true,
  });
  assert.equal(await client.findArchivedSession('ses_new'), null);
  assert.equal(await client.findArchivedSession('ses_missing'), null);
  assert.match(calls[0], /\/api\/session\?archived=true&limit=100$/);
  assert.deepEqual((await client.listSessions()).map((session) => session.id), ['ses_new']);
});

test('accepts a wrapped { data } session list', async () => {
  const client = createOpenCodeClient({
    baseUrl: 'http://127.0.0.1:4096',
    token: 't',
    fetchImpl: async () => json({ data: [{ id: 'ses_1', title: 'One', time: { updated: 1 } }] }),
  });
  assert.equal((await client.listSessions()).length, 1);
});

test('lists active session ids', async () => {
  const client = createOpenCodeClient({
    baseUrl: 'http://127.0.0.1:4096',
    token: 't',
    fetchImpl: async () => json([{ id: 'ses_1' }, 'ses_2']),
  });
  assert.deepEqual([...(await client.listActiveSessionIds())].sort(), ['ses_1', 'ses_2']);
});

test('fails explicitly when OpenCode refuses a read', async () => {
  const client = createOpenCodeClient({
    baseUrl: 'http://127.0.0.1:4096',
    token: 't',
    fetchImpl: async () => json({ message: 'not allowed' }, 403),
  });
  await assert.rejects(() => client.listSessions(), (error) => {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'OPENCODE_REQUEST_FAILED');
    return true;
  });
});

test('an unavailable client throws OPENCODE_UNAVAILABLE', async () => {
  const client = createOpenCodeClient({ baseUrl: '', token: '' });
  await assert.rejects(() => client.listSessions(), (error) => error.code === 'OPENCODE_UNAVAILABLE');
});
