'use strict';

/**
 * tnt-tracker plugin
 *
 * Twitch follows                → +50 TNT
 * Twitch subs / resubs          → +50 TNT
 * Twitch gift subs              → +50 TNT (× quantity)
 * YouTube subscribers           → +50 TNT
 * YouTube likes                 → +10 TNT
 *
 * Game link:
 *   POST http://localhost:<OVERLAY_PORT>/tnt_update
 *   Body (JSON): { "action": "place",  "amount": 1 }
 *                { "action": "remove", "amount": 1 }
 *                { "action": "set",    "amount": 500 }
 *                { "action": "reset" }
 *   Header (optional): x-tnt-secret: <TNT_UPDATE_SECRET from .env>
 *
 *   Response: { "ok": true, "count": <number> }
 *
 * OBS browser source:  http://localhost:<OVERLAY_PORT>/tnt_placing
 *
 * Discord slash command:
 *   /tnt set <n>    — hard-set the count
 *   /tnt add <n>    — add or subtract
 *   /tnt status     — show current count (ephemeral)
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { addRoute, updateSection, registerSection } = require('../../overlay-server');
const dashboard = require('../../dashboard');
const log = require('../../logger');

// queue is injected via init(context) — see init() below.
let _queue = null;

// ─── State ────────────────────────────────────────────────────────────────────

let tntCount = 0;
const TNT_PER_EVENT = 50;
const TNT_PER_LIKE  = 10;

// ─── Overlay section ──────────────────────────────────────────────────────────

registerSection('tnt-tracker', {
  title: 'TNT Left to Place',
  order: 99,
  icon: `<svg viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <rect width="22" height="22" fill="#c0392b"/>
    <rect x="0" y="0" width="22" height="5" fill="#e74c3c"/>
    <rect x="0" y="17" width="22" height="5" fill="#e74c3c"/>
    <rect x="3" y="8" width="2" height="7" fill="#fff"/>
    <rect x="2" y="8" width="4" height="1" fill="#fff"/>
    <rect x="9" y="8" width="2" height="7" fill="#fff"/>
    <rect x="8" y="8" width="1" height="4" fill="#fff"/>
    <rect x="11" y="8" width="1" height="4" fill="#fff"/>
    <rect x="16" y="8" width="2" height="7" fill="#fff"/>
    <rect x="15" y="8" width="4" height="1" fill="#fff"/>
  </svg>`,
  render: (function render(data, el, esc, { badge }) {
    if (!data) return;
    badge.textContent = data.tnt + ' blocks';
    el.style.cssText = 'padding:10px 14px;font-family:monospace;font-size:18px;color:#e74c3c';
    el.textContent = '\uD83D\uDCA3 ' + data.tnt;
  }).toString(),
});

// ─── Dashboard widget ─────────────────────────────────────────────────────────

dashboard.registerWidget('tnt-tracker', {
  title: 'TNT Tracker',
  order: 99,
  icon: `<svg width="20" height="20" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <rect width="22" height="22" fill="#c0392b"/>
    <rect x="0" y="0" width="22" height="5" fill="#e74c3c"/>
    <rect x="0" y="17" width="22" height="5" fill="#e74c3c"/>
    <rect x="3" y="8" width="2" height="7" fill="#fff"/>
    <rect x="2" y="8" width="4" height="1" fill="#fff"/>
    <rect x="9" y="8" width="2" height="7" fill="#fff"/>
    <rect x="8" y="8" width="1" height="4" fill="#fff"/>
    <rect x="11" y="8" width="1" height="4" fill="#fff"/>
    <rect x="16" y="8" width="2" height="7" fill="#fff"/>
    <rect x="15" y="8" width="4" height="1" fill="#fff"/>
  </svg>`,
  render: (function render(data, el, esc, { badge }) {
    if (!data) { el.innerHTML = ''; badge.textContent = ''; return; }
    badge.textContent = data.tnt + ' blocks';
    el.innerHTML =
      '<p style="font-size:40px;font-weight:900;text-align:center;padding:12px 0;' +
      'font-family:var(--mono);color:var(--accent)">' + esc(String(data.tnt)) + '</p>' +
      '<p style="text-align:center;color:var(--muted);font-size:11px">blocks left to place</p>';
  }).toString(),
});



function setTnt(n) {
  tntCount = Math.max(0, Math.round(n));
  log.info(`[tnt-tracker] TNT count → ${tntCount}`);
  updateSection('tnt-tracker', { tnt: tntCount });
  dashboard.updateWidget('tnt-tracker', { tnt: tntCount });
}

function addTnt(n) {
  setTnt(tntCount + n);
}

updateSection('tnt-tracker', { tnt: tntCount });

// ─── /tnt_placing HTML page ───────────────────────────────────────────────────

const TNT_PAGE_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>TNT Left to Place</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Share+Tech+Mono&display=swap">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: transparent; display: flex; align-items: flex-start; justify-content: flex-start; overflow: hidden; }
  #widget {
    position: relative; display: inline-flex; flex-direction: column; align-items: center;
    padding: 14px 24px 16px; margin: 16px;
    background: rgba(8, 6, 5, 0.90); border: 2px solid #c0392b; border-radius: 3px;
    box-shadow: 0 0 0 1px #000, 0 0 22px rgba(192,57,43,0.5), inset 0 0 50px rgba(192,57,43,0.05);
    min-width: 210px; gap: 5px;
  }
  #widget::before {
    content: ''; position: absolute; top: 9px; left: 9px;
    width: 7px; height: 7px; border-radius: 50%;
    background: #e74c3c; box-shadow: 0 0 8px #e74c3c;
    animation: led 1.1s steps(1) infinite;
  }
  @keyframes led { 50% { opacity: 0; } }
  #label { font-family: 'Bebas Neue', sans-serif; font-size: 10.5px; letter-spacing: 0.28em; color: #663333; text-transform: uppercase; }
  #count-row { display: flex; align-items: center; gap: 12px; }
  #count {
    font-family: 'Bebas Neue', sans-serif; font-size: 64px; line-height: 1; color: #e74c3c;
    text-shadow: 0 0 14px rgba(231,76,60,0.75), 0 0 35px rgba(231,76,60,0.25); letter-spacing: 0.03em;
  }
  #count.bump { animation: bump 0.3s cubic-bezier(.36,.07,.19,.97) forwards; }
  @keyframes bump { 0% { transform:scale(1); color:#e74c3c; } 35% { transform:scale(1.22); color:#ff7070; } 100% { transform:scale(1); color:#e74c3c; } }
  .tnt-block { width: 40px; height: 40px; flex-shrink: 0; }
  #sublabel { font-family: 'Share Tech Mono', monospace; font-size: 10px; letter-spacing: 0.2em; color: #4a2020; text-transform: uppercase; margin-top: 1px; }
  #flash { position: absolute; inset: 0; border-radius: 2px; background: rgba(231,76,60,0.18); opacity: 0; pointer-events: none; }
  #flash.on { animation: flash 0.25s ease forwards; }
  @keyframes flash { 0% { opacity: 1; } 100% { opacity: 0; } }
</style>
</head>
<body>
<div id="widget">
  <div id="flash"></div>
  <div id="label">TNT Left to Place</div>
  <div id="count-row">
    <svg class="tnt-block" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
      <rect width="16" height="16" fill="#c0392b"/><rect x="0" y="0" width="16" height="4" fill="#e74c3c"/>
      <rect x="0" y="12" width="16" height="4" fill="#e74c3c"/><rect x="2" y="6" width="2" height="5" fill="#fff"/>
      <rect x="1" y="6" width="4" height="1" fill="#fff"/><rect x="7" y="6" width="2" height="5" fill="#fff"/>
      <rect x="6" y="6" width="1" height="3" fill="#fff"/><rect x="9" y="6" width="1" height="3" fill="#fff"/>
      <rect x="12" y="6" width="2" height="5" fill="#fff"/><rect x="11" y="6" width="4" height="1" fill="#fff"/>
    </svg>
    <div id="count">0</div>
    <svg class="tnt-block" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
      <rect width="16" height="16" fill="#c0392b"/><rect x="0" y="0" width="16" height="4" fill="#e74c3c"/>
      <rect x="0" y="12" width="16" height="4" fill="#e74c3c"/><rect x="2" y="6" width="2" height="5" fill="#fff"/>
      <rect x="1" y="6" width="4" height="1" fill="#fff"/><rect x="7" y="6" width="2" height="5" fill="#fff"/>
      <rect x="6" y="6" width="1" height="3" fill="#fff"/><rect x="9" y="6" width="1" height="3" fill="#fff"/>
      <rect x="12" y="6" width="2" height="5" fill="#fff"/><rect x="11" y="6" width="4" height="1" fill="#fff"/>
    </svg>
  </div>
  <div id="sublabel">blocks remaining</div>
</div>
<script>
(function () {
  var countEl = document.getElementById('count');
  var flashEl = document.getElementById('flash');
  function update(n) {
    countEl.textContent = Number(n).toLocaleString();
    countEl.classList.remove('bump'); void countEl.offsetWidth; countEl.classList.add('bump');
    flashEl.classList.remove('on');  void flashEl.offsetWidth;  flashEl.classList.add('on');
  }
  function connect() {
    var es = new EventSource('/sse');
    es.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'section' && msg.id === 'tnt-tracker' && msg.data) update(msg.data.tnt);
      } catch (_) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 2000); };
  }
  connect();
})();
</script>
</body>
</html>`;

addRoute('/tnt_placing', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(TNT_PAGE_HTML);
});

// ─── Game link endpoint ───────────────────────────────────────────────────────

addRoute('/tnt_update', (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  }

  // Optional auth — set TNT_UPDATE_SECRET in .env to enable
  const secret = process.env.TNT_UPDATE_SECRET;
  if (secret && req.headers['x-tnt-secret'] !== secret) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
    }

    const { action, amount } = data;

    switch (action) {
      case 'place':
        addTnt(-(amount ?? 1));
        log.info(`[tnt-tracker] Game: placed ${amount ?? 1} TNT → ${tntCount} remaining`);
        break;
      case 'remove':
        addTnt(amount ?? 1);
        log.info(`[tnt-tracker] Game: removed ${amount ?? 1} TNT → ${tntCount} remaining`);
        break;
      case 'set':
        setTnt(amount ?? 0);
        log.info(`[tnt-tracker] Game: set TNT to ${tntCount}`);
        break;
      case 'reset':
        setTnt(0);
        log.info('[tnt-tracker] Game: reset TNT to 0');
        break;
      default:
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: tntCount }));
  });
});

// ─── Discord slash command ────────────────────────────────────────────────────

const command = new SlashCommandBuilder()
  .setName('tnt')
  .setDescription('Manage the TNT counter on the stream overlay')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub =>
    sub.setName('set')
      .setDescription('Set TNT count to an exact value')
      .addIntegerOption(o =>
        o.setName('amount').setDescription('New TNT count').setRequired(true).setMinValue(0)))
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Add to (or subtract from) the current TNT count')
      .addIntegerOption(o =>
        o.setName('amount').setDescription('Amount to add (use negative to subtract)').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('status').setDescription('Show the current TNT count'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const n = interaction.options.getInteger('amount');
    setTnt(n);
    return interaction.editReply(`💣 TNT count set to **${tntCount.toLocaleString()}**.`);
  }
  if (sub === 'add') {
    const n = interaction.options.getInteger('amount');
    addTnt(n);
    return interaction.editReply(`💣 TNT ${n >= 0 ? '+' + n : n} → now **${tntCount.toLocaleString()}**.`);
  }
  if (sub === 'status') {
    return interaction.editReply(`💣 Current TNT count: **${tntCount.toLocaleString()}**.`);
  }
  return interaction.editReply('⚠️ Unknown subcommand.');
}

// ─── Plugin entry point ───────────────────────────────────────────────────────

function init(context) {
  _queue = context.queue;
  if (!_queue?.onDonation) {
    log.warn('[tnt-tracker] queue not in init context — Twitch events will not be tracked.');
  } else {
    _queue.onDonation(donation => {
      const { type, platform, username, quantity } = donation ?? {};
      if (platform !== 'twitch') return;

      if (type === 'follow') {
        log.info(`[tnt-tracker] Twitch follow: ${username} → +${TNT_PER_EVENT} TNT`);
        addTnt(TNT_PER_EVENT);
        return;
      }
      if (type === 'sub' || type === 'resub') {
        log.info(`[tnt-tracker] Twitch ${type}: ${username} → +${TNT_PER_EVENT} TNT`);
        addTnt(TNT_PER_EVENT);
        return;
      }
      if (type === 'subgift') {
        const qty = quantity ?? 1;
        log.info(`[tnt-tracker] Twitch subgift x${qty}: ${username} → +${TNT_PER_EVENT * qty} TNT`);
        addTnt(TNT_PER_EVENT * qty);
      }
    });
  }

  // FIX: YouTube WebSub pushes video notifications via yt.triggerVideo() which
  // calls queue.onMessage (or similar) with { platform: 'youtube', type: 'video', ... }.
  // The previous listener checked for type === 'subscribe' which never matches a
  // WebSub video-push event — so YouTube notifications were silently dropped.
  //
  // The listener now accepts both 'video' (WebSub livestream push) and 'subscribe'
  // (direct subscriber event, if your youtube.js emits one), and logs the full
  // message shape the first time it sees an unrecognised YouTube event so you can
  // confirm the exact type string your youtube.js uses.
  if (!_queue?.onMessage) {
    log.warn('[tnt-tracker] queue.onMessage not available — YouTube events will not be tracked.');
  } else {
    _queue.onMessage(msg => {
      const { type, platform, username } = msg ?? {};
      if (platform !== 'youtube') return;

      // 'video'     — emitted by yt.triggerVideo() via WebSub push
      // 'subscribe' — emitted by a direct YouTube subscriber event (if supported)
      if (type === 'video' || type === 'subscribe') {
        const who = username ?? '<anonymous>';
        log.info(`[tnt-tracker] YouTube ${type}: ${who} → +${TNT_PER_EVENT} TNT`);
        addTnt(TNT_PER_EVENT);
        return;
      }

      // 'like' — emitted by youtube.js _pollLikeCount(), one event per new like
      if (type === 'like') {
        log.info(`[tnt-tracker] YouTube like → +${TNT_PER_LIKE} TNT`);
        addTnt(TNT_PER_LIKE);
        return;
      }

      // Safety net: log any other YouTube event shape so the type string is
      // visible in your logs and you can add it above if needed.
      log.debug('[tnt-tracker] Unhandled YouTube message shape:', JSON.stringify(msg));
    });
  }
}

module.exports = {
  id: 'tnt-tracker',
  init,
  command,
  handleInteraction,
  async processMessage(msg) { return { message: msg }; },
};