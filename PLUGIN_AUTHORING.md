# Writing a chat-mirror Plugin

Plugins live in `src/plugins/<your-plugin-name>/index.js`.  
Create the directory, drop in an `index.js`, and it will be auto-loaded on next start — no registration needed.

---

## Minimal plugin skeleton

```js
'use strict';

module.exports = {
  // Required — unique kebab-case identifier
  id: 'my-plugin',

  // Optional — called once at startup with the full runtime context:
  //
  //   context.discord:  { sendChat, sendRedeem, sendDonation, registerCommands, onModAction, client }
  //                     (`client` is the raw discord.js Client, set after login)
  //   context.queue:    { onMessage, onRedeem, onDonation, pushMessage, pushRedeem, pushDonation, normaliseRedeemTitle }
  //   context.twitch:   the src/twitch module — say, ban, timeout, vip, unvip,
  //                     listRewards, createReward, deleteReward, updateReward,
  //                     getRewardByTitle, setRewardEnabled, getFollowerCount,
  //                     getSubscriberCount, createPoll, endPoll, getPoll,
  //                     createPrediction, endPrediction, updateStreamInfo,
  //                     getBroadcasterId, getUserToken, helixRequest, helixUserRequest
  //   context.youtube:  the src/youtube module — say, sayTo, stopSession,
  //                     triggerVideo, updateVideoInfo, getSubscriberCount,
  //                     getLikeCount, ban, timeout, vip, unvip
  //   context.streamInfo: the src/stream-info module — live Twitch stream state:
  //                     isLive(), getActiveGame(), getSnapshot(), getViewerCount(),
  //                     getCurrentSession(), getLastSession(), getAllSessions(),
  //                     getSessionStats(), onStreamEvent(fn).
  //                     See "Reading the active game / live viewer state" below.
  //
  // Note: chatReply is NOT in context — it's set later via onChatReady().
  // Anything that needs to send chat replies must wait for onChatReady.
  init(context) {
    // Capture modules you need:
    const { queue, twitch, youtube } = context;
    // Subscribe to queue events:
    queue.onRedeem(redeem => { /* ... */ });
  },

  // Optional — called when chat reply handlers become available.
  // chatReply shape:
  //   {
  //     twitch:         (text) => void,                  // broadcast to primary Twitch channel
  //     youtube:        (text) => void,                  // broadcast to all live YT sessions
  //     youtubeSession: (videoId, text) => void,         // target one specific YT live stream
  //   }
  onChatReady(chatReply) {},

  // Optional — a single discord.js SlashCommandBuilder
  command: null,

  // Optional — an array of SlashCommandBuilders (for plugins with multiple commands)
  commands: [],

  // Optional — called when any of your slash commands are invoked
  // Use interaction.commandName to route between multiple commands
  async handleInteraction(interaction) {},

  // Optional — called for every chat message
  // Return value controls routing (see below)
  async processMessage(msg) {
    return { message: msg }; // pass-through unchanged
  },
};
```

---

## `processMessage(msg)` return values

| Return value | Effect |
|---|---|
| `{ message: msg }` | Pass the (possibly modified) message to the next plugin and eventually the main feed |
| `{ message: null }` | Suppress from main feed entirely |
| `{ message: msg, sideEffect: async fn }` | Send to main feed AND call `fn()` (e.g. post to a different webhook) |
| `{ message: null, sideEffect: async fn }` | Suppress from main feed, but still call `fn()` |
| `null` / `undefined` | Same as `{ message: null }` — full suppress |

Plugins are applied in order. The first plugin to suppress a message stops the pipeline for that message — later plugins do not run.

> **Side effects and suppression:** when a plugin suppresses a message (`message: null`), its own `sideEffect` is still collected and will be called — but no further plugins run at all, so later plugins cannot add their own side effects.

---

## Replying to chat with `onChatReady`

If your plugin needs to send messages back to Twitch or YouTube chat, implement `onChatReady(chatReply)`. This is called once the chat reply handlers are ready, and gives you a `{ twitch, youtube, youtubeSession }` object.

```js
let _chatReply = { twitch: null, youtube: null, youtubeSession: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
}

async function processMessage(msg) {
  // Broadcast to the platform the message came from:
  const send = _chatReply[msg.platform]; // 'twitch' or 'youtube'
  if (send) {
    send('Hello chat!')
      .catch(e => log.error('[my-plugin] chat reply error:', e.message));
  }

  // OR target a specific YouTube live stream (when msg.videoId is set):
  if (msg.platform === 'youtube' && msg.videoId && _chatReply.youtubeSession) {
    _chatReply.youtubeSession(msg.videoId, 'Reply only to this stream')
      .catch(e => log.error('[my-plugin] session reply error:', e.message));
  }

  return { message: null };
}

module.exports = {
  id: 'my-plugin',
  onChatReady,
  processMessage,
};
```

> **Always guard with `if (send)`** — a platform handler may be `null` if that platform isn't connected.  
> **Always `.catch()`** — a failed send should never crash the plugin pipeline.

### chatReply contract

| Field | Signature | Use when… |
|---|---|---|
| `chatReply.twitch(text)` | `(text: string) => Promise<void>` | You want to broadcast to the primary Twitch channel |
| `chatReply.youtube(text)` | `(text: string) => Promise<void>` | You want to broadcast to ALL active YouTube live sessions |
| `chatReply.youtubeSession(videoId, text)` | `(videoId: string, text: string) => Promise<void>` | You want to reply only to the specific YouTube stream a message came from |

`youtubeSession` is the right choice whenever you have a `msg.videoId` — it
avoids broadcasting replies to other concurrent streams.

---

## Registering commands with the `!commands` list

The `commands-list` plugin exposes a shared registry so that `!commands` in chat always reflects every command that's actually loaded. **Any plugin that adds a chat command should register it** — otherwise it stays invisible to viewers.

### Registering on startup

Call `registerCommand` inside `onChatReady` (or `init`). Re-registering the same name just overwrites the description, so hot-reloads are safe.

```js
const commandsList = require('../commands-list');

function onChatReady(chatReply) {
  _chatReply = chatReply;
  commandsList.registerCommand('!discord', 'Get the Discord invite link');
}
```

### Removing a command

Call `removeCommand` if your plugin disables a command at runtime (e.g. a toggle feature).

```js
commandsList.removeCommand('!discord');
```

### Reading the full list

```js
const cmds = commandsList.getCommands();
// → [{ name: '!commands', description: '…' }, { name: '!discord', description: '…' }, …]
// Always sorted alphabetically.
```

### Full registry API

| Method | Signature | Description |
|---|---|---|
| `registerCommand` | `(name: string, description: string) => void` | Add or update a command entry |
| `removeCommand` | `(name: string) => void` | Remove a command entry by name |
| `getCommands` | `() => { name, description }[]` | Return all entries, sorted A–Z |

> **Load order note.** Plugin directories are loaded alphabetically. If your plugin loads before `commands-list`, the `require('../commands-list')` call will still succeed — Node's module cache means it gets the same singleton once `commands-list` eventually loads. However, prefer registering inside `onChatReady` rather than at module-load time to avoid ordering surprises.

---

## Multiple slash commands

Export a `commands` array instead of a single `command`, then route inside `handleInteraction` using `interaction.commandName`.

```js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commandFoo = new SlashCommandBuilder()
  .setName('foo')
  .setDescription('Does foo')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

const commandBar = new SlashCommandBuilder()
  .setName('bar')
  .setDescription('Does bar')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand(sub => sub.setName('list').setDescription('List things'))
  .addSubcommand(sub => sub.setName('clear').setDescription('Clear things'));

async function handleInteraction(interaction) {
  await interaction.deferReply({ ephemeral: false });

  if (interaction.commandName === 'foo') {
    return interaction.editReply('foo!');
  }

  if (interaction.commandName === 'bar') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list')  return interaction.editReply('listing…');
    if (sub === 'clear') return interaction.editReply('cleared!');
  }

  return interaction.editReply('⚠️ Unknown command.');
}

module.exports = {
  id: 'my-plugin',
  commands: [commandFoo, commandBar],
  handleInteraction,
};
```

> Use `command` (singular) when your plugin only needs one slash command.  
> Use `commands` (array) when it needs two or more.

---

## Reading the active game / live viewer state

`init(context)` receives `context.streamInfo` — a shared, always-fresh view of
the broadcaster's Twitch stream state (polled from Helix `GET /streams` every
60 s by default, using the existing app token — no new credentials).

### Quick reference

| Call | Returns | Notes |
|---|---|---|
| `streamInfo.isLive()` | `boolean` | |
| `streamInfo.getActiveGame()` | `{ name, id, since } \| null` | The Twitch category currently being played; `null` while offline |
| `streamInfo.getViewerCount()` | `number` | Live viewer count; `0` while offline |
| `streamInfo.getSnapshot()` | `{ isLive, gameName, gameId, title, viewers, startedAt, gameSinceAt, fetchedAt }` | Latest poll result |
| `streamInfo.getCurrentSession()` | session \| null | Open session while live (shape below) |
| `streamInfo.getLastSession()` | session \| null | Most recent FROZEN session — data freezes when the stream ends |
| `streamInfo.getAllSessions()` | session[] | Archived frozen sessions, oldest first |
| `streamInfo.getSessionStats(s)` | `{ peak, peakAt, avg, count, durationMs }` | Summary stats for any session |
| `streamInfo.onStreamEvent(fn)` | unsubscribe fn | Events: `live`, `offline`, `game-change`, `update` |

Session shape (compact — samples are `[epochSeconds, viewers, gameIndex]`
triples sharing a `games` string table):

```js
{
  startedAt: 1761164400000,   // ms epoch (Twitch started_at)
  endedAt:   null,            // set when the stream ended → session is frozen
  gameName: 'Minecraft',      // game at stream start
  title:    '…',              // latest stream title
  games:    ['Minecraft', 'Just Chatting'],
  samples:  [[1761164400, 42, 0], [1761164460, 55, 0], ...],
  peak:     { v: 420, t: 1761170000000 },
  rawSampleCount: 480,        // polls captured (before any decimation)
}
```

### Example: react to game changes

```js
function init(context) {
  const { streamInfo } = context;
  if (!streamInfo) return; // running under an older index.js — unavailable

  streamInfo.onStreamEvent(ev => {
    if (ev.type === 'game-change') {
      // ev.from → ev.to, e.g. swap an OBS scene or update a Discord channel
      log.info(`Now playing: ${ev.to} (was ${ev.from})`);
    }
    if (ev.type === 'offline') {
      const last = streamInfo.getLastSession();
      log.info(`Stream ended — peak ${streamInfo.getSessionStats(last).peak} viewers`);
    }
  });
}
```

The `stream-stats` plugin (live viewcount widget + graph + CSV export) is a
full working example of everything above — see
`src/plugins/stream-stats/index.js`.

> **Why polling, not EventSub?** Twitch's EventSub has `stream.online` /
> `stream.offline` events but **no viewer-count event** — Helix `GET /streams`
> is the only source of live viewer numbers, so one poll loop covers
> liveness, game changes, and viewcounts together (~1 req/min, well within
> the 800 req/min app-token budget).

---

## Twitch extension feeds (panel + mobile views)

The `twitch-ext` plugin is a **generic Twitch Extension backend (EBS)**: it owns
everything Twitch-specific — viewer JWT verification, the broadcaster id,
Extension PubSub delivery, per-viewer cooldowns, the 5 KB / 1 msg-s PubSub caps —
and knows nothing about any feature. Your plugin registers a **feed** to get its
state onto extension panels and to receive actions from viewers.

> Requires `TWITCH_EXT_CLIENT_ID` + `TWITCH_EXT_SECRET` in `.env` (see
> `env-additions.txt` in the twitch-extension deliverable). Without them the
> host stays dormant and `registerFeed` is a harmless no-op caller.

```js
const twitchExt = require('../twitch-ext');

const unregister = twitchExt.registerFeed({
  // Required — unique, [a-zA-Z0-9_-]{1,32}. The wire key the front-end reads.
  id: 'my-feature',

  // Optional — shown in logs and /ext/health.
  title: 'My Feature',

  // Optional category gate (case-insensitive Twitch category names).
  //   ['Geometry Dash']  → feed only active while streaming one of these
  //   null / [] / omitted → active whenever the channel is live, any game
  games: ['Geometry Dash'],

  // Required — the panel state. Called lazily on every /ext/state request
  // and PubSub broadcast, so it always serves fresh data. Keep it cheap and
  // JSON-safe, and sanitize anything user-generated.
  //
  // `byteBudget` (JSON bytes) is set on the PubSub path: trim yourself to
  // fit (e.g. drop tail list items while keeping the true total count) —
  // the whole broadcast envelope must stay under Twitch's 5 KB cap.
  snapshot({ byteBudget }) {
    return { items: _items.slice(0, 30), total: _items.length };
  },

  // Optional — viewer actions. Each key is the `type` field of a
  // POST /ext/submit body; action types must be unique across feeds.
  actions: {
    'do-thing': (viewer, payload) => {
      // viewer = { login, opaqueId, channelId } — TRUSTED identity, decoded
      //          from the SIGNED viewer JWT by the host. `login` is '' for
      //          anonymous viewers. NEVER trust payload for who is calling.
      // payload = the parsed JSON body (also carries .type).
      //
      // Return { ok: true, ...extras } → sent to the panel as-is (HTTP 200),
      // or      { ok: false, error, status?: 4xx } → shown as the error text.
      return _doThing(viewer.login, payload.thingId);
    },
  },
});

// Whenever your state changes, tell the host — it broadcasts to every open
// panel (merged + spaced to Twitch's 1 msg/s cap; no-op while inactive).
function _notify() {
  twitchExt.publish('my-feature');
}
```

`registerFeed()` returns an `unregister()` function (mostly useful in tests).
Register at module load, exactly where you `registerSection()` /
`dashboard.registerWidget()` — that's what `gd-queue` does for its level queue.

### What the panels receive

`GET /ext/state` (viewer JWT) and every PubSub broadcast carry the same
envelope — one entry per registered feed:

```json
{
  "active": true,
  "category": "Geometry Dash",
  "updatedAt": 1761170000000,
  "feeds": {
    "my-feature": { "active": true, "data": { "…whatever snapshot() returned" } }
  }
}
```

A front-end for one specific Twitch extension picks its feed id and renders
`state.feeds['my-feature'].data`. Each Twitch extension has its own client id
and front-end (e.g. the GD Level Queue panel in the twitch-extension
deliverable) — several feeds can share this one EBS host.

### Host-owned guarantees (you don't have to implement these)

| Concern | What the host does |
|---|---|
| Identity | Verifies the viewer JWT (HS256, hand-rolled — no new deps), requires the panel's `channel_id` to match the bot's channel, and hands your action a trusted `{ login, opaqueId, channelId }` |
| Broadcaster id | Resolved dynamically from `context.twitch.getBroadcasterId()`; `.env` pin only as a fallback |
| Rate limits | PubSub sends merged + spaced ≥ 1.1 s; per-viewer per-action 10 s cooldown; 4 KB body cap |
| Delivery | Full snapshots (not deltas) — panels self-heal via their periodic `/ext/state` poll |
| Category gating | Your feed's `games` list decides when panels are "live"; actions are hard-rejected (409) while the gate is closed |

`gd-queue` (`src/plugins/gd-queue/index.js`, "Twitch extension feed
registration") is the reference implementation: a trimmed, sanitized queue
snapshot + a `level-submit` action that lands viewer requests in the same
queue as the `!q` chat command, with anonymous viewers getting a stable
`Viewer-XXXX` handle.

---

## Overlay integration

Plugins can push data to the stream overlay via `registerSection` and `updateSection` from `../../overlay-server`.

```js
const { registerSection, updateSection } = require('../../overlay-server');

// Call once at module load time to declare your section
registerSection('my-plugin', {
  title: 'My Plugin',
  order: 10,               // controls render order relative to other sections
  icon: `<svg>…</svg>`,   // raw SVG string shown as the section icon

  // render() is serialised to a string and injected into the browser page.
  // It MUST be self-contained — no references to outer-scope variables.
  // Signature: (data, el, esc, { card, badge }) => void
  render: (function render(data, el, esc, { card, badge }) {
    if (!data) { el.innerHTML = ''; return; }
    badge.textContent = data.items.length + ' items';
    el.innerHTML = data.items.map(i => '<div>' + esc(i.name) + '</div>').join('');
  }).toString(),
});

// Call whenever state changes to push new data to the overlay
function _notify() {
  updateSection('my-plugin', { items: _items });
}
```

**Render function constraints** (because it is serialised):
- No closures over module-level variables
- No `require()` calls
- Use the provided `esc(str)` helper to HTML-escape user content
- Use `card.dataset.state` to toggle visual states (e.g. `'closed'`)
- Use `badge.textContent` to set the pill text in the section header

---

## Example: chat command with reply

```js
// src/plugins/discord-link/index.js
'use strict';

const log = require('../../logger');
const commandsList = require('../commands-list');

const CMD_DISCORD = /^!discord\s*$/i;

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
  commandsList.registerCommand('!discord', 'Get the Discord invite link');
  log.info('[discord-link] Chat reply handlers registered.');
}

async function processMessage(msg) {
  if (!CMD_DISCORD.test(msg.message.trim())) return { message: msg };

  const send = _chatReply[msg.platform];
  if (send) {
    send('Join the Discord: https://discord.gg/jBSNayWUrX')
      .catch(e => log.error('[discord-link] chat reply error:', e.message));
  }

  return { message: null }; // suppress the command from #stream-chat
}

module.exports = {
  id: 'discord-link',
  onChatReady,
  processMessage,
};
```

---

## Example: suppress all-caps messages

```js
// src/plugins/no-caps/index.js
'use strict';

module.exports = {
  id: 'no-caps',
  async processMessage(msg) {
    if (msg.message === msg.message.toUpperCase() && msg.message.length > 5) {
      return { message: null }; // suppress
    }
    return { message: msg };
  },
};
```

---

## Example: route messages with a keyword to a side channel

```js
// src/plugins/hype-train/index.js
'use strict';

const { WebhookClient, EmbedBuilder } = require('discord.js');
const wh = new WebhookClient({ url: process.env.DISCORD_HYPE_WEBHOOK_URL });

module.exports = {
  id: 'hype-train',
  async processMessage(msg) {
    if (!/hype|PogChamp|KEKW/i.test(msg.message)) return { message: msg };

    return {
      message: msg, // keep in main feed too
      sideEffect: async () => {
        await wh.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xff4500)
              .setDescription(`🚂 **${msg.username}**: ${msg.message}`)
          ],
        });
      },
    };
  },
};
```

---

## Example: slash command plugin

```js
// src/plugins/shoutout/index.js
'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  id: 'shoutout',

  command: new SlashCommandBuilder()
    .setName('shoutout')
    .setDescription('Give a shoutout in the stream chat')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption(o =>
      o.setName('user').setDescription('Username to shout out').setRequired(true)),

  async handleInteraction(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getString('user');
    // ... do something
    await interaction.editReply(`✅ Shoutout sent for ${user}!`);
  },

  async processMessage(msg) {
    return { message: msg };
  },
};
```

---

## Tips

- **Fail open.** If your plugin throws, the pipeline catches the error and passes the original message through, so chat is never silently dropped.
- **Env vars** for your plugin should follow the pattern `DISCORD_<PLUGIN>_WEBHOOK_URL` or `<PLUGIN>_<SETTING>`.
- **No registration.** Just create `src/plugins/<name>/index.js` and restart the bot.
- **Order matters.** Plugins are loaded alphabetically by directory name. If plugin A should run before plugin B, name accordingly (e.g. `01-plugin-a`, `02-plugin-b`).
- **`init(context)`** receives `{ discord, queue, twitch, youtube }`:
  - `context.discord` is the discord API object (`sendChat`, `sendRedeem`, `sendDonation`, `registerCommands`, `onModAction`, plus `client` after login).
  - `context.queue` is the queue module — subscribe via `queue.onMessage` / `queue.onRedeem` / `queue.onDonation`.
  - `context.twitch` and `context.youtube` are the main platform modules — use their public APIs (e.g. `twitch.listRewards()`, `twitch.ban(user, reason)`, `youtube.getSubscriberCount()`) rather than reimplementing Helix / YouTube Data API calls inline.
- **`onChatReady(chatReply)`** is called once Twitch and YouTube clients are ready, after `init`. It's the correct hook for anything that sends replies to chat — by this point `chatReply.twitch`, `chatReply.youtube`, and `chatReply.youtubeSession` are all populated.
- **Prefer `chatReply.youtubeSession(videoId, text)`** over `chatReply.youtube(text)` whenever you have a `msg.videoId` — it avoids broadcasting replies to other concurrent streams.
- **Don't `require()` main modules directly** — use `init(context)` instead. If you find yourself writing `require('../../twitch')` or `require('../../youtube')` inside a plugin, that's a smell: the loader already passes those modules in via context.
- **Don't monkey-patch `context.discord.sendRedeem`** or any other API method. If you need to react to redeems, subscribe via `context.queue.onRedeem(...)`.
- **Use `queue.normaliseRedeemTitle(rawTitle)`** to strip `[YT]` suffixes and normalise case before matching redeem titles — every plugin that compares redeem titles should use this helper so the format is consistent.
- **Suppress bot-trigger commands** from `#stream-chat` by returning `{ message: null }` — commands like `!q` or `!discord` are noise in the Discord feed.
- **Serialise render functions** with `.toString()` when registering overlay sections. The function body must be fully self-contained.
- **For standalone OBS browser sources** of a single section, use `overlay.buildStandaloneSectionPage(sectionId)` instead of reaching into private `_getSectionMeta` / `_getSectionData` helpers.
- **Register every chat command** with `commandsList.registerCommand()` inside `onChatReady` so it appears in `!commands`. This is the single source of truth viewers see — if it's not registered, it's invisible.