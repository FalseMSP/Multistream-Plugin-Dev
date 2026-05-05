'use strict';

/**
 * Plugin: repeat-ban
 * ──────────────────
 * Bans users who send the same message more than three times (default: off).
 *
 * "Same message" is compared case-insensitively after collapsing whitespace.
 * The count resets if the user sends a different message.
 * The history is also cleared when the toggle is turned off.
 *
 * Discord slash commands:
 *   /repeatban toggle  — enable or disable the plugin
 *   /repeatban status  — show whether the plugin is on or off
 *   /repeatban clear   — clear the tracked message history for all users
 *   /repeatban pardons <user> — clear a specific user's history (un-flag them)
 *
 * Ban mechanics:
 *   - Twitch: issues a /ban via the chat reply handler
 *   - YouTube: issues a /ban via the chat reply handler (if supported by your
 *     YouTube integration; otherwise logs a warning and does nothing)
 *
 * The plugin emits an overlay section so you can see the current state on
 * stream if you want, but it intentionally shows no private user data —
 * just the enabled/disabled status and the total number of tracked users.
 */

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');
const { registerSection, updateSection } = require('../../overlay-server');

// ── Constants ─────────────────────────────────────────────────────────────

const REPEAT_LIMIT = 3; // ban on the (REPEAT_LIMIT + 1)-th identical message
const ACCENT_COLOR = 0xff4444;

// ── State ─────────────────────────────────────────────────────────────────
// _history: Map<lowercaseUsername, { normalised: string, count: number }>

let _enabled = false;
const _history = new Map();

// Injected by onChatReady()
let _chatReply = { twitch: null, youtube: null };

// ── Helpers ───────────────────────────────────────────────────────────────

/** Normalise a message for comparison: lowercase + collapse whitespace. */
function _normalise(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function _clearUser(username) {
  _history.delete(username.toLowerCase());
}

function _clearAll() {
  _history.clear();
}

function _notify() {
  updateSection('repeat-ban', { enabled: _enabled, trackedUsers: _history.size });
}

// ── Overlay ───────────────────────────────────────────────────────────────

registerSection('repeat-ban', {
  title: 'Repeat-Ban',
  order: 20,
  icon: `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="11" r="9" stroke="#ff4444" stroke-width="1.4"/>
    <line x1="5" y1="5" x2="17" y2="17" stroke="#ff4444" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`,
  render: (function render(data, el, esc, { card, badge }) {
    if (!data) { el.innerHTML = ''; return; }
    const { enabled, trackedUsers } = data;

    card.dataset.state = enabled ? '' : 'closed';
    badge.textContent  = enabled ? 'ON' : 'OFF';

    el.innerHTML = '<div class="msg ' + (enabled ? 'msg-active' : 'msg-closed') + '">'
      + (enabled
          ? 'AUTO-BAN ACTIVE — tracking ' + trackedUsers + ' user' + (trackedUsers === 1 ? '' : 's')
          : 'AUTO-BAN DISABLED')
      + '</div>';
  }).toString(),
});

// ── processMessage ────────────────────────────────────────────────────────

async function processMessage(msg) {
  if (!_enabled) return { message: msg };

  const key        = msg.username.toLowerCase();
  const normalised = _normalise(msg.message);

  // Ignore empty messages (shouldn't happen, but be safe)
  if (!normalised) return { message: msg };

  const entry = _history.get(key);

  if (entry && entry.normalised === normalised) {
    entry.count += 1;

    if (entry.count > REPEAT_LIMIT) {
      // Ban the user
      log.warn(`[repeat-ban] Banning ${msg.username} (${msg.platform}) — repeated "${normalised}" ${entry.count} times`);

      const send = _chatReply[msg.platform];
      if (send) {
        send(`/ban ${msg.username} Repeated the same message more than ${REPEAT_LIMIT} times.`)
          .catch(e => log.error('[repeat-ban] ban command error:', e.message));
      } else {
        log.warn(`[repeat-ban] No chat reply handler for platform "${msg.platform}" — cannot issue ban.`);
      }

      // Clean up so if they return they get a fresh slate
      _history.delete(key);
      _notify();

      // Suppress the offending message from Discord relay
      return { message: null };
    }
  } else {
    // Different message (or first message) — reset their counter
    _history.set(key, { normalised, count: 1 });
  }

  _notify();
  return { message: msg };
}

// ── Slash commands ────────────────────────────────────────────────────────

const commandRepeatBan = new SlashCommandBuilder()
  .setName('repeatban')
  .setDescription('Manage the repeat-message auto-ban plugin')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('toggle').setDescription('Enable or disable the auto-ban'))
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Show whether the auto-ban is on or off'))
  .addSubcommand(sub =>
    sub.setName('clear').setDescription('Clear all tracked message history'))
  .addSubcommand(sub =>
    sub.setName('pardon')
      .setDescription("Clear a specific user's message history")
      .addStringOption(o =>
        o.setName('user').setDescription('The username to pardon').setRequired(true)));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: false });
  const sub = interaction.options.getSubcommand();

  if (sub === 'toggle') {
    _enabled = !_enabled;
    if (!_enabled) _clearAll(); // wipe history when disabling
    _notify();
    log.info(`[repeat-ban] ${_enabled ? 'Enabled' : 'Disabled'} by Discord command`);
    return interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setColor(ACCENT_COLOR)
        .setDescription(_enabled
          ? `✅ Repeat-ban is now **ON** — users who send the same message more than ${REPEAT_LIMIT} times will be banned.`
          : '🔒 Repeat-ban is now **OFF** — message history cleared.'),
    ]});
  }

  if (sub === 'status') {
    return interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setColor(ACCENT_COLOR)
        .setTitle('Repeat-Ban Status')
        .setDescription(_enabled
          ? `✅ **ON** — banning after ${REPEAT_LIMIT} identical messages.\nCurrently tracking **${_history.size}** user${_history.size === 1 ? '' : 's'}.`
          : '🔒 **OFF** — no auto-bans in effect.'),
    ]});
  }

  if (sub === 'clear') {
    const count = _history.size;
    _clearAll();
    _notify();
    log.info('[repeat-ban] History cleared by Discord command');
    return interaction.editReply(`🗑️ Cleared message history for ${count} user${count === 1 ? '' : 's'}.`);
  }

  if (sub === 'pardon') {
    const user = interaction.options.getString('user');
    if (!_history.has(user.toLowerCase())) {
      return interaction.editReply(`⚠️ No tracked history found for **${user}**.`);
    }
    _clearUser(user);
    _notify();
    log.info(`[repeat-ban] Pardoned ${user} via Discord command`);
    return interaction.editReply(`✅ Cleared message history for **${user}** — their repeat count has been reset.`);
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ── Plugin lifecycle ──────────────────────────────────────────────────────

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[repeat-ban] Chat reply handlers registered.');
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = {
  id: 'repeat-ban',
  commands: [commandRepeatBan],
  handleInteraction,
  processMessage,
  onChatReady,
};