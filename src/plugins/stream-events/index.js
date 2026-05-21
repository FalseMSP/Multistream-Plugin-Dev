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
 * The feed keeps the 50 most recent events, newest first.
 * The badge pill shows the count of events seen this session.
 */

const log       = require('../../logger');
const dashboard = require('../../dashboard');

// ── State ─────────────────────────────────────────────────────────────────────

const MAX_EVENTS  = 50;
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
  const queue = require('../../queue');

  // ── Twitch donation/event bus (follow, sub, resub, subgift, redeem) ────────

  if (!queue?.onDonation) {
    log.warn('[stream-events] queue.onDonation not available — Twitch sub/follow/redeem events will not be captured.');
  } else {
    queue.onDonation(donation => {
      const { type, platform, username, quantity, months, message } = donation ?? {};

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
        if (type === 'redeem') {
          _push({ type, platform, username, ts: _ts(),
            label: `redeemed: ${donation.rewardTitle ?? 'channel points'}`,
            detail: donation.userInput || null });
          return;
        }
        log.debug('[stream-events] Unhandled Twitch donation type:', JSON.stringify(donation));
      }
    });
  }

  // ── queue.onMessage — YouTube events (subscribe, video, like, superchat) ──
  // Also catches Twitch redeems if your twitch.js emits them on onMessage.

  if (!queue?.onMessage) {
    log.warn('[stream-events] queue.onMessage not available — YouTube events will not be captured.');
  } else {
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
        log.debug('[stream-events] Unhandled YouTube message type:', JSON.stringify(msg));
        return;
      }

      // Twitch redeems forwarded via onMessage (some twitch.js setups do this)
      if (platform === 'twitch' && type === 'redeem') {
        _push({ type, platform, username, ts: _ts(),
          label: `redeemed: ${msg.rewardTitle ?? 'channel points'}`,
          detail: msg.userInput || null });
      }
    });
  }

  // ── Discord context mod-action hook ───────────────────────────────────────
  // Catches redeems forwarded through the Discord context if your setup uses it.

  if (context?.discord?.onModAction) {
    context.discord.onModAction(action => {
      const { type, username, rewardTitle, userInput, platform } = action ?? {};
      if (type === 'redeem') {
        _push({ type, platform: platform ?? 'twitch', username, ts: _ts(),
          label: `redeemed: ${rewardTitle ?? 'channel points'}`,
          detail: userInput || null });
      }
    });
  }

  // ── api.sendDonation intercept ────────────────────────────────────────────
  // discord.js calls api.sendDonation() for follow/sub/resub/subgift/bits/like/
  // subscribe events. The queue.onDonation path may never fire for these, so
  // we wrap the api function to observe the same payloads discord.js receives.

  if (context?.sendDonation) {
    const _origSendDonation = context.sendDonation.bind(context);
    context.sendDonation = function (donation) {
      const { type, platform, username, quantity, months, message,
              amount, currency, tier, recipient } = donation ?? {};

      if (platform === 'twitch' || platform === 'youtube') {
        switch (type) {
          case 'follow':
            _push({ type, platform, username, ts: _ts(),
              label: 'followed on Twitch', detail: null });
            break;
          case 'sub':
            _push({ type, platform, username, ts: _ts(),
              label: 'subscribed on Twitch', detail: message || null });
            break;
          case 'resub': {
            const mo = months ? `${months} months` : null;
            _push({ type, platform, username, ts: _ts(),
              label: `resubscribed on Twitch${mo ? ` (${mo})` : ''}`,
              detail: message || null });
            break;
          }
          case 'subgift': {
            const qty = quantity ?? 1;
            _push({ type, platform, username, ts: _ts(),
              label: `gifted ${qty} sub${qty !== 1 ? 's' : ''} on Twitch`,
              detail: null });
            break;
          }
          case 'bits':
            _push({ type, platform, username, ts: _ts(),
              label: `cheered ${amount ?? '?'} bits`, detail: message || null });
            break;
          case 'like':
            _push({ type, platform, username: username ?? 'viewer', ts: _ts(),
              label: 'liked on YouTube', detail: null });
            break;
          case 'subscribe':
            _push({ type, platform, username: username ?? 'viewer', ts: _ts(),
              label: 'subscribed on YouTube', detail: null });
            break;
          default:
            log.debug('[stream-events] sendDonation intercept — unhandled type:', type);
        }
      }

      return _origSendDonation(donation);
    };
  }

  // ── api.sendRedeem intercept ──────────────────────────────────────────────
  // discord.js calls api.sendRedeem() for channel point redemptions.
  // Shape: { username, title, cost, input, timestamp }

  if (context?.sendRedeem) {
    const _origSendRedeem = context.sendRedeem.bind(context);
    context.sendRedeem = function (redeem) {
      const { username, title, input } = redeem ?? {};
      _push({ type: 'redeem', platform: 'twitch', username, ts: _ts(),
        label: `redeemed: ${title ?? 'channel points'}`,
        detail: input || null });
      return _origSendRedeem(redeem);
    };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  id: 'stream-events',
  init,
  async processMessage(msg) { return { message: msg }; },
};