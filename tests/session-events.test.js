'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../service/lib/store');
const { createOutbox } = require('../service/lib/outbox');
const { createSessionEvents, validateSessionEvent } = require('../service/lib/session-events');
const { silentLogger } = require('../service/lib/log');

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

const baseEvent = (type, extra = {}) => ({
  v: 1,
  requestId: `req_${type}`,
  event: {
    id: `evt_${type}_${Math.random().toString(36).slice(2)}`,
    type,
    at: 1_000,
    session: { id: 'ses_1', parentId: null },
    project: { directory: '/repo' },
    linked: [],
    ...extra,
  },
});

const makeHarness = async ({ notifySetting = 'active' } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-events-'));
  let now = 1_000_000;
  const store = new Store({ dir, clock: () => now, logger: silentLogger });
  await store.load();
  store.setPrimaryChat(100);
  store.addPairedId(100);
  const sent = [];
  const edits = [];
  const telegram = {
    async sendMessage(payload) {
      sent.push(payload);
      return { message_id: 500 + sent.length };
    },
    async editMessageText(payload) {
      edits.push(payload);
      return true;
    },
  };
  const hostCalls = [];
  const host = {
    available: true,
    sessions: {
      async answerForm(...args) { hostCalls.push(['answerForm', ...args]); return { answered: true }; },
      async answerPermission(...args) { hostCalls.push(['answerPermission', ...args]); return { answered: true }; },
    },
  };
  const outbox = createOutbox({ store, telegram, logger: silentLogger, clock: () => now });
  const events = createSessionEvents({
    store,
    host,
    telegram,
    outbox,
    logger: silentLogger,
    getSettings: () => ({ notifySetting }),
    clock: () => now,
  });
  return {
    dir,
    store,
    sent,
    edits,
    hostCalls,
    outbox,
    events,
    telegram,
    advance: (ms) => { now += ms; },
    now: () => now,
  };
};

test('validates the session event wire shape', () => {
  const request = baseEvent('turn-finished');
  request.content = { type: 'turn-finished', sessionTitle: 'Fix', reply: 'done', replyTruncated: false };
  assert.ok(validateSessionEvent(request));
  assert.equal(validateSessionEvent({ v: 2 }), null);
  assert.equal(validateSessionEvent({ ...request, event: { ...request.event, type: 'unknown' } }), null);
  assert.equal(validateSessionEvent({ ...request, content: { type: 'turn-failed' } }), null);
  assert.equal(validateSessionEvent(JSON.stringify(request)).event.id, request.event.id);
});

test('question-asked creates a card, refs and a persisted form', async () => {
  const h = await makeHarness();
  const request = baseEvent('question-asked', { question: { kind: 'form', id: 'frm_1' } });
  request.content = {
    type: 'question-asked',
    sessionTitle: 'Fix parser',
    ask: {
      kind: 'form',
      id: 'frm_1',
      title: 'Pick a branch',
      fields: [{
        key: 'choice',
        type: 'string',
        title: 'Branch',
        required: true,
        options: [{ value: 'main', label: 'main' }, { value: 'dev', label: 'dev' }],
      }],
    },
  };
  const result = await h.events.handle(request);
  assert.equal(result.ok, true);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Pick a branch/);
  assert.equal(h.sent[0].keyboard.length, 2);
  const form = h.store.state.forms['ses_1:frm_1'];
  assert.ok(form);
  assert.equal(form.messageId, 501);
  assert.equal(form.chatId, 100);
  assert.ok(Object.values(h.store.state.refs).some((ref) => ref.value === 'main'));
  assert.equal(h.store.messageRoute(100, 501).sessionId, 'ses_1');
});

test('permission-asked creates Allow/Deny buttons and stores the request', async () => {
  const h = await makeHarness();
  const request = baseEvent('permission-asked', { permission: { requestId: 'perm_1' } });
  request.content = {
    type: 'permission-asked',
    sessionTitle: 'Fix parser',
    action: 'bash',
    resources: ['git push'],
    message: 'Push the branch?',
  };
  await h.events.handle(request);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 1);
  const buttons = h.sent[0].keyboard.flat();
  assert.equal(buttons.length, 2);
  assert.match(buttons[0].text, /Allow once/);
  assert.match(buttons[1].text, /Deny/);
  const permission = h.store.state.permissions.perm_1;
  assert.ok(permission);
  assert.equal(permission.messageId, 501);
  assert.equal(permission.closed, false);
});

test('turn-finished notifies only watched sessions in active mode', async () => {
  const h = await makeHarness();
  const request = baseEvent('turn-finished');
  request.content = { type: 'turn-finished', sessionTitle: 'Background', reply: 'done', replyTruncated: false };
  await h.events.handle(request);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.state.recentEvents.at(-1).delivery, 'suppressed');

  const watched = baseEvent('turn-finished');
  watched.event.session.id = 'ses_2';
  watched.content = { type: 'turn-finished', sessionTitle: 'Watched', reply: 'done', replyTruncated: false };
  h.store.watchSession('ses_2');
  await h.events.handle(watched);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Watched/);
});

test('turn-finished is suppressed in off mode and for subagents', async () => {
  const off = await makeHarness({ notifySetting: 'off' });
  off.store.watchSession('ses_1');
  const request = baseEvent('turn-finished');
  request.content = { type: 'turn-finished', sessionTitle: 'No', reply: 'done', replyTruncated: false };
  await off.events.handle(request);
  await settle();
  assert.equal(off.sent.length, 0);

  const sub = await makeHarness({ notifySetting: 'all' });
  const child = baseEvent('turn-finished', { session: { id: 'ses_child', parentId: 'ses_parent' } });
  child.content = { type: 'turn-finished', sessionTitle: 'Child', reply: 'done', replyTruncated: false };
  await sub.events.handle(child);
  await settle();
  assert.equal(sub.sent.length, 0);
});

test('duplicate event ids are ignored', async () => {
  const h = await makeHarness({ notifySetting: 'all' });
  const request = baseEvent('turn-finished');
  request.content = { type: 'turn-finished', sessionTitle: 'Once', reply: 'done', replyTruncated: false };
  await h.events.handle(request);
  await h.events.handle(request);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 1);
});

test('page questions are notices with a session route', async () => {
  const h = await makeHarness();
  const request = baseEvent('question-asked', { question: { kind: 'page', id: 'page_1' } });
  request.content = {
    type: 'question-asked',
    sessionTitle: 'Fix parser',
    ask: { kind: 'page', id: 'page_1', title: 'Choose a layout' },
  };
  await h.events.handle(request);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /cannot be answered from a service/);
  assert.equal(h.store.messageRoute(100, 501).sessionId, 'ses_1');
});

test('pending counts group questions and permissions by session', async () => {
  const h = await makeHarness();
  h.store.state.forms['ses_1:frm_1'] = { sessionId: 'ses_1', closed: false, updatedAt: 1 };
  h.store.state.forms['ses_1:frm_2'] = { sessionId: 'ses_1', closed: true, updatedAt: 1 };
  h.store.state.permissions.perm_1 = { sessionId: 'ses_2', closed: false };
  const counts = h.events.pendingCounts();
  assert.equal(counts.questions, 1);
  assert.equal(counts.permissions, 1);
  assert.equal(counts.bySession.get('ses_1'), 1);
  assert.equal(counts.bySession.get('ses_2'), 1);
});
