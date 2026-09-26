'use strict';
/**
 * Plugin: yt-points
 * ─────────────────
 * A channel-point-adjacent earn-and-spend system for YouTube chat exclusively.
 * Twitch already has native channel points; this plugin mirrors the streamer's
 * actual Twitch custom rewards so YouTube viewers can redeem the same things.
 *
 * ── How viewers earn points ───────────────────────────────────────────────────
 *   • +1  per chat message (passive accrual, rate-limited to 1 per 30 s)
 *   • +10 per 5 min since last message, awarded silently on next message (max +60)
 *
 * ── Chat commands (YouTube only) ─────────────────────────────────────────────
 *   !points              — Check your current balance
 *   !points top          — Show the top 5 viewers by points
 *   !redeem              — Show how to redeem (usage hint)
 *   !redeem <reward>     — Spend points on a registered reward
 *   !rewards             — Compact grouped shop overview (SFX collapsed)
 *   !rewards sfx [page]  — Browse one group (paginated to fit one chat line)
 *   !rewards <name>      — Full detail card for one reward (typos get hints)
 *
 * ── Twitch reward sync ────────────────────────────────────────────────────────
 *   Rewards are scraped from the Twitch Helix API on demand via:
 *     Discord slash command:  /sync-rewards
 *   Uses the twitch module's listRewards() public API (no Helix plumbing in
 *   this file). The broadcaster OAuth token in .twitch-tokens.json (written by
 *   twitch-auth.js) must carry channel:read:redemptions scope.
 *
 *   When a YouTube viewer redeems a Twitch-sourced reward:
 *     1. Confirmed in YouTube chat (see "Redeem announcements" below)
 *     2. Injected into the redeem pipeline via queue.pushRedeem() — appears in
 *        #redeem-feed exactly like a real Twitch redemption (tagged [YT]).
 *
 * ── Redeem announcements (YouTube chat UX) ───────────────────────────────────
 *   YouTube chat is the "redeem screen" viewers watch, so announcements are
 *   engineered to stay readable even when redeems are spammy:
 *
 *   • Every reward carries a group: 'sfx' (auto-detected via the sfx plugin's
 *     sound map — the majority of redeems on most streams) or 'general'.
 *   • SFX redeems are BATCHED: everything within YT_SFX_BATCH_MS (default 6 s,
 *     0 = off) collapses into ONE line, e.g.
 *         🔊 3 SFX: Vine Boom (alice) · Quack (bob) +1 more
 *   • Non-SFX redeems announce immediately (rare → worth the spotlight):
 *         ✅ alice redeemed Gacha Pull (5,000 pts) · 1,230 left
 *   • Every line is single-line and hard-capped at YouTube's 200-char limit —
 *     the blind mid-word chunking of old never happens by construction.
 *   • !rewards is grouped + paginated instead of one giant pipe-separated
 *     dump, and unknown reward names get "did you mean" suggestions.
 *
 * ── Public API (for other plugins) ───────────────────────────────────────────
 *   const pts = require('../yt-points');
 *
 *   pts.getPoints(username)                        → number
 *   pts.addPoints(username, amount, reason?)       → number  (new total)
 *   pts.deductPoints(username, amount)             → number | false  (false = insufficient)
 *   pts.setPoints(username, amount)                → void
 *
 *   pts.registerReward({ name, cost, description, handler, oncePerStream? })
 *     handler: async (username, chatReply) => boolean  (return true = success)
 *     oncePerStream: true = reward can only be redeemed once per stream session
 *   pts.removeReward(name)
 *   pts.getRewards()                               → reward[]
 *
 *   pts.syncTwitchRewards()                        → Promise<number>  (count synced)
 *     Rewards with max_per_stream_setting = 1 are automatically flagged oncePerStream.
 *
 *   pts.onStreamStart()  — call when stream goes live; resets once-per-stream redeems
 *   pts.onStreamEnd()    — call when stream ends; locks once-per-stream rewards
 *
 *   pts.onPointsChange(fn)   — subscribe: fn(username, newTotal, delta, reason)
 *   pts.offPointsChange(fn)  — unsubscribe
 *
 * ── Discord slash commands ────────────────────────────────────────────────────
 *   /sync-rewards                  — Scrape & import rewards from Twitch
 *   /yt-points inspect|set|give|take|top
 *   /yt-rewards list|add|remove
 *
 * ── Required env vars ─────────────────────────────────────────────────────────
 *   (None directly. Twitch reward sync uses the shared twitch module, which
 *    handles its own env vars. The broadcaster OAuth token must be in
 *    .twitch-tokens.json — run twitch-auth.js once with scope
 *    channel:read:redemptions to enable reward scraping.)
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const log  = require('../../logger');
const commandsList = require('../commands-list');
// Source of truth for which rewards are sounds. yt-points uses it to auto-tag
// SFX rewards so their chat announcements can be batched (see header).
const sfxPlugin = require('../sfx');

// ─── Constants ────────────────────────────────────────────────────────────────

const PASSIVE_COOLDOWN_MS  = 30  * 1000;      // 30 s between passive +1 awards
const CHECKIN_WINDOW_MS    = 5   * 60 * 1000; // each 5-min block since last msg = +20 pts
const CHECKIN_PTS_PER_TICK = 20;              // points per completed 5-min window
const CHECKIN_MAX_PTS      = 120;              // cap: max bonus per message

const CMD_POINTS      = /^!points(?:\s+(top))?\s*$/i;
const CMD_REDEEM      = /^!redeem\s+(.+)$/i;
const CMD_REDEEM_BARE = /^!redeem\s*$/i;
const CMD_REWARDS     = /^!(rewards|shop)(?:\s+(.+))?$/i;

const POINTS_FILE = path.resolve('.yt-points.json');

/**
 * Window (ms) during which SFX redeem announcements are collected into a
 * single chat message. SFX are the bulk of redeems — without batching every
 * vine-boom would be its own chat line. 0 disables batching (not recommended).
 * Env: YT_SFX_BATCH_MS (clamped to 0–30000, default 6000).
 */
const _rawBatchMs = parseInt(process.env.YT_SFX_BATCH_MS ?? '6000', 10);
const SFX_BATCH_MS = Number.isFinite(_rawBatchMs) && _rawBatchMs >= 0
  ? Math.min(_rawBatchMs, 30000)
  : 6000;

// ─── Plugin context (set in init) ────────────────────────────────────────────
//
// We require the twitch + queue modules via the init(context) interface
// rather than reaching into them directly. This is the documented way for
// plugins to access shared main-module functionality. The previous version
// reimplemented ~150 lines of Helix token + reward-list plumbing inline;
// those have all been replaced by calls to twitch.listRewards() and
// twitch.getBroadcasterId().

let _twitch = null;
let _queue  = null;

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, number>} username → point balance */
const _balances = new Map();
/** @type {Map<string, number>} username → last passive-award timestamp */
const _passiveCooldowns = new Map();
/** @type {Map<string, number>} username → timestamp of their last chat message (for check-in bonus) */
const _lastMessageTime = new Map();

/**
 * @typedef  {Object} Reward
 * @property {string}   name
 * @property {string}   [displayTitle]  Pretty title shown in chat (defaults to name)
 * @property {number}   cost
 * @property {string}   description
 * @property {string}   [group]         Logical group — 'sfx' | 'general' | custom
 * @property {boolean}  fromTwitch    true if scraped from Twitch
 * @property {string}   [twitchId]      Twitch reward ID
 * @property {boolean}  [oncePerStream] true = can only be redeemed once per stream session
 * @property {(username: string, chatReply: Function, ctx?: {videoId?: string}) => Promise<boolean>} handler
 */
/** @type {Map<string, Reward>} */
const _rewards = new Map();

/** @type {Array<Function>} */
const _changeListeners = [];

/**
 * Per-reward cooldown tracking for !redeem.
 * Maps reward key → timestamp of last successful redemption (ms).
 * Cooldown duration comes from the reward's own cooldownSeconds field.
 */
const _redeemCooldowns = new Map();

/**
 * Once-per-stream tracking.
 * _streamActive: true while a stream session is live (set via onStreamStart/onStreamEnd).
 * _redeemedThisStream: set of reward keys already redeemed during the current session.
 */
let _streamActive = false;
const _redeemedThisStream = new Set();

let _chatReply = { twitch: null, youtube: null };
// _queue is declared above (with _twitch) — captured from init(context).

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _applyDelta(username, delta, reason = 'unspecified') {
  const current = _balances.get(username) ?? 0;
  const next    = Math.max(0, current + delta);
  _balances.set(username, next);
  if (delta !== 0) {
    log.debug(`[yt-points] ${username}: ${current} → ${next} (${delta > 0 ? '+' : ''}${delta}, ${reason})`);
    _scheduleSave();
    for (const fn of _changeListeners) {
      try { fn(username, next, delta, reason); } catch { /* listener errors must not crash */ }
    }
  }
  return next;
}

function _leaderboardText(limit = 5) {
  const sorted = [..._balances.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (!sorted.length) return 'No points awarded yet!';
  return sorted.map(([name, pts], i) => `#${i + 1} ${name} (${_fmtNum(pts)})`).join(' | ');
}

// ─── Chat formatting helpers ─────────────────────────────────────────────────
//
// YouTube live chat is the "redeem screen" viewers watch. Everything shown to
// chatters goes through these helpers so it stays single-line, under the
// 200-char API cap, and visually consistent.

const YT_MSG_MAX = 200;   // hard YouTube liveChatMessages.insert cap
const SEP        = ' · '; // visual separator used across shop/announcement lines

/** Emoji prefix per reward group in chat lines. */
const GROUP_ICONS = { sfx: '\u{1F50A}', general: '\u2705' };
function _groupIcon(group) { return GROUP_ICONS[group] ?? '\u{1F4E6}'; }

/** 1234 → "1,234" — thousands separators keep balances scannable in chat. */
function _fmtNum(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/** 90 → "1m 30s" — cooldown remaining in chat-friendly form. */
function _fmtCooldown(seconds) {
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m > 0 ? (s ? `${m}m ${s}s` : `${m}m`) : `${s}s`;
}

/** Slice without splitting surrogate pairs (emoji) at the boundary. */
function _safeSlice(str, max) {
  return String(str).slice(0, max).replace(/[\uD800-\uDFFF]$/, '');
}

/**
 * The single choke point for every chat reply: collapses whitespace (YouTube
 * strips newlines anyway), trims, and hard-caps at 200 chars. Errors are
 * logged here so call sites never need .catch() noise.
 */
function _sendLine(send, text) {
  if (typeof send !== 'function') return;
  const line = _safeSlice(String(text).replace(/\s+/g, ' ').trim(), YT_MSG_MAX);
  if (!line) return;
  Promise.resolve()
    .then(() => send(line))
    .catch(e => log.error('[yt-points] send error:', e.message));
}

/** Send several pre-composed lines (each already sized to fit). */
function _sendPacked(send, lines) {
  for (const line of lines) _sendLine(send, line);
}

/** Classic DP edit distance — inputs are short reward names only. */
function _levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,                                    // deletion
        cur[j - 1] + 1,                                 // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),  // substitution
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Typo rescue: closest registered reward to a user-typed name. Compares
 * against both the hyphenated key ("vine-boom") and the display title
 * ("Vine Boom") so "!redeem vine boom" and "!redeem vineboom" both hit.
 * @param {string} typed  raw user input
 * @returns {Reward|null}
 */
function _suggestReward(typed) {
  const norm = String(typed ?? '').toLowerCase().trim().replace(/\s+/g, '-');
  if (!norm || _rewards.has(norm)) return _rewards.get(norm) ?? null;

  let best = null, bestDist = Infinity;
  for (const r of _rewards.values()) {
    const titleKey = r.displayTitle.toLowerCase().replace(/\s+/g, '-');
    for (const candidate of new Set([r.name, titleKey])) {
      const d = _levenshtein(norm, candidate);
      if (d < bestDist) { bestDist = d; best = r; }
    }
  }
  // Tolerate ~1 typo per 4 characters (min 2) — beyond that it's a guess.
  const threshold = Math.max(2, Math.floor(norm.length / 4));
  return bestDist <= threshold ? best : null;
}

// ─── Redeem announcements (SFX batching) ─────────────────────────────────────
//
// SFX redeems dominate most streams — announcing each one separately turns
// YouTube chat into a wall of "✅ user redeemed X!". Instead, SFX announcements
// are collected per-stream for SFX_BATCH_MS and flushed as ONE compact line:
//   🔊 3 SFX: Vine Boom (alice), Quack (bob) +2 more
//   🔊 3 SFX by alice: Vine Boom, Quack, Metal Pipe
// Non-SFX redeems stay individual — they're rare and worth the spotlight:
//   ✅ alice redeemed Gacha Pull (5,000 pts) · 1,230 left

/** Per-video batch state: videoId → { items, send, timer } */
const _sfxBatches = new Map();

/**
 * Queue one redeem announcement. SFX goes through the per-video batch,
 * everything else sends immediately.
 * @param {object} p
 * @param {Function|null} p.send       per-session chat sender (may be null)
 * @param {string|undefined} p.videoId
 * @param {string} p.username
 * @param {{group: string, displayTitle: string, cost: number}} p.reward
 */
function _announceRedeem({ send, videoId, username, reward }) {
  if (typeof send !== 'function') return;
  const group = reward?.group ?? 'general';

  if (group !== 'sfx' || SFX_BATCH_MS <= 0) {
    _sendLine(send, _singleRedeemLine(username, reward));
    return;
  }

  const batchKey = videoId ?? '_default';
  let batch = _sfxBatches.get(batchKey);
  if (!batch) {
    batch = { items: [], send, timer: null };
    _sfxBatches.set(batchKey, batch);
  }
  batch.items.push({ username, reward });

  // Safety valve: absurd bursts flush early instead of growing unbounded.
  if (batch.items.length >= 20) { _flushSfxBatch(batchKey); return; }

  if (!batch.timer) {
    const t = setTimeout(() => _flushSfxBatch(batchKey), SFX_BATCH_MS);
    if (typeof t.unref === 'function') t.unref(); // never hold the process open
    batch.timer = t;
  }
}

/**
 * Single-redeem line. Balance is read at send time (the !redeem message
 * itself may have just earned passive points, so this stays accurate).
 */
function _singleRedeemLine(username, reward) {
  const balance = _fmtNum(getPoints(username));
  if ((reward?.group ?? 'general') === 'sfx') {
    return `🔊 ${username} played ${reward.displayTitle} · ${balance} pts left`;
  }
  return `✅ ${username} redeemed ${reward.displayTitle} (${_fmtNum(reward.cost)} pts) · ${balance} left`;
}

/**
 * Collapse every buffered SFX redeem for one stream into a single chat line,
 * greedily packed to stay inside YouTube's 200-char cap (overflow → "+N more").
 */
function _flushSfxBatch(batchKey) {
  const batch = _sfxBatches.get(batchKey);
  if (!batch) return;
  _sfxBatches.delete(batchKey);
  if (batch.timer) { clearTimeout(batch.timer); batch.timer = null; }
  if (!batch.items.length) return;

  const count    = batch.items.length;
  const sameUser = batch.items.every(i => i.username === batch.items[0].username);

  let line;
  if (count === 1) {
    line = _singleRedeemLine(batch.items[0].username, batch.items[0].reward);
  } else {
    const prefix = sameUser
      ? `🔊 ${count} SFX by ${batch.items[0].username}: `
      : `🔊 ${count} SFX: `;
    const parts = batch.items.map(i => sameUser
      ? i.reward.displayTitle
      : `${i.reward.displayTitle} (${i.username})`);

    const RESERVE = 12; // room for " +99 more"
    let body = '';
    let shown = 0;
    for (const part of parts) {
      const candidate = body ? `${body}, ${part}` : part;
      if ((prefix + candidate).length > YT_MSG_MAX - RESERVE) break;
      body = candidate;
      shown++;
    }
    line = prefix + body + (shown < count ? ` +${count - shown} more` : '');
  }

  _sendLine(batch.send, line);
}

// ─── !rewards rendering (grouped + paginated shop) ────────────────────────────
//
// The old one-line pipe-separated dump (name + cost + FULL description per
// reward) blew way past YouTube's 200-char cap and got blind-split into a
// wall-of-text. The shop is now grouped:
//   !rewards            → compact overview, SFX collapsed to one entry
//   !rewards sfx [page] → one group, paginated to exactly fit one chat line
//   !rewards <name>     → detail card for a single reward

const REWARDS_HINT = 'browse: !rewards sfx · details: !rewards <name>';

/** All rewards grouped by their group field, cost-sorted within each group. */
function _groupedRewards() {
  const groups = new Map();
  for (const r of getRewards()) { // getRewards() sorts by cost
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  return groups;
}

/**
 * Greedily pack list entries into the fewest ≤200-char single-line messages.
 * Continuation messages repeat the prefix so each line keeps its context.
 */
function _packEntries(entries, prefix = '') {
  const lines = [];
  let line = prefix;
  for (const entry of entries) {
    const candidate = (line === prefix) ? prefix + entry : line + SEP + entry;
    if (candidate.length > YT_MSG_MAX && line !== prefix) {
      lines.push(line);
      line = prefix + entry;
    } else {
      line = candidate;
    }
    if (line.length > YT_MSG_MAX) line = _safeSlice(line, YT_MSG_MAX);
  }
  lines.push(line);
  return lines;
}

/**
 * Split name entries across pages whose rendered line (prefix + body + page
 * hint) always fits one chat message. Slightly conservative on the last page
 * — that's fine, correctness beats squeezing 3 extra characters into chat.
 * @returns {string[]} page bodies
 */
function _paginate(entries, prefix, sep, reserve = 0) {
  const pages = [];
  let body = '';
  for (const entry of entries) {
    const candidate = body ? body + sep + entry : entry;
    if (prefix.length + candidate.length + reserve > YT_MSG_MAX && body) {
      pages.push(body);
      body = entry;
    } else {
      body = candidate;
    }
  }
  if (body) pages.push(body);
  return pages;
}

/**
 * Compact shop overview. Non-general groups collapse to one entry each:
 *   🎁 Rewards: gacha-pull 5,000 · 🔊 sfx ×15 (50 ea) → !rewards sfx
 */
function _overviewLines() {
  const groups  = _groupedRewards();
  const entries = [];

  for (const [group, items] of groups) {
    if (group === 'general') {
      for (const r of items) entries.push(`${r.name} ${_fmtNum(r.cost)}`);
      continue;
    }
    const uniform = items.every(r => r.cost === items[0].cost);
    const label = `${_groupIcon(group)} ${group} ×${items.length}` +
      (uniform ? ` (${_fmtNum(items[0].cost)} ea)` : ' (costs vary)');
    entries.push(`${label} → !rewards ${group}`);
  }

  if (!entries.length) return [];
  return _packEntries(entries, '🎁 Rewards: ');
}

/**
 * One group listing, e.g. "!rewards sfx 2" — paginated to fit a single line.
 * When every reward in the group costs the same, the header carries the price
 * and items are listed name-only (the common case for SFX — much cleaner).
 */
function _groupLines(group, items, page) {
  const uniform = items.every(r => r.cost === items[0].cost);
  const header = `${_groupIcon(group)} ${group}` +
    (uniform ? ` · ${_fmtNum(items[0].cost)} pts each` : ' · costs vary');
  const names = items.map(r => uniform ? r.name : `${r.name} ${_fmtNum(r.cost)}`);

  const RESERVE = 34; // room for " (2/5) — … (!rewards sfx 3 for more)"
  const bodies  = _paginate(names, header + ' — ', ', ', RESERVE);
  const total   = bodies.length;

  if (total === 1) return [`${header} — ${bodies[0]}`];

  const idx = Math.min(Math.max(page ?? 1, 1), total);
  let line = `${header} (${idx}/${total}) — ${bodies[idx - 1]}`;
  if (idx < total) line += ` (!rewards ${group} ${idx + 1} for more)`;
  return [_safeSlice(line, YT_MSG_MAX)];
}

/**
 * One-reward detail card (single line), e.g.
 *   🎁 gacha-pull · 5,000 pts · once/stream — "Spawn a gacha pull on stream!"
 * Description is trimmed to whatever room the metadata leaves.
 */
function _detailLine(reward) {
  const bits = [`🎁 ${reward.name}`, `${_fmtNum(reward.cost)} pts`];
  if (reward.group && reward.group !== 'general') {
    bits.push(`${_groupIcon(reward.group)} ${reward.group}`);
  }
  if (reward.oncePerStream)       bits.push('once/stream');
  if (reward.cooldownSeconds > 0) bits.push(`${_fmtCooldown(reward.cooldownSeconds)} cooldown`);

  const prefix = bits.join(SEP);
  if (!reward.description) return _safeSlice(prefix, YT_MSG_MAX);

  const room = YT_MSG_MAX - prefix.length - ' — '.length;
  const desc = room <= 0 ? '' : _safeSlice(reward.description, room - 1) + (reward.description.length > room - 1 ? '…' : '');
  return desc ? `${prefix} — ${desc}` : prefix;
}

/**
 * Entry point for "!rewards [query]".
 * @param {Function|null} send
 * @param {string} arg  everything after "!rewards" (may be '')
 */
function _handleRewardsCommand(send, arg) {
  if (!send) return;
  if (!getRewards().length) {
    _sendLine(send, '🎁 No rewards yet — check back soon!');
    return;
  }

  const raw    = String(arg ?? '').trim().toLowerCase();
  if (!raw) { _sendPacked(send, _overviewLines()); return; }

  // "!rewards sfx 2" → group 'sfx', page 2 (group names are hyphenated keys)
  const tokens = raw.split(/\s+/);
  let page = null;
  if (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) {
    page = parseInt(tokens.pop(), 10);
  }
  const query = tokens.join('-');

  const groups = _groupedRewards();
  if (groups.has(query)) {
    _sendPacked(send, _groupLines(query, groups.get(query), page));
    return;
  }

  // Exact reward, then typo rescue — showing the detail card IS the suggestion.
  const reward = _rewards.get(query) ?? _suggestReward(raw);
  if (reward) { _sendLine(send, _detailLine(reward)); return; }

  _sendLine(send, `❌ No reward or group called "${_safeSlice(raw, 40)}". ${REWARDS_HINT}`);
}

// ─── Persistence ─────────────────────────────────────────────────────────────

let _saveTimer = null;

/** Persist balances to disk (debounced — batches rapid changes). */
function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const data = Object.fromEntries(_balances);
      fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error('[yt-points] Failed to save points:', err.message);
    }
  }, 2000); // write at most once every 2 s
}

/** Load balances from disk on startup. */
function _loadPoints() {
  if (!fs.existsSync(POINTS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
    for (const [username, pts] of Object.entries(data)) {
      if (typeof pts === 'number' && pts >= 0) _balances.set(username, pts);
    }
    log.info(`[yt-points] Loaded ${_balances.size} balance(s) from ${POINTS_FILE}`);
  } catch (err) {
    log.warn('[yt-points] Could not read points file:', err.message);
  }
}

// ─── Twitch reward sync ───────────────────────────────────────────────────────

/**
 * Fetch all enabled custom rewards from the broadcaster's Twitch channel and
 * register them as yt-points rewards. Previously-synced Twitch rewards are
 * cleared first so stale entries don't accumulate.
 *
 * When a YouTube viewer redeems a synced reward the handler:
 *   1. Announces the redemption in YouTube chat ("✅ user redeemed X!")
 *   2. Calls queue.pushRedeem() so it appears in #redeem-feed like a real
 *      Twitch redemption, with "[YT]" appended to the title.
 *
 * Uses twitch.listRewards() from the main twitch module (exposed via
 * init(context)) — no Helix token plumbing reimplemented locally.
 *
 * @returns {Promise<number>} number of rewards synced
 */
async function syncTwitchRewards() {
  if (!_twitch) {
    throw new Error('twitch module not in init context — cannot sync rewards');
  }

  let twitchRewards;
  try {
    twitchRewards = await _twitch.listRewards({ force: true });
  } catch (err) {
    if (err.message.includes('401') || err.message.includes('403')) {
      throw new Error(
        'Twitch returned an auth error fetching rewards. ' +
        'Ensure the broadcaster has granted channel:read:redemptions — run: node twitch-auth.js'
      );
    }
    throw err;
  }

  // Clear previously-synced Twitch rewards before importing fresh ones
  for (const [key, reward] of _rewards) {
    if (reward.fromTwitch) _rewards.delete(key);
  }

  let synced = 0;
  for (const r of twitchRewards) {
    if (!r.is_enabled) continue;

    const key             = r.title.toLowerCase().trim().replace(/\s+/g, '-');
    const cost            = r.cost;
    const description     = r.prompt?.trim() || r.title;
    const twitchId        = r.id;
    const rewardTitle     = r.title; // captured for the closure below
    const isSfx           = sfxPlugin.isSfxTitle(rewardTitle); // auto-group SFX
    const rewardGroup     = isSfx ? 'sfx' : 'general';
    const cooldownSeconds = r.global_cooldown_setting?.is_enabled
      ? (r.global_cooldown_setting.global_cooldown_seconds ?? 0)
      : 0;
    const oncePerStream   = r.max_per_stream_setting?.is_enabled
      && (r.max_per_stream_setting.max_per_stream ?? 0) === 1;

    registerReward({
      name:        key,
      cost,
      description,
      fromTwitch:  true,
      twitchId,
      cooldownSeconds,
      oncePerStream,
      group:       rewardGroup,
      displayTitle: rewardTitle,
      handler: async (username, chatReply, ctx = {}) => {
        // 1. Announce in YouTube chat. SFX redeems are batched into one line
        //    per YT_SFX_BATCH_MS window (see "Redeem announcements" header);
        //    everything else announces immediately. The reward shape passed
        //    here mirrors what registerReward stored — it is read by the
        //    announcement formatter.
        _announceRedeem({
          send:    chatReply,
          videoId: ctx.videoId,
          username,
          reward:  { group: rewardGroup, displayTitle: rewardTitle, cost },
        });

        // 2. Inject into the redeem pipeline → shows in #redeem-feed
        if (_queue?.pushRedeem) {
          _queue.pushRedeem({
            username,
            title:     `${rewardTitle} [YT]`,
            cost,
            input:     null,
            timestamp: new Date(),
          });
          log.info(
            `[yt-points] Injected redeem into pipeline: ` +
            `${username} → "${rewardTitle}" (${cost} pts)`
          );
        } else {
          log.warn('[yt-points] queue.pushRedeem not available — redeem not mirrored to Discord');
        }

        return true;
      },
    });

    log.info(`[yt-points] Synced Twitch reward: "${rewardTitle}" (${cost} pts)`);
    synced++;
  }

  log.info(`[yt-points] Sync complete — ${synced} reward(s) imported from Twitch.`);
  return synced;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Get current point balance for a viewer (0 if unseen). */
function getPoints(username) {
  return _balances.get(username.toLowerCase()) ?? 0;
}

/** Add points; returns new total. */
function addPoints(username, amount, reason = 'external') {
  return _applyDelta(username.toLowerCase(), Math.abs(amount), reason);
}

/**
 * Deduct points; returns new total or false if the viewer can't afford it.
 * @returns {number|false}
 */
function deductPoints(username, amount) {
  const lc      = username.toLowerCase();
  const current = _balances.get(lc) ?? 0;
  if (current < amount) return false;
  return _applyDelta(lc, -Math.abs(amount), 'spend');
}

/** Force-set a viewer's balance (mod action). */
function setPoints(username, amount) {
  const lc  = username.toLowerCase();
  const cur = _balances.get(lc) ?? 0;
  _applyDelta(lc, amount - cur, 'mod-set');
}

/**
 * Register a redeemable reward.
 * @param {Reward} reward
 */
function registerReward({ name, cost, description, handler, fromTwitch = false, twitchId = null, cooldownSeconds = 0, oncePerStream = false, group = null, displayTitle = null }) {
  if (!name || !cost || !description || typeof handler !== 'function') {
    log.warn('[yt-points] registerReward: missing required field(s)');
    return;
  }
  const key = name.toLowerCase().trim();
  const resolvedGroup = String(group ?? 'general').toLowerCase().trim() || 'general';
  _rewards.set(key, {
    name: key,
    displayTitle: _safeSlice(String(displayTitle ?? name).trim(), 60),
    cost, description, handler,
    fromTwitch, twitchId, cooldownSeconds, oncePerStream,
    group: resolvedGroup,
  });
  log.info(`[yt-points] Reward registered: ${key} (${cost} pts)${fromTwitch ? ' [Twitch]' : ''}${oncePerStream ? ' [once-per-stream]' : ''}${resolvedGroup !== 'general' ? ` [${resolvedGroup}]` : ''}`);
}

/** Remove a reward by name. */
function removeReward(name) {
  const key = name.toLowerCase().trim();
  if (_rewards.delete(key)) log.info(`[yt-points] Reward removed: ${key}`);
}

/** Returns all rewards sorted by cost. */
function getRewards() {
  return [..._rewards.values()].sort((a, b) => a.cost - b.cost);
}

/** Subscribe to any point balance change. */
function onPointsChange(fn) {
  _changeListeners.push(fn);
}

/** Unsubscribe from point balance changes. */
function offPointsChange(fn) {
  const idx = _changeListeners.indexOf(fn);
  if (idx !== -1) _changeListeners.splice(idx, 1);
}

// ─── Stream lifecycle ─────────────────────────────────────────────────────────

/**
 * Call when a stream session goes live.
 * Resets all once-per-stream redemption records so those rewards are
 * available again for the new session.
 */
function onStreamStart() {
  _streamActive = true;
  _redeemedThisStream.clear();
  log.info('[yt-points] Stream started — once-per-stream redemptions reset.');
}

/**
 * Call when a stream session ends.
 * Marks the session as inactive; once-per-stream rewards stay locked until
 * the next onStreamStart() call (so late redeems after go-offline are blocked).
 */
function onStreamEnd() {
  _streamActive = false;
  log.info('[yt-points] Stream ended — once-per-stream rewards are now locked until next stream.');
}

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────

function init(context) {
  // Load persisted balances before anything else
  _loadPoints();

  // Capture twitch + queue from the documented init(context) interface.
  // Previously this plugin reached into '../../queue' directly and
  // reimplemented Helix token plumbing inline — both are now gone.
  _twitch = context.twitch ?? null;
  _queue  = context.queue  ?? null;

  if (!_queue) {
    log.warn('[yt-points] queue not in init context — pushRedeem will be unavailable.');
  }
  if (!_twitch) {
    log.warn('[yt-points] twitch not in init context — Twitch reward sync disabled.');
    return;
  }

  // Auto-sync Twitch rewards on startup. The twitch module handles all the
  // token / broadcaster-id resolution; we just consume the reward list.
  syncTwitchRewards()
    .then(count => log.info(`[yt-points] Auto-synced ${count} Twitch reward(s) on startup.`))
    .catch(err  => log.warn('[yt-points] Auto-sync failed:', err.message));
}

// yt-points/index.js  —  onChatReady patch
// Replace your existing onChatReady function with this:

function onChatReady(chatReply) {
  _chatReply = chatReply;

  commandsList.registerCommand('!points',  'Check your YouTube point balance (or !points top for leaderboard)', 'youtube');
  commandsList.registerCommand('!redeem',  'Redeem a reward — !redeem <name> · !rewards to browse', 'youtube');
  commandsList.registerCommand('!rewards', 'Browse rewards — !rewards overview · !rewards sfx · !rewards <name> for details', 'youtube');

  log.info('[yt-points] Ready. Chat commands registered.');
}

// ─── processMessage ───────────────────────────────────────────────────────────

async function processMessage(msg) {
  // YouTube only — Twitch has native channel points
  if (msg.platform !== 'youtube') return { message: msg };

  const username = (msg.username ?? msg.author ?? 'unknown').toLowerCase();
  const text     = (msg.message ?? '').trim();
  const videoId  = msg.videoId;
  // Use the documented per-session chat reply contract:
  //   chatReply.youtubeSession(videoId, text)
  // Falls back to no-op (with a warning) if the message doesn't carry a
  // videoId or the contract isn't wired up yet.
  const sessionSend = (videoId && _chatReply.youtubeSession)
    ? (replyText) => _chatReply.youtubeSession(videoId, replyText)
    : null;
  const send = sessionSend ?? (() => {
    log.warn(`[yt-points] No videoId on message — skipping reply to avoid broadcasting to all chats. username=${username}`);
    return Promise.resolve();
  });
  const now      = Date.now();

  // ── Passive earn (1 pt per message, cooldown-gated) ──────────────────────
  const lastPassive = _passiveCooldowns.get(username) ?? 0;
  if (now - lastPassive >= PASSIVE_COOLDOWN_MS) {
    _passiveCooldowns.set(username, now);
    _applyDelta(username, 1, 'passive');
  }

  // ── Watch-time bonus (10 pts per 5 min since last message, max 60) ────────
  // Mimics Twitch channel-point accrual: the longer a viewer was away, the
  // more points their next message earns (silently, no chat announcement).
  const prevMessageTime = _lastMessageTime.get(username);
  _lastMessageTime.set(username, now);
  if (prevMessageTime != null) {
    const elapsedMs = now - prevMessageTime;
    const ticks     = Math.floor(elapsedMs / CHECKIN_WINDOW_MS);
    if (ticks >= 1) {
      const bonus = Math.min(ticks * CHECKIN_PTS_PER_TICK, CHECKIN_MAX_PTS);
      _applyDelta(username, bonus, 'watchtime-bonus');
    }
  }

  // ── !points / !points top ─────────────────────────────────────────────────
  const pointsMatch = CMD_POINTS.exec(text);
  if (pointsMatch) {
    if (pointsMatch[1]?.toLowerCase() === 'top') {
      if (send) _sendLine(send, '🏆 Top viewers: ' + _leaderboardText(5));
    } else {
      const total = getPoints(username);
      if (send) _sendLine(send, `⭐ ${username}: ${_fmtNum(total)} pts`);
    }
    return { message: null };
  }

  // ── !rewards [group | page | name] ──────────────────────────────────
  const rewardsMatch = CMD_REWARDS.exec(text);
  if (rewardsMatch) {
    _handleRewardsCommand(send, rewardsMatch[2] ?? '');
    return { message: null };
  }

  // ── !redeem (no arguments) → usage hint ─────────────────────────────
  // Previously bare "!redeem" matched nothing, fell through, and never got a
  // reply — confusing for first-time users. Teach the command instead.
  if (CMD_REDEEM_BARE.test(text)) {
    if (send) _sendLine(send, `🎁 Usage: !redeem <name> — ${REWARDS_HINT}`);
    return { message: null };
  }

  const redeemMatch = CMD_REDEEM.exec(text);
  if (redeemMatch) {
    // Normalise the typed name the same way registerReward does
    const rewardKey = redeemMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
    const reward    = _rewards.get(rewardKey);

    if (!reward) {
      // Typo rescue: point at the closest real reward instead of a dead end.
      const suggestion = _suggestReward(redeemMatch[1]);
      const tip = suggestion ? ` Did you mean "${suggestion.name}"?` : '';
      if (send) _sendLine(send,
        `❌ Unknown reward "${_safeSlice(redeemMatch[1].trim(), 40)}".${tip} !rewards to browse`);
      return { message: null };
    }

    const balance = getPoints(username);
    if (balance < reward.cost) {
      const short = reward.cost - balance;
      if (send) _sendLine(send,
        `❌ ${username}: ${reward.displayTitle} costs ${_fmtNum(reward.cost)} pts · ` +
        `you have ${_fmtNum(balance)} (${_fmtNum(short)} short)`);
      return { message: null };
    }

    // ── Per-reward cooldown (mirrors Twitch global_cooldown_setting) ──────────
    if (reward.cooldownSeconds > 0) {
      const lastRedeem    = _redeemCooldowns.get(rewardKey) ?? 0;
      const elapsedMs     = now - lastRedeem;
      const cooldownMs    = reward.cooldownSeconds * 1000;
      if (elapsedMs < cooldownMs) {
        const remainingSecs = Math.ceil((cooldownMs - elapsedMs) / 1000);
        if (send) _sendLine(send,
          `⏳ "${reward.displayTitle}" is on cooldown — ${_fmtCooldown(remainingSecs)} left.`);
        return { message: null };
      }
    }

    // ── Once-per-stream gate ──────────────────────────────────────────────────
    if (reward.oncePerStream) {
      // YouTube chat messages can only arrive during a live stream, so if we
      // receive a message the stream must be live.  Auto-activate the session
      // the first time a YT message arrives so once-per-stream rewards work
      // without requiring an explicit onStreamStart() call.
      if (!_streamActive) {
        log.info('[yt-points] Auto-activating stream session on first YouTube message.');
        onStreamStart();
      }
      if (_redeemedThisStream.has(rewardKey)) {
        if (send) _sendLine(send,
          `❌ "${reward.displayTitle}" was already redeemed this stream (once-per-stream reward).`);
        return { message: null };
      }
    }

    // Deduct first — handler is responsible for returning false to trigger refund
    deductPoints(username, reward.cost);

    let success = false;
    try {
      // 3rd arg gives handlers stream context (per-video announcement batching:
      // videoId → which chat the SFX batch flushes to).
      success = await reward.handler(username, send, { videoId });
    } catch (e) {
      log.error(`[yt-points] reward handler error (${rewardKey}):`, e.message);
    }

    if (!success) {
      addPoints(username, reward.cost, 'redeem-refund');
      if (send) _sendLine(send,
        `⚠️ ${username}: "${reward.displayTitle}" couldn't be fulfilled right now. Points refunded.`);
    } else {
      if (reward.cooldownSeconds > 0) _redeemCooldowns.set(rewardKey, now);
      if (reward.oncePerStream)       _redeemedThisStream.add(rewardKey);
    }

    return { message: null };
  }

  return { message: msg };
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const commandSyncRewards = new SlashCommandBuilder()
  .setName('sync-rewards')
  .setDescription('Scrape enabled custom rewards from Twitch and import them into the YouTube points system')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

const commandYtPoints = new SlashCommandBuilder()
  .setName('yt-points')
  .setDescription('Manage the YouTube viewer points system')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('inspect')
      .setDescription("Check a viewer's point balance")
      .addStringOption(o =>
        o.setName('username').setDescription('YouTube username').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('set')
      .setDescription("Force-set a viewer's balance")
      .addStringOption(o =>
        o.setName('username').setDescription('YouTube username').setRequired(true))
      .addIntegerOption(o =>
        o.setName('amount').setDescription('New balance').setRequired(true).setMinValue(0)))
  .addSubcommand(sub =>
    sub.setName('give')
      .setDescription('Give points to a viewer')
      .addStringOption(o =>
        o.setName('username').setDescription('YouTube username').setRequired(true))
      .addIntegerOption(o =>
        o.setName('amount').setDescription('Points to give').setRequired(true).setMinValue(1)))
  .addSubcommand(sub =>
    sub.setName('take')
      .setDescription("Remove points from a viewer's balance")
      .addStringOption(o =>
        o.setName('username').setDescription('YouTube username').setRequired(true))
      .addIntegerOption(o =>
        o.setName('amount').setDescription('Points to remove').setRequired(true).setMinValue(1)))
  .addSubcommand(sub =>
    sub.setName('top')
      .setDescription('Show the full points leaderboard')
      .addIntegerOption(o =>
        o.setName('limit').setDescription('How many to show (default 10)').setMinValue(1).setMaxValue(50)));

const commandYtRewards = new SlashCommandBuilder()
  .setName('yt-rewards')
  .setDescription('Manage redeemable rewards for the YouTube points system')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('List all registered rewards (🟣 = synced from Twitch)'))
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Manually add a reward (use /sync-rewards to import from Twitch)')
      .addStringOption(o =>
        o.setName('name').setDescription('Reward key, no spaces — use hyphens').setRequired(true))
      .addIntegerOption(o =>
        o.setName('cost').setDescription('Point cost').setRequired(true).setMinValue(1))
      .addStringOption(o =>
        o.setName('description').setDescription('Short description shown in !rewards').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Remove a reward by key')
      .addStringOption(o =>
        o.setName('name').setDescription('Reward key to remove').setRequired(true)));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const { commandName } = interaction;

  // ── /sync-rewards ─────────────────────────────────────────────────────────
  if (commandName === 'sync-rewards') {
    try {
      const count = await syncTwitchRewards();
      if (count === 0) {
        return interaction.editReply('ℹ️ No enabled custom rewards found on the Twitch channel.');
      }
      const lines = getRewards()
        .filter(r => r.fromTwitch)
        .map(r => `• \`${r.name}\` — **${r.cost} pts** — ${r.description}`);
      return interaction.editReply(
        `✅ Synced **${count}** reward(s) from Twitch:\n${lines.join('\n')}`
      );
    } catch (err) {
      log.error('[yt-points] /sync-rewards error:', err.message);
      return interaction.editReply(`❌ Sync failed: ${err.message}`);
    }
  }

  // ── /yt-points ────────────────────────────────────────────────────────────
  if (commandName === 'yt-points') {
    const sub      = interaction.options.getSubcommand();
    const username = interaction.options.getString('username')?.trim().toLowerCase();
    const amount   = interaction.options.getInteger('amount');

    if (sub === 'inspect') {
      return interaction.editReply(`⭐ **${username}** has **${getPoints(username)} pts**.`);
    }
    if (sub === 'set') {
      setPoints(username, amount);
      return interaction.editReply(`✅ Set **${username}** to **${amount} pts**.`);
    }
    if (sub === 'give') {
      const next = addPoints(username, amount, 'mod-gift');
      return interaction.editReply(
        `✅ Gave **${amount} pts** to **${username}** → new total: **${next} pts**.`
      );
    }
    if (sub === 'take') {
      const result = deductPoints(username, amount);
      if (result === false) {
        return interaction.editReply(
          `❌ **${username}** only has **${getPoints(username)} pts** — can't take ${amount}.`
        );
      }
      return interaction.editReply(
        `✅ Removed **${amount} pts** from **${username}** → new total: **${result} pts**.`
      );
    }
    if (sub === 'top') {
      const limit  = interaction.options.getInteger('limit') ?? 10;
      const sorted = [..._balances.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
      if (!sorted.length) return interaction.editReply('ℹ️ No points awarded yet.');
      const lines = sorted.map(
        ([name, pts], i) => `\`${String(i + 1).padStart(2, ' ')}\` **${name}** — ${pts} pts`
      );
      return interaction.editReply(
        `🏆 **YouTube Points Leaderboard (top ${sorted.length}):**\n${lines.join('\n')}`
      );
    }
  }

  // ── /yt-rewards ───────────────────────────────────────────────────────────
  if (commandName === 'yt-rewards') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const rewards = getRewards();
      if (!rewards.length) {
        return interaction.editReply(
          'ℹ️ No rewards registered. Run `/sync-rewards` to import from Twitch, or use `/yt-rewards add`.'
        );
      }
      const lines = rewards.map(r =>
        `• \`${r.name}\` — **${r.cost} pts** — ${r.description}${r.fromTwitch ? ' 🟣' : ''}`
      );
      return interaction.editReply(
        `🎁 **Rewards (${rewards.length})** _(🟣 = synced from Twitch)_:\n${lines.join('\n')}`
      );
    }

    if (sub === 'add') {
      const rawName = interaction.options.getString('name').trim().toLowerCase().replace(/\s+/g, '-');
      const cost    = interaction.options.getInteger('cost');
      const desc    = interaction.options.getString('description').trim();
      const send    = _chatReply.youtube;

      registerReward({
        name: rawName, cost, description: desc,
        group: 'general',
        handler: async (username, chatReply, ctx = {}) => {
          // Same announcement path as Twitch-synced rewards (immediate — this
          // is a general reward). Errors inside the announcement are caught
          // by _sendLine and must NOT fail the redeem (no bogus refunds).
          _announceRedeem({
            send:    chatReply,
            videoId: ctx.videoId,
            username,
            reward:  { group: 'general', displayTitle: rawName, cost },
          });
          return true;
        },
      });
      return interaction.editReply(`✅ Reward \`${rawName}\` added — **${cost} pts** — "${desc}"`);
    }

    if (sub === 'remove') {
      const rawName = interaction.options.getString('name').trim().toLowerCase();
      if (!_rewards.has(rawName)) {
        return interaction.editReply(`ℹ️ \`${rawName}\` is not a registered reward.`);
      }
      removeReward(rawName);
      return interaction.editReply(`✅ Removed reward \`${rawName}\`.`);
    }
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  id: 'yt-points',

  init,
  onChatReady,
  processMessage,

  commands: [commandSyncRewards, commandYtPoints, commandYtRewards],
  handleInteraction,

  // Public API for other plugins
  getPoints,
  addPoints,
  deductPoints,
  setPoints,
  registerReward,
  removeReward,
  getRewards,
  syncTwitchRewards,
  onPointsChange,
  offPointsChange,
  onStreamStart,
  onStreamEnd,
};