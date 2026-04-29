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
 *   - type:poll        → creates a real Twitch channel poll via Helix API
 *   - type:prediction  → creates a real Twitch prediction via Helix API
 *
 * YouTube:
 *   - Always chat-based (YouTube API has no live poll/prediction endpoint)
 *   - Posts the question + numbered options to YouTube chat
 *   - Listens for messages containing "1", "2", "3", etc. (first vote per user wins)
 *   - /poll end or duration expiry posts results to both YouTube chat and Discord
 *
 * Required env vars:
 *   TWITCH_CLIENT_ID       — your app's client ID
 *   TWITCH_CLIENT_SECRET   — app client secret (for app token fallback)
 *   TWITCH_BROADCASTER_ID  — numeric broadcaster user ID (or set TWITCH_BROADCASTER_LOGIN to resolve automatically)
 *   .twitch-tokens.json    — broadcaster OAuth token file written by twitch-auth.js
 *                            (requires scopes: channel:manage:polls, channel:manage:predictions)
 */

const { SlashCommandBuilder, EmbedBuilder, WebhookClient, PermissionFlagsBits } = require('discord.js');
const log     = require('../../logger');
const overlay = require('../../overlay-server');

// ── Env / config ──────────────────────────────────────────────────────────

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? '';
const CHAT_WEBHOOK_URL = process.env.DISCORD_CHAT_WEBHOOK_URL ?? '';

const fs        = require('fs');
const TOKEN_FILE = require('path').resolve('.twitch-tokens.json');

// Read & auto-refresh the broadcaster user token from .twitch-tokens.json
// (written by twitch-auth.js). Mirrors getUserToken() in twitch.js exactly.
// Polls/predictions require channel:manage:polls / channel:manage:predictions
// scopes — only the broadcaster OAuth token carries these, not the IRC bot token.
let _userTokenCache = null;
async function _getBroadcasterToken() {
  if (!_userTokenCache) {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    try {
      _userTokenCache = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    } catch {
      log.warn('[poll] Could not read .twitch-tokens.json');
      return null;
    }
  }

  if (Date.now() >= (_userTokenCache.expires_at ?? 0)) {
    log.info('[poll] User token expired — refreshing…');
    try {
      const { default: fetch } = await import('node-fetch');
      const res  = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: _userTokenCache.refresh_token,
          client_id:     TWITCH_CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }),
      });
      const data = await res.json();
      if (!data.access_token) throw new Error(JSON.stringify(data));
      _userTokenCache = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token ?? _userTokenCache.refresh_token,
        expires_at:    Date.now() + (data.expires_in - 60) * 1000,
        scopes:        data.scope ?? _userTokenCache.scopes,
      };
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(_userTokenCache, null, 2));
      log.info('[poll] User token refreshed and saved.');
    } catch (err) {
      log.error('[poll] User token refresh failed:', err.message);
      _userTokenCache = null;
      return null;
    }
  }

  return _userTokenCache.access_token;
}

// App token fallback (for read-only /users lookups when no user token is available).
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? '';
let _appToken = null, _appTokenExpiry = 0;
async function _getAppToken() {
  if (_appToken && Date.now() < _appTokenExpiry) return _appToken;
  const { default: fetch } = await import('node-fetch');
  const res  = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error(`Failed to get app token: ${JSON.stringify(data)}`);
  _appToken       = data.access_token;
  _appTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _appToken;
}

let TWITCH_BROADCASTER_ID = ''; // resolved at runtime

// ── Twitch broadcaster ID resolution ───────────────────────────────────────

async function _resolveBroadcasterId() {
  if (process.env.TWITCH_BROADCASTER_ID) {
    TWITCH_BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID;
    log.info(`[poll] Broadcaster ID: ${TWITCH_BROADCASTER_ID}`);
    return;
  }
  const login = process.env.TWITCH_BROADCASTER_LOGIN
             || (process.env.TWITCH_CHANNELS ?? '').split(',')[0].trim();
  if (!login) { log.warn('[poll] No broadcaster login found — set TWITCH_BROADCASTER_LOGIN'); return; }
  try {
    const data = await _twitchRequest('GET', `/users?login=${login}`, null);
    TWITCH_BROADCASTER_ID = data?.data?.[0]?.id ?? '';
    log.info(`[poll] Broadcaster ID resolved: ${TWITCH_BROADCASTER_ID} (${login})`);
  } catch (e) {
    log.error('[poll] Failed to resolve broadcaster ID:', e.message);
  }
}

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
  _resolveBroadcasterId();
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
 * } | null}
 */
let _active = null;

// ── Twitch Helix helpers ───────────────────────────────────────────────────

async function _twitchRequest(method, path, body) {
  // Polls and predictions require a broadcaster user token (same as vip/ban in twitch.js).
  // Fall back to app token only for read-only requests (e.g. /users lookup).
  const userToken = await _getBroadcasterToken();
  const token = userToken ?? await _getAppToken();
  if (!token) throw new Error('No Twitch token available — run twitch-auth.js to authorise');

  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`https://api.twitch.tv/helix${path}`, {
    method,
    headers: {
      'Client-ID':     TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Twitch ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function _createTwitchPoll(title, options, durationSec) {
  const data = await _twitchRequest('POST', '/polls', {
    broadcaster_id: TWITCH_BROADCASTER_ID,
    title,
    choices: options.map(t => ({ title: t })),
    duration: Math.min(Math.max(durationSec, 15), 1800), // Twitch: 15–1800s
  });
  return data?.data?.[0]?.id ?? null;
}

async function _endTwitchPoll(pollId) {
  const data = await _twitchRequest('PATCH', '/polls', {
    broadcaster_id: TWITCH_BROADCASTER_ID,
    id:     pollId,
    status: 'TERMINATED',
  });
  return data?.data?.[0] ?? null;
}

async function _createTwitchPrediction(title, options, durationSec) {
  const data = await _twitchRequest('POST', '/predictions', {
    broadcaster_id:    TWITCH_BROADCASTER_ID,
    title,
    outcomes:          options.map(t => ({ title: t })),
    prediction_window: Math.min(Math.max(durationSec, 30), 1800),
  });
  return data?.data?.[0]?.id ?? null;
}

async function _endTwitchPrediction(predictionId, winningIndex) {
  // First LOCK it, then RESOLVE it (or just CANCEL if no winner)
  const locked = await _twitchRequest('PATCH', '/predictions', {
    broadcaster_id: TWITCH_BROADCASTER_ID,
    id:     predictionId,
    status: 'LOCKED',
  });

  const outcomes = locked?.data?.[0]?.outcomes ?? [];

  if (winningIndex !== null && winningIndex !== undefined && outcomes[winningIndex]) {
    await _twitchRequest('PATCH', '/predictions', {
      broadcaster_id:     TWITCH_BROADCASTER_ID,
      id:                 predictionId,
      status:             'RESOLVED',
      winning_outcome_id: outcomes[winningIndex].id,
    });
  } else {
    await _twitchRequest('PATCH', '/predictions', {
      broadcaster_id: TWITCH_BROADCASTER_ID,
      id:             predictionId,
      status:         'CANCELED',
    });
  }

  return locked?.data?.[0] ?? null;
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

async function _fetchTwitchVotes() {
  if (!_active) return;
  try {
    if (_active.twitchPollId) {
      const data = await _twitchRequest('GET', `/polls?broadcaster_id=${TWITCH_BROADCASTER_ID}&id=${_active.twitchPollId}`);
      const poll = data?.data?.[0];
      if (poll) {
        (poll.choices ?? []).forEach((choice, i) => {
          _active.twitchVotes[i] = (choice.votes ?? 0) + (choice.channel_points_votes ?? 0);
        });
      }
    } else if (_active.twitchPredictionId) {
      const data = await _twitchRequest('GET', `/predictions?broadcaster_id=${TWITCH_BROADCASTER_ID}&id=${_active.twitchPredictionId}`);
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
    if (!TWITCH_CLIENT_ID || !TWITCH_BROADCASTER_ID) {
      errors.push('Twitch credentials not configured (TWITCH_CLIENT_ID or broadcaster ID missing)');
    } else {
      try {
        if (type === 'prediction') {
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

  // Push final combined results to overlay, then hide after 30s
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
  onChatReady,
  processMessage,
  commands: [commandPoll],
  handleInteraction,
};