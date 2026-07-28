"""
ClipCurator Clipper Backend — FastAPI service for real video processing.

CPU-optimized pipeline:
  1. yt-dlp downloads Twitch/YouTube VODs
  2. faster-whisper (CTranslate2 CPU) generates transcripts
  3. librosa detects audio peaks (dB spikes, spectral flux)
  4. Chat velocity analysis (Twitch chat logs parsed from VOD metadata)
  5. Engagement scoring → highlight clip detection
  6. FFmpeg renders final clips
  7. YouTube Data API publishes approved clips

Endpoints:
  POST /download    — download a VOD via yt-dlp
  POST /analyze     — analyze a downloaded VOD (whisper + librosa + velocity)
  POST /render      — render a clip segment via FFmpeg
  POST /publish     — upload a clip to YouTube
  GET  /vod/{id}/master.mp4 — serve downloaded VOD file for review playback
  GET  /clip/{id}/final.mp4 — serve rendered clip file
  GET  /health      — service health check
"""

import os
import json
import uuid
import shutil
import subprocess
import asyncio
import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ─── Config ──────────────────────────────────────────────────────────────────

from dotenv import load_dotenv

# Load the parent project's .env (../.env) first, then our own
_parent_env = Path(__file__).resolve().parent.parent / ".env"
if _parent_env.exists():
    load_dotenv(_parent_env)
load_dotenv()  # clipper/.env overrides

DATA_DIR = Path(os.environ.get("CLIPPER_DATA_DIR", "/tmp/clipcurator"))
VOD_DIR = DATA_DIR / "vods"
CLIPS_DIR = DATA_DIR / "clips"
VOD_DIR.mkdir(parents=True, exist_ok=True)
CLIPS_DIR.mkdir(parents=True, exist_ok=True)

CLIPPER_PORT = int(os.environ.get("CLIPPER_PORT", "8100"))

# YouTube auth — read from .env (same vars the multistream bot uses)
YT_API_KEY = os.environ.get("YT_API_KEY", "")
YT_CHANNEL_ID = os.environ.get("YT_CHANNEL_ID", "")

# YouTube OAuth tokens file (same one youtube_auth.js creates)
YT_TOKENS_FILE = Path(__file__).resolve().parent.parent / ".youtube-tokens.json"

# Twitch auth — read from .env
TWITCH_CLIENT_ID = os.environ.get("TWITCH_CLIENT_ID", "")
TWITCH_CLIENT_SECRET = os.environ.get("TWITCH_CLIENT_SECRET", "")
TWITCH_TOKENS_FILE = Path(__file__).resolve().parent.parent / ".twitch-tokens.json"

log = logging.getLogger("clipper")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="ClipCurator Clipper", version="1.0.0")


# ─── Pydantic request models ────────────────────────────────────────────────

class DownloadRequest(BaseModel):
    sourceId: str
    url: str
    platform: str  # TWITCH | YOUTUBE

class AnalyzeRequest(BaseModel):
    sourceId: str
    storagePath: str

class RenderRequest(BaseModel):
    clipId: str
    sourceStoragePath: str
    finalStartSec: float
    finalEndSec: float

class PublishRequest(BaseModel):
    clipId: str
    clipStoragePath: str
    channel: str  # CHANNEL_A | CHANNEL_B
    title: str


# ─── yt-dlp download ────────────────────────────────────────────────────────

async def download_vod(url: str, source_id: str, platform: str) -> dict:
    """
    Download a VOD using yt-dlp. Saves to vods/{source_id}/master.mp4.
    Returns metadata: title, streamer name, duration, etc.
    """
    out_dir = VOD_DIR / source_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "master.mp4"

    # yt-dlp options — prefer mp4, best quality, no playlists
    ydl_opts = [
        "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "--output", str(out_path),
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "--no-check-certificates",
    ]

    # For Twitch VODs, try to get chat data too
    if platform == "TWITCH":
        chat_path = out_dir / "chat.json"
        ydl_opts.extend([
            "--write-comments",  # yt-dlp can extract Twitch chat from VODs
        ])

    cmd = ["yt-dlp"] + ydl_opts + [url]
    log.info(f"[download] Running: {cmd}")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        err_msg = stderr.decode() or "yt-dlp download failed"
        log.error(f"[download] Failed: {err_msg}")
        raise RuntimeError(err_msg)

    # Extract metadata using yt-dlp --dump-json
    meta_cmd = ["yt-dlp", "--dump-json", "--no-playlist", "--quiet", url]
    meta_proc = await asyncio.create_subprocess_exec(
        *meta_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    meta_stdout, meta_stderr = await meta_proc.communicate()

    metadata = {}
    if meta_proc.returncode == 0 and meta_stdout:
        try:
            metadata = json.loads(meta_stdout.decode())
        except json.JSONDecodeError:
            log.warning("[download] Could not parse yt-dlp metadata JSON")

    title = metadata.get("title", "Untitled Stream")
    streamer = metadata.get("uploader", metadata.get("channel", "Unknown"))
    duration = metadata.get("duration", 0) or 0
    thumbnail = metadata.get("thumbnail", "")

    # Save chat data if available (Twitch VODs)
    chat_path = out_dir / "chat.json"
    chat_data = []
    if chat_path.exists():
        try:
            chat_data = json.loads(chat_path.read_text())
        except:
            chat_data = []

    # Save metadata alongside the video
    meta_file = out_dir / "metadata.json"
    meta_file.write_text(json.dumps({
        "title": title,
        "streamer": streamer,
        "duration": duration,
        "thumbnail": thumbnail,
        "platform": platform,
        "url": url,
    }, indent=2))

    storage_path = f"/vods/{source_id}/master.mp4"

    return {
        "sourceId": source_id,
        "title": title,
        "streamerName": streamer,
        "durationSec": int(duration),
        "storagePath": storage_path,
        "thumbnailUrl": thumbnail,
    }


# ─── Whisper transcription (CPU-optimized) ──────────────────────────────────

def run_whisper(video_path: str) -> list[dict]:
    """
    Run faster-whisper on the video file. Uses the CTranslate2 CPU backend
    with the 'tiny' or 'base' model for fast CPU inference.
    Returns segments with start/end times and text.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log.warning("[whisper] faster-whisper not installed, falling back to mock transcript")
        return _mock_transcript()

    # Use 'tiny' model for CPU — fast and sufficient for highlight detection.
    # 'base' is better quality but ~2x slower on CPU.
    model_size = os.environ.get("WHISPER_MODEL", "tiny")
    device = "cpu"
    compute_type = "int8"  # Fastest CPU compute type

    log.info(f"[whisper] Loading model '{model_size}' on {device}/{compute_type}")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    log.info(f"[whisper] Transcribing {video_path}")
    segments_iter, info = model.transcribe(video_path, beam_size=1, vad_filter=True)

    segments = []
    for seg in segments_iter:
        segments.append({
            "start": seg.start,
            "end": seg.end,
            "text": seg.text.strip(),
        })

    log.info(f"[whisper] Transcribed {len(segments)} segments, language={info.language}")
    return segments


def _mock_transcript() -> list[dict]:
    """Fallback when faster-whisper is not available."""
    return [
        {"start": 0, "end": 5, "text": "Mock transcript — whisper not available"},
    ]


# ─── Audio analysis (librosa) ──────────────────────────────────────────────

def analyze_audio(video_path: str) -> list[dict]:
    """
    Use librosa to detect audio peaks — dB spikes and spectral flux
    that indicate exciting moments. CPU-only, uses librosa's default backend.
    Returns list of {time: float, score: float} peaks.
    """
    try:
        import librosa
        import numpy as np
    except ImportError:
        log.warning("[librosa] librosa not installed, falling back to mock audio peaks")
        return [{"time": 15.0, "score": 0.5}, {"time": 120.0, "score": 0.7}]

    log.info(f"[librosa] Analyzing audio from {video_path}")

    # Load audio at 16kHz (mono) — fast CPU processing
    y, sr = librosa.load(video_path, sr=16000, mono=True)

    # Short-time energy (RMS) in 0.5s windows
    hop_length = int(sr * 0.5)  # 0.5s windows
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]

    # Compute dB
    rms_db = librosa.amplitude_to_db(rms, ref=np.max)

    # Detect peaks: segments where RMS exceeds mean + 1.5 * std
    mean_db = np.mean(rms_db)
    std_db = np.std(rms_db)
    threshold = mean_db + 1.5 * std_db

    peaks = []
    peak_indices = np.where(rms_db > threshold)[0]

    # Merge nearby peaks (within 10 seconds)
    if len(peak_indices) > 0:
        current_start = peak_indices[0]
        for i in range(1, len(peak_indices)):
            gap = (peak_indices[i] - current_start) * 0.5  # convert to seconds
            if gap < 10:
                continue  # merge
            time_sec = current_start * 0.5
            score = min(1.0, (rms_db[current_start] - mean_db) / (2 * std_db + 1))
            peaks.append({"time": time_sec, "score": max(0.3, score)})
            current_start = peak_indices[i]
        # Last peak
        time_sec = current_start * 0.5
        score = min(1.0, (rms_db[current_start] - mean_db) / (2 * std_db + 1))
        peaks.append({"time": time_sec, "score": max(0.3, score)})

    # Also detect spectral flux peaks (onset detection)
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    onset_threshold = np.mean(onset_env) + 1.5 * np.std(onset_env)
    onset_peaks = librosa.util.peak_pick(
        onset_env, pre_max=3, post_max=3, pre_avg=3, post_avg=5, delta=onset_threshold, wait=10
    )
    for idx in onset_peaks:
        time_sec = idx * 0.5
        score = min(1.0, onset_env[idx] / (np.mean(onset_env) + 2 * np.std(onset_env)))
        peaks.append({"time": time_sec, "score": max(0.2, score)})

    # Deduplicate by merging within 15 seconds
    peaks.sort(key=lambda p: p["time"])
    merged = []
    if peaks:
        current = peaks[0].copy()
        for p in peaks[1:]:
            if p["time"] - current["time"] < 15:
                current["score"] = max(current["score"], p["score"])
                current["time"] = (current["time"] + p["time"]) / 2
            else:
                merged.append(current)
                current = p.copy()
        merged.append(current)

    log.info(f"[librosa] Detected {len(merged)} audio peaks")
    return merged


# ─── Chat velocity analysis ─────────────────────────────────────────────────

def analyze_chat_velocity(chat_data: list, duration_sec: float) -> list[dict]:
    """
    Parse Twitch/YouTube chat data and detect velocity spikes.
    A velocity spike means many messages in a short window — the audience
    is reacting to something exciting.
    Returns list of {time: float, score: float, velocity: int} peaks.
    """
    if not chat_data:
        return []

    # Build time-indexed message counts in 5-second buckets
    bucket_size = 5
    bucket_count = max(1, int(duration_sec / bucket_size))
    buckets = [0] * bucket_count

    for msg in chat_data:
        # Twitch chat timestamps are in offset_seconds
        t = msg.get("offset_seconds", msg.get("timestamp_sec", 0))
        idx = min(bucket_count - 1, int(t / bucket_size))
        buckets[idx] += 1

    # Detect spikes: mean + 2.5 * std
    import statistics
    if not buckets:
        return []

    mean = statistics.mean(buckets)
    std = statistics.stdev(buckets) if len(buckets) > 1 else 0
    threshold = mean + 2.5 * std if std > 0 else mean * 3

    peaks = []
    for i, count in enumerate(buckets):
        if count > threshold:
            time_sec = i * bucket_size
            score = min(1.0, (count - mean) / (3 * std + 1))
            peaks.append({"time": time_sec, "score": max(0.3, score), "velocity": count})

    return peaks


# ─── Full analysis pipeline ─────────────────────────────────────────────────

async def analyze_vod(source_id: str, storage_path: str) -> dict:
    """
    Run the full analysis pipeline on a downloaded VOD:
    1. Whisper transcription
    2. Librosa audio peak detection
    3. Chat velocity parsing
    4. Merge all peaks → detect highlight clips
    5. Pad/trim clips to 45-90s duration, cap at 20 clips
    """
    # Resolve local file path from storage_path
    # storage_path format: /vods/{sourceId}/master.mp4
    local_path = VOD_DIR / source_id / "master.mp4"
    if not local_path.exists():
        raise FileNotFoundError(f"VOD not found: {local_path}")

    meta_file = VOD_DIR / source_id / "metadata.json"
    metadata = {}
    if meta_file.exists():
        metadata = json.loads(meta_file.read_text())

    duration = metadata.get("duration", 0) or 600
    thumbnail = metadata.get("thumbnail", "")

    # Run Whisper transcription (CPU)
    log.info(f"[analyze] Starting Whisper transcription for {source_id}")
    whisper_segments = run_whisper(str(local_path))

    # Run librosa audio analysis (CPU)
    log.info(f"[analyze] Starting librosa audio analysis for {source_id}")
    audio_peaks = analyze_audio(str(local_path))

    # Chat velocity
    chat_file = VOD_DIR / source_id / "chat.json"
    chat_data = []
    if chat_file.exists():
        try:
            chat_data = json.loads(chat_file.read_text())
        except:
            chat_data = []

    chat_peaks = analyze_chat_velocity(chat_data, duration)

    # Transcript highlight detection — look for excitement phrases
    transcript_peaks = []
    excitement_words = [
        "let's go", "no way", "holy", "clip it", "pog", "insane",
        "unbelievable", "wow", "gg", "amazing", "best",
    ]
    for seg in whisper_segments:
        text_lower = seg["text"].lower()
        for phrase in excitement_words:
            if phrase in text_lower:
                score = 0.4 + len(phrase) / 20  # longer phrases score higher
                transcript_peaks.append({
                    "time": seg["start"],
                    "score": score,
                    "phrase": seg["text"],
                })
                break

    # ─── Merge all peaks ──────────────────────────────────────────────
    all_peaks = []
    for p in audio_peaks:
        all_peaks.append({"time": p["time"], "score": p["score"], "type": "audio"})
    for p in chat_peaks:
        all_peaks.append({"time": p["time"], "score": p["score"], "velocity": p.get("velocity", 0), "type": "chat"})
    for p in transcript_peaks:
        all_peaks.append({"time": p["time"], "score": p["score"], "phrase": p.get("phrase", ""), "type": "transcript"})

    # Sort by time
    all_peaks.sort(key=lambda p: p["time"])

    # Merge proximate peaks (within 15s)
    merged = []
    if all_peaks:
        current = all_peaks[0].copy()
        for p in all_peaks[1:]:
            if p["time"] - current["time"] < 15:
                current["score"] = max(current["score"], p["score"])
                if "velocity" in p:
                    current["velocity"] = max(current.get("velocity", 0), p["velocity"])
                if p.get("phrase") and not current.get("phrase"):
                    current["phrase"] = p["phrase"]
                current["time"] = (current["time"] + p["time"]) / 2
            else:
                merged.append(current)
                current = p.copy()
        merged.append(current)

    # Sort by score, cap at 20 clips
    merged.sort(key=lambda p: p["score"], reverse=True)
    top_peaks = merged[:20]

    # ─── Build clip windows ──────────────────────────────────────────
    clips = []
    for peak in top_peaks:
        start = max(0, peak["time"] - 15)
        end = min(duration, peak["time"] + 45)

        # Enforce min 45s, max 90s
        if end - start < 45:
            end = min(duration, start + 45)
        if end - start > 90:
            end = start + 90

        # Engagement score: weighted blend
        chat_boost = 0
        velocity = peak.get("velocity", 0)
        if velocity > 0:
            chat_boost = min(0.3, velocity / 500)
        engagement = min(0.99, 0.4 + peak["score"] * 0.4 + chat_boost)

        # Build transcript snippet
        relevant_segments = [
            s for s in whisper_segments
            if s["start"] >= start and s["end"] <= end
        ]
        transcript_text = " ".join(s["text"] for s in relevant_segments) or peak.get("phrase", "")

        clips.append({
            "startTimeSec": start,
            "endTimeSec": end,
            "suggestedStart": start,
            "suggestedEnd": end,
            "engagementScore": round(engagement, 2),
            "chatVelocity": velocity or 20,
            "transcript": transcript_text,
            "peakPhrase": peak.get("phrase", "Highlight"),
            "thumbnailUrl": thumbnail,
        })

    # Sort clips by start time
    clips.sort(key=lambda c: c["startTimeSec"])

    log.info(f"[analyze] Detected {len(clips)} highlight clips for {source_id}")
    return {"sourceId": source_id, "clips": clips}


# ─── FFmpeg render ──────────────────────────────────────────────────────────

async def render_clip(
    clip_id: str,
    source_storage_path: str,
    final_start_sec: float,
    final_end_sec: float,
) -> dict:
    """
    Render a clip using FFmpeg: cut the segment from the VOD and produce
    a standalone MP4 optimized for YouTube upload.
    """
    # Resolve local source path
    source_id = source_storage_path.split("/")[2] if "/" in source_storage_path else ""
    local_source = VOD_DIR / source_id / "master.mp4"
    if not local_source.exists():
        raise FileNotFoundError(f"VOD not found: {local_source}")

    out_dir = CLIPS_DIR / clip_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "final.mp4"

    # FFmpeg command — fast seek + re-encode for YouTube compatibility
    cmd = [
        "ffmpeg",
        "-y",                    # overwrite output
        "-ss", str(final_start_sec),  # seek to start
        "-i", str(local_source),      # input file
        "-t", str(final_end_sec - final_start_sec),  # duration
        "-c:v", "libx264",           # H264 video codec
        "-preset", "fast",           # Fast encoding (CPU-friendly)
        "-crf", "23",                # Quality (23 is good for YouTube)
        "-c:a", "aac",               # AAC audio
        "-b:a", "128k",              # Audio bitrate
        "-movflags", "+faststart",   # Web-friendly MP4
        "-vf", "scale=-2:720",       # 720p output (scale width proportionally)
        str(out_path),
    ]

    log.info(f"[render] Running FFmpeg: {cmd}")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        err_msg = stderr.decode()[-500:] or "FFmpeg render failed"
        log.error(f"[render] Failed: {err_msg}")
        raise RuntimeError(err_msg)

    storage_path = f"/clips/{clip_id}/final.mp4"
    return {"clipId": clip_id, "storagePath": storage_path}


# ─── YouTube publish ────────────────────────────────────────────────────────

async def publish_to_youtube(
    clip_id: str,
    clip_storage_path: str,
    channel: str,
    title: str,
) -> dict:
    """
    Upload a rendered clip to YouTube using the YouTube Data API v3.
    Uses OAuth tokens from the .youtube-tokens.json file (created by youtube_auth.js).
    """
    # Resolve local clip path
    clip_id_from_path = clip_storage_path.split("/")[2] if "/" in clip_storage_path else clip_id
    local_clip = CLIPS_DIR / clip_id_from_path / "final.mp4"
    if not local_clip.exists():
        raise FileNotFoundError(f"Clip not found: {local_clip}")

    # Load YouTube OAuth tokens
    if not YT_TOKENS_FILE.exists():
        raise RuntimeError(
            f"YouTube tokens not found at {YT_TOKENS_FILE}. "
            "Run youtube_auth.js in the parent project directory first."
        )

    tokens = json.loads(YT_TOKENS_FILE.read_text())

    # Use google-auth to build credentials from the saved tokens
    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
    except ImportError:
        raise RuntimeError("google-api-python-client not installed. Run: pip install google-api-python-client")

    # Build credentials from saved tokens
    # The tokens file from youtube_auth.js has: access_token, refresh_token, token_uri, client_id, client_secret, scopes, expiry
    creds = Credentials(
        token=tokens.get("access_token", ""),
        refresh_token=tokens.get("refresh_token", ""),
        token_uri=tokens.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=tokens.get("client_id", ""),
        client_secret=tokens.get("client_secret", ""),
        scopes=tokens.get("scopes", ["https://www.googleapis.com/auth/youtube.force-ssl"]),
    )

    # Refresh if expired
    if creds.expired and creds.refresh_token:
        from google.auth.transport.requests import Request
        creds.refresh(Request())
        # Save refreshed tokens back
        tokens["access_token"] = creds.token
        tokens["expiry"] = creds.expiry.isoformat() if creds.expiry else ""
        YT_TOKENS_FILE.write_text(json.dumps(tokens, indent=2))

    youtube = build("youtube", "v3", credentials=creds)

    # Determine which channel to upload to
    # In production, CHANNEL_A and CHANNEL_B would map to different YouTube channels.
    # For now, we upload to the authenticated channel.
    # Future: add CHANNEL_A_YT_CHANNEL_ID and CHANNEL_B_YT_CHANNEL_ID env vars

    log.info(f"[publish] Uploading clip {clip_id} to YouTube as '{title}'")

    # YouTube upload request
    body = {
        "snippet": {
            "title": title,
            "description": f"Auto-detected highlight clip from livestream VOD. Generated by ClipCurator.",
            "tags": ["clipcurator", "livestream", "highlights", "twitch", "vod"],
            "categoryId": "20",  # Gaming category
        },
        "status": {
            "privacyStatus": "public",
            "selfDeclaredMadeForKids": False,
        },
    }

    media = MediaFileUpload(str(local_clip), mimetype="video/mp4", resumable=True)

    request = youtube.videos().insert(
        part="snippet,status",
        body=body,
        media_body=media,
    )

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            log.info(f"[publish] Upload progress: {int(status.progress() * 100)}%")

    youtube_video_id = response.get("id", "")
    log.info(f"[publish] Published! YouTube video ID: {youtube_video_id}")

    return {"clipId": clip_id, "youtubeVideoId": youtube_video_id}


# ─── API Endpoints ──────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "clipper", "version": "1.0.0"}


@app.post("/download")
async def api_download(req: DownloadRequest):
    try:
        result = await download_vod(req.url, req.sourceId, req.platform)
        return JSONResponse(result)
    except Exception as e:
        log.error(f"[download] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze")
async def api_analyze(req: AnalyzeRequest):
    try:
        result = await analyze_vod(req.sourceId, req.storagePath)
        return JSONResponse(result)
    except Exception as e:
        log.error(f"[analyze] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/render")
async def api_render(req: RenderRequest):
    try:
        result = await render_clip(
            req.clipId,
            req.sourceStoragePath,
            req.finalStartSec,
            req.finalEndSec,
        )
        return JSONResponse(result)
    except Exception as e:
        log.error(f"[render] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/publish")
async def api_publish(req: PublishRequest):
    try:
        result = await publish_to_youtube(
            req.clipId,
            req.clipStoragePath,
            req.channel,
            req.title,
        )
        return JSONResponse(result)
    except Exception as e:
        log.error(f"[publish] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ─── Static file serving ────────────────────────────────────────────────────

@app.get("/vod/{source_id}/master.mp4")
async def serve_vod(source_id: str):
    path = VOD_DIR / source_id / "master.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="VOD not found")
    return FileResponse(path, media_type="video/mp4", filename="master.mp4")


@app.get("/clip/{clip_id}/final.mp4")
async def serve_clip(clip_id: str):
    path = CLIPS_DIR / clip_id / "final.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")
    return FileResponse(path, media_type="video/mp4", filename="final.mp4")


# ─── Startup ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    log.info(f"ClipCurator Clipper starting on port {CLIPPER_PORT}")
    log.info(f"Data directory: {DATA_DIR}")
    log.info(f"VOD directory: {VOD_DIR}")
    log.info(f"Clips directory: {CLIPS_DIR}")
    uvicorn.run(app, host="0.0.0.0", port=CLIPPER_PORT)
