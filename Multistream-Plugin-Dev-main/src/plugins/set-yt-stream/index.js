'use strict';

/**
 * add-yt-stream plugin
 * ─────────────────────
 * Adds an /add-yt-stream Discord slash command that lets mods point the bot at
 * an additional YouTube video ID without restarting.
 *
 * Accepts any of:
 * https://www.youtube.com/watch?v=dQw4w9WgXcQ
 * https://youtu.be/dQw4w9WgXcQ
 * https://www.youtube.com/live/dQw4w9WgXcQ
 * dQw4w9WgXcQ   (bare ID)
 *
 * On success it calls youtube.triggerVideo() (provided via init(context))
 * which starts a new masterchat session for that video ID alongside any
 * existing streams.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const log = require('../../logger');

// ── Plugin context (set in init) ───────────────────────────────────────────

let _youtube = null;
let _queue   = null;

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
  id: 'add-yt-stream',

  init(context) {
    _youtube = context.youtube ?? null;
    _queue   = context.queue   ?? null;
    if (!_youtube) log.warn('[add-yt-stream] youtube module not in init context — slash command will be disabled');
    if (!_queue)   log.warn('[add-yt-stream] queue not in init context — triggerVideo will be unavailable');
  },

  command: new SlashCommandBuilder()
    .setName('add-yt-stream')
    .setDescription('Add an additional YouTube stream to monitor')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption(o =>
      o
        .setName('url')
        .setDescription('YouTube URL or bare video ID (e.g. https://youtu.be/dQw4w9WgXcQ)')
        .setRequired(true),
    ),

  async handleInteraction(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (!_youtube) {
      return interaction.editReply('⚠️ YouTube module not available — cannot add stream.');
    }

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
      // youtube.triggerVideo expects (videoId, queue) — the queue is needed
      // so it can push discovered chat messages into the pipeline.
      _youtube.triggerVideo(videoId, _queue);
    } catch (err) {
      log.error('[add-yt-stream] triggerVideo error:', err.message);
      return interaction.editReply(`⚠️ Failed to start session: ${err.message}`);
    }

    log.info(`[add-yt-stream] ${interaction.user.tag} added YouTube stream ${videoId}`);
    return interaction.editReply(
      `✅ Now monitoring YouTube stream \`${videoId}\`\n` +
      `<https://www.youtube.com/watch?v=${videoId}>\n` +
      `A new chat session will start momentarily (or is already running).`,
    );
  },

  // This plugin doesn't touch the chat message pipeline
  async processMessage(msg) {
    return { message: msg };
  },
};