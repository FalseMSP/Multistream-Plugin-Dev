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

  // Optional — called once at startup with the full context object:
  //   context.discord:   { sendChat, sendRedeem, onModAction }
  //   context.chatReply: { twitch: async fn(text), youtube: async fn(text) }
  // Note: chatReply values may be null at init time if platforms aren't ready yet.
  // Prefer onChatReady() for anything that depends on chatReply being populated.
  init(context) {},

  // Optional — called when chat reply handlers become available
  // chatReply: { twitch: fn, youtube: fn }
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

If your plugin needs to send messages back to Twitch or YouTube chat, implement `onChatReady(chatReply)`. This is called once the chat reply handlers are ready, and gives you a `{ twitch, youtube }` object where each value is an async function that accepts a string.

```js
let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
}

async function processMessage(msg) {
  const send = _chatReply[msg.platform]; // platform is 'twitch' or 'youtube'
  if (send) {
    send('Hello chat!')
      .catch(e => log.error('[my-plugin] chat reply error:', e.message));
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

const CMD_DISCORD = /^!discord\s*$/i;

let _chatReply = { twitch: null, youtube: null };

function onChatReady(chatReply) {
  _chatReply = chatReply;
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
- **`init(context)`** receives `{ discord: { sendChat, sendRedeem, onModAction }, chatReply }` — use it if your plugin needs to register its own mod-action handler or send messages proactively. `chatReply` values may still be `null` at this point if platforms haven't started yet — use `onChatReady` instead for anything that needs to send to chat.
- **`onChatReady(chatReply)`** is called once Twitch and YouTube clients are ready, after `init`. It's the correct hook for anything that sends replies to chat — by this point `chatReply.twitch` and `chatReply.youtube` are guaranteed to be populated.
- **Suppress bot-trigger commands** from `#stream-chat` by returning `{ message: null }` — commands like `!q` or `!discord` are noise in the Discord feed.
- **Serialise render functions** with `.toString()` when registering overlay sections. The function body must be fully self-contained.
