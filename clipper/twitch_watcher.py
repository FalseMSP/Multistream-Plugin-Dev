"""
TwitchWatcher — automatically ingests streams when they end.

Polling-based approach (no public webhook needed):
  1. Every 60 seconds, check if configured channels are live
  2. Track live/offline state per channel
  3. When a stream goes live → offline:
     a. Wait 5 minutes for Twitch to process the VOD
     b. Fetch the latest VOD URL via Twitch API
     c. Submit to ClipCurator's /api/streams endpoint
     d. Mark as ingested

Uses the Twitch Client Credentials flow (client_id + client_secret from .env).
Requires TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables.
"""

import asyncio
import json
import logging
import os
import time
import httpx
from pathlib import Path
from datetime import datetime, timezone

log = logging.getLogger("twitch-watcher")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CLIPPER_URL = os.environ.get("CLIPPER_URL", "http://localhost:8100")
CLIPCURATOR_URL = os.environ.get("CLIPCURATOR_INTERNAL_URL", "http://localhost:3001/clipcurator")
CLIPCURATOR_INTERNAL_API_KEY = os.environ.get("CLIPCURATOR_INTERNAL_API_KEY", "")
TWITCH_CLIENT_ID = os.environ.get("TWITCH_CLIENT_ID", "")
TWITCH_CLIENT_SECRET = os.environ.get("TWITCH_CLIENT_SECRET", "")

# Path to the SQLite DB (for direct read when the API is behind auth)
_DB_PATH = PROJECT_ROOT / "clipcurator" / "db" / "custom.db"

# State file — persists channel live/offline state across restarts
STATE_FILE = Path(os.environ.get("CLIPPER_DATA_DIR", "/tmp/clipcurator")) / "twitch_watcher_state.json"

# Polling interval (seconds)
POLL_INTERVAL = 60

# How long to wait after a stream ends before fetching the VOD (seconds)
VOD_WAIT_TIME = 5 * 60  # 5 minutes

# Max clips per auto-ingested stream
AUTO_INGEST_MAX_CLIPS = 8


class TwitchWatcher:
    def __init__(self):
        self.app_token = None
        self.token_expires = 0
        self.channel_states = {}  # channel_name → { is_live, last_offline_time, ingested }
        self.running = False
        self._load_state()

    def _load_state(self):
        """Load persisted channel states from disk."""
        try:
            if STATE_FILE.exists():
                data = json.loads(STATE_FILE.read_text())
                self.channel_states = data.get("channels", {})
                log.info(f"[twitch-watcher] Loaded state for {len(self.channel_states)} channels")
        except Exception as e:
            log.warning(f"[twitch-watcher] Failed to load state: {e}")
            self.channel_states = {}

    def _save_state(self):
        """Persist channel states to disk."""
        try:
            STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            STATE_FILE.write_text(json.dumps({
                "channels": self.channel_states,
                "saved_at": datetime.now(timezone.utc).isoformat(),
            }, indent=2))
        except Exception as e:
            log.warning(f"[twitch-watcher] Failed to save state: {e}")

    async def _get_app_token(self) -> str:
        """Get or refresh the Twitch app access token (client credentials flow)."""
        if self.app_token and time.time() < self.token_expires - 60:
            return self.app_token

        if not TWITCH_CLIENT_ID or not TWITCH_CLIENT_SECRET:
            log.warning("[twitch-watcher] TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET not set")
            return None

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://id.twitch.tv/oauth2/token",
                params={
                    "client_id": TWITCH_CLIENT_ID,
                    "client_secret": TWITCH_CLIENT_SECRET,
                    "grant_type": "client_credentials",
                },
                timeout=10,
            )
            if resp.status_code != 200:
                log.error(f"[twitch-watcher] Token request failed: {resp.status_code} {resp.text}")
                return None

            data = resp.json()
            self.app_token = data["access_token"]
            self.token_expires = time.time() + data.get("expires_in", 3600)
            log.info("[twitch-watcher] Refreshed Twitch app token")
            return self.app_token

    async def _get_watched_channels(self) -> list:
        """
        Fetch the list of watched channel names directly from the SQLite DB.
        Returns list of channel names (lowercase) with autoIngest=true.
        """
        try:
            import sqlite3
            import asyncio

            def _query():
                if not _DB_PATH.exists():
                    return []
                conn = sqlite3.connect(str(_DB_PATH))
                conn.row_factory = sqlite3.Row
                cursor = conn.execute(
                    "SELECT channelName FROM TwitchChannel WHERE autoIngest = 1"
                )
                rows = cursor.fetchall()
                conn.close()
                return [row["channelName"].lower() for row in rows]

            return await asyncio.to_thread(_query)
        except Exception as e:
            log.warning(f"[twitch-watcher] Failed to read channels from DB: {e}")
            return []

    async def _check_channel_live(self, channel_name: str, token: str) -> dict:
        """
        Check if a channel is currently live.
        Returns { is_live: bool, stream_id: str|null, started_at: str|null } or None on error.
        """
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    "https://api.twitch.tv/helix/streams",
                    params={"user_login": channel_name},
                    headers={
                        "Client-Id": TWITCH_CLIENT_ID,
                        "Authorization": f"Bearer {token}",
                    },
                    timeout=10,
                )
                if resp.status_code != 200:
                    log.warning(f"[twitch-watcher] Stream check failed for {channel_name}: {resp.status_code}")
                    return None

                data = resp.json()
                streams = data.get("data", [])
                if streams:
                    s = streams[0]
                    return {
                        "is_live": True,
                        "stream_id": s.get("id"),
                        "started_at": s.get("started_at"),
                        "title": s.get("title"),
                    }
                return {"is_live": False, "stream_id": None, "started_at": None}
        except Exception as e:
            log.warning(f"[twitch-watcher] Error checking {channel_name}: {e}")
            return None

    async def _get_latest_vod(self, channel_name: str, token: str) -> str:
        """
        Get the latest VOD URL for a channel.
        Returns the Twitch VOD URL (e.g. https://www.twitch.tv/videos/123456) or None.
        """
        try:
            async with httpx.AsyncClient() as client:
                # First get the user ID
                user_resp = await client.get(
                    "https://api.twitch.tv/helix/users",
                    params={"login": channel_name},
                    headers={
                        "Client-Id": TWITCH_CLIENT_ID,
                        "Authorization": f"Bearer {token}",
                    },
                    timeout=10,
                )
                if user_resp.status_code != 200:
                    log.warning(f"[twitch-watcher] User lookup failed for {channel_name}")
                    return None

                user_data = user_resp.json().get("data", [])
                if not user_data:
                    log.warning(f"[twitch-watcher] User not found: {channel_name}")
                    return None

                user_id = user_data[0]["id"]

                # Get latest VOD (archive type = past broadcast)
                vod_resp = await client.get(
                    "https://api.twitch.tv/helix/videos",
                    params={
                        "user_id": user_id,
                        "type": "archive",
                        "first": 1,
                    },
                    headers={
                        "Client-Id": TWITCH_CLIENT_ID,
                        "Authorization": f"Bearer {token}",
                    },
                    timeout=10,
                )
                if vod_resp.status_code != 200:
                    log.warning(f"[twitch-watcher] VOD lookup failed for {channel_name}")
                    return None

                vods = vod_resp.json().get("data", [])
                if not vods:
                    log.warning(f"[twitch-watcher] No VODs found for {channel_name}")
                    return None

                vod = vods[0]
                vod_url = f"https://www.twitch.tv/videos/{vod['id']}"
                log.info(f"[twitch-watcher] Found VOD for {channel_name}: {vod_url} (duration: {vod.get('duration', 'unknown')})")
                return vod_url
        except Exception as e:
            log.warning(f"[twitch-watcher] Error getting VOD for {channel_name}: {e}")
            return None

    async def _submit_vod(self, vod_url: str):
        """
        Submit a VOD URL to ClipCurator for processing.
        Calls the clipper's /download endpoint directly (bypasses the
        Next.js API + auth) since we're already running inside the clipper.
        """
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{CLIPPER_URL}/download",
                    json={
                        "sourceId": f"twitch_auto_{int(time.time())}",
                        "url": vod_url,
                        "platform": "TWITCH",
                    },
                    timeout=30,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    log.info(f"[twitch-watcher] Auto-submitted {vod_url} → {data.get('storagePath', 'unknown')}")
                else:
                    log.warning(f"[twitch-watcher] Submit failed: {resp.status_code} {resp.text}")
        except Exception as e:
            log.warning(f"[twitch-watcher] Error submitting VOD: {e}")

    async def _process_channel(self, channel_name: str, token: str):
        """Check a single channel and handle live→offline transitions."""
        status = await self._check_channel_live(channel_name, token)
        if status is None:
            return

        was_live = self.channel_states.get(channel_name, {}).get("is_live", False)
        is_live = status["is_live"]

        # Detect live → offline transition
        if was_live and not is_live:
            log.info(f"[twitch-watcher] {channel_name} went offline — scheduling VOD ingestion")
            self.channel_states[channel_name] = {
                "is_live": False,
                "offline_since": time.time(),
                "ingested": False,
                "last_stream_title": self.channel_states.get(channel_name, {}).get("current_title", ""),
            }
            self._save_state()

        # Detect offline → live transition
        elif not was_live and is_live:
            log.info(f"[twitch-watcher] {channel_name} went live: {status.get('title', '')}")
            self.channel_states[channel_name] = {
                "is_live": True,
                "stream_id": status.get("stream_id"),
                "current_title": status.get("title"),
                "ingested": False,
            }
            self._save_state()

        # Check if we need to ingest a VOD (channel went offline + waited enough)
        elif not is_live:
            state = self.channel_states.get(channel_name, {})
            offline_since = state.get("offline_since", 0)
            ingested = state.get("ingested", False)

            if offline_since and not ingested:
                elapsed = time.time() - offline_since
                if elapsed >= VOD_WAIT_TIME:
                    log.info(f"[twitch-watcher] {channel_name} — fetching VOD after {elapsed:.0f}s wait")
                    vod_url = await self._get_latest_vod(channel_name, token)
                    if vod_url:
                        await self._submit_vod(vod_url)
                        state["ingested"] = True
                        state["vod_url"] = vod_url
                        self._save_state()
                    else:
                        # VOD not ready yet — retry next cycle
                        log.info(f"[twitch-watcher] {channel_name} — VOD not ready, will retry")

    async def start(self):
        """Start the polling loop. Runs forever."""
        if not TWITCH_CLIENT_ID or not TWITCH_CLIENT_SECRET:
            log.warning("[twitch-watcher] TWITCH_CLIENT_ID/SECRET not set — watcher disabled")
            return

        self.running = True
        log.info(f"[twitch-watcher] Started (polling every {POLL_INTERVAL}s)")

        while self.running:
            try:
                token = await self._get_app_token()
                if token:
                    channels = await self._get_watched_channels()
                    if channels:
                        log.info(f"[twitch-watcher] Checking {len(channels)} channel(s): {', '.join(channels)}")
                        for ch in channels:
                            await self._process_channel(ch, token)
                    else:
                        log.debug("[twitch-watcher] No channels to watch")
            except Exception as e:
                log.error(f"[twitch-watcher] Polling error: {e}")

            await asyncio.sleep(POLL_INTERVAL)

    def stop(self):
        self.running = False
        log.info("[twitch-watcher] Stopped")
