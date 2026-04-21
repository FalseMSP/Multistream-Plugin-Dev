'use strict';

const log = require('../../logger');

/**
 * Plugin: yt-bot-filter
 * ─────────────────────
 * Suppresses messages from the YouTube bot account so its replies
 * don't echo back into #stream-chat.
 *
 * Configured via environment variable:
 *   YT_BOT_USERNAME  — YouTube display name to suppress (default: RedTalksGames)
 *
 * Only applies to platform === 'youtube'. Twitch messages are unaffected.
 */

const SUPPRESSED = (process.env.YT_BOT_USERNAME ?? 'RedTalksGames').toLowerCase().replace(/^@/, '');

async function processMessage(msg) {
  if (msg.platform === 'youtube') {
    log.debug(`[yt-bot-filter] username: ${JSON.stringify(msg.username)} suppressing: ${JSON.stringify(SUPPRESSED)}`);
  }
  if (msg.platform === 'youtube' && msg.username.toLowerCase().replace(/^@/, '') === SUPPRESSED) {
    return null; // suppress entirely — no main feed, no side effects
  }
  return { message: msg };
}

module.exports = {
  id: 'yt-bot-filter',
  processMessage,
};