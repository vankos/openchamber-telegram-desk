'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtml,
  clip,
  clipHtmlSafe,
  htmlToPlain,
  formatPermission,
  formatTurnFinished,
  formatTurnFailed,
  formatStatus,
  formatSessions,
  formatDigest,
  formatStartHelp,
  formatHelp,
  formatTestMessage,
} = require('../service/lib/format');

test('escapeHtml escapes the three dangerous characters', () => {
  assert.equal(escapeHtml('<b>A & B</b>'), '&lt;b&gt;A &amp; B&lt;/b&gt;');
});

test('clip counts code points and adds an ellipsis', () => {
  assert.equal(clip('abcdef', 6), 'abcdef');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('a\nb', 10), 'a\nb');
});

test('clipHtmlSafe never cuts an entity or a tag', () => {
  const text = `<b>${'&amp;'.repeat(100)}</b>`;
  const clipped = clipHtmlSafe(text, 30);
  assert.ok(clipped.length <= 31);
  assert.ok(!/&[a-z]*$/.test(clipped.replace(/…$/, '')), 'entity must stay intact');
  assert.ok(!/<[^>]*$/.test(clipped.replace(/…$/, '')), 'tag must stay intact');
});

test('htmlToPlain strips tags and decodes entities', () => {
  assert.equal(htmlToPlain('<b>A &amp; B</b>\n<code>x</code>'), 'A & B\nx');
});

test('formatPermission escapes text and caps resources', () => {
  const card = formatPermission({
    sessionTitle: '<script>alert(1)</script>',
    action: 'bash',
    resources: Array.from({ length: 9 }, (_, index) => `/path/${index}`),
    message: '<b>run it</b>',
  });
  assert.match(card.text, /&lt;script&gt;/);
  assert.ok(!card.text.includes('<script>'));
  assert.match(card.text, /\+3 more/);
  assert.ok(card.text.length < 4096);
});

test('formatTurnFinished keeps a bounded excerpt and plain fallback', () => {
  const card = formatTurnFinished({ sessionTitle: 'Fix', reply: 'x'.repeat(5000), replyTruncated: false });
  assert.ok(card.text.length < 1200);
  assert.match(card.text, /finished/);
  assert.ok(card.plain.includes('Fix'));
});

test('formatTurnFailed includes the error type', () => {
  const card = formatTurnFailed({ sessionTitle: 'Fix', error: { type: 'api_error', message: 'rate limited' } });
  assert.match(card.text, /api_error/);
  assert.match(card.text, /rate limited/);
});

test('formatStatus groups sessions and escapes titles', () => {
  const card = formatStatus({
    sessions: [
      { id: 'ses_a', title: '<b>A</b>', status: 'waiting', pendingCount: 2, directory: '/repo/a' },
      { id: 'ses_b', title: 'B', status: 'busy', pendingCount: 0, directory: '/repo/b' },
      { id: 'ses_c', title: 'C', status: 'idle', pendingCount: 0, directory: null },
    ],
    now: 1000,
  });
  assert.match(card.text, /1 busy · 1 waiting · 1 idle/);
  assert.match(card.text, /&lt;b&gt;A&lt;\/b&gt;/);
  assert.ok(card.text.indexOf('A') < card.text.indexOf('B'));
});

test('formatSessions numbers sessions and stores readable IDs', () => {
  const card = formatSessions({
    sessions: [{ id: 'ses_1234567890', title: 'Title', status: 'idle', directory: '/repo/x', updatedAt: 0 }],
    now: 1000,
  });
  assert.match(card.text, /1\./);
  assert.match(card.text, /ses_1234567890/);
});

test('formatDigest reports counts and pending answers', () => {
  const card = formatDigest({
    sessions: [
      { id: 'ses_a', title: 'A', status: 'waiting' },
      { id: 'ses_b', title: 'B', status: 'busy' },
    ],
    pending: { questions: 1, permissions: 2 },
    recentEvents: [
      { type: 'turn-finished', sessionId: 'ses_a', sessionTitle: 'A', at: 900, delivery: 'sent' },
      { type: 'turn-failed', sessionId: 'ses_b', sessionTitle: 'B', at: 950, delivery: 'failed' },
    ],
    since: 0,
    now: 1000,
  });
  assert.match(card.text, /1 busy/);
  assert.match(card.text, /1 question/);
  assert.match(card.text, /2 permissions/);
  assert.match(card.text, /not delivered/);
});

test('formatStartHelp explains the vestigial API token field', () => {
  const card = formatStartHelp({ configured: false, botUsername: null });
  assert.match(card.plain, /Bot token/);
  assert.match(card.plain, /Integrations/);
});

test('all formatters stay under Telegram\'s message limit', () => {
  const cards = [
    formatHelp(),
    formatTestMessage({ now: 0 }),
    formatStatus({ sessions: Array.from({ length: 40 }, (_, i) => ({ id: `ses_${i}`, title: 'T'.repeat(200), status: 'idle', pendingCount: 0 })) }),
    formatSessions({ sessions: Array.from({ length: 40 }, (_, i) => ({ id: `ses_${i}`, title: 'T'.repeat(200), status: 'idle', updatedAt: 0 })) }),
  ];
  for (const card of cards) {
    assert.ok(card.text.length <= 4096, `message too long: ${card.text.length}`);
    assert.ok(card.plain.length <= 4096);
  }
});
