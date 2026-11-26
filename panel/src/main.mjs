import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

const host = connectHost();
const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  service: 'starting',
  error: null,
  loading: false,
  busy: new Set(),
  testResult: '',
  pairResult: '',
  notifyResult: '',
  lastLoadedAt: 0,
};

const relative = (timestamp) => {
  if (!timestamp) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const duration = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

const setText = (id, text) => {
  const element = $(id);
  if (element) element.textContent = text;
};

const setPill = (text, tone) => {
  const element = $('service-pill');
  if (!element) return;
  element.textContent = text;
  element.className = `pill ${tone}`;
};

const show = (id, visible) => {
  const element = $(id);
  if (!element) return;
  element.classList.toggle('hidden', !visible);
};

const readBody = (response) => {
  let body = response?.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = { ok: false, error: body };
    }
  }
  return body ?? {};
};

const request = async (method, path, body) => {
  const response = await host.serviceRequest({ method, path, ...(body === undefined ? {} : { body }) });
  return { status: response?.status ?? 0, body: readBody(response) };
};

const serviceError = (error) => {
  if (!error) return 'Unknown error';
  if (error.code === 'NO_SERVICE') return 'The local service is not approved yet. Allow it in Settings → Extensions → Telegram Desk.';
  if (error.code === 'DISABLED') return 'The extension is paused in Settings → Extensions.';
  if (error.code === 'SERVICE_FAILED') return 'The local service failed to start. Check the OpenChamber logs.';
  if (error.code === 'REQUEST_FAILED') return 'The service did not answer. It may have restarted.';
  return error.message || String(error);
};

const setBusy = (key, value) => {
  if (value) state.busy.add(key);
  else state.busy.delete(key);
  if (key === 'test') $('test-button').disabled = value;
  if (key === 'pair') $('pair-button').disabled = value;
  if (key === 'notify') $('notify-mode').disabled = value;
};

const setResult = (id, text, isError = false) => {
  const element = $(id);
  if (!element) return;
  element.textContent = text || '';
  element.classList.toggle('hidden', !text);
  element.classList.toggle('error', Boolean(isError));
};

const renderSetup = (status) => {
  if (state.error) {
    show('setup-card', true);
    setText('setup-title', 'The service is not reachable');
    setText('setup-body', serviceError(state.error));
    return;
  }
  if (!status) {
    show('setup-card', false);
    return;
  }
  if (!status.configured) {
    show('setup-card', true);
    setText('setup-title', 'Add a bot token');
    setText('setup-body', 'Open Settings → Integrations → Telegram Desk. Paste the BotFather token into “Bot token used by the service”, then save by clicking outside the field. The API token field and Connect button are not used by this extension.');
    return;
  }
  if (!status.token.looksValid) {
    show('setup-card', true);
    setText('setup-title', 'The bot token does not look valid');
    setText('setup-body', 'Open Settings → Integrations → Telegram Desk → Bot token and paste the token from @BotFather again.');
    return;
  }
  if (!status.service.hostAvailable) {
    show('setup-card', true);
    setText('setup-title', 'OpenChamber callback is unavailable');
    setText('setup-body', 'The service was started without OPENCHAMBER_HOST_CALLBACK_URL. Restart OpenChamber from the desktop or web app.');
    return;
  }
  show('setup-card', false);
};

const renderFacts = (status) => {
  const service = status?.service ?? {};
  setText('fact-service', `${status?.version ?? '?'} · ${duration(service.uptimeMs ?? 0)} · ${service.settingsReady ? 'settings ok' : 'settings pending'}`);
  setText('fact-bot', status?.bot?.username ? `@${status.bot.username}` : (status?.configured ? 'checking…' : 'no token'));
  setText('fact-poll', status?.service?.lastPollAt ? relative(status.service.lastPollAt) : 'never');
  setText('fact-opencode', service.opencodeAvailable ? 'available' : 'event registry only');
  const pending = status?.pending ?? { questions: 0, permissions: 0 };
  setText('fact-pending', `${pending.questions} question${pending.questions === 1 ? '' : 's'} · ${pending.permissions} permission${pending.permissions === 1 ? '' : 's'}`);
  setText('fact-outbox', `${service.outbox ?? 0} queued`);
  const lastError = status?.service?.lastError;
  if (lastError) {
    show('last-error', true);
    setText('last-error', lastError.description || lastError.message || 'Service error');
  } else if (state.error) {
    show('last-error', true);
    setText('last-error', serviceError(state.error));
  } else {
    show('last-error', false);
  }
};

const renderPairing = (status) => {
  const pairing = status?.pairing;
  show('pair-code-box', Boolean(pairing));
  if (pairing) {
    setText('pair-code', pairing.code);
    setText('pair-code-inline', pairing.code);
    updateExpiry();
  }
  const allowlist = status?.allowlist ?? { settings: [], paired: [], effective: [], primaryChatId: null };
  const list = $('allowlist');
  list.replaceChildren();
  const effective = Array.isArray(allowlist.effective) ? allowlist.effective : [];
  setText('allowlist-count', `${effective.length} chat${effective.length === 1 ? '' : 's'}`);
  if (!effective.length) {
    const empty = document.createElement('li');
    empty.className = 'muted small';
    empty.textContent = 'No allowed chats yet. Create a pairing code.';
    list.append(empty);
  }
  for (const rawId of effective) {
    const id = Number(rawId);
    const paired = Array.isArray(allowlist.paired) && allowlist.paired.includes(id);
    const item = document.createElement('li');
    item.className = 'chip';
    const label = document.createElement('span');
    label.textContent = String(id);
    item.append(label);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = paired ? 'paired' : 'settings';
    item.append(tag);
    if (allowlist.primaryChatId === id) {
      const primaryTag = document.createElement('span');
      primaryTag.className = 'tag';
      primaryTag.textContent = 'events';
      item.append(primaryTag);
    }
    if (paired) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = `Remove ${id} from paired chats`;
      remove.addEventListener('click', () => void removeChat(id));
      item.append(remove);
    }
    list.append(item);
  }
  setText('primary-chat', allowlist.primaryChatId
    ? `Questions, permissions and turn notices go to chat ${allowlist.primaryChatId}. Commands work from every allowed chat.`
    : 'No event chat yet. Pair a private chat to receive questions and permissions.');
};

const renderNotify = (status) => {
  const preferences = status?.preferences;
  if (!preferences) return;
  const select = $('notify-mode');
  if (select.value !== preferences.notifyMode) select.value = preferences.notifyMode;
  const source = preferences.override ? 'set here' : `from settings: ${preferences.setting}`;
  setText('notify-hint', `Active means a session asked a question, requested permission, or was messaged from Telegram in the last 24 hours. The default is all. Current value: ${source}.`);
};

const eventIcon = (type) => ({
  'turn-finished': '✅',
  'turn-failed': '❌',
  'question-asked': '❓',
  'permission-asked': '🔐',
  'turn-started': '🟡',
  'session-created': '🆕',
}[type] ?? '•');

const renderEvents = (status) => {
  const events = Array.isArray(status?.events) ? status.events : [];
  const list = $('events');
  list.replaceChildren();
  setText('event-count', events.length ? `${events.length} shown` : '');
  if (!events.length) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No events yet. Questions and permissions will appear here.';
    list.append(empty);
    return;
  }
  for (const event of events) {
    const item = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'event-icon';
    icon.textContent = eventIcon(event.type);
    item.append(icon);
    const main = document.createElement('div');
    main.className = 'event-main';
    const title = document.createElement('div');
    title.className = 'event-title';
    title.textContent = event.sessionTitle || event.sessionId || 'Session';
    const meta = document.createElement('div');
    meta.className = 'event-meta';
    meta.textContent = `${String(event.type).replace(/-/g, ' ')} · ${relative(event.at)}`;
    main.append(title, meta);
    item.append(main);
    const badge = document.createElement('span');
    const delivery = event.delivery || 'received';
    badge.className = `badge ${delivery === 'sent' ? 'sent' : delivery === 'failed' ? 'failed' : delivery === 'suppressed' ? 'suppressed' : ''}`;
    badge.textContent = delivery === 'queued' ? 'queued' : delivery;
    item.append(badge);
    list.append(item);
  }
};

const renderStatus = (status) => {
  state.status = status;
  const configured = Boolean(status?.configured);
  if (state.error) {
    setPill('not reachable', 'error');
    setText('subtitle', serviceError(state.error));
  } else if (!configured) {
    setPill('needs token', 'warning');
    setText('subtitle', 'Waiting for a bot token in Settings → Integrations');
  } else if (status?.bot?.username) {
    setPill('connected', 'success');
    setText('subtitle', `@${status.bot.username} · long polling active`);
  } else {
    setPill('connecting', 'warning');
    setText('subtitle', 'Token saved; connecting to Telegram…');
  }
  setText('version', `Telegram Desk ${status?.version ?? ''}`.trim());
  renderSetup(status);
  renderFacts(status);
  renderPairing(status);
  renderNotify(status);
  renderEvents(status);
  const pending = status?.pending ?? { questions: 0, permissions: 0 };
  const count = (pending.questions ?? 0) + (pending.permissions ?? 0);
  if (typeof host.setBadge === 'function') {
    host.setBadge(count > 0 ? count : null).catch(() => {});
  }
};

const updateExpiry = () => {
  const pairing = state.status?.pairing;
  if (!pairing) return;
  const remaining = Math.max(0, pairing.expiresAt - Date.now());
  if (remaining <= 0) {
    setText('pair-expiry', 'expired');
    return;
  }
  setText('pair-expiry', `expires in ${Math.floor(remaining / 60000)}m ${Math.floor((remaining % 60000) / 1000)}s`);
};

const loadStatus = async () => {
  if (state.loading) return;
  if (document.hidden) return;
  state.loading = true;
  try {
    const result = await request('GET', '/status');
    if (result.status === 200 && result.body.ok !== false) {
      state.error = null;
      renderStatus(result.body);
    } else {
      state.error = { message: result.body.error || `HTTP ${result.status}` };
      renderStatus(state.status);
    }
  } catch (error) {
    state.error = error;
    renderStatus(state.status);
  } finally {
    state.loading = false;
    state.lastLoadedAt = Date.now();
  }
};

const refreshServiceState = async () => {
  if (typeof host.serviceStatus !== 'function') {
    state.service = 'unknown';
    return;
  }
  try {
    const result = await host.serviceStatus();
    state.service = result?.status ?? 'unknown';
  } catch {
    state.service = 'unavailable';
  }
};

const sendTest = async () => {
  setBusy('test', true);
  setResult('test-result', 'Sending…');
  try {
    const result = await request('POST', '/test');
    const body = result.body;
    if (result.status === 200 && body.ok) {
      const sent = (body.results ?? []).filter((item) => item.ok).length;
      setResult('test-result', `Test sent to ${sent} chat${sent === 1 ? '' : 's'}.`);
    } else {
      setResult('test-result', body.error || `HTTP ${result.status}`, true);
    }
  } catch (error) {
    setResult('test-result', serviceError(error), true);
  } finally {
    setBusy('test', false);
    await loadStatus();
  }
};

const createPairCode = async () => {
  setBusy('pair', true);
  setResult('pair-result', '');
  try {
    const result = await request('POST', '/pair/code');
    if (result.status === 200 && result.body.ok) {
      if (state.status) state.status.pairing = { code: result.body.code, expiresAt: result.body.expiresAt };
      renderPairing(state.status);
      setResult('pair-result', `Send /start ${result.body.code} to the bot in a private chat.`);
      await loadStatus();
    } else {
      setResult('pair-result', result.body.error || `HTTP ${result.status}`, true);
    }
  } catch (error) {
    setResult('pair-result', serviceError(error), true);
  } finally {
    setBusy('pair', false);
  }
};

const removeChat = async (id) => {
  try {
    const result = await request('POST', '/allowlist/remove', { id });
    if (result.status !== 200 || !result.body.ok) {
      setResult('pair-result', result.body.error || `HTTP ${result.status}`, true);
      return;
    }
    if (result.body.status) renderStatus(result.body.status);
    setResult('pair-result', `Removed ${id} from paired chats.`);
  } catch (error) {
    setResult('pair-result', serviceError(error), true);
  }
};

const changeNotifyMode = async () => {
  const mode = $('notify-mode').value;
  setBusy('notify', true);
  setResult('notify-result', 'Saving…');
  try {
    const result = await request('POST', '/notify-mode', { mode });
    if (result.status === 200 && result.body.ok) {
      setResult('notify-result', 'Saved.');
      await loadStatus();
    } else {
      setResult('notify-result', result.body.error || `HTTP ${result.status}`, true);
    }
  } catch (error) {
    setResult('notify-result', serviceError(error), true);
  } finally {
    setBusy('notify', false);
  }
};

const bind = () => {
  $('test-button').addEventListener('click', () => void sendTest());
  $('pair-button').addEventListener('click', () => void createPairCode());
  $('notify-mode').addEventListener('change', () => void changeNotifyMode());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void loadStatus();
  });
};

host.onReady((ctx) => {
  try {
    applyHostReady(ctx, document.documentElement);
  } catch {
    // The panel still works with its fallback colours.
  }
  document.body.dataset.theme = ctx?.theme?.mode ?? 'light';
});

if (typeof host.onServiceEvent === 'function') {
  host.onServiceEvent((event) => {
    if (event?.topic === 'status') void loadStatus();
  });
}

bind();
void refreshServiceState().then(() => loadStatus());
setInterval(() => void loadStatus(), 3000);
setInterval(() => updateExpiry(), 1000);
