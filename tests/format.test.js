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

test('formatTurnFinished sends the whole reply in parts under the limit', () => {
  const reply = Array.from({ length: 600 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n');
  const card = formatTurnFinished({ sessionTitle: 'Fix', reply, replyTruncated: false });
  assert.ok(card.parts.length > 1);
  assert.match(card.parts[0].text, /finished/);
  assert.match(card.parts[0].text, /line 0 /);
  assert.match(card.parts.at(-1).text, /line 599 /);
  assert.match(card.parts.at(-1).text, /continue the session/);
  for (const part of card.parts) {
    assert.ok(part.text.length <= 3900, `part too long: ${part.text.length}`);
    assert.ok(part.plain.length <= 3900);
  }
  const plain = card.parts.map((part) => part.plain).join('\n');
  assert.ok(plain.includes('line 0 '));
  assert.ok(plain.includes('line 599 '));
});

test('formatTurnFinished escapes each part and marks a truncated reply', () => {
  const reply = `${'a&<>\n'.repeat(2000)}END`;
  const card = formatTurnFinished({ sessionTitle: 'Fix', reply, replyTruncated: true });
  assert.ok(card.parts.length > 1);
  for (const part of card.parts) {
    const withoutTags = part.text.replace(/<\/?(b|i)>/g, '');
    assert.ok(!/[<>]/.test(withoutTags), 'reply text must stay escaped');
    assert.ok(!/&[a-z]*$/.test(part.text), 'entity must stay intact');
    assert.ok(part.text.length <= 3900);
  }
  assert.match(card.parts.at(-1).text, /truncated by OpenChamber/);
  assert.match(card.parts.at(-1).text, /continue the session/);

  const short = formatTurnFinished({ sessionTitle: 'Fix', reply: 'done', replyTruncated: false });
  assert.equal(short.parts.length, 1);
  assert.match(short.parts[0].text, /done/);

  const empty = formatTurnFinished({ sessionTitle: 'Fix', reply: '', replyTruncated: false });
  assert.equal(empty.parts.length, 1);
  assert.match(empty.parts[0].text, /finished/);
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
