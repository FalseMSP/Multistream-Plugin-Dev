// src/plugins/discord-reminder/index.js
'use strict';

const log = require('../../logger');
const commandsList = require('../commands-list');

const INTERVAL_MS      = 5 * 60 * 1000; // how often to fire
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000; // a chat is "active" if messaged within this window

const DISCORD_URL = 'https://discord.gg/jBSNayWUrX';

let _youtube    = null;
let _chatReply  = { twitch: null, youtube: null };
let _intervalId = null;

/** Map<videoId, lastMessageTimestamp> — YouTube only */
const _ytLastSeen = new Map();
/** Last message timestamp for Twitch (single channel, no video ID) */
let _twitchLastSeen = null;

function _getYoutube() {
  if (!_youtube) {
    try { _youtube = require('../../youtube'); }
    catch (err) { log.warn('[discord-reminder] Could not require youtube module:', err.message); }
  }
  return _youtube;
}

function _startReminder() {
  if (_intervalId) return;

  _intervalId = setInterval(async () => {
    const now = Date.now();

    // ── Twitch ───────────────────────────────────────────────────────────────
    const twitchSend = _chatReply.twitch;
    if (twitchSend && _twitchLastSeen && now - _twitchLastSeen < ACTIVITY_WINDOW_MS) {
      twitchSend(`👾 Join the Discord: ${DISCORD_URL}`)
        .catch(e => log.error('[discord-reminder] Twitch send error:', e.message));
      log.info('[discord-reminder] Sent reminder to Twitch chat.');
    }

    // ── YouTube (per active video ID) ─────────────────────────────────────
    const yt = _getYoutube();
    if (yt?.sayTo) {
      for (const [videoId, lastSeen] of _ytLastSeen.entries()) {
        if (now - lastSeen < ACTIVITY_WINDOW_MS) {
          yt.sayTo(videoId, `👾 Join the Discord: ${DISCORD_URL}`)
            .catch(e => log.error(`[discord-reminder] YT send error (${videoId}):`, e.message));
          log.info(`[discord-reminder] Sent reminder to YouTube chat (videoId=${videoId}).`);
        } else {
          // Prune stale entries so the map doesn't grow forever
          _ytLastSeen.delete(videoId);
          log.debug(`[discord-reminder] Pruned inactive videoId ${videoId}.`);
        }
      }
    }
  }, INTERVAL_MS);
}

function onChatReady(chatReply) {
  _chatReply = chatReply;
  commandsList.registerCommand('!discord', 'Get the Discord invite link');
  _startReminder();
  log.info('[discord-reminder] Started 5-minute reminder interval.');
}

async function processMessage(msg) {
  if (msg.platform === 'youtube' && msg.videoId) {
    _ytLastSeen.set(msg.videoId, Date.now());
  } else if (msg.platform === 'twitch') {
    _twitchLastSeen = Date.now();
  }
  return { message: msg };
}

module.exports = {
  id: 'discord-reminder',
  onChatReady,
  processMessage,
};