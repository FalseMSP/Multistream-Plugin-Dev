'use strict';

/**
 * stream-stats plugin
 * ────────────────────
 * Live viewcount widget for the dashboard, with a viewer graph over time.
 *
 * Data comes from context.streamInfo (src/stream-info.js — the shared Twitch
 * /streams poller), which exposes:
 *   • the active game + live viewer count while live
 *   • a per-session viewer time-series (one sample per poll)
 *   • FROZEN session data once the stream ends — the graph stops moving and
 *     stays downloadable until the next stream starts
 *
 * What this plugin adds on top:
 *   • a "Live Viewers" dashboard widget: big viewer number, game + title,
 *     peak / avg / uptime chips, an SVG line chart of viewers over time with
 *     hover tooltip and game-change markers
 *   • CSV export — the "CSV" button downloads the shown session; the
 *     "all sessions" button downloads every archived session (server action
 *     'stream-stats-csv')
 *   • a `!game` chat command that says what's currently being played
 *     (also demonstrates how plugins consume context.streamInfo)
 *
 * Env (all optional — see src/stream-info.js):
 *   STREAM_INFO_POLL_SECONDS, STREAM_INFO_MAX_SESSIONS,
 *   STREAM_INFO_MAX_SAMPLES, STREAM_INFO_DATA_FILE
 */

const log          = require('../../logger');
const dashboard    = require('../../dashboard');
const commandsList = require('../commands-list');

const CMD_GAME = /^!game\s*$/i;

// ── Lazy refs (set by init) ────────────────────────────────────────────────
let _streamInfo = null;
let _chatReply  = { twitch: null, youtube: null, youtubeSession: null };

// ── Dashboard widget ───────────────────────────────────────────────────────

dashboard.registerWidget('stream-stats', {
  title: 'Live Viewers',
  order: 6,
  icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
           <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
           <circle cx="12" cy="12" r="3"/>
         </svg>`,

  // NOTE: this function is serialised via .toString() and eval'd in the
  // browser — it must be fully self-contained (no outer-scope references).
  //
  // Render-contract history: WIDGET_AUTHORING.md documents the 4th argument
  // as { card, badge }, and the overlay mosaic has always passed both — but
  // the dashboard's invoke() used to pass { badge } only, so touching
  // card.* crashed the render with a TypeError and left the widget body
  // blank. The dashboard now passes { card, badge } too; we STILL resolve
  // the card defensively (host-provided, else el.closest('.widget-card'))
  // and guard every use — the card state is cosmetic, never worth crashing
  // the whole widget over.
  render: (function render(data, el, esc, { card, badge }) {
    var cardEl = card || (typeof el.closest === 'function' ? el.closest('.widget-card') : null);

    if (!data || !data.session) {
      if (cardEl) cardEl.dataset.state = 'idle';
      badge.textContent = '';
      el.innerHTML = data && data.unavailable
        ? '<p style="color:var(--muted);font-size:12px;font-family:var(--mono)">stream-info module not available — update index.js init context</p>'
        : '<p style="color:var(--muted);font-size:12px;font-family:var(--mono)">Offline — waiting for the next stream…</p>';
      return;
    }

    var S       = data.session;
    var live    = !!S.live;
    var samples = S.samples || [];
    var games   = S.games || [];

    if (cardEl) cardEl.dataset.state = live ? 'live' : 'frozen';
    badge.textContent  = live ? (S.viewers + ' watching') : 'frozen';

    function fmtNum(n) { return Number(n == null ? 0 : n).toLocaleString('en-US'); }
    function fmtClock(t) {
      var d = new Date(t);
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function fmtDur(ms) {
      if (!ms || ms < 0) ms = 0;
      var s = Math.floor(ms / 1000);
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return h > 0 ? (h + 'h ' + m + 'm') : (m + 'm ' + (s % 60) + 's');
    }

    // ── Header: big number (live) or ENDED summary (frozen) ────────────────
    var headHtml;
    if (live) {
      headHtml =
        '<div style="display:flex;align-items:baseline;gap:10px;padding:2px 0 8px">' +
          '<span style="font-family:var(--mono);font-size:34px;font-weight:900;color:var(--accent);line-height:1">' +
            fmtNum(S.viewers) +
          '</span>' +
          '<span style="color:var(--muted);font-size:11px">viewers now</span>' +
          '<span style="margin-left:auto;display:flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:0.08em;color:#22c55e">' +
            '<span style="width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,0.3)"></span>LIVE' +
          '</span>' +
        '</div>';
    } else {
      headHtml =
        '<div style="display:flex;align-items:baseline;gap:10px;padding:2px 0 8px">' +
          '<span style="font-family:var(--mono);font-size:20px;font-weight:900;color:var(--muted);line-height:1">ENDED</span>' +
          '<span style="color:var(--muted);font-size:11px">' +
            (S.endedAt ? 'data frozen · ' + fmtDur(S.durationMs) + ' stream' : '') +
          '</span>' +
          '<span style="margin-left:auto;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:0.08em;color:var(--muted)">&#9208; FROZEN</span>' +
        '</div>';
    }

    // ── Game + title ───────────────────────────────────────────────────────
    var gameHtml =
      '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:2px">' +
        '&#127918; ' + esc(S.game || 'Unknown') +
      '</div>' +
      (S.title
        ? '<div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:8px" title="' + esc(S.title) + '">' + esc(S.title) + '</div>'
        : '<div style="margin-bottom:8px"></div>');

    // ── Stat chips ─────────────────────────────────────────────────────────
    var chips = [
      { label: live ? 'uptime' : 'duration', value: fmtDur(S.durationMs) },
      { label: 'peak',   value: fmtNum(S.peak) + (S.peakAt ? ' · ' + fmtClock(S.peakAt) : '') },
      { label: 'avg',    value: fmtNum(S.avg) },
      { label: 'points', value: fmtNum(S.count) },
    ];
    var chipsHtml = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
      chips.map(function(c) {
        return (
          '<div style="flex:1;min-width:64px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:4px 8px">' +
            '<div style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted)">' + esc(c.label) + '</div>' +
            '<div style="font-family:var(--mono);font-size:12px;font-weight:700;color:var(--text)">' + esc(String(c.value)) + '</div>' +
          '</div>');
      }).join('') +
      '</div>';

    // ── Viewer-over-time chart (pure SVG, no external libs) ────────────────
    var W = 600, H = 140, PAD = 10;
    var t0 = samples.length ? samples[0][0] : 0;
    var tN = samples.length ? samples[samples.length - 1][0] : 0;
    var span = Math.max(1, tN - t0);
    var vmax = 1;
    for (var vi = 0; vi < samples.length; vi++) if (samples[vi][1] > vmax) vmax = samples[vi][1];
    function X(t) { return PAD + ((t - t0) / span) * (W - 2 * PAD); }
    function Y(v) { return H - PAD - (v / vmax) * (H - 2 * PAD); }

    var chartHtml;
    if (!samples.length) {
      chartHtml =
        '<div style="height:110px;display:flex;align-items:center;justify-content:center;' +
        'color:var(--muted);font-size:11px;font-family:var(--mono);background:var(--surface2);' +
        'border:1px solid var(--border);border-radius:4px;margin-bottom:2px">no samples recorded</div>';
    } else {
      var pts = [];
      var gameLines = '';
      var prevG = samples[0][2];
      for (var si = 0; si < samples.length; si++) {
        var smp = samples[si];
        var x = X(smp[0]).toFixed(2);
        pts.push(x + ',' + Y(smp[1]).toFixed(2));
        if (si > 0 && smp[2] !== prevG) {
          gameLines +=
            '<line x1="' + x + '" y1="' + (PAD - 4) + '" x2="' + x + '" y2="' + (H - PAD) +
            '" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>';
          prevG = smp[2];
        }
      }
      var areaPath =
        'M' + X(t0).toFixed(2) + ',' + (H - PAD) +
        ' L' + pts.join(' L') +
        ' L' + X(tN).toFixed(2) + ',' + (H - PAD) + ' Z';
      var lastS = samples[samples.length - 1];
      var liveDot = live
        ? '<div style="position:absolute;left:' + (X(lastS[0]) / W * 100).toFixed(2) + '%;top:' + (Y(lastS[1]) / H * 100).toFixed(2) + '%;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:var(--accent);border:2px solid #fff;box-shadow:0 0 0 2px rgba(229,57,53,0.35);pointer-events:none;z-index:3"></div>'
        : '';

      chartHtml =
        '<div id="vc-chart" style="position:relative;margin-bottom:2px">' +
          '<svg id="vc-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
               'style="width:100%;height:140px;display:block;background:var(--surface2);border:1px solid var(--border);border-radius:4px;cursor:crosshair">' +
            '<path d="' + areaPath + '" fill="var(--accent-lo)" stroke="none"/>' +
            gameLines +
            '<line x1="' + PAD + '" y1="' + Y(vmax / 2).toFixed(2) + '" x2="' + (W - PAD) + '" y2="' + Y(vmax / 2).toFixed(2) +
              '" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 5" vector-effect="non-scaling-stroke"/>' +
            '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) +
              '" stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
            '<polyline points="' + pts.join(' ') +
              '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
            '<line id="vc-guide" x1="0" y1="' + PAD + '" x2="0" y2="' + (H - PAD) +
              '" stroke="var(--muted)" stroke-width="1" visibility="hidden" vector-effect="non-scaling-stroke"/>' +
          '</svg>' +
          liveDot +
          '<div id="vc-gdot" style="position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#fff;border:1px solid var(--accent);display:none;pointer-events:none;z-index:4"></div>' +
          '<span style="position:absolute;top:4px;left:6px;font-family:var(--mono);font-size:9px;color:var(--muted);pointer-events:none">' + fmtNum(vmax) + '</span>' +
          '<span style="position:absolute;top:50%;left:6px;transform:translateY(-50%);font-family:var(--mono);font-size:9px;color:var(--muted);pointer-events:none">' + fmtNum(Math.round(vmax / 2)) + '</span>' +
          '<div id="vc-tip" style="position:absolute;display:none;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:3px 7px;font-family:var(--mono);font-size:10px;color:var(--text);white-space:nowrap;z-index:5"></div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:9px;color:var(--muted);padding:0 2px 8px">' +
          '<span>' + fmtClock(t0 * 1000) + '</span>' +
          (games.length > 1 ? '<span>' + esc(games.length + ' games') + '</span>' : '<span></span>') +
          '<span>' + fmtClock(tN * 1000) + '</span>' +
        '</div>';
    }

    // ── CSV buttons ────────────────────────────────────────────────────────
    var BTN = 'padding:5px 12px;border:none;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;letter-spacing:0.04em;font-family:inherit;transition:opacity 0.15s;';
    var btnsHtml =
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button id="vc-csv" style="' + BTN + 'background:var(--accent);color:#fff;">&#11015; CSV</button>' +
        '<button id="vc-csv-all" style="' + BTN + 'background:transparent;color:var(--muted);border:1px solid var(--border);">&#11015; all sessions</button>' +
        '<span id="vc-status" style="margin-left:auto;font-family:var(--mono);font-size:9px;color:var(--muted)"></span>' +
      '</div>';

    el.innerHTML = headHtml + gameHtml + chipsHtml + chartHtml + btnsHtml;

    // ── Chart hover: vertical guide + tooltip with time / viewers / game ────
    var svgEl   = document.getElementById('vc-svg');
    var guide   = document.getElementById('vc-guide');
    var gdot    = document.getElementById('vc-gdot');
    var tip     = document.getElementById('vc-tip');
    if (svgEl && samples.length) {
      svgEl.addEventListener('mousemove', function(ev) {
        var rect = svgEl.getBoundingClientRect();
        if (!rect.width) return;
        var frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        var t = t0 + frac * span;
        var best = 0, bd = Infinity;
        for (var k = 0; k < samples.length; k++) {
          var d = Math.abs(samples[k][0] - t);
          if (d < bd) { bd = d; best = k; }
        }
        var s2 = samples[best];
        var gx = X(s2[0]);
        guide.setAttribute('x1', String(gx));
        guide.setAttribute('x2', String(gx));
        guide.setAttribute('visibility', 'visible');
        gdot.style.left = (gx / W * 100) + '%';
        gdot.style.top  = (Y(s2[1]) / H * 100) + '%';
        gdot.style.display = 'block';
        tip.style.display = 'block';
        tip.style.left = Math.max(4, Math.min(rect.width - 140, ev.clientX - rect.left + 12)) + 'px';
        tip.style.top  = Math.max(2, ev.clientY - rect.top - 30) + 'px';
        tip.textContent = fmtClock(s2[0] * 1000) + '  ' + fmtNum(s2[1]) + '  ' + (games[s2[2]] || '?');
      });
      svgEl.addEventListener('mouseleave', function() {
        guide.setAttribute('visibility', 'hidden');
        gdot.style.display = 'none';
        tip.style.display = 'none';
      });
    }

    // ── Status helper ──────────────────────────────────────────────────────
    var statusEl = document.getElementById('vc-status');
    function status(msg) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      if (statusEl._t) clearTimeout(statusEl._t);
      statusEl._t = setTimeout(function() { statusEl.textContent = ''; }, 5000);
    }

    // ── CSV of the shown session (client-side Blob, no server round trip) ──
    var csvBtn = document.getElementById('vc-csv');
    if (csvBtn) csvBtn.addEventListener('click', function() {
      if (!samples.length) { status('no samples yet'); return; }
      function csvEsc(s) {
        s = String(s == null ? '' : s);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }
      var lines = ['time_iso,epoch_seconds,viewers,game'];
      for (var ci = 0; ci < samples.length; ci++) {
        lines.push(
          new Date(samples[ci][0] * 1000).toISOString() + ',' +
          samples[ci][0] + ',' +
          samples[ci][1] + ',' +
          csvEsc(games[samples[ci][2]] || '')
        );
      }
      var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = data.csvName || 'viewcount.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function() { URL.revokeObjectURL(a.href); }, 2000);
      status('saved ' + samples.length + ' rows');
    });

    // ── CSV of every archived session (server action) ──────────────────────
    var allBtn = document.getElementById('vc-csv-all');
    if (allBtn) allBtn.addEventListener('click', function() {
      allBtn.disabled = true;
      status('building…');
      fetch('/dashboard/action', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'stream-stats-csv' }),
      })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (!d || !d.ok) { status('error: ' + ((d && d.error) || '?')); return; }
          var blob = new Blob([d.csv], { type: 'text/csv;charset=utf-8' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = d.filename || 'viewcount-all-sessions.csv';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function() { URL.revokeObjectURL(a.href); }, 2000);
          status('saved ' + (d.rows || 0) + ' rows');
        })
        .catch(function(e) { status('failed: ' + e.message); })
        .finally(function() { allBtn.disabled = false; });
    });
  }).toString(),
});

// ── Widget payload builder ─────────────────────────────────────────────────

function _isoCompact(ms) {
  return ms ? new Date(ms).toISOString().replace(/[:.]/g, '-') : 'unknown';
}

function _payload() {
  if (!_streamInfo) {
    return { session: null, updatedAt: Date.now(), unavailable: true };
  }
  const snap     = _streamInfo.getSnapshot();
  const current  = _streamInfo.getCurrentSession();
  const session  = current ?? _streamInfo.getLastSession();
  if (!session) return { session: null, updatedAt: snap.fetchedAt || Date.now() };

  const stats   = _streamInfo.getSessionStats(session);
  const lastSmp = session.samples[session.samples.length - 1] ?? null;

  return {
    updatedAt: snap.fetchedAt || Date.now(),
    csvName:   'viewcount-' + _isoCompact(session.startedAt) + '.csv',
    session: {
      live:       !!snap.isLive && !!current,
      game:       lastSmp ? (session.games[lastSmp[2]] ?? null) : (session.gameName ?? null),
      title:      session.title ?? null,
      viewers:    snap.isLive && current ? snap.viewers : null,
      startedAt:  session.startedAt ?? null,
      endedAt:    session.endedAt ?? null,
      peak:       stats.peak,
      peakAt:     stats.peakAt,
      avg:        stats.avg,
      count:      stats.count,
      durationMs: stats.durationMs,
      samples:    session.samples.map(s => [s[0], s[1], s[2]]),
      games:      session.games.slice(),
    },
  };
}

function _notify() {
  dashboard.updateWidget('stream-stats', _payload());
}

// ── Dashboard action: CSV of ALL archived sessions + current ────────────────

async function _handleCsvAction() {
  try {
    if (!_streamInfo) return { ok: false, error: 'stream-info module not available' };

    const sessions = _streamInfo.getAllSessions();
    const current  = _streamInfo.getCurrentSession();
    if (current && current.samples.length) sessions.push(current);
    if (!sessions.length) return { ok: false, error: 'No viewer data recorded yet' };

    const csvEsc = v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = ['session_start_iso,session_end_iso,time_iso,epoch_seconds,viewers,game'];
    let rows = 0;
    for (const s of sessions) {
      const startIso = s.startedAt ? new Date(s.startedAt).toISOString() : '';
      const endIso   = s.endedAt   ? new Date(s.endedAt).toISOString()   : '';
      for (const [t, v, gi] of s.samples) {
        lines.push([startIso, endIso, new Date(t * 1000).toISOString(), t, v, csvEsc(s.games?.[gi] ?? '')].join(','));
        rows++;
      }
    }
    return { ok: true, rows, filename: 'viewcount-all-sessions.csv', csv: lines.join('\n') };
  } catch (err) {
    log.error('[stream-stats] CSV action failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── !game chat command (demonstrates consuming context.streamInfo) ─────────

function _gameReplyText() {
  if (!_streamInfo) return 'Stream status unavailable.';
  const g = _streamInfo.getActiveGame();
  if (g) {
    const v = _streamInfo.getViewerCount();
    return `Currently playing: ${g.name}` + (v > 0 ? ` (${v} watching)` : '');
  }
  const last    = _streamInfo.getLastSession();
  const lastSmp = last?.samples?.[last.samples.length - 1];
  const lastGame = lastSmp ? (last.games?.[lastSmp[2]] ?? null) : null;
  return lastGame ? `Stream is offline. Last played: ${lastGame}` : 'Stream is offline.';
}

// ── Plugin lifecycle ────────────────────────────────────────────────────────

function init(context) {
  _streamInfo = context?.streamInfo ?? null;
  if (!_streamInfo) {
    log.warn('[stream-stats] streamInfo module not in init context — update index.js to pass context.streamInfo');
  }

  dashboard.registerAction('stream-stats-csv', _handleCsvAction);

  if (_streamInfo?.onStreamEvent) {
    _streamInfo.onStreamEvent(() => _notify());
  }
  _notify();
}

function onChatReady(chatReply) {
  _chatReply = chatReply ?? { twitch: null, youtube: null, youtubeSession: null };
  commandsList.registerCommand('!game', 'Show the game currently being played on stream');
  log.info('[stream-stats] Chat reply handlers registered.');
}

async function processMessage(msg) {
  const text = (msg?.message ?? '').trim();
  if (!CMD_GAME.test(text)) return { message: msg };

  const send = _chatReply[msg?.platform];
  if (send) {
    send(_gameReplyText())
      .catch(e => log.error('[stream-stats] !game reply error:', e.message));
  }
  return { message: null }; // suppress the command from the Discord feed
}

module.exports = {
  id: 'stream-stats',
  init,
  onChatReady,
  processMessage,

  // Exposed for tests / manual invocation — not part of the plugin contract.
  _handleCsvAction,
  _payload,
};
