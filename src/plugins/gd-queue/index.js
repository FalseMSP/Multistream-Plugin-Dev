'use strict';

/**
 * Plugin: gd-queue
 * ────────────────
 * Geometry Dash level request queue.
 *
 * Chat commands (Twitch + YouTube):
 *   !q <levelId> [notes]  — add a level to the queue (numbers only)
 *                           optional notes appended after the ID
 *                           if the user already has a level in the queue,
 *                           their previous entry is replaced with the new one
 *   !queue <levelId> [notes] — alias for !q
 *   !q                    — show the current queue (alias for /queue list)
 *   !ql                   — bot replies with the current queue length in that chat
 *
 * Discord slash commands:
 *   /next          — dequeue and display the next level ID
 *   /queue list    — show all levels currently in the queue
 *   /queue clear   — empty the entire queue
 *   /queue remove <user> — remove a specific user's entry
 *   /queue toggle  — enable or disable the queue plugin
 *
 * All chat commands are suppressed from #stream-chat (they're bot triggers,
 * not conversation).
 */

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');

// ── State ─────────────────────────────────────────────────────────────────
// Queue entries: Array<{ username, platform, levelId, notes, addedAt }>
// Ordered by insertion time. One entry per username (case-insensitive).

const _queue = [];
let _enabled = true;

const CMD_ADD      = /^!(?:q|queue)\s+(\d+)(?:\s+(.+))?\s*$/i;
const CMD_LIST     = /^!q\s*$/i;
const CMD_LENGTH   = /^!ql\s*$/i;

// Injected by onChatReady()
let _chatReply = { twitch: null, youtube: null };

// ── Queue helpers ─────────────────────────────────────────────────────────

function _findByUser(username) {
  return _queue.findIndex(e => e.username.toLowerCase() === username.toLowerCase());
}

function _add(username, platform, levelId, notes) {
  const existing = _findByUser(username);
  if (existing !== -1) {
    const old = _queue[existing].levelId;
    _queue.splice(existing, 1);
    log.info(`[gd-queue] Replaced ${username}'s entry ${old} → ${levelId}`);
  }
  _queue.push({ username, platform, levelId, notes: notes || null, addedAt: new Date() });
  log.info(`[gd-queue] Added: ${username} → ${levelId}${notes ? ` (notes: ${notes})` : ''} (queue length: ${_queue.length})`);
  return existing !== -1; // true = was a replacement
}

function _next() {
  return _queue.shift() ?? null;
}

// ── processMessage ────────────────────────────────────────────────────────

async function processMessage(msg) {
  const text = msg.message.trim();

  // !q (no args) — show the current queue
  if (CMD_LIST.test(text)) {
    if (!_enabled) {
      const send = _chatReply[msg.platform];
      if (send) send('The level queue is currently closed.')
        .catch(e => log.error('[gd-queue] chat reply error:', e.message));
      return { message: null };
    }

    const len = _queue.length;
    let reply;
    if (len === 0) {
      reply = 'The level queue is currently empty!';
    } else {
      const entries = _queue.map((e, i) => `#${i + 1}: ${e.levelId} (${e.username}${e.notes ? ` — ${e.notes}` : ''})`).join(' | ');
      reply = `Queue (${len}): ${entries}`;
    }

    const send = _chatReply[msg.platform];
    if (send) send(reply).catch(e => log.error('[gd-queue] chat reply error:', e.message));

    return { message: null };
  }

  // !q <levelId> [notes] / !queue <levelId> [notes]
  if (CMD_ADD.test(text)) {
    if (!_enabled) {
      const send = _chatReply[msg.platform];
      if (send) send(`@${msg.username} the level queue is currently closed.`)
        .catch(e => log.error('[gd-queue] chat reply error:', e.message));
      return { message: null }; // still suppress from #stream-chat
    }

    const addMatch  = text.match(CMD_ADD);
    const levelId   = addMatch[1];
    const notes     = addMatch[2] ? addMatch[2].trim() : null;
    const replaced  = _add(msg.username, msg.platform, levelId, notes);
    const notesHint = notes ? ` (notes: ${notes})` : '';
    const reply     = replaced
      ? `@${msg.username} updated your request to level ${levelId}${notesHint}! Queue position: #${_queue.length}`
      : `@${msg.username} added level ${levelId}${notesHint} to the queue! Position: #${_queue.length}`;

    const send = _chatReply[msg.platform];
    if (send) send(reply).catch(e => log.error('[gd-queue] chat reply error:', e.message));

    return { message: null };
  }

  // !ql
  if (CMD_LENGTH.test(text)) {
    if (!_enabled) {
      const send = _chatReply[msg.platform];
      if (send) send('The level queue is currently closed.')
        .catch(e => log.error('[gd-queue] chat reply error:', e.message));
      return { message: null };
    }

    const len   = _queue.length;
    const reply = len === 0
      ? 'The level queue is currently empty!'
      : `There ${len === 1 ? 'is' : 'are'} ${len} level${len === 1 ? '' : 's'} in the queue.`;

    const send = _chatReply[msg.platform];
    if (send) send(reply).catch(e => log.error('[gd-queue] chat reply error:', e.message));

    return { message: null };
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
    const notesStr = e.notes ? ` — *${e.notes}*` : '';
    return `**${i + 1}.** \`${e.levelId}\` — ${platform} ${e.username}${notesStr}`;
  });

  embed.setDescription(lines.join('\n'));
  embed.setFooter({ text: `${_queue.length} level${_queue.length === 1 ? '' : 's'} in queue` });
  return embed;
}

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
        o.setName('user').setDescription('The username to remove').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('toggle').setDescription('Enable or disable the level queue'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: false });
  const cmd = interaction.commandName;

  // /next
  if (cmd === 'next') {
    if (!_enabled) {
      return interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(GD_BLUE).setDescription('⚠️ The queue is currently disabled.'),
      ]});
    }

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
        { name: 'Level ID',     value: `\`${entry.levelId}\``,          inline: true },
        { name: 'Requested by', value: `(${platform}) ${entry.username}`, inline: true },
      )
      .setFooter({ text: `${_queue.length} level${_queue.length === 1 ? '' : 's'} remaining` })
      .setTimestamp();
    if (entry.notes) {
      embed.addFields({ name: 'Notes', value: entry.notes, inline: false });
    }
    return interaction.editReply({ embeds: [embed] });
  }

  // /queue subcommands
  if (cmd === 'queue') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'toggle') {
      _enabled = !_enabled;
      log.info(`[gd-queue] Queue ${_enabled ? 'enabled' : 'disabled'} by Discord command`);
      return interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setColor(GD_BLUE)
          .setDescription(_enabled
            ? '✅ Level queue is now **open** — viewers can submit levels.'
            : '🔒 Level queue is now **closed** — submissions are paused.'),
      ]});
    }

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
  commands: [commandNext, commandQueue],
  handleInteraction,
  processMessage,
  onChatReady,
};