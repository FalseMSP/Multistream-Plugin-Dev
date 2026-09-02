'use strict';

/**
 * Widget registry.
 * ────────────────────────────────────────────────────────────────────────────
 * Plugins call registerWidget() once at module-load time to declare a
 * dashboard card. They then call updateWidget(id, data) whenever their
 * state changes — that triggers an SSE broadcast to all connected clients.
 *
 * Widget shape:
 *   {
 *     title:  string,            // card header text
 *     icon:   string,            // raw SVG string, shown at 20×20
 *     order:  number,            // sort weight, default 50 (lower = earlier)
 *     render: string,            // fn.toString() of a client-side render fn
 *     data:   any                // latest payload pushed via updateWidget
 *   }
 */

const log       = require('../logger');
const { broadcast } = require('./sse');

/** @type {Map<string, { title: string, icon: string, order: number, render: string, data: * }>} */
const _widgets = new Map();

// Monotonic counter for auto-assigned chat message ids. `Date.now()` was
// used previously, which collides whenever two messages arrive in the same
// millisecond (common during raids/bot floods) — the dashboard's
// `list.find(x => x.id === m.id)` dedup then silently drops the second
// message.
let _autoId = 0;

/**
 * Register a dashboard widget.
 * @param {string} id     Unique widget id
 * @param {{ title: string, icon?: string, order?: number, render: string }} opts
 */
function registerWidget(id, { title, icon = '', order = 50, render }) {
  if (typeof render !== 'string') {
    throw new TypeError(
      `[dashboard] registerWidget('${id}'): opts.render must be a function serialised ` +
      `to a string via myFn.toString() — the browser will eval it.`
    );
  }
  _widgets.set(id, { title, icon, order, render, data: null });
  log.info(`[dashboard] Widget registered: ${id}`);
}

/**
 * Push new data to a widget and broadcast to connected dashboard clients.
 * @param {string} id
 * @param {*}      data
 */
function updateWidget(id, data) {
  const widget = _widgets.get(id);
  if (!widget) {
    log.warn(`[dashboard] updateWidget('${id}'): widget not registered — did you call registerWidget() first?`);
    return;
  }
  widget.data = data;
  broadcast({ type: 'widget', id, data });
}

/**
 * Append a single chat message to the dashboard chat feed.
 * Only call this with messages that have already passed through runPipeline,
 * so the dashboard sees exactly what Discord sees.
 *
 * Writes to two widgets:
 *   chat-overlay-<platform>   — per-platform feed
 *   chat-overlay-combined     — cross-platform interleaved feed
 *
 * @param {{ platform: string, username: string, message: string, id?: *, firstTimer?: boolean }} msg
 */
function pushChatMessage(msg) {
  const widgetId = `chat-overlay-${msg.platform}`;
  const widget   = _widgets.get(widgetId);

  // Assign a monotonic id if the message doesn't already have one. Must stay
  // numeric — the dashboard sorts the combined feed with `a.id - b.id`.
  // Offset it far below Date.now() so auto-ids never collide with any
  // upstream-provided numeric/timestamp ids.
  const entry = { ...msg, id: msg.id ?? ++_autoId };

  if (widget) {
    const data     = widget.data ?? { messages: [] };
    const messages = [...(data.messages ?? []), entry].slice(-200);
    widget.data = { ...data, messages };
  }

  // Also keep the combined widget's snapshot in sync if it exists.
  const combined = _widgets.get('chat-overlay-combined');
  if (combined) {
    const data     = combined.data ?? { messages: [] };
    const messages = [...(data.messages ?? []), entry].slice(-200);
    combined.data = { ...data, messages };
  }

  // Broadcast just the ONE new message rather than re-sending the whole
  // (up to 200-message) buffer on every chat line. Previously this called
  // updateWidget() for both the per-platform and combined widgets, each of
  // which broadcasts its *entire* stored `messages` array to every
  // connected dashboard client — meaning a single chat line could push
  // ~200 messages' worth of JSON (multiplied further when messages still
  // carried the full third-party emote map) over SSE. The dashboard only
  // ever needs the new message; `widget.data` above still holds the full
  // snapshot for clients that connect/reload and need to bootstrap.
  broadcast({ type: 'chat-message', platform: msg.platform, entry });
}

/** Returns the raw widget Map (used by the dashboard-page builder + /state route). */
function _widgetsMap() {
  return _widgets;
}

/** Returns widgets sorted by order (used by the dashboard-page builder). */
function getSortedWidgets() {
  return [..._widgets.values()].sort((a, b) => a.order - b.order);
}

/** Returns a { widgetId: data } snapshot of every widget's current data. */
function getWidgetStateSnapshot() {
  return Object.fromEntries([..._widgets.entries()].map(([id, w]) => [id, w.data]));
}

module.exports = {
  registerWidget,
  updateWidget,
  pushChatMessage,
  getSortedWidgets,
  getWidgetStateSnapshot,
  _widgetsMap,
};
