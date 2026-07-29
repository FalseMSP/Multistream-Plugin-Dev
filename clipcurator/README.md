# ClipCurator v2 — Real Pipeline + Subtitles + Backing Tracks + Channel Config

## What this patch does

This patch upgrades ClipCurator from a mock-demo to a fully working clip
curation tool. **All fake data has been removed.** Every clip is detected
from real video content via Whisper + librosa + chat velocity analysis.

### Major additions

1. **Real engagement detection** — Multi-signal scoring:
   - Whisper transcription → excitement phrase matching (60+ phrases,
     multi-language: English, Spanish, Japanese, Korean, French)
   - ALL CAPS density detection (≥50% uppercase → excited)
   - Exclamation mark density (≥2 per segment → excited)
   - librosa audio peak detection (RMS + spectral flux + onset)
   - Twitch chat velocity spikes (from yt-dlp `--write-comments`)
   - Laughter detection via spectral rolloff spikes

2. **Download button** — Sits on top of Channel A / Channel B / Reject in
   the review queue. Triggers a synchronous FFmpeg render and downloads
   the MP4 without publishing.

3. **In-app channel configuration** — New Settings page lets you label
   Channel A / Channel B and check their YouTube connection status.
   Per-channel OAuth token files (`.youtube-tokens.json`,
   `.youtube-tokens-b.json`). Click "Refresh" to pull the channel name +
   avatar from the YouTube API.

4. **Burned-in subtitles** — Toggle in the review queue. Whisper segments
   load into an inline editor where you can:
   - Edit text per segment
   - Adjust start/end times
   - Add / delete segments
   - Click a segment to seek the video
   - Style: font size, color, background color, position, bold
   - Live preview shows how subtitles will look
   FFmpeg burns the VTT into the rendered MP4 using the `subtitles` filter
   with ASS force_style.

5. **Backing tracks** — Upload MP3s to a library in Settings. Select per
   clip in the review queue with adjustable volume. FFmpeg mixes via
   `amix` filter.

6. **Auth unchanged** — Still uses the dashboard `dash_session` cookie
   via `middleware.ts` (Next.js 16: rename to `proxy.ts` to silence the
   deprecation warning). Same password as the dashboard.

7. **Removed all fake data:**
   - `SAMPLE_VODS` array (Big Buck Bunny etc.) — deleted
   - `HIGHLIGHT_PHRASES` array — deleted
   - `TRANSCRIPT_TEMPLATES` array — deleted
   - `pickSampleVod()` function — deleted
   - `analyzeStream()` mock — deleted
   - `generateYoutubeId()` mock — deleted
   - `/api/seed` endpoint — deleted
   - `useSeedDemo` hook — deleted
   - "Quick picks" section in dashboard — deleted
   - "Load demo data" button — deleted

---

## Design notes (research)

I looked at how existing clip curation tools handle these features:

| Tool | Engagement | Subtitles | Multi-channel | Download |
|------|-----------|-----------|---------------|----------|
| **OpusClip** | AI virality (audio + text + visual) | Auto, baked, editable | Single account | Paid only |
| **Eklipse.gg** | Chat velocity + keyword triggers | Auto, editable | Single | Yes |
| **Streamladder** | Manual | Manual editor w/ preview | Single | Yes |
| **Powder.gg** | Audio + chat + gameplay events | Auto, editable | Multi-account | Yes |

**Decisions made:**

- **Subtitle editor UX** — Modeled on Descript: each Whisper segment is
  a row with click-to-seek timestamp + inline textarea. No drag-handles
  (numeric inputs instead) because mobile drag UX is fiddly and the
  numeric inputs are precise. Live preview pane shows the rendered
  subtitle in a mock video frame.

- **Channel config** — Two cards (A and B) side-by-side. Each shows
  connection status as a badge (green Connected / red Not configured)
  and the YouTube avatar + name when connected. "Refresh" button pulls
  fresh info from the YouTube API. Instructions for running OAuth are
  inline so users don't have to leave the page.

- **Download button** — Placed leftmost in the action bar (before A/B/
  Reject) with a distinct zinc color so it doesn't compete with the
  green/blue publish CTAs. Synchronous render (5-30s) — the button
  shows a spinner during render, then auto-opens the download in a new
  tab. No publish happens.

- **Backing track selector** — Card below the subtitle editor. Toggle
  on/off, then a dropdown of uploaded tracks + volume slider. Original
  audio is always at 100%, backing track defaults to 30% (adjustable
  0-100%).

---

## File map

```
clipcurator-v2/
├── README.md                          ← this file
├── apply-patch.sh                     ← one-shot apply script
├── next.config.ts                     ← adds /backing/ rewrite
├── prisma/
│   └── schema.prisma                  ← Channel, BackingTrack, Clip fields
├── clipper/
│   └── clipper.py                     ← v2: enhanced engagement, subtitles, backing, multi-channel
└── src/
    ├── types/index.ts                 ← new types: Channel, BackingTrack, SubtitleStyle, RenderOptions
    ├── lib/
    │   ├── constants.ts               ← cleaned: no SAMPLE_VODS / HIGHLIGHT_PHRASES / etc.
    │   ├── pipeline.ts                ← generateTitle + VTT helpers (segmentsToVtt, vttToSegments)
    │   ├── clipper-client.ts          ← typed wrappers for all clipper endpoints
    │   └── queue.ts                   ← real pipeline + passes subtitle/backing options
    ├── store/queue.ts                 ← added withSubtitles, subtitleStyle, withBackingTrack, etc.
    ├── hooks/use-clipcurator.ts       ← removed useSeedDemo; added channels, backing-tracks, transcript, render-preview
    ├── components/clipcurator/
    │   ├── app-shell.tsx              ← added Settings nav item
    │   ├── dashboard-view.tsx         ← removed quick picks + demo data button
    │   ├── queue-view.tsx             ← added Download button, subtitle editor, backing track selector
    │   ├── settings-view.tsx          ← NEW: channel config + backing track library
    │   └── subtitle-editor.tsx        ← NEW: inline VTT editor with styling
    └── app/api/
        ├── streams/route.ts           ← POST no longer fakes title/streamer
        ├── queue/next/route.ts        ← returns real storagePath as videoUrl
        ├── queue/[id]/review/route.ts ← accepts withSubtitles, subtitleVtt, withBackingTrack, etc.
        ├── channels/                  ← NEW: GET, PUT (label), POST (refresh)
        │   ├── route.ts
        │   └── [id]/route.ts
        ├── backing-tracks/            ← NEW: GET (list), POST (upload), DELETE
        │   ├── route.ts
        │   └── [id]/route.ts
        ├── clips/[id]/
        │   ├── download/route.ts      ← NEW: 302 redirect to clipper's /clip/{id}/final.mp4
        │   ├── render-preview/route.ts ← NEW: synchronous render for download button
        │   └── subtitles/route.ts     ← NEW: GET/PUT saved VTT for a clip
        └── sources/[id]/
            └── transcript/route.ts    ← NEW: returns Whisper segments (DB first, clipper fallback)
```

Files **deleted** by the apply script:
- `src/app/api/seed/route.ts` (and its empty parent dir)

---

## Prerequisites

Before applying, verify these on the server:

```bash
# 1. Clipper backend is running
curl http://localhost:8100/health
# Expected: {"status":"ok","service":"clipper","version":"2.0.0"}

# 2. Python deps installed (faster-whisper, librosa, yt-dlp, google-api)
~/discord-chat-mirror2/clipper/.venv/bin/python -c "
import faster_whisper, librosa, yt_dlp
from googleapiclient.discovery import build
print('OK')
"

# 3. FFmpeg + ffprobe installed
which ffmpeg ffprobe

# 4. YouTube OAuth tokens exist for Channel A
ls -la ~/discord-chat-mirror2/.youtube-tokens.json

# 5. For Channel B, run youtube_auth.js with the --tokens flag:
#    node youtube_auth.js --tokens=.youtube-tokens-b.json

# 6. Twitch credentials in .env (for Twitch VOD downloads)
grep -E 'TWITCH_CLIENT_ID|TWITCH_CLIENT_SECRET' ~/discord-chat-mirror2/.env
```

If `faster-whisper` import fails:
```bash
~/discord-chat-mirror2/clipper/.venv/bin/pip install faster-whisper==1.1.0
```

If `google-api-python-client` is missing:
```bash
~/discord-chat-mirror2/clipper/.venv/bin/pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib
```

---

## Apply

```bash
# Copy this entire clipcurator-v2/ directory to the server, then:
bash apply-patch.sh /home/ubuntu/discord-chat-mirror2
```

The script:
1. Backs up replaced files to `*.bak.v2`
2. Copies patched files into place
3. Removes the obsolete `/api/seed` endpoint
4. Runs `prisma generate` + `prisma db push` (adds Channel, BackingTrack
   tables and new Clip columns)
5. Nukes `.next` cache
6. Restarts `clip-curator` systemd service
7. Tails the logs

---

## Verify end-to-end

### 1. Submit a real VOD URL

Dashboard → "Submit Stream URL" → paste a Twitch/YouTube VOD URL.

Logs should show:
```
[download] Running: ['yt-dlp', '--format', 'bestvideo[ext=mp4]...', url]
[whisper] Loading model 'tiny' on cpu/int8
[whisper] Transcribing /tmp/clipcurator/vods/{id}/master.mp4
[librosa] Analyzing audio from ...
[librosa] Detected N audio peaks
[analyze] Detected N highlight clips for {id}
```

Dashboard "Recent Streams" shows the real title + streamer (not "Big Buck Bunny").

### 2. Configure channels

Settings → for each channel:
- Click "Refresh" — should show YouTube channel name + avatar
- If "Not configured" → run `node youtube_auth.js` (Channel A) or
  `node youtube_auth.js --tokens=.youtube-tokens-b.json` (Channel B) on
  the server, then click Refresh again

### 3. Upload a backing track

Settings → "Backing Track Library" → upload an MP3 → should appear in
the list with duration + file size.

### 4. Review a clip

Queue → first clip loads. Real VOD plays in the player.

- **Subtitle editor**: toggle "Burned-in Subtitles" → Whisper segments
  load → edit text → adjust times → set style → preview
- **Backing track**: toggle "On" → select track → set volume
- **Download button**: click → spinner during render (5-30s) → browser
  downloads `final.mp4` with subtitles + backing burned in
- **Channel A / B**: click → render + publish to that channel
- **Reject**: marks as rejected, no render

### 5. Check published clips

History view → clip shows status `PUBLISHED` with real YouTube video ID.
Click the ID to open the video on YouTube.

---

## Performance expectations (2-hour VOD on CPU)

| Step | Time |
|------|------|
| Download (yt-dlp) | 1–10 min |
| Whisper 'tiny' transcription | ~1 hour (0.5× realtime) |
| librosa audio analysis | 3–5 min |
| FFmpeg render (60s clip, no subs) | 5–15s |
| FFmpeg render (60s clip, with subs + backing) | 15–40s |
| YouTube upload (60s 720p clip) | 30–120s |

The UI shows heartbeat progress during long operations.

---

## Troubleshooting

### "clipper unreachable: fetch failed"
Clipper backend isn't running. Check:
```bash
curl http://localhost:8100/health
```
If fails, look at clip-curator service logs for Python tracebacks.

### Whisper returns empty transcript
Either `faster-whisper` isn't installed, or the model can't download
(first run needs internet to fetch ~75MB model). Install:
```bash
~/discord-chat-mirror2/clipper/.venv/bin/pip install faster-whisper==1.1.0
```

### Subtitles don't burn in
Check that FFmpeg was compiled with `--enable-libass` (required for the
`subtitles` filter). Test:
```bash
ffmpeg -filters 2>&1 | grep subtitles
```
Should show `subtitles` in the list. If not, install a full FFmpeg build.

### Backing track mixing has no audio
The backing track file must exist at `/tmp/clipcurator/backing/{id}.mp3`.
Check:
```bash
ls /tmp/clipcurator/backing/
```
If empty, the upload didn't reach the clipper — check the Next.js API
logs for the `/api/backing-tracks` POST.

### YouTube publish fails for Channel B
You need a separate OAuth token file. On the server:
```bash
cd ~/discord-chat-mirror2
node youtube_auth.js --tokens=.youtube-tokens-b.json
```
Complete the OAuth flow with the second Google account, then click
"Refresh" in Settings.

### Channel refresh says "Not configured" but tokens exist
The clipper couldn't reach the YouTube API. Check:
```bash
curl http://localhost:8100/youtube/channel?channel=CHANNEL_A
```
Look at clipper logs for `[youtube/channel]` errors — usually a stale
refresh token or revoked access.

---

## Rollback

To revert to the pre-patch state:

```bash
cd ~/discord-chat-mirror2/clipcurator

# Restore backups
for f in $(find . -name "*.bak.v2"); do
  cp "$f" "${f%.bak.v2}"
done

# Restart Prisma + service
npx prisma generate
npx prisma db push --accept-data-loss
rm -rf .next
sudo systemctl restart clip-curator
```

Note: rollback will lose any data in the new `Channel`, `BackingTrack`
tables and the new Clip columns (withSubtitles, etc.) — `prisma db push`
will drop them when reverting the schema.
