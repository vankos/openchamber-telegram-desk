'use strict';

const TOKEN_PATTERN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const redactString = (value) => String(value)
  .replace(TOKEN_PATTERN, '[redacted-token]')
  .replace(BEARER_PATTERN, 'Bearer [redacted]');

const redactValue = (value, depth = 0) => {
  if (depth > 3) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      code: typeof value.code === 'string' ? value.code : undefined,
      status: typeof value.status === 'number' ? value.status : undefined,
      message: redactString(value.message),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) out[key] = redactValue(item, depth + 1);
    return out;
  }
  return value;
};

const safeError = (error) => {
  if (!error || typeof error !== 'object') return { message: redactString(String(error)) };
  return redactValue(error);
};

const createLogger = ({ stream = process.stderr, clock = Date.now, level = 'info' } = {}) => {
  const ranks = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = ranks[level] ?? ranks.info;
  const write = (name, message, meta) => {
    if ((ranks[name] ?? ranks.info) < threshold) return;
    let line = `${new Date(clock()).toISOString()} [telegram-desk] ${name} ${redactString(message)}`;
    if (meta !== undefined) {
      try {
        line += ` ${JSON.stringify(redactValue(meta))}`;
      } catch {
        line += ' [unserializable]';
      }
    }
    stream.write(`${line}\n`);
  };
  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
};

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

module.exports = {
  redactString,
  redactValue,
  safeError,
  createLogger,
  silentLogger,
};
