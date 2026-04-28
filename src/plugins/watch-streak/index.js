'use strict';

/**
 * watch-streak plugin
 *
 * Tracks how many consecutive stream-days a YouTube viewer has interacted.
 *
 * Rules:
 *  - A viewer earns credit for a date the first time they send ANY message
 *    on YouTube during an active stream session on that date.
 *  - Multiple streams on the same calendar date count as one — catching any
 *    of them is enough; missing the others on that day doesn't break the streak.
 *  - When a new stream session starts, anyone whose last-seen date is more than
 *    one calendar day before today has their streak reset to 0.
 *  - Streaks are written to disk so they survive bot restarts.
 *
 * Slash commands:
 *   /streak user:<name>   — look up a specific viewer's streak
 *   /streaks              — leaderboard of top 10 streaks
 */

const fs   = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const log  = require('../../logger');

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const DATA_PATH = path.join(__dirname, 'streaks.json');

/** @type {{ [username: string]: { streak: number, lastDate: string } }} */
let _data = {};

function _load() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      _data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      log.info(`[watch-streak] Loaded ${Object.keys(_data).length} streak records.`);
    }
  } catch (e) {
    log.error('[watch-streak] Failed to load streaks.json:', e.message);
    _data = {};
  }
}

function _save() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(_data, null, 2), 'utf8');
  } catch (e) {
    log.error('[watch-streak] Failed to save streaks.json:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Returns today's date as a YYYY-MM-DD string (local time). */
function _today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Returns the number of whole calendar days between two YYYY-MM-DD strings. */
function _daysBetween(a, b) {
  const msPerDay = 86_400_000;
  return Math.round((new Date(b) - new Date(a)) / msPerDay);
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/** Date string for the current stream session (set when first message arrives). */
let _sessionDate = null;

/**
 * Usernames that have already been credited during this session.
 * Prevents a second message in the same session from double-incrementing.
 */
const _creditedThisSession = new Set();

/**
 * Called once per session when the first YouTube message arrives.
 * Resets streaks for anyone who missed the previous session date.
 */
function _startSession(today) {
  if (_sessionDate === today) return; // already initialised for today

  log.info(`[watch-streak] New session detected for date ${today}.`);
  _sessionDate = today;
  _creditedThisSession.clear();

  // Reset streaks for viewers who missed the last stream
  let resetCount = 0;
  for (const [user, record] of Object.entries(_data)) {
    if (!record.lastDate) continue;
    const gap = _daysBetween(record.lastDate, today);
    if (gap > 1) {
      log.info(`[watch-streak] Resetting streak for ${user} (last seen ${record.lastDate}, gap ${gap} days).`);
      record.streak  = 0;
      record.lastDate = null;
      resetCount++;
    }
  }

  if (resetCount > 0) {
    _save();
    log.info(`[watch-streak] Reset ${resetCount} streak(s) for missed stream.`);
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Credit a viewer for today's stream.
 * Returns the new streak value, or null if they were already credited today.
 */
function _credit(username, today) {
  if (_creditedThisSession.has(username)) return null; // already counted this session
  _creditedThisSession.add(username);

  const record = _data[username] ?? { streak: 0, lastDate: null };

  if (record.lastDate === today) {
    // Edge case: bot restarted mid-stream — don't double-count
    _data[username] = record;
    return null;
  }

  record.streak  += 1;
  record.lastDate = today;
  _data[username] = record;

  _save();
  return record.streak;
}

// ---------------------------------------------------------------------------
// processMessage
// ---------------------------------------------------------------------------

async function processMessage(msg) {
  if (msg.platform !== 'youtube') return { message: msg };

  const today = _today();
  _startSession(today);

  const newStreak = _credit(msg.username, today);

  if (newStreak !== null) {
    log.info(`[watch-streak] ${msg.username} — streak now ${newStreak} day(s).`);

    // Milestone announcements (optional — remove if you don't want chat messages)
    if (_chatReply.youtube && [7, 14, 30, 50, 100].includes(newStreak)) {
      _chatReply.youtube(
        `🔥 ${msg.username} has watched ${newStreak} streams in a row — incredible streak!`
      ).catch(e => log.error('[watch-streak] chat reply error:', e.message));
    }
  }

  return { message: msg }; // always pass messages through
}

// ---------------------------------------------------------------------------
// onChatReady
// ---------------------------------------------------------------------------

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  log.info('[watch-streak] Chat reply handlers registered.');
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const commandStreak = new SlashCommandBuilder()
  .setName('streak')
  .setDescription("Look up a viewer's watch streak")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addStringOption(o =>
    o.setName('user')
      .setDescription('YouTube username to look up')
      .setRequired(true));

const commandStreaks = new SlashCommandBuilder()
  .setName('streaks')
  .setDescription('Show the top-10 watch streak leaderboard')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: false });

  if (interaction.commandName === 'streak') {
    const user   = interaction.options.getString('user');
    const record = _data[user];

    if (!record || record.streak === 0) {
      return interaction.editReply(`No streak found for **${user}** — they may not have chatted yet.`);
    }

    const lastSeen = record.lastDate ?? 'unknown';
    return interaction.editReply(
      `📺 **${user}** has a watch streak of **${record.streak}** day(s) ` +
      `(last seen: ${lastSeen}).`
    );
  }

  if (interaction.commandName === 'streaks') {
    const top = Object.entries(_data)
      .filter(([, r]) => r.streak > 0)
      .sort(([, a], [, b]) => b.streak - a.streak)
      .slice(0, 10);

    if (top.length === 0) {
      return interaction.editReply('No streaks recorded yet.');
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = top.map(([user, r], i) => {
      const medal = medals[i] ?? `**${i + 1}.**`;
      return `${medal} **${user}** — ${r.streak} day(s) (last seen: ${r.lastDate})`;
    });

    return interaction.editReply(`📺 **Watch Streak Leaderboard**\n\n${lines.join('\n')}`);
  }

  return interaction.editReply('⚠️ Unknown command.');
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function init() {
  _load();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

module.exports = {
  id: 'watch-streak',
  init,
  onChatReady,
  processMessage,
  commands: [commandStreak, commandStreaks],
  handleInteraction,
};