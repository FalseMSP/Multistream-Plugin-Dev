Twitch IRC (tmi.js)
  └─ chat messages ──► plugin pipeline ──────────────────┐
  └─ channel point redeems ───────────────────────────────┤
                                                          │
YouTube (masterchat / Data API)                           ▼
  └─ WebSub trigger ──► plugin pipeline ──► queue ──► Discord webhooks
  └─ polling fallback ──┘                           • stream-chat  (purple/red/gold embeds)
                                                    • redeem-feed  (gold embeds)
                                                    • plugin-chat  (plain text, minecraft-link)

Plugin pipeline (src/plugins/)
  └─ minecraft-link  matches regex → #plugin-chat, suppresses from #stream-chat
  └─ gd-queue        !q / !ql → queue state + chat reply back to Twitch/YouTube

Discord bot (discord.js)
  └─ /ban /vip /unvip ──► Twitch Helix API / YouTube Data API
  └─ /minecraft_link  ──► configure minecraft-link plugin live
  └─ /next            ──► dequeue next GD level
  └─ /queue           ──► list / clear / remove queue entries
