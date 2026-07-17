'use strict';

/**
 * poll plugin
 * ───────────
 * Slash commands:
 *   /poll start  title:<text> options:<a,b,c> duration:<seconds> type:<poll|prediction> platform:<both|twitch|youtube>
 *   /poll end
 *   /poll status
 *
 * Twitch:
 *   - type:poll        → creates a real Twitch channel poll via twitch.createPoll()
 *   - type:prediction  → creates a real Twitch prediction via twitch.createPrediction()
 *
 * YouTube:
 *   - Always chat-based (YouTube API has no live poll/prediction endpoint)
 *   - Posts the question + numbered options to YouTube chat
 *   - Listens for messages containing "1", "2", "3", etc. (first vote per user wins)
 *   - /poll end or duration expiry posts results to both YouTube chat and Discord
 *
 * Required env vars:
 *   DISCORD_CHAT_WEBHOOK_URL  — for result embeds
 *   .twitch-tokens.json      — broadcaster OAuth token file written by twitch-auth.js
 *                              (requires scopes: channel:manage:polls, channel:manage:predictions)
 *
 * Note: This plugin uses the public twitch module APIs (createPoll, endPoll,
 * getPoll, createPrediction, endPrediction, getBroadcasterId) instead of
 * reimplementing Helix token plumbing. The previous version had ~150 lines
 * of duplicate Helix code (token refresh, app token, broadcaster ID resolution)
 * that have all been removed in favour of the shared twitch.js helpers.
 */

const { SlashCommandBuilder, EmbedBuilder, WebhookClient, PermissionFlagsBits } = require('discord.js');
const log     = require('../../logger');
const overlay = require('../../overlay-server');

// ── Env / config ──────────────────────────────────────────────────────────

const CHAT_WEBHOOK_URL = process.env.DISCORD_CHAT_WEBHOOK_URL ?? '';

// ── Plugin context (set in init) ───────────────────────────────────────────

let _twitch = null;

// ── Discord webhook (for result embeds) ───────────────────────────────────

let _webhook = null;
function _getWebhook() {
  if (!_webhook && CHAT_WEBHOOK_URL) _webhook = new WebhookClient({ url: CHAT_WEBHOOK_URL });
  return _webhook;
}

// ── Chat reply ────────────────────────────────────────────────────────────

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
}

// ── Active poll state ─────────────────────────────────────────────────────

/**
 * @type {{
 *   type:       'poll' | 'prediction',
 *   title:      string,
 *   options:    string[],
 *   platforms:  string[],
 *   startedAt:  Date,
 *   durationMs: number,
 *   timer:      NodeJS.Timeout | null,
 *
 *   // Twitch
 *   twitchPollId:       string | null,
 *   twitchPredictionId: string | null,
 *
 *   // YouTube chat voting
 *   ytVotes:   { [option_index: string]: number },
 *   ytVoters:  Set<string>,
 *   twitchVotes: { [option_index: string]: number },
 *   pollInterval: NodeJS.Timeout | null,
 * } | null}
 */
let _active = null;

// ── Twitch poll/prediction helpers (thin wrappers over twitch.js public API) ──

async function _createTwitchPoll(title, options, durationSec) {
  if (!_twitch) throw new Error('twitch module not in init context');
  const poll = await _twitch.createPoll({ title, choices: options, duration: durationSec });
  return poll?.id ?? null;
}

async function _endTwitchPoll(pollId) {
  return _twitch.endPoll(pollId, true);
}

async function _createTwitchPrediction(title, options, durationSec) {
  const pred = await _twitch.createPrediction({ title, outcomes: options, duration: durationSec });
  return pred?.id ?? null;
}

async function _endTwitchPrediction(predictionId, winningIndex) {
  // First LOCK it, then RESOLVE it (or CANCEL if no winner)
  const locked = await _twitch.endPrediction(predictionId, 'LOCK');

  const outcomes = locked?.outcomes ?? [];

  if (winningIndex !== null && winningIndex !== undefined && outcomes[winningIndex]) {
    return _twitch.endPrediction(predictionId, 'RESOLVED', outcomes[winningIndex].id);
  }
  return _twitch.endPrediction(predictionId, 'CANCEL', undefined);
}

async function _fetchTwitchVotes() {
  if (!_active) return;
  try {
    if (_active.twitchPollId) {
      const poll = await _twitch.getPoll(_active.twitchPollId);
      if (poll) {
        (poll.choices ?? []).forEach((choice, i) => {
          _active.twitchVotes[i] = (choice.votes ?? 0) + (choice.channel_points_votes ?? 0);
        });
      }
    } else if (_active.twitchPredictionId) {
      // Helix prediction status is fetched via helixUserRequest because we
      // don't have a dedicated getPrediction helper — predictions have a
      // different response shape than polls and aren't worth a dedicated
      // helper just for this one read path.
      const data = await _twitch.helixUserRequest(
        'GET',
        `/predictions?broadcaster_id=${await _twitch.getBroadcasterId()}&id=${_active.twitchPredictionId}`
      );
      const pred = data?.data?.[0];
      if (pred) {
        (pred.outcomes ?? []).forEach((outcome, i) => {
          _active.twitchVotes[i] = outcome.channel_points ?? 0;
        });
      }
    }
    _pushOverlay();
  } catch (e) {
    log.debug('[poll] Twitch live fetch error:', e.message);
  }
}

// ── YouTube chat voting helpers ───────────────────────────────────────────

/** Post the poll question to YouTube chat. */
async function _postYtPollMessage(title, options, durationSec) {
  const send = _chatReply.youtube;
  if (!send) { log.warn('[poll] No YouTube chat reply — cannot post poll'); return; }

  const lines = [
    `📊 ${title}`,
    ...options.map((o, i) => `${i + 1}️⃣  ${o}`),
    `Type 1–${options.length} to vote! (${Math.round(durationSec / 60)} min)`,
  ];

  send(lines.join('  |  ')).catch(e => log.error('[poll] YT post error:', e.message));
}

async function _postYtResultsMessage(title, votes, options) {
  const send = _chatReply.youtube;
  if (!send) return;
  const total = Object.values(votes).reduce((a, b) => a + b, 0) || 1;
  const lines = [
    `📊 Results: ${title}`,
    ...options.map((o, i) => {
      const v   = votes[i] ?? 0;
      const pct = Math.round((v / total) * 100);
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      return `${i + 1}. ${o}  ${bar}  ${v} (${pct}%)`;
    }),
  ];
  send(lines.join('  |  ')).catch(e => log.error('[poll] YT results error:', e.message));
}

// ── Result embed ──────────────────────────────────────────────────────────

async function _postResultsEmbed(state, winningIndex = null, twitchVotes = {}, combinedVotes = null) {
  const wh = _getWebhook();
  if (!wh) return;

  const votes    = combinedVotes ?? state.ytVotes;
  const total    = Object.values(votes).reduce((a, b) => a + b, 0) || 1;
  const ytTotal  = Object.values(state.ytVotes).reduce((a, b) => a + b, 0);
  const twTotal  = Object.values(twitchVotes).reduce((a, b) => a + b, 0);
  const isPrediction  = state.type === 'prediction';
  const twitchLabel   = isPrediction ? 'channel points' : 'votes';

  const fields = state.options.map((opt, i) => {
    const combined  = votes[i] ?? 0;
    const pct       = Math.round((combined / total) * 100);
    const winner    = winningIndex === i ? ' 🏆' : '';
    const yt        = state.ytVotes[i] ?? 0;
    const tw        = twitchVotes[i] ?? 0;
    const breakdown = state.platforms.length > 1
      ? `\nTwitch: ${tw.toLocaleString()} ${twitchLabel}  •  YouTube: ${yt}`
      : '';
    return {
      name:   `${i + 1}. ${opt}${winner}`,
      value:  `**${combined.toLocaleString()}** total (${pct}%)${breakdown}`,
      inline: true,
    };
  });

  const elapsed = Math.round((Date.now() - state.startedAt.getTime()) / 1000);
  const label   = isPrediction ? '🔮 Prediction ended' : '📊 Poll ended';
  const footerParts = [`Ran for ${elapsed}s`];
  if (twTotal) footerParts.push(`${twTotal.toLocaleString()} Twitch ${twitchLabel}`);
  if (ytTotal) footerParts.push(`${ytTotal} YouTube votes`);

  const embed = new EmbedBuilder()
    .setColor(isPrediction ? 0x9146FF : 0x00B4FF)
    .setTitle(`${label}: ${state.title}`)
    .addFields(...fields)
    .setFooter({ text: footerParts.join('  •  ') })
    .setTimestamp();

  wh.send({ embeds: [embed] }).catch(e => log.error('[poll] webhook error:', e.message));
}


function _pushOverlay() {
  if (!_active) return;
  const combinedVotes = Object.fromEntries(
    _active.options.map((_, i) => [i, (_active.ytVotes[i] ?? 0) + (_active.twitchVotes[i] ?? 0)])
  );
  overlay.updatePollOverlay({
    type:          _active.type,
    title:         _active.title,
    options:       _active.options,
    platforms:     _active.platforms,
    startedAt:     _active.startedAt.getTime(),
    durationMs:    _active.durationMs,
    combinedVotes,
  });
}

// ── Start / end logic ─────────────────────────────────────────────────────

async function _startPoll({ title, options, durationSec, type, platforms }) {
  _active = {
    type,
    title,
    options,
    platforms,
    startedAt:          new Date(),
    durationMs:         durationSec * 1000,
    timer:              null,
    twitchPollId:       null,
    twitchPredictionId: null,
    ytVotes:            Object.fromEntries(options.map((_, i) => [i, 0])),
    ytVoters:           new Set(),
    twitchVotes:        Object.fromEntries(options.map((_, i) => [i, 0])),
    pollInterval:       null,
  };
  _pushOverlay();

  const errors = [];

  // Twitch
  if (platforms.includes('twitch')) {
    if (!_twitch) {
      errors.push('Twitch module not available in init context');
    } else {
      try {
        // Ensure broadcaster ID is resolvable before we try to create the poll
        const bid = await _twitch.getBroadcasterId();
        if (!bid) {
          errors.push('Could not resolve Twitch broadcaster ID');
        } else if (type === 'prediction') {
          _active.twitchPredictionId = await _createTwitchPrediction(title, options, durationSec);
          log.info(`[poll] Twitch prediction created: ${_active.twitchPredictionId}`);
        } else {
          _active.twitchPollId = await _createTwitchPoll(title, options, durationSec);
          log.info(`[poll] Twitch poll created: ${_active.twitchPollId}`);
        }
      } catch (e) {
        log.error('[poll] Twitch create error:', e.message);
        errors.push(`Twitch: ${e.message}`);
      }
    }
  }

  // Start live Twitch vote polling (every 5 s) if a Twitch poll/prediction was created
  if (_active.twitchPollId || _active.twitchPredictionId) {
    _active.pollInterval = setInterval(_fetchTwitchVotes, 5000);
  }

  // YouTube
  if (platforms.includes('youtube')) {
    await _postYtPollMessage(title, options, durationSec);
  }

  // Auto-end timer
  _active.timer = setTimeout(() => {
    log.info('[poll] Auto-ending poll after duration.');
    _endPoll(null).catch(e => log.error('[poll] Auto-end error:', e.message));
  }, durationSec * 1000);

  return errors;
}

/**
 * @param {number|null} winningIndex  — for predictions only; null = cancel/no winner
 */
async function _endPoll(winningIndex) {
  if (!_active) return null;
  const state = _active;
  _active = null;

  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }

  const errors = [];

  // Seed from live-polled values already accumulated during the poll
  const twitchVotes = { ...state.twitchVotes };

  // End Twitch poll — capture vote counts per choice
  if (state.twitchPollId) {
    try {
      const result = await _endTwitchPoll(state.twitchPollId);
      (result?.choices ?? []).forEach((choice, i) => {
        twitchVotes[i] = (choice.votes ?? 0) + (choice.channel_points_votes ?? 0);
      });
      log.info('[poll] Twitch poll ended.');
    } catch (e) {
      log.error('[poll] End Twitch poll error:', e.message);
      errors.push(`Twitch poll end: ${e.message}`);
    }
  }

  // End Twitch prediction — capture channel points per outcome
  if (state.twitchPredictionId) {
    try {
      const result = await _endTwitchPrediction(state.twitchPredictionId, winningIndex);
      (result?.outcomes ?? []).forEach((outcome, i) => {
        twitchVotes[i] = outcome.channel_points ?? 0;
      });
      log.info('[poll] Twitch prediction ended.');
    } catch (e) {
      log.error('[poll] End Twitch prediction error:', e.message);
      errors.push(`Twitch prediction end: ${e.message}`);
    }
  }

  // Merge Twitch + YouTube votes
  const combinedVotes = Object.fromEntries(
    state.options.map((_, i) => [i, (state.ytVotes[i] ?? 0) + (twitchVotes[i] ?? 0)])
  );

  // YouTube results (show combined totals in chat)
  if (state.platforms.includes('youtube')) {
    await _postYtResultsMessage(state.title, combinedVotes, state.options);
  }

  // Discord embed
  await _postResultsEmbed(state, winningIndex, twitchVotes, combinedVotes);

  // Push final combined results to overlay, then hide after 10s
  overlay.updatePollOverlay({
    type:          state.type,
    title:         state.title,
    options:       state.options,
    platforms:     state.platforms,
    startedAt:     state.startedAt.getTime(),
    durationMs:    state.durationMs,
    combinedVotes,
    ended:         true,
    endedAt:       Date.now(),
  });
  setTimeout(() => overlay.updatePollOverlay(null), 10_000);
  return { state, errors };
}

// ── processMessage — YouTube vote counting ────────────────────────────────

async function processMessage(msg) {
  if (!_active) return { message: msg };
  if (!_active.platforms.includes('youtube')) return { message: msg };
  if (msg.platform !== 'youtube') return { message: msg };

  const trimmed = msg.message.trim();

  // Accept bare digits or digit + punctuation: "1", "2.", "3!", " 2 " etc.
  const match = trimmed.match(/^(\d+)[^\d]?$/);
  if (!match) return { message: msg };

  const choice = parseInt(match[1], 10) - 1; // 0-indexed
  if (choice < 0 || choice >= _active.options.length) return { message: msg };

  if (_active.ytVoters.has(msg.username)) {
    // Already voted — suppress the duplicate silently but don't count it
    return { message: null };
  }

  _active.ytVoters.add(msg.username);
  _active.ytVotes[choice] = (_active.ytVotes[choice] ?? 0) + 1;
  log.info(`[poll] YT vote from ${msg.username}: option ${choice + 1}`);
  _pushOverlay();

  // Suppress vote messages from Discord feed — keeps #stream-chat clean
  return { message: null };
}

// ── Slash commands ─────────────────────────────────────────────────────────

const PLATFORM_CHOICES = [
  { name: 'Both',    value: 'both'    },
  { name: 'Twitch',  value: 'twitch'  },
  { name: 'YouTube', value: 'youtube' },
];

const TYPE_CHOICES = [
  { name: 'Poll',       value: 'poll'       },
  { name: 'Prediction', value: 'prediction' },
];

const commandPoll = new SlashCommandBuilder()
  .setName('poll')
  .setDescription('Manage polls and predictions across Twitch and YouTube')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)

  .addSubcommand(sub => sub
    .setName('start')
    .setDescription('Start a new poll or prediction')
    .addStringOption(o => o
      .setName('title')
      .setDescription('Question or title (e.g. "Who will win?")')
      .setRequired(true))
    .addStringOption(o => o
      .setName('options')
      .setDescription('Comma-separated options (e.g. "Red,Blue,Green")')
      .setRequired(true))
    .addIntegerOption(o => o
      .setName('duration')
      .setDescription('Duration in seconds (default 120)')
      .setMinValue(15)
      .setMaxValue(1800))
    .addStringOption(o => o
      .setName('type')
      .setDescription('Poll (channel points vote) or Prediction (points bet) — Twitch only')
      .addChoices(...TYPE_CHOICES))
    .addStringOption(o => o
      .setName('platform')
      .setDescription('Which platforms to run on (default: both)')
      .addChoices(...PLATFORM_CHOICES)))

  .addSubcommand(sub => sub
    .setName('end')
    .setDescription('End the active poll or prediction early')
    .addIntegerOption(o => o
      .setName('winner')
      .setDescription('Winning option number for predictions (leave blank to cancel prediction)')
      .setMinValue(1)))

  .addSubcommand(sub => sub
    .setName('status')
    .setDescription('Check the current poll status'));

// ── init ───────────────────────────────────────────────────────────────────

function init(context) {
  _twitch = context.twitch;
  if (!_twitch) {
    log.warn('[poll] twitch module not in init context — Twitch poll/prediction creation disabled');
  }
}

// ── handleInteraction ─────────────────────────────────────────────────────

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  // ── /poll status ────────────────────────────────────────────────────────
  if (sub === 'status') {
    if (!_active) {
      return interaction.editReply('No poll is currently running.');
    }
    const elapsed  = Math.round((Date.now() - _active.startedAt.getTime()) / 1000);
    const remaining = Math.max(0, Math.round((_active.durationMs - (Date.now() - _active.startedAt.getTime())) / 1000));
    const total     = Object.values(_active.ytVotes).reduce((a, b) => a + b, 0) || 1;
    const lines     = _active.options.map((o, i) => {
      const v = _active.ytVotes[i] ?? 0;
      return `${i + 1}. **${o}** — ${v} YT votes (${Math.round((v / total) * 100)}%)`;
    });

    return interaction.editReply(
      `**${_active.type === 'prediction' ? '🔮 Prediction' : '📊 Poll'}**: ${_active.title}\n` +
      `Platforms: ${_active.platforms.join(', ')}  •  ${elapsed}s elapsed  •  ~${remaining}s remaining\n\n` +
      lines.join('\n')
    );
  }

  // ── /poll start ─────────────────────────────────────────────────────────
  if (sub === 'start') {
    if (_active) {
      return interaction.editReply('A poll is already running. Use `/poll end` first.');
    }

    const title       = interaction.options.getString('title');
    const rawOptions  = interaction.options.getString('options');
    const durationSec = interaction.options.getInteger('duration')  ?? 120;
    const type        = interaction.options.getString('type')        ?? 'poll';
    const platformOpt = interaction.options.getString('platform')    ?? 'both';

    const options = rawOptions.split(',').map(s => s.trim()).filter(Boolean);

    if (options.length < 2) {
      return interaction.editReply('Please provide at least 2 comma-separated options.');
    }
    if (options.length > 10) {
      return interaction.editReply('Maximum 10 options supported.');
    }
    if (type === 'prediction' && options.length > 10) {
      return interaction.editReply('Twitch predictions support a maximum of 10 outcomes.');
    }

    const platforms = platformOpt === 'both' ? ['twitch', 'youtube'] : [platformOpt];

    const errors = await _startPoll({ title, options, durationSec, type, platforms });

    const optionList = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
    const errBlock   = errors.length ? `\n\n⚠️ Errors:\n${errors.join('\n')}` : '';

    return interaction.editReply(
      `✅ **${type === 'prediction' ? 'Prediction' : 'Poll'} started** on ${platforms.join(' + ')}\n` +
      `**${title}**\n${optionList}\n` +
      `Duration: ${durationSec}s${errBlock}`
    );
  }

  // ── /poll end ───────────────────────────────────────────────────────────
  if (sub === 'end') {
    if (!_active) {
      return interaction.editReply('No poll is currently running.');
    }

    const winnerNum = interaction.options.getInteger('winner');
    const winningIndex = winnerNum != null ? winnerNum - 1 : null;

    if (winnerNum != null && (winningIndex < 0 || winningIndex >= _active.options.length)) {
      return interaction.editReply(`Invalid winner — choose between 1 and ${_active.options.length}.`);
    }

    const result = await _endPoll(winningIndex);
    if (!result) return interaction.editReply('Poll already ended.');

    const { state, errors } = result;
    const total = Object.values(state.ytVotes).reduce((a, b) => a + b, 0);
    const errBlock = errors.length ? `\n\n⚠️ Errors:\n${errors.join('\n')}` : '';
    const winner   = winningIndex !== null ? `\nWinner: **${state.options[winningIndex]}**` : '';

    return interaction.editReply(
      `✅ **${state.type === 'prediction' ? 'Prediction' : 'Poll'} ended**: ${state.title}${winner}\n` +
      `${total} YouTube votes recorded — results posted to Discord.${errBlock}`
    );
  }

  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = {
  id: 'poll',
  init,
  onChatReady,
  processMessage,
  commands: [commandPoll],
  handleInteraction,
};
