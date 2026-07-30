"""
YouTube Analytics fetcher — retrieves retention curves and view stats
for published clips, feeding the data back into the clip scorer.

Uses the YouTube Data API v3 and YouTube Analytics API.
Requires the same OAuth tokens used for publishing (per-channel).

Key metrics:
  - audienceWatchRatio: fraction of viewers watching at each time point
  - relativeRetentionPerformance: how this video's retention compares
    to similar videos (1.0 = average, >1 = better than average)
  - viewCount, likeCount, commentCount, shareCount

The retention curve is the most valuable signal — it tells us exactly
where viewers lose interest, which informs more aggressive cutting.
"""

import json
import logging
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx

log = logging.getLogger("youtube-analytics")

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Per-channel token files (same as publish)
TOKEN_FILES = {
    "CHANNEL_A": PROJECT_ROOT / ".youtube-tokens.json",
    "CHANNEL_B": PROJECT_ROOT / ".youtube-tokens-b.json",
}


def _get_credentials(channel: str):
    """Build Google credentials for a channel."""
    tokens_file = TOKEN_FILES.get(channel)
    if not tokens_file or not tokens_file.exists():
        return None

    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
    except ImportError:
        log.warning("[yt-analytics] google-auth not installed")
        return None

    tokens = json.loads(tokens_file.read_text())

    # Load client creds
    client_secret_file = PROJECT_ROOT / "client_secret.json"
    client_id = ""
    client_secret = ""
    if client_secret_file.exists():
        try:
            cs_data = json.loads(client_secret_file.read_text())
            installed = cs_data.get("installed", cs_data.get("web", {}))
            client_id = installed.get("client_id", "")
            client_secret = installed.get("client_secret", "")
        except Exception:
            pass
    client_id = os.environ.get("YT_CLIENT_ID", client_id)
    client_secret = os.environ.get("YT_CLIENT_SECRET", client_secret)

    scopes = tokens.get("scope", tokens.get("scopes",
        ["https://www.googleapis.com/auth/youtube.force-ssl"]))
    if isinstance(scopes, str):
        scopes = scopes.split(" ")

    # Need the analytics scope
    if "https://www.googleapis.com/auth/yt-analytics.readonly" not in scopes:
        scopes.append("https://www.googleapis.com/auth/yt-analytics.readonly")

    creds = Credentials(
        token=tokens.get("access_token", ""),
        refresh_token=tokens.get("refresh_token", ""),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=scopes,
    )

    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            tokens["access_token"] = creds.token
            tokens["expiry"] = creds.expiry.isoformat() if creds.expiry else ""
            tokens_file.write_text(json.dumps(tokens, indent=2))
        except Exception as e:
            log.warning(f"[yt-analytics] Token refresh failed: {e}")
            return None

    return creds


async def fetch_retention_curve(
    video_id: str,
    channel: str,
) -> Optional[dict]:
    """
    Fetch the audience retention curve for a video.

    Returns:
        {
            "videoId": str,
            "retentionCurve": [(time_ratio, watch_ratio), ...],
            "averageViewPercentage": float,
            "relativeRetentionPerformance": float,  # 1.0 = average
            "openingRetention": float,  # retention at first 10%
        }
        or None on error.
    """
    creds = _get_credentials(channel)
    if not creds:
        return None

    try:
        from googleapiclient.discovery import build
    except ImportError:
        log.warning("[yt-analytics] google-api-python-client not installed")
        return None

    try:
        youtube_analytics = build(
            "youtubeAnalytics",
            "v2",
            credentials=creds,
            cache_discovery=False,
        )

        # Fetch retention report
        # dimensions=elapsedVideoTimeRatio gives us data points at
        # 0%, 1%, 2%, ... 100% of the video
        end_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        start_date = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%d")

        response = youtube_analytics.reports().query(
            ids="channel==MINE",
            startDate=start_date,
            endDate=end_date,
            metrics="audienceWatchRatio,relativeRetentionPerformance",
            dimensions="elapsedVideoTimeRatio",
            filters=f"video=={video_id}",
        ).execute()

        rows = response.get("rows", [])
        if not rows:
            log.info(f"[yt-analytics] No retention data for {video_id}")
            return None

        # Parse retention curve
        retention_curve = []
        for row in rows:
            time_ratio = float(row[0])  # 0.0 to 1.0
            watch_ratio = float(row[1]) if len(row) > 1 and row[1] is not None else 0.0
            retention_curve.append((time_ratio, watch_ratio))

        # Calculate opening retention (first 10% of video)
        opening_points = [w for t, w in retention_curve if t <= 0.1]
        opening_retention = sum(opening_points) / len(opening_points) if opening_points else 0.0

        # Average view percentage
        all_watch = [w for _, w in retention_curve]
        avg_view_pct = sum(all_watch) / len(all_watch) if all_watch else 0.0

        # Relative retention performance (last row's second metric)
        rel_retention = float(rows[-1][2]) if len(rows[-1]) > 2 and rows[-1][2] else 1.0

        result = {
            "videoId": video_id,
            "retentionCurve": retention_curve,
            "averageViewPercentage": avg_view_pct,
            "relativeRetentionPerformance": rel_retention,
            "openingRetention": opening_retention,
        }

        log.info(
            f"[yt-analytics] {video_id}: "
            f"avg={avg_view_pct:.2%}, opening={opening_retention:.2%}, "
            f"relative={rel_retention:.2f}"
        )
        return result

    except Exception as e:
        log.warning(f"[yt-analytics] Failed to fetch retention for {video_id}: {e}")
        return None


async def fetch_video_stats(video_id: str, channel: str) -> Optional[dict]:
    """
    Fetch basic video statistics (views, likes, comments).

    Returns:
        {
            "videoId": str,
            "viewCount": int,
            "likeCount": int,
            "commentCount": int,
        }
        or None on error.
    """
    creds = _get_credentials(channel)
    if not creds:
        return None

    try:
        from googleapiclient.discovery import build
    except ImportError:
        return None

    try:
        youtube = build("youtube", "v3", credentials=creds, cache_discovery=False)

        response = youtube.videos().list(
            part="statistics",
            id=video_id,
        ).execute()

        items = response.get("items", [])
        if not items:
            return None

        stats = items[0].get("statistics", {})
        result = {
            "videoId": video_id,
            "viewCount": int(stats.get("viewCount", 0)),
            "likeCount": int(stats.get("likeCount", 0)),
            "commentCount": int(stats.get("commentCount", 0)),
        }

        log.info(
            f"[yt-analytics] {video_id}: "
            f"{result['viewCount']} views, {result['likeCount']} likes"
        )
        return result

    except Exception as e:
        log.warning(f"[yt-analytics] Failed to fetch stats for {video_id}: {e}")
        return None
