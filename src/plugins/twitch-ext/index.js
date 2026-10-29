'use strict';

/**
 * Plugin: twitch-ext — generic Twitch Extension backend (EBS) host
 * ─────────────────────────────────────────────────────────────────
 * Infrastructure for Twitch Extension panels (Panel + Mobile views).
 * This module knows how to talk to Twitch — viewer JWT auth, Extension
 * PubSub, Helix, the bot's broadcaster id — and NOTHING about any
 * feature. Plugins register "feeds" to surface their state and receive
 * viewer actions; the host handles identity, security and delivery.
 *
 * ── Registering a feed (from any plugin) ────────────────────────────
 *
 *   const twitchExt = require('../twitch-ext');
 *
 *   twitchExt.registerFeed({
 *     id: 'my-feature',              // unique, [a-zA-Z0-9_-]{1,32}
 *     title: 'My Feature',           // optional — for logs + /ext/health
 *     games: ['Geometry Dash'],      // optional category gate (case-
 *                                     // insensitive). null / [] / omitted
 *                                     // → active whenever the channel is
 *                                     // live, in ANY category
 *     snapshot({ byteBudget }) {     // state for the panels; called
 *       return { items: _items };    // lazily on every broadcast and
 *     },                             // /ext/state — keep it cheap & JSON-safe.
 *                                     // Trim yourself down to byteBudget
 *                                     // bytes (JSON) so the whole envelope
 *                                     // stays under Twitch's 5 KB PubSub cap.
 *     actions: {                     // optional — what viewers may POST
 *       'do-thing': (viewer, payload) => {
 *         // viewer = { login, opaqueId, channelId } — TRUSTED identity
 *         //         (login comes from the SIGNED viewer JWT; '' if the
 *         //         viewer is anonymous — never trust payload for names)
 *         // payload = the parsed JSON body (also carries .type)
 *         // Return { ok: true, ...extras } or
 *         //        { ok: false, error, status?: 4xx } — sent to the panel.
 *         return { ok: true, counted: _items.length };
 *       },
 *     },
 *   });
 *
 *   twitchExt.publish('my-feature'); // call whenever the feed's data
 *                                     // changed → host broadcasts soon
 *                                     // (merged + spaced to Twitch's caps)
 *
 * registerFeed() returns an unregister() function (mostly for tests).
 *
 * ── Wire format (what the panels see) ────────────────────────────────
 *
 *   GET /ext/state (viewer JWT) and every PubSub broadcast carry the
 *   same envelope:
 *
 *   {
 *     active: true,            // ANY registered feed is active
 *     category: 'Geometry Dash',
 *     updatedAt: 1761170000000,
 *     feeds: {
 *       'my-feature': {
 *         active: true,         // this feed's own category gate
 *         data: { …whatever snapshot() returned… }
 *       }
 *     }
 *   }
 *
 *   A front-end for one specific Twitch extension picks its feed id and
 *   reads state.feeds['my-feature'].data. (Each Twitch extension has its
 *   own client id and its own front-end; several feeds can share this
 *   one EBS.)
 *
 *   POST /ext/submit (viewer JWT) — { type: 'do-thing', …payload }.
 *   `type` routes to the feed that registered that action. The host
 *   handles: JWT verification, channel match, per-viewer per-action
 *   cooldown, body size cap, and the feed's category gate. The action
 *   handler's return value becomes the HTTP response.
 *
 * ── Host-owned guarantees ────────────────────────────────────────────
 *
 *   1. CATEGORY GATE — each feed declares which categories activate it
 *      (games). Feed state comes from src/stream-info (already polling
 *      Helix GET /streams every 60 s with the existing app token).
 *
 *   2. STATE BROADCAST — full envelopes to every open panel via Twitch
 *      Extension PubSub (POST /helix/extensions/pubsub,
 *      is_global_broadcast). Twitch caps this at 1 message / second /
 *      channel and ~5 KB per message, so sends are merged and spaced
 *      (BROADCAST_SPACING_MS) and each feed is asked to trim itself to
 *      a byte budget. Full snapshots — not deltas — mean a panel that
 *      misses a broadcast self-heals on the next one or on its periodic
 *      /ext/state refresh.
 *
 *   3. VIEWER IDENTITY — the submitter's name is NEVER client-supplied.
 *      Twitch puts the viewer's login inside the signed JWT (base64-
 *      encoded to keep its case), so the EBS reads it server-side and
 *      hands every action handler a viewer object — viewers can never
 *      spoof each other's names. What a handler does for anonymous
 *      viewers (login '') is the plugin's choice (e.g. Viewer-XXXX
 *      handles derived from the opaque id).
 *
 * ── HTTP routes (mounted on the overlay server, port 2999 — put them
 *    behind your public HTTPS domain, the same one WEBSUB_PUBLIC_URL
 *    uses, e.g. https://yourdomain.com/ext/state → localhost:2999/ext/state):
 *
 *   GET  /ext/health — no-auth smoke test → { ok, active, category,
 *                                             broadcasterId, feeds[] }
 *   GET  /ext/state  — full envelope (requires viewer JWT)
 *   POST /ext/submit — { type, …payload } (requires viewer JWT)
 *
 *   All three send CORS headers — the front-end lives on GitHub Pages
 *   while the EBS lives on the bot's domain, so the browser needs the
 *   cross-origin handshake (including OPTIONS preflight for the
 *   Authorization header).
 *
 * ── Env vars (.env) — host only; feeds configure themselves ──────────
 *   TWITCH_EXT_CLIENT_ID       Extension "Client ID" from the dev console
 *   TWITCH_EXT_SECRET          Extension shared secret — paste the base64
 *                              string EXACTLY as shown; it is decoded here
 *   TWITCH_EXT_BROADCASTER_ID  OPTIONAL pin. Leave it unset (the normal
 *                              case) and the EBS resolves the channel id
 *                              at init() from the bot's own twitch module
 *                              (context.twitch.getBroadcasterId() — the
 *                              same Helix lookup stream-info uses)
 *
 * Front-end pairing: each extension's viewer page (e.g. the viewer.
 * {html,css,js} shipped alongside a plugin's feed) sets EBS_ORIGIN to
 * this server's public HTTPS URL and reads its feed out of the envelope.
 */

const crypto = require('crypto');
const log    = require('../../logger');
const { addRoute } = require('../../overlay-server');
const streamInfo = require('../../stream-info');

// ── Configuration ───────────────────────────────────────────────────────────

const _clientId  = (process.env.TWITCH_EXT_CLIENT_ID || '').trim();
const _secretB64 = (process.env.TWITCH_EXT_SECRET    || '').trim();

// OPTIONAL pin — only for edge cases (bot account ≠ the channel you serve)
// and tests. Normally the broadcaster id is resolved dynamically at init()
// from context.twitch.getBroadcasterId(), so no .env line is needed.
const _broadcasterIdOverride = (process.env.TWITCH_EXT_BROADCASTER_ID || '').trim();

const MAX_SNAPSHOT_BYTES   = 5000;  // Twitch PubSub hard cap: 5 KB per message
const ENVELOPE_OVERHEAD    = 200;   // reserved for the envelope around feed data
const BROADCAST_SPACING_MS = 1100;  // Twitch PubSub hard cap: 1 msg / s / channel
const ACTION_COOLDOWN_MS   = 10000; // per-viewer, per-action submit cooldown
const MAX_BODY_BYTES       = 4096;  // /ext/submit request body cap

let _secretBuf = null;
if (_secretB64) {
  try { _secretBuf = Buffer.from(_secretB64, 'base64'); } catch (_) { /* unreachable */ }
}

const _configured =
  !!(_clientId && _secretB64) &&
  !!(_secretBuf && _secretBuf.length >= 16);

if (!_configured) {
  log.warn(
    '[twitch-ext] Not configured — set TWITCH_EXT_CLIENT_ID and TWITCH_EXT_SECRET ' +
    'in .env to enable the Twitch extension backend. ' +
    'The /ext/* routes stay mounted and answer 503 until then.'
  );
}

// ── Runtime state ───────────────────────────────────────────────────────────

let _twitchModule  = null;                              // set by init(context)
let _broadcasterId = _broadcasterIdOverride || null;    // resolved lazily
let _idPromise     = null;                              // in-flight resolution

let _gameName = null;   // current category name (null while offline)
let _active   = false;  // ANY registered feed is active

let _dirty    = false;  // a broadcast is warranted
let _draining = false;
let _lastPubsubErrorAt = 0;

// ── Feed registry (the plugin-facing heart of the host) ─────────────────────

/** id → { id, title, games, snapshot, actions } in registration order */
const _feeds = new Map();

/** action type → owning feed id (types are unique across feeds) */
const _actionIndex = new Map();

/**
 * Normalise a feed's category gate to a lowercase array.
 * null / [] → null, meaning "active whenever the channel is live".
 */
function _normalizeGames(games) {
  if (games == null) return null;
  const list = Array.isArray(games) ? games : String(games).split(',');
  const out = list.map(g => String(g || '').trim().toLowerCase()).filter(Boolean);
  return out.length ? out : null;
}

/**
 * Register a panel feed. Any plugin may call this — usually at module
 * load, right where it registers its overlay sections and dashboard
 * widgets (see PLUGIN_AUTHORING.md).
 *
 * @param {{ id: string, title?: string, games?: string[]|null,
 *           snapshot: (ctx: { byteBudget: number|null }) => object|null,
 *           actions?: Object<string, (viewer, payload) => object|Promise<object> }} feed
 * @returns {(() => void)|null} unregister function, or null when rejected
 */
function registerFeed(feed) {
  const def  = (feed && typeof feed === 'object') ? feed : {};
  const id   = _sanitizeText(def.id, 32);

  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) {
    log.error('[twitch-ext] registerFeed: feed id must match [a-zA-Z0-9_-]{1,32} — feed ignored');
    return null;
  }
  if (_feeds.has(id)) {
    log.error(`[twitch-ext] registerFeed: feed '${id}' is already registered — ignoring the duplicate`);
    return null;
  }
  if (typeof def.snapshot !== 'function') {
    log.error(`[twitch-ext] registerFeed('${id}'): snapshot must be a function — feed ignored`);
    return null;
  }

  // Collect + validate the actions first (all-or-nothing registration).
  const actions = {};
  if (def.actions && typeof def.actions === 'object') {
    for (const rawType of Object.keys(def.actions)) {
      const type = _sanitizeText(rawType, 32);
      const fn   = def.actions[rawType];
      if (!type || typeof fn !== 'function') {
        log.error(`[twitch-ext] registerFeed('${id}'): action '${rawType}' must be a named function — feed ignored`);
        return null;
      }
      const owner = _actionIndex.get(type);
      if (owner && owner !== id) {
        log.error(
          `[twitch-ext] registerFeed('${id}'): action '${type}' is already owned by ` +
          `feed '${owner}' — action types must be unique across feeds; feed ignored`
        );
        return null;
      }
      actions[type] = fn;
    }
  }

  const feedObj = {
    id,
    title:   _sanitizeText(def.title, 48) || id,
    games:   _normalizeGames(def.games),
    snapshot: def.snapshot,
    actions,
  };

  _feeds.set(id, feedObj);
  for (const type of Object.keys(actions)) _actionIndex.set(type, id);

  log.info(
    `[twitch-ext] Feed registered: '${id}'` +
    (feedObj.games ? ` (active games: ${feedObj.games.join(', ')})` : ' (active whenever live)') +
    (Object.keys(actions).length ? ` — actions: ${Object.keys(actions).join(', ')}` : ' (no viewer actions)')
  );

  _refreshActive(); // a feed can flip the host active/inactive on arrival

  return function unregister() {
    if (_feeds.get(id) !== feedObj) return;
    _feeds.delete(id);
    for (const [type, owner] of _actionIndex) {
      if (owner === id) _actionIndex.delete(type);
    }
    log.info(`[twitch-ext] Feed unregistered: '${id}'`);
    _refreshActive();
  };
}

/**
 * Tell the host a feed's data changed — it will (re)broadcast the full
 * envelope to every open panel, merged and spaced to Twitch's caps.
 * No-ops while no feed is active (panels are then showing their static
 * "No active Extension" page; the next gate flip pushes fresh state).
 *
 * @param {string} [feedId] — which feed changed (logging only; optional)
 */
function publish(feedId) {
  if (feedId && !_feeds.has(feedId)) return; // unknown feed — nothing to publish
  if (_active) _broadcastSoon();
}

// ── Broadcaster id resolution ───────────────────────────────────────────────

/**
 * Resolve the broadcaster id once and cache it. Priority:
 *   1. TWITCH_EXT_BROADCASTER_ID (if pinned in .env — rare)
 *   2. context.twitch.getBroadcasterId() — the bot's own Helix lookup,
 *      the same source stream-info, poll and create-reward already use,
 *      so the extension always serves the channel the bot runs on.
 *
 * In-flight calls are deduped; a failure clears the cache so the next call
 * retries (lazy self-healing — no timers). Returns the id string or null.
 */
function _ensureBroadcasterId() {
  if (_broadcasterId) return Promise.resolve(_broadcasterId);
  if (_idPromise) return _idPromise;

  const mod = _twitchModule;
  if (!mod || typeof mod.getBroadcasterId !== 'function') {
    return Promise.resolve(null);
  }

  _idPromise = Promise.resolve()
    .then(() => mod.getBroadcasterId())
    .then((id) => {
      _idPromise = null;
      _broadcasterId = (id && String(id).trim()) || null;
      return _broadcasterId;
    })
    .catch((err) => {
      _idPromise = null;
      log.warn('[twitch-ext] getBroadcasterId() failed — will retry on the next request:', err.message);
      return null;
    });
  return _idPromise;
}

/** cooldown key (opaqueId + action type) → ms epoch of last accepted action */
const _lastSubmitAt = new Map();

// ── JWT (HS256) — sign & verify with the extension shared secret ────────────
//
// Only HS256 is ever used by Twitch extension tokens, so a hand-rolled
// implementation with node:crypto avoids adding a dependency to the bot.

function _b64urlToBuf(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function _bufToB64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign a JWT with HS256. `secretBuf` must be the base64-DECODED secret. */
function _signHs256(payloadObj, secretBuf) {
  const header  = _bufToB64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = _bufToB64url(Buffer.from(JSON.stringify(payloadObj)));
  const sig     = _bufToB64url(
    crypto.createHmac('sha256', secretBuf).update(header + '.' + payload).digest()
  );
  return header + '.' + payload + '.' + sig;
}

/**
 * Verify an HS256 JWT. Returns the claims object, or null when the token is
 * malformed, signed with another algorithm, has a bad signature, or is expired.
 */
function _verifyHs256(token, secretBuf) {
  if (!secretBuf || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header;
  try { header = JSON.parse(_b64urlToBuf(parts[0]).toString('utf8')); } catch (_) { return null; }
  if (!header || header.alg !== 'HS256') return null; // refuse alg confusion

  const expected = crypto.createHmac('sha256', secretBuf).update(parts[0] + '.' + parts[1]).digest();
  const got      = _b64urlToBuf(parts[2]);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;

  let claims;
  try { claims = JSON.parse(_b64urlToBuf(parts[1]).toString('utf8')); } catch (_) { return null; }
  if (!claims || typeof claims !== 'object') return null;
  if (typeof claims.exp === 'number' && claims.exp <= Date.now() / 1000) return null;

  return claims;
}

/** Server-to-server JWT for calling Helix as the extension (role: external). */
function _serverToken() {
  return _signHs256(
    {
      exp: Math.floor(Date.now() / 1000) + 60,
      user_id: String(_broadcasterId),
      role: 'external',
    },
    _secretBuf
  );
}

// ── HTTP helpers (raw http style — same contract as the other plugins) ──────

function _applyCors(res) {
  // The front-end is hosted on GitHub Pages while this EBS runs on the bot's
  // domain, so every response carries permissive CORS. No cookies are used
  // (credentials: 'omit' on the front-end), so a wildcard origin is safe.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function _sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function _isPreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204, { 'Content-Type': 'text/plain' });
  res.end();
  return true;
}

/**
 * Extract + verify the viewer JWT from the Authorization header.
 * Returns { opaqueId, channelId, login } or null (bad token / wrong
 * channel). `login` is the viewer's Twitch login from the signed token
 * ('' for anonymous viewers) — the ONLY trusted source of identity,
 * handed to every action handler.
 */
function _authorize(req) {
  if (!_secretBuf) return null;
  const header = req.headers && req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;

  const claims = _verifyHs256(match[1], _secretBuf);
  if (!claims) return null;

  // The panel must be embedded in OUR channel, not someone else's.
  if (String(claims.channel_id || '') !== String(_broadcasterId)) return null;

  return {
    opaqueId: String(claims.opaque_user_id || claims.user_id || ''),
    channelId: String(claims.channel_id),
    login: _decodeLoginClaim(claims.login),
  };
}

/** Read + parse a JSON request body, capped at MAX_BODY_BYTES. Null on error. */
function _readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (chunks.length === 0) { done(null); return; }
      try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { done(null); }
    });
    req.on('error', () => done(null));
  });
}

/** Strip control characters, trim, cap length. Returns '' for garbage. */
function _sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, maxLen);
}

/**
 * The `login` claim of a Twitch viewer JWT is base64-encoded (to preserve
 * case). Decode-first, then fall back to the raw string — and only accept
 * values that look like a Twitch login (letters, digits, underscore).
 * Returns '' when the token has no usable login (anonymous viewer).
 */
function _decodeLoginClaim(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';

  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded && /^[a-zA-Z0-9_]{1,25}$/.test(decoded)) return decoded.toLowerCase();
  } catch (_) { /* not base64 — try the raw string below */ }

  return /^[a-zA-Z0-9_]{1,25}$/.test(raw) ? raw.toLowerCase() : '';
}

// ── Feed activation + envelope building ─────────────────────────────────────

/**
 * A feed's own category gate: true when the channel is live AND (the feed
 * declared no games → any category, OR the current category matches).
 */
function _feedActive(feed) {
  if (!_gameName) return false;              // offline
  if (!feed.games) return true;              // no gate → live is enough
  return feed.games.includes(_gameName.toLowerCase());
}

/** Call a feed's snapshot() defensively. Returns its data, or null. */
function _safeSnapshot(feed, byteBudget) {
  try {
    const data = feed.snapshot({ byteBudget });
    return data === undefined ? null : data;
  } catch (err) {
    log.error(`[twitch-ext] Feed '${feed.id}' snapshot() threw:`, err.message);
    return null;
  }
}

/**
 * Build the full envelope served by /ext/state and carried on PubSub.
 *
 * @param {number|null} byteBudget — per-feed JSON byte budget feeds should
 *   trim themselves to (Twitch caps the whole PubSub message at 5 KB).
 *   Pass null for /ext/state, where size doesn't matter.
 */
function _buildEnvelope(byteBudget) {
  const feeds = {};
  let anyActive = false;

  for (const feed of _feeds.values()) {
    const active = _feedActive(feed);
    if (active) anyActive = true;
    feeds[feed.id] = {
      active,
      data: _safeSnapshot(feed, byteBudget),
    };
  }

  return {
    active: anyActive,
    category: _gameName,
    updatedAt: Date.now(),
    feeds,
  };
}

/**
 * Envelope as a JSON string that fits the 5 KB PubSub cap. Feeds are asked
 * to trim themselves to an even share of the budget; if a feed ignores its
 * budget the host defensively drops oversized feed data (largest first)
 * rather than breaking the broadcast for every other feed.
 */
function _buildEnvelopeJson() {
  const n     = Math.max(1, _feeds.size);
  const share = Math.max(500, Math.floor((MAX_SNAPSHOT_BYTES - ENVELOPE_OVERHEAD) / n));

  const envelope = _buildEnvelope(share);
  let json = JSON.stringify(envelope);

  while (Buffer.byteLength(json, 'utf8') > MAX_SNAPSHOT_BYTES) {
    // Largest feed data first; keep ids (they are tiny) so panels still
    // see the feed exists.
    let largest = null;
    for (const id of Object.keys(envelope.feeds)) {
      if (envelope.feeds[id].data == null) continue;
      const size = Buffer.byteLength(JSON.stringify(envelope.feeds[id].data), 'utf8');
      if (!largest || size > largest.size) largest = { id, size };
    }
    if (!largest) break; // nothing left to drop — accept the oversized send
    log.warn(
      `[twitch-ext] Feed '${largest.id}' exceeded its ${share} B snapshot budget — ` +
      'dropping its data from this broadcast (the feed should honour byteBudget)'
    );
    envelope.feeds[largest.id].data = null;
    json = JSON.stringify(envelope);
  }

  return json;
}

// ── PubSub broadcast (rate-limited, merged) ─────────────────────────────────

let _fetchFn = null;
async function _getFetch() {
  if (_fetchFn) return _fetchFn;
  if (typeof globalThis.fetch === 'function') {
    _fetchFn = globalThis.fetch;
    return _fetchFn;
  }
  // Same node-fetch fallback pattern other plugins use.
  const mod = await import('node-fetch');
  _fetchFn = mod.default || mod;
  return _fetchFn;
}

async function _sendPubsub(message) {
  const fetchFn = await _getFetch();
  const res = await fetchFn('https://api.twitch.tv/helix/extensions/pubsub', {
    method: 'POST',
    headers: {
      'Client-Id':     _clientId,
      'Authorization': 'Extension ' + _serverToken(),
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      broadcaster_id:     String(_broadcasterId),
      is_global_broadcast: true,
      target:             ['broadcast'],
      message,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from Helix pubsub: ${text.slice(0, 200)}`);
  }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Request a broadcast of the current state. Merges: at most 1 send / 1.1 s. */
function _broadcastSoon() {
  if (!_configured) { _dirty = false; return; }
  _dirty = true;
  if (!_draining) _drain().catch(() => { /* logged inside */ });
}

async function _drain() {
  _draining = true;
  try {
    while (_dirty) {
      _dirty = false;
      const message = _buildEnvelopeJson();
      try {
        const id = await _ensureBroadcasterId();
        if (!id) throw new Error('broadcaster id not resolved yet');
        await _sendPubsub(message);
      } catch (err) {
        // Log at most once a minute so a bad secret doesn't spam the log.
        if (Date.now() - _lastPubsubErrorAt > 60000) {
          _lastPubsubErrorAt = Date.now();
          log.error('[twitch-ext] PubSub broadcast failed:', err.message);
          if (/HTTP 40[13]/.test(err.message)) {
            log.error(
              '[twitch-ext]   ↳ check TWITCH_EXT_CLIENT_ID and TWITCH_EXT_SECRET. ' +
              'The secret must be copied from the console EXACTLY as-is (it is ' +
              'decoded from base64 here) — a hand-decoded or truncated secret is ' +
              'the most common cause of 401.'
            );
          }
        }
        break; // stop hammering a failing endpoint; panels self-heal via /ext/state
      }
      await _sleep(BROADCAST_SPACING_MS);
    }
  } finally {
    _draining = false;
  }
}

// ── Category tracking (stream-info events) ──────────────────────────────────

function _refreshActive() {
  const game = (streamInfo && typeof streamInfo.getActiveGame === 'function')
    ? streamInfo.getActiveGame()
    : null;
  const name   = (game && game.name) ? game.name : null;

  let anyActive = false;
  for (const feed of _feeds.values()) {
    if (feed.games ? (!!name && feed.games.includes(name.toLowerCase())) : !!name) {
      anyActive = true;
      break;
    }
  }

  if (anyActive === _active && name === _gameName) return; // nothing changed

  const becameActive = anyActive !== _active;
  _active   = anyActive;
  _gameName = name;

  if (becameActive) {
    log.info(anyActive
      ? `[twitch-ext] Extension host ACTIVE — streaming "${name}" (${_feeds.size} feed(s) registered). Panels now show live data.`
      : `[twitch-ext] Extension host inactive (category: ${name || 'offline'}). Panels show their static page.`
    );
  }
  _broadcastSoon(); // always push — open panels must learn about gate flips
}

// stream-info fires: live / offline / game-change / update (every 60 s poll).
// Listening to all four keeps the gate correct even if an event is missed.
if (streamInfo && typeof streamInfo.onStreamEvent === 'function') {
  streamInfo.onStreamEvent((ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'game-change' || ev.type === 'live' || ev.type === 'offline' || ev.type === 'update') {
      _refreshActive();
    }
  });
}

// ── HTTP route handlers ─────────────────────────────────────────────────────

function _handleHealth(req, res) {
  _applyCors(res);
  if (_isPreflight(req, res)) return;
  if (req.method !== 'GET') return _sendJson(res, 405, { ok: false, error: 'Method not allowed' });

  _sendJson(res, 200, {
    ok: _configured,
    active: _active,
    category: _gameName,
    broadcasterId: _broadcasterId || null, // which channel the EBS serves
    feeds: Array.from(_feeds.values(), f => ({ id: f.id, title: f.title, active: _feedActive(f) })),
    updatedAt: Date.now(),
  });
}

function _handleState(req, res) {
  _applyCors(res);
  if (_isPreflight(req, res)) return;
  if (req.method !== 'GET') return _sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  if (!_configured) {
    return _sendJson(res, 503, { ok: false, error: 'Twitch extension backend not configured (TWITCH_EXT_* env vars missing)' });
  }

  // Fast path (the normal case): the id is already resolved → answer
  // synchronously, keeping the addRoute contract. Only the rare startup /
  // failure window goes async, answering 503 until the lookup lands.
  if (!_broadcasterId) {
    _ensureBroadcasterId().then((id) => {
      if (!id) {
        return _sendJson(res, 503, { ok: false, error: 'Broadcaster id not resolved yet — retrying' });
      }
      _answerState(req, res);
    }).catch((err) => {
      log.error('[twitch-ext] /ext/state error:', err.message);
      if (!res.headersSent) _sendJson(res, 500, { ok: false, error: 'Internal error' });
      else if (!res.writableEnded) res.end();
    });
    return;
  }
  _answerState(req, res);
}

function _answerState(req, res) {
  const viewer = _authorize(req);
  if (!viewer) return _sendJson(res, 401, { ok: false, error: 'Invalid or missing viewer token' });

  _sendJson(res, 200, _buildEnvelope(null));
}

async function _handleSubmit(req, res) {
  _applyCors(res);
  if (_isPreflight(req, res)) return;
  if (req.method !== 'POST') return _sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  if (!_configured) {
    return _sendJson(res, 503, { ok: false, error: 'Twitch extension backend not configured (TWITCH_EXT_* env vars missing)' });
  }
  if (!_broadcasterId) {
    const id = await _ensureBroadcasterId();
    if (!id) {
      return _sendJson(res, 503, { ok: false, error: 'Broadcaster id not resolved yet — retrying' });
    }
  }
  const viewer = _authorize(req);
  if (!viewer) return _sendJson(res, 401, { ok: false, error: 'Invalid or missing viewer token' });
  if (!viewer.opaqueId) return _sendJson(res, 403, { ok: false, error: 'Not authorized to submit' });

  const body = await _readJsonBody(req);
  if (!body || typeof body !== 'object') {
    return _sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
  }

  // Route the action to the feed that registered its type. This is the
  // ONLY thing the host knows about the payload — validation, identity
  // handling and the response shape all belong to the feed.
  const type = _sanitizeText(body.type, 32);
  if (!type) return _sendJson(res, 400, { ok: false, error: 'Missing action type' });

  const feedId = _actionIndex.get(type);
  const feed   = feedId ? _feeds.get(feedId) : null;
  if (!feed || typeof feed.actions[type] !== 'function') {
    return _sendJson(res, 400, { ok: false, error: 'Unknown action type' });
  }

  // API hardening: no actions while the owning feed's category gate is
  // closed. (Front-ends hide their form anyway — this stops direct API
  // calls from bypassing a gate the streamer relies on.)
  if (!_feedActive(feed)) {
    return _sendJson(res, 409, { ok: false, error: 'The extension is not active right now' });
  }

  // Per-viewer, per-action cooldown — anti-abuse that applies to every
  // feed equally. Only successful actions burn the cooldown.
  const cooldownKey = viewer.opaqueId + '\u0000' + type;
  const last = _lastSubmitAt.get(cooldownKey) || 0;
  if (Date.now() - last < ACTION_COOLDOWN_MS) {
    const wait = Math.ceil((ACTION_COOLDOWN_MS - (Date.now() - last)) / 1000);
    return _sendJson(res, 429, { ok: false, error: `You just submitted — try again in ${wait}s` });
  }

  let result;
  try {
    result = await feed.actions[type](viewer, body);
  } catch (err) {
    log.error(`[twitch-ext] Feed '${feed.id}' action '${type}' threw:`, err.message);
    return _sendJson(res, 500, { ok: false, error: 'Action error — try again' });
  }

  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    log.error(`[twitch-ext] Feed '${feed.id}' action '${type}' returned a malformed result — ignoring`);
    return _sendJson(res, 500, { ok: false, error: 'Action error — try again' });
  }

  // A feed may flag a client error with status: 4xx; everything else is 200
  // (the front-end reads result.ok / result.error, not the HTTP code).
  const status = (typeof result.status === 'number' &&
                  Number.isInteger(result.status) &&
                  result.status >= 400 && result.status < 500)
    ? result.status : 200;

  if (result.ok === true) {
    _lastSubmitAt.set(cooldownKey, Date.now());
  }

  log.info(
    `[twitch-ext] Action '${type}' from ${viewer.login || 'anonymous viewer'} → ` +
    `feed '${feed.id}': ${result.ok ? 'ok' : `rejected (${result.error || 'no reason'})`}`
  );

  return _sendJson(res, status, result);
}

// addRoute handlers are sync signatures — _handleSubmit is async, so wrap it
// to guarantee a JSON 500 instead of a floating rejection.
addRoute('/ext/health', _handleHealth);
addRoute('/ext/state',  _handleState);
addRoute('/ext/submit', (req, res) => {
  _handleSubmit(req, res).catch((err) => {
    log.error('[twitch-ext] /ext/submit error:', err.message);
    if (!res.headersSent) _sendJson(res, 500, { ok: false, error: 'Internal error' });
    else if (!res.writableEnded) res.end();
  });
});

// ── Plugin lifecycle ────────────────────────────────────────────────────────

function init(context) {
  if (!_configured) return;

  // The bot's own Twitch module — handed to every plugin by the loader
  // (index.js → plugins.initPlugins({ twitch: twitchModule, … })).
  _twitchModule = (context && context.twitch) || null;

  _ensureBroadcasterId().then((id) => {
    if (id) {
      log.info(
        `[twitch-ext] EBS ready — client ${_clientId.slice(0, 8)}…, broadcaster ${id} ` +
        `(${_broadcasterIdOverride ? 'pinned via TWITCH_EXT_BROADCASTER_ID' : 'resolved via twitch.getBroadcasterId()'}), ` +
        `${_feeds.size} feed(s) registered`
      );
      log.info(
        '[twitch-ext] Routes: GET /ext/health · GET /ext/state · POST /ext/submit — ' +
        'expose them under your public HTTPS domain (the WEBSUB_PUBLIC_URL host).'
      );
    } else {
      log.warn(
        '[twitch-ext] Broadcaster id unresolved — /ext/* routes answer 503 and retry ' +
        'on each request. Check the bot\'s TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET / ' +
        'channel login, or pin TWITCH_EXT_BROADCASTER_ID in .env as a fallback.'
      );
    }
    _refreshActive();
  });
}

module.exports = {
  id: 'twitch-ext',
  init,

  // Plugin-facing API — any plugin registers its panel feed through these.
  registerFeed,
  publish,

  // Test/debug hooks (not used by the bot itself).
  _internals: {
    _buildEnvelope, _buildEnvelopeJson, _refreshActive, _feedActive,
    _ensureBroadcasterId, _authorize, _signHs256, _verifyHs256,
    _feeds, _actionIndex,
  },
};
