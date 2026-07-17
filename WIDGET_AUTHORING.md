---
name: widget-authoring
description: "Use this skill whenever a user wants to add a dashboard widget to a chat-mirror plugin. Triggers include: 'add a widget', 'show data on the dashboard', 'create a dashboard card', 'register a widget', 'display stats in the dashboard', 'push data to the dashboard', or any request to surface plugin state visually on the stream dashboard. Also use when the user asks how to update, style, or use the badge/card helpers inside a render function. Do NOT use for overlay sections (those go through overlay-server's registerSection/updateSection), chat commands, slash commands, or general plugin scaffolding unrelated to the dashboard."
---

# Dashboard Widget Authoring

This skill covers everything needed to add a live-updating widget card to the stream dashboard from inside a chat-mirror plugin.

---

## How widgets work

The dashboard (`dashboard.js`) maintains a registry of widgets. Each widget has:

- A **server-side record** (title, icon, order, render function source, latest data)
- A **client-side card** rendered in the browser grid
- A live **SSE push** whenever `updateWidget()` is called

Plugins register once at startup, then call `updateWidget()` whenever their state changes. The browser re-renders automatically.

---

## Quick reference

| Task | Call |
|---|---|
| Register a widget | `dashboard.registerWidget(id, opts)` — call **once** at module load |
| Push new data | `dashboard.updateWidget(id, data)` — call whenever state changes |
| Update the badge pill | `badge.textContent = '…'` inside the render function |
| Toggle card visual state | `card.dataset.state = 'active'` inside the render function |
| HTML-escape user content | `esc(str)` inside the render function |

---

## Step 1 — Require the dashboard module

```js
const dashboard = require('../../dashboard');
```

Place this at the top of your plugin's `index.js`, alongside your other requires.

---

## Step 2 — Register the widget

Call `dashboard.registerWidget()` **at module load time** (outside any function), so the card appears in the dashboard grid immediately on startup — even before any data arrives.

```js
dashboard.registerWidget('my-plugin', {
  title: 'My Plugin',          // Card header text
  icon:  `<svg width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2.2"
            stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
          </svg>`,              // Raw SVG string, 20×20
  order: 30,                   // Sort order in grid (default: 50; lower = further left/up)
  render: (function render(data, el, esc, { badge }) {
    if (!data) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px">Waiting for data…</p>';
      return;
    }
    badge.textContent = data.count + ' items';
    el.innerHTML = data.items.map(i =>
      '<div>' + esc(i.name) + '</div>'
    ).join('');
  }).toString(),
});
```

### `registerWidget` options

| Option | Type | Required | Description |
|---|---|---|---|
| `title` | string | ✅ | Card header text |
| `icon` | string | | Raw SVG (20×20). Shown left of the title in accent colour. |
| `order` | number | | Grid sort order. Default `50`. Lower values render first. |
| `render` | string | ✅ | Client-side render function **serialised to a string** via `.toString()`. See render function rules below. |

---

## Step 3 — Push data

Call `dashboard.updateWidget()` any time your plugin's state changes. The dashboard broadcasts the new data to all connected browser tabs over SSE.

```js
function _notify() {
  dashboard.updateWidget('my-plugin', {
    count: _items.length,
    items: _items,
  });
}
```

Call `_notify()` after every mutation — additions, removals, clears, etc.

### What to pass as data

Pass a plain JSON-serialisable object. Whatever you pass here is what the render function receives as its first argument (`data`). Keep it flat and small — the dashboard SSE stream sends this on every update to every connected client.

---

## The render function

The render function runs **in the browser**. It is serialised to a string by `.toString()` and `eval`'d on the client side. This means:

### ✅ You can use
- The four arguments: `data`, `el`, `esc`, `{ card, badge }`
- Standard DOM APIs (`document`, `createElement`, etc.) — but prefer writing to `el.innerHTML`
- CSS custom properties defined by the dashboard (`var(--bg)`, `var(--accent)`, `var(--muted)`, `var(--text)`, `var(--border)`, `var(--mono)`)
- Inline styles on generated elements

### ❌ You cannot use
- `require()` — no Node modules in the browser
- Closures over module-level variables — the function is serialised, outer scope is gone
- `import` statements
- Any reference to variables defined outside the function body

### Render function signature

```
function render(data, el, esc, { card, badge }) { … }
```

| Argument | Type | Description |
|---|---|---|
| `data` | any \| null | Whatever was last passed to `updateWidget()`. `null` until first update. |
| `el` | HTMLElement | The `<div class="widget-body">` — write your HTML here |
| `esc` | function | HTML-escape helper: `esc(str)` → safe string. **Always use for user-supplied content.** |
| `card` | HTMLElement | The outer `<div class="widget-card">`. Use `card.dataset.state` to toggle visual modes. |
| `badge` | HTMLElement | The `<span class="widget-badge">` in the card header. Set `.textContent` for a pill label. |

### Always handle the null case

```js
render: (function render(data, el, esc, { badge }) {
  if (!data) {
    el.innerHTML = '<p style="color:var(--muted);font-size:12px">Waiting…</p>';
    badge.textContent = '';
    return;
  }
  // … normal render
}).toString(),
```

The render function is called on initial page load with `data = null` (before `updateWidget` has ever been called). Failing to guard will throw and the card will appear broken.

---

## Full plugin example

```js
// src/plugins/queue/index.js
'use strict';

const log       = require('../../logger');
const dashboard = require('../../dashboard');

// ── State ─────────────────────────────────────────────────────────────────
let _queue = [];

// ── Dashboard widget ──────────────────────────────────────────────────────
dashboard.registerWidget('queue', {
  title: 'Song Queue',
  order: 20,
  icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
           <line x1="8" y1="6"  x2="21" y2="6"/>
           <line x1="8" y1="12" x2="21" y2="12"/>
           <line x1="8" y1="18" x2="21" y2="18"/>
           <line x1="3" y1="6"  x2="3.01" y2="6"/>
           <line x1="3" y1="12" x2="3.01" y2="12"/>
           <line x1="3" y1="18" x2="3.01" y2="18"/>
         </svg>`,

  render: (function render(data, el, esc, { badge }) {
    if (!data || !data.queue) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px;font-family:var(--mono)">Queue empty</p>';
      badge.textContent = '';
      return;
    }

    badge.textContent = data.queue.length + ' songs';

    if (data.queue.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:12px;font-family:var(--mono)">Queue empty</p>';
      return;
    }

    el.innerHTML = data.queue.map((entry, i) =>
      '<div style="display:flex;gap:8px;align-items:baseline;padding:3px 0;' +
        'border-bottom:1px solid var(--border);font-size:13px">' +
        '<span style="color:var(--muted);font-family:var(--mono);font-size:11px;flex-shrink:0">' +
          (i + 1) +
        '</span>' +
        '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
          esc(entry.title) +
        '</span>' +
        '<span style="color:var(--muted);font-size:11px;flex-shrink:0">' +
          esc(entry.requester) +
        '</span>' +
      '</div>'
    ).join('');
  }).toString(),
});

// ── Helpers ───────────────────────────────────────────────────────────────
function _notify() {
  dashboard.updateWidget('queue', { queue: _queue });
}

function addToQueue(title, requester) {
  _queue.push({ title, requester });
  log.info(`[queue] Added: ${title} (${requester}), depth: ${_queue.length}`);
  _notify();
}

function skipCurrent() {
  _queue.shift();
  log.info(`[queue] Skipped. Remaining: ${_queue.length}`);
  _notify();
}

function clearQueue() {
  _queue = [];
  log.info('[queue] Cleared');
  _notify();
}

// ── Plugin export ─────────────────────────────────────────────────────────
module.exports = {
  id: 'queue',

  async processMessage(msg) {
    const text = msg.message.trim();

    if (/^!sr\s+/i.test(text)) {
      const title = text.replace(/^!sr\s+/i, '');
      addToQueue(title, msg.username);
      return { message: null };
    }

    if (/^!skip$/i.test(text) && msg.isMod) {
      skipCurrent();
      return { message: null };
    }

    if (/^!clearqueue$/i.test(text) && msg.isMod) {
      clearQueue();
      return { message: null };
    }

    return { message: msg };
  },
};
```

---

## Common patterns

### Counter / single stat

```js
render: (function render(data, el, esc, { badge }) {
  if (!data) { el.innerHTML = ''; badge.textContent = ''; return; }
  badge.textContent = data.value;
  el.innerHTML =
    '<p style="font-size:32px;font-weight:900;text-align:center;padding:12px 0;' +
    'font-family:var(--mono);color:var(--accent)">' + esc(String(data.value)) + '</p>' +
    '<p style="text-align:center;color:var(--muted);font-size:11px">' + esc(data.label) + '</p>';
}).toString(),
```

### Key-value table

```js
render: (function render(data, el, esc, { badge }) {
  if (!data) { el.innerHTML = ''; return; }
  el.innerHTML = Object.entries(data.stats).map(([k, v]) =>
    '<div style="display:flex;justify-content:space-between;padding:4px 0;' +
      'border-bottom:1px solid var(--border);font-size:12px">' +
      '<span style="color:var(--muted)">' + esc(k) + '</span>' +
      '<span style="font-family:var(--mono);font-weight:700">' + esc(String(v)) + '</span>' +
    '</div>'
  ).join('');
}).toString(),
```

### Card state toggling (e.g. active/idle)

```js
render: (function render(data, el, esc, { card, badge }) {
  if (!data) { card.dataset.state = 'idle'; el.innerHTML = ''; return; }
  const active = data.isLive;
  card.dataset.state = active ? 'active' : 'idle';
  badge.textContent  = active ? 'LIVE' : 'offline';
  el.innerHTML = '<p>' + esc(data.title) + '</p>';
}).toString(),
```

`card.dataset.state` is a free-form string — use it to apply CSS you add to the dashboard's `<style>` block if you control the dashboard HTML, or just leave it as a data attribute for future use.

---

## Common mistakes

| Mistake | Fix |
|---|---|
| Referencing a module-level variable inside render | Move all needed data into the object passed to `updateWidget()` |
| Forgetting `.toString()` on the render function | `render` must be a string — wrap in `(function render(…){…}).toString()` |
| Not guarding `if (!data)` | `data` is `null` on first render. Always handle it. |
| Calling `registerWidget` inside `init()` or `onChatReady()` | Call at module load time (top level) so the card exists before data arrives |
| Using `require()` inside render | Impossible in the browser — pass all needed values through `data` |
| Passing non-serialisable data (class instances, functions, circular refs) | Flatten to a plain object before passing to `updateWidget()` |
| XSS via user content | Always use `esc()` for any string that came from chat or user input |

---

## Relationship to overlay sections

Widgets (dashboard) and overlay sections are different systems:

| | Dashboard widgets | Overlay sections |
|---|---|---|
| Module | `../../dashboard` | `../../overlay-server` |
| Register | `registerWidget(id, opts)` | `registerSection(id, opts)` |
| Push data | `updateWidget(id, data)` | `updateSection(id, data)` |
| Visible to | Password-protected dashboard UI | Browser-source overlay in OBS/StreamElements |
| Purpose | Operator monitoring & control | Viewer-facing stream overlay |

A plugin can register **both** — one for the operator dashboard and one for the viewer overlay — using the same underlying state.