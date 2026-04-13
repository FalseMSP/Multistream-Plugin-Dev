'use strict';

/**
 * Discord module
 * ──────────────
 * • Sends chat messages as rich embeds via DISCORD_CHAT_WEBHOOK
 * • Sends redeems as gold embeds via DISCORD_REDEEM_WEBHOOK (+ also to chat)
 * • Registers and handles /ban, /vip, /unvip slash commands
 * • Loads plugin slash commands and routes interactions to the plugin pipeline
 */

const {
  Client, GatewayIntentBits, EmbedBuilder,
  REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, WebhookClient,
} = require('discord.js');

const log = require('./logger');

// ── Config ────────────────────────────────────────────────────────────────

const CHAT_WEBHOOK_URL   = process.env.DISCORD_CHAT_WEBHOOK_URL   ?? '';
const REDEEM_WEBHOOK_URL = process.env.DISCORD_REDEEM_WEBHOOK_URL ?? '';
const BOT_TOKEN          = process.env.DISCORD_BOT_TOKEN          ?? '';
const CLIENT_ID          = process.env.DISCORD_CLIENT_ID          ?? '';
const GUILD_ID           = process.env.DISCORD_GUILD_ID           ?? '';
const RATE_LIMIT         = parseFloat(process.env.DISCORD_RATE_LIMIT ?? '2');

// Platform colours
const COLOURS = {
  twitch:  0x9146FF,
  youtube: 0xFF0000,
  redeem:  0xFFD700,
};

// ── Webhook sender ────────────────────────────────────────────────────────

let chatWebhook   = null;
let redeemWebhook = null;

function getWebhooks() {
  if (!chatWebhook   && CHAT_WEBHOOK_URL)   chatWebhook   = new WebhookClient({ url: CHAT_WEBHOOK_URL });
  if (!redeemWebhook && REDEEM_WEBHOOK_URL) redeemWebhook = new WebhookClient({ url: REDEEM_WEBHOOK_URL });
}

// Token-bucket rate limiter
class RateLimiter {
  constructor(ratePerSec) {
    this._interval = 1000 / ratePerSec;
    this._queue    = [];
    this._running  = false;
  }
  schedule(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      if (!this._running) this._run();
    });
  }
  async _run() {
    this._running = true;
    while (this._queue.length) {
      const { fn, resolve, reject } = this._queue.shift();
      try { resolve(await fn()); } catch (e) { reject(e); }
      if (this._queue.length) await new Promise(r => setTimeout(r, this._interval));
    }
    this._running = false;
  }
}

const limiter = new RateLimiter(RATE_LIMIT);

async function sendEmbed(webhookClient, embed) {
  const send = () => webhookClient.send({ embeds: [embed] });
  try {
    await limiter.schedule(send);
  } catch (err) {
    if (err?.status === 429) {
      const retry = (err.rawError?.retry_after ?? 1) * 1000;
      log.warn(`Discord rate-limited — retrying in ${retry}ms`);
      await new Promise(r => setTimeout(r, retry));
      await limiter.schedule(send);
    } else {
      log.error('Discord send error:', err?.message ?? err);
    }
  }
}

// ── Embed builders ────────────────────────────────────────────────────────

function buildChatEmbed(platform, username, message) {
  const label = platform === 'twitch' ? '🟣 Twitch' : '🔴 YouTube';
  return new EmbedBuilder()
    .setColor(COLOURS[platform])
    .setAuthor({ name: `${label} • ${username}` })
    .setDescription(message)
    .setTimestamp();
}

function buildRedeemEmbed(username, title, cost, input, timestamp) {
  const embed = new EmbedBuilder()
    .setColor(COLOURS.redeem)
    .setAuthor({ name: `🎁 Channel Point Redeem` })
    .setTitle(title)
    .addFields(
      { name: 'Redeemed by', value: username,         inline: true },
      { name: 'Cost',        value: `${cost} points`, inline: true },
    )
    .setTimestamp(timestamp ?? new Date());

  if (input) embed.addFields({ name: 'Message', value: input });
  return embed;
}

// ── Public API ────────────────────────────────────────────────────────────

async function sendChat({ platform, username, message }) {
  getWebhooks();
  if (!chatWebhook) { log.warn('No chat webhook configured'); return; }
  const embed = buildChatEmbed(platform, username, message);
  await sendEmbed(chatWebhook, embed);
}

async function sendRedeem({ username, title, cost, input, timestamp }) {
  getWebhooks();
  const embed = buildRedeemEmbed(username, title, cost, input, timestamp);
  if (redeemWebhook) await sendEmbed(redeemWebhook, embed);
  else log.warn('No redeem webhook configured');
  if (chatWebhook)   await sendEmbed(chatWebhook, embed);
}

// ── Core slash commands ───────────────────────────────────────────────────

const PLATFORM_CHOICE = [
  { name: 'Both',    value: 'both'    },
  { name: 'Twitch',  value: 'twitch'  },
  { name: 'YouTube', value: 'youtube' },
];

const coreCommands = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user from Twitch and/or YouTube')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption(o => o.setName('user').setDescription('Username to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Ban reason'))
    .addStringOption(o => o.setName('platform').setDescription('Platform').addChoices(...PLATFORM_CHOICE))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('vip')
    .setDescription('Grant VIP to a user on Twitch and/or YouTube')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption(o => o.setName('user').setDescription('Username').setRequired(true))
    .addStringOption(o => o.setName('platform').setDescription('Platform').addChoices(...PLATFORM_CHOICE))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('unvip')
    .setDescription('Remove VIP from a user on Twitch and/or YouTube')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption(o => o.setName('user').setDescription('Username').setRequired(true))
    .addStringOption(o => o.setName('platform').setDescription('Platform').addChoices(...PLATFORM_CHOICE))
    .toJSON(),
];

async function registerCommands() {
  if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID) {
    log.warn('Discord bot credentials incomplete — slash commands disabled.');
    return;
  }

  // Merge core commands with any plugin commands
  const { getPluginCommands } = require('./plugins/index');
  const allCommands = [...coreCommands, ...getPluginCommands()];

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: allCommands });
  log.info(`Slash commands registered (${allCommands.map(c => `/${c.name}`).join(', ')}).`);
}

// ── Bot client ────────────────────────────────────────────────────────────

let _modHandlers = { ban: null, vip: null, unvip: null };

function onModAction(action, fn) {
  _modHandlers[action] = fn;
}

async function startDiscordBot() {
  // Load all plugins so their commands are available before registerCommands()
  const plugins = require('./plugins/index');
  plugins.loadPlugins();
  plugins.initPlugins({ sendChat, sendRedeem, onModAction });

  if (!BOT_TOKEN) {
    log.warn('DISCORD_BOT_TOKEN not set — slash commands disabled. Webhooks still active.');
    return { sendChat, sendRedeem, registerCommands, onModAction };
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on('ready', () => log.info(`Discord bot ready as ${client.user.tag}`));

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ── Try plugin commands first ──────────────────────────────────────
    const handled = await plugins.handlePluginInteraction(interaction);
    if (handled) return;

    // ── Core mod commands ──────────────────────────────────────────────
    const { commandName } = interaction;
    const user     = interaction.options.getString('user');
    const platform = interaction.options.getString('platform') ?? 'both';
    const reason   = interaction.options.getString('reason')   ?? 'No reason provided';

    await interaction.deferReply({ ephemeral: true });

    const results = [];

    async function run(platformKey, action) {
      const handler = _modHandlers[action];
      if (!handler) { results.push(`⚠️ No ${platformKey} handler for /${action}`); return; }
      try {
        await handler(platformKey, user, reason);
        results.push(`✅ ${action} applied to **${user}** on ${platformKey}`);
      } catch (err) {
        results.push(`❌ ${platformKey} error: ${err.message}`);
        log.error(`/${action} ${platformKey} error:`, err);
      }
    }

    const platforms = platform === 'both' ? ['twitch', 'youtube'] : [platform];

    if      (commandName === 'ban')   for (const p of platforms) await run(p, 'ban');
    else if (commandName === 'vip')   for (const p of platforms) await run(p, 'vip');
    else if (commandName === 'unvip') for (const p of platforms) await run(p, 'unvip');
    else results.push(`⚠️ Unknown command: /${commandName}`);

    await interaction.editReply(results.join('\n') || '⚠️ No actions were taken.');
  });

  await client.login(BOT_TOKEN);

  return { sendChat, sendRedeem, registerCommands, onModAction };
}

module.exports = { startDiscordBot };