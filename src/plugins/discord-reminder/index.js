// src/plugins/discord-reminder/index.js
'use strict';

const log = require('../../logger');
const commandsList = require('../commands-list');

const INTERVAL_MS      = 5 * 60 * 1000; // how often to fire
const ACTIVITY_WINDOW_MS = 5 * 60 * 1000; // a chat is "active" if messaged within this window

const DISCORD_URL = 'https://discord.gg/jBSNayWUrX';

// Messages sent to both platforms
const COMMON_MESSAGES = [
  `Join the Discord: ${DISCORD_URL}`,
  `Gacha odds are public! https://docs.google.com/spreadsheets/d/1EG0E9UboCVIvHQ-oV3QAAf7gQqtSp5ikBLoeQHfD3rE/edit?usp=sharing`,
  `!help will tell you all available commands`,
  `these messages are pre-generated, i'm running out of things to say`,
  `Hey there! Do you want to know about Twitch Prime? Oh! You may be asking, "What's Twitch Prime?" Let me tell ya! When you connect your Amazon account to your Twitch account, you can get 1 free sub to ANY streamer on Twitch, every month! Yup, and along with that, get yourself some Twitch loot! With Twitch loot, you can go ahead and get yourself some exclusive Twitch gear and your favorite games! So go ahead! Grab your Amazon account, grab a family or friend's Amazon Prime account, and link it to your Twitch account TODAY!`
  `does anyone actually read these?`,
  `fun fact: redlife doens't actually see these in his dashboard`,
  `im not sentient trust guys`
];

// Messages exclusive to YouTube (doesn't make sense to plug Twitch on Twitch)
const YOUTUBE_ONLY_MESSAGES = [
  `if you're enjoying, like the stream please :)`,
  `im also on twitch! twitch.tv/redlifemc`,
  `Liking the stream gives a free budget gacha pull!`,
  `do !points to see your channel points!`,
  `you can spend your channel points by using !redeem`,
  `do !rewards to see all rewards that are purchasable with channel points!`,
  `if you want to put something in the queue, use !q`,
  `if you wanna see more content from me, subscribe!`,
];

function _randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

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
      const twitchMessage = _randomFrom(COMMON_MESSAGES);
      twitchSend(twitchMessage)
        .catch(e => log.error('[discord-reminder] Twitch send error:', e.message));
      log.info('[discord-reminder] Sent reminder to Twitch chat.');
    }

    // ── YouTube (per active video ID) ─────────────────────────────────────
    const yt = _getYoutube();
    if (yt?.sayTo) {
      const youtubeMessage = _randomFrom([...COMMON_MESSAGES, ...YOUTUBE_ONLY_MESSAGES]);
      for (const [videoId, lastSeen] of _ytLastSeen.entries()) {
        if (now - lastSeen < ACTIVITY_WINDOW_MS) {
          yt.sayTo(videoId, youtubeMessage)
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
