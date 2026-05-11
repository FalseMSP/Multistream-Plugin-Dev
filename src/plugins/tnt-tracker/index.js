'use strict';

/**
 * tnt-tracker plugin
 * ... (existing header unchanged) ...
 *
 * Game link:
 *   POST http://localhost:<OVERLAY_PORT>/tnt_update
 *   Body (JSON): { "action": "place", "amount": 1 }
 *                { "action": "remove", "amount": 1 }
 *                { "action": "set",    "amount": 500 }
 *                { "action": "reset" }
 *
 *   Response: { "ok": true, "count": <number> }
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { addRoute, updateSection, registerSection } = require('../../overlay-server');
const queue = require('../../queue');
const log = require('../../logger');

// ─── State ────────────────────────────────────────────────────────────────────

let tntCount = 0;
const TNT_PER_EVENT = 50;

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

// ─── State helpers ────────────────────────────────────────────────────────────

function setTnt(n) {
  tntCount = Math.max(0, Math.round(n));
  log.info(`[tnt-tracker] TNT count → ${tntCount}`);
  updateSection('tnt-tracker', { tnt: tntCount });
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

addRoute('/tnt_update', (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  }

  // Auth check
  const secret = process.env.TNT_UPDATE_SECRET;
  if (secret && req.headers['x-tnt-secret'] !== secret) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  }
  
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(TNT_PAGE_HTML);
});

// ─── Game link endpoint ───────────────────────────────────────────────────────
//
//  POST /tnt_update   (on the overlay server port, same as /tnt_placing)
//  Body JSON:
//    { "action": "place",  "amount": 1 }   — subtract: player placed N TNT
//    { "action": "remove", "amount": 1 }   — add back: player removed N TNT
//    { "action": "set",    "amount": 500 } — hard-set the counter
//    { "action": "reset" }                 — set to 0
//
//  Response: { "ok": true, "count": <number> }
//
//  From Minecraft (or any HTTP client), e.g.:
//    curl -X POST http://localhost:<OVERLAY_PORT>/tnt_update \
//         -H "Content-Type: application/json" \
//         -d '{"action":"place","amount":1}'

addRoute('/tnt_update', (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
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
        // Placing TNT subtracts from the "left to place" counter
        addTnt(-(amount ?? 1));
        log.info(`[tnt-tracker] Game: placed ${amount ?? 1} TNT → ${tntCount} remaining`);
        break;
      case 'remove':
        // Removing/picking up TNT adds it back
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

function init(_context) {
  if (!queue?.onDonation) {
    log.warn('[tnt-tracker] queue.onDonation not available — Twitch events will not be tracked.');
  } else {
    queue.onDonation(donation => {
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

  if (!queue?.onMessage) {
    log.warn('[tnt-tracker] queue.onMessage not available — YouTube subscriber events will not be tracked.');
  } else {
    queue.onMessage(msg => {
      const { type, platform, username } = msg ?? {};
      if (platform !== 'youtube' || type !== 'subscribe') return;

      const who = username ?? '<anonymous>';
      log.info(`[tnt-tracker] YouTube subscriber: ${who} → +${TNT_PER_EVENT} TNT`);
      addTnt(TNT_PER_EVENT);
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