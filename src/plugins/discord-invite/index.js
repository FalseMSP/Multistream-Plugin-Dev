'use strict';

/**
 * Plugin: discord-link
 * ────────────────────
 * Responds to !discord in chat with the Discord invite link.
 *
 * Chat commands (Twitch + YouTube):
 *   !discord — bot replies with the Discord invite link
 */

const log = require('../../logger');

const CMD_DISCORD = /^!discord\s*$/i;

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[discord-link] Chat reply handlers registered.');
}

async function processMessage(msg) {
  if (!CMD_DISCORD.test(msg.message.trim())) return { message: msg };

  const send = _chatReply[msg.platform];
  if (send) {
    send('Join the Discord: https://discord.gg/jBSNayWUrX')
      .catch(e => log.error('[discord-link] chat reply error:', e.message));
  }

  return { message: null }; // suppress from #stream-chat
}

module.exports = {
  id: 'discord-link',
  processMessage,
  onChatReady,
};
