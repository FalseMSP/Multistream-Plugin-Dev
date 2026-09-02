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

const { startOverlayServer } = require('./src/overlay-server');
const {
  pushExternalChatMessage,
  pushExternalRedeem,
} = require('./src/overlay-server');
const dashboard = require('./src/dashboard');
const chatEmotes = require('./src/chat-emotes');

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));
process.on('uncaughtException',  (err) => log.error('Uncaught exception:',  err));

async function main() {
  log.info('chat-mirror starting…');

  // 1. Discover plugins (idempotent — safe to call before discord is up).
  //    We load plugin FILES early so their top-level registerSection() /
  //    registerWidget() / addRoute() calls execute before the overlay server
  //    starts listening. init() is NOT called yet — that happens in step 1c
  //    once we have the full runtime context to hand them.
  plugins.loadPlugins();

  // 2. Start Discord bot (loads slash commands, sets up interaction router).
  //    Note: startDiscordBot no longer calls plugins.initPlugins() itself —
  //    we do that explicitly below with the full context so plugins get
  //    queue + twitch + youtube + discord.client in a single init pass.
  const discord = await startDiscordBot();

  // 2b. Initialise plugins ONCE with the full runtime context. This is the
  //     only init pass — no duplicate "first init without queue" anymore,
  //     which previously caused the spurious "context.queue not available"
  //     warnings in gacha / sfx / event-feed / stream-events / pull-fragment.
  plugins.initPlugins({
    discord,
    queue,
    twitch: twitchModule,
    youtube: ytModule,
  });

  // 2c. Mount dashboard routes on the overlay server, then start the HTTP
  //     server. OBS Browser Source URL: http://127.0.0.1:2999/overlay
  dashboard.mountOnOverlayServer(require('./src/overlay-server'));

  // 2d. Mount ClipCurator reverse-proxy on the overlay server (optional).
  //     If the clipcurator-proxy module isn't available (e.g. partial deploy),
  //     the bot still starts — ClipCurator just won't be accessible at /clipcurator.
  //     ClipCurator (Next.js) runs on an internal port (3001) and is
  //     reverse-proxied to /clipcurator on the same port 2999 as the
  //     dashboard. Access at: http://127.0.0.1:2999/clipcurator/
  try {
    const clipcuratorProxy = require('./src/clipcurator-proxy');
    clipcuratorProxy.mountOnOverlayServer(require('./src/overlay-server'));
  } catch (err) {
    log.warn('[clipcurator] Could not mount ClipCurator proxy:', err.message);
    log.warn('[clipcurator] ClipCurator will not be available at /clipcurator.');
    log.warn('[clipcurator] To fix, ensure src/clipcurator-proxy.js exists and run: ./dev-both.sh clips');
  }

  startOverlayServer(2999);

  // 3. Wire queue → Discord embeds + dashboard chat feed.
  //    By the time onMessage fires, queue.pushMessage has already run the
  //    plugin pipeline — msg is the filtered finalMsg, suppressed messages
  //    never arrive.
  queue.onMessage(async (msg) => {
    // Feed the external pull API (GET /api/chat) so out-of-process
    // consumers (e.g. the ViewersHateMe Minecraft mod) can poll for new
    // chat messages with a monotonic id cursor. We push BEFORE routing
    // to Discord/dashboard so the API never lags behind the embeds.
    try { pushExternalChatMessage(msg); } catch (e) { log.error('[external-api] pushExternalChatMessage:', e.message); }

    // Subscribe/membership events have no chat text — build a simple announcement.
    if (msg.type === 'subscribe') {
      const name = msg.username ?? 'Someone';
      discord.sendChat({
        platform: msg.platform,
        username: name,
        message:  `⭐ ${name} just subscribed!`,
      });
      return;
    }

    // Twitch watch-streak share (USERNOTICE msg-id=viewermilestone).
    // A viewer clicked "Share Watch Streak" in the Twitch UI — announce it
    // to the chat feed, mirroring the subscribe announcement above.
    // The watch-streak plugin has already updated streaks.json + awarded
    // points by the time the message reaches here (it runs earlier in the
    // pipeline). We deliberately do NOT route this through sendDonation,
    // so the gacha plugin's onDonation handler never sees it — no pull.
    if (msg.type === 'watch-streak') {
      const name   = msg.username ?? 'Someone';
      const streak = msg.streak ?? '?';
      const announcement = `🔥 ${name} is on a ${streak}-stream watch streak!`;
      discord.sendChat({
        platform: msg.platform,
        username: name,
        message:  announcement,
      });
      // Also push to the dashboard's live chat column so it's visible there.
      // The subscribe/like events above miss this (early return before
      // pushChatMessage) — that's a pre-existing gap we're not fixing here.
      // Raids + watch-streaks should be visible in the live chat feed.
      dashboard.pushChatMessage({
        platform: msg.platform,
        username: name,
        message:  announcement,
        type:     'watch-streak',
      });
      return;
    }

    // Twitch raid (tmi.js 'raided' event → queue.pushMessage with type:'raid').
    // Announce the raid in the chat feed, mirroring the subscribe pattern.
    // Same as watch-streak: routed via sendChat, NOT sendDonation, so the
    // gacha plugin's onDonation handler never fires — no pull.
    if (msg.type === 'raid') {
      const name    = msg.username ?? 'Someone';
      const viewers = msg.viewers ?? '?';
      const announcement = `⚔️ ${name} is raiding with ${viewers} viewers!`;
      discord.sendChat({
        platform: msg.platform,
        username: name,
        message:  announcement,
      });
      // Also push to the dashboard's live chat column so it's visible there.
      dashboard.pushChatMessage({
        platform: msg.platform,
        username: name,
        message:  announcement,
        type:     'raid',
      });
      return;
    }

    // Like events have no chat text — route to sendDonation for a proper embed.
    if (msg.type === 'like') {
      discord.sendDonation(msg);
      return;
    }

    // Pipeline has already run in queue.pushMessage — msg is the filtered finalMsg.
    // suppressDiscord: a plugin (e.g. first-time-chatter) already sent its own
    // Discord embed for this message as a sideEffect — sending it again here
    // would double-post it.
    if (!msg.suppressDiscord) discord.sendChat(msg);

    // Build emote segments ONCE here, using the same builder the OBS overlay
    // uses (src/chat-emotes.js), so the dashboard chat column renders emotes
    // identically to the overlay instead of falling back to plain text.
    //
    // We also deliberately do NOT forward `thirdPartyEmotes` (the full
    // BTTV/FFZ/7TV word→url map — hundreds of KB, shared across ALL Twitch
    // messages) into the dashboard entry. Once segments are built we only
    // need the small resulting segments array; keeping the raw map around
    // was bloating every dashboard chat entry and, since pushChatMessage
    // rebroadcasts the whole 200-message buffer on every new message, that
    // bloat was multiplied 200x per update.
    const { thirdPartyEmotes, ytEmotes, emotes, suppressDiscord, ...rest } = msg;
    const segments = chatEmotes.buildSegments(
      msg.message,
      msg.platform === 'twitch' ? emotes : undefined,
      msg.platform === 'youtube' ? (ytEmotes ?? emotes) : undefined,
      thirdPartyEmotes,
    );
    dashboard.pushChatMessage({ ...rest, segments });
  });
  queue.onRedeem((redeem)    => {
    // Mirror redeems into the external pull API (GET /api/redeems).
    try { pushExternalRedeem(redeem); } catch (e) { log.error('[external-api] pushExternalRedeem:', e.message); }
    discord.sendRedeem(redeem);
  });
  queue.onDonation((donation) => discord.sendDonation(donation));

  // 4. Wire mod action handlers: Discord /ban /vip → Twitch & YouTube
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

  // 5. YouTube WebSub + EventSub HTTP server
  const websubRunning = await startWebSub(queue);

  // 6. Purge any stale Twitch EventSub subs from previous runs, then
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

  // 7. Twitch IRC (chat mirroring)
  await twitchModule.startTwitch(queue);

  // 8. YouTube chat + watchdog
  await ytModule.startYouTube(queue, websubRunning);

  // 9. Now that both platform clients are up, give plugins access to chat reply.
  //    chatReply is the documented way for plugins to send messages back to
  //    Twitch or YouTube chat. Two flavours:
  //      chatReply.twitch(text)                — broadcast to primary Twitch channel
  //      chatReply.youtube(text)               — broadcast to all live YT sessions
  //      chatReply.youtubeSession(videoId, text) — target one specific YT live stream
  plugins.setChatReply({
    twitch:         (text) => twitchModule.say(text),
    youtube:        (text) => ytModule.say(text),
    youtubeSession: (videoId, text) => ytModule.sayTo(videoId, text),
  });

  // 10. Register Discord slash commands (idempotent guild deploy)
  await discord.registerCommands();

  log.info('chat-mirror running. Ctrl+C to stop.');
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});
