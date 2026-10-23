'use strict';

/**
 * stream-info module
 * ──────────────────
 * Shared live-stream state for the whole plugin stack.
 *
 * Polls Twitch Helix GET /streams for the broadcaster's channel and keeps:
 *   • a snapshot of the current stream (live?, game, title, viewers, startedAt)
 *   • a per-session viewer time-series (one sample per successful poll)
 *   • an archive of frozen sessions — data FREEZES when the stream ends
 *
 * Why polling instead of EventSub:
 *   Twitch's EventSub has stream.online / stream.offline events but NO
 *   viewer-count event — the Helix /streams endpoint is the ONLY source of
 *   live viewer counts. One GET per poll interval (default 60 s) is well
 *   within the app-token rate limit (800 points/min) and doubles as our
 *   live/offline + game-change detector, so a single loop covers everything.
 *
 * Data freezes on stream end:
 *   When a poll comes back empty after the channel was live, the open session
 *   is frozen (endedAt set, samples stop growing) and pushed into the archive.
 *   The frozen session stays available via getLastSession() so dashboards can
 *   keep showing (and exporting as CSV) the finished stream's viewer graph
 *   until the next stream starts a fresh session.
 *
 * Restart resilience:
 *   Sessions are persisted to data/stream-sessions.json after every sample.
 *   On boot, an open session is resumed when the stream's Twitch `started_at`
 *   still matches (bot restarted mid-stream); a stale open session is frozen.
 *
 * Exposed to plugins as context.streamInfo (wired in index.js, documented in
 * PLUGIN_AUTHORING.md):
 *   start(twitch), stop(), pollNow(),
 *   isLive(), getSnapshot(), getActiveGame(), getViewerCount(),
 *   getCurrentSession(), getLastSession(), getAllSessions(),
 *   getSessionStats(session), onStreamEvent(fn)
 *
 * onStreamEvent events (listener receives a single event object):
 *   { type: 'live',        snapshot }                    — stream started
 *   { type: 'offline',     snapshot }                    — stream ended, session frozen
 *   { type: 'game-change', snapshot, from, to }          — category changed mid-stream
 *   { type: 'update',      snapshot }                    — regular poll while live
 *
 * Env vars:
 *   STREAM_INFO_POLL_SECONDS   poll cadence (default 60, clamped 15–600)
 *   STREAM_INFO_MAX_SESSIONS   frozen sessions kept on disk (default 12)
 *   STREAM_INFO_MAX_SAMPLES    samples per session before decimation (default 1440)
 *   STREAM_INFO_DATA_FILE      override persistence path
 *                              (default <repo root>/data/stream-sessions.json)
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

// ── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_POLL_SECONDS = 60;

function _clampEnvInt(name, def, min, max) {
  const parsed = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return def;
  return Math.min(max, Math.max(min, parsed));
}

const POLL_SECONDS  = _clampEnvInt('STREAM_INFO_POLL_SECONDS', DEFAULT_POLL_SECONDS, 15, 600);
const MAX_SESSIONS  = _clampEnvInt('STREAM_INFO_MAX_SESSIONS', 12, 1, 500);
const MAX_SAMPLES   = _clampEnvInt('STREAM_INFO_MAX_SAMPLES', 1440, 60, 20000);
const DATA_FILE     = process.env.STREAM_INFO_DATA_FILE
  ? path.resolve(process.env.STREAM_INFO_DATA_FILE)
  : path.resolve(__dirname, '..', 'data', 'stream-sessions.json');

// ── State ───────────────────────────────────────────────────────────────────

let _twitch            = null;   // src/twitch module, injected via start()
let _broadcasterId     = null;   // resolved once, then reused for every poll
let _running           = false;
let _timer             = null;
let _consecutiveErrors = 0;
let _everEmitted       = false;

/** Latest snapshot — safe to hand to callers via getSnapshot(). */
let _snapshot = {
  isLive: false, gameName: null, gameId: null, title: null,
  viewers: 0, startedAt: null, gameSinceAt: null, fetchedAt: 0,
};

/** Open (live) session, or null while offline. */
let _current = null;

/** Archived frozen sessions, oldest first, capped at MAX_SESSIONS. */
let _sessions = [];

/** Subscribers — see onStreamEvent(). */
const _listeners = [];

// ── Session helpers ─────────────────────────────────────────────────────────

function _copySession(s) {
  if (!s) return null;
  return {
    ...s,
    samples: (s.samples ?? []).map(x => [x[0], x[1], x[2]]),
    games:   (s.games ?? []).slice(),
    peak:    { ...(s.peak ?? { v: 0, t: null }) },
  };
}

/** Index of a game name inside the session's compact games table. */
function _gameIndex(session, gameName) {
  const name = gameName ?? 'Unknown';
  let i = session.games.indexOf(name);
  if (i === -1) { session.games.push(name); i = session.games.length - 1; }
  return i;
}

/**
 * Append one viewer sample to the open session.
 * Bounds memory on very long streams: once MAX_SAMPLES is exceeded the OLDER
 * half of the series is decimated (every other point dropped) while the recent
 * half keeps full resolution. rawSampleCount records how many polls were
 * actually captured, so exports stay honest about the original cadence.
 */
function _appendSample(nowMs) {
  const session = _current;
  if (!session) return;

  const tSec = Math.floor(nowMs / 1000);
  const gi   = _gameIndex(session, _snapshot.gameName);
  const last = session.samples[session.samples.length - 1];

  // Two polls inside the same second → refresh the last sample in place
  if (last && last[0] === tSec) {
    last[1] = _snapshot.viewers;
    last[2] = gi;
  } else {
    session.samples.push([tSec, _snapshot.viewers, gi]);
  }
  session.rawSampleCount = (session.rawSampleCount ?? 0) + 1;

  if (_snapshot.viewers > (session.peak?.v ?? 0)) {
    session.peak = { v: _snapshot.viewers, t: nowMs };
  }

  if (session.samples.length > MAX_SAMPLES) {
    const half = Math.floor(session.samples.length / 2);
    session.samples = session.samples.filter((s, i) => i >= half || i % 2 === 0);
    session.decimated = true;
  }
}

/**
 * Freeze the open session: stamp endedAt with the last time we saw viewers,
 * move it into the archive, and trim the archive to MAX_SESSIONS.
 */
function _freezeCurrent(nowMs) {
  const session = _current;
  if (!session) return null;
  const last = session.samples[session.samples.length - 1];
  session.endedAt = last ? last[0] * 1000 : nowMs;
  _current = null;
  _sessions.push(session);
  while (_sessions.length > MAX_SESSIONS) _sessions.shift();
  return _copySession(session);
}

/**
 * Apply a fresh /streams result (null entry = offline) to all state:
 * create/resume/freeze sessions, track game changes, emit events.
 */
function _applyStreamState(s, nowMs) {
  const prevGame = _snapshot?.gameName ?? null;

  _snapshot = {
    isLive:      !!s,
    gameName:    s?.game_name ?? null,
    gameId:      s?.game_id ?? null,
    title:       s?.title ?? null,
    viewers:     Number(s?.viewer_count) || 0,
    startedAt:   s?.started_at ? Date.parse(s.started_at) : null,
    gameSinceAt: _snapshot?.gameSinceAt ?? null,
    fetchedAt:   nowMs,
  };

  if (_snapshot.isLive) {
    // Start a new session when none is open, or when Twitch reports a
    // different started_at (covers: first poll while live, mid-stream bot
    // restart resuming the persisted session, and Twitch stream restarts).
    if (!_current || _current.startedAt !== _snapshot.startedAt) {
      if (_current) _freezeCurrent(nowMs);   // stale open session (old stream)
      _current = {
        startedAt:      _snapshot.startedAt ?? nowMs,
        endedAt:        null,
        gameName:       _snapshot.gameName,
        title:          _snapshot.title,
        games:          [],
        samples:        [],
        peak:           { v: 0, t: null },
        rawSampleCount: 0,
        decimated:      false,
      };
      _snapshot.gameSinceAt = _current.startedAt;
      log.info(`[stream-info] Stream is LIVE — tracking viewers${_snapshot.gameName ? ` (${_snapshot.gameName})` : ''}`);
      _emit({ type: 'live', snapshot: { ..._snapshot } });
    }

    if (prevGame && _snapshot.gameName && prevGame !== _snapshot.gameName) {
      _snapshot.gameSinceAt = nowMs;
      log.info(`[stream-info] Game changed: "${prevGame}" → "${_snapshot.gameName}"`);
      _emit({ type: 'game-change', snapshot: { ..._snapshot }, from: prevGame, to: _snapshot.gameName });
    }

    _appendSample(nowMs);
    _current.title = _snapshot.title;
    _emit({ type: 'update', snapshot: { ..._snapshot } });
    _save();
  } else {
    _snapshot.gameSinceAt = null;
    if (_current) {
      const frozen = _freezeCurrent(nowMs);
      log.info(
        `[stream-info] Stream ended — session frozen ` +
        `(${frozen ? frozen.samples.length : 0} samples, peak ${frozen?.peak?.v ?? 0} viewers)`
      );
      _emit({ type: 'offline', snapshot: { ..._snapshot } });
      _save();
    } else if (!_everEmitted) {
      // First-ever poll came back offline — let dashboards render "offline"
      // instead of "waiting for data".
      _emit({ type: 'update', snapshot: { ..._snapshot } });
    }
    // Quiet offline polls emit nothing: nothing changed, no traffic needed.
  }
}

// ── Poll loop ───────────────────────────────────────────────────────────────

/**
 * Perform one poll right now. Also exported so tests (and anything else that
 * wants a manual refresh) can drive the state machine without waiting for
 * the timer.
 *
 * @param {number} [nowMs] Override for "now" (ms epoch) — used by tests to
 *        simulate the passage of time between polls. Defaults to Date.now().
 */
async function pollNow(nowMs) {
  if (!_twitch) throw new Error('stream-info not started');
  if (!_broadcasterId) {
    _broadcasterId = await _twitch.getBroadcasterId();
    if (!_broadcasterId) throw new Error('could not resolve broadcaster id');
  }
  const data = await _twitch.helixRequest('GET', `/streams?user_id=${_broadcasterId}&first=1`);
  const s = Array.isArray(data?.data) ? (data.data[0] ?? null) : null;
  _applyStreamState(s, nowMs ?? Date.now());
}

async function _tick() {
  if (!_running) return;
  try {
    await pollNow();
    _consecutiveErrors = 0;
    _schedule(POLL_SECONDS * 1000);
  } catch (err) {
    _consecutiveErrors++;
    const backoff = Math.min(16, 2 ** Math.min(4, _consecutiveErrors - 1));
    log.warn(
      `[stream-info] Poll failed (${_consecutiveErrors}x): ${err.message} ` +
      `— retrying in ${POLL_SECONDS * backoff}s`
    );
    _schedule(POLL_SECONDS * backoff * 1000);
  }
}

function _schedule(delayMs) {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { _tick().catch(() => {}); }, delayMs);
}

// ── Persistence ─────────────────────────────────────────────────────────────

function _save() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      current: _current,
      sessions: _sessions,
    }));
  } catch (err) {
    log.error('[stream-info] Failed to save sessions:', err.message);
  }
}

function _load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw?.version !== 1) {
      log.warn('[stream-info] Unknown data-file version — starting fresh');
      return;
    }
    _sessions = Array.isArray(raw.sessions)
      ? raw.sessions.filter(s => s && Array.isArray(s.samples))
      : [];
    _current = raw.current && Array.isArray(raw.current.samples) ? raw.current : null;
    log.info(
      `[stream-info] Loaded ${_sessions.length} archived session(s)` +
      (_current ? ' + 1 open session (will resume if the stream is still live)' : '')
    );
  } catch (err) {
    log.warn('[stream-info] Could not read', DATA_FILE, ':', err.message);
    try { fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch { /* ignore */ }
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

function _emit(event) {
  _everEmitted = true;
  for (const fn of _listeners) {
    try { fn(event); }
    catch (err) { log.error('[stream-info] listener error:', err.message); }
  }
}

/**
 * Subscribe to stream state events.
 * @param {(event: { type: 'live'|'offline'|'game-change'|'update', snapshot: object, from?: string, to?: string }) => void} fn
 * @returns {() => void} unsubscribe function
 */
function onStreamEvent(fn) {
  if (typeof fn !== 'function') throw new TypeError('onStreamEvent: handler must be a function');
  _listeners.push(fn);
  return () => {
    const i = _listeners.indexOf(fn);
    if (i !== -1) _listeners.splice(i, 1);
  };
}

// ── Public getters ──────────────────────────────────────────────────────────

function isLive()          { return !!_snapshot.isLive; }
function getViewerCount()  { return _snapshot.isLive ? _snapshot.viewers : 0; }
function getSnapshot()     { return { ..._snapshot }; }

/**
 * The game (Twitch category) currently being played, or null when offline.
 * @returns {{ name: string, id: string, since: number } | null}
 */
function getActiveGame() {
  if (!_snapshot.isLive || !_snapshot.gameName) return null;
  return {
    name: _snapshot.gameName,
    id:   _snapshot.gameId,
    since: _snapshot.gameSinceAt ?? _snapshot.startedAt,
  };
}

/** The open live session (copy), or null while offline. */
function getCurrentSession() { return _copySession(_current); }

/**
 * The most recently FROZEN session (copy), or null if none exists yet.
 * While live, this returns the previous stream's frozen data — the open
 * session is available via getCurrentSession().
 */
function getLastSession() {
  return _copySession(_sessions[_sessions.length - 1] ?? null);
}

/** All archived frozen sessions (copies), oldest first. */
function getAllSessions() { return _sessions.map(_copySession); }

/**
 * Summary statistics for a session object (works for open or frozen ones).
 * @param {{ startedAt: number, endedAt?: number|null, samples?: Array }} session
 * @returns {{ peak: number, peakAt: number|null, avg: number, count: number, durationMs: number }}
 */
function getSessionStats(session) {
  if (!session) return { peak: 0, peakAt: null, avg: 0, count: 0, durationMs: 0 };
  const samples = session.samples ?? [];
  let peak = 0, peakAt = null, sum = 0;
  for (const [t, v] of samples) {
    if (v > peak) { peak = v; peakAt = t * 1000; }
    sum += v;
  }
  const endedAt = session.endedAt ?? Date.now();
  return {
    peak,
    peakAt,
    avg:    samples.length ? Math.round(sum / samples.length) : 0,
    count:  samples.length,
    durationMs: Math.max(0, endedAt - (session.startedAt ?? endedAt)),
  };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Start polling. Call once from index.js with the src/twitch module.
 * @param {{ helixRequest: Function, getBroadcasterId: Function }} twitchModule
 */
function start(twitchModule) {
  if (_running) return;
  if (!twitchModule?.helixRequest || typeof twitchModule?.getBroadcasterId !== 'function') {
    log.warn('[stream-info] start() called without the twitch module — stream state disabled');
    return;
  }
  _twitch  = twitchModule;
  _running = true;
  _load();
  _schedule(250);   // first poll almost immediately
  log.info(`[stream-info] Polling Twitch /streams every ${POLL_SECONDS}s (active game + live viewers)`);
}

function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = {
  start,
  stop,
  pollNow,

  isLive,
  getSnapshot,
  getActiveGame,
  getViewerCount,
  getCurrentSession,
  getLastSession,
  getAllSessions,
  getSessionStats,

  onStreamEvent,
};
