# chat-mirror

Mirrors Twitch + YouTube Live chat to Discord with rich embeds, channel point redeem tracking, and Discord slash commands for moderation.

## Features

| Feature | Detail |
|---|---|
| Twitch chat | Purple embed → `#chat-feed` |
| YouTube chat | Red embed → `#chat-feed` |
| Twitch redeems | Gold embed → `#redeem-feed` **and** `#chat-feed` |
| `/ban <user> [reason] [platform]` | Bans on Twitch and/or YouTube |
| `/vip <user> [platform]` | Grants VIP (Twitch) / Moderator (YouTube) |
| `/unvip <user> [platform]` | Removes VIP/Mod |
| YouTube ingest | WebSub primary, masterchat polling fallback |
| Plugin Support | Look at src/plugins for how to make stuff |

Current inbuilt plugins:
- Minecraft Link -> hides a regex and moves it to #plugin-chat
- GD Level Requests -> exactly what it sounds like

---

## Setup

### 1. Install dependencies

```bash
npm install
```

Requires Node.js 18+.

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env` — see the comments in `.env.example` for each value.

### 3. Create a Discord bot

1. Go to https://discord.com/developers/applications → **New Application**
2. **Bot** tab → **Reset Token** → copy token into `DISCORD_BOT_TOKEN`
3. Copy the **Application ID** into `DISCORD_CLIENT_ID`
4. **OAuth2 → URL Generator**: scopes = `bot` + `applications.commands`, permissions = `Send Messages`
5. Visit the generated URL to invite the bot to your server
6. Right-click your Discord server → **Copy Server ID** → `DISCORD_GUILD_ID`

### 4. Create Discord webhooks

For each channel (`#chat-feed` and `#redeem-feed`):

1. Channel Settings → Integrations → Webhooks → **New Webhook**
2. Copy URL into `DISCORD_CHAT_WEBHOOK_URL` / `DISCORD_REDEEM_WEBHOOK_URL`

### 5. Twitch credentials

- Bot OAuth token: https://twitchapps.com/tmi/ (log in as the bot account)
- App credentials: https://dev.twitch.tv/console/apps → **Register Your Application**
- The bot account must be a **moderator** in the channel to execute `/ban` and `/vip`

### 6. YouTube credentials

- API key: https://console.cloud.google.com/ → **APIs & Services → Credentials → Create Credentials → API Key**
- Enable the **YouTube Data API v3** in your project

### 7. WebSub (optional but recommended)

Set `WEBSUB_PUBLIC_URL` to your server's public HTTPS URL (e.g. `https://yourdomain.com`). The bot will receive push notifications when your channel goes live instead of polling.

If you don't have a public URL, leave it blank — the bot will fall back to polling every `YT_POLL_INTERVAL` seconds.

### 8. Run

```bash
npm start
```

Or with auto-restart on file changes (Node 18+):

```bash
npm run dev
```

---

## YouTube moderation limitation

YouTube's moderation API (ban user, add moderator) requires **OAuth 2.0** with the channel owner's credentials — an API key alone is not enough. The current implementation will return a clear error message when you try `/ban` or `/vip` on YouTube.

To enable YouTube mod actions, you would need to:

1. Set up OAuth 2.0 in your Google Cloud project
2. Add `https://www.googleapis.com/auth/youtube.force-ssl` scope
3. Implement the token refresh flow and store the refresh token

This is a planned improvement. Twitch mod actions work fully out of the box.

---

## Architecture

```
Twitch IRC (tmi.js)
  └─ chat messages ──────────────────┐
  └─ channel point redeems ──────────┤
                                     │
YouTube (masterchat)                 ▼
  └─ WebSub trigger ──► queue ──► Discord webhooks
  └─ polling fallback ──┘        • chat-feed   (purple/red/gold embeds)
                                 • redeem-feed (gold embeds)

Discord bot (discord.js)
  └─ /ban /vip /unvip ──► Twitch Helix API
                      └──► YouTube Data API (OAuth required)
```
