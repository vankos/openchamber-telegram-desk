'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { timingSafeEqual } = require('./ids');

const DAY = 24 * 60 * 60 * 1000;

const defaultState = () => ({
  version: 1,
  offset: 0,
  pairedIds: [],
  primaryChatId: null,
  pairCode: null,
  pairAttempts: {},
  messages: {},
  refs: {},
  forms: {},
  permissions: {},
  processedCallbacks: {},
  seenEvents: {},
  seenUpdates: {},
  sessionRegistry: {},
  watchedSessions: {},
  lastSessionLists: {},
  preferences: { notifyMode: null },
  outbox: [],
  recentEvents: [],
  lastDigestAt: {},
  stats: { events: 0, sent: 0, answers: 0, errors: 0 },
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const mergeState = (base, incoming) => {
  if (!isObject(incoming)) return base;
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in base)) continue;
    if (isObject(base[key]) && isObject(value) && !Array.isArray(base[key])) {
      base[key] = { ...base[key], ...value };
    } else if (Array.isArray(base[key]) && Array.isArray(value)) {
      base[key] = value;
    } else if (typeof base[key] === typeof value || base[key] === null) {
      base[key] = value;
    }
  }
  return base;
};

const mapValues = (map) => (isObject(map) ? map : {});

const pruneByAge = (map, getAt, cutoff, maxEntries = 0) => {
  for (const [key, value] of Object.entries(map)) {
    if (getAt(value) < cutoff) delete map[key];
  }
  if (maxEntries > 0) {
    const keys = Object.keys(map);
    if (keys.length > maxEntries) {
      keys
        .sort((a, b) => getAt(map[a]) - getAt(map[b]))
        .slice(0, keys.length - maxEntries)
        .forEach((key) => delete map[key]);
    }
  }
};

class Store {
  constructor({ dir, clock = Date.now, logger }) {
    if (!dir) throw new Error('Store needs a data directory');
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.clock = clock;
    this.logger = logger;
    this.state = defaultState();
    this._dirty = false;
    this._timer = null;
    this._writing = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = mergeState(defaultState(), parsed);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn('Could not read state, starting fresh', { code: error?.code, message: error?.message });
        try {
          await fs.rename(this.file, `${this.file}.broken-${this.clock()}`);
        } catch {
          // best effort; a broken file must not stop the service
        }
      }
    }
    this.#normalize();
    this.prune();
    return this.state;
  }

  #normalize() {
    const state = this.state;
    if (!Number.isFinite(state.offset)) state.offset = 0;
    state.offset = Math.max(0, Math.trunc(state.offset));
    if (!Array.isArray(state.pairedIds)) state.pairedIds = [];
    state.pairedIds = state.pairedIds.filter((id) => Number.isSafeInteger(id) && id !== 0);
    if (!Number.isSafeInteger(state.primaryChatId) || state.primaryChatId === 0) state.primaryChatId = null;
    for (const key of ['messages', 'refs', 'forms', 'permissions', 'processedCallbacks', 'seenEvents', 'seenUpdates',
      'sessionRegistry', 'watchedSessions', 'pairAttempts', 'lastDigestAt', 'lastSessionLists']) {
      state[key] = mapValues(state[key]);
    }
    if (!isObject(state.preferences)) state.preferences = { notifyMode: null };
    if (!['all', 'active', 'off', null].includes(state.preferences.notifyMode)) state.preferences.notifyMode = null;
    if (!Array.isArray(state.outbox)) state.outbox = [];
    if (!Array.isArray(state.recentEvents)) state.recentEvents = [];
    if (!isObject(state.stats)) state.stats = { events: 0, sent: 0, answers: 0, errors: 0 };
    for (const key of ['events', 'sent', 'answers', 'errors']) {
      if (!Number.isFinite(state.stats[key])) state.stats[key] = 0;
    }
    if (!isObject(state.pairCode)) state.pairCode = null;
  }

  touch() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, 100);
    this._timer.unref?.();
  }

  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return;
    this._dirty = false;
    const data = JSON.stringify(this.state);
    this._writing = this._writing.then(async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, data, { mode: 0o600 });
      try {
        await fs.rename(temp, this.file);
      } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
        await fs.rm(this.file, { force: true });
        await fs.rename(temp, this.file);
      }
    }).catch((error) => {
      this._dirty = true;
      this.logger?.error('Could not save state', { code: error?.code, message: error?.message });
    });
    await this._writing;
  }

  prune() {
    const now = this.clock();
    const state = this.state;
    pruneByAge(state.processedCallbacks, (v) => v?.at ?? 0, now - 3 * DAY, 2000);
    pruneByAge(state.seenEvents, (v) => v ?? 0, now - 7 * DAY, 2000);
    pruneByAge(state.seenUpdates, (v) => v ?? 0, now - DAY, 1000);
    pruneByAge(state.messages, (v) => v?.at ?? 0, now - 14 * DAY);
    pruneByAge(state.refs, (v) => v?.at ?? 0, now - 14 * DAY);
    for (const [key, form] of Object.entries(state.forms)) {
      const age = now - (form?.updatedAt ?? 0);
      if (form?.closed ? age > DAY : age > 7 * DAY) delete state.forms[key];
    }
    pruneByAge(state.permissions, (v) => v?.at ?? 0, now - 7 * DAY);
    pruneByAge(state.sessionRegistry, (v) => v?.updatedAt ?? 0, now - 30 * DAY);
    pruneByAge(state.watchedSessions, (v) => v ?? 0, now - 2 * DAY);
    pruneByAge(state.lastDigestAt, (v) => v ?? 0, now - 180 * DAY, 20);
    for (const [key, attempts] of Object.entries(state.pairAttempts)) {
      const fresh = (Array.isArray(attempts) ? attempts : []).filter((at) => at > now - DAY);
      if (fresh.length) state.pairAttempts[key] = fresh.slice(-20);
      else delete state.pairAttempts[key];
    }
    if (state.pairCode && state.pairCode.expiresAt <= now) state.pairCode = null;
    state.outbox = state.outbox
      .filter((item) => (item?.attempts ?? 0) < 8 && (item?.createdAt ?? 0) > now - 2 * DAY)
      .slice(-100);
    state.recentEvents = state.recentEvents.slice(-40);
    this.touch();
  }

  setOffset(value) {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, Math.trunc(value));
    this.state.offset = Math.max(this.state.offset, next);
    this.touch();
  }

  hasSeenEvent(eventId) {
    return Object.prototype.hasOwnProperty.call(this.state.seenEvents, eventId);
  }

  markEventSeen(eventId) {
    this.state.seenEvents[eventId] = this.clock();
    this.touch();
  }

  hasSeenUpdate(updateId) {
    return Object.prototype.hasOwnProperty.call(this.state.seenUpdates, updateId);
  }

  markUpdateSeen(updateId) {
    this.state.seenUpdates[updateId] = this.clock();
    this.touch();
  }

  callbackOutcome(callbackId) {
    return this.state.processedCallbacks[callbackId] ?? null;
  }

  markCallback(callbackId, outcome) {
    this.state.processedCallbacks[callbackId] = { at: this.clock(), outcome };
    this.touch();
  }

  recordMessage(chatId, messageId, route) {
    if (!Number.isSafeInteger(messageId)) return;
    this.state.messages[`${chatId}:${messageId}`] = {
      sessionId: route.sessionId ?? null,
      sessionTitle: route.sessionTitle ?? null,
      kind: route.kind ?? 'session',
      formKey: route.formKey ?? null,
      at: this.clock(),
    };
    this.touch();
  }

  messageRoute(chatId, messageId) {
    return this.state.messages[`${chatId}:${messageId}`] ?? null;
  }

  addRef(ref, data) {
    this.state.refs[ref] = { ...data, at: this.clock() };
    this.touch();
  }

  getRef(ref) {
    return this.state.refs[ref] ?? null;
  }

  deleteRef(ref) {
    delete this.state.refs[ref];
    this.touch();
  }

  touchSession(sessionId, patch = {}) {
    if (!sessionId) return;
    const current = this.state.sessionRegistry[sessionId] ?? {};
    this.state.sessionRegistry[sessionId] = {
      ...current,
      ...patch,
      sessionId,
      updatedAt: this.clock(),
    };
    this.touch();
  }

  watchSession(sessionId) {
    if (!sessionId) return;
    this.state.watchedSessions[sessionId] = this.clock();
    this.touch();
  }

  isWatched(sessionId, ttlMs = DAY) {
    const at = this.state.watchedSessions[sessionId];
    return Number.isFinite(at) && this.clock() - at <= ttlMs;
  }

  addOutbox(item) {
    const entry = {
      id: item.id,
      eventId: item.eventId ?? null,
      chatId: item.chatId,
      text: item.text,
      plain: item.plain ?? null,
      parts: item.parts ?? null,
      rich: item.rich ?? null,
      sentParts: item.sentParts ?? 0,
      keyboard: item.keyboard ?? null,
      replyToMessageId: item.replyToMessageId ?? null,
      sessionId: item.sessionId ?? null,
      sessionTitle: item.sessionTitle ?? null,
      formKey: item.formKey ?? null,
      permissionRef: item.permissionRef ?? null,
      kind: item.kind ?? 'event',
      attempts: 0,
      nextAt: item.nextAt ?? 0,
      createdAt: this.clock(),
    };
    this.state.outbox.push(entry);
    if (this.state.outbox.length > 100) this.state.outbox.splice(0, this.state.outbox.length - 100);
    this.touch();
    return entry;
  }

  dueOutbox(now = this.clock()) {
    return this.state.outbox
      .filter((item) => (item.nextAt ?? 0) <= now)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  updateOutbox(id, patch) {
    const item = this.state.outbox.find((entry) => entry.id === id);
    if (item) Object.assign(item, patch);
    this.touch();
    return item ?? null;
  }

  removeOutbox(id) {
    this.state.outbox = this.state.outbox.filter((entry) => entry.id !== id);
    this.touch();
  }

  recordRecent(event) {
    const entry = {
      id: event.id,
      type: event.type,
      sessionId: event.sessionId ?? null,
      sessionTitle: event.sessionTitle ?? null,
      at: event.at ?? this.clock(),
      delivery: event.delivery ?? 'received',
      detail: event.detail ?? null,
    };
    this.state.recentEvents.push(entry);
    if (this.state.recentEvents.length > 40) this.state.recentEvents.splice(0, this.state.recentEvents.length - 40);
    this.touch();
    return entry;
  }

  updateRecent(id, patch) {
    const entry = [...this.state.recentEvents].reverse().find((item) => item.id === id);
    if (entry) Object.assign(entry, patch);
    this.touch();
    return entry ?? null;
  }

  setPairCode(code, ttlMs) {
    const now = this.clock();
    this.state.pairCode = { code, createdAt: now, expiresAt: now + ttlMs };
    this.touch();
  }

  activePairCode() {
    const pair = this.state.pairCode;
    if (!pair || pair.expiresAt <= this.clock()) return null;
    return { code: pair.code, expiresAt: pair.expiresAt };
  }

  consumePairCode(code) {
    const active = this.activePairCode();
    if (!active) return false;
    if (!timingSafeEqual(active.code, code)) return false;
    this.state.pairCode = null;
    this.touch();
    return true;
  }

  pairAttempt(chatId, limit, windowMs) {
    const now = this.clock();
    const key = String(chatId);
    const attempts = (this.state.pairAttempts[key] ?? []).filter((at) => at > now - windowMs);
    if (attempts.length >= limit) {
      this.state.pairAttempts[key] = attempts;
      this.touch();
      return false;
    }
    attempts.push(now);
    this.state.pairAttempts[key] = attempts;
    this.touch();
    return true;
  }

  addPairedId(id) {
    if (!Number.isSafeInteger(id) || id === 0) return;
    if (!this.state.pairedIds.includes(id)) this.state.pairedIds.push(id);
    if (this.state.primaryChatId === null) this.state.primaryChatId = id;
    this.touch();
  }

  removePairedId(id) {
    this.state.pairedIds = this.state.pairedIds.filter((value) => value !== id);
    if (this.state.primaryChatId === id) this.state.primaryChatId = null;
    this.touch();
  }

  setPrimaryChat(id) {
    this.state.primaryChatId = Number.isSafeInteger(id) ? id : null;
    this.touch();
  }

  setNotifyPreference(mode) {
    this.state.preferences.notifyMode = ['all', 'active', 'off'].includes(mode) ? mode : null;
    this.touch();
  }

  setLastSessionList(chatId, sessionIds) {
    this.state.lastSessionLists[String(chatId)] = Array.isArray(sessionIds) ? sessionIds.slice(0, 30) : [];
    this.touch();
  }

  lastSessionList(chatId) {
    return this.state.lastSessionLists[String(chatId)] ?? [];
  }

  setLastDigest(chatId, at = this.clock()) {
    this.state.lastDigestAt[String(chatId)] = at;
    this.touch();
  }

  lastDigest(chatId) {
    return this.state.lastDigestAt[String(chatId)] ?? 0;
  }

  bump(metric, amount = 1) {
    if (!(metric in this.state.stats)) return;
    this.state.stats[metric] += amount;
    this.touch();
  }
}

module.exports = {
  Store,
  defaultState,
  DAY,
};
