'use strict';

/**
 * Plugin: stopwatch
 * ────────────────
 * A sleek speedrun-style stopwatch that counts UP, running as a transparent
 * OBS browser-source overlay. Visually identical to the `timer` plugin
 * (same fonts, glow, paused treatment) except the clock moves the other way.
 *
 * ── Multiple stopwatches ──────────────────────────────────────────────────
 * Unlike /timer, the stopwatch keeps a LIST of named stopwatches. Exactly
 * one of them is "active" — that one is what /stopwatch (the OBS overlay)
 * and the dashboard readout display.
 *
 *   • Create "Cuphead", run it, pause it → its elapsed time is saved to
 *     src/plugins/stopwatch/stopwatches.json and survives bot restarts.
 *   • Create another stopwatch ("Mario") → it starts at 00:00:00 and the
 *     overlay switches to it. The paused "Cuphead" keeps its saved time.
 *   • Select either one again at any time from the dashboard (or
 *     /stopwatch use cuphead) → the overlay switches back and resumes.
 *
 * ── Dashboard widget (at /dashboard) ──────────────────────────────────────
 *   • Live HH:MM:SS readout of the active stopwatch (ticks client-side)
 *   • Dropdown to pick which stopwatch is relayed to the overlay
 *   • Create (with name), Rename, Delete, Pause / Resume, Reset, and
 *     Set — type a time (1:23:45, 12:30 or 90) to jump the clock there
 *
 * ── Discord slash command ─────────────────────────────────────────────────
 *   /stopwatch create <name>   — create a stopwatch and switch to it
 *   /stopwatch use <name>      — make an existing one the active overlay
 *   /stopwatch list            — list all stopwatches (▶ = active)
 *   /stopwatch start           — start (or resume) the active one
 *   /stopwatch pause           — freeze it and SAVE it to disk
 *   /stopwatch resume          — resume from where pause froze it
 *   /stopwatch reset           — zero the active stopwatch
 *   /stopwatch set <time>      — manually set the time (1:23:45, 12:30 or 90)
 *   /stopwatch delete <name>   — remove a stopwatch
 *   /stopwatch status          — show active stopwatch state
 *
 * ── Overlay ───────────────────────────────────────────────────────────────
 *   OBS Browser Source: https://<host>/stopwatch
 *   (Through Caddy. The legacy http://<host>:2999/stopwatch also works.)
 *   Add &name=1 to display the stopwatch's name as a small label above
 *   the digits. Default is bare digits, identical to the timer overlay.
 *
 * ── State model ───────────────────────────────────────────────────────────
 *   Same shape as `timer`, per stopwatch:
 *     {
 *       id:            string,  // stable slug, dropdown/API key
 *       name:          string,  // display name
 *       baseElapsedMs: number,  // elapsed ms at the moment running flipped
 *       baseTimestamp: number|null, // Date.now() when running became true
 *       running:       boolean,
 *       createdAt:     number,
 *     }
 *   elapsedMs = baseElapsedMs + (running ? Date.now() - baseTimestamp : 0)
 *
 *   Ticking is CLIENT-SIDE on every render surface; the server only pushes
 *   snapshots on mutation + a 2s heartbeat (same design as `timer`).
 *
 * ── Persistence ───────────────────────────────────────────────────────────
 *   Every mutation writes { stopwatches, activeId } to stopwatches.json in
 *   this plugin's directory (same convention as watch-streak). On startup,
 *   any stopwatch that was still `running` in the file is frozen at its
 *   last saved whole-second — server downtime is never silently counted
 *   into a run. Pause explicitly to bank your time before shutting down.
 */

const fs   = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const log       = require('../../logger');
const dashboard = require('../../dashboard');
const {
  registerSection,
  updateSection,
  addRoute,
} = require('../../overlay-server');

// ── Persistence ────────────────────────────────────────────────────────────

const DATA_PATH = path.join(__dirname, 'stopwatches.json');

let _stopwatches = [];   // [{ id, name, baseElapsedMs, baseTimestamp, running, createdAt }]
let _activeId    = null; // which stopwatch /stopwatch relays

function _load() {
  try {
    if (!fs.existsSync(DATA_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.stopwatches)) return;
    _stopwatches = raw.stopwatches.filter(sw =>
      sw && typeof sw.id === 'string' && typeof sw.name === 'string' &&
      Number.isFinite(sw.baseElapsedMs));
    _activeId = typeof raw.activeId === 'string' ? raw.activeId : null;
    if (_activeId && !_stopwatches.some(sw => sw.id === _activeId)) {
      _activeId = _stopwatches.length ? _stopwatches[0].id : null;
    }
    // Freeze anything that was running when the process died. Its on-disk
    // baseElapsedMs was banked at the last pause/mutation; the partial tick
    // since `baseTimestamp` is discarded so downtime never counts.
    let froze = 0;
    for (const sw of _stopwatches) {
      if (sw.running && sw.baseTimestamp != null) {
        sw.baseTimestamp = null;
        sw.running       = false;
        froze++;
      }
    }
    if (froze) {
      log.warn(`[stopwatch] froze ${froze} running stopwatch(es) at their last saved value (server was down)`);
    }
  } catch (err) {
    log.error(`[stopwatch] failed to load ${DATA_PATH}: ${err.message}`);
    _stopwatches = [];
    _activeId    = null;
  }
}

function _save() {
  try {
    fs.writeFileSync(
      DATA_PATH,
      JSON.stringify({ stopwatches: _stopwatches, activeId: _activeId }, null, 2),
      'utf8',
    );
  } catch (err) {
    log.error(`[stopwatch] failed to save ${DATA_PATH}: ${err.message}`);
  }
}

// ── State helpers ──────────────────────────────────────────────────────────

function _slugify(name) {
  const s = String(name).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'stopwatch';
}

function _uniqueId(base) {
  let id = base;
  let n  = 2;
  while (_stopwatches.some(sw => sw.id === id)) id = `${base}-${n++}`;
  return id;
}

function _getByIdOrName(idOrName) {
  const q = String(idOrName || '').trim().toLowerCase();
  if (!q) return null;
  return _stopwatches.find(sw => sw.id.toLowerCase() === q) ||
         _stopwatches.find(sw => sw.name.toLowerCase() === q) || null;
}

function _getActive() {
  return _stopwatches.find(sw => sw.id === _activeId) || null;
}

function _requireActive() {
  const sw = _getActive();
  if (!sw) throw new Error('no active stopwatch — create one first (/stopwatch create <name>)');
  return sw;
}

function _elapsedOf(sw) {
  return (sw.running && sw.baseTimestamp != null)
    ? sw.baseElapsedMs + (Date.now() - sw.baseTimestamp)
    : sw.baseElapsedMs;
}

/** Snapshot one stopwatch for clients (same contract as `timer`). */
function _snapshot(sw) {
  return {
    id:            sw.id,
    name:          sw.name,
    baseElapsedMs: sw.baseElapsedMs,
    baseTimestamp: sw.baseTimestamp,
    running:       sw.running,
    elapsedMs:     _elapsedOf(sw),   // convenience for first paint
    serverTime:    Date.now(),
  };
}

// ── Broadcast ──────────────────────────────────────────────────────────────
// Push the active stopwatch to the OBS overlay section, and the full list
// to the dashboard widget. Pure projections of state — no client round-trips.

function _notify() {
  const active = _getActive();
  updateSection('stopwatch', active ? _snapshot(active) : null);
  dashboard.updateWidget('stopwatch', {
    stopwatches: _stopwatches.map(sw => _snapshot(sw)),
    activeId:    _activeId,
    serverTime:  Date.now(),
  });
}

// ── State mutations ────────────────────────────────────────────────────────
// Each is a small idempotent transition; every mutation persists to disk
// (pausing banks the time — that's the whole point of the file) and then
// notifies every surface.

/** Create a stopwatch at 00:00:00 (paused) and make it the active one. */
function create(name) {
  const trimmed = String(name || '').trim().slice(0, 48);
  if (!trimmed) throw new Error('stopwatch name is required');
  const sw = {
    id:            _uniqueId(_slugify(trimmed)),
    name:          trimmed,
    baseElapsedMs: 0,
    baseTimestamp: null,
    running:       false,
    createdAt:     Date.now(),
  };
  _stopwatches.push(sw);
  _activeId = sw.id;
  _save();
  _notify();
  log.info(`[stopwatch] created "${sw.name}" (id=${sw.id}) — now active`);
  return sw;
}

/** Make an existing stopwatch the one relayed through /stopwatch. */
function select(idOrName) {
  const sw = _getByIdOrName(idOrName);
  if (!sw) throw new Error(`no stopwatch named "${idOrName}" — see /stopwatch list`);
  _activeId = sw.id;
  _save();
  _notify();
  log.info(`[stopwatch] switched overlay to "${sw.name}" (id=${sw.id})`);
  return sw;
}

/** Start (or resume) the active stopwatch. */
function start() {
  const sw = _requireActive();
  if (sw.running) return sw; // already running
  sw.baseTimestamp = Date.now();
  sw.running       = true;
  _save();
  _notify();
  return sw;
}

/** Pause the active stopwatch — folds elapsed time and SAVES it to disk. */
function pause() {
  const sw = _requireActive();
  if (!sw.running) return sw; // already paused
  sw.baseElapsedMs += Date.now() - sw.baseTimestamp;
  sw.baseTimestamp  = null;
  sw.running        = false;
  _save();
  _notify();
  log.info(`[stopwatch] paused "${sw.name}" at ${formatMs(sw.baseElapsedMs)} — saved`);
  return sw;
}

/** Reset the active stopwatch to 00:00:00 (keeps it selected). */
function reset() {
  const sw = _requireActive();
  sw.baseElapsedMs = 0;
  sw.baseTimestamp = null;
  sw.running       = false;
  _save();
  _notify();
  return sw;
}

/**
 * Parse a manual time entry into milliseconds. Loose formats, strict ranges:
 *   "90"      → plain seconds  → 00:01:30
 *   "12:30"   → mm:ss          → 00:12:30
 *   "1:23:45" → h:mm:ss        → 01:23:45
 * Internal whitespace is tolerated; seconds/minutes above 59 are REJECTED
 * rather than silently rolled over, so a typo can't land on a time you
 * didn't mean. Returns ms (integer ≥ 0), or null if unparseable.
 */
function parseTimeInput(raw) {
  const norm = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!/^\d{1,3}(:\d{1,2}){0,2}$/.test(norm)) return null;
  const parts = norm.split(':').map(Number);
  let h = 0, m = 0, s = 0;
  if (parts.length === 1) {
    // Bare number = total seconds; allowed to exceed 59 ("90" → 00:01:30).
    return parts[0] * 1000;
  }
  else if (parts.length === 2) { m = parts[0]; s = parts[1]; }
  else { h = parts[0]; m = parts[1]; s = parts[2]; }
  if (s > 59 || m > 59) return null;
  return ((h * 3600) + (m * 60) + s) * 1000;
}

/**
 * Manually set a stopwatch's elapsed time (defaults to the active one).
 * Running state is preserved: a running stopwatch keeps ticking onward
 * from the new value; a paused one just banks the value as-is.
 */
function setTime(idOrName, timeStr) {
  const sw = (idOrName && String(idOrName).trim())
    ? _getByIdOrName(idOrName)
    : _requireActive();
  if (!sw) throw new Error(`no stopwatch named "${idOrName}" — see /stopwatch list`);
  const ms = parseTimeInput(timeStr);
  if (ms == null) {
    throw new Error(
      `can't read time "${timeStr}" — use h:mm:ss (1:23:45), mm:ss (12:30), or seconds (90)`);
  }
  sw.baseElapsedMs = ms;
  sw.baseTimestamp = sw.running ? Date.now() : null;
  _save();
  _notify();
  log.info(`[stopwatch] set "${sw.name}" to ${formatMs(ms)} (${sw.running ? 'running' : 'paused'})`);
  return sw;
}

/** Rename a stopwatch (its id stays stable — overlays keep subscribing). */
function rename(idOrName, newName) {
  const sw = _getByIdOrName(idOrName) || _requireActive();
  const trimmed = String(newName || '').trim().slice(0, 48);
  if (!trimmed) throw new Error('new name is required');
  const old = sw.name;
  sw.name = trimmed;
  _save();
  _notify();
  log.info(`[stopwatch] renamed "${old}" → "${trimmed}"`);
  return sw;
}

/** Remove a stopwatch. If it was active, the first remaining one becomes active. */
function remove(idOrName) {
  const sw = _getByIdOrName(idOrName);
  if (!sw) throw new Error(`no stopwatch named "${idOrName}" — see /stopwatch list`);
  _stopwatches = _stopwatches.filter(x => x.id !== sw.id);
  if (_activeId === sw.id) {
    _activeId = _stopwatches.length ? _stopwatches[0].id : null;
  }
  _save();
  _notify();
  log.info(`[stopwatch] deleted "${sw.name}" (id=${sw.id})`);
  return sw;
}

// ── Formatting ─────────────────────────────────────────────────────────────

/** Format ms as HH:MM:SS (clamped at zero — stopwatches never go negative). */
function formatMs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// ── Overlay section registration ───────────────────────────────────────────
//
// The render function is only used when the stopwatch is shown inside the
// main /overlay mosaic. The dedicated /stopwatch page (added below) is what
// OBS should use, but registering the section here means the stopwatch also
// appears in /overlay for debugging / multi-overlay setups.

registerSection('stopwatch', {
  title: 'Stopwatch',
  order: 21,
  icon: `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="12.5" r="7.5" stroke="#e53935" stroke-width="1.5"/>
    <path d="M11 12.5 L11 8" stroke="#e53935" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M11 12.5 L13.8 14" stroke="#e53935" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M9.5 2.5 L12.5 2.5" stroke="#e53935" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M11 2.5 L11 5" stroke="#e53935" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M16.8 6.2 L15.6 7.4" stroke="#e53935" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  render: (function render(data, el, esc, { card, badge }) {
    if (!data) {
      el.innerHTML = '<div style="font-family:Inter,sans-serif;font-size:13px;color:#8a7d7d;' +
        'text-align:center;padding:14px 0">No stopwatch selected</div>';
      badge.textContent = '';
      if (card && card.dataset) card.dataset.state = 'closed';
      return;
    }
    // Same client-side recomputation as the timer's mosaic card.
    var elapsed = data.baseElapsedMs;
    if (data.running && data.baseTimestamp != null) {
      elapsed = data.baseElapsedMs + (Date.now() - data.baseTimestamp);
    }
    var totalSec = Math.max(0, Math.floor(elapsed / 1000));
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    var text = pad(h) + ':' + pad(m) + ':' + pad(s);

    if (card && card.dataset) card.dataset.state = data.running ? '' : 'closed';
    badge.textContent = data.running ? 'RUNNING' : 'PAUSED';

    el.innerHTML =
      '<div style="font-family:Inter,sans-serif;font-size:10px;font-weight:600;' +
        'letter-spacing:0.14em;text-transform:uppercase;color:#9c8f8f;text-align:center;' +
        'padding-top:10px">' + esc(data.name) + '</div>' +
      '<div style="font-family:Inter,sans-serif;font-weight:700;font-size:32px;' +
        'letter-spacing:0.04em;color:#f0e0e0;' +
        'text-shadow:0 0 14px rgba(229,57,53,0.30), 0 1px 3px rgba(0,0,0,0.9);' +
        'text-align:center;padding:8px 0 14px;font-variant-numeric:tabular-nums">' +
        esc(text) +
      '</div>';
  }).toString(),
});

// ── Dashboard widget ───────────────────────────────────────────────────────

dashboard.registerWidget('stopwatch', {
  title: 'Stopwatch',
  order: 21,
  icon: `<svg width="20" height="20" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="12.5" r="7.5" stroke="currentColor" stroke-width="1.5"/>
    <path d="M11 12.5 L11 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M11 12.5 L13.8 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M9.5 2.5 L12.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M11 2.5 L11 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M16.8 6.2 L15.6 7.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
  render: (function render(data, el, esc, { badge }) {
    if (!data) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px">Loading…</p>';
      badge.textContent = '';
      return;
    }

    var list   = data.stopwatches || [];
    var active = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === data.activeId) { active = list[i]; break; }
    }

    // Live readout — recompute from the snapshot each render. For smooth
    // ticking the interval below re-reads this node's __snapshot field.
    function computeElapsed(d) {
      if (!d) return 0;
      if (d.running && d.baseTimestamp != null) {
        return d.baseElapsedMs + (Date.now() - d.baseTimestamp);
      }
      return d.baseElapsedMs;
    }
    function fmt(ms) {
      var totalSec = Math.max(0, Math.floor(ms / 1000));
      var h = Math.floor(totalSec / 3600);
      var m = Math.floor((totalSec % 3600) / 60);
      var s = totalSec % 60;
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      return pad(h) + ':' + pad(m) + ':' + pad(s);
    }

    badge.textContent = active ? (active.running ? 'RUNNING' : 'PAUSED') : 'EMPTY';

    var BTN_BASE =
      'padding:5px 10px;border-radius:4px;border:1px solid var(--border);' +
      'background:transparent;color:var(--text);font-size:11px;font-weight:700;' +
      'letter-spacing:0.04em;cursor:pointer;transition:all 0.15s;font-family:inherit;';
    var BTN_PRIMARY =
      'padding:5px 10px;border-radius:4px;border:none;' +
      'background:var(--accent);color:#fff;font-size:11px;font-weight:700;' +
      'letter-spacing:0.04em;cursor:pointer;transition:opacity 0.15s;font-family:inherit;';
    var INPUT_STYLE =
      'flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:4px;' +
      'color:var(--text);font-size:12px;padding:5px 8px;outline:none;font-family:var(--mono);' +
      'box-sizing:border-box;';
    var SELECT_STYLE =
      'flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);border-radius:4px;' +
      'color:var(--text);font-size:12px;padding:5px 6px;outline:none;font-family:inherit;' +
      'box-sizing:border-box;';

    // ── Preserve in-progress inputs across re-renders ────────────────────
    // The dashboard re-renders this widget on every state push (including
    // the 2s heartbeat). If the operator is mid-typing in the Create or
    // Rename field when a push arrives, capture value + selection before
    // innerHTML wipes it, then restore afterwards. Same trick the timer
    // widget uses for its Set field.
    function captureInput(id) {
      var prev = document.getElementById(id);
      return {
        hadFocus: !!(prev && document.activeElement === prev),
        value:    prev ? prev.value : '',
        selStart: prev ? prev.selectionStart : 0,
        selEnd:   prev ? prev.selectionEnd : 0,
      };
    }
    function restoreInput(id, cap) {
      if (!cap.hadFocus) return;
      var now = document.getElementById(id);
      if (now) {
        now.value = cap.value;
        now.focus();
        try { now.setSelectionRange(cap.selStart, cap.selEnd); } catch (_) {}
      }
    }
    var capCreate = captureInput('stopwatch-create-input');
    var capRename = captureInput('stopwatch-rename-input');
    var capSet    = captureInput('stopwatch-set-input');

    var selectHadFocus = (function () {
      var sel = document.getElementById('stopwatch-select');
      return !!(sel && document.activeElement === sel);
    })();

    // Options only rebuild when the list/selection actually changed. When
    // nothing changed we KEEP the live <select> node: detach it BEFORE the
    // innerHTML wipe, then re-insert it into the fresh row afterwards.
    // (Assigning innerHTML destroys the old subtree — grabbing parentNode
    // AFTER the wipe silently no-oped because the node was already detached,
    // so the dropdown vanished every other heartbeat: visible ~2s, gone
    // ~2s, forever. Detach-then-reinsert in the same synchronous render
    // keeps it continuously visible with its value + listener intact.)
    var listKey = list.map(function (sw) { return sw.id + ':' + sw.name; }).join('|') +
                  '@' + (data.activeId || '');
    var prevSelect = document.getElementById('stopwatch-select');
    var selectChanged = !prevSelect || prevSelect.__listKey !== listKey;
    var keptSelect = (!selectChanged && prevSelect) ? prevSelect : null;
    if (keptSelect && keptSelect.parentNode) {
      keptSelect.parentNode.removeChild(keptSelect);
    }

    var optionsHtml = list.map(function (sw) {
      var sel = sw.id === data.activeId;
      return '<option value="' + esc(sw.id) + '"' + (sel ? ' selected' : '') + '>' +
        esc(sw.name) + '</option>';
    }).join('');

    el.innerHTML =
      // Big readout
      '<div id="stopwatch-readout" style="font-family:var(--mono);font-weight:700;font-size:38px;' +
        'letter-spacing:0.04em;color:var(--accent);text-align:center;' +
        'padding:8px 0 2px;font-variant-numeric:tabular-nums;' +
        'text-shadow:0 0 12px rgba(229,57,53,0.25);">' +
        esc(fmt(active ? computeElapsed(active) : 0)) +
      '</div>' +
      // Active name line
      '<div id="stopwatch-active-name" style="font-size:10px;font-weight:600;letter-spacing:0.14em;' +
        'text-transform:uppercase;color:var(--muted);text-align:center;margin-bottom:12px">' +
        esc(active ? active.name : 'no stopwatch selected') +
      '</div>' +

      (list.length
        ? // Select + delete row
          '<div id="stopwatch-select-row" style="display:flex;gap:6px;margin-bottom:8px">' +
          (selectChanged
            ? '<select id="stopwatch-select" style="' + SELECT_STYLE + '">' + optionsHtml + '</select>'
            : '') +
          '<button id="stopwatch-delete-btn" title="Delete the selected stopwatch" style="' +
            BTN_BASE + ';flex-shrink:0">🗑</button>' +
          '</div>'
        : '<p style="color:var(--muted);font-size:11px;margin-bottom:8px">' +
            'Create your first stopwatch below — it becomes the one on the overlay.' +
          '</p>') +

      // Action buttons (need an active stopwatch)
      (active
        ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
            (active.running
              ? '<button id="stopwatch-pause-btn" style="' + BTN_PRIMARY + ';flex:1">⏸ Pause</button>'
              : '<button id="stopwatch-start-btn" style="' + BTN_PRIMARY + ';flex:1">▶ ' +
                  (active.baseElapsedMs > 0 ? 'Resume' : 'Start') + '</button>') +
            '<button id="stopwatch-reset-btn" style="' + BTN_BASE + ';flex:1">↺ Reset</button>' +
          '</div>' +
          // Rename row
          '<div style="display:flex;gap:6px;margin-bottom:8px">' +
            '<input id="stopwatch-rename-input" type="text" value="' + esc(active.name) + '" ' +
              'placeholder="Rename active…" style="' + INPUT_STYLE + '" />' +
            '<button id="stopwatch-rename-btn" style="' + BTN_BASE + ';flex-shrink:0">Rename</button>' +
          '</div>' +
          // Set-time row — jump the clock to an exact value
          '<div style="display:flex;gap:6px;margin-bottom:8px">' +
            '<input id="stopwatch-set-input" type="text" placeholder="Set time… 1:23:45" ' +
              'title="h:mm:ss (1:23:45), mm:ss (12:30) or plain seconds (90)" ' +
              'style="' + INPUT_STYLE + '" />' +
            '<button id="stopwatch-set-btn" title="Jump the clock to this time" ' +
              'style="' + BTN_BASE + ';flex-shrink:0">Set</button>' +
          '</div>'
        : '') +

      // Create row
      '<div style="display:flex;gap:6px">' +
        '<input id="stopwatch-create-input" type="text" placeholder="New stopwatch name…" ' +
          'maxlength="48" style="' + INPUT_STYLE + '" />' +
        '<button id="stopwatch-create-btn" style="' + BTN_PRIMARY + ';flex-shrink:0">Create</button>' +
      '</div>';

    // Restore in-progress inputs + the preserved dropdown
    restoreInput('stopwatch-create-input', capCreate);
    restoreInput('stopwatch-rename-input', capRename);
    restoreInput('stopwatch-set-input', capSet);
    if (keptSelect) {
      var selRow = document.getElementById('stopwatch-select-row');
      if (selRow) selRow.insertBefore(keptSelect, selRow.firstChild);
    }
    if (selectHadFocus) {
      var newSel = document.getElementById('stopwatch-select');
      if (newSel) { newSel.value = data.activeId; newSel.focus(); }
    }
    var curSelect = document.getElementById('stopwatch-select');
    if (curSelect) curSelect.__listKey = listKey;

    // ── Live ticker ───────────────────────────────────────────────────────
    var readout = document.getElementById('stopwatch-readout');
    if (!window.__stopwatchTickInterval) {
      window.__stopwatchTickInterval = setInterval(function () {
        var r = document.getElementById('stopwatch-readout');
        if (!r || !r.__snapshot) return;
        var d = r.__snapshot;
        r.textContent = fmt(computeElapsed(d));
      }, 200);
    }
    if (readout) readout.__snapshot = active;

    // ── Button wiring ─────────────────────────────────────────────────────
    function action(name, payload) {
      return fetch('/dashboard/action', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(Object.assign({ action: 'stopwatch-' + name }, payload || {})),
      }).then(function (r) { return r.json(); });
    }
    function flash(btn, errText, okText) {
      if (!btn) return;
      btn.textContent = errText;
      setTimeout(function () { btn.textContent = okText; }, 1500);
    }
    function bind(id, name, before) {
      var b = document.getElementById(id);
      if (!b) return;
      b.addEventListener('click', function () {
        if (before && before() === false) return;
        b.disabled = true; b.style.opacity = '0.5';
        action(name)
          .then(function () { b.disabled = false; b.style.opacity = '1'; })
          .catch(function () { b.disabled = false; b.style.opacity = '1'; });
      });
    }
    bind('stopwatch-start-btn', 'start');
    bind('stopwatch-pause-btn', 'pause');
    bind('stopwatch-reset-btn', 'reset');

    var selEl = document.getElementById('stopwatch-select');
    // A preserved <select> survives across renders — wire it exactly once,
    // or every heartbeat would stack another change listener onto the same
    // node (one pick → N duplicate POSTs).
    if (selEl && !selEl.__wired) {
      selEl.__wired = true;
      selEl.addEventListener('change', function () {
        selEl.disabled = true;
        action('select', { id: selEl.value })
          .then(function () { selEl.disabled = false; })
          .catch(function () { selEl.disabled = false; });
      });
    }

    var delBtn = document.getElementById('stopwatch-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        var victim = selEl ? selEl.value : data.activeId;
        var victimName = '';
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === victim) { victimName = list[i].name; break; }
        }
        if (!victim || !window.confirm('Delete stopwatch "' + victimName + '"? Its saved time is lost.')) return;
        delBtn.disabled = true; delBtn.style.opacity = '0.5';
        action('delete', { id: victim })
          .then(function () { delBtn.disabled = false; delBtn.style.opacity = '1'; })
          .catch(function () { delBtn.disabled = false; delBtn.style.opacity = '1'; });
      });
    }

    var createBtn = document.getElementById('stopwatch-create-btn');
    if (createBtn) {
      var createInp = document.getElementById('stopwatch-create-input');
      if (createInp) createInp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') createBtn.click();
      });
      createBtn.addEventListener('click', function () {
        var val = createInp ? createInp.value.trim() : '';
        if (!val) return;
        createBtn.disabled = true; createBtn.style.opacity = '0.5';
        action('create', { name: val })
          .then(function (res) {
            createBtn.disabled = false; createBtn.style.opacity = '1';
            if (!res || res.ok === false) { flash(createBtn, '✗', 'Create'); }
            else if (createInp) { createInp.value = ''; }
          })
          .catch(function () {
            createBtn.disabled = false; createBtn.style.opacity = '1';
            flash(createBtn, '✗', 'Create');
          });
      });
    }

    var renameBtn = document.getElementById('stopwatch-rename-btn');
    if (renameBtn) {
      var renameInp = document.getElementById('stopwatch-rename-input');
      if (renameInp) renameInp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') renameBtn.click();
      });
      renameBtn.addEventListener('click', function () {
        var val = renameInp ? renameInp.value.trim() : '';
        if (!val || !active) return;
        renameBtn.disabled = true; renameBtn.style.opacity = '0.5';
        action('rename', { name: val })
          .then(function (res) {
            renameBtn.disabled = false; renameBtn.style.opacity = '1';
            if (!res || res.ok === false) flash(renameBtn, '✗', 'Rename');
          })
          .catch(function () {
            renameBtn.disabled = false; renameBtn.style.opacity = '1';
            flash(renameBtn, '✗', 'Rename');
          });
      });
    }

    var setBtn = document.getElementById('stopwatch-set-btn');
    if (setBtn) {
      var setInp = document.getElementById('stopwatch-set-input');
      if (setInp) setInp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') setBtn.click();
      });
      setBtn.addEventListener('click', function () {
        var val = setInp ? setInp.value.trim() : '';
        if (!val || !active) return;
        setBtn.disabled = true; setBtn.style.opacity = '0.5';
        action('set', { time: val })
          .then(function (res) {
            setBtn.disabled = false; setBtn.style.opacity = '1';
            if (!res || res.ok === false) { flash(setBtn, '✗', 'Set'); }
            else if (setInp) { setInp.value = ''; }
          })
          .catch(function () {
            setBtn.disabled = false; setBtn.style.opacity = '1';
            flash(setBtn, '✗', 'Set');
          });
      });
    }
  }).toString(),
});

// ── Dashboard action handlers ──────────────────────────────────────────────

dashboard.registerAction('stopwatch-create', async (body) => {
  try {
    const sw = create(body && body.name);
    return { ok: true, id: sw.id, name: sw.name };
  } catch (err) {
    log.warn(`[stopwatch] create failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

dashboard.registerAction('stopwatch-select', async (body) => {
  try {
    const sw = select(body && body.id);
    return { ok: true, id: sw.id, name: sw.name };
  } catch (err) {
    log.warn(`[stopwatch] select failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

dashboard.registerAction('stopwatch-start', async () => {
  try { start();  return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

dashboard.registerAction('stopwatch-pause', async () => {
  try { pause();  return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

dashboard.registerAction('stopwatch-reset', async () => {
  try { reset();  return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

dashboard.registerAction('stopwatch-set', async (body) => {
  try {
    const sw = setTime(null, body && body.time); // null → operates on the active one
    return { ok: true, id: sw.id, name: sw.name, elapsedMs: sw.baseElapsedMs };
  } catch (err) {
    log.warn(`[stopwatch] set failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

dashboard.registerAction('stopwatch-rename', async (body) => {
  try {
    const sw = rename(null, body && body.name); // null → operates on the active one
    return { ok: true, id: sw.id, name: sw.name };
  } catch (err) {
    log.warn(`[stopwatch] rename failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

dashboard.registerAction('stopwatch-delete', async (body) => {
  try {
    const sw = remove(body && body.id);
    return { ok: true, id: sw.id, name: sw.name };
  } catch (err) {
    log.warn(`[stopwatch] delete failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ── Discord slash command ──────────────────────────────────────────────────

const stopwatchCommand = new SlashCommandBuilder()
  .setName('stopwatch')
  .setDescription('Control the speedrun-style stopwatch overlay (counts up)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub => sub
    .setName('create')
    .setDescription('Create a new stopwatch and switch the overlay to it')
    .addStringOption(o => o
      .setName('name')
      .setDescription('Name for the stopwatch (e.g. "Cuphead")')
      .setRequired(true)))
  .addSubcommand(sub => sub
    .setName('use')
    .setDescription('Make an existing stopwatch the one on the overlay')
    .addStringOption(o => o
      .setName('name')
      .setDescription('Stopwatch name (see /stopwatch list)')
      .setRequired(true)))
  .addSubcommand(sub => sub
    .setName('list')
    .setDescription('List all stopwatches (▶ = the one on the overlay)'))
  .addSubcommand(sub => sub
    .setName('start')
    .setDescription('Start (or resume) the active stopwatch'))
  .addSubcommand(sub => sub
    .setName('pause')
    .setDescription('Pause the active stopwatch and save it to disk'))
  .addSubcommand(sub => sub
    .setName('resume')
    .setDescription('Resume the active stopwatch'))
  .addSubcommand(sub => sub
    .setName('reset')
    .setDescription('Reset the active stopwatch to 00:00:00'))
  .addSubcommand(sub => sub
    .setName('set')
    .setDescription('Manually set the time (e.g. 1:23:45, 12:30, or 90)')
    .addStringOption(o => o
      .setName('time')
      .setDescription('h:mm:ss, mm:ss, or plain seconds — e.g. 1:23:45')
      .setRequired(true))
    .addStringOption(o => o
      .setName('name')
      .setDescription('Which stopwatch (default: the active one)')))
  .addSubcommand(sub => sub
    .setName('rename')
    .setDescription('Rename the active stopwatch')
    .addStringOption(o => o
      .setName('name')
      .setDescription('New name')
      .setRequired(true)))
  .addSubcommand(sub => sub
    .setName('delete')
    .setDescription('Delete a stopwatch permanently')
    .addStringOption(o => o
      .setName('name')
      .setDescription('Stopwatch name (see /stopwatch list)')
      .setRequired(true)))
  .addSubcommand(sub => sub
    .setName('status')
    .setDescription('Show the active stopwatch state'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'create': {
      const raw = interaction.options.getString('name', true);
      try {
        const sw = create(raw);
        await interaction.editReply(
          `⏱ Stopwatch \`${sw.name}\` created and now on the overlay at \`00:00:00\`. ` +
          `Start it from the dashboard or \`/stopwatch start\`.`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'use': {
      const raw = interaction.options.getString('name', true);
      try {
        const sw = select(raw);
        await interaction.editReply(
          `⏱ Overlay switched to \`${sw.name}\` — currently \`${formatMs(_elapsedOf(sw))}\` ` +
          `(${sw.running ? 'running' : 'paused'}).`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'list': {
      if (!_stopwatches.length) {
        await interaction.editReply('No stopwatches yet — create one with `/stopwatch create <name>`.');
        return;
      }
      const lines = _stopwatches.map(sw =>
        `${sw.id === _activeId ? '▶' : '　'} \`${sw.name}\` — \`${formatMs(_elapsedOf(sw))}\` ` +
        `(${sw.running ? 'running' : 'paused'})`);
      await interaction.editReply(`⏱ Stopwatches (▶ = on the overlay):\n${lines.join('\n')}`);
      return;
    }
    case 'start': {
      try {
        const sw = start();
        await interaction.editReply(
          `▶ \`${sw.name}\` running — \`${formatMs(_elapsedOf(sw))}\`.`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'pause': {
      try {
        const sw = pause();
        await interaction.editReply(
          `⏸ \`${sw.name}\` paused and **saved** at \`${formatMs(sw.baseElapsedMs)}\`.`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'resume': {
      try {
        const sw = start();
        await interaction.editReply(
          `▶ \`${sw.name}\` resumed — \`${formatMs(_elapsedOf(sw))}\`.`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'reset': {
      try {
        const sw = reset();
        await interaction.editReply(`↺ \`${sw.name}\` reset to \`00:00:00\`.`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'set': {
      const raw = interaction.options.getString('time', true);
      const name = interaction.options.getString('name');
      try {
        const sw = setTime(name, raw);
        await interaction.editReply(
          `⏱ \`${sw.name}\` set to \`${formatMs(sw.baseElapsedMs)}\` — ` +
          `${sw.running ? 'running from there' : 'paused'}.`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'rename': {
      const raw = interaction.options.getString('name', true);
      try {
        const sw = rename(null, raw);
        await interaction.editReply(`✏️ Renamed to \`${sw.name}\`.`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'delete': {
      const raw = interaction.options.getString('name', true);
      try {
        const sw = remove(raw);
        await interaction.editReply(`🗑 Deleted \`${sw.name}\`.`);
      } catch (err) {
        await interaction.editReply(`⚠️ ${err.message}`);
      }
      return;
    }
    case 'status': {
      const sw = _getActive();
      if (!sw) {
        await interaction.editReply('No active stopwatch — create one with `/stopwatch create <name>`.');
        return;
      }
      await interaction.editReply(
        `⏱ \`${sw.name}\`: \`${formatMs(_elapsedOf(sw))}\` — ` +
        `${sw.running ? 'running' : 'paused'}${sw.id === _activeId ? ' (on the overlay)' : ''}`);
      return;
    }
    default:
      await interaction.editReply(`⚠️ Unknown subcommand: \`${sub}\``);
  }
}

// ── Standalone OBS overlay page ────────────────────────────────────────────
//
// Visual clone of the timer's overlay page (same fonts, glow, paused
// treatment, pinned-visibility trick) with two differences: it counts UP,
// and it can optionally show the stopwatch's name via ?name=1.
// The SSE subscription is the same /sse stream the rest of the overlay uses.
//
// NOTE on ticking (same as timer): OBS's Browser Source (CEF) throttles
// requestAnimationFrame for pages it considers "not visible". We pin the
// Page Visibility API to "visible" and drive the tick off setInterval.

function buildStopwatchOverlayHtml() {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Stopwatch Overlay</title>
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

  .stopwatch-name {
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.65);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
    position: absolute;
    top: 0;
    left: 0;
    white-space: nowrap;
    display: none;
    padding-bottom: 4px;
  }

  /* Bare digits on a transparent canvas — identical treatment to /timer:
     no card, no chrome, subtle red glow over a dark contrast layer. */
  .stopwatch-display {
    font-family: 'Inter', sans-serif;
    font-weight: 700;
    font-size: 64px;
    letter-spacing: 0.06em;
    color: #ffffff;
    text-shadow:
      0 1px 3px rgba(0, 0, 0, 0.95),
      0 0 6px rgba(0, 0, 0, 0.55),
      0 0 14px rgba(229, 57, 53, 0.35),
      0 0 28px rgba(229, 57, 53, 0.18);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    transition: color 0.3s ease, text-shadow 0.3s ease;
    position: absolute;
    top: 0;
    left: 0;
    white-space: nowrap;
  }

  /* Paused — dim the digits but keep the contrast shadow. */
  .stopwatch-display.paused {
    color: #c8b8b8;
    text-shadow:
      0 1px 3px rgba(0, 0, 0, 0.95),
      0 0 6px rgba(0, 0, 0, 0.55),
      0 0 8px rgba(229, 57, 53, 0.12),
      0 0 18px rgba(229, 57, 53, 0.06);
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
    position: absolute;
    top: 74px;
    left: 0;
  }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<div class="stopwatch-name" id="swname"></div>
<div class="stopwatch-display paused" id="display">00:00:00</div>
<div class="msg-reconnecting" id="reconn">⚠ RECONNECTING…</div>

<script>
(function () {
  // OBS/CEF throttles rAF + timers for sources it considers "not visible"
  // (i.e. not on the active scene). Pin visibility so ticking never stalls.
  try {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  } catch (_) {}

  var display = document.getElementById('display');
  var nameEl  = document.getElementById('swname');
  var reconn  = document.getElementById('reconn');

  var SHOW_NAME = /[?&]name=1/.test(location.search);

  var latest = null;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmt(ms) {
    var totalSec = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  function computeElapsed(d) {
    if (!d) return 0;
    if (d.running && d.baseTimestamp != null) {
      return d.baseElapsedMs + (Date.now() - d.baseTimestamp);
    }
    return d.baseElapsedMs;
  }

  function position() {
    // When the name label is shown, push the digits below it.
    display.style.top = SHOW_NAME ? '26px' : '0px';
  }

  function render() {
    var elapsed = computeElapsed(latest);
    display.textContent = fmt(elapsed);

    var running = !!(latest && latest.running);
    display.classList.toggle('paused', !running);

    if (SHOW_NAME) {
      nameEl.style.display = latest && latest.name ? 'block' : 'none';
      nameEl.textContent = latest ? latest.name : '';
    }
  }

  position();
  setInterval(render, 250);

  function connect() {
    var es = new EventSource('/sse');
    es.onopen = function () { reconn.style.display = 'none'; render(); };
    es.onmessage = function (e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'section' && msg.id === 'stopwatch') {
          latest = msg.data;
          render(); // redraw immediately on every push
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

addRoute('/stopwatch', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(buildStopwatchOverlayHtml());
});

// ── Slow heartbeat re-broadcast ───────────────────────────────────────────
// Same rationale as the timer: the overlay and dashboard widget tick
// CLIENT-SIDE from the latest snapshot, so we only re-broadcast every 2s —
// enough for a freshly-loaded OBS source or dashboard to pick up current
// state quickly, and to heal a dropped mutation message. 2s is also slow
// enough that the widget's input-preservation logic absorbs re-renders
// without clobbering in-progress typing.

const HEARTBEAT_INTERVAL_MS = 2000;
setInterval(_notify, HEARTBEAT_INTERVAL_MS);

// ── Plugin export ──────────────────────────────────────────────────────────

_load();

module.exports = {
  id: 'stopwatch',

  commands: [stopwatchCommand],
  handleInteraction,

  init() {
    log.info('[stopwatch] plugin initialised — overlay at /stopwatch, slash command /stopwatch, ' +
      `${_stopwatches.length} stopwatch(es) loaded from disk`);
    _notify();
  },

  async processMessage(msg) {
    return { message: msg };
  },
};