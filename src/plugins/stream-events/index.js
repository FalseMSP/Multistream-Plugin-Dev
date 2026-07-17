'use strict';

/**
 * Plugin: stream-events
 * ─────────────────────
 * Captures all stream events — Twitch and YouTube — and surfaces them
 * as a live feed on the dashboard widget.
 *
 * Captured events:
 *   Twitch:
 *     follow        — new follower
 *     sub           — new subscriber
 *     resub         — resubscription (includes cumulative months)
 *     subgift       — gifted sub(s), quantity-aware
 *     redeem        — channel point redemption
 *   YouTube:
 *     subscribe     — new subscriber
 *     video         — new video / WebSub push
 *     like          — new like (via poll)
 *     superchat     — super chat / super sticker
 *
 * The feed keeps the 10 most recent events, newest first.
 * The badge pill shows the count of events seen this session.
 */

const log       = require('../../logger');
const dashboard = require('../../dashboard');
const { addRoute } = require('../../overlay-server');

// ── State ─────────────────────────────────────────────────────────────────────

const MAX_EVENTS  = 10;
const _events     = [];   // newest-first; each entry is a plain object
let   _totalCount = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _push(event) {
  _events.unshift(event);
  if (_events.length > MAX_EVENTS) _events.length = MAX_EVENTS;
  _totalCount++;
  _notify();
  log.info(`[stream-events] ${event.label}`);
}

function _ts() {
  const d = new Date();
  return d.getHours().toString().padStart(2, '0') + ':'
       + d.getMinutes().toString().padStart(2, '0') + ':'
       + d.getSeconds().toString().padStart(2, '0');
}

function _notify() {
  dashboard.updateWidget('stream-events', {
    events: _events,
    total:  _totalCount,
  });
}

// ── Dashboard widget ──────────────────────────────────────────────────────────

dashboard.registerWidget('stream-events', {
  title: 'Stream Events',
  order: 5,
  icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
           <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
         </svg>`,

  render: (function render(data, el, esc, { badge }) {
    if (!data) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px;font-family:var(--mono)">Waiting for events…</p>';
      badge.textContent = '';
      return;
    }

    badge.textContent = data.total + ' this session';

    // Clear button — rendered outside el, into a sibling container we create once
    var clearId = 'stream-events-clear';
    if (!document.getElementById(clearId)) {
      var btn = document.createElement('button');
      btn.id = clearId;
      btn.textContent = 'Clear';
      btn.style.cssText =
        'display:block;margin:6px 14px 0;padding:3px 10px;font-size:10px;font-family:var(--mono);' +
        'color:var(--muted);background:none;border:1px solid var(--border);border-radius:3px;' +
        'cursor:pointer;transition:color 0.15s,border-color 0.15s;width:calc(100% - 28px)';
      btn.onmouseover = function() { btn.style.color='var(--text)'; btn.style.borderColor='var(--muted)'; };
      btn.onmouseout  = function() { btn.style.color='var(--muted)'; btn.style.borderColor='var(--border)'; };
      btn.onclick = function() {
        fetch('/stream-events/clear', { method: 'POST' }).catch(function(){});
      };
      el.parentNode.insertBefore(btn, el);
    }

    if (!data.events || data.events.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px;font-family:var(--mono)">No events yet.</p>';
      return;
    }

    // Colour and icon mapping — must be self-contained (no outer scope references)
    var COLORS = {
      follow:    '#9147ff',
      sub:       '#00b5ad',
      resub:     '#00b5ad',
      subgift:   '#f2711c',
      redeem:    '#fbbd08',
      subscribe: '#ff0000',
      video:     '#ff6b6b',
      like:      '#ff9f43',
      superchat: '#ffd700',
    };

    var ICONS = {
      follow:    '👤',
      sub:       '⭐',
      resub:     '🔁',
      subgift:   '🎁',
      redeem:    '🏆',
      subscribe: '📺',
      video:     '🎬',
      like:      '👍',
      superchat: '💛',
    };

    el.innerHTML = data.events.map(function (e) {
      var color = COLORS[e.type] || 'var(--muted)';
      var icon  = ICONS[e.type]  || '📡';
      return (
        '<div style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;' +
          'border-bottom:1px solid var(--border)">' +
          '<span style="font-size:14px;flex-shrink:0;line-height:1.4">' + icon + '</span>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap">' +
              '<span style="font-size:12px;font-weight:700;color:' + color + ';' +
                'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px">' +
                esc(e.username || 'anonymous') +
              '</span>' +
              '<span style="font-size:11px;color:var(--muted);flex:1;min-width:0;' +
                'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
                esc(e.label) +
              '</span>' +
            '</div>' +
            (e.detail
              ? '<div style="font-size:10px;color:var(--muted);margin-top:1px;' +
                'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
                esc(e.detail) + '</div>'
              : '') +
          '</div>' +
          '<span style="font-family:var(--mono);font-size:10px;color:var(--muted);' +
            'flex-shrink:0;align-self:center">' + esc(e.ts) + '</span>' +
        '</div>'
      );
    }).join('');
  }).toString(),
});

// ── Plugin lifecycle ──────────────────────────────────────────────────────────

function init(context) {
  // context = { ...discord, queue }  (see src/plugins/index.js → initPlugins)
  const queue = context.queue;

  if (!queue) {
    log.warn('[stream-events] queue not found in context — no events will be captured.');
    return;
  }

  // ── queue.onDonation — Twitch: follow, sub, resub, subgift, bits ──────────

  queue.onDonation(donation => {
    const { type, platform, username, quantity, months, message,
            amount, currency } = donation ?? {};

    if (platform === 'twitch') {
      if (type === 'follow') {
        _push({ type, platform, username, ts: _ts(),
          label: 'followed on Twitch',
          detail: null });
        return;
      }
      if (type === 'sub') {
        _push({ type, platform, username, ts: _ts(),
          label: 'subscribed on Twitch',
          detail: message || null });
        return;
      }
      if (type === 'resub') {
        const mo = months ? `${months} months` : null;
        _push({ type, platform, username, ts: _ts(),
          label: `resubscribed on Twitch${mo ? ` (${mo})` : ''}`,
          detail: message || null });
        return;
      }
      if (type === 'subgift') {
        const qty = quantity ?? 1;
        _push({ type, platform, username, ts: _ts(),
          label: `gifted ${qty} sub${qty !== 1 ? 's' : ''} on Twitch`,
          detail: null });
        return;
      }
      if (type === 'bits') {
        _push({ type, platform, username, ts: _ts(),
          label: `cheered ${amount ?? '?'} bits`,
          detail: message || null });
        return;
      }
      log.debug('[stream-events] Unhandled Twitch donation type:', JSON.stringify(donation));
    }
  });

  // ── queue.onRedeem — Twitch channel point redemptions ────────────────────

  queue.onRedeem(redeem => {
    const { username, title, input } = redeem ?? {};
    _push({ type: 'redeem', platform: 'twitch', username, ts: _ts(),
      label: `redeemed: ${title ?? 'channel points'}`,
      detail: input || null });
  });

  // ── queue.onMessage — YouTube events: subscribe, video, like, superchat ──

  queue.onMessage(msg => {
    const { type, platform, username, message, amount, currency } = msg ?? {};

    if (platform === 'youtube') {
      if (type === 'subscribe') {
        _push({ type, platform, username, ts: _ts(),
          label: 'subscribed on YouTube',
          detail: null });
        return;
      }
      if (type === 'video') {
        _push({ type, platform, username: username ?? 'YouTube', ts: _ts(),
          label: 'new video / stream notification',
          detail: msg.title || null });
        return;
      }
      if (type === 'like') {
        _push({ type, platform, username: username ?? 'viewer', ts: _ts(),
          label: 'liked on YouTube',
          detail: null });
        return;
      }
      if (type === 'superchat') {
        const amountStr = (amount != null && currency)
          ? `${currency}${amount}`
          : amount != null ? String(amount) : null;
        _push({ type, platform, username, ts: _ts(),
          label: `super chat${amountStr ? ` (${amountStr})` : ''}`,
          detail: message || null });
        return;
      }
      // Not a special YouTube event type — let it pass through for chat mirroring
    }
  });

  _notify();
}

// ── Clear route ───────────────────────────────────────────────────────────────

addRoute('/stream-events/clear', (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  _events.length = 0;
  _totalCount    = 0;
  log.info('[stream-events] Feed cleared via dashboard');
  _notify();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  id: 'stream-events',
  init,
  async processMessage(msg) { return { message: msg }; },
};