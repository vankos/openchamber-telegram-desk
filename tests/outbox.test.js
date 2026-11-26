'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../service/lib/store');
const { createOutbox } = require('../service/lib/outbox');
const { silentLogger } = require('../service/lib/log');

const make = async ({ send, isChatAllowed } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-outbox-'));
  let now = 1_000_000;
  const store = new Store({ dir, clock: () => now, logger: silentLogger });
  await store.load();
  const sent = [];
  const telegram = {
    async sendMessage(payload) {
      sent.push(payload);
      if (send) return send(payload);
      return { message_id: 42 };
    },
  };
  const outbox = createOutbox({
    store,
    telegram,
    logger: silentLogger,
    clock: () => now,
    isChatAllowed: isChatAllowed ?? (() => true),
  });
  return { store, outbox, sent, advance: (ms) => { now += ms; }, now: () => now };
};

test('delivers an item, stores the message route and removes it from the outbox', async () => {
  const h = await make();
  h.outbox.enqueue({ chatId: 100, text: '<b>Hi</b>', sessionId: 'ses_1', sessionTitle: 'Fix' });
  await h.outbox.drain();
  assert.equal(h.store.state.outbox.length, 0);
  assert.equal(h.sent.length, 1);
  assert.equal(h.store.messageRoute(100, 42).sessionId, 'ses_1');
});

test('keeps the item while the bot token is missing', async () => {
  const h = await make({
    send: async () => {
      const error = new Error('Bot token is not configured');
      error.code = 'NO_TOKEN';
      throw error;
    },
  });
  h.outbox.enqueue({ chatId: 100, text: 'Hi' });
  await h.outbox.drain();
  assert.equal(h.store.state.outbox.length, 1);
  assert.equal(h.store.state.outbox[0].attempts, 0);
  assert.ok(h.store.state.outbox[0].nextAt > h.now());
});

test('drops an item for a chat that is no longer allowed', async () => {
  const h = await make({ isChatAllowed: () => false });
  h.outbox.enqueue({ chatId: 100, text: 'Hi' });
  await h.outbox.drain();
  assert.equal(h.store.state.outbox.length, 0);
  assert.equal(h.sent.length, 0);
});

test('retries a transient Telegram failure with backoff', async () => {
  let count = 0;
  const h = await make({
    send: async () => {
      count += 1;
      if (count === 1) {
        const error = new Error('Too Many Requests');
        error.code = 429;
        error.transient = true;
        error.retryAfter = 5;
        throw error;
      }
      return { message_id: 43 };
    },
  });
  h.outbox.enqueue({ chatId: 100, text: 'Hi' });
  await h.outbox.drain();
  assert.equal(h.store.state.outbox.length, 1);
  assert.equal(h.store.state.outbox[0].attempts, 1);
  h.advance(5000);
  await h.outbox.drain();
  assert.equal(h.store.state.outbox.length, 0);
  assert.equal(h.sent.length, 2); // one failed attempt, one successful attempt
});
