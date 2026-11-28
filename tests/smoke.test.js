'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDeskService } = require('../service/app');
const { createLogger } = require('../service/lib/log');

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const SERVICE_TOKEN = 'service-token-for-tests';

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const questionEvent = () => ({
  v: 1,
  requestId: 'req_q1',
  event: {
    id: 'evt_q1',
    type: 'question-asked',
    at: 1_000,
    session: { id: 'ses_1', parentId: null },
    project: { directory: '/repo' },
    linked: [],
    question: { kind: 'form', id: 'frm_1' },
  },
  content: {
    type: 'question-asked',
    sessionTitle: 'Fix parser',
    ask: {
      kind: 'form',
      id: 'frm_1',
      title: 'Pick a branch',
      fields: [{
        key: 'branch',
        type: 'string',
        title: 'Branch',
        required: true,
        options: [{ value: 'main', label: 'main' }, { value: 'dev', label: 'dev' }],
      }],
    },
  },
});

const sessionDeletedEvent = () => ({
  v: 1,
  requestId: 'req_d1',
  event: {
    id: 'evt_d1',
    type: 'session-deleted',
    at: 3_000,
    session: { id: 'ses_1', parentId: null },
    project: { directory: '/repo' },
    linked: [],
  },
});

const permissionEvent = () => ({
  v: 1,
  requestId: 'req_p1',
  event: {
    id: 'evt_p1',
    type: 'permission-asked',
    at: 2_000,
    session: { id: 'ses_1', parentId: null },
    project: { directory: '/repo' },
    linked: [],
    permission: { requestId: 'perm_1' },
  },
  content: {
    type: 'permission-asked',
    sessionTitle: 'Fix parser',
    action: 'bash',
    resources: ['git push'],
    message: 'Push?',
  },
});

const createHarness = async (dataDir) => {
  const logs = [];
  const stream = { write: (line) => logs.push(line) };
  const logger = createLogger({ stream, clock: () => 1_000 });
  const sent = [];
  const edits = [];
  const callbackAnswers = [];
  const hostCalls = [];
  const telegram = {
    token: TOKEN,
    setToken() {},
    async getMe() { return { id: 1, username: 'desk_bot' }; },
    async setMyCommands() { return true; },
    async sendMessage(payload) {
      sent.push(payload);
      return { message_id: 500 + sent.length };
    },
    async editMessageText(payload) { edits.push(payload); return true; },
    async editMessageReplyMarkup() { return true; },
    async answerCallbackQuery(payload) { callbackAnswers.push(payload); return true; },
    async getUpdates() { return []; },
  };
  const host = {
    available: true,
    async readSettings() {
      return { 'bot-token': TOKEN, allowlist: '100', notify: 'active' };
    },
    async needsConfiguration() { return { saved: true }; },
    sessions: {
      async start(...args) { hostCalls.push(['start', ...args]); return { sessionId: 'ses_new', directory: '/repo' }; },
      async send(...args) { hostCalls.push(['send', ...args]); return { sent: true }; },
      async stop(...args) { hostCalls.push(['stop', ...args]); return { stopped: true }; },
      async status(...args) { hostCalls.push(['status', ...args]); return { status: 'idle' }; },
      async answerForm(...args) { hostCalls.push(['answerForm', ...args]); return { answered: true }; },
      async answerPermission(...args) { hostCalls.push(['answerPermission', ...args]); return { answered: true }; },
    },
  };
  const opencode = {
    available: true,
    async listSessions() {
      return [{ id: 'ses_seed', title: 'Seed project', parentId: null, directory: '/repo', updatedAt: 900 }];
    },
    async listActiveSessionIds() { return new Set(); },
  };
  const service = createDeskService({
    env: {
      OPENCHAMBER_SERVICE_PORT: '0',
      OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
      OPENCHAMBER_SERVICE_DATA_DIR: dataDir,
    },
    logger,
    clock: () => 1_000,
    startLoops: false,
    hostOverride: host,
    opencodeOverride: opencode,
    telegramOverride: telegram,
  });
  const { port } = await service.start();
  await service.refreshSettings({ force: true });
  await settle(20);
  return { service, port, sent, edits, callbackAnswers, hostCalls, logs, telegram, host };
};

const api = async (port, method, route, body = undefined, token = SERVICE_TOKEN) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, body: data };
};

test('smoke: health auth, question card, button answer, mapping and restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-smoke-'));
  const h = await createHarness(dir);
  try {
    const unauthorized = await api(h.port, 'GET', '/health', undefined, '');
    assert.equal(unauthorized.status, 401);
    const health = await api(h.port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const status = await api(h.port, 'GET', '/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, true);
    assert.deepEqual(status.body.allowlist.effective, [100]);

    const invalid = await api(h.port, 'POST', '/session-events', { v: 2 });
    assert.equal(invalid.status, 400);

    const event = await api(h.port, 'POST', '/session-events', questionEvent());
    assert.equal(event.status, 200);
    assert.equal(event.body.ok, true);
    await settle();
    await h.service.outbox.drain();

    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].text, /Pick a branch/);
    const callback = h.sent[0].keyboard[0][0].callback_data;
    assert.ok(callback);
    assert.equal(h.service.store.messageRoute(100, 501).sessionId, 'ses_1');

    await h.service.handleTelegramUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb-1',
        from: { id: 100, is_bot: false },
        data: callback,
        message: { message_id: 501, chat: { id: 100, type: 'private' } },
      },
    });
    await settle();
    const answer = h.hostCalls.find((call) => call[0] === 'answerForm');
    assert.deepEqual(answer, ['answerForm', 'ses_1', 'frm_1', { branch: 'main' }, undefined]);
    assert.equal(h.service.store.state.forms['ses_1:frm_1'].closed, true);
    assert.ok(h.callbackAnswers.some((item) => item.callbackQueryId === 'cb-1'));
    assert.equal(h.service.store.state.offset, 2);
    await h.service.store.flush();
    const stateOnDisk = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
    assert.ok(!stateOnDisk.includes(TOKEN), 'state.json must never contain the bot token');

    // Idempotent callback: the same callback_query id, carried by a new update,
    // must not answer the form twice.
    const before = h.hostCalls.filter((call) => call[0] === 'answerForm').length;
    await h.service.handleTelegramUpdate({
      update_id: 3,
      callback_query: {
        id: 'cb-1',
        from: { id: 100, is_bot: false },
        data: callback,
        message: { message_id: 501, chat: { id: 100, type: 'private' } },
      },
    });
    assert.equal(h.hostCalls.filter((call) => call[0] === 'answerForm').length, before);
    assert.ok(h.callbackAnswers.some((item) => item.callbackQueryId === 'cb-1' && item.text === 'Already handled'));
    assert.equal(h.service.store.state.offset, 4);

    // A stale duplicate update must not move the offset backwards.
    await h.service.handleTelegramUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb-1',
        from: { id: 100, is_bot: false },
        data: callback,
        message: { message_id: 501, chat: { id: 100, type: 'private' } },
      },
    });
    assert.equal(h.service.store.state.offset, 4);
    assert.ok(h.logs.join('').includes('Telegram Desk service listening'));
    assert.ok(!h.logs.join('').includes(TOKEN), 'logs must never contain the bot token');

    // Leave one question open across a restart to prove the ref/form state survives.
    const second = questionEvent();
    second.requestId = 'req_q2';
    second.event.id = 'evt_q2';
    second.event.session.id = 'ses_2';
    second.event.question.id = 'frm_2';
    second.content.sessionTitle = 'Second session';
    second.content.ask.id = 'frm_2';
    second.content.ask.title = 'Second question';
    second.content.ask.fields[0].key = 'branch2';
    const secondResponse = await api(h.port, 'POST', '/session-events', second);
    assert.equal(secondResponse.status, 200);
    await settle();
    await h.service.outbox.drain();
    assert.equal(h.sent.length, 2);
    const secondCallback = h.sent[1].keyboard[0][0].callback_data;

    await h.service.stop();

    // Restart against the same data directory.
    const again = await createHarness(dir);
    try {
      assert.equal(again.service.store.state.offset, 4);
      assert.equal(again.service.store.messageRoute(100, 501).sessionId, 'ses_1');
      const statusAfter = await api(again.port, 'GET', '/status');
      assert.equal(statusAfter.body.allowlist.primaryChatId, 100);

      // The form opened before the restart still answers through the persisted ref.
      await again.service.handleTelegramUpdate({
        update_id: 50,
        callback_query: {
          id: 'cb-restart',
          from: { id: 100, is_bot: false },
          data: secondCallback,
          message: { message_id: 502, chat: { id: 100, type: 'private' } },
        },
      });
      const restartedAnswer = again.hostCalls.find((call) => call[0] === 'answerForm');
      assert.deepEqual(restartedAnswer, ['answerForm', 'ses_2', 'frm_2', { branch2: 'main' }, undefined]);
      assert.equal(again.service.store.state.offset, 51);
    } finally {
      await again.service.stop();
    }
  } finally {
    await h.service.stop().catch(() => {});
  }
});

test('smoke: pairing and commands flow through real Telegram updates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-smoke-'));
  const h = await createHarness(dir);
  try {
    const pairing = await api(h.port, 'POST', '/pair/code');
    assert.equal(pairing.status, 200);
    await h.service.handleTelegramUpdate({
      update_id: 100,
      message: {
        message_id: 1,
        from: { id: 300, is_bot: false },
        chat: { id: 300, type: 'private' },
        text: `/start ${pairing.body.code}`,
      },
    });
    assert.ok(h.service.store.state.pairedIds.includes(300));
    assert.ok(h.sent.some((message) => /Paired/.test(message.text)));

    await h.service.handleTelegramUpdate({
      update_id: 101,
      message: {
        message_id: 2,
        from: { id: 300, is_bot: false },
        chat: { id: 300, type: 'private' },
        text: '/help',
      },
    });
    assert.ok(h.sent.some((message) => /Telegram Desk/.test(message.text) && /\/status/.test(message.text)));
    assert.equal(h.service.store.state.offset, 102);

    const unauthorized = await h.service.processUpdate({
      update_id: 102,
      message: {
        message_id: 3,
        from: { id: 999, is_bot: false },
        chat: { id: 999, type: 'private' },
        text: '/status',
      },
    });
    assert.equal(unauthorized, undefined);
    assert.ok(!h.sent.some((message) => message.chatId === 999));
  } finally {
    await h.service.stop();
  }
});

test('smoke: permission card answers through the host and unauthorized chats are ignored', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-smoke-'));
  const h = await createHarness(dir);
  try {
    const event = await api(h.port, 'POST', '/session-events', permissionEvent());
    assert.equal(event.status, 200);
    await settle();
    await h.service.outbox.drain();
    assert.equal(h.sent.length, 1);
    const allow = h.sent[0].keyboard[0][0];
    assert.match(allow.text, /Allow once/);

    await h.service.handleTelegramUpdate({
      update_id: 10,
      callback_query: {
        id: 'cb-allow',
        from: { id: 100, is_bot: false },
        data: allow.callback_data,
        message: { message_id: 501, chat: { id: 100, type: 'private' } },
      },
    });
    await settle();
    const answer = h.hostCalls.find((call) => call[0] === 'answerPermission');
    assert.deepEqual(answer, ['answerPermission', 'ses_1', 'perm_1', { decision: 'allow' }]);
    assert.equal(h.service.store.state.permissions.perm_1.closed, true);

    const before = h.hostCalls.length;
    await h.service.handleTelegramUpdate({
      update_id: 11,
      callback_query: {
        id: 'cb-outsider',
        from: { id: 999, is_bot: false },
        data: allow.callback_data,
        message: { message_id: 501, chat: { id: 999, type: 'private' } },
      },
    });
    await settle();
    assert.equal(h.hostCalls.length, before);
    assert.ok(h.callbackAnswers.some((item) => item.callbackQueryId === 'cb-outsider' && item.text === 'Not allowed'));

    const testResult = await api(h.port, 'POST', '/test');
    assert.equal(testResult.status, 200);
    assert.equal(testResult.body.ok, true);

    const pairing = await api(h.port, 'POST', '/pair/code');
    assert.equal(pairing.status, 200);
    assert.match(pairing.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const notify = await api(h.port, 'POST', '/notify-mode', { mode: 'off' });
    assert.equal(notify.body.mode, 'off');
    const status = await api(h.port, 'GET', '/status');
    assert.equal(status.body.preferences.notifyMode, 'off');
  } finally {
    await h.service.stop();
  }
});

test('smoke: /new starts a session and routes its confirmation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-smoke-'));
  const h = await createHarness(dir);
  try {
    await h.service.handleTelegramUpdate({
      update_id: 200,
      message: {
        message_id: 10,
        from: { id: 100, is_bot: false },
        chat: { id: 100, type: 'private' },
        text: '/new fix the failing tests',
      },
    });
    const start = h.hostCalls.find((call) => call[0] === 'start');
    assert.deepEqual(start, ['start', { prompt: 'fix the failing tests', directory: '/repo' }]);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].text, /New session started/);
    assert.match(h.sent[0].text, /ses_new/);
    assert.equal(h.service.store.messageRoute(100, 501).sessionId, 'ses_new');
    assert.equal(h.service.store.isWatched('ses_new'), true);

    await h.service.handleTelegramUpdate({
      update_id: 201,
      message: {
        message_id: 11,
        from: { id: 100, is_bot: false },
        chat: { id: 100, type: 'private' },
        text: 'one more thing',
        reply_to_message: {
          message_id: 501,
          from: { id: 1, is_bot: true, username: 'desk_bot' },
        },
      },
    });
    const sent = h.hostCalls.find((call) => call[0] === 'send');
    assert.deepEqual(sent, ['send', 'ses_new', 'one more thing']);
    assert.equal(h.service.store.state.offset, 202);
  } finally {
    await h.service.stop();
  }
});

test('smoke: session-deleted leaves /sessions, closes cards and keeps replies clear', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-smoke-'));
  const h = await createHarness(dir);
  try {
    assert.equal((await api(h.port, 'POST', '/session-events', questionEvent())).body.ok, true);
    assert.equal((await api(h.port, 'POST', '/session-events', permissionEvent())).body.ok, true);
    await settle();
    await h.service.outbox.drain();
    assert.equal(h.sent.length, 2);
    const formCallback = h.sent[0].keyboard[0][0].callback_data;
    const formRoute = h.service.store.messageRoute(100, 501);
    assert.equal(formRoute.sessionId, 'ses_1');
    assert.equal(h.service.store.state.forms['ses_1:frm_1'].messageId, 501);
    assert.equal(h.service.store.state.permissions.perm_1.messageId, 502);

    const before = await api(h.port, 'GET', '/sessions');
    assert.equal(before.status, 200);
    assert.ok(before.body.sessions.some((session) => session.id === 'ses_1'));

    const deleted = await api(h.port, 'POST', '/session-events', sessionDeletedEvent());
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);

    const after = await api(h.port, 'GET', '/sessions');
    assert.equal(after.status, 200);
    assert.ok(!after.body.sessions.some((session) => session.id === 'ses_1'));
    assert.ok(after.body.sessions.some((session) => session.id === 'ses_seed'));
    assert.equal(h.service.store.state.sessionRegistry.ses_1, undefined);
    assert.equal(h.service.store.state.forms['ses_1:frm_1'].closed, true);
    assert.equal(h.service.store.state.permissions.perm_1.closed, true);
    assert.equal(h.service.store.messageRoute(100, 501).sessionId, 'ses_1');
    assert.equal(h.service.store.messageRoute(100, 502).sessionId, 'ses_1');
    assert.ok(h.edits.some((edit) => edit.messageId === 501 && /deleted in OpenChamber/.test(edit.text)));
    assert.ok(h.edits.some((edit) => edit.messageId === 502 && /deleted in OpenChamber/.test(edit.text)));

    const commandSessions = await h.service.commands.handleMessage({
      chatId: 100, userId: 100, text: '/sessions', isPrivate: true, chatType: 'private',
    });
    assert.doesNotMatch(commandSessions.text, /ses_1/);
    assert.match(commandSessions.text, /ses_seed/);

    // A stale button press closes quietly and never reaches the host.
    const answersBefore = h.hostCalls.filter((call) => String(call[0]).startsWith('answer')).length;
    await h.service.handleTelegramUpdate({
      update_id: 300,
      callback_query: {
        id: 'cb-deleted-form',
        from: { id: 100, is_bot: false },
        data: formCallback,
        message: { message_id: 501, chat: { id: 100, type: 'private' } },
      },
    });
    assert.equal(h.hostCalls.filter((call) => String(call[0]).startsWith('answer')).length, answersBefore);
    assert.ok(h.callbackAnswers.some((item) => item.callbackQueryId === 'cb-deleted-form'));

    // Replying to an old card still resolves to the deleted session and reports the host's
    // answer instead of sending the text to another session.
    h.host.sessions.send = async () => {
      const error = new Error('Session not found');
      error.status = 404;
      error.code = 'NOT_FOUND';
      throw error;
    };
    await h.service.handleTelegramUpdate({
      update_id: 301,
      message: {
        message_id: 20,
        from: { id: 100, is_bot: false },
        chat: { id: 100, type: 'private' },
        text: 'continue please',
        reply_to_message: {
          message_id: 501,
          from: { id: 1, is_bot: true, username: 'desk_bot' },
        },
      },
    });
    assert.ok(h.sent.some((message) => /Session not found/.test(message.text)));
    assert.equal(h.hostCalls.filter((call) => call[0] === 'send').length, 0);
  } finally {
    await h.service.stop();
  }
});
