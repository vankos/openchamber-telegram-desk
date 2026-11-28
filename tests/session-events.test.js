'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../service/lib/store');
const { createOutbox } = require('../service/lib/outbox');
const { createSessionEvents, validateSessionEvent } = require('../service/lib/session-events');
const { createAnswerEngine } = require('../service/lib/answers');
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

const makeHarness = async ({ notifySetting = 'active', rich = false } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-events-'));
  let now = 1_000_000;
  const store = new Store({ dir, clock: () => now, logger: silentLogger });
  await store.load();
  store.setPrimaryChat(100);
  store.addPairedId(100);
  const sent = [];
  const richSent = [];
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
  if (rich) {
    telegram.sendRichMessage = async (payload) => {
      richSent.push(payload);
      return { message_id: 800 + richSent.length };
    };
  }
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
  const answers = createAnswerEngine({ store, host, telegram, logger: silentLogger, clock: () => now });
  return {
    dir,
    store,
    sent,
    richSent,
    edits,
    hostCalls,
    outbox,
    events,
    answers,
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

test('turn-finished sends a rich message when Telegram supports it', async () => {
  const h = await makeHarness({ notifySetting: 'all', rich: true });
  const request = baseEvent('turn-finished');
  request.content = {
    type: 'turn-finished',
    sessionTitle: 'Fix *parser*',
    reply: '**Done.**\n\n```js\nconst x = 1;\n```',
    replyTruncated: false,
  };
  await h.events.handle(request);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 0);
  assert.equal(h.richSent.length, 1);
  assert.match(h.richSent[0].rich.markdown, /\*\*Done\.\*\*/);
  assert.match(h.richSent[0].rich.markdown, /Fix \\\*parser\\\*/);
  assert.equal(h.store.messageRoute(100, 801).sessionId, 'ses_1');
  assert.equal(h.store.state.outbox.length, 0);
});

test('turn-finished splits a reply too large for one rich message', async () => {
  const h = await makeHarness({ notifySetting: 'all', rich: true });
  const request = baseEvent('turn-finished');
  request.content = {
    type: 'turn-finished',
    sessionTitle: 'Huge',
    reply: 'z'.repeat(40000),
    replyTruncated: true,
  };
  await h.events.handle(request);
  await settle();
  await h.outbox.drain();
  assert.equal(h.richSent.length, 0);
  assert.ok(h.sent.length > 1);
  assert.ok(h.sent.every((message) => message.text.length <= 4096));
  assert.match(h.sent[0].text, /finished/);
  assert.match(h.sent.at(-1).text, /truncated by OpenChamber/);
  for (let index = 0; index < h.sent.length; index += 1) {
    assert.equal(h.store.messageRoute(100, 501 + index).sessionId, 'ses_1');
  }
  assert.equal(h.store.state.stats.sent, 1);
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

test('session-deleted drops the session and closes its cards without touching routes', async () => {
  const h = await makeHarness({ notifySetting: 'all' });
  const question = baseEvent('question-asked', { question: { kind: 'form', id: 'frm_1' } });
  question.content = {
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
        options: [{ value: 'main', label: 'main' }],
      }],
    },
  };
  await h.events.handle(question);
  const permission = baseEvent('permission-asked', { permission: { requestId: 'perm_1' } });
  permission.content = {
    type: 'permission-asked',
    sessionTitle: 'Fix parser',
    action: 'bash',
    resources: ['git push'],
    message: 'Push?',
  };
  await h.events.handle(permission);
  const other = baseEvent('question-asked', {
    session: { id: 'ses_2', parentId: null },
    question: { kind: 'form', id: 'frm_2' },
  });
  other.content = {
    type: 'question-asked',
    sessionTitle: 'Other session',
    ask: {
      kind: 'form',
      id: 'frm_2',
      title: 'Keep me',
      fields: [{ key: 'note', type: 'string', title: 'Note', required: true }],
    },
  };
  await h.events.handle(other);
  h.store.setLastSessionList(100, ['ses_1', 'ses_2']);
  await settle();
  await h.outbox.drain();

  const form = h.store.state.forms['ses_1:frm_1'];
  const permissionEntry = h.store.state.permissions.perm_1;
  assert.ok(form);
  assert.ok(permissionEntry);
  assert.equal(h.store.messageRoute(100, form.messageId).sessionId, 'ses_1');
  assert.equal(h.store.messageRoute(100, permissionEntry.messageId).sessionId, 'ses_1');
  assert.ok(h.store.state.sessionRegistry.ses_1);
  assert.equal(h.store.isWatched('ses_1'), true);

  const result = await h.events.handle(baseEvent('session-deleted'));
  assert.equal(result.ok, true);

  assert.equal(h.store.state.sessionRegistry.ses_1, undefined);
  assert.equal(h.store.isWatched('ses_1'), false);
  assert.ok(h.store.state.sessionRegistry.ses_2);
  assert.equal(h.store.state.forms['ses_1:frm_1'].closed, true);
  assert.equal(h.store.state.forms['ses_2:frm_2'].closed, false);
  assert.equal(h.store.state.permissions.perm_1.closed, true);
  assert.equal(h.store.messageRoute(100, form.messageId).sessionId, 'ses_1');
  assert.equal(h.store.messageRoute(100, permissionEntry.messageId).sessionId, 'ses_1');
  assert.deepEqual(h.store.lastSessionList(100), [null, 'ses_2']);
  assert.equal(h.store.state.outbox.filter((item) => item.sessionId === 'ses_1').length, 0);
  assert.ok(h.edits.some((edit) => edit.messageId === form.messageId && /deleted in OpenChamber/.test(edit.text)));
  assert.ok(h.edits.some((edit) => edit.messageId === permissionEntry.messageId && /deleted in OpenChamber/.test(edit.text)));

  // Old buttons stay recognisable but close as stale; no answer reaches the host.
  const formRef = Object.entries(h.store.state.refs)
    .find(([, payload]) => payload.kind === 'question' && payload.sessionId === 'ses_1');
  assert.ok(formRef);
  const press = await h.answers.chooseOption(formRef[1]);
  assert.equal(press.ok, false);
  assert.equal(press.stale, true);
  const permissionPress = await h.answers.answerPermission(permissionEntry, 'allow');
  assert.equal(permissionPress.ok, false);
  assert.equal(permissionPress.stale, true);
  assert.equal(h.hostCalls.filter((call) => String(call[0]).startsWith('answer')).length, 0);

  const counts = h.events.pendingCounts();
  assert.equal(counts.bySession.get('ses_1'), undefined);
  assert.equal(counts.bySession.get('ses_2'), 1);
});

test('session-deleted for an unknown session is harmless', async () => {
  const h = await makeHarness({ notifySetting: 'all' });
  h.store.touchSession('ses_keep', { title: 'Keep' });
  const result = await h.events.handle(baseEvent('session-deleted'));
  assert.equal(result.ok, true);
  assert.equal(h.store.state.sessionRegistry.ses_1, undefined);
  assert.equal(h.store.state.sessionRegistry.ses_keep.title, 'Keep');
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
  const onlyLead = h.events.pendingCounts('ses_1');
  assert.equal(onlyLead.questions, 1);
  assert.equal(onlyLead.permissions, 0);
  assert.deepEqual([...onlyLead.bySession.keys()], ['ses_1']);
});

test('with a lead, events from every other session are ignored and create nothing', async () => {
  const h = await makeHarness({ notifySetting: 'all' });
  h.store.setLeadSession({ sessionId: 'ses_lead', title: 'Lead session' });

  const turn = baseEvent('turn-finished', { session: { id: 'ses_other', parentId: null } });
  turn.content = { type: 'turn-finished', sessionTitle: 'Other', reply: 'done', replyTruncated: false };
  await h.events.handle(turn);

  const question = baseEvent('question-asked', {
    session: { id: 'ses_other', parentId: null },
    question: { kind: 'form', id: 'frm_other' },
  });
  question.content = {
    type: 'question-asked',
    sessionTitle: 'Other',
    ask: {
      kind: 'form',
      id: 'frm_other',
      title: 'Other question',
      fields: [{ key: 'x', type: 'string', title: 'X', required: true }],
    },
  };
  await h.events.handle(question);

  const permission = baseEvent('permission-asked', {
    session: { id: 'ses_other', parentId: null },
    permission: { requestId: 'perm_other' },
  });
  permission.content = {
    type: 'permission-asked',
    sessionTitle: 'Other',
    action: 'bash',
    resources: ['rm -rf /tmp/x'],
  };
  await h.events.handle(permission);

  const started = baseEvent('turn-started', { session: { id: 'ses_other', parentId: null } });
  await h.events.handle(started);

  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.state.sessionRegistry.ses_other, undefined);
  assert.equal(Object.keys(h.store.state.forms).length, 0);
  assert.equal(Object.keys(h.store.state.permissions).length, 0);
  assert.equal(Object.keys(h.store.state.refs).length, 0);
  assert.equal(h.store.state.outbox.length, 0);
  assert.equal(h.store.state.stats.ignored, 4);
  assert.equal(h.store.state.recentEvents.at(-1).delivery, 'ignored');
  assert.match(h.store.state.recentEvents.at(-1).detail, /not the Telegram lead/);

  const leadTurn = baseEvent('turn-finished', { session: { id: 'ses_lead', parentId: null } });
  leadTurn.content = { type: 'turn-finished', sessionTitle: 'Lead session', reply: 'lead done', replyTruncated: false };
  await h.events.handle(leadTurn);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Lead session/);
  assert.equal(h.store.state.sessionRegistry.ses_lead.status, 'idle');
  assert.equal(h.store.state.stats.ignored, 4);
});

test('deleting a non-lead session cleans it up without touching the lead or sending', async () => {
  const h = await makeHarness({ notifySetting: 'all' });
  h.store.setLeadSession({ sessionId: 'ses_lead', title: 'Lead session' });
  h.store.touchSession('ses_lead', { title: 'Lead session', status: 'idle' });
  h.store.touchSession('ses_2', { title: 'Other session', status: 'busy', directory: '/repo/other' });
  h.store.watchSession('ses_2');
  h.store.state.forms['ses_2:frm_2'] = {
    sessionId: 'ses_2',
    formId: 'frm_2',
    title: 'Other question',
    sessionTitle: 'Other session',
    chatId: 100,
    messageId: 601,
    fields: [],
    answers: {},
    salt: 'salt2',
    closed: false,
    updatedAt: 1,
  };
  h.store.state.permissions.perm_2 = {
    ref: 'ref_perm_2',
    sessionId: 'ses_2',
    requestId: 'perm_2',
    chatId: 100,
    messageId: 602,
    closed: false,
    at: 1,
  };
  h.store.addOutbox({ id: 'ob_2', chatId: 100, text: 'queued for the other session', sessionId: 'ses_2' });
  h.store.setLastSessionList(100, ['ses_2', 'ses_lead']);

  const result = await h.events.handle(baseEvent('session-deleted', {
    session: { id: 'ses_2', parentId: null },
  }));
  assert.equal(result.ok, true);
  assert.equal(h.store.state.sessionRegistry.ses_2, undefined);
  assert.equal(h.store.isWatched('ses_2'), false);
  assert.equal(h.store.state.forms['ses_2:frm_2'].closed, true);
  assert.equal(h.store.state.permissions.perm_2.closed, true);
  assert.equal(h.store.state.outbox.filter((item) => item.sessionId === 'ses_2').length, 0);
  assert.deepEqual(h.store.lastSessionList(100), [null, 'ses_lead']);
  assert.ok(h.edits.some((edit) => edit.messageId === 601 && /deleted in OpenChamber/.test(edit.text)));
  assert.ok(h.edits.some((edit) => edit.messageId === 602 && /deleted in OpenChamber/.test(edit.text)));
  assert.equal(h.store.state.stats.ignored, 1);
  assert.deepEqual(h.store.leadSession(), {
    sessionId: 'ses_lead',
    title: 'Lead session',
    setAt: h.store.state.leadSetAt,
    paused: false,
  });
  assert.equal(h.sent.length, 0);
  await h.outbox.drain();
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.state.outbox.length, 0);
});

test('a paused binding still cleans a deleted session without sending', async () => {
  const h = await makeHarness({ notifySetting: 'all' });
  h.store.clearLeadSession({ paused: true });
  h.store.touchSession('ses_gone', { title: 'Deleted session', status: 'busy', directory: '/repo/gone' });
  h.store.watchSession('ses_gone');
  h.store.addOutbox({ id: 'ob_gone', chatId: 100, text: 'queued for a deleted session', sessionId: 'ses_gone' });

  const result = await h.events.handle(baseEvent('session-deleted', {
    session: { id: 'ses_gone', parentId: null },
  }));
  assert.equal(result.ok, true);
  assert.equal(h.store.state.sessionRegistry.ses_gone, undefined);
  assert.equal(h.store.isWatched('ses_gone'), false);
  assert.equal(h.store.state.outbox.filter((item) => item.sessionId === 'ses_gone').length, 0);
  assert.equal(h.store.state.stats.ignored, 1);
  assert.deepEqual(h.store.leadSession(), { sessionId: null, title: null, setAt: null, paused: true });
  await h.outbox.drain();
  assert.equal(h.sent.length, 0);
});

test('deleting the lead clears the binding, pauses delivery and asks for a new lead', async () => {
  const h = await makeHarness({ notifySetting: 'all' });
  h.store.setLeadSession({ sessionId: 'ses_1', title: 'Fix parser' });
  h.store.touchSession('ses_1', { title: 'Fix parser', status: 'busy' });
  h.store.watchSession('ses_1');

  const result = await h.events.handle(baseEvent('session-deleted'));
  assert.equal(result.ok, true);
  assert.equal(h.store.state.sessionRegistry.ses_1, undefined);
  assert.equal(h.store.isWatched('ses_1'), false);
  assert.equal(h.store.state.leadSessionId, null);
  assert.equal(h.store.state.leadPaused, true);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].chatId, 100);
  assert.match(h.sent[0].text, /Telegram lead removed/);
  assert.match(h.sent[0].text, /deleted in OpenChamber/);
  assert.match(h.sent[0].text, /Choose a new lead/);

  // While paused, even a normal session event is ignored instead of leaking.
  const other = baseEvent('turn-finished', { session: { id: 'ses_2', parentId: null } });
  other.content = { type: 'turn-finished', sessionTitle: 'Other', reply: 'done', replyTruncated: false };
  await h.events.handle(other);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 1);
  assert.equal(h.store.state.stats.ignored, 1);
  assert.match(h.store.state.recentEvents.at(-1).detail, /paused/);
  h.store.state.forms['ses_2:frm_keep'] = { sessionId: 'ses_2', closed: false, updatedAt: 1 };
  assert.equal(h.events.pendingCounts('').questions, 0);
  assert.equal(h.events.pendingCounts().questions, 1);

  // Choosing a new lead lifts the pause.
  h.store.setLeadSession({ sessionId: 'ses_2', title: 'Other' });
  assert.equal(h.store.leadSession().paused, false);
});

test('archiving the lead clears the binding and pauses delivery', async () => {
  const h = await makeHarness({ notifySetting: 'all' });
  h.store.setLeadSession({ sessionId: 'ses_1', title: 'Fix parser' });
  h.store.touchSession('ses_1', { title: 'Fix parser', status: 'busy' });

  const result = await h.events.handle(baseEvent('session-archived'));
  assert.equal(result.ok, true);
  assert.equal(h.store.state.sessionRegistry.ses_1, undefined);
  assert.equal(h.store.state.leadSessionId, null);
  assert.equal(h.store.state.leadPaused, true);
  await settle();
  await h.outbox.drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Telegram lead removed/);
  assert.match(h.sent[0].text, /archived in OpenChamber/);
  assert.match(h.sent[0].text, /Choose a new lead/);
});
