'use strict';

// OpenCode's list is capped and archived sessions drop out of it; the host knows a
// session directly. A missing lead is only confirmed when a short, complete list
// does not contain it and the host answers 404. An empty, capped or failed list, an
// unavailable OpenCode or host, or any other status cannot prove deletion, so the
// binding stays. Callers must re-check the binding before clearing it.
const LEAD_LIST_LIMIT = 100;

const isNotFound = (error) => error?.status === 404 || error?.code === 'NOT_FOUND';

const probeLeadPresence = async ({ sessionId, opencode, host } = {}) => {
  if (typeof sessionId !== 'string' || !sessionId) {
    return { outcome: 'unknown', reason: 'no session id' };
  }

  let listState = 'unknown';
  if (opencode?.available && typeof opencode.listSessions === 'function') {
    try {
      const sessions = await opencode.listSessions();
      if (Array.isArray(sessions)) {
        if (sessions.some((session) => session?.id === sessionId)) {
          return { outcome: 'present', source: 'opencode' };
        }
        // A list at its cap may have been truncated, and an empty list is what a
        // still-starting OpenCode returns; neither proves that the lead is gone.
        listState = sessions.length > 0 && sessions.length < LEAD_LIST_LIMIT ? 'absent' : 'incomplete';
      }
    } catch {
      listState = 'unknown';
    }
  }

  let hostState = 'unknown';
  if (host?.available && host.sessions && typeof host.sessions.status === 'function') {
    try {
      await host.sessions.status(sessionId);
      return { outcome: 'present', source: 'host' };
    } catch (error) {
      hostState = isNotFound(error) ? 'absent' : 'unknown';
    }
  }

  if (listState === 'absent' && hostState === 'absent') {
    return { outcome: 'missing', source: 'opencode+host' };
  }
  return { outcome: 'unknown', reason: `list ${listState}, host ${hostState}` };
};

module.exports = {
  LEAD_LIST_LIMIT,
  probeLeadPresence,
};
