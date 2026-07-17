'use strict';

/**
 * Plugin: timer
 * ────────────────
 * A sleek speedrun-style countdown timer that runs as a transparent OBS
 * browser-source overlay.
 *
 * ── Controls ──────────────────────────────────────────────────────────────
 * Discord slash command:
 *   /timer set <hh:mm:ss>       — set the duration (e.g. /timer set 00:05:00)
 *   /timer start                — start (or resume) the countdown
 *   /timer pause                — freeze the timer at its current value
 *   /timer resume               — resume from where pause froze it
 *   /timer reset                — stop and reset to the last set duration
 *   /timer status               — reply with current state
 *
 * Dashboard widget (at /dashboard):
 *   Same five buttons (Set / Start / Pause / Resume / Reset) + a live
 *   HH:MM:SS readout. The Set button reads the text field next to it.
 *
 * ── Overlay ───────────────────────────────────────────────────────────────
 * Add http://<host>:2999/timer as a Browser Source in OBS.
 * Sleek dark card, Inter font (same as combined chat overlay), red accent
 * (#e53935, matches dashboard). No title.
 *
 * ── Behaviour at 00:00:00 ─────────────────────────────────────────────────
 * The timer keeps counting into negative territory (-00:00:01, -00:00:02…)
 * so you can see how far over you went. It only stops when you /timer pause
 * or /timer reset.
 *
 * ── State model ───────────────────────────────────────────────────────────
 * The server stores the timer as a small state object and pushes it via SSE
 * to both the dashboard widget and the OBS overlay. The actual ticking is
 * done CLIENT-SIDE on each render surface (so 60+ viewers of the overlay
 * don't cause 60+ server ticks per second). The server sends:
 *
 *   {
 *     durationMs: number,   // the configured duration (e.g. 300000 for 5:00)
 *     running:     boolean,  // is the clock currently advancing?
 *     baseRemainingMs: number, // remaining ms at the moment running became true
 *     baseTimestamp: number,   // Date.now() when running became true
 *   }
 *
 * The client computes displayRemaining = baseRemainingMs - (now - baseTimestamp)
 * when running, else displayRemaining = baseRemainingMs.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const log       = require('../../logger');
const dashboard = require('../../dashboard');
const {
  registerSection,
  updateSection,
  addRoute,
  buildStandaloneSectionPage,
} = require('../../overlay-server');

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_DURATION_MS = 5 * 60 * 1000; // 00:05:00

// ── State ──────────────────────────────────────────────────────────────────
//
// Single source of truth. The render functions are pure projections of this.
//
// running=true means the clock is advancing. When running flips false→true,
// we capture (baseRemainingMs, baseTimestamp) so clients can compute the
// current remaining time without further server round-trips.

const _state = {
  durationMs:      DEFAULT_DURATION_MS,
  baseRemainingMs: DEFAULT_DURATION_MS,
  baseTimestamp:   null,            // epoch ms when running became true
  running:         false,
};

/**
 * Snapshot the state for clients. We compute remainingMs at snapshot time
 * so a freshly-connecting client sees the right value immediately.
 */
function _snapshot() {
  let remainingMs = _state.baseRemainingMs;
  if (_state.running && _state.baseTimestamp != null) {
    remainingMs = _state.baseRemainingMs - (Date.now() - _state.baseTimestamp);
  }
  return {
    durationMs:      _state.durationMs,
    baseRemainingMs: _state.baseRemainingMs,
    baseTimestamp:   _state.baseTimestamp,
    running:         _state.running,
    remainingMs,     // convenience for first-paint; clients recompute from the rest
    serverTime:      Date.now(),
  };
}

// Push current state to the OBS overlay section + dashboard widget.
function _notify() {
  const snap = _snapshot();
  updateSection('timer', snap);
  dashboard.updateWidget('timer', snap);
}

// ── State mutations ────────────────────────────────────────────────────────
//
// Each mutation is a pure transition; _notify() is called after each one.
// All of these are idempotent — calling setDuration with the same value is
// a no-op, calling pause when already paused is a no-op, etc.

/** Set the configured duration. Resets the displayed remaining to match. */
function setDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`invalid duration: ${durationMs}`);
  }
  _state.durationMs      = durationMs;
  _state.baseRemainingMs = durationMs;
  _state.baseTimestamp   = null;
  _state.running         = false;
  _notify();
}

/** Start (or resume) the countdown. */
function start() {
  if (_state.running) return; // already running
  if (_state.baseRemainingMs <= 0) {
    // At or past zero — restart from the configured duration.
    _state.baseRemainingMs = _state.durationMs;
  }
  _state.baseTimestamp = Date.now();
  _state.running       = true;
  _notify();
}

/** Pause the countdown. Freezes the displayed remaining time. */
function pause() {
  if (!_state.running) return; // already paused
  // Capture the remaining time at the moment of pause so it doesn't keep
  // ticking while paused.
  _state.baseRemainingMs = _state.baseRemainingMs - (Date.now() - _state.baseTimestamp);
  _state.baseTimestamp   = null;
  _state.running         = false;
  _notify();
}

/** Resume from a paused state. Same as start() — kept as an alias for clarity. */
function resume() { start(); }

/** Stop and reset to the configured duration. */
function reset() {
  _state.baseRemainingMs = _state.durationMs;
  _state.baseTimestamp   = null;
  _state.running         = false;
  _notify();
}

// ── Duration parsing ───────────────────────────────────────────────────────
//
// Accepts "HH:MM:SS", "MM:SS", or a bare number of seconds. Returns ms.
// Throws on garbage so the caller can reply with a friendly error.

function parseDuration(input) {
  if (typeof input !== 'string') throw new Error('duration must be a string');
  const s = input.trim();
  if (!s) throw new Error('duration is empty');

  // Bare number → seconds
  if (/^\d+(\.\d+)?$/.test(s)) {
    return Math.round(parseFloat(s) * 1000);
  }

  // HH:MM:SS or MM:SS
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`invalid duration "${input}" — use HH:MM:SS or MM:SS`);
  }
  const nums = parts.map(p => parseInt(p, 10));
  if (nums.some(n => Number.isNaN(n))) {
    throw new Error(`invalid duration "${input}" — non-numeric segment`);
  }
  if (nums.some(n => n < 0)) {
    throw new Error(`invalid duration "${input}" — negative segment`);
  }
  // MM:SS
  if (nums.length === 2) {
    if (nums[1] >= 60) throw new Error(`invalid duration "${input}" — seconds must be < 60`);
    return (nums[0] * 60 + nums[1]) * 1000;
  }
  // HH:MM:SS
  if (nums[1] >= 60 || nums[2] >= 60) {
    throw new Error(`invalid duration "${input}" — minutes/seconds must be < 60`);
  }
  return (nums[0] * 3600 + nums[1] * 60 + nums[2]) * 1000;
}

/** Format ms as either HH:MM:SS or -HH:MM:SS (negative when over). */
function formatMs(ms) {
  const neg = ms < 0;
  let abs = Math.abs(ms);
  const totalSec = Math.floor(abs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => String(n).padStart(2, '0');
  const text = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return neg ? `-${text}` : text;
}

// ── Overlay section registration ───────────────────────────────────────────
//
// The render function is only used when the timer is shown inside the main
// /overlay mosaic. The dedicated /timer page (buildStandaloneSectionPage
// below) is what OBS should use, but registering the section here means
// the timer also appears in /overlay for debugging / multi-overlay setups.

registerSection('timer', {
  title: 'Timer',
  order: 20,
  icon: `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="12" r="8" stroke="#e53935" stroke-width="1.5"/>
    <path d="M11 12 L11 7" stroke="#e53935" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M11 12 L14 13" stroke="#e53935" stroke-width="1.5" stroke-linecap="round"/>
    <rect x="8.5" y="2" width="5" height="2" rx="1" fill="#e53935"/>
  </svg>`,
  render: (function render(data, el, esc, { card, badge }) {
    if (!data) { el.innerHTML = ''; return; }
    // The mosaic card defers to the same inlined computation as the
    // standalone page. We recompute every render call (SSE pushes) —
    // for smooth ticking, the standalone page uses its own RAF loop.
    var remaining = data.remainingMs;
    if (data.running && data.baseTimestamp != null) {
      remaining = data.baseRemainingMs - (Date.now() - data.baseTimestamp);
    }
    var text = remaining < 0 ? '-' : '';
    var abs = Math.abs(remaining);
    var totalSec = Math.floor(abs / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    text += pad(h) + ':' + pad(m) + ':' + pad(s);

    var color = remaining < 0 ? '#ff6b6b' : '#f0e0e0';
    var glow  = remaining < 0 ? 'rgba(255,107,107,0.45)' : 'rgba(229,57,53,0.30)';

    card.dataset.state = data.running ? '' : 'closed';
    badge.textContent = data.running ? 'RUNNING' : 'PAUSED';

    el.innerHTML =
      '<div style="font-family:Inter,sans-serif;font-weight:700;font-size:32px;' +
        'letter-spacing:0.04em;color:' + color + ';' +
        'text-shadow:0 0 14px ' + glow + ', 0 1px 3px rgba(0,0,0,0.9);' +
        'text-align:center;padding:14px 0;font-variant-numeric:tabular-nums">' +
        esc(text) +
      '</div>';
  }).toString(),
});

// ── Dashboard widget ───────────────────────────────────────────────────────

dashboard.registerWidget('timer', {
  title: 'Timer',
  order: 20,
  icon: `<svg width="20" height="20" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="12" r="8" stroke="currentColor" stroke-width="1.5"/>
    <path d="M11 12 L11 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M11 12 L14 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <rect x="8.5" y="2" width="5" height="2" rx="1" fill="currentColor"/>
  </svg>`,
  render: (function render(data, el, esc, { badge }) {
    if (!data) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px">Loading…</p>';
      badge.textContent = '';
      return;
    }

    // Live readout — recompute from the snapshot each render. For smooth
    // ticking the inline script below re-renders this same DOM node every
    // 200ms using the same formula.
    function computeRemaining(d) {
      if (d.running && d.baseTimestamp != null) {
        return d.baseRemainingMs - (Date.now() - d.baseTimestamp);
      }
      return d.baseRemainingMs;
    }
    function fmt(ms) {
      var neg = ms < 0;
      var abs = Math.abs(ms);
      var totalSec = Math.floor(abs / 1000);
      var h = Math.floor(totalSec / 3600);
      var m = Math.floor((totalSec % 3600) / 60);
      var s = totalSec % 60;
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return (neg ? '-' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
    }

    var remaining = computeRemaining(data);
    var isOver = remaining < 0;
    var color  = isOver ? '#ff6b6b' : 'var(--accent)';

    badge.textContent = data.running ? 'RUNNING' : 'PAUSED';

    var BTN_BASE =
      'padding:5px 10px;border-radius:4px;border:1px solid var(--border);' +
      'background:transparent;color:var(--text);font-size:11px;font-weight:700;' +
      'letter-spacing:0.04em;cursor:pointer;transition:all 0.15s;font-family:inherit;';
    var BTN_PRIMARY =
      'padding:5px 10px;border-radius:4px;border:none;' +
      'background:var(--accent);color:#fff;font-size:11px;font-weight:700;' +
      'letter-spacing:0.04em;cursor:pointer;transition:opacity 0.15s;font-family:inherit;';
    var INPUT_STYLE =
      'width:100%;background:var(--bg);border:1px solid var(--border);border-radius:4px;' +
      'color:var(--text);font-size:12px;padding:5px 8px;outline:none;font-family:var(--mono);' +
      'box-sizing:border-box;';

    // ── Preserve input across re-renders ────────────────────────────────
    // The dashboard re-renders this widget on every state push (start / /
    // pause / reset / set). If the operator is mid-typing a new duration
    // when one of those pushes arrives, we'd clobber their input. Capture
    // the current value + selection before innerHTML wipes it, then
    // restore afterwards.
    var prevInput     = document.getElementById('timer-set-input');
    var hadFocus      = !!(prevInput && document.activeElement === prevInput);
    var prevVal       = prevInput ? prevInput.value       : '';
    var prevSelStart  = prevInput ? prevInput.selectionStart : 0;
    var prevSelEnd    = prevInput ? prevInput.selectionEnd   : 0;

    el.innerHTML =
      // Big readout
      '<div id="timer-readout" style="font-family:var(--mono);font-weight:700;font-size:38px;' +
        'letter-spacing:0.04em;color:' + color + ';text-align:center;' +
        'padding:8px 0 14px;font-variant-numeric:tabular-nums;' +
        'text-shadow:0 0 12px ' + (isOver ? 'rgba(255,107,107,0.30)' : 'rgba(229,57,53,0.25)') + ';">' +
        esc(fmt(remaining)) +
      '</div>' +

      // Set duration row
      '<div style="display:flex;gap:6px;margin-bottom:10px">' +
        '<input id="timer-set-input" type="text" value="' + esc(fmt(data.durationMs)) + '" ' +
          'placeholder="HH:MM:SS" style="' + INPUT_STYLE + '" />' +
        '<button id="timer-set-btn" style="' + BTN_BASE + ';flex-shrink:0">Set</button>' +
      '</div>' +

      // Action buttons
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        (data.running
          ? '<button id="timer-pause-btn"  style="' + BTN_PRIMARY + ';flex:1">⏸ Pause</button>'
          : '<button id="timer-start-btn"  style="' + BTN_PRIMARY + ';flex:1">▶ ' +
              (data.baseRemainingMs < data.durationMs ? 'Resume' : 'Start') + '</button>'
        ) +
        '<button id="timer-reset-btn" style="' + BTN_BASE + ';flex:1">↺ Reset</button>' +
      '</div>';

    // Restore input value + focus if the operator was typing when the
    // re-render fired. We deliberately keep their typed text — even if it
    // differs from the server's current durationMs — because clicking
    // Start/Pause/Reset shouldn't blow away an unsubmitted Set input.
    if (hadFocus) {
      var newInput = document.getElementById('timer-set-input');
      if (newInput) {
        newInput.value = prevVal;
        newInput.focus();
        try { newInput.setSelectionRange(prevSelStart, prevSelEnd); } catch (_) {}
      }
    }

    // ── Live ticker ───────────────────────────────────────────────────────
    // The server only pushes state on mutation; the readout needs to tick
    // smoothly every second. We re-read the latest snapshot from the DOM
    // node's __snapshot field, which is updated each time this render()
    // runs (the dashboard re-renders the whole widget on every SSE push).
    var readout = document.getElementById('timer-readout');
    if (!window.__timerTickInterval) {
      window.__timerTickInterval = setInterval(function () {
        var r = document.getElementById('timer-readout');
        if (!r || !r.__snapshot) return;
        var d = r.__snapshot;
        var rem = computeRemaining(d);
        var over = rem < 0;
        r.style.color = over ? '#ff6b6b' : 'var(--accent)';
        r.style.textShadow = '0 0 12px ' + (over ? 'rgba(255,107,107,0.30)' : 'rgba(229,57,53,0.25)');
        r.textContent = fmt(rem);
      }, 200);
    }
    readout.__snapshot = data;

    // ── Button wiring ─────────────────────────────────────────────────────
    function action(name, payload) {
      return fetch('/dashboard/action', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(Object.assign({ action: 'timer-' + name }, payload || {})),
      }).then(function (r) { return r.json(); });
    }

    var setBtn = document.getElementById('timer-set-btn');
    if (setBtn) {
      var inp = document.getElementById('timer-set-input');
      if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') setBtn.click(); });
      setBtn.addEventListener('click', function () {
        var val = inp ? inp.value.trim() : '';
        if (!val) return;
        setBtn.disabled = true; setBtn.style.opacity = '0.5';
        action('set', { duration: val })
          .then(function (res) {
            setBtn.disabled = false; setBtn.style.opacity = '1';
            if (!res || res.ok === false) {
              setBtn.textContent = '✗';
              setTimeout(function () { setBtn.textContent = 'Set'; }, 1500);
            }
          })
          .catch(function () {
            setBtn.disabled = false; setBtn.style.opacity = '1';
            setBtn.textContent = '✗';
            setTimeout(function () { setBtn.textContent = 'Set'; }, 1500);
          });
      });
    }

    function bind(id, name) {
      var b = document.getElementById(id);
      if (!b) return;
      b.addEventListener('click', function () {
        b.disabled = true; b.style.opacity = '0.5';
        action(name)
          .then(function () { b.disabled = false; b.style.opacity = '1'; })
          .catch(function () { b.disabled = false; b.style.opacity = '1'; });
      });
    }
    bind('timer-start-btn', 'start');
    bind('timer-pause-btn', 'pause');
    bind('timer-reset-btn', 'reset');
  }).toString(),
});

// ── Dashboard action handlers ──────────────────────────────────────────────

dashboard.registerAction('timer-set',    async (body) => {
  try {
    const ms = parseDuration(body.duration);
    setDuration(ms);
    log.info(`[timer] duration set to ${formatMs(ms)} (${ms}ms)`);
    return { ok: true, durationMs: ms, display: formatMs(ms) };
  } catch (err) {
    log.warn(`[timer] set failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

dashboard.registerAction('timer-start',  async () => { start();   log.info('[timer] start');  return { ok: true }; });
dashboard.registerAction('timer-pause',  async () => { pause();   log.info('[timer] pause');  return { ok: true }; });
dashboard.registerAction('timer-resume', async () => { resume();  log.info('[timer] resume'); return { ok: true }; });
dashboard.registerAction('timer-reset',  async () => { reset();   log.info('[timer] reset');  return { ok: true }; });

// ── Discord slash command ──────────────────────────────────────────────────

const timerCommand = new SlashCommandBuilder()
  .setName('timer')
  .setDescription('Control the speedrun-style stream timer overlay')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub => sub
    .setName('set')
    .setDescription('Set the timer duration (resets the displayed time)')
    .addStringOption(o => o
      .setName('duration')
      .setDescription('HH:MM:SS (e.g. 00:05:00) or MM:SS (e.g. 05:00)')
      .setRequired(true)))
  .addSubcommand(sub => sub
    .setName('start')
    .setDescription('Start (or resume) the countdown'))
  .addSubcommand(sub => sub
    .setName('pause')
    .setDescription('Freeze the timer at its current value'))
  .addSubcommand(sub => sub
    .setName('resume')
    .setDescription('Resume from where pause froze it'))
  .addSubcommand(sub => sub
    .setName('reset')
    .setDescription('Stop and reset to the configured duration'))
  .addSubcommand(sub => sub
    .setName('status')
    .setDescription('Show the current timer state'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'set': {
      const raw = interaction.options.getString('duration', true);
      try {
        const ms = parseDuration(raw);
        setDuration(ms);
        await interaction.editReply(`⏱ Timer set to \`${formatMs(ms)}\` and reset.`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'start': {
      const wasRunning = _state.running;
      start();
      await interaction.editReply(wasRunning
        ? '⏱ Timer is already running.'
        : `⏱ Timer started. Currently at \`${formatMs(_snapshot().remainingMs)}\`.`);
      return;
    }
    case 'pause': {
      const wasRunning = _state.running;
      pause();
      await interaction.editReply(wasRunning
        ? `⏸ Timer paused at \`${formatMs(_snapshot().remainingMs)}\`.`
        : '⏸ Timer is already paused.');
      return;
    }
    case 'resume': {
      resume();
      await interaction.editReply(`▶ Timer resumed at \`${formatMs(_snapshot().remainingMs)}\`.`);
      return;
    }
    case 'reset': {
      reset();
      await interaction.editReply(`↺ Timer reset to \`${formatMs(_state.durationMs)}\`.`);
      return;
    }
    case 'status': {
      const snap = _snapshot();
      await interaction.editReply(
        `⏱ Timer: \`${formatMs(snap.remainingMs)}\` / \`${formatMs(snap.durationMs)}\` — ` +
        (snap.running ? 'running' : 'paused')
      );
      return;
    }
    default:
      await interaction.editReply(`⚠️ Unknown subcommand: \`${sub}\``);
  }
}

// ── Standalone OBS overlay page ────────────────────────────────────────────
//
// We don't use buildStandaloneSectionPage() here because the timer needs a
// custom RAF tick loop and a different visual treatment (sleek speedrun
// look — no card chrome, just glowing digits on a transparent background).
// The SSE subscription is the same /sse stream the rest of the overlay uses.

function buildTimerOverlayHtml() {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Timer Overlay</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: transparent;
    width: 100%;
    height: 100%;
    overflow: hidden;
    font-family: 'Inter', sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  /* Bare digits on a transparent canvas. No card, no border, no chrome —
     just a subtle red glow so the timer reads as part of the same overlay
     system as the combined chat feed. */
  .timer-display {
    font-family: 'Inter', sans-serif;
    font-weight: 700;
    font-size: 64px;
    letter-spacing: 0.06em;
    color: #f0e0e0;
    text-shadow:
      0 0 14px rgba(229, 57, 53, 0.35),
      0 0 28px rgba(229, 57, 53, 0.18);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    transition: color 0.3s ease, text-shadow 0.3s ease;
    display: inline-block;
  }

  /* Paused — dim and desaturate the glow. */
  .timer-display.paused {
    color: #9a8a8a;
    text-shadow:
      0 0 8px rgba(229, 57, 53, 0.12),
      0 0 18px rgba(229, 57, 53, 0.06);
  }

  /* Over — warmer red and pulse so the operator notices. */
  .timer-display.over {
    color: #ff6b6b;
    text-shadow:
      0 0 18px rgba(255, 107, 107, 0.55),
      0 0 36px rgba(255, 107, 107, 0.28);
    animation: pulseOver 1s ease-in-out infinite;
  }

  @keyframes pulseOver {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.75; }
  }

  .msg-reconnecting {
    margin-top: 8px;
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    color: #e53935;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
    animation: blink 1s step-start infinite;
    display: none;
  }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<div class="timer-display paused" id="display">00:00:00</div>
<div class="msg-reconnecting" id="reconn">⚠ RECONNECTING…</div>

<script>
(function () {
  var display = document.getElementById('display');
  var reconn  = document.getElementById('reconn');

  // Latest snapshot from the server.
  var latest = null;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmt(ms) {
    var neg = ms < 0;
    var abs = Math.abs(ms);
    var totalSec = Math.floor(abs / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return (neg ? '-' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  function computeRemaining(d) {
    if (!d) return 0;
    if (d.running && d.baseTimestamp != null) {
      return d.baseRemainingMs - (Date.now() - d.baseTimestamp);
    }
    return d.baseRemainingMs;
  }

  function render() {
    var rem = computeRemaining(latest);
    display.textContent = fmt(rem);

    var over = rem < 0;
    var running = !!(latest && latest.running);

    display.classList.toggle('over',   over);
    display.classList.toggle('paused', !running);
  }

  function tick() { render(); requestAnimationFrame(tick); }
  requestAnimationFrame(tick);

  function connect() {
    var es = new EventSource('/sse');
    es.onopen = function () { reconn.style.display = 'none'; };
    es.onmessage = function (e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'section' && msg.id === 'timer') {
          latest = msg.data;
        }
      } catch (_) {}
    };
    es.onerror = function () {
      reconn.style.display = 'block';
      es.close();
      setTimeout(connect, 2000);
    };
  }
  connect();
})();
</script>
</body>
</html>`;
}

addRoute('/timer', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(buildTimerOverlayHtml());
});

// ── No periodic re-broadcast ───────────────────────────────────────────────
//
// The overlay and dashboard widget both tick CLIENT-SIDE from the latest
// cached snapshot (no server round-trip per second), so we deliberately do
// NOT re-push state on a timer. State is only pushed on actual mutations
// (set / start / pause / resume / reset). This prevents the dashboard
// widget's input field from being clobbered every 250ms while the operator
// is typing a new duration — see the input-preservation block in
// registerWidget('timer').render for the second half of that fix.

// ── Plugin export ──────────────────────────────────────────────────────────

module.exports = {
  id: 'timer',

  commands: [timerCommand],
  handleInteraction,

  init() {
    log.info('[timer] plugin initialised — overlay at /timer, slash command /timer');
    _notify();
  },

  async processMessage(msg) {
    return { message: msg };
  },
};
