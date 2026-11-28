'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../service/lib/store');
const { createOutbox } = require('../service/lib/outbox');
const { createSessionEvents } = require('../service/lib/session-events');
const { createAnswerEngine } = require('../service/lib/answers');
const { createCommands } = require('../service/lib/commands');
const { createFormState } = require('../service/lib/forms');
const { silentLogger } = require('../service/lib/log');

const makeHarness = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-commands-'));
  let now = 2_000_000;
  const store = new Store({ dir, clock: () => now, logger: silentLogger });
  await store.load();
  const settings = {
    tokenPresent: true,
    settingsAllowlist: [100],
    notifySetting: 'active',
  };
  const sent = [];
  const telegram = {
    async sendMessage(payload) { sent.push(payload); return { message_id: 900 + sent.length }; },
    async editMessageText() { return true; },
  };
  const hostCalls = [];
  const host = {
    available: true,
    sessions: {
      async start(...args) { hostCalls.push(['start', ...args]); return { sessionId: 'ses_new', directory: '/repo/one' }; },
      async send(...args) { hostCalls.push(['send', ...args]); return { sent: true }; },
      async stop(...args) { hostCalls.push(['stop', ...args]); return { stopped: true }; },
      async status(sessionId) { hostCalls.push(['status', sessionId]); return { status: sessionId === 'ses_2' ? 'busy' : 'idle' }; },
      async answerForm(...args) { hostCalls.push(['answerForm', ...args]); return { answered: true }; },
      async answerPermission(...args) { hostCalls.push(['answerPermission', ...args]); return { answered: true }; },
    },
  };
  const opencode = {
    available: true,
    async listSessions() {
      return [
        { id: 'ses_1', title: 'Fix parser', parentId: null, directory: '/repo/one', updatedAt: 200 },
        { id: 'ses_2', title: 'Build release', parentId: null, directory: '/repo/two', updatedAt: 100 },
      ];
    },
    async listActiveSessionIds() { return new Set(['ses_2']); },
  };
  const outbox = createOutbox({ store, telegram, logger: silentLogger, clock: () => now });
  const sessionEvents = createSessionEvents({
    store, host, telegram, outbox, logger: silentLogger, getSettings: () => settings, clock: () => now,
  });
  const answerEngine = createAnswerEngine({ store, host, telegram, logger: silentLogger, clock: () => now });
  const commands = createCommands({
    store, host, opencode, sessionEvents, answerEngine, logger: silentLogger, getSettings: () => settings, clock: () => now,
  });
  return { dir, store, settings, sent, hostCalls, host, opencode, outbox, sessionEvents, answerEngine, commands, advance: (ms) => { now += ms; } };
};

test('unauthorized chats are ignored', async () => {
  const h = await makeHarness();
  const result = await h.commands.handleMessage({
    chatId: 999, userId: 999, text: '/status', isPrivate: true, chatType: 'private',
  });
  assert.equal(result, null);
});

test('a pairing code allows a private chat and is single use', async () => {
  const h = await makeHarness();
  h.store.setPairCode('ABCD2345', 600_000);
  const paired = await h.commands.handleMessage({
    chatId: 200, userId: 200, text: '/start ABCD-2345', isPrivate: true, chatType: 'private', botUsername: 'desk_bot',
  });
  assert.match(paired.text, /Paired/);
  assert.deepEqual(h.store.state.pairedIds, [200]);
  const again = await h.commands.handleMessage({
    chatId: 200, userId: 200, text: '/start', isPrivate: true, chatType: 'private', botUsername: 'desk_bot',
  });
  assert.match(again.text, /already paired/i);
});

test('/status reports waiting, busy and idle sessions', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.store.state.forms['ses_1:frm_1'] = { sessionId: 'ses_1', closed: false, updatedAt: 1 };
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/status', isPrivate: true, chatType: 'private',
  });
  assert.match(result.text, /1 busy/);
  assert.match(result.text, /1 waiting/);
  assert.match(result.text, /Fix parser/);
});

test('/sessions stores indexes and /send resolves an index', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  const sessions = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/sessions', isPrivate: true, chatType: 'private',
  });
  assert.match(sessions.text, /Fix parser/);
  assert.deepEqual(h.store.lastSessionList(100), ['ses_1', 'ses_2']);

  const sent = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/send 1 please continue', isPrivate: true, chatType: 'private',
  });
  assert.match(sent.text, /Sent to/);
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'send'), ['send', 'ses_1', 'please continue']);
});

test('a deleted session leaves /sessions and an old index cannot misroute', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.store.touchSession('ses_gone', { title: 'Deleted session', status: 'busy', directory: '/repo/gone' });
  h.store.setLastSessionList(100, ['ses_1', 'ses_gone', 'ses_2']);
  await h.sessionEvents.handle({
    v: 1,
    requestId: 'req_deleted',
    event: {
      id: 'evt_deleted',
      type: 'session-deleted',
      at: 1,
      session: { id: 'ses_gone', parentId: null },
      project: { directory: '/repo/gone' },
      linked: [],
    },
  });
  assert.equal(h.store.state.sessionRegistry.ses_gone, undefined);
  assert.deepEqual(h.store.lastSessionList(100), ['ses_1', null, 'ses_2']);

  const stale = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/send 2 hello', isPrivate: true, chatType: 'private',
  });
  assert.match(stale.text, /No session number 2/);
  assert.equal(h.hostCalls.filter((call) => call[0] === 'send').length, 0);

  const shifted = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/send 3 hello', isPrivate: true, chatType: 'private',
  });
  assert.match(shifted.text, /Sent to/);
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'send'), ['send', 'ses_2', 'hello']);

  const sessions = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/sessions', isPrivate: true, chatType: 'private',
  });
  assert.doesNotMatch(sessions.text, /ses_gone/);
  assert.match(sessions.text, /ses_1/);
  assert.match(sessions.text, /ses_2/);
});

test('/new starts a session with the task and routes the confirmation', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/new fix the failing tests', isPrivate: true, chatType: 'private',
  });
  assert.match(result.text, /New session started/);
  assert.match(result.text, /ses_new/);
  assert.equal(result.sessionId, 'ses_new');
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'start'), ['start', { prompt: 'fix the failing tests', directory: '/repo/one' }]);
  assert.equal(h.store.isWatched('ses_new'), true);
  assert.equal(h.store.state.sessionRegistry.ses_new.status, 'busy');
  assert.equal(h.store.state.sessionRegistry.ses_new.directory, '/repo/one');
});

test('/new requires a task', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/new', isPrivate: true, chatType: 'private',
  });
  assert.match(result.text, /Usage: \/new/);
  assert.equal(h.hostCalls.filter((call) => call[0] === 'start').length, 0);
});

test('/new explains when no project is known', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.opencode.listSessions = async () => [];
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/new ship it', isPrivate: true, chatType: 'private',
  });
  assert.match(result.text, /No project is known/);
  assert.equal(h.hostCalls.filter((call) => call[0] === 'start').length, 0);
});

test('/new explains a missing model', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.host.sessions.start = async () => {
    const error = new Error('No model');
    error.code = 'NO_MODEL';
    throw error;
  };
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/new go', isPrivate: true, chatType: 'private',
  });
  assert.match(result.text, /No model/);
  assert.equal(result.sessionId, undefined);
});

test('/send resolves a unique id prefix and closes an open form', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  const form = createFormState(
    { sessionId: 'ses_1', sessionTitle: 'Fix parser', chatId: 100 },
    { id: 'frm_1', title: 'Pick', fields: [{ key: 'x', type: 'string', title: 'X', required: true }] },
  );
  form.messageId = 500;
  h.store.state.forms['ses_1:frm_1'] = form;
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/send ses_1 go', isPrivate: true, chatType: 'private',
  });
  assert.match(result.text, /Sent to/);
  assert.equal(form.closed, true);
});

test('/send and /stop accept a quoted multi-word title', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  const sent = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/send "Fix parser" continue', isPrivate: true, chatType: 'private',
  });
  assert.match(sent.text, /Sent to/);
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'send'), ['send', 'ses_1', 'continue']);
  const stopped = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/stop "Fix parser"', isPrivate: true, chatType: 'private',
  });
  assert.match(stopped.text, /Stopped/);
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'stop'), ['stop', 'ses_1']);
});

test('/digest records the digest time and reports pending answers', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.store.state.forms['ses_1:frm_1'] = { sessionId: 'ses_1', closed: false, updatedAt: 1 };
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/digest', isPrivate: true, chatType: 'private',
  });
  assert.match(result.text, /digest/i);
  assert.match(result.text, /1 question/);
  assert.ok(h.store.lastDigest(100) > 0);
});

test('a reply to a session message is sent to that session', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.store.recordMessage(100, 501, { sessionId: 'ses_2', sessionTitle: 'Build release', kind: 'finish' });
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: 'one more thing', isPrivate: true, chatType: 'private', replyToMessageId: 501,
  });
  assert.match(result.text, /Sent to/);
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'send'), ['send', 'ses_2', 'one more thing']);
});

test('a reply to an open form answers its text field', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  const form = createFormState(
    { sessionId: 'ses_1', sessionTitle: 'Fix parser', chatId: 100 },
    {
      id: 'frm_1',
      title: 'Details',
      fields: [{ key: 'note', type: 'string', title: 'Note', required: true }],
    },
  );
  form.messageId = 777;
  h.store.state.forms['ses_1:frm_1'] = form;
  h.store.recordMessage(100, 777, { sessionId: 'ses_1', sessionTitle: 'Fix parser', kind: 'form', formKey: 'ses_1:frm_1' });
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: 'some details', isPrivate: true, chatType: 'private', replyToMessageId: 777,
  });
  assert.match(result.text, /Answer sent|Saved/);
  const call = h.hostCalls.find((item) => item[0] === 'answerForm');
  assert.deepEqual(call, ['answerForm', 'ses_1', 'frm_1', { note: 'some details' }, undefined]);
});

test('unknown commands and plain text get a short help reply', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  const unknown = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/nope', isPrivate: true, chatType: 'private',
  });
  assert.match(unknown.text, /Unknown command/);
  const plain = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: 'hello', isPrivate: true, chatType: 'private',
  });
  assert.match(plain.text, /Reply to a bot message/);
});

test('a lead scopes /status, /sessions, /send and /stop', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.store.setLeadSession({ sessionId: 'ses_2', title: 'Build release' });
  h.store.state.forms['ses_2:frm_lead'] = { sessionId: 'ses_2', closed: false, updatedAt: 1 };
  h.store.state.forms['ses_1:frm_other'] = { sessionId: 'ses_1', closed: false, updatedAt: 1 };

  const status = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/status', isPrivate: true, chatType: 'private',
  });
  assert.match(status.text, /Build release/);
  assert.match(status.text, /1 waiting/);
  assert.doesNotMatch(status.text, /Fix parser/);
  assert.doesNotMatch(status.text, /ses_1/);

  const sessions = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/sessions', isPrivate: true, chatType: 'private',
  });
  assert.match(sessions.text, /ses_2/);
  assert.doesNotMatch(sessions.text, /ses_1/);
  assert.deepEqual(h.store.lastSessionList(100), ['ses_2']);

  const byDefault = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/send hello there', isPrivate: true, chatType: 'private',
  });
  assert.match(byDefault.text, /Sent to/);
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'send'), ['send', 'ses_2', 'hello there']);

  const byNumber = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/send 1 another', isPrivate: true, chatType: 'private',
  });
  assert.match(byNumber.text, /Sent to/);
  assert.deepEqual(h.hostCalls.filter((call) => call[0] === 'send').at(-1), ['send', 'ses_2', 'another']);

  const sendsBefore = h.hostCalls.filter((call) => call[0] === 'send').length;
  const other = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/send ses_1 no', isPrivate: true, chatType: 'private',
  });
  assert.match(other.text, /only to the Telegram lead/);
  assert.equal(h.hostCalls.filter((call) => call[0] === 'send').length, sendsBefore);

  const stopped = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/stop', isPrivate: true, chatType: 'private',
  });
  assert.match(stopped.text, /Stopped/);
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'stop'), ['stop', 'ses_2']);

  const stopsBefore = h.hostCalls.filter((call) => call[0] === 'stop').length;
  const stopOther = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/stop ses_1', isPrivate: true, chatType: 'private',
  });
  assert.match(stopOther.text, /only to the Telegram lead/);
  assert.equal(h.hostCalls.filter((call) => call[0] === 'stop').length, stopsBefore);
});

test('a lead blocks /new and points the task at the lead', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.store.setLeadSession({ sessionId: 'ses_2', title: 'Build release' });
  const result = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/new fix the failing tests', isPrivate: true, chatType: 'private',
  });
  assert.match(result.text, /Telegram lead/);
  assert.match(result.text, /Build release/);
  assert.match(result.text, /\/send/);
  assert.equal(h.hostCalls.filter((call) => call[0] === 'start').length, 0);

  const noTask = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/new', isPrivate: true, chatType: 'private',
  });
  assert.match(noTask.text, /Telegram lead/);
});

test('with a lead, replies go to the lead and other form cards are stale', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.store.setLeadSession({ sessionId: 'ses_2', title: 'Build release' });

  h.store.recordMessage(100, 501, { sessionId: 'ses_1', sessionTitle: 'Fix parser', kind: 'finish' });
  const reply = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: 'one more thing', isPrivate: true, chatType: 'private', replyToMessageId: 501,
  });
  assert.match(reply.text, /Sent to/);
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'send'), ['send', 'ses_2', 'one more thing']);

  const otherForm = createFormState(
    { sessionId: 'ses_1', sessionTitle: 'Fix parser', chatId: 100 },
    { id: 'frm_other', title: 'Old question', fields: [{ key: 'note', type: 'string', title: 'Note', required: true }] },
  );
  otherForm.messageId = 777;
  h.store.state.forms['ses_1:frm_other'] = otherForm;
  h.store.recordMessage(100, 777, {
    sessionId: 'ses_1', sessionTitle: 'Fix parser', kind: 'form', formKey: 'ses_1:frm_other',
  });
  const stale = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: 'some details', isPrivate: true, chatType: 'private', replyToMessageId: 777,
  });
  assert.match(stale.text, /not the Telegram lead/);
  assert.equal(otherForm.closed, true);
  assert.equal(h.hostCalls.filter((call) => call[0] === 'answerForm').length, 0);

  const leadForm = createFormState(
    { sessionId: 'ses_2', sessionTitle: 'Build release', chatId: 100 },
    { id: 'frm_lead', title: 'Lead question', fields: [{ key: 'note', type: 'string', title: 'Note', required: true }] },
  );
  leadForm.messageId = 778;
  h.store.state.forms['ses_2:frm_lead'] = leadForm;
  h.store.recordMessage(100, 778, {
    sessionId: 'ses_2', sessionTitle: 'Build release', kind: 'form', formKey: 'ses_2:frm_lead',
  });
  const answered = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: 'lead details', isPrivate: true, chatType: 'private', replyToMessageId: 778,
  });
  assert.match(answered.text, /Answer sent|Saved/);
  assert.deepEqual(h.hostCalls.find((call) => call[0] === 'answerForm'), [
    'answerForm', 'ses_2', 'frm_lead', { note: 'lead details' }, undefined,
  ]);
});

test('a paused lead rejects work commands until a new lead is chosen', async () => {
  const h = await makeHarness();
  h.store.setPrimaryChat(100);
  h.store.addPairedId(100);
  h.store.clearLeadSession({ paused: true });
  for (const text of ['/status', '/sessions', '/send hello', '/stop', '/new do it', '/digest']) {
    const result = await h.commands.handleMessage({
      chatId: 100, userId: 100, text, isPrivate: true, chatType: 'private',
    });
    assert.match(result.text, /No Telegram lead/);
    assert.match(result.text, /Choose a new lead/);
  }
  assert.equal(h.hostCalls.filter((call) => call[0] === 'send' || call[0] === 'stop' || call[0] === 'start').length, 0);
  const help = await h.commands.handleMessage({
    chatId: 100, userId: 100, text: '/help', isPrivate: true, chatType: 'private',
  });
  assert.match(help.text, /Telegram Desk/);
});
