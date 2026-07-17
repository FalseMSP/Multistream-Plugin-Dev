'use strict';

/**
 * Dashboard module — public API + overlay-server integration.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Setup:
 *   # .env
 *   DASHBOARD_PASSWORD=your-secret-here
 *
 * Widget API (for plugins):
 *   const dashboard = require('./dashboard');
 *   dashboard.registerWidget('my-plugin', { title, icon?, order?, render });
 *   dashboard.updateWidget('my-plugin', { ...anyData });
 *
 * Action API (for plugins that want custom dashboard buttons):
 *   dashboard.registerAction('my-action', async (body) => { return { ok: true }; });
 *
 * Moderation API (for twitch.js / youtube.js):
 *   dashboard.onModerate({ ban, timeout });
 *
 * HTTP endpoints (all auth-gated except /dashboard/login):
 *   GET  /dashboard          — dashboard UI
 *   POST /dashboard/login    — submit password → sets session cookie
 *   GET  /dashboard/logout   — clears session cookie
 *   GET  /dashboard/sse      — SSE stream for live widget + log updates
 *   GET  /dashboard/state    — full JSON snapshot of all widget data
 *   POST /dashboard/command  — run a slash command { name, options }
 *   POST /dashboard/moderate — issue a moderation action { username, platform, action }
 *   POST /dashboard/action   — invoke a named plugin action { action, ...payload }
 *
 * Integration with overlay-server:
 *   const overlay   = require('./overlay-server');
 *   const dashboard = require('./dashboard');
 *   dashboard.mountOnOverlayServer(overlay);
 *   overlay.startOverlayServer(2999);
 *
 * Internal layout (see sibling files in this directory):
 *   auth.js              — session store + cookie helpers + password check
 *   widget-registry.js   — registerWidget / updateWidget / pushChatMessage
 *   sse.js               — broadcast + client Set
 *   logger-tap.js        — monkey-patches logger to mirror output into SSE
 *   moderation.js        — onModerate + /moderate route
 *   actions.js           — registerAction + /action route
 *   command-dispatch.js  — fake discord.js interaction + /command route
 *   http-helpers.js      — _readBody / _readJsonBody / _parseFormBody / _resolveContent
 *   routes.js            — handleRequest dispatcher (auth gate + route table)
 *   views/login.js       — login page HTML
 *   views/dashboard-page.js — main dashboard SPA HTML
 */

require('dotenv').config();

const log = require('../logger');
const auth          = require('./auth');
const widgetRegistry = require('./widget-registry');
const moderation    = require('./moderation');
const actions       = require('./actions');
const { handleRequest } = require('./routes');
// logger-tap is side-effectful — requiring it patches the logger.
// We pull it in here so any module that requires './dashboard' triggers
// the patch exactly once.
require('./logger-tap');

// Warn at module load if the password isn't configured.
if (!auth.isPasswordConfigured()) {
  log.warn('[dashboard] DASHBOARD_PASSWORD is not set in .env — the dashboard will be inaccessible.');
}

// ── Public API surface ──────────────────────────────────────────────────────
//
// Re-export the functions plugins call. We don't expose the internal modules
// themselves — plugins should only touch the documented surface.

const {
  registerWidget,
  updateWidget,
  pushChatMessage,
} = widgetRegistry;

const {
  onModerate,
} = moderation;

const {
  registerAction,
} = actions;

// ── Overlay integration ─────────────────────────────────────────────────────

const DASHBOARD_ROUTES = [
  '/dashboard',
  '/dashboard/login',
  '/dashboard/logout',
  '/dashboard/sse',
  '/dashboard/state',
  '/dashboard/moderate',
  '/dashboard/command',
  '/dashboard/action',
];

/**
 * Mount dashboard routes onto an existing overlay-server instance.
 * Wraps overlay.addRoute to inject the async handleRequest middleware
 * before each overlay request is dispatched.
 *
 * Call this BEFORE overlay.startOverlayServer().
 *
 * @param {{ addRoute: Function }} overlayModule
 */
function mountOnOverlayServer(overlayModule) {
  for (const route of DASHBOARD_ROUTES) {
    overlayModule.addRoute(route, (req, res) => {
      handleRequest(req, res).then(handled => {
        if (!handled) { res.writeHead(404); res.end('Not found'); }
      }).catch(err => {
        log.error('[dashboard] Unhandled error:', err.message);
        res.writeHead(500); res.end('Internal error');
      });
    });
  }
  log.info('[dashboard] Mounted on overlay server at /dashboard');
}

module.exports = {
  // Widget API
  registerWidget,
  updateWidget,
  pushChatMessage,

  // Action API
  registerAction,

  // Moderation API
  onModerate,

  // HTTP entry point (used by mountOnOverlayServer + direct callers)
  handleRequest,

  // Overlay integration
  mountOnOverlayServer,
};
