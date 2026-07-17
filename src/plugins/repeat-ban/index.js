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
 *   - Twitch: calls twitch.ban(username, reason) — a real Helix ban via the
 *     broadcaster user OAuth token, not a chat-string /ban.
 *   - YouTube: calls youtube.ban(username) — a real live-chat ban via the
 *     YouTube Data API.
 *
 * The plugin emits an overlay section so you can see the current state on
 * stream if you want, but it intentionally shows no private user data —
 * just the enabled/disabled status and the total number of tracked users.
 */

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');
const { registerSection, updateSection } = require('../../overlay-server');

// ── Plugin context (set in init) ───────────────────────────────────────────

let _twitch  = null;
let _youtube = null;

// ── Constants ─────────────────────────────────────────────────────────────

const REPEAT_LIMIT = 3; // ban on the (REPEAT_LIMIT + 1)-th identical message
const ACCENT_COLOR = 0xff4444;

// ── State ─────────────────────────────────────────────────────────────────
// _history: Map<lowercaseUsername, { normalised: string, count: number }>

let _enabled = false;
const _history = new Map();

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

/**
 * Issue a real platform ban via the twitch / youtube modules' public APIs.
 * Falls back to a warning log if the platform isn't available.
 */
async function _banUser(platform, username, reason) {
  try {
    if (platform === 'twitch' && _twitch) {
      await _twitch.ban(username, reason);
      log.info(`[repeat-ban] Twitch ban applied to ${username}`);
    } else if (platform === 'youtube' && _youtube) {
      await _youtube.ban(username);
      log.info(`[repeat-ban] YouTube ban applied to ${username}`);
    } else {
      log.warn(`[repeat-ban] No ban API available for platform "${platform}" — cannot ban ${username}.`);
    }
  } catch (err) {
    log.error(`[repeat-ban] Failed to ban ${username} on ${platform}:`, err.message);
  }
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
  const normalised = _normalise(msg.message ?? '');

  // Ignore empty messages (shouldn't happen, but be safe)
  if (!normalised) return { message: msg };

  const entry = _history.get(key);

  if (entry && entry.normalised === normalised) {
    entry.count += 1;

    if (entry.count > REPEAT_LIMIT) {
      // Ban the user via the proper platform API.
      const reason = `Repeated the same message more than ${REPEAT_LIMIT} times.`;
      log.warn(`[repeat-ban] Banning ${msg.username} (${msg.platform}) — repeated "${normalised}" ${entry.count} times`);
      // Fire-and-forget — ban may take a moment but we don't want to hold up
      // the chat pipeline. Errors are caught and logged inside _banUser.
      _banUser(msg.platform, msg.username, reason);

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

function init(context) {
  _twitch  = context.twitch  ?? null;
  _youtube = context.youtube ?? null;
  if (!_twitch)  log.warn('[repeat-ban] twitch module not in init context — Twitch bans will not work');
  if (!_youtube) log.warn('[repeat-ban] youtube module not in init context — YouTube bans will not work');
  log.info('[repeat-ban] Plugin loaded.');
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = {
  id: 'repeat-ban',
  init,
  commands: [commandRepeatBan],
  handleInteraction,
  processMessage,
};