'use strict';

const log = require('../../logger');
const { registerSection, updateSection, addRoute } = require('../../overlay-server');
const fs   = require('fs');
const path = require('path');

const OVERLAY_HTML = path.resolve(__dirname, 'overlay.html');

// ─── State ────────────────────────────────────────────────────────────────────

const MAX_EVENTS = 20; // keep a rolling window
const _events = [];    // [{ id, type, label, detail, ts }]
let   _nextId = 1;

// Event type → display config (emoji + colour)
const TYPE_CONFIG = {
  follow:        { emoji: '💜', color: '#a970ff', label: 'Follow'     },
  sub:           { emoji: '⭐', color: '#f5c518', label: 'Sub'        },
  resub:         { emoji: '🔄', color: '#f5a623', label: 'Resub'      },
  subgift:       { emoji: '🎁', color: '#ff6b6b', label: 'Gift Sub'   },
  bits:          { emoji: '💎', color: '#00d4ff', label: 'Bits'       },
  like:          { emoji: '👍', color: '#ff4444', label: 'Like'       },
  subscribe:     { emoji: '🔔', color: '#ff0000', label: 'Subscribe'  },
  redeem:        { emoji: '🎯', color: '#00e676', label: 'Redeem'     },
  raid:          { emoji: '⚔️', color: '#ff9800', label: 'Raid'       },
  'watch-streak':{ emoji: '🔥', color: '#ff5722', label: 'Streak'     },
  default:       { emoji: '📌', color: '#ffffff', label: 'Event'      },
};

function _push(type, username, detail) {
  const cfg   = TYPE_CONFIG[type] ?? TYPE_CONFIG.default;
  const event = {
    id:     _nextId++,
    type,
    emoji:  cfg.emoji,
    color:  cfg.color,
    label:  cfg.label,
    username: username ?? null,
    detail:   detail   ?? null,
    ts: Date.now(),
  };
  _events.unshift(event);
  if (_events.length > MAX_EVENTS) _events.length = MAX_EVENTS;
  log.info(`[event-feed] ${cfg.label}: ${username ?? '—'} ${detail ? '(' + detail + ')' : ''}`);
  _notify();
}

function _notify() {
  updateSection('event-feed', { events: _events });
}

// ─── Overlay section ──────────────────────────────────────────────────────────

registerSection('event-feed', {
  title: 'Event Feed',
  order: 2,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
  </svg>`,

  render: (function render(data, el, esc) {
    if (!data || !data.events || data.events.length === 0) {
      el.innerHTML = '<p style="color:rgba(255,255,255,0.4);font-size:13px">No events yet…</p>';
      return;
    }
    el.innerHTML = data.events.map(e =>
      '<div style="display:flex;align-items:baseline;gap:6px;padding:3px 0;font-size:13px">' +
        '<span>' + e.emoji + '</span>' +
        '<span style="color:' + e.color + ';font-weight:600;white-space:nowrap">' + esc(e.label) + '</span>' +
        (e.username ? '<span style="color:#fff">' + esc(e.username) + '</span>' : '') +
        (e.detail   ? '<span style="color:rgba(255,255,255,0.5);font-size:11px">' + esc(e.detail) + '</span>' : '') +
      '</div>'
    ).join('');
  }).toString(),
});

// ─── Overlay route ────────────────────────────────────────────────────────────

addRoute('/event-feed', (req, res) => {
  try {
    const html = fs.readFileSync(OVERLAY_HTML, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    log.error('[event-feed] Could not read overlay.html:', e.message);
    res.writeHead(500); res.end('Event feed overlay not found');
  }
});

// ─── Plugin hooks ─────────────────────────────────────────────────────────────

function init(context) {
  const q = context.queue;

  // Redeems
  if (typeof q?.onRedeem === 'function') {
    q.onRedeem(redeem => {
      const title = (redeem.title ?? redeem.reward?.title ?? 'Unknown').replace(/\s*\[YT\]\s*$/i, '').trim();
      const user  = redeem.username ?? redeem.user ?? 'someone';
      if (redeem._fromGacha) return; // skip synthetic gacha redeems — noise
      _push('redeem', user, title);
    });
  }

  // Bits / subs / follows / likes / etc.
  if (typeof q?.onDonation === 'function') {
    q.onDonation(event => {
      const user = event.username ?? 'someone';
      switch (event.type) {
        case 'follow':
          _push('follow', user);
          break;
        case 'sub':
          _push('sub', user);
          break;
        case 'resub': {
          const months = event.months ? `${event.months} months` : null;
          _push('resub', user, months);
          break;
        }
        case 'subgift': {
          const count = event.quantity ?? 1;
          _push('subgift', user, count > 1 ? `×${count}` : null);
          break;
        }
        case 'bits': {
          const bits = event.amount ?? 0;
          _push('bits', user, `${bits} bits`);
          break;
        }
        case 'raid': {
          const viewers = event.viewers ?? event.amount;
          _push('raid', user, viewers ? `${viewers} viewers` : null);
          break;
        }
      }
    });
  }

  log.info('[event-feed] Plugin loaded.');
}

// processMessage handles events delivered as messages (YT subscribe, like,
// Twitch raid, Twitch watch-streak share).
async function processMessage(msg) {
  if (msg.platform === 'youtube') {
    if (msg.type === 'subscribe') {
      _push('subscribe', msg.username ?? 'anonymous');
      return { message: msg }; // let other plugins see it too
    }
    if (msg.type === 'like') {
      _push('like', null);
      return { message: msg };
    }
  }

  // Twitch raid (pushed by twitch.js raided handler with type:'raid').
  // Show in the overlay event feed. We pass the message through so the
  // index.js onMessage handler can still build the Discord chat-feed
  // announcement — this overlay entry is additive, not a replacement.
  if (msg.type === 'raid') {
    const viewers = msg.viewers;
    _push('raid', msg.username, viewers ? `${viewers} viewers` : null);
    return { message: msg };
  }

  // Twitch watch-streak share (USERNOTICE msg-id=viewermilestone).
  if (msg.type === 'watch-streak') {
    const streak = msg.streak;
    _push('watch-streak', msg.username, streak ? `${streak} streams` : null);
    return { message: msg };
  }

  return { message: msg };
}

module.exports = {
  id: 'event-feed',
  init,
  processMessage,
};