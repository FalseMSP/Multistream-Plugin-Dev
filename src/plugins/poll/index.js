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
 * YouTube (real poll API integration via masterchat):
 *   - YouTube's public Data API has no "create poll" endpoint — polls must be
 *     created manually in YouTube Studio. Once a poll exists, masterchat emits
 *     three native poll actions straight from the live_chat endpoint:
 *       showPollPanelAction → poll created (we adopt it as the active YT poll)
 *       updatePollAction    → vote ratios updated (we sync to overlay / Discord)
 *       addPollResultAction → poll closed (we post final results)
 *   - /poll start platform:youtube posts a heads-up message telling the
 *     broadcaster which question + options to enter in Studio, then subscribes
 *     to poll events. When the broadcaster creates the poll, the plugin
 *     automatically adopts it and streams live vote ratios to the overlay.
 *   - /poll end posts whatever tally we have so far. The broadcaster is still
 *     responsible for closing the poll in Studio (no public end-poll API);
 *     when YouTube emits addPollResultAction we also auto-finalise.
 *
 * Required env vars:
 *   DISCORD_CHAT_WEBHOOK_URL  — for result embeds
 *   .twitch-tokens.json      — broadcaster OAuth token file written by twitch-auth.js
 *                              (requires scopes: channel:manage:polls, channel:manage:predictions)
 *
 * Note: This plugin uses the public twitch module APIs (createPoll, endPoll,
 * getPoll, createPrediction, endPrediction, getBroadcasterId) and the public
 * youtube module APIs (onPollEvent, getActivePoll) instead of reimplementing
 * their internals. The previous version had ~150 lines of duplicate Helix code
 * that have all been removed in favour of the shared twitch.js helpers, and
 * the YouTube branch no longer relies on chat-based "type 1/2/3" voting.
 */

const { SlashCommandBuilder, EmbedBuilder, WebhookClient, PermissionFlagsBits } = require('discord.js');
const log     = require('../../logger');
const overlay = require('../../overlay-server');

// ── Env / config ──────────────────────────────────────────────────────────

const CHAT_WEBHOOK_URL = process.env.DISCORD_CHAT_WEBHOOK_URL ?? '';

// ── Plugin context (set in init) ───────────────────────────────────────────

let _twitch  = null;
let _youtube = null;

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
 *   platforms:   string[],
 *   startedAt:  Date,
 *   durationMs: number,
 *   timer:      NodeJS.Timeout | null,
 *
 *   // Twitch
 *   twitchPollId:       string | null,
 *   twitchPredictionId: string | null,
 *   twitchVotes: { [option_index: string]: number },
 *   pollInterval: NodeJS.Timeout | null,
 *
 *   // YouTube poll API integration
 *   youtubePollId:  string | null,        // masterchat poll id once adopted
 *   youtubeVideoId: string | null,        // which live stream the poll lives on
 *   youtubeVotes:   { [option_index: string]: number },  // absolute votes per choice
 *   youtubeTotal:   number,              // total votes reported by YouTube
 *   ytPollUnsub:    (() => void) | null, // unsubscribe from youtube.onPollEvent
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

// ── YouTube poll API integration ───────────────────────────────────────────
//
// Masterchat (the YouTube live-chat library used by src/youtube.js) emits
// three poll-related actions straight from YouTube's internal
// /youtubei/v1/live_chat/get_live_chat endpoint. The youtube module wraps
// those into a stable poll-state object and pushes them to subscribers via
// youtube.onPollEvent(callback). Each callback invocation receives
//   (videoId, action, pollState)
// where `action.type` is one of:
//   showPollPanelAction  — broadcaster just created a poll in YouTube Studio
//   updatePollAction     — vote ratios updated (fired continuously)
//   addPollResultAction  — poll closed; final tally + winner highlighted
//   closePanelAction     — UI-only banner dismissal (we ignore this)
//
// The plugin subscribes when /poll start platform:youtube runs and
// unsubscribes when the poll ends (manually, by duration, or by YouTube).

/** Map option text → choice index (1:1 against _active.options). */
function _optionTextToIndex(text) {
  if (!_active || !text) return -1;
  const norm = String(text).trim().toLowerCase();
  // exact match first
  for (let i = 0; i < _active.options.length; i++) {
    if (_active.options[i].trim().toLowerCase() === norm) return i;
  }
  // prefix match (YT may truncate long option text in the panel render)
  for (let i = 0; i < _active.options.length; i++) {
    const opt = _active.options[i].trim().toLowerCase();
    if (opt.length > 3 && (norm.startsWith(opt) || opt.startsWith(norm))) return i;
  }
  // positional fallback — match by order in the choice array
  return -1;
}

/**
 * Map a YouTube pollState's choices onto our option-indexed vote tally.
 * Returns { votes: { [index]: number }, total: number, matched: boolean }.
 * If we can't confidently map ANY choice to our options (e.g. the broadcaster
 * created a poll with completely different text), we fall back to positional
 * ordering so the overlay still updates — the Discord embed will note the
 * mismatch.
 */
function _mapYtChoicesToOptions(poll) {
  const votes = Object.fromEntries(_active.options.map((_, i) => [i, 0]));
  const choices = poll?.choices ?? [];

  // Try text-matching first
  let matchedCount = 0;
  const usedIdx = new Set();
  choices.forEach((c, i) => {
    const idx = _optionTextToIndex(c.text);
    if (idx >= 0 && !usedIdx.has(idx)) {
      votes[idx] = (votes[idx] ?? 0) + (c.voteCount ?? 0);
      usedIdx.add(idx);
      matchedCount++;
    }
  });

  // If text matching failed for every choice, fall back to positional mapping
  // so the overlay still shows something useful — broadcaster likely created
  // the poll with their own wording.
  if (matchedCount === 0 && choices.length === _active.options.length) {
    choices.forEach((c, i) => { votes[i] = c.voteCount ?? 0; });
  }

  return {
    votes,
    total:   poll?.totalVotes ?? 0,
    matched: matchedCount > 0,
  };
}

/**
 * Update _active.youtubeVotes / youtubeTotal / youtubePollId from a fresh
 * pollState and refresh the overlay. No-op if the plugin state has moved on.
 */
function _syncYtPollState(videoId, poll) {
  if (!_active || _active.youtubeVideoId !== videoId) return;
  if (poll?.pollId && !_active.youtubePollId) {
    _active.youtubePollId = poll.pollId;
    log.info(`[poll] Adopted YouTube poll id=${poll.pollId} q="${poll.question}"`);
  }
  if (poll?.pollId && _active.youtubePollId && poll.pollId !== _active.youtubePollId) {
    // A different poll appeared — ignore it; the broadcaster may have queued
    // up a second poll. We only track one at a time.
    return;
  }

  const mapped = _mapYtChoicesToOptions(poll);
  _active.youtubeVotes = mapped.votes;
  _active.youtubeTotal = mapped.total;
  _active._ytMatched    = mapped.matched;
  _pushOverlay();
}

/**
 * Subscriber callback handed to youtube.onPollEvent(). Runs for every active
 * YouTube session — we filter to the video we're tracking.
 *
 * Adoption rule: if we don't yet know which video the broadcaster will create
 * the poll on (youtubeVideoId === null), the FIRST showPollPanelAction on ANY
 * active stream adopts that video. Subsequent events are then filtered to
 * that videoId, so a poll created on a second concurrent stream is ignored.
 */
function _onYtPollEvent(videoId, action, poll) {
  if (!_active) return;

  // First-ever poll event for this /poll session — adopt the videoId.
  if (_active.youtubeVideoId === null && action.type === 'showPollPanelAction') {
    _active.youtubeVideoId = videoId;
    log.info(`[poll] Adopting YouTube video ${videoId} as the poll stream.`);
  }

  // Filter to the adopted video — ignore polls from other concurrent streams.
  if (_active.youtubeVideoId !== videoId) return;

  if (action.type === 'showPollPanelAction') {
    // A new poll appeared — adopt it (regardless of whether the question
    // exactly matches what /poll start suggested; the broadcaster may have
    // paraphrased). Sync vote state immediately.
    _syncYtPollState(videoId, poll);
  } else if (action.type === 'updatePollAction') {
    // Vote ratios updated — sync the live tally to the overlay.
    _syncYtPollState(videoId, poll);
  } else if (action.type === 'addPollResultAction') {
    // Poll closed on YouTube's side — auto-finalise with the final tally.
    log.info('[poll] YouTube poll closed by broadcaster — auto-finalising.');
    _syncYtPollState(videoId, poll);
    _endPoll(null).catch(e => log.error('[poll] Auto-finalise error:', e.message));
  }
  // closePanelAction is UI-only — ignored.
}

/** Post the "please create this poll in YouTube Studio" heads-up message. */
async function _postYtPollInstructions(title, options, durationSec) {
  const send = _chatReply.youtube;
  if (!send) { log.warn('[poll] No YouTube chat reply — cannot post instructions'); return; }

  const optionLines = options.map((o, i) => `${i + 1}. ${o}`).join('  •  ');
  const lines = [
    `📊 Poll starting: ${title}`,
    `Options: ${optionLines}`,
    `Create this poll in YouTube Studio — I'll track votes automatically. (${Math.round(durationSec / 60)} min)`,
  ];

  send(lines.join('  |  ')).catch(e => log.error('[poll] YT post error:', e.message));
}

/** Post the final YouTube poll result message to YouTube chat. */
async function _postYtResultsMessage(title, votes, options, total) {
  const send = _chatReply.youtube;
  if (!send) return;
  const sum = total || Object.values(votes).reduce((a, b) => a + b, 0) || 1;
  const lines = [
    `📊 Results: ${title}`,
    ...options.map((o, i) => {
      const v   = votes[i] ?? 0;
      const pct = Math.round((v / sum) * 100);
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      return `${i + 1}. ${o}  ${bar}  ${v} (${pct}%)`;
    }),
    `Total YouTube votes: ${sum}`,
  ];
  send(lines.join('  |  ')).catch(e => log.error('[poll] YT results error:', e.message));
}

// ── Result embed ──────────────────────────────────────────────────────────

async function _postResultsEmbed(state, winningIndex = null, twitchVotes = {}, combinedVotes = null) {
  const wh = _getWebhook();
  if (!wh) return;

  const votes    = combinedVotes ?? state.youtubeVotes;
  const total    = Object.values(votes).reduce((a, b) => a + b, 0) || 1;
  const ytTotal  = Object.values(state.youtubeVotes).reduce((a, b) => a + b, 0);
  const twTotal  = Object.values(twitchVotes).reduce((a, b) => a + b, 0);
  const isPrediction  = state.type === 'prediction';
  const twitchLabel   = isPrediction ? 'channel points' : 'votes';

  const fields = state.options.map((opt, i) => {
    const combined  = votes[i] ?? 0;
    const pct       = Math.round((combined / total) * 100);
    const winner    = winningIndex === i ? ' 🏆' : '';
    const yt        = state.youtubeVotes[i] ?? 0;
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
  // Combined = Twitch votes + YouTube poll votes per option index
  const combinedVotes = Object.fromEntries(
    _active.options.map((_, i) => [
      i,
      (_active.twitchVotes[i]  ?? 0) + (_active.youtubeVotes[i] ?? 0),
    ])
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

    // Twitch state
    twitchPollId:       null,
    twitchPredictionId: null,
    twitchVotes:        Object.fromEntries(options.map((_, i) => [i, 0])),
    pollInterval:       null,

    // YouTube state (real poll API)
    youtubePollId:      null,
    youtubeVideoId:     null,
    youtubeVotes:       Object.fromEntries(options.map((_, i) => [i, 0])),
    youtubeTotal:       0,
    ytPollUnsub:        null,
    _ytMatched:        true,
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

  // YouTube — subscribe to real poll events and ask the broadcaster to create
  // the poll in YouTube Studio. The subscription is global (not per-video);
  // _onYtPollEvent adopts the first showPollPanelAction's videoId and filters
  // all subsequent events to it, so a poll created on a second concurrent
  // stream is ignored.
  if (platforms.includes('youtube')) {
    if (!_youtube) {
      errors.push('YouTube module not available in init context');
    } else if (typeof _youtube.onPollEvent !== 'function') {
      errors.push('YouTube module missing onPollEvent — update src/youtube.js');
    } else {
      _active.youtubeVideoId = null;          // adopted on first poll event
      _active.ytPollUnsub    = _youtube.onPollEvent(_onYtPollEvent);
      log.info('[poll] Subscribed to YouTube poll events — waiting for broadcaster to create poll in Studio.');

      await _postYtPollInstructions(title, options, durationSec);
    }
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

  if (state.timer)        { clearTimeout(state.timer); state.timer = null; }
  if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }
  if (typeof state.ytPollUnsub === 'function') {
    try { state.ytPollUnsub(); } catch { /* ignore */ }
    state.ytPollUnsub = null;
  }

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

  // For YouTube: if a YouTube poll was adopted, do one last poll-state sync
  // before finalising. The broadcaster is responsible for actually closing
  // the poll in YouTube Studio — there is no public end-poll endpoint.
  if (state.platforms.includes('youtube') && state.youtubeVideoId && _youtube?.getActivePoll) {
    try {
      const fresh = _youtube.getActivePoll(state.youtubeVideoId);
      if (fresh && fresh.pollId === state.youtubePollId) {
        const m = _mapYtChoicesToOptionsForState(state, fresh);
        state.youtubeVotes = m.votes;
        state.youtubeTotal = m.total;
        state._ytMatched   = m.matched;
      }
    } catch (e) {
      log.warn('[poll] Final YouTube poll sync failed:', e.message);
    }
  }

  // Merge Twitch + YouTube votes
  const combinedVotes = Object.fromEntries(
    state.options.map((_, i) => [i, (state.youtubeVotes[i] ?? 0) + (twitchVotes[i] ?? 0)])
  );

  // YouTube results (show combined totals in chat)
  if (state.platforms.includes('youtube')) {
    await _postYtResultsMessage(state.title, combinedVotes, state.options, state.youtubeTotal);
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

/**
 * Standalone version of _mapYtChoicesToOptions that takes an explicit state
 * object instead of reading the module-level _active. Lets _endPoll sync one
 * last time after _active has been cleared.
 */
function _mapYtChoicesToOptionsForState(state, poll) {
  if (!state || !poll) return { votes: {}, total: 0, matched: false };
  const votes = Object.fromEntries(state.options.map((_, i) => [i, 0]));
  const choices = poll?.choices ?? [];
  const norm = (s) => String(s ?? '').trim().toLowerCase();

  let matchedCount = 0;
  const usedIdx = new Set();
  choices.forEach((c) => {
    const txt = norm(c.text);
    let idx = -1;
    for (let i = 0; i < state.options.length; i++) {
      if (norm(state.options[i]) === txt) { idx = i; break; }
    }
    if (idx < 0) {
      for (let i = 0; i < state.options.length; i++) {
        const opt = norm(state.options[i]);
        if (opt.length > 3 && (txt.startsWith(opt) || opt.startsWith(txt))) { idx = i; break; }
      }
    }
    if (idx >= 0 && !usedIdx.has(idx)) {
      votes[idx] = (votes[idx] ?? 0) + (c.voteCount ?? 0);
      usedIdx.add(idx);
      matchedCount++;
    }
  });

  if (matchedCount === 0 && choices.length === state.options.length) {
    choices.forEach((c, i) => { votes[i] = c.voteCount ?? 0; });
  }

  return {
    votes,
    total:   poll?.totalVotes ?? 0,
    matched: matchedCount > 0,
  };
}

// ── processMessage ────────────────────────────────────────────────────────
//
// With the YouTube poll API integration, YouTube chat is no longer used as
// the vote channel — votes are submitted directly through the YouTube poll
// UI and masterchat reports them via updatePollAction events. So we no
// longer intercept "1", "2", "3" messages on YouTube. Chat messages pass
// through unchanged to the main feed.

async function processMessage(msg) {
  return { message: msg };
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
  _twitch  = context.twitch;
  _youtube = context.youtube;
  if (!_twitch) {
    log.warn('[poll] twitch module not in init context — Twitch poll/prediction creation disabled');
  }
  if (!_youtube) {
    log.warn('[poll] youtube module not in init context — YouTube poll API integration disabled');
  } else if (typeof _youtube.onPollEvent !== 'function') {
    log.warn('[poll] youtube module missing onPollEvent — update src/youtube.js to enable YouTube polls');
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
    const ytTotal = _active.youtubeTotal ?? Object.values(_active.youtubeVotes).reduce((a, b) => a + b, 0);
    const twTotal = Object.values(_active.twitchVotes).reduce((a, b) => a + b, 0);
    const total = Math.max(1, ytTotal + twTotal);
    const lines = _active.options.map((o, i) => {
      const yt = _active.youtubeVotes[i] ?? 0;
      const tw = _active.twitchVotes[i]  ?? 0;
      const pct = Math.round(((yt + tw) / total) * 100);
      const ytPart = _active.platforms.includes('youtube') ? `  •  YT: ${yt}` : '';
      const twPart = _active.platforms.includes('twitch')  ? `  •  TW: ${tw}` : '';
      return `${i + 1}. **${o}** — ${yt + tw} votes (${pct}%)${ytPart}${twPart}`;
    });

    const ytAdopted = _active.youtubePollId ? `  •  YouTube poll: ${_active.youtubePollId}` : '';
    const ytWaiting = (_active.platforms.includes('youtube') && !_active.youtubePollId)
      ? '\n⏳ Waiting for broadcaster to create the poll in YouTube Studio…'
      : '';

    return interaction.editReply(
      `**${_active.type === 'prediction' ? '🔮 Prediction' : '📊 Poll'}**: ${_active.title}\n` +
      `Platforms: ${_active.platforms.join(', ')}${ytAdopted}  •  ${elapsed}s elapsed  •  ~${remaining}s remaining\n\n` +
      lines.join('\n') + ytWaiting
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

    const ytNote = platforms.includes('youtube')
      ? `\nYouTube: create the poll in YouTube Studio with the title + options above — I'll auto-adopt it.`
      : '';

    return interaction.editReply(
      `✅ **${type === 'prediction' ? 'Prediction' : 'Poll'} started** on ${platforms.join(' + ')}\n` +
      `**${title}**\n${optionList}\n` +
      `Duration: ${durationSec}s${ytNote}${errBlock}`
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
    const ytTotal  = state.youtubeTotal ?? Object.values(state.youtubeVotes).reduce((a, b) => a + b, 0);
    const twTotal  = Object.values(state.twitchVotes).reduce((a, b) => a + b, 0);
    const errBlock = errors.length ? `\n\n⚠️ Errors:\n${errors.join('\n')}` : '';
    const winner   = winningIndex !== null ? `\nWinner: **${state.options[winningIndex]}**` : '';

    const ytNote = state.platforms.includes('youtube')
      ? state.youtubePollId
        ? `\nYouTube poll tracked: ${state.youtubePollId} (${ytTotal} votes).`
        : `\nYouTube: no poll was adopted before /poll end — broadcaster may not have created one in Studio.`
      : '';

    return interaction.editReply(
      `✅ **${state.type === 'prediction' ? 'Prediction' : 'Poll'} ended**: ${state.title}${winner}\n` +
      `${twTotal} Twitch votes  •  ${ytTotal} YouTube votes recorded — results posted to Discord.${ytNote}${errBlock}`
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
