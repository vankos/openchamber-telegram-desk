'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDeskService } = require('../service/app');
const { createLogger } = require('../service/lib/log');

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const SERVICE_TOKEN = 'service-token-for-lead-validation';
const CHAT_ID = 100;

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await settle(5);
  }
  return false;
};

const notFound = () => {
  const error = new Error('Session not found');
  error.status = 404;
  error.code = 'NOT_FOUND';
  return error;
};

const unavailable = (message, code = 'HOST_UNAVAILABLE') => {
  const error = new Error(message);
  error.code = code;
  error.status = 0;
  return error;
};

const seedState = async (dir, overrides = {}) => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    offset: 0,
    pairedIds: [CHAT_ID],
    primaryChatId: CHAT_ID,
    leadSessionId: 'ses_old',
    leadSessionTitle: 'Old lead',
    leadSetAt: 1_000,
    leadPaused: false,
    sessionRegistry: {
      ses_old: {
        sessionId: 'ses_old',
        title: 'Old lead',
        parentId: null,
        directory: '/repo/old',
        status: 'idle',
        updatedAt: 900,
      },
    },
    ...overrides,
  }, null, 2));
};

const api = async (port, method, route, body = undefined) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
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

const createHarness = async (dir, {
  listSessions = async () => [],
  findArchivedSession = async () => null,
  sessionStatus = async () => ({ status: 'idle' }),
  awaitValidation = true,
} = {}) => {
  const logs = [];
  const logger = createLogger({ stream: { write: (line) => logs.push(line) }, clock: () => 1_000 });
  const sent = [];
  const edits = [];
  const statusCalls = [];
  const listCalls = [];
  const findCalls = [];
  const telegram = {
    token: TOKEN,
    setToken() {},
    async getMe() { return { id: 1, username: 'desk_bot' }; },
    async setMyCommands() { return true; },
    async sendMessage(payload) {
      sent.push(payload);
      return { message_id: 500 + sent.length };
    },
    async editMessageText(payload) {
      edits.push(payload);
      return true;
    },
    async answerCallbackQuery() { return true; },
    async getUpdates() { return []; },
  };
  const host = {
    available: true,
    async readSettings() {
      return { 'bot-token': TOKEN, allowlist: String(CHAT_ID), notify: 'all' };
    },
    async needsConfiguration() { return { saved: true }; },
    sessions: {
      async status(sessionId) {
        statusCalls.push(sessionId);
        return sessionStatus(sessionId);
      },
    },
  };
  const opencode = {
    available: true,
    async listSessions() {
      listCalls.push(true);
      return listSessions();
    },
    async findArchivedSession(sessionId) {
      findCalls.push(sessionId);
      return findArchivedSession(sessionId);
    },
    async listActiveSessionIds() {
      return new Set();
    },
  };
  const service = createDeskService({
    env: {
      OPENCHAMBER_SERVICE_PORT: '0',
      OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
      OPENCHAMBER_SERVICE_DATA_DIR: dir,
    },
    logger,
    clock: () => 1_000,
    startLoops: false,
    hostOverride: host,
    opencodeOverride: opencode,
    telegramOverride: telegram,
  });
  const { port } = await service.start();
  if (awaitValidation) {
    await service.leadValidation;
    await settle();
    await service.outbox.drain();
  }
  return { service, port, sent, edits, logs, statusCalls, listCalls, findCalls, telegram, host };
};

test('startup clears a lead that OpenCode and the host confirm is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir);
  const h = await createHarness(dir, {
    listSessions: async () => [{
      id: 'ses_other', title: 'Other session', parentId: null, directory: '/repo/other', updatedAt: 800,
    }],
    sessionStatus: async () => { throw notFound(); },
  });
  try {
    const status = h.service.getStatus();
    assert.equal(status.lead.sessionId, null);
    assert.equal(status.lead.paused, true);
    assert.equal(status.lead.setAt, null);
    assert.equal(h.service.store.state.sessionRegistry.ses_old, undefined);
    assert.equal(h.service.store.state.outbox.length, 0);

    // Exactly one notice, to the primary chat, and nothing was auto-selected.
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].chatId, CHAT_ID);
    assert.match(h.sent[0].text, /Telegram lead removed/);
    assert.match(h.sent[0].text, /Old lead/);
    assert.match(h.sent[0].text, /deleted or archived while the service was offline/);
    assert.match(h.sent[0].text, /Choose a new lead/);
    assert.equal(h.sent[0].text.includes(TOKEN), false);
    assert.equal(h.sent[0].text.includes(String(CHAT_ID)), false);
    assert.equal(h.logs.join('').includes(TOKEN), false);
  } finally {
    await h.service.stop();
  }
});

test('startup keeps a lead present in the OpenCode list without a notice', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir);
  const h = await createHarness(dir, {
    listSessions: async () => [{
      id: 'ses_old', title: 'Old lead', parentId: null, directory: '/repo/old', updatedAt: 900,
    }],
  });
  try {
    const status = h.service.getStatus();
    assert.equal(status.lead.sessionId, 'ses_old');
    assert.equal(status.lead.paused, false);
    assert.equal(h.service.store.state.sessionRegistry.ses_old.title, 'Old lead');
    assert.deepEqual(h.statusCalls, []);
    assert.equal(h.sent.length, 0);
    assert.equal(h.service.store.state.outbox.length, 0);
  } finally {
    await h.service.stop();
  }
});

test('startup keeps a host-resolved session that OpenCode does not confirm archived', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir);
  const h = await createHarness(dir, {
    // Archived sessions drop out of the active list and a missing raw record is not
    // proof of archiving, so the host fallback still keeps the binding.
    findArchivedSession: async () => null,
    listSessions: async () => [],
    sessionStatus: async () => ({ status: 'idle' }),
  });
  try {
    const status = h.service.getStatus();
    assert.equal(status.lead.sessionId, 'ses_old');
    assert.equal(status.lead.paused, false);
    assert.deepEqual(h.findCalls, ['ses_old']);
    assert.deepEqual(h.statusCalls, ['ses_old']);
    assert.equal(h.sent.length, 0);
  } finally {
    await h.service.stop();
  }
});

test('startup clears a lead confirmed archived while the service was offline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir);
  const h = await createHarness(dir, {
    findArchivedSession: async (sessionId) => ({
      id: sessionId,
      title: 'Old lead',
      parentId: null,
      directory: '/repo/old',
      updatedAt: 900,
      archived: true,
    }),
    listSessions: async () => [{
      id: 'ses_other', title: 'Other session', parentId: null, directory: '/repo/other', updatedAt: 800,
    }],
    sessionStatus: async () => ({ status: 'idle' }),
  });
  try {
    const status = h.service.getStatus();
    assert.equal(status.lead.sessionId, null);
    assert.equal(status.lead.paused, true);
    assert.equal(h.service.store.state.sessionRegistry.ses_old, undefined);
    assert.equal(h.service.store.state.outbox.length, 0);

    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].chatId, CHAT_ID);
    assert.match(h.sent[0].text, /Telegram lead removed/);
    assert.match(h.sent[0].text, /Old lead/);
    assert.match(h.sent[0].text, /archived while the service was offline/);
    assert.match(h.sent[0].text, /Choose a new lead/);
    assert.equal(h.service.store.state.leadSessionId, null);

    // The positive archived record settles it; the host is not consulted.
    assert.deepEqual(h.findCalls, ['ses_old']);
    assert.deepEqual(h.listCalls, []);
    assert.deepEqual(h.statusCalls, []);
  } finally {
    await h.service.stop();
  }
});

test('startup keeps the lead when the archived state cannot be read', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir);
  const h = await createHarness(dir, {
    findArchivedSession: async () => { throw unavailable('OpenCode did not answer', 'OPENCODE_UNAVAILABLE'); },
    listSessions: async () => [],
    sessionStatus: async () => ({ status: 'idle' }),
  });
  try {
    const status = h.service.getStatus();
    assert.equal(status.lead.sessionId, 'ses_old');
    assert.equal(status.lead.paused, false);
    assert.deepEqual(h.findCalls, ['ses_old']);
    assert.equal(h.sent.length, 0);
    assert.equal(h.service.store.state.stats.errors, 0);
  } finally {
    await h.service.stop();
  }
});

test('startup keeps the lead when OpenCode and the host fail transiently', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir);
  const h = await createHarness(dir, {
    listSessions: async () => { throw unavailable('OpenCode did not answer', 'OPENCODE_UNAVAILABLE'); },
    sessionStatus: async () => { throw unavailable('OpenChamber did not answer'); },
  });
  try {
    const status = h.service.getStatus();
    assert.equal(status.lead.sessionId, 'ses_old');
    assert.equal(status.lead.paused, false);
    assert.equal(h.sent.length, 0);
    assert.equal(h.service.store.state.stats.errors, 0);
    assert.deepEqual(h.statusCalls, ['ses_old']);
  } finally {
    await h.service.stop();
  }
});

test('startup keeps the lead when an empty list and a host 404 cannot prove deletion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir);
  const h = await createHarness(dir, {
    listSessions: async () => [],
    sessionStatus: async () => { throw notFound(); },
  });
  try {
    const status = h.service.getStatus();
    assert.equal(status.lead.sessionId, 'ses_old');
    assert.equal(status.lead.paused, false);
    assert.equal(h.sent.length, 0);
  } finally {
    await h.service.stop();
  }
});

test('a panel bind during startup validation survives the missing result', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir);
  let releaseStatus;
  let markStatusEntered;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  const statusEntered = new Promise((resolve) => { markStatusEntered = resolve; });
  const h = await createHarness(dir, {
    listSessions: async () => [{
      id: 'ses_new', title: 'New lead', parentId: null, directory: '/repo/new', updatedAt: 1_100,
    }],
    sessionStatus: async (sessionId) => {
      if (sessionId === 'ses_old') {
        markStatusEntered();
        await statusGate;
        throw notFound();
      }
      return { status: 'idle' };
    },
    awaitValidation: false,
  });
  try {
    assert.equal(await waitFor(() => h.statusCalls.includes('ses_old')), true);

    const bind = await api(h.port, 'POST', '/lead', { sessionId: 'ses_new' });
    assert.equal(bind.status, 200);
    assert.equal(bind.body.lead.sessionId, 'ses_new');
    assert.equal(bind.body.lead.paused, false);

    releaseStatus();
    await h.service.leadValidation;
    await settle();
    await h.service.outbox.drain();

    const status = h.service.getStatus();
    assert.equal(status.lead.sessionId, 'ses_new');
    assert.equal(status.lead.paused, false);
    assert.equal(h.sent.length, 0);
    assert.equal(h.service.store.state.outbox.length, 0);
  } finally {
    releaseStatus();
    await h.service.stop();
  }
});

test('a restart after the missing lead was cleared sends no second notice', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir);
  const first = await createHarness(dir, {
    listSessions: async () => [{
      id: 'ses_other', title: 'Other session', parentId: null, directory: '/repo/other', updatedAt: 800,
    }],
    sessionStatus: async () => { throw notFound(); },
  });
  try {
    assert.equal(first.sent.length, 1);
    assert.equal(first.service.getStatus().lead.paused, true);
  } finally {
    await first.service.stop();
  }

  const second = await createHarness(dir, {
    listSessions: async () => [{
      id: 'ses_other', title: 'Other session', parentId: null, directory: '/repo/other', updatedAt: 800,
    }],
    sessionStatus: async () => { throw notFound(); },
  });
  try {
    const status = second.service.getStatus();
    assert.equal(status.lead.sessionId, null);
    assert.equal(status.lead.paused, true);
    assert.equal(second.sent.length, 0);
    assert.equal(second.service.store.state.outbox.length, 0);
    assert.deepEqual(second.listCalls, []);
  } finally {
    await second.service.stop();
  }
});

test('a missing lead with no primary chat is cleared without a notice', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-lead-validation-'));
  await seedState(dir, { pairedIds: [], primaryChatId: null });
  const h = await createHarness(dir, {
    listSessions: async () => [{
      id: 'ses_other', title: 'Other session', parentId: null, directory: '/repo/other', updatedAt: 800,
    }],
    sessionStatus: async () => { throw notFound(); },
  });
  try {
    const status = h.service.getStatus();
    assert.equal(status.lead.sessionId, null);
    assert.equal(status.lead.paused, true);
    assert.equal(h.sent.length, 0);
    assert.equal(h.service.store.state.outbox.length, 0);
  } finally {
    await h.service.stop();
  }
});
