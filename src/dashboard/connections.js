'use strict';

/**
 * connections.js
 * ─────────────
 * Central connection-status bus + dashboard widget (review W2, the
 * highest-leverage UX finding: "No platform connection status anywhere").
 *
 * Adapters own their state but never told anyone: when Twitch IRC dropped,
 * the only evidence was an unusually quiet log console. This module gives
 * every platform surface a place to report status:
 *
 *   const connections = require('./dashboard/connections');
 *   connections.setStatus('twitch-irc', 'down', 'Disconnected: ' + reason);
 *
 * The bus pushes into the 'connections' dashboard widget via
 * updateWidget() — a live card with green/amber/red dots per surface:
 *   twitch-irc, eventsub, youtube, websub, discord.
 *
 * Statuses: 'ok' (green) | 'degraded' (amber: retrying / stale) |
 * 'down' (red) | 'off' (grey: not configured — not an error).
 */

const { registerWidget, updateWidget } = require('./widget-registry');
const log                             = require('../logger');

const _surfaces = [
  { id: 'twitch-irc', label: 'Twitch Chat (IRC)', icon: '◆' },
  { id: 'eventsub',   label: 'Twitch EventSub',   icon: '⚡' },
  { id: 'youtube',    label: 'YouTube Chat',      icon: '▶' },
  { id: 'websub',     label: 'YouTube WebSub',    icon: '🔔' },
  { id: 'discord',    label: 'Discord Bot',       icon: '💬' },
  { id: 'dashboard',  label: 'Dashboard SSE',     icon: '🖥' },
];

// id → { status, detail, since }
const _status = new Map();

let _registered = false;

function _push() {
  const data = _surfaces.map(s => ({
    id: s.id, label: s.label, icon: s.icon,
    status: (_status.get(s.id) || { status: 'off' }).status,
    detail: (_status.get(s.id) || {}).detail || '',
    since:  (_status.get(s.id) || {}).since || null,
  }));
  updateWidget('connections', data);
}

/**
 * Report a surface's status.
 * @param {string} id      surface id (see _surfaces)
 * @param {'ok'|'degraded'|'down'|'off'} status
 * @param {string} [detail] one-line explanation for the widget
 */
function setStatus(id, status, detail = '') {
  const prev = _status.get(id);
  if (prev && prev.status === status && prev.detail === detail) return; // no churn
  _status.set(id, { status, detail, since: Date.now() });
  if (prev && prev.status !== status) {
    log.info(`[connections] ${id}: ${prev.status} → ${status}${detail ? ' — ' + detail : ''}`);
  }
  _push();
}

function getStatus() {
  return Object.fromEntries([..._status.entries()].map(([k, v]) => [k, v.status]));
}

// ── Widget registration (once, at module load like every plugin) ──────────
// The widget is registered by the first require of this module (dashboard
// index requires it), keeping the "register at module scope" convention.
function ensureRegistered() {
  if (_registered) return;
  _registered = true;

  registerWidget('connections', {
    title: 'Connections',
    icon: '🔗',
    order: 5, // near the top: this is the "is the mirror alive?" card
    render: function (data, body, esc) {
      // data: [{ id, label, icon, status, detail }]
      body.innerHTML = '';
      if (!Array.isArray(data) || data.length === 0) {
        body.innerHTML = '<div style="color:var(--muted);padding:6px 2px;font-size:12px">No status yet…</div>';
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'connections-list';
      for (const s of data) {
        const row = document.createElement('div');
        row.className = 'connection-row';
        row.dataset.state = s.status;

        const dot = document.createElement('span');
        dot.className = 'connection-dot connection-' + s.status;
        // Non-colour identity (review UX): the state is in the text too,
        // so screen readers / colour-blind users get the same information.
        const label = document.createElement('span');
        label.className = 'connection-label';
        label.textContent = s.icon + ' ' + s.label;

        const state = document.createElement('span');
        state.className = 'connection-state connection-state-' + s.status;
        state.textContent = s.status === 'ok' ? 'connected'
          : s.status === 'degraded' ? 'retrying'
          : s.status === 'down' ? 'DOWN'
          : 'off';

        row.appendChild(dot);
        row.appendChild(label);
        row.appendChild(state);
        if (s.detail) row.title = s.detail;
        wrap.appendChild(row);
      }
      body.appendChild(wrap);
    }.toString(),
  });

  _push();
}

module.exports = { setStatus, getStatus, ensureRegistered, _surfaces };
