'use strict';

/**
 * watch-streak plugin
 *
 * Tracks how many consecutive stream-days a viewer has chatted, across
 * both YouTube and Twitch.
 *
 * Rules:
 *  - A viewer earns credit for a date the first time they send ANY message
 *    on either platform during an active stream session on that date.
 *  - Multiple streams on the same calendar date count as one — catching any
 *    of them is enough; missing the others on that day doesn't break the streak.
 *  - When a new stream session starts, anyone whose last-seen date is more than
 *    one calendar day before today has their streak reset to 0.
 *  - Streaks are written to disk so they survive bot restarts.
 *  - When a Twitch viewer clicks "Share Watch Streak", their self-reported
 *    count is written directly to the db if it exceeds the stored value.
 *    Requires twitch.js to emit { type: 'watch-streak', streak: N } on
 *    USERNOTICE viewermilestone events (see accompanying twitch.js change).
 *  - Milestone announcements fire on YouTube only — never in Twitch chat.
 *
 * Channel points (per-stream streak bonus):
 *  - Points are awarded every stream a viewer attends as part of a streak,
 *    mirroring Twitch's exact watch-streak bonus schedule:
 *      streak 1  → no bonus
 *      streak 2  → +300 points
 *      streak 3  → +350 points
 *      streak 4  → +400 points
 *      streak 5+ → +450 points (flat)
 *  - Applies to both platforms — YouTube viewers earn points too.
 *  - Requires a points plugin registered via onPointsReady().
 *    The plugin must expose: awardPoints(username, platform, amount, reason) → Promise<void>
 *  - For a Twitch streak-share that jumps the count by multiple steps, only
 *    the bonus for the final streak value is awarded (matches Twitch behaviour).
 *
 * Data format (streaks.json):
 *   Keys are "platform:username" (e.g. "twitch:Alice", "youtube:Bob").
 *   Each record: { streak, lastDate }
 *   If upgrading from a previous version that used bare username keys,
 *   manually prefix existing keys with "youtube:" to preserve history.
 *
 * Slash commands:
 *   /streak user:<name> [platform]  — look up a viewer's streak(s)
 *   /streaks [platform]             — leaderboard of top 10 streaks
 */

const fs   = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const log  = require('../../logger');

// ---------------------------------------------------------------------------
// Streak point rewards — mirrors Twitch's exact watch-streak bonus schedule.
//
// Points are awarded every stream (not just at sparse milestones).
// The amount depends on where the viewer is in their current streak:
//   streak 1  → no bonus (first attendance, no streak yet)
//   streak 2  → +300 points
//   streak 3  → +350 points
//   streak 4  → +400 points
//   streak 5+ → +450 points (flat forever)
// ---------------------------------------------------------------------------

/**
 * Returns the channel-point bonus for attending stream number `streak` in a row.
 * Returns 0 for streak === 1 (no bonus on first attendance).
 * @param {number} streak
 * @returns {number}
 */
function _streakPoints(streak) {
  if (streak <= 1) return 0;
  if (streak === 2) return 300;
  if (streak === 3) return 350;
  if (streak === 4) return 400;
  return 450; // 5+
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const DATA_PATH = path.join(__dirname, 'streaks.json');

/** @type {{ [key: string]: { streak: number, lastDate: string | null } }} */
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
 * Called once per session when the first message arrives on any platform.
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
// Points plugin bridge
// ---------------------------------------------------------------------------

/**
 * The points plugin, once registered via onPointsReady().
 * Must expose: awardPoints(username, platform, amount, reason) → Promise<void>
 */
let _pointsPlugin = null;

function onPointsReady(plugin) {
  _pointsPlugin = plugin;
  log.info('[watch-streak] Points plugin registered.');
}

/**
 * Award the per-stream streak bonus for the viewer's current streak count.
 * Called once per session after the streak is incremented (or set via share).
 *
 * @param {string} username
 * @param {string} platform
 * @param {number} streak  — the new streak value after crediting this session
 */
async function _awardStreakPoints(username, platform, streak) {
  if (!_pointsPlugin) return;

  const points = _streakPoints(streak);
  if (points === 0) return; // streak 1 — no bonus

  const reason = `Watch streak day ${streak} bonus`;
  log.info(`[watch-streak] Awarding ${points} points to ${platform}/${username} (streak ${streak}).`);
  try {
    await _pointsPlugin.awardPoints(username, points, reason);
  } catch (e) {
    log.error(`[watch-streak] Failed to award points to ${platform}/${username}:`, e.message);
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Credit a viewer for today's stream.
 * Returns the new streak value, or null if they were already credited today.
 */
function _credit(username, platform, today) {
  const key = `${platform}:${username}`;
  if (_creditedThisSession.has(key)) return null; // already counted this session
  _creditedThisSession.add(key);

  const record = _data[key] ?? { streak: 0, lastDate: null };

  if (record.lastDate === today) {
    // Edge case: bot restarted mid-stream — don't double-count
    _data[key] = record;
    return null;
  }

  record.streak  += 1;
  record.lastDate = today;
  _data[key] = record;

  _save();
  return record.streak;
}

// ---------------------------------------------------------------------------
// processMessage
// ---------------------------------------------------------------------------

async function processMessage(msg) {
  if (msg.platform !== 'youtube' && msg.platform !== 'twitch') return { message: msg };

  const today = _today();
  _startSession(today);

  // ── Twitch watch-streak share (USERNOTICE viewermilestone) ───────────────
  // The viewer explicitly shared their streak count — trust it and write it
  // directly to the db if it's higher than what we have recorded.
  if (msg.platform === 'twitch' && msg.type === 'watch-streak') {
    const reported = msg.streak;
    const key      = `twitch:${msg.username}`;
    const existing = _data[key] ?? { streak: 0, lastDate: null };

    if (reported > existing.streak) {
      existing.streak   = reported;
      existing.lastDate = today;
      _data[key] = existing;
      _save();
      log.info(`[watch-streak] Twitch streak share: ${msg.username} reported ${reported} — updated.`);

      // Award the bonus for the reported streak value (one award per share event)
      await _awardStreakPoints(msg.username, 'twitch', reported);
    } else {
      log.info(`[watch-streak] Twitch streak share: ${msg.username} reported ${reported} (already have ${existing.streak}) — no update.`);
    }

    // Also credit them for today so the normal increment path doesn't fire
    _creditedThisSession.add(key);

    // Pass the message through so Discord still sees the share notification
    return { message: msg };
  }

  // ── Normal message — credit for today ────────────────────────────────────
  const newStreak = _credit(msg.username, msg.platform, today);

  if (newStreak !== null) {
    log.info(`[watch-streak] ${msg.platform}/${msg.username} — streak now ${newStreak} day(s).`);

    // Award per-stream streak bonus
    await _awardStreakPoints(msg.username, msg.platform, newStreak);

    // Milestone announcements — YouTube only (not Twitch chat)
    if (msg.platform === 'youtube' && [7, 14, 30, 50, 100].includes(newStreak)) {
      const send = _chatReply.youtube;
      if (send) {
        send(
          `🔥 ${msg.username} has watched ${newStreak} streams in a row — incredible streak!`
        ).catch(e => log.error('[watch-streak] chat reply error:', e.message));
      }
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
      .setDescription('Username to look up')
      .setRequired(true))
  .addStringOption(o =>
    o.setName('platform')
      .setDescription('Platform (default: shows best streak across both)')
      .setRequired(false)
      .addChoices(
        { name: 'YouTube', value: 'youtube' },
        { name: 'Twitch',  value: 'twitch'  },
      ));

const commandStreaks = new SlashCommandBuilder()
  .setName('streaks')
  .setDescription('Show the top-10 watch streak leaderboard')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addStringOption(o =>
    o.setName('platform')
      .setDescription('Filter by platform (default: all)')
      .setRequired(false)
      .addChoices(
        { name: 'YouTube', value: 'youtube' },
        { name: 'Twitch',  value: 'twitch'  },
      ));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: false });

  if (interaction.commandName === 'streak') {
    const user     = interaction.options.getString('user');
    const platform = interaction.options.getString('platform'); // may be null

    if (platform) {
      // Specific platform requested
      const key    = `${platform}:${user}`;
      const record = _data[key];
      const emoji  = platform === 'twitch' ? '🟣' : '🔴';

      if (!record || record.streak === 0) {
        return interaction.editReply(`No ${platform} streak found for **${user}**.`);
      }
      return interaction.editReply(
        `${emoji} **${user}** (${platform}) has a watch streak of **${record.streak}** day(s) ` +
        `(last seen: ${record.lastDate}).`
      );
    }

    // No platform specified — show both if present
    const yt  = _data[`youtube:${user}`];
    const tw  = _data[`twitch:${user}`];

    if ((!yt || yt.streak === 0) && (!tw || tw.streak === 0)) {
      return interaction.editReply(`No streak found for **${user}** — they may not have chatted yet.`);
    }

    const lines = [];
    if (yt?.streak > 0) lines.push(`🔴 YouTube: **${yt.streak}** day(s) (last seen: ${yt.lastDate})`);
    if (tw?.streak > 0) lines.push(`🟣 Twitch: **${tw.streak}** day(s) (last seen: ${tw.lastDate})`);

    return interaction.editReply(`📺 **${user}**\n${lines.join('\n')}`);
  }

  if (interaction.commandName === 'streaks') {
    const platform = interaction.options.getString('platform'); // may be null

    const entries = Object.entries(_data)
      .filter(([key, r]) => r.streak > 0 && (!platform || key.startsWith(`${platform}:`)))
      .map(([key, r]) => {
        const colonIdx = key.indexOf(':');
        const plat     = key.slice(0, colonIdx);
        const name     = key.slice(colonIdx + 1);
        return { plat, name, streak: r.streak, lastDate: r.lastDate };
      })
      .sort((a, b) => b.streak - a.streak)
      .slice(0, 10);

    if (entries.length === 0) {
      return interaction.editReply('No streaks recorded yet.');
    }

    const medals    = ['🥇', '🥈', '🥉'];
    const platEmoji = { youtube: '🔴', twitch: '🟣' };
    const lines     = entries.map((e, i) => {
      const medal = medals[i] ?? `**${i + 1}.**`;
      const tag   = platform ? '' : ` ${platEmoji[e.plat] ?? ''}`;
      return `${medal}${tag} **${e.name}** — ${e.streak} day(s) (last seen: ${e.lastDate})`;
    });

    const title = platform
      ? `📺 **Watch Streak Leaderboard — ${platform.charAt(0).toUpperCase() + platform.slice(1)}**`
      : '📺 **Watch Streak Leaderboard — All Platforms**';

    return interaction.editReply(`${title}\n\n${lines.join('\n')}`);
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
  onPointsReady,
  processMessage,
  commands: [commandStreak, commandStreaks],
  handleInteraction,
};