/**
 * chat-mirror  (Node.js rewrite)
 * ================================
 * Mirrors Twitch + YouTube Live chat → Discord with rich embeds.
 *
 * Features
 *  • Twitch chat  → #chat-feed  (purple embed)
 *  • YouTube chat → #chat-feed  (red embed)
 *  • Twitch redeems → #redeem-feed AND #chat-feed  (gold embed)
 *  • Discord slash commands: /ban /vip  (works on Twitch + YouTube)
 *  • YouTube: WebSub primary, masterchat polling fallback
 */

'use strict';

require('dotenv').config();

const { startDiscordBot } = require('./src/discord');
const twitchModule        = require('./src/twitch');
const ytModule            = require('./src/youtube');
const { startWebSub }     = require('./src/websub');
const queue               = require('./src/queue');
const log                 = require('./src/logger');

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));
process.on('uncaughtException',  (err) => log.error('Uncaught exception:',  err));

async function main() {
  log.info('chat-mirror starting…');

  // 1. Discord bot
  const discord = await startDiscordBot();

  // 2. Wire queue → Discord embeds
  queue.onMessage(discord.sendChat.bind(discord));
  queue.onRedeem(discord.sendRedeem.bind(discord));

  // 3. Wire mod action handlers: Discord /ban /vip → Twitch & YouTube
  discord.onModAction('ban', async (platform, username, reason) => {
    if (platform === 'twitch')  return twitchModule.modHandlers.ban('twitch', username, reason);
    if (platform === 'youtube') return ytModule.modHandlers.ban('youtube', username, reason);
  });
  discord.onModAction('vip', async (platform, username) => {
    if (platform === 'twitch')  return twitchModule.modHandlers.vip('twitch', username);
    if (platform === 'youtube') return ytModule.modHandlers.vip('youtube', username);
  });
  discord.onModAction('unvip', async (platform, username) => {
    if (platform === 'twitch')  return twitchModule.modHandlers.unvip('twitch', username);
    if (platform === 'youtube') return ytModule.modHandlers.unvip('youtube', username);
  });

  // 4. Twitch
  await twitchModule.startTwitch(queue);

  // 5. YouTube WebSub server (returns false if not configured → polling fallback)
  const websubRunning = await startWebSub(queue);

  // 6. YouTube chat + watchdog
  await ytModule.startYouTube(queue, websubRunning);

  // 7. Register Discord slash commands (idempotent guild deploy)
  await discord.registerCommands();

  log.info('chat-mirror running. Ctrl+C to stop.');
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});
