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
 *   !redeem <reward>     — Spend points on a registered reward
 *   !rewards             — List all available rewards and costs
 *
 * ── Twitch reward sync ────────────────────────────────────────────────────────
 *   Rewards are scraped from the Twitch Helix API on demand via:
 *     Discord slash command:  /sync-rewards
 *   Uses the twitch module's listRewards() public API (no Helix plumbing in
 *   this file). The broadcaster OAuth token in .twitch-tokens.json (written by
 *   twitch-auth.js) must carry channel:read:redemptions scope.
 *
 *   When a YouTube viewer redeems a Twitch-sourced reward:
 *     1. Confirmed in YouTube chat: "✅ {user} redeemed {reward}!"
 *     2. Injected into the redeem pipeline via queue.pushRedeem() — appears in
 *        #redeem-feed exactly like a real Twitch redemption (tagged [YT]).
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

// ─── Constants ────────────────────────────────────────────────────────────────

const PASSIVE_COOLDOWN_MS  = 30  * 1000;      // 30 s between passive +1 awards
const CHECKIN_WINDOW_MS    = 5   * 60 * 1000; // each 5-min block since last msg = +20 pts
const CHECKIN_PTS_PER_TICK = 20;              // points per completed 5-min window
const CHECKIN_MAX_PTS      = 120;              // cap: max bonus per message

const CMD_POINTS  = /^!points(?:\s+(top))?\s*$/i;
const CMD_REDEEM  = /^!redeem\s+(.+)$/i;
const CMD_REWARDS = /^!(rewards|shop)\s*$/i;

const POINTS_FILE = path.resolve('.yt-points.json');

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
 * @property {number}   cost
 * @property {string}   description
 * @property {boolean}  fromTwitch    true if scraped from Twitch
 * @property {string}   [twitchId]      Twitch reward ID
 * @property {boolean}  [oncePerStream] true = can only be redeemed once per stream session
 * @property {(username: string, chatReply: Function) => Promise<boolean>} handler
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
  return sorted.map(([name, pts], i) => `#${i + 1} ${name} (${pts})`).join(' | ');
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
      handler: async (username, chatReply) => {
        // 1. Announce in YouTube chat
        if (chatReply) {
          await chatReply(`✅ ${username} redeemed "${rewardTitle}"!`)
            .catch(e => log.error('[yt-points] YT chat reply error:', e.message));
        }

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
function registerReward({ name, cost, description, handler, fromTwitch = false, twitchId = null, cooldownSeconds = 0, oncePerStream = false }) {
  if (!name || !cost || !description || typeof handler !== 'function') {
    log.warn('[yt-points] registerReward: missing required field(s)');
    return;
  }
  const key = name.toLowerCase().trim();
  _rewards.set(key, { name: key, cost, description, handler, fromTwitch, twitchId, cooldownSeconds, oncePerStream });
  log.info(`[yt-points] Reward registered: ${key} (${cost} pts)${fromTwitch ? ' [Twitch]' : ''}${oncePerStream ? ' [once-per-stream]' : ''}`);
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
  commandsList.registerCommand('!redeem',  'Spend points on a reward — !redeem <reward name>', 'youtube');
  commandsList.registerCommand('!rewards', 'List available point rewards and their costs', 'youtube');

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
      if (send) send('🏆 Top viewers: ' + _leaderboardText(5))
        .catch(e => log.error('[yt-points] send error:', e.message));
    } else {
      const total = getPoints(username);
      if (send) send(`⭐ ${username}: ${total} pts`)
        .catch(e => log.error('[yt-points] send error:', e.message));
    }
    return { message: null };
  }

  // ── !rewards ──────────────────────────────────────────────────────────────
  if (CMD_REWARDS.test(text)) {
    const rewards = getRewards();
    const reply   = rewards.length
      ? '🎁 Rewards: ' + rewards.map(r => `${r.name} (${r.cost} pts — ${r.description})`).join(' | ')
      : 'No rewards yet — check back soon!';
    if (send) send(reply).catch(e => log.error('[yt-points] send error:', e.message));
    return { message: null };
  }

  // ── !redeem <reward> ──────────────────────────────────────────────────────
  const redeemMatch = CMD_REDEEM.exec(text);
  if (redeemMatch) {
    // Normalise the typed name the same way registerReward does
    const rewardKey = redeemMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
    const reward    = _rewards.get(rewardKey);

    if (!reward) {
      if (send) send(`❌ Unknown reward "${redeemMatch[1].trim()}". Type !rewards to see options.`)
        .catch(e => log.error('[yt-points] send error:', e.message));
      return { message: null };
    }

    const balance = getPoints(username);
    if (balance < reward.cost) {
      const short = reward.cost - balance;
      if (send) send(`❌ ${username}: need ${reward.cost} pts, have ${balance} (${short} more needed).`)
        .catch(e => log.error('[yt-points] send error:', e.message));
      return { message: null };
    }

    // ── Per-reward cooldown (mirrors Twitch global_cooldown_setting) ──────────
    if (reward.cooldownSeconds > 0) {
      const lastRedeem    = _redeemCooldowns.get(rewardKey) ?? 0;
      const elapsedMs     = now - lastRedeem;
      const cooldownMs    = reward.cooldownSeconds * 1000;
      if (elapsedMs < cooldownMs) {
        const remainingSecs = Math.ceil((cooldownMs - elapsedMs) / 1000);
        const mm = Math.floor(remainingSecs / 60);
        const ss = remainingSecs % 60;
        const timeStr = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
        if (send) send(`⏳ "${reward.name}" is on cooldown — available again in ${timeStr}.`)
          .catch(e => log.error('[yt-points] send error:', e.message));
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
        if (send) send(`❌ "${reward.name}" has already been redeemed this stream — it's a once-per-stream reward!`)
          .catch(e => log.error('[yt-points] send error:', e.message));
        return { message: null };
      }
    }

    // Deduct first — handler is responsible for returning false to trigger refund
    deductPoints(username, reward.cost);

    let success = false;
    try {
      success = await reward.handler(username, send);
    } catch (e) {
      log.error(`[yt-points] reward handler error (${rewardKey}):`, e.message);
    }

    if (!success) {
      addPoints(username, reward.cost, 'redeem-refund');
      if (send) send(`⚠️ ${username}: "${reward.name}" couldn't be fulfilled right now. Points refunded.`)
        .catch(e => log.error('[yt-points] send error:', e.message));
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
        handler: async (username) => {
          if (send) await send(`🎉 ${username} redeemed: ${rawName}! (${desc})`);
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