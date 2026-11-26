'use strict';

const { redactString } = require('./log');

class OpenCodeError extends Error {
  constructor(message, code = 'OPENCODE_UNAVAILABLE', status = 0) {
    super(redactString(message));
    this.name = 'OpenCodeError';
    this.code = code;
    this.status = status;
  }
}

const firstNumber = (...values) => {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return 0;
};

const normalizeSession = (item) => {
  if (!item || typeof item !== 'object') return null;
  const id = item.id ?? item.sessionID ?? item.sessionId;
  if (typeof id !== 'string' || !id) return null;
  const time = item.time && typeof item.time === 'object' ? item.time : {};
  return {
    id,
    title: typeof item.title === 'string' ? item.title : (typeof item.name === 'string' ? item.name : null),
    parentId: item.parentID ?? item.parentId ?? null,
    directory: item.directory ?? item.path ?? null,
    updatedAt: firstNumber(time.updated, time.created, item.updatedAt, item.createdAt),
    archived: Boolean(time.archived ?? item.archivedAt),
  };
};

const extractSessionArray = (body) => {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const key of ['data', 'sessions', 'items', 'result', 'active']) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
};

const createOpenCodeClient = ({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) => {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const available = Boolean(base && token);

  const request = async (path) => {
    if (!available) throw new OpenCodeError('OpenCode access is not available', 'OPENCODE_UNAVAILABLE', 0);
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new OpenCodeError('OpenCode did not answer', 'OPENCODE_UNAVAILABLE', 0);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new OpenCodeError(body?.message ?? `OpenCode answered HTTP ${response.status}`, 'OPENCODE_REQUEST_FAILED', response.status);
    }
    return body;
  };

  return {
    available,
    async listSessions() {
      const body = await request('/api/session');
      const sessions = extractSessionArray(body)
        .map(normalizeSession)
        .filter(Boolean)
        .filter((session) => !session.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return sessions.slice(0, 100);
    },
    async listActiveSessionIds() {
      const body = await request('/api/session/active');
      const values = extractSessionArray(body);
      return new Set(values.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean));
    },
  };
};

module.exports = {
  OpenCodeError,
  createOpenCodeClient,
  normalizeSession,
  extractSessionArray,
};
