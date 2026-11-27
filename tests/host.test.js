'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHostClient, HostError } = require('../service/lib/host');

const makeHost = (handler) => {
  const calls = [];
  const client = createHostClient({
    callbackUrl: 'http://127.0.0.1:9999',
    token: 'service-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return handler(url, options, calls.length);
    },
  });
  return { client, calls };
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('calls the host callback with the service bearer', async () => {
  const { client, calls } = makeHost(async () => json({ result: { sent: true } }));
  const result = await client.sessions.send('ses_1', 'hello');
  assert.deepEqual(result, { sent: true });
  assert.equal(calls[0].url, 'http://127.0.0.1:9999/service/call');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer service-secret');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    method: 'sessions.send',
    input: { sessionId: 'ses_1', prompt: 'hello' },
  });
});

test('starts a session with the prompt and optional directory', async () => {
  const { client, calls } = makeHost(async () => json({ result: { sessionId: 'ses_new', directory: '/repo' } }));
  const result = await client.sessions.start({ prompt: 'fix it', directory: '/repo' });
  assert.deepEqual(result, { sessionId: 'ses_new', directory: '/repo' });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    method: 'sessions.start',
    input: { prompt: 'fix it', directory: '/repo' },
  });
});

test('answers forms and permissions with the right input shapes', async () => {
  const { client, calls } = makeHost(async () => json({ result: { answered: true } }));
  await client.sessions.answerForm('ses_1', 'frm_1', { choice: 'yes' }, 'from Telegram');
  await client.sessions.answerPermission('ses_1', 'perm_1', { decision: 'deny', message: 'no' });
  assert.deepEqual(JSON.parse(calls[0].options.body).input, {
    sessionId: 'ses_1',
    formId: 'frm_1',
    values: { choice: 'yes' },
    message: 'from Telegram',
  });
  assert.deepEqual(JSON.parse(calls[1].options.body).input, {
    sessionId: 'ses_1',
    requestId: 'perm_1',
    decision: 'deny',
    message: 'no',
  });
});

test('maps host refusals to HostError codes', async () => {
  const { client } = makeHost(async () => json({ error: { message: 'Not allowed', code: 'NOT_GRANTED' } }, 403));
  await assert.rejects(
    () => client.sessions.stop('ses_1'),
    (error) => {
      assert.ok(error instanceof HostError);
      assert.equal(error.code, 'NOT_GRANTED');
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test('readSettings returns the settings object', async () => {
  const { client } = makeHost(async () => json({ result: { settings: { 'bot-token': 'x' } } }));
  assert.deepEqual(await client.readSettings(), { 'bot-token': 'x' });
});

test('unavailable client refuses without a request', async () => {
  const client = createHostClient({ callbackUrl: '', token: '' });
  await assert.rejects(() => client.readSettings(), (error) => error.code === 'HOST_UNAVAILABLE');
});

test('network failures are HOST_UNAVAILABLE and do not leak the token', async () => {
  const { client } = makeHost(async () => {
    throw new Error('connection refused for service-secret');
  });
  await assert.rejects(
    () => client.readSettings(),
    (error) => {
      assert.equal(error.code, 'HOST_UNAVAILABLE');
      assert.ok(!error.message.includes('service-secret'));
      return true;
    },
  );
});
