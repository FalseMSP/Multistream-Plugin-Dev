'use strict';

/**
 * set-yt-stream plugin
 * ─────────────────────
 * Adds a /set-yt-stream Discord slash command that lets mods point the bot at
 * a specific YouTube video ID without restarting.
 *
 * Accepts any of:
 *   https://www.youtube.com/watch?v=dQw4w9WgXcQ
 *   https://youtu.be/dQw4w9WgXcQ
 *   https://www.youtube.com/live/dQw4w9WgXcQ
 *   dQw4w9WgXcQ   (bare ID)
 *
 * On success it calls triggerVideo() from the YouTube module, which starts a
 * new masterchat session for that video ID (no-op if one is already running).
 *
 * Usage: drop in src/plugins/set-yt-stream/index.js
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const log          = require('../../logger');
// queue is a module-level singleton — safe to require directly at load time.
const queue        = require('../../queue');
const { triggerVideo } = require('../../youtube');

// ── Video ID extraction ───────────────────────────────────────────────────

const YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function _extractVideoId(input) {
  const s = (input ?? '').trim();
  if (!s) return null;

  // Bare 11-char ID
  if (YT_ID_RE.test(s)) return s;

  try {
    const url = new URL(s);

    // youtu.be/<id>
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return YT_ID_RE.test(id) ? id : null;
    }

    // youtube.com/watch?v=<id>
    const v = url.searchParams.get('v');
    if (v && YT_ID_RE.test(v)) return v;

    // youtube.com/live/<id>  or  youtube.com/shorts/<id>
    const pathId = url.pathname.split('/').find(seg => YT_ID_RE.test(seg));
    if (pathId) return pathId;
  } catch {
    // Not a URL — fall through
  }

  return null;
}

// ── Plugin ────────────────────────────────────────────────────────────────

module.exports = {
  id: 'set-yt-stream',

  command: new SlashCommandBuilder()
    .setName('set-yt-stream')
    .setDescription('Point the bot at a specific YouTube stream URL or video ID')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption(o =>
      o
        .setName('url')
        .setDescription('YouTube URL or bare video ID (e.g. https://youtu.be/dQw4w9WgXcQ)')
        .setRequired(true),
    ),

  async handleInteraction(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const raw     = interaction.options.getString('url', true);
    const videoId = _extractVideoId(raw);

    if (!videoId) {
      return interaction.editReply(
        `⚠️ Couldn't find a valid YouTube video ID in: \`${raw}\`\n` +
        `Accepted formats:\n` +
        `• \`https://www.youtube.com/watch?v=VIDEO_ID\`\n` +
        `• \`https://youtu.be/VIDEO_ID\`\n` +
        `• \`https://www.youtube.com/live/VIDEO_ID\`\n` +
        `• \`VIDEO_ID\` (11-character ID)`,
      );
    }

    try {
      triggerVideo(videoId, queue);
    } catch (err) {
      log.error('[set-yt-stream] triggerVideo error:', err.message);
      return interaction.editReply(`⚠️ Failed to start session: ${err.message}`);
    }

    log.info(`[set-yt-stream] ${interaction.user.tag} set YouTube stream to ${videoId}`);
    return interaction.editReply(
      `✅ YouTube stream set to \`${videoId}\`\n` +
      `<https://www.youtube.com/watch?v=${videoId}>\n` +
      `A new chat session will start momentarily (or is already running).`,
    );
  },

  // This plugin doesn't touch the chat message pipeline
  async processMessage(msg) {
    return { message: msg };
  },
};