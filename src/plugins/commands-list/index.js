'use strict';
/**
 * Plugin: commands-list
 * ─────────────────────
 * Responds to !commands in chat with a list of all registered chat commands.
 * Commands can be scoped to a specific platform ('twitch', 'youtube') or shared
 * across both ('both', the default).  When a viewer types !commands they only
 * see commands that are relevant to their platform.
 *
 * Chat commands (Twitch + YouTube):
 *   !commands — bot replies with commands relevant to the viewer's platform
 *
 * Slash command: /commands
 *   list [platform]                          — show commands for a platform (or all)
 *   add <name> <description> [platform]      — register a new command
 *   remove <name> [platform]                 — unregister a command
 *
 * Registry API (for other plugins):
 *   const registry = require('./commands-list');
 *
 *   // platform: 'twitch' | 'youtube' | 'both' (default: 'both')
 *   registry.registerCommand('!tnt',     'Spawns TNT at the streamer');           // both
 *   registry.registerCommand('!points',  'Check your points', 'youtube');         // YT only
 *   registry.registerCommand('!redeem',  'Redeem a reward',   'youtube');         // YT only
 *   registry.removeCommand('!tnt');               // removes from all platforms
 *   registry.removeCommand('!points', 'youtube'); // removes only from youtube
 *   registry.getCommands();                       // all commands
 *   registry.getCommands('youtube');              // youtube + both
 *   registry.getCommands('twitch');               // twitch  + both
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');

const CMD_COMMANDS = /^!commands\s*$/i;

const VALID_PLATFORMS = ['twitch', 'youtube', 'both'];

/**
 * @typedef  {Object} CommandEntry
 * @property {string} name
 * @property {string} description
 * @property {'twitch'|'youtube'|'both'} platform
 */
/** @type {CommandEntry[]} */
const _registry = [];

let _chatReply = { twitch: null, youtube: null };

// ─── Registry API ────────────────────────────────────────────────────────────

/**
 * Register a chat command so it appears in !commands output.
 * Calling registerCommand with an already-registered name + platform overwrites
 * the existing description (idempotent-friendly for hot-reloads).
 *
 * @param {string} name        The command trigger, e.g. "!discord"
 * @param {string} description Short human-readable explanation
 * @param {'twitch'|'youtube'|'both'} [platform='both']
 */
function registerCommand(name, description, platform = 'both') {
  if (!name || !description) {
    log.warn('[commands-list] registerCommand called with missing name or description');
    return;
  }
  if (!VALID_PLATFORMS.includes(platform)) {
    log.warn(`[commands-list] registerCommand: unknown platform "${platform}", defaulting to "both"`);
    platform = 'both';
  }
  const normalised = name.toLowerCase().trim();
  const existing = _registry.findIndex(c => c.name === normalised && c.platform === platform);
  if (existing !== -1) {
    _registry[existing].description = description;
    log.info(`[commands-list] Updated command: ${normalised} [${platform}]`);
  } else {
    _registry.push({ name: normalised, description, platform });
    log.info(`[commands-list] Registered command: ${normalised} [${platform}]`);
  }
}

/**
 * Remove a previously registered command.
 * If platform is omitted, removes the command from all platforms it appears in.
 *
 * @param {string} name
 * @param {'twitch'|'youtube'|'both'} [platform]
 */
function removeCommand(name, platform) {
  const normalised = name.toLowerCase().trim();
  let removed = 0;
  for (let i = _registry.length - 1; i >= 0; i--) {
    const c = _registry[i];
    if (c.name === normalised && (platform == null || c.platform === platform)) {
      _registry.splice(i, 1);
      removed++;
    }
  }
  if (removed) {
    log.info(`[commands-list] Removed command: ${normalised}${platform ? ` [${platform}]` : ' [all platforms]'}`);
  }
}

/**
 * Returns a sorted list of commands visible on the given platform.
 * Includes commands registered as 'both' plus any platform-specific ones.
 * Passing no platform (or null) returns every registered command.
 *
 * @param {'twitch'|'youtube'|'both'|null} [platform]
 * @returns {CommandEntry[]}
 */
function getCommands(platform) {
  const filtered = platform && platform !== 'both'
    ? _registry.filter(c => c.platform === platform || c.platform === 'both')
    : [..._registry];
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[commands-list] Chat reply handlers registered.');
}

async function processMessage(msg) {
  if (!msg.message || !CMD_COMMANDS.test(msg.message.trim())) return { message: msg };

  // Only show commands relevant to the viewer's platform
  const cmds  = getCommands(msg.platform);
  const reply = cmds.length
    ? 'Commands: ' + cmds.map(c => `${c.name} (${c.description})`).join(' | ')
    : 'No commands registered yet.';

  const send = _chatReply[msg.platform];
  if (send) {
    send(reply).catch(e => log.error('[commands-list] chat reply error:', e.message));
  }

  return { message: null }; // suppress from #stream-chat
}

// ─── Slash command ────────────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('commands')
  .setDescription('Manage the !commands chat list')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('Show registered chat commands')
      .addStringOption(o =>
        o.setName('platform')
          .setDescription('Filter by platform (default: all)')
          .addChoices(
            { name: 'All',     value: 'both'    },
            { name: 'Twitch',  value: 'twitch'  },
            { name: 'YouTube', value: 'youtube' },
          )))
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Add or update a chat command')
      .addStringOption(o =>
        o.setName('name')
          .setDescription('Command trigger, e.g. !discord (! is optional)')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('description')
          .setDescription('Short description shown in !commands output')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('platform')
          .setDescription('Which platform shows this command (default: both)')
          .addChoices(
            { name: 'Both',    value: 'both'    },
            { name: 'Twitch',  value: 'twitch'  },
            { name: 'YouTube', value: 'youtube' },
          )))
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Remove a chat command from the list')
      .addStringOption(o =>
        o.setName('name')
          .setDescription('Command trigger to remove, e.g. !discord')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('platform')
          .setDescription('Remove only from this platform (default: all platforms)')
          .addChoices(
            { name: 'Both',    value: 'both'    },
            { name: 'Twitch',  value: 'twitch'  },
            { name: 'YouTube', value: 'youtube' },
          )));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  // ── list ──────────────────────────────────────────────────────────────────
  if (sub === 'list') {
    const platform = interaction.options.getString('platform') ?? null;
    const cmds     = getCommands(platform);
    if (!cmds.length) {
      return interaction.editReply('ℹ️ No commands registered yet.');
    }
    const platformLabel = !platform || platform === 'both'
      ? 'All platforms'
      : platform.charAt(0).toUpperCase() + platform.slice(1);
    const lines = cmds.map(c => {
      const tag = c.platform !== 'both' ? ` _(${c.platform} only)_` : '';
      return `• \`${c.name}\` — ${c.description}${tag}`;
    });
    return interaction.editReply(`**Registered commands — ${platformLabel} (${cmds.length}):**\n${lines.join('\n')}`);
  }

  // ── add ───────────────────────────────────────────────────────────────────
  if (sub === 'add') {
    let name          = interaction.options.getString('name').trim().toLowerCase();
    const description = interaction.options.getString('description').trim();
    const platform    = interaction.options.getString('platform') ?? 'both';

    // Normalise: ensure name starts with !
    if (!name.startsWith('!')) name = `!${name}`;

    if (!name || !description) {
      return interaction.editReply('❌ Both a name and description are required.');
    }

    const isUpdate    = _registry.some(c => c.name === name && c.platform === platform);
    registerCommand(name, description, platform);

    const platformLabel = platform === 'both' ? 'both platforms' : platform;
    return interaction.editReply(
      isUpdate
        ? `✅ Updated \`${name}\` [${platformLabel}] → "${description}"`
        : `✅ Added \`${name}\` [${platformLabel}] — "${description}"`
    );
  }

  // ── remove ────────────────────────────────────────────────────────────────
  if (sub === 'remove') {
    let name       = interaction.options.getString('name').trim().toLowerCase();
    const platform = interaction.options.getString('platform') ?? null;
    if (!name.startsWith('!')) name = `!${name}`;

    const exists = _registry.some(
      c => c.name === name && (platform == null || c.platform === platform)
    );
    if (!exists) {
      return interaction.editReply(`ℹ️ \`${name}\` is not in the list — nothing to remove.`);
    }

    removeCommand(name, platform);
    const platformLabel = platform ? `[${platform}]` : '[all platforms]';
    return interaction.editReply(`✅ Removed \`${name}\` ${platformLabel} from the commands list.`);
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ─── Pre-register built-in commands ──────────────────────────────────────────
// Commands visible on both platforms (default)
registerCommand('!commands', 'Lists all chat commands');
registerCommand('!discord',  'Get the Discord invite link');

// Minecraft / viewer interaction commands (both platforms)
registerCommand('!tnt',      'Spawns TNT near the streamer');
registerCommand('!william',  'Spawns a dog');
registerCommand('!creeper',  'Spawns a charged creeper');
registerCommand('!penny',    'Spawns a cat');
registerCommand('!suzy',     'Spawns a bunny');

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Plugin identity
  id: 'commands-list',

  // Plugin lifecycle hooks
  processMessage,
  onChatReady,

  // Discord slash command
  command,
  handleInteraction,

  // Public registry API — import this module from other plugins to use
  registerCommand,
  removeCommand,
  getCommands,
};