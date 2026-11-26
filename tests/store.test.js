'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../service/lib/store');

const makeStore = async (clock = () => 1_000) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-store-'));
  const store = new Store({ dir, clock });
  await store.load();
  return { dir, store };
};

test('persists offset, message routes, refs, callbacks and pair state', async () => {
  const { dir, store } = await makeStore();
  store.setOffset(42);
  store.recordMessage(100, 7, { sessionId: 'ses_1', sessionTitle: 'Fix', kind: 'form', formKey: 'ses_1:frm_1' });
  store.addRef('ab12cd34ef', { kind: 'question', sessionId: 'ses_1', formId: 'frm_1', fieldKey: 'choice', value: 'yes' });
  store.markCallback('cb1', 'answered');
  store.markEventSeen('evt1');
  store.markUpdateSeen(99);
  store.addPairedId(100);
  await store.flush();

  const reloaded = new Store({ dir, clock: () => 2_000 });
  await reloaded.load();
  assert.equal(reloaded.state.offset, 42);
  assert.deepEqual(reloaded.messageRoute(100, 7), {
    sessionId: 'ses_1',
    sessionTitle: 'Fix',
    kind: 'form',
    formKey: 'ses_1:frm_1',
    at: 1_000,
  });
  assert.equal(reloaded.getRef('ab12cd34ef').value, 'yes');
  assert.deepEqual(reloaded.callbackOutcome('cb1'), { at: 1_000, outcome: 'answered' });
  assert.equal(reloaded.hasSeenEvent('evt1'), true);
  assert.equal(reloaded.hasSeenUpdate(99), true);
  assert.deepEqual(reloaded.state.pairedIds, [100]);
  assert.equal(reloaded.state.primaryChatId, 100);
});

test('pair codes expire and are single use', async () => {
  let now = 1_000;
  const { store } = await makeStore(() => now);
  store.setPairCode('ABCD2345', 10_000);
  assert.equal(store.consumePairCode('ABCD2345'), true);
  assert.equal(store.consumePairCode('ABCD2345'), false);

  store.setPairCode('EFGH6789', 10_000);
  now = 20_000;
  assert.equal(store.consumePairCode('EFGH6789'), false);
  assert.equal(store.activePairCode(), null);
});

test('pair attempts are limited per window', async () => {
  let now = 1_000;
  const { store } = await makeStore(() => now);
  assert.equal(store.pairAttempt(5, 2, 10_000), true);
  assert.equal(store.pairAttempt(5, 2, 10_000), true);
  assert.equal(store.pairAttempt(5, 2, 10_000), false);
  now += 11_000;
  assert.equal(store.pairAttempt(5, 2, 10_000), true);
});

test('outbox persists, updates and removes entries', async () => {
  const { dir, store } = await makeStore();
  const item = store.addOutbox({ chatId: 1, text: '<b>Hi</b>', keyboard: [[{ text: 'A', callback_data: 'td1:q:ab12cd34ef' }]] });
  assert.equal(store.dueOutbox(1_000).length, 1);
  store.updateOutbox(item.id, { attempts: 2, nextAt: 5_000 });
  assert.equal(store.dueOutbox(2_000).length, 0);
  await store.flush();
  const reloaded = new Store({ dir, clock: () => 3_000 });
  await reloaded.load();
  assert.equal(reloaded.state.outbox[0].text, '<b>Hi</b>');
  reloaded.removeOutbox(item.id);
  assert.equal(reloaded.state.outbox.length, 0);
});

test('recent events are bounded and can be updated by id', async () => {
  const { store } = await makeStore();
  for (let index = 0; index < 50; index += 1) {
    store.recordRecent({ id: `evt_${index}`, type: 'turn-finished', sessionId: 'ses_1', at: index });
  }
  assert.equal(store.state.recentEvents.length, 40);
  store.updateRecent('evt_49', { delivery: 'sent' });
  assert.equal(store.state.recentEvents.at(-1).delivery, 'sent');
});

test('prune removes old callbacks, refs, forms and expired pair codes', async () => {
  let now = 10_000_000_000;
  const { store } = await makeStore(() => now);
  store.state.processedCallbacks.old = { at: 0, outcome: 'answered' };
  store.state.refs.oldref1234 = { kind: 'question', at: 0 };
  store.state.forms.old = { updatedAt: 0, closed: false, sessionId: 'ses_1' };
  store.state.pairCode = { code: 'ABCD2345', createdAt: 0, expiresAt: 100 };

  store.prune();
  assert.equal(store.callbackOutcome('old'), null);
  assert.equal(store.getRef('oldref1234'), null);
  assert.equal(store.state.forms.old, undefined);
  assert.equal(store.state.pairCode, null);
});

test('last session list is persisted per chat', async () => {
  const { dir, store } = await makeStore();
  store.setLastSessionList(5, ['a', 'b', 'c']);
  assert.deepEqual(store.lastSessionList(5), ['a', 'b', 'c']);
  await store.flush();
  const reloaded = new Store({ dir });
  await reloaded.load();
  assert.deepEqual(reloaded.lastSessionList(5), ['a', 'b', 'c']);
});
