'use strict';

/**
 * first-time-chatter plugin
 *
 * Detects first-time chatters on Twitch or YouTube.
 * For first-timers:
 *   - Suppresses the normal message from the main pipeline
 *   - Sends an identical-looking embed via the chat webhook itself,
 *     but with a distinct mint colour + "First time chatting!" footer
 *
 * For returning chatters:
 *   - Passes the message through untouched
 *
 * Requires: DISCORD_CHAT_WEBHOOK_URL (same env var used by discord.js)
 *
 * Persistence:
 *   src/plugins/first-time-chatter/seen.json
 *   { "twitch": ["alice", ...], "youtube": ["carol", ...] }
 */

const fs   = require('fs');
const path = require('path');
const { EmbedBuilder, WebhookClient } = require('discord.js');
const log  = require('../../logger');

// ── Config ────────────────────────────────────────────────────────────────

const CHAT_WEBHOOK_URL = process.env.DISCORD_CHAT_WEBHOOK_URL ?? '';

const COLOURS = {
  twitch:     0x9146FF,
  youtube:    0xFF0000,
  firstTimer: 0x00FFB2, // mint — stands out in the chat feed
};

// ── Webhook ───────────────────────────────────────────────────────────────

let _webhook = null;

function _getWebhook() {
  if (!_webhook && CHAT_WEBHOOK_URL) {
    _webhook = new WebhookClient({ url: CHAT_WEBHOOK_URL });
  }
  return _webhook;
}

// ── Persistence ───────────────────────────────────────────────────────────

const DATA_PATH = path.join(__dirname, 'seen.json');

/** @type {{ twitch: Set<string>, youtube: Set<string> }} */
const _seen = { twitch: new Set(), youtube: new Set() };

function _load() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      if (Array.isArray(raw.twitch))  raw.twitch.forEach(u  => _seen.twitch.add(u));
      if (Array.isArray(raw.youtube)) raw.youtube.forEach(u => _seen.youtube.add(u));
      log.info(
        `[first-time-chatter] Loaded ${_seen.twitch.size} Twitch + ` +
        `${_seen.youtube.size} YouTube known chatters.`
      );
    }
  } catch (e) {
    log.error('[first-time-chatter] Failed to load seen.json:', e.message);
  }
}

function _save() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify({
      twitch:  [..._seen.twitch],
      youtube: [..._seen.youtube],
    }, null, 2), 'utf8');
  } catch (e) {
    log.error('[first-time-chatter] Failed to save seen.json:', e.message);
  }
}

// ── Core ──────────────────────────────────────────────────────────────────

/** Returns true the first time this username is seen on this platform. */
function _checkAndMark(platform, username) {
  const store = _seen[platform];
  if (!store || store.has(username)) return false;
  store.add(username);
  _save();
  return true;
}

// ── Embed builders ────────────────────────────────────────────────────────

/** Same layout as discord.js buildChatEmbed, but mint + first-timer footer. */
function _buildFirstTimerEmbed(platform, username, message) {
  const label = platform === 'twitch' ? '🟣 Twitch' : '🔴 YouTube';
  return new EmbedBuilder()
    .setColor(COLOURS.firstTimer)
    .setAuthor({ name: `👋 First-time chatter  •  ${label}  •  ${username}` })
    .setDescription(message)
    .setFooter({ text: '✨ First time chatting!' })
    .setTimestamp();
}

// ── Plugin API ────────────────────────────────────────────────────────────

function init() {
  _load();
}

async function processMessage(msg) {
  // Skip synthetic event notifications (subscribe, like, watch-streak, raid).
  // These carry a `type` field and are NOT actual chat messages — a raider
  // sharing a raid or a viewer sharing their watch streak hasn't "chatted",
  // so they shouldn't be marked as seen or trigger a first-time-chatter embed.
  // We pass them through untouched so other plugins/consumers still see them.
  if (msg.type) return { message: msg };

  const isFirst = _checkAndMark(msg.platform, msg.username);

  if (!isFirst) {
    return { message: msg }; // returning chatter — pass through untouched
  }

  log.info(`[first-time-chatter] First message from ${msg.username} on ${msg.platform}.`);

  // Tag the message so consumers (e.g. the dashboard) can highlight it.
  //
  // suppressDiscord tells index.js's queue.onMessage handler to skip its own
  // discord.sendChat(msg) call, since we're sending our own styled embed via
  // sideEffect below. (The old `suppress: true` return value here did
  // nothing — runPipeline only ever checked `result.message === null` to
  // suppress, so the plain embed was ALWAYS also sent by index.js, causing
  // every first-time chatter to get double-posted to Discord.)
  const taggedMsg = { ...msg, firstTimer: true, suppressDiscord: true };

  const webhook = _getWebhook();

  if (!webhook) {
    log.warn('[first-time-chatter] No DISCORD_CHAT_WEBHOOK_URL — cannot send first-timer embed.');
    // No webhook to send our own embed with, so let the normal send happen.
    return { message: { ...msg, firstTimer: true } };
  }

  // Send our styled embed as a side effect instead of awaiting it inline.
  // Awaiting it here used to block the entire pipeline (and therefore the
  // dashboard/overlay dispatch) on a Discord API round-trip for every
  // first-time chatter. Returning it as a sideEffect lets the message reach
  // the dashboard/overlay immediately while the webhook call happens in the
  // background (queue.pushMessage runs sideEffects without waiting on them).
  const embed = _buildFirstTimerEmbed(msg.platform, msg.username, msg.message);
  const sideEffect = async () => {
    try {
      await webhook.send({ embeds: [embed] });
    } catch (e) {
      log.error('[first-time-chatter] Failed to send first-timer embed:', e.message);
    }
  };

  return { message: taggedMsg, sideEffect };
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = {
  id: 'first-time-chatter',
  init,
  processMessage,
};