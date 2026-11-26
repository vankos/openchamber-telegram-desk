'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTelegramClient, TelegramError } = require('../service/lib/telegram');

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const makeClient = (handler) => {
  const calls = [];
  const client = createTelegramClient({
    token: TOKEN,
    apiBase: 'https://telegram.test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return handler(url, options, calls.length);
    },
  });
  return { client, calls };
};

test('getMe and sendMessage use the bot URL and JSON body', async () => {
  const { client, calls } = makeClient(async (url) => {
    if (url.includes('/getMe')) return jsonResponse({ ok: true, result: { id: 1, username: 'desk_bot' } });
    return jsonResponse({ ok: true, result: { message_id: 77, chat: { id: 5 } } });
  });
  assert.equal((await client.getMe()).username, 'desk_bot');
  const sent = await client.sendMessage({
    chatId: 5,
    text: '<b>Hello</b>',
    plain: 'Hello',
    keyboard: [[{ text: 'Yes', callback_data: 'td1:q:ab12cd34ef' }]],
    replyToMessageId: 10,
  });
  assert.equal(sent.message_id, 77);
  assert.match(calls[1].url, /\/bot123456:/);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.chat_id, 5);
  assert.equal(body.parse_mode, 'HTML');
  assert.deepEqual(body.reply_parameters, { message_id: 10, allow_sending_without_reply: true });
  assert.equal(body.reply_markup.inline_keyboard[0][0].text, 'Yes');
});

test('falls back to plain text when Telegram rejects HTML entities', async () => {
  const { client, calls } = makeClient(async (url, options, count) => {
    if (count === 1) return jsonResponse({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, 400);
    return jsonResponse({ ok: true, result: { message_id: 2 } });
  });
  const sent = await client.sendMessage({ chatId: 1, text: '<b>broken', plain: 'broken' });
  assert.equal(sent.message_id, 2);
  const fallback = JSON.parse(calls[1].options.body);
  assert.equal(fallback.text, 'broken');
  assert.equal(fallback.parse_mode, undefined);
});

test('429 remains transient and exposes retry_after', async () => {
  const { client } = makeClient(async () => jsonResponse({
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after 7',
    parameters: { retry_after: 7 },
  }, 429));
  await assert.rejects(
    () => client.sendMessage({ chatId: 1, text: 'x' }),
    (error) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.transient, true);
      assert.equal(error.retryAfter, 7);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
});

test('network errors are transient and never include the token', async () => {
  const { client } = makeClient(async () => {
    throw new Error(`connection to ${TOKEN} failed`);
  });
  await assert.rejects(
    () => client.getUpdates({ offset: 5 }),
    (error) => {
      assert.equal(error.transient, true);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
});

test('getUpdates sends offset, timeout and allowed updates', async () => {
  const { client, calls } = makeClient(async () => jsonResponse({ ok: true, result: [] }));
  const updates = await client.getUpdates({ offset: 12, timeout: 5 });
  assert.deepEqual(updates, []);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.offset, 12);
  assert.equal(body.timeout, 5);
  assert.deepEqual(body.allowed_updates, ['message', 'callback_query']);
});

test('answerCallbackQuery sends the query id and a short text', async () => {
  const { client, calls } = makeClient(async () => jsonResponse({ ok: true, result: true }));
  await client.answerCallbackQuery({ callbackQueryId: 'cb-1', text: 'Not allowed' });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.callback_query_id, 'cb-1');
  assert.equal(body.text, 'Not allowed');
});

test('editMessageText treats not-modified as a no-op', async () => {
  let count = 0;
  const { client } = makeClient(async () => {
    count += 1;
    if (count === 1) {
      return jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, 400);
    }
    return jsonResponse({ ok: true, result: true });
  });
  const result = await client.editMessageText({ chatId: 1, messageId: 2, text: 'x' });
  assert.equal(result, null);
});
