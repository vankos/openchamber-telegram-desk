'use strict';

const { redactString, safeError } = require('./log');

class HostError extends Error {
  constructor(message, code = 'HOST_UNAVAILABLE', status = 0) {
    super(redactString(message));
    this.name = 'HostError';
    this.code = code;
    this.status = status;
  }
}

const createHostClient = ({
  callbackUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  clock = Date.now,
} = {}) => {
  const base = String(callbackUrl ?? '').replace(/\/+$/, '');
  const available = Boolean(base && token);

  const call = async (method, input = {}) => {
    if (!available) throw new HostError('OpenChamber callback is not available', 'HOST_UNAVAILABLE', 0);
    let response;
    try {
      response = await fetchImpl(`${base}/service/call`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new HostError('OpenChamber did not answer', 'HOST_UNAVAILABLE', 0);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.ok && body && body.result !== undefined) return body.result;
    const message = body?.error?.message ?? `OpenChamber answered HTTP ${response.status}`;
    const code = body?.error?.code ?? (response.status === 404 ? 'NOT_FOUND' : 'HOST_UNAVAILABLE');
    throw new HostError(message, code, response.status);
  };

  return {
    available,
    call,
    async readSettings() {
      const result = await call('settings.read', {});
      return result?.settings ?? {};
    },
    async needsConfiguration(message) {
      return call('status.set', { needsConfiguration: message });
    },
    async emit(topic, data) {
      return call('panels.emit', { topic, data: data ?? null });
    },
    sessions: {
      send: (sessionId, prompt) => call('sessions.send', { sessionId, prompt }),
      retry: (sessionId) => call('sessions.retry', { sessionId }),
      status: (sessionId) => call('sessions.status', { sessionId }),
      lastReply: (sessionId) => call('sessions.lastReply', { sessionId }),
      stop: (sessionId) => call('sessions.stop', { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call('sessions.answerPermission', {
        sessionId,
        requestId,
        decision: answer.decision,
        ...(answer.message === undefined ? {} : { message: answer.message }),
      }),
      answerForm: (sessionId, formId, values, message) => call('sessions.answerForm', {
        sessionId,
        formId,
        values,
        ...(message === undefined ? {} : { message }),
      }),
    },
    lastError: null,
    describeError: safeError,
    clock,
  };
};

module.exports = {
  HostError,
  createHostClient,
};
