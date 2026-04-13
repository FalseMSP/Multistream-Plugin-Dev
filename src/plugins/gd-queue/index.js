'use strict';

/**
 * Plugin: gd-queue
 * ────────────────
 * Geometry Dash level request queue.
 *
 * Chat commands (Twitch + YouTube):
 *   !q <levelId>   — add a level to the queue (numbers only)
 *                    if the user already has a level in the queue,
 *                    their previous entry is replaced with the new one
 *   !ql            — bot replies with the current queue length in that chat
 *
 * Discord slash commands:
 *   /next          — dequeue and display the next level ID
 *   /queue         — show all levels currently in the queue
 *   /queue_clear   — empty the entire queue
 *   /queue_remove <user> — remove a specific user's entry
 *
 * All chat commands are suppressed from #stream-chat (they're bot triggers,
 * not conversation).
 */

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');

// ── State ─────────────────────────────────────────────────────────────────
// Queue entries: Array<{ username, platform, levelId, addedAt }>
// Ordered by insertion time. One entry per username (case-insensitive).

const _queue = [];

const CMD_ADD    = /^!q\s+(\d+)\s*$/i;
const CMD_LENGTH = /^!ql\s*$/i;

// Injected by onChatReady()
let _chatReply = { twitch: null, youtube: null };

// ── Queue helpers ─────────────────────────────────────────────────────────

function _findByUser(username) {
  return _queue.findIndex(e => e.username.toLowerCase() === username.toLowerCase());
}

function _add(username, platform, levelId) {
  const existing = _findByUser(username);
  if (existing !== -1) {
    const old = _queue[existing].levelId;
    _queue.splice(existing, 1);
    log.info(`[gd-queue] Replaced ${username}'s entry ${old} → ${levelId}`);
  }
  _queue.push({ username, platform, levelId, addedAt: new Date() });
  log.info(`[gd-queue] Added: ${username} → ${levelId} (queue length: ${_queue.length})`);
  return existing !== -1; // true = was a replacement
}

function _next() {
  return _queue.shift() ?? null;
}

// ── processMessage ────────────────────────────────────────────────────────

async function processMessage(msg) {
  const text = msg.message.trim();

  // !q <levelId>
  const addMatch = text.match(CMD_ADD);
  if (addMatch) {
    const levelId    = addMatch[1];
    const replaced   = _add(msg.username, msg.platform, levelId);
    const reply      = replaced
      ? `@${msg.username} updated your request to level ${levelId}! Queue position: #${_queue.length}`
      : `@${msg.username} added level ${levelId} to the queue! Position: #${_queue.length}`;

    const send = _chatReply[msg.platform];
    if (send) send(reply).catch(e => log.error('[gd-queue] chat reply error:', e.message));

    return { message: null }; // suppress from #stream-chat
  }

  // !ql
  if (CMD_LENGTH.test(text)) {
    const len   = _queue.length;
    const reply = len === 0
      ? 'The level queue is currently empty!'
      : `There ${len === 1 ? 'is' : 'are'} ${len} level${len === 1 ? '' : 's'} in the queue.`;

    const send = _chatReply[msg.platform];
    if (send) send(reply).catch(e => log.error('[gd-queue] chat reply error:', e.message));

    return { message: null }; // suppress from #stream-chat
  }

  return { message: msg };
}

// ── Slash commands ────────────────────────────────────────────────────────

const GD_BLUE = 0x00a8ff;

function _buildQueueEmbed() {
  const embed = new EmbedBuilder()
    .setColor(GD_BLUE)
    .setTitle('🎮 GD Level Queue')
    .setTimestamp();

  if (_queue.length === 0) {
    embed.setDescription('The queue is empty.');
    return embed;
  }

  const lines = _queue.map((e, i) => {
    const platform = e.platform === 'twitch' ? '🟣' : '🔴';
    return `**${i + 1}.** \`${e.levelId}\` — ${platform} ${e.username}`;
  });

  embed.setDescription(lines.join('\n'));
  embed.setFooter({ text: `${_queue.length} level${_queue.length === 1 ? '' : 's'} in queue` });
  return embed;
}

// We register multiple top-level commands (discord.js doesn't allow
// subcommands and top-level commands to coexist on the same name easily,
// and /next should be a clean single command).
// The plugin exports an array for `command` — the pipeline engine handles both.

const commandNext = new SlashCommandBuilder()
  .setName('next')
  .setDescription('Dequeue and show the next GD level request')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

const commandQueue = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Manage the GD level request queue')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('list').setDescription('Show all levels currently in the queue'))
  .addSubcommand(sub =>
    sub.setName('clear').setDescription('Empty the entire queue'))
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription("Remove a specific user's entry from the queue")
      .addStringOption(o =>
        o.setName('user').setDescription('The username to remove').setRequired(true)));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: false });
  const cmd = interaction.commandName;

  // /next
  if (cmd === 'next') {
    const entry = _next();
    if (!entry) {
      return interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(GD_BLUE).setDescription('📭 The queue is empty — no more levels!'),
      ]});
    }
    const platform = entry.platform === 'twitch' ? '🟣 Twitch' : '🔴 YouTube';
    const embed = new EmbedBuilder()
      .setColor(GD_BLUE)
      .setTitle('Next Level')
      .addFields(
        { name: 'Level ID',    value: `\`${entry.levelId}\``,  inline: true },
        { name: 'Requested by', value: `(${platform}) ${entry.username}`, inline: true },
      )
      .setFooter({ text: `${_queue.length} level${_queue.length === 1 ? '' : 's'} remaining` })
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  // /queue subcommands
  if (cmd === 'queue') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      return interaction.editReply({ embeds: [_buildQueueEmbed()] });
    }

    if (sub === 'clear') {
      const count = _queue.length;
      _queue.length = 0;
      log.info('[gd-queue] Queue cleared by Discord command');
      return interaction.editReply(`Queue cleared — removed ${count} level${count === 1 ? '' : 's'}.`);
    }

    if (sub === 'remove') {
      const user = interaction.options.getString('user');
      const idx  = _findByUser(user);
      if (idx === -1) {
        return interaction.editReply(`⚠️ No entry found for **${user}** in the queue.`);
      }
      const removed = _queue.splice(idx, 1)[0];
      log.info(`[gd-queue] Removed ${removed.username}'s entry (${removed.levelId}) via Discord`);
      return interaction.editReply(`Removed **${removed.username}**'s level \`${removed.levelId}\` from the queue.`);
    }
  }

  return interaction.editReply('⚠️ Unknown command.');
}

// ── Plugin lifecycle ──────────────────────────────────────────────────────

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[gd-queue] Chat reply handlers registered.');
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = {
  id: 'gd-queue',
  commands: [commandNext, commandQueue], // array — see note in pipeline engine
  handleInteraction,
  processMessage,
  onChatReady,
};