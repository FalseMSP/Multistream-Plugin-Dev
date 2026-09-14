'use strict';

// ─── gacha-results plugin ─────────────────────────────────────────────────────
//
// Dashboard widget that shows every gacha pull result (single pulls AND
// grid pulls) and lets the streamer mark each one as fulfilled ("−"
// button) once they've actually delivered the reward to the viewer.
//
// Features:
//   • Live list of pull results (user, label, rarity, timestamp, fulfilled)
//   • Filter by user (dropdown populated from the result set)
//   • Free-text search (matches user / label / rarity)
//   • "−" button on each row to mark as fulfilled
//   • "Fulfilled" toggle to hide/show fulfilled rows
//   • Clear-fulfilled button to wipe the list
//   • Persists to results.json next to this file
//
// Source of truth: gacha.onResult(cb) — the gacha plugin calls us every
// time a pull completes. We also expose a dashboard action so the
// widget's "−" button can round-trip through the server to flip the
// fulfilled flag and broadcast the updated list back to all clients.

const log       = require('../../logger');
const fs        = require('fs');
const path       = require('path');
const dashboard = require('../../dashboard');
const gacha      = require('../gacha');

const DATA_FILE = path.resolve(__dirname, 'results.json');
const MAX_RESULTS = 500; // cap to keep the file + widget payload bounded

// ─── In-memory state ─────────────────────────────────────────────────────────

/** @type {Array<{ id: number, user: string, label: string, rarity: string, isDud: boolean, timestamp: string, fulfilled: boolean }>} */
let _results = [];

function _load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      _results = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      log.info(`[gacha-results] Loaded ${_results.length} saved result(s) from disk.`);
    }
  } catch (e) {
    log.error('[gacha-results] Failed to load results.json — starting fresh:', e.message);
    _results = [];
  }
}

function _save() {
  try {
    // Only persist the tail (most recent MAX_RESULTS). Trim before write
    // so the file doesn't grow unbounded over months of streaming.
    const trimmed = _results.slice(-MAX_RESULTS);
    fs.writeFileSync(DATA_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (e) {
    log.error('[gacha-results] Failed to save results.json:', e.message);
  }
}

// ─── Widget state push ────────────────────────────────────────────────────────
//
// The widget render function (below) runs in the browser, but the SEARCH
// and FILTER state has to live there — we can't push filter state from
// the server or it would clobber what the mod is typing. So we push the
// raw result list and let the browser filter on its own end.

function _pushState() {
  // Compute the unique-user list server-side so the dropdown doesn't
  // have to be rebuilt every render.
  const users = [];
  const seen = new Set();
  for (const r of _results) {
    const key = String(r.user ?? '').toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); users.push(r.user); }
  }
  users.sort((a, b) => String(a).toLowerCase().localeCompare(String(b).toLowerCase()));

  dashboard.updateWidget('gacha-results', {
    results: _results.slice().reverse(), // newest first
    users,
    max: MAX_RESULTS,
  });
}

// ─── Result listener (called by gacha plugin) ─────────────────────────────────

function _onResult(result) {
  // result shape from gacha: { id, user, label, rarity, isDud, timestamp }
  // We re-serialize the timestamp to ISO string so JSON stays clean.
  _results.push({
    id:        result.id,
    user:      result.user,
    label:     result.label,
    rarity:    result.rarity,
    isDud:     !!result.isDud,
    timestamp: result.timestamp instanceof Date ? result.timestamp.toISOString() : String(result.timestamp),
    fulfilled: false,
  });

  // Trim in-memory immediately (don't wait for next _save())
  if (_results.length > MAX_RESULTS) {
    _results = _results.slice(-MAX_RESULTS);
  }
  _save();
  _pushState();
}

// ─── Dashboard action: mark a result as fulfilled ─────────────────────────────

async function _handleFulfillAction(body) {
  const { resultId, clear } = body;

  // `clear: true` → mark ALL as fulfilled (used by the "Clear fulfilled" button)
  if (clear) {
    _results = _results.filter(r => !r.fulfilled);
    _save();
    _pushState();
    log.info(`[gacha-results] Cleared all fulfilled results (${_results.length} remaining).`);
    return { ok: true, remaining: _results.length };
  }

  // Normal case: flip the fulfilled flag on one result by id.
  if (typeof resultId !== 'number') {
    return { ok: false, error: 'Missing or non-numeric resultId' };
  }
  const target = _results.find(r => r.id === resultId);
  if (!target) {
    return { ok: false, error: `No result with id ${resultId}` };
  }
  target.fulfilled = true;
  _save();
  _pushState();
  log.info(`[gacha-results] Marked result #${resultId} (${target.label} for ${target.user}) as fulfilled.`);
  return { ok: true, result: target };
}

// ─── Dashboard widget render ──────────────────────────────────────────────────
//
// Serialized via .toString() and eval'd in the browser. Receives
// (data, el, esc, helpers) — same contract as stream-title's render fn.
//
// State (search string, filter user, show-fulfilled toggle) lives in
// closure variables inside the render fn so it survives re-renders
// triggered by SSE updates. The pattern: on first render we initialize
// the closure; on subsequent renders we *re-use* the existing DOM
// references and just re-render the list body, so the search input the
// mod is typing in doesn't get clobbered.

const RARITY_COLORS = {
  common:    '#aaaaaa',
  uncommon:  '#4cff82',
  rare:      '#4ab4ff',
  epic:      '#c47eff',
  legendary: '#ffd54a',
  mythic:    '#ff6060',
  oneofone:  '#ff4ef7',
  dud:       '#888888',
};

// Note: RARITY_COLORS is also inlined inside the render function below,
// because the dashboard compiles the render fn via `new Function(...)` in
// the browser's global scope, where it CANNOT see module-level constants.
// If you change a color here, also change the inline copy.

const _widgetRender = (function render(data, el, esc) {
  // ─── Per-render persistent state (survives SSE re-renders) ──────────────
  if (!el.__gachaResultsState) {
    el.__gachaResultsState = {
      search:    '',
      filterUser: '',
      showFulfilled: true,
    };
  }
  const state = el.__gachaResultsState;

  // Inline copy of RARITY_COLORS — see the comment above the render fn.
  const RARITY_COLORS = {
    common:    '#aaaaaa',
    uncommon:  '#4cff82',
    rare:      '#4ab4ff',
    epic:      '#c47eff',
    legendary: '#ffd54a',
    mythic:    '#ff6060',
    oneofone:  '#ff4ef7',
    dud:       '#888888',
  };

  // ─── Build (or rebuild) the chrome if needed ────────────────────────────
  // We compare el.__chromeBuilt so we don't blow away focus on the search
  // box every time data updates. The chrome only needs to be built once
  // per widget instance — after that, only the list rows change.
  if (!el.__chromeBuilt) {
    el.__chromeBuilt = true;
    el.innerHTML =
      '<div style="display:flex;flex-direction:column;gap:6px;font-family:inherit">' +
        // Search + filter row
        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
          '<input id="gr-search" type="text" placeholder="Search results…" ' +
            'style="flex:1;min-width:120px;background:var(--bg);border:1px solid var(--border);' +
            'border-radius:4px;color:var(--text);font-size:11px;padding:4px 8px;outline:none;' +
            'font-family:inherit;box-sizing:border-box;" />' +
          '<select id="gr-filter-user" ' +
            'style="background:var(--bg);border:1px solid var(--border);border-radius:4px;' +
            'color:var(--text);font-size:11px;padding:4px 6px;outline:none;font-family:inherit;">' +
            '<option value="">All users</option>' +
          '</select>' +
          '<label style="font-size:10px;color:var(--muted);display:flex;align-items:center;gap:3px;">' +
            '<input type="checkbox" id="gr-show-fulfilled" style="margin:0;" />' +
            'Show fulfilled' +
          '</label>' +
          '<button id="gr-clear-fulfilled" ' +
            'style="margin-left:auto;background:transparent;border:1px solid var(--border);' +
            'border-radius:4px;color:var(--muted);font-size:10px;padding:3px 8px;cursor:pointer;' +
            'font-family:inherit;letter-spacing:0.06em;text-transform:uppercase;">' +
            'Clear fulfilled' +
          '</button>' +
        '</div>' +
        // List body — re-rendered on every data change
        '<div id="gr-list" style="display:flex;flex-direction:column;gap:4px;max-height:340px;' +
          'overflow-y:auto;padding-right:4px;"></div>' +
        // Empty-state placeholder
        '<div id="gr-empty" style="color:var(--muted);font-size:11px;text-align:center;padding:12px;">' +
          'No pulls yet.' +
        '</div>' +
      '</div>';

    // Wire up the inputs ONCE — they persist across re-renders.
    const search = el.querySelector('#gr-search');
    const filter = el.querySelector('#gr-filter-user');
    const showF = el.querySelector('#gr-show-fulfilled');
    const clearB = el.querySelector('#gr-clear-fulfilled');

    search.value = state.search;
    filter.value = state.filterUser;
    showF.checked = state.showFulfilled;

    search.addEventListener('input', function() {
      state.search = search.value;
      renderList();
    });
    filter.addEventListener('change', function() {
      state.filterUser = filter.value;
      renderList();
    });
    showF.addEventListener('change', function() {
      state.showFulfilled = showF.checked;
      renderList();
    });

    clearB.addEventListener('click', function() {
      clearB.disabled = true;
      fetch('/dashboard/action', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'gacha-fulfill-result', clear: true }),
      })
        .then(function(r) { return r.json(); })
        .finally(function() { clearB.disabled = false; });
    });

    // The list-rendering function lives in this closure so the input
    // handlers above can call it. It reads `data` from the outer render
    // fn's current invocation — which means we need to re-bind it on
    // every render. Simpler: stash the latest data on the element and
    // have renderList read from there.
    el.__renderList = function() {
      const data = el.__latestData;
      if (!data) return;

      const list  = el.querySelector('#gr-list');
      const empty = el.querySelector('#gr-empty');
      if (!list) return;

      const results = data.results || [];

      // Apply filters
      const searchLower = state.search.trim().toLowerCase();
      const filtered = results.filter(function(r) {
        if (state.filterUser && r.user !== state.filterUser) return false;
        if (!state.showFulfilled && r.fulfilled) return false;
        if (searchLower) {
          const hay = (String(r.user) + ' ' + String(r.label) + ' ' + String(r.rarity)).toLowerCase();
          if (hay.indexOf(searchLower) === -1) return false;
        }
        return true;
      });

      // Render rows
      list.innerHTML = filtered.map(function(r) {
        var color = RARITY_COLORS[r.rarity] || '#ffffff';
        var time  = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '';
        var fulfilledStyle = r.fulfilled
          ? 'opacity:0.45;text-decoration:line-through;'
          : '';
        var rarityLabel = r.rarity === 'oneofone' ? '1of1' :
          (r.rarity || '').slice(0, 4);
        return (
          '<div style="display:flex;align-items:center;gap:8px;padding:5px 7px;border:1px solid var(--border);' +
            'border-radius:4px;background:rgba(0,0,0,0.18);' + fulfilledStyle + '">' +
            // Rarity dot + label
            '<span style="flex:0 0 auto;display:flex;align-items:center;gap:4px;">' +
              '<span style="width:8px;height:8px;border-radius:50%;' +
                'background:' + color + ';box-shadow:0 0 8px ' + color + ';"></span>' +
              '<span style="font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;' +
                'color:' + color + ';min-width:42px;">' + esc(rarityLabel) + '</span>' +
            '</span>' +
            // Label
            '<span style="flex:1;font-size:11px;font-weight:600;color:var(--text);' +
              'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              esc(r.label) +
            '</span>' +
            // User
            '<span style="flex:0 0 auto;font-size:10px;color:var(--muted);max-width:110px;' +
              'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              esc(r.user) +
            '</span>' +
            // Time
            '<span style="flex:0 0 auto;font-size:10px;color:var(--muted);font-family:var(--mono);">' +
              esc(time) +
            '</span>' +
            // Fulfill button (− icon)
            (r.fulfilled
              ? '<span style="flex:0 0 auto;font-size:11px;color:#4ade80;">✓ done</span>'
              : '<button data-id="' + r.id + '" ' +
                  'style="flex:0 0 auto;background:transparent;border:1px solid var(--border);' +
                  'border-radius:3px;color:var(--accent);font-size:14px;font-weight:700;' +
                  'cursor:pointer;padding:0 6px;line-height:1.1;font-family:inherit;">−</button>') +
          '</div>'
        );
      }).join('');

      // Wire up the − buttons
      var btns = list.querySelectorAll('button[data-id]');
      for (var i = 0; i < btns.length; i++) {
        (function(btn) {
          btn.addEventListener('click', function() {
            btn.disabled = true;
            btn.style.opacity = '0.4';
            fetch('/dashboard/action', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({
                action:   'gacha-fulfill-result',
                resultId: parseInt(btn.getAttribute('data-id'), 10),
              }),
            })
              .then(function(r) { return r.json(); })
              .finally(function() {
                btn.disabled = false;
                btn.style.opacity = '1';
              });
          });
        })(btns[i]);
      }

      // Toggle empty state
      if (empty) {
        empty.style.display = filtered.length === 0 ? 'block' : 'none';
        if (filtered.length === 0) {
          empty.textContent = (results.length === 0)
            ? 'No pulls yet.'
            : 'No results match your filters.';
        }
      }

      // Rebuild the filter-user dropdown options (without losing the
      // current selection).
      var users = data.users || [];
      var currentVal = filter.value;
      // Keep the existing selection if it's still in the list.
      var options = ['<option value="">All users</option>'];
      for (var j = 0; j < users.length; j++) {
        var u = users[j];
        var sel = (u === currentVal) ? ' selected' : '';
        options.push('<option value="' + esc(u) + '"' + sel + '>' + esc(u) + '</option>');
      }
      filter.innerHTML = options.join('');
      filter.value = currentVal; // restore selection
    };
  }

  // Stash the latest data and (re)render the list.
  el.__latestData = data;
  if (el.__renderList) el.__renderList();
}).toString();

// ─── Widget registration ─────────────────────────────────────────────────────

dashboard.registerWidget('gacha-results', {
  title: 'Gacha Results',
  order: 8,
  icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
           <polyline points="20 6 9 17 4 12"/>
         </svg>`,
  render: _widgetRender,
});

// ─── Plugin lifecycle ─────────────────────────────────────────────────────────

function init() {
  _load();
  // Subscribe to gacha pull results so we can populate the list.
  if (typeof gacha.onResult === 'function') {
    gacha.onResult(_onResult);
    log.info('[gacha-results] Subscribed to gacha.onResult.');
  } else {
    log.warn('[gacha-results] gacha.onResult not available — widget will stay empty.');
  }
  // Register the dashboard action for the "−" buttons.
  dashboard.registerAction('gacha-fulfill-result', _handleFulfillAction);
  // Push initial state (loaded from disk).
  _pushState();
  log.info('[gacha-results] Plugin loaded.');
}

module.exports = {
  id: 'gacha-results',
  init,
};
