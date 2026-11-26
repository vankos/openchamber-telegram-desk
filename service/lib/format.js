'use strict';

const MAX_MESSAGE = 4096;
const SAFE_MESSAGE = 3900;
const RICH_LIMIT = 32000;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const escapeAttr = (value) => escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const stripControls = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

const clip = (value, max, suffix = '…') => {
  const text = stripControls(value);
  if (!Number.isFinite(max) || max <= 0) return '';
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join('')}${suffix}`;
};

/**
 * Cut an HTML fragment without splitting an entity or a tag. The fragments we build
 * contain only our own tags; dynamic text is escaped before insertion.
 */
const clipHtmlSafe = (html, max = SAFE_MESSAGE) => {
  const text = String(html ?? '');
  if (text.length <= max) return text;
  let cut = Math.max(0, max - 1);
  const lastAmp = text.lastIndexOf('&', cut - 1);
  if (lastAmp !== -1) {
    const semicolon = text.indexOf(';', lastAmp);
    if (semicolon === -1 || semicolon >= cut) cut = lastAmp;
  }
  const lastLt = text.lastIndexOf('<', cut - 1);
  if (lastLt !== -1) {
    const gt = text.indexOf('>', lastLt);
    if (gt === -1 || gt >= cut) cut = lastLt;
  }
  return `${text.slice(0, Math.max(0, cut))}…`;
};

/**
 * Split raw text into escaped HTML chunks, each within max characters after escaping.
 * Line breaks are preferred; a single longer line is cut between code points. Escaping
 * happens per chunk, so an entity or a tag is never torn in the middle.
 */
const splitEscapedText = (value, max) => {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
  if (!text || !Number.isFinite(max) || max <= 0) return [];

  const units = [];
  for (const line of text.split('\n')) {
    if (escapeHtml(line).length <= max) {
      units.push(line);
      continue;
    }
    const points = Array.from(line);
    let at = 0;
    while (at < points.length) {
      let low = 1;
      let high = points.length - at;
      let best = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (escapeHtml(points.slice(at, at + middle).join('')).length <= max) {
          best = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (best <= 0) best = 1;
      units.push(points.slice(at, at + best).join(''));
      at += best;
    }
  }

  const chunks = [];
  let current = '';
  let length = 0;
  for (const unit of units) {
    const escapedLength = escapeHtml(unit).length;
    const grown = current ? length + 1 + escapedLength : escapedLength;
    if (current && grown > max) {
      chunks.push(escapeHtml(current));
      current = unit;
      length = escapedLength;
    } else {
      current = current ? `${current}\n${unit}` : unit;
      length = grown;
    }
  }
  if (current) chunks.push(escapeHtml(current));
  return chunks;
};

const htmlToPlain = (html) => String(html ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|blockquote|pre)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

const code = (value) => `<code>${escapeHtml(clip(value, 500))}</code>`;
const bold = (value) => `<b>${escapeHtml(clip(value, 300))}</b>`;
const italic = (value) => `<i>${escapeHtml(clip(value, 500))}</i>`;

const formatRelative = (timestamp, now = Date.now()) => {
  const at = Number(timestamp);
  if (!Number.isFinite(at) || at <= 0) return 'unknown time';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

const formatDuration = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

const statusIcon = (status) => ({
  busy: '🟡',
  waiting: '🔵',
  idle: '🟢',
  failed: '❌',
  unknown: '⚪',
}[status] ?? '⚪');

const statusWord = (status) => ({
  busy: 'busy',
  waiting: 'waiting',
  idle: 'idle',
  failed: 'failed',
}[status] ?? 'unknown');

const sessionTitle = (title, id) => clip(title?.trim() || id || 'Untitled session', 90);

const escapeMarkdown = (value) => String(value ?? '').replace(/([\\`*_\[\]<>#$~=|])/g, '\\$1');

const directoryName = (directory) => {
  if (!directory) return '';
  const parts = String(directory).split(/[\\/]+/).filter(Boolean);
  return clip(parts[parts.length - 1] ?? '', 40);
};

const formatPermission = ({ sessionTitle: title, action, resources, message }) => {
  const lines = [
    '🔐 <b>Permission request</b>',
    `<b>${escapeHtml(sessionTitle(title))}</b>`,
    `Action: ${code(action || 'unknown')}`,
  ];
  if (message) lines.push(`Message: ${escapeHtml(clip(message, 600))}`);
  const list = Array.isArray(resources) ? resources.filter(Boolean) : [];
  if (list.length) {
    lines.push('<b>Resources</b>');
    for (const resource of list.slice(0, 6)) lines.push(`• ${code(resource)}`);
    if (list.length > 6) lines.push(`• +${list.length - 6} more`);
  }
  lines.push('<i>Allow once or deny. “Always allow” stays in OpenChamber.</i>');
  const html = clipHtmlSafe(lines.join('\n'));
  return { text: html, plain: htmlToPlain(html) };
};

const formatTurnFinished = ({ sessionTitle: title, reply, replyTruncated }) => {
  const head = `✅ <b>${escapeHtml(sessionTitle(title))}</b> finished.`;
  const footer = '<i>Reply to this message to continue the session.</i>';
  const note = replyTruncated ? '<i>The reply was truncated by OpenChamber.</i>' : '';
  const tail = [note, footer].filter(Boolean).join('\n');
  const body = String(reply ?? '').trim();
  const build = () => {
    if (!body) return null;
    // Every part keeps room for the heading and the tail, so a part can be first or last.
    const room = SAFE_MESSAGE - head.length - tail.length - 6;
    const chunks = splitEscapedText(body, Math.max(1, room));
    if (!chunks.length) return null;
    return chunks.map((chunk, index) => {
      const pieces = [];
      if (index === 0) pieces.push(head);
      pieces.push(chunk);
      if (index === chunks.length - 1) pieces.push(tail);
      const text = pieces.join('\n\n');
      return { text, plain: htmlToPlain(text) };
    });
  };
  const parts = build() ?? [{ text: `${head}\n\n${tail}`, plain: htmlToPlain(`${head}\n\n${tail}`) }];
  // Telegram rich text carries the agent's Markdown as-is; an over-long or refused one falls back to parts.
  let rich = null;
  if (body && body.length + 1000 <= RICH_LIMIT) {
    const heading = `**✅ ${escapeMarkdown(sessionTitle(title).replace(/\s+/g, ' '))} finished.**`;
    const richNote = replyTruncated ? '_The reply was truncated by OpenChamber._' : '';
    const markdown = [heading, body, richNote, '_Reply to this message to continue the session._']
      .filter(Boolean)
      .join('\n\n');
    if (markdown.length <= RICH_LIMIT) rich = { markdown };
  }
  return rich ? { parts, rich } : { parts };
};

const formatTurnFailed = ({ sessionTitle: title, error }) => {
  const lines = [`❌ <b>${escapeHtml(sessionTitle(title))}</b> failed.`];
  const type = error?.type ? clip(error.type, 80) : 'error';
  const message = error?.message ? clip(error.message, 700) : '';
  lines.push(code(type));
  if (message) lines.push(`<blockquote>${escapeHtml(message)}</blockquote>`);
  lines.push('<i>Reply to this message to send a new instruction.</i>');
  const html = clipHtmlSafe(lines.join('\n'));
  return { text: html, plain: htmlToPlain(html) };
};

const formatQuestionUnavailable = ({ sessionTitle: title }) => {
  const html = clipHtmlSafe([
    `❓ <b>${escapeHtml(sessionTitle(title))}</b> asked a question.`,
    '<i>The question content was not delivered (the transcript permission is missing). Answer in OpenChamber, or reply to this message to send text to the session.</i>',
  ].join('\n'));
  return { text: html, plain: htmlToPlain(html) };
};

const formatPageQuestion = ({ sessionTitle: title, pageTitle }) => {
  const html = clipHtmlSafe([
    `📄 <b>${escapeHtml(sessionTitle(title))}</b> opened a page.`,
    `<b>${escapeHtml(clip(pageTitle || 'Agent page', 200))}</b>`,
    '<i>Pages cannot be answered from a service. Answer in OpenChamber, or reply to this message to send text to the session instead.</i>',
  ].join('\n'));
  return { text: html, plain: htmlToPlain(html) };
};

const formatStatus = ({ sessions = [], now = Date.now() }) => {
  if (!sessions.length) {
    return {
      text: '📊 <b>Sessions</b>\nNo sessions known yet. Open a session in OpenChamber first.',
      plain: 'Sessions\nNo sessions known yet. Open a session in OpenChamber first.',
    };
  }
  const counts = { busy: 0, waiting: 0, idle: 0, failed: 0, unknown: 0 };
  for (const session of sessions) counts[session.status] = (counts[session.status] ?? 0) + 1;
  const order = { waiting: 0, busy: 1, failed: 2, idle: 3, unknown: 4 };
  const ordered = [...sessions].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const lines = [
    `📊 <b>Sessions</b> · ${counts.busy} busy · ${counts.waiting} waiting · ${counts.idle} idle`
      + (counts.failed ? ` · ${counts.failed} failed` : ''),
    '',
  ];
  for (const session of ordered.slice(0, 18)) {
    const pending = session.pendingCount > 0 ? ` · ${session.pendingCount} open` : '';
    const project = directoryName(session.directory);
    lines.push(`${statusIcon(session.status)} ${escapeHtml(sessionTitle(session.title, session.id))} — ${code(session.id)}${pending}${project ? ` · ${escapeHtml(project)}` : ''}`);
  }
  if (ordered.length > 18) lines.push(`<i>+${ordered.length - 18} more. Use /sessions for the list.</i>`);
  lines.push('', '<i>/send &lt;session&gt; &lt;text&gt; · /stop &lt;session&gt;</i>');
  const html = clipHtmlSafe(lines.join('\n'));
  return { text: html, plain: htmlToPlain(html) };
};

const formatSessions = ({ sessions = [], now = Date.now() }) => {
  if (!sessions.length) {
    return {
      text: '🗂 <b>Sessions</b>\nNo sessions known yet. Open a session in OpenChamber first.',
      plain: 'Sessions\nNo sessions known yet. Open a session in OpenChamber first.',
    };
  }
  const lines = ['🗂 <b>Recent sessions</b>', ''];
  sessions.slice(0, 20).forEach((session, index) => {
    const project = directoryName(session.directory);
    const updated = formatRelative(session.updatedAt, now);
    lines.push(`${index + 1}. ${statusIcon(session.status)} ${escapeHtml(sessionTitle(session.title, session.id))}`);
    lines.push(`   ${code(session.id)}${project ? ` · ${escapeHtml(project)}` : ''} · ${updated}`);
  });
  if (sessions.length > 20) lines.push(`<i>+${sessions.length - 20} more.</i>`);
  lines.push('', '<i>Use /send &lt;number|id&gt; &lt;text&gt; or /stop &lt;number|id&gt;.</i>');
  const html = clipHtmlSafe(lines.join('\n'));
  return { text: html, plain: htmlToPlain(html) };
};

const formatDigest = ({
  sessions = [],
  pending = { questions: 0, permissions: 0 },
  recentEvents = [],
  since = 0,
  now = Date.now(),
}) => {
  const counts = { busy: 0, waiting: 0, idle: 0, failed: 0, unknown: 0 };
  for (const session of sessions) counts[session.status] = (counts[session.status] ?? 0) + 1;
  const sinceEvents = recentEvents.filter((event) => (event.at ?? 0) >= since);
  const finished = sinceEvents.filter((event) => event.type === 'turn-finished').length;
  const failed = sinceEvents.filter((event) => event.type === 'turn-failed').length;
  const lines = [
    '📬 <b>Telegram Desk digest</b>',
    `${counts.busy} busy · ${counts.waiting} waiting · ${counts.idle} idle` + (counts.failed ? ` · ${counts.failed} failed` : ''),
    `Pending answers: ${pending.questions} question${pending.questions === 1 ? '' : 's'}, ${pending.permissions} permission${pending.permissions === 1 ? '' : 's'}`,
  ];
  if (since) {
    lines.push(`Since the last digest (${formatDuration(Math.max(0, now - since))}): ${finished} finished, ${failed} failed`);
  } else {
    lines.push('No earlier digest in this chat.');
  }
  const waiting = sessions.filter((session) => session.status === 'waiting');
  if (waiting.length) {
    lines.push('', '<b>Waiting on you</b>');
    for (const session of waiting.slice(0, 6)) {
      lines.push(`🔵 ${escapeHtml(sessionTitle(session.title, session.id))} — ${code(session.id)}`);
    }
  }
  const recent = recentEvents
    .filter((event) => event.type === 'turn-finished' || event.type === 'turn-failed')
    .slice(-6)
    .reverse();
  if (recent.length) {
    lines.push('', '<b>Recent turns</b>');
    for (const event of recent) {
      const icon = event.type === 'turn-finished' ? '✅' : '❌';
      const delivery = event.delivery === 'failed' ? ' · not delivered' : '';
      lines.push(`${icon} ${escapeHtml(sessionTitle(event.sessionTitle, event.sessionId))} · ${formatRelative(event.at, now)}${delivery}`);
    }
  }
  const html = clipHtmlSafe(lines.join('\n'));
  return { text: html, plain: htmlToPlain(html) };
};

const formatHelp = () => {
  const html = [
    '🤖 <b>Telegram Desk</b>',
    '/status — waiting, busy and idle sessions',
    '/sessions — recent sessions and IDs',
    '/send &lt;session&gt; &lt;text&gt; — send a message',
    '/stop &lt;session&gt; — stop a running turn',
    '/digest — summary since the last digest',
    '/help — this list',
    '',
    '<i>Reply to any bot message to send the text to the session it belongs to.</i>',
  ].join('\n');
  return { text: clipHtmlSafe(html), plain: htmlToPlain(html) };
};

const formatStartHelp = ({ configured, botUsername }) => {
  const lines = ['🤖 <b>Telegram Desk</b>'];
  if (!configured) {
    lines.push('The bot has no token yet.');
    lines.push('Add it in <b>Settings → Integrations → Telegram Desk → Bot token</b>, then try again.');
  } else {
    lines.push('This chat is not allowed yet.');
    lines.push('Open the <b>Telegram Desk</b> panel in OpenChamber, create a pairing code, then send:');
    lines.push('<code>/start CODE</code>');
    lines.push('<i>The code expires in 10 minutes and works once.</i>');
  }
  if (botUsername) lines.push(`<i>Bot: @${escapeHtml(botUsername)}</i>`);
  const html = clipHtmlSafe(lines.join('\n'));
  return { text: html, plain: htmlToPlain(html) };
};

const formatPaired = ({ chatId, botUsername }) => {
  const html = [
    '✅ <b>Paired.</b>',
    'This chat can now receive questions, permission requests and turn notifications.',
    `Chat ID: ${code(chatId)}`,
    '',
    '/status · /sessions · /send · /stop · /digest · /help',
  ].join('\n');
  return { text: clipHtmlSafe(html), plain: htmlToPlain(html) };
};

const formatAlreadyPaired = ({ botUsername }) => {
  const html = [
    '✅ This chat is already paired.',
    botUsername ? `<i>Bot: @${escapeHtml(botUsername)}</i>` : '',
    '',
    '/status · /sessions · /send · /stop · /digest · /help',
  ].filter(Boolean).join('\n');
  return { text: clipHtmlSafe(html), plain: htmlToPlain(html) };
};

const formatPairInvalid = () => ({
  text: '❌ That pairing code is invalid or expired. Create a new code in the Telegram Desk panel.',
  plain: 'That pairing code is invalid or expired. Create a new code in the Telegram Desk panel.',
});

const formatSendSuccess = (title) => {
  const html = `✅ Sent to <b>${escapeHtml(sessionTitle(title))}</b>.`;
  return { text: html, plain: htmlToPlain(html) };
};

const formatStopResult = ({ title, stopped }) => {
  const html = stopped
    ? `⏹ Stopped <b>${escapeHtml(sessionTitle(title))}</b>.`
    : `Nothing was running in <b>${escapeHtml(sessionTitle(title))}</b>.`;
  return { text: html, plain: htmlToPlain(html) };
};

const formatReplySent = (title) => {
  const html = `✅ Sent to <b>${escapeHtml(sessionTitle(title))}</b>.`;
  return { text: html, plain: htmlToPlain(html) };
};

const formatNoTarget = () => ({
  text: 'Reply to a bot message that belongs to a session, or use /send &lt;session&gt; &lt;text&gt;.',
  plain: 'Reply to a bot message that belongs to a session, or use /send <session> <text>.',
});

const formatTestMessage = ({ now = Date.now() } = {}) => {
  const html = [
    '✅ <b>Telegram Desk test</b>',
    `The service reached Telegram at ${escapeHtml(new Date(now).toISOString())}.`,
    '<i>Questions, permission requests and turn notifications will arrive here.</i>',
  ].join('\n');
  return { text: clipHtmlSafe(html), plain: htmlToPlain(html) };
};

const formatInvalidCommand = () => ({
  text: 'Unknown command. Try /help.',
  plain: 'Unknown command. Try /help.',
});

const formatError = (message) => {
  const html = `⚠️ ${escapeHtml(clip(message, 800))}`;
  return { text: html, plain: htmlToPlain(html) };
};

module.exports = {
  MAX_MESSAGE,
  SAFE_MESSAGE,
  escapeHtml,
  escapeAttr,
  clip,
  clipHtmlSafe,
  htmlToPlain,
  code,
  bold,
  italic,
  formatRelative,
  formatDuration,
  statusIcon,
  statusWord,
  sessionTitle,
  directoryName,
  formatPermission,
  formatTurnFinished,
  formatTurnFailed,
  formatQuestionUnavailable,
  formatPageQuestion,
  formatStatus,
  formatSessions,
  formatDigest,
  formatHelp,
  formatStartHelp,
  formatPaired,
  formatAlreadyPaired,
  formatPairInvalid,
  formatSendSuccess,
  formatStopResult,
  formatReplySent,
  formatNoTarget,
  formatTestMessage,
  formatInvalidCommand,
  formatError,
};
