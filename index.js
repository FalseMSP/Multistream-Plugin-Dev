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
 *  • Plugin pipeline (src/plugins/) for extensible message processing
 */

'use strict';

require('dotenv').config();

const { startDiscordBot } = require('./src/discord');
const twitchModule        = require('./src/twitch');
const ytModule            = require('./src/youtube');
const { startWebSub }     = require('./src/websub');
const queue               = require('./src/queue');
const log                 = require('./src/logger');
const plugins             = require('./src/plugins/index');

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));
process.on('uncaughtException',  (err) => log.error('Uncaught exception:',  err));

async function main() {
  log.info('chat-mirror starting…');

  // 1. Discord bot (also loads + inits plugins)
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

  // 4. YouTube WebSub + EventSub HTTP server
  const websubRunning = await startWebSub(queue);

  // 5. Purge any stale Twitch EventSub subs from previous runs, then
  //    register a fresh one — both must happen AFTER the server is listening
  //    so Twitch can reach /eventsub for the challenge handshake.
  const { getEventSubCallbackUrl, getTwitchSecret, purgeStaleTwitchSubs } = require('./src/websub');
  if (getEventSubCallbackUrl()) {
    try {
      const appToken = await twitchModule.getAppToken();
      await purgeStaleTwitchSubs(appToken);
    } catch (err) {
      log.warn('Could not purge stale Twitch subs:', err.message);
    }
    await twitchModule.setupEventSub(getEventSubCallbackUrl(), getTwitchSecret());
  }

  // 6. Twitch IRC (chat mirroring)
  await twitchModule.startTwitch(queue);

  // 7. YouTube chat + watchdog
  await ytModule.startYouTube(queue, websubRunning);

  // 8. Now that both platform clients are up, give plugins access to chat reply.
  //    Plugins that need to send messages back to Twitch/YouTube chat use these.
  plugins.setChatReply({
    twitch:  (text) => twitchModule.say(text),
    youtube: (text) => ytModule.say(text),
  });

  // 9. Register Discord slash commands (idempotent guild deploy)
  await discord.registerCommands();

  log.info('chat-mirror running. Ctrl+C to stop.');
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});