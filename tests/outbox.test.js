'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../service/lib/store');
const { createOutbox } = require('../service/lib/outbox');
const { silentLogger } = require('../service/lib/log');

const make = async ({ send, richSend, isChatAllowed } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-desk-outbox-'));
  let now = 1_000_000;
  const store = new Store({ dir, clock: () => now, logger: silentLogger });
  await store.load();
  const sent = [];
  const richSent = [];
  const telegram = {
    async sendMessage(payload) {
      sent.push(payload);
      if (send) return send(payload);
      return { message_id: 42 };
    },
  };
  if (richSend) {
    telegram.sendRichMessage = async (payload) => {
      richSent.push(payload);
      return richSend(payload);
    };
  }
  const outbox = createOutbox({
    store,
    telegram,
    logger: silentLogger,
    clock: () => now,
    isChatAllowed: isChatAllowed ?? (() => true),
  });
  return { store, outbox, sent, richSent, advance: (ms) => { now += ms; }, now: () => now };
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

test('delivers a rich message in one call and stores its route', async () => {
  const h = await make({ richSend: async () => ({ message_id: 77 }) });
  h.outbox.enqueue({
    chatId: 100,
    text: '<b>Hi</b>',
    rich: { markdown: '**Hi**' },
    parts: [{ text: '<b>Hi</b>', plain: 'Hi' }],
    sessionId: 'ses_1',
    sessionTitle: 'Fix',
    kind: 'finish',
  });
  await h.outbox.drain();
  assert.equal(h.richSent.length, 1);
  assert.equal(h.richSent[0].rich.markdown, '**Hi**');
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.messageRoute(100, 77).sessionId, 'ses_1');
  assert.equal(h.store.state.outbox.length, 0);
});

test('falls back to HTML parts when Telegram refuses a rich message', async () => {
  const h = await make({
    richSend: async () => {
      const error = new Error('Bad Request: unsupported rich message');
      error.code = 400;
      error.description = 'Bad Request: unsupported rich message';
      throw error;
    },
  });
  h.outbox.enqueue({
    chatId: 100,
    text: '<b>Hi</b>',
    rich: { markdown: '**Hi**' },
    parts: [{ text: '<b>Hi</b>', plain: 'Hi' }],
    sessionId: 'ses_1',
    kind: 'finish',
  });
  await h.outbox.drain();
  assert.equal(h.richSent.length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, '<b>Hi</b>');
  assert.equal(h.store.state.outbox.length, 0);
});

test('sends every part, resumes after a failed part and routes each message', async () => {
  let count = 0;
  const h = await make({
    send: async () => {
      count += 1;
      if (count === 2) {
        const error = new Error('Too Many Requests');
        error.code = 429;
        error.transient = true;
        error.retryAfter = 5;
        throw error;
      }
      return { message_id: 100 + count };
    },
  });
  h.outbox.enqueue({
    chatId: 100,
    text: 'a',
    parts: [{ text: 'a', plain: 'a' }, { text: 'b', plain: 'b' }, { text: 'c', plain: 'c' }],
    keyboard: [[{ text: 'Yes', callback_data: 'td1:q:ab12cd34ef' }]],
    replyToMessageId: 9,
    sessionId: 'ses_1',
    kind: 'event',
  });
  await h.outbox.drain();
  assert.equal(h.sent.length, 2);
  assert.equal(h.store.state.outbox[0].sentParts, 1);

  h.advance(5000);
  await h.outbox.drain();
  assert.equal(h.sent.length, 4);
  assert.equal(h.store.state.outbox.length, 0);
  assert.equal(h.sent[0].replyToMessageId, 9);
  assert.equal(h.sent[2].replyToMessageId, null);
  assert.equal(h.sent[3].keyboard[0][0].text, 'Yes');
  assert.equal(h.store.messageRoute(100, 101).sessionId, 'ses_1');
  assert.equal(h.store.messageRoute(100, 103).sessionId, 'ses_1');
  assert.equal(h.store.messageRoute(100, 104).sessionId, 'ses_1');
});
