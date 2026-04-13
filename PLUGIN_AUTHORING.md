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

  // Optional — called once at startup with the discord module
  init(discord) {},

  // Optional — a discord.js SlashCommandBuilder
  command: null,

  // Optional — called when your slash command is invoked
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

  // This plugin doesn't filter messages
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
- **`init(discord)`** receives `{ sendChat, sendRedeem, onModAction }` — use it if your plugin needs to register its own mod-action handler or send messages proactively.
