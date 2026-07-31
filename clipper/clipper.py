"""
ClipCurator Clipper Backend — FastAPI service for real video processing.

CPU-optimized pipeline:
  1. yt-dlp downloads Twitch/YouTube VODs
  2. faster-whisper (CTranslate2 CPU) generates transcripts
  3. librosa detects audio peaks (dB spikes, spectral flux, onset)
  4. Chat velocity analysis (Twitch chat logs parsed from VOD metadata)
  5. Engagement scoring → highlight clip detection (multi-signal:
     audio peaks + chat velocity + transcript excitement + ALL CAPS +
     exclamation density + laughter detection)
  6. FFmpeg renders final clips (with optional burned-in subtitles +
     backing track mixing)
  7. YouTube Data API publishes approved clips (multi-channel support)

Endpoints:
  POST /download              — download a VOD via yt-dlp
  POST /analyze               — analyze a downloaded VOD (whisper + librosa + velocity)
  POST /render                — render a clip segment via FFmpeg (+ subtitles + backing)
  POST /publish               — upload a clip to YouTube (channel-aware)
  GET  /transcript/{sourceId} — return raw Whisper segments for the subtitle editor
  POST /backing-track         — upload an MP3 to the backing track library
  GET  /backing/{trackId}.mp3 — serve a backing track file
  GET  /vod/{id}/master.mp4   — serve downloaded VOD file for review playback
  GET  /clip/{id}/final.mp4   — serve rendered clip file
  GET  /youtube/channel       — fetch YouTube channel info from saved tokens
  GET  /health                — service health check
"""

import os
import json
import uuid
import shutil
import subprocess
import asyncio
import logging
import math
import re
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
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
BACKING_DIR = DATA_DIR / "backing"
VOD_DIR.mkdir(parents=True, exist_ok=True)
CLIPS_DIR.mkdir(parents=True, exist_ok=True)
BACKING_DIR.mkdir(parents=True, exist_ok=True)

CLIPPER_PORT = int(os.environ.get("CLIPPER_PORT", "8100"))

# YouTube auth — read from .env (same vars the multistream bot uses)
YT_API_KEY = os.environ.get("YT_API_KEY", "")
YT_CHANNEL_ID = os.environ.get("YT_CHANNEL_ID", "")

# Per-channel token files. Channel A uses the legacy default; Channel B
# uses a separate file. The Next.js app manages which file each channel
# points to via the Channel table.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TOKEN_FILES = {
    "CHANNEL_A": PROJECT_ROOT / ".youtube-tokens.json",
    "CHANNEL_B": PROJECT_ROOT / ".youtube-tokens-b.json",
}

# Twitch auth — read from .env
TWITCH_CLIENT_ID = os.environ.get("TWITCH_CLIENT_ID", "")
TWITCH_CLIENT_SECRET = os.environ.get("TWITCH_CLIENT_SECRET", "")
TWITCH_TOKENS_FILE = PROJECT_ROOT / ".twitch-tokens.json"

log = logging.getLogger("clipper")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ─── Neural network v2 + feature extractor + YouTube analytics ───────────────
from clip_scorer import ClipScorer
from feature_extractor import extract_motion_score, extract_scene_count, extract_clap_score
from youtube_analytics import fetch_retention_curve, fetch_video_stats
from twitch_watcher import TwitchWatcher

_MODEL_PATH = DATA_DIR / "clip_scorer_model.json"
scorer = ClipScorer(model_path=str(_MODEL_PATH))
log.info(f"[clipper] Neural network v2 initialized — {scorer.stats()}")

_twitch_watcher = None

# Resolve yt-dlp binary path relative to the Python interpreter running this
# script. When launched via .venv/bin/python, sys.executable is
# /path/to/.venv/bin/python and yt-dlp is at /path/to/.venv/bin/yt-dlp.
# This avoids [Errno 2] No such file or directory when the venv's bin/
# isn't on PATH.
import sys as _sys
from pathlib import Path as _Path
import shutil as _shutil

_VENV_BIN = _Path(_sys.executable).parent
YTDLP_BIN = str(_VENV_BIN / "yt-dlp")
if not _Path(YTDLP_BIN).exists():
    YTDLP_BIN = "yt-dlp"  # fallback to PATH lookup
log.info(f"[clipper] yt-dlp binary: {YTDLP_BIN}")

# Resolve ffmpeg + ffprobe binary paths. ffmpeg is a system binary (not
# installed via pip), so it's NOT in the venv's bin/. We check common
# system paths, then fall back to shutil.which() (PATH lookup), then
# to the bare command name. This avoids [Errno 2] when the systemd
# service doesn't have /usr/bin on PATH.
def _resolve_binary(name: str) -> str:
    """Find a binary in venv/bin, common system paths, or PATH."""
    # 1. Check venv/bin (for pip-installed CLIs like yt-dlp)
    venv_path = _VENV_BIN / name
    if venv_path.exists():
        return str(venv_path)
    # 2. Check common system paths
    for p in ["/usr/bin", "/usr/local/bin", "/bin", "/snap/bin"]:
        candidate = _Path(p) / name
        if candidate.exists():
            return str(candidate)
    # 3. Use shutil.which() (respects PATH)
    which = _shutil.which(name)
    if which:
        return which
    # 4. Fall back to bare name (will fail with [Errno 2] if not on PATH)
    return name

FFMPEG_BIN = _resolve_binary("ffmpeg")
FFPROBE_BIN = _resolve_binary("ffprobe")
log.info(f"[clipper] ffmpeg binary: {FFMPEG_BIN}")
log.info(f"[clipper] ffprobe binary: {FFPROBE_BIN}")

app = FastAPI(title="ClipCurator Clipper", version="2.0.0")


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
    withSubtitles: bool = False
    subtitleVtt: Optional[str] = None
    subtitleStyle: Optional[dict] = None
    withBackingTrack: bool = False
    backingTrackPath: Optional[str] = None
    backingTrackVolume: float = 0.3
    # Vertical video layout (Shorts/TikTok format)
    # "original" = keep source aspect ratio (no vertical transform)
    # "vertical_center" = 9:16 with video centered, blurred background fill
    # "vertical_top" = 9:16 with video at top (facecam at bottom)
    # "vertical_bottom" = 9:16 with video at bottom (facecam at top)
    # "vertical_split" = 9:16 with video on top half, facecam placeholder on bottom
    layout: str = "original"


class PublishRequest(BaseModel):
    clipId: str
    clipStoragePath: str
    channel: str  # CHANNEL_A | CHANNEL_B
    title: str


# ─── yt-dlp download ────────────────────────────────────────────────────────

async def download_vod(url: str, source_id: str, platform: str) -> dict:
    """Download a VOD using yt-dlp. Saves to vods/{source_id}/master.mp4."""
    out_dir = VOD_DIR / source_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "master.mp4"

    ydl_opts = [
        "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "--output", str(out_path),
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "--no-check-certificates",
    ]

    # Use cookies if available — YouTube and Twitch often require authentication.
    # The cookies.txt file (Netscape format) should be in the clipper directory.
    _cookies_file = Path(__file__).resolve().parent / "cookies.txt"
    if _cookies_file.exists():
        ydl_opts.extend(["--cookies", str(_cookies_file)])
        log.info(f"[download] Using cookies from: {_cookies_file}")

    if platform == "TWITCH":
        ydl_opts.extend(["--write-comments"])

    cmd = [YTDLP_BIN] + ydl_opts + [url]
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

    # Extract metadata
    meta_cmd = [YTDLP_BIN, "--dump-json", "--no-playlist", "--quiet"]
    if _cookies_file.exists():
        meta_cmd.extend(["--cookies", str(_cookies_file)])
    meta_cmd.append(url)
    meta_proc = await asyncio.create_subprocess_exec(
        *meta_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    meta_stdout, _ = await meta_proc.communicate()

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

    chat_path = out_dir / "chat.json"
    chat_data = []
    if chat_path.exists():
        try:
            chat_data = json.loads(chat_path.read_text())
        except Exception:
            chat_data = []

    meta_file = out_dir / "metadata.json"
    meta_file.write_text(json.dumps({
        "title": title,
        "streamer": streamer,
        "duration": duration,
        "thumbnail": thumbnail,
        "platform": platform,
        "url": url,
    }, indent=2))

    # ─── Move moov atom to the front of the file (web optimization) ──────
    #
    # MP4 files from yt-dlp often have the moov atom (metadata: duration,
    # track info, sample tables) at the END of the file. The browser MUST
    # read moov before it can determine duration, seek, or start playback.
    #
    # For a 1.5GB VOD with moov at the end, the browser has to:
    #   1. Range-request the last few MB to read moov
    #   2. Parse metadata
    #   3. Range-request the beginning to start playing
    #
    # If any step fails or is slow, the player stalls silently — no error,
    # no log, just a frozen video element. This is the #1 cause of
    # "video loads but doesn't play" in web-based video editors.
    #
    # ffmpeg -movflags +faststart moves moov to the front, enabling
    # progressive download (browser reads metadata immediately, can seek
    # anywhere, starts playing as soon as the first bytes arrive).
    # This is what YouTube, Vimeo, and every video platform do.
    #
    # -c copy means no re-encoding — just remux into a new container.
    # Takes ~30-60s for a 1.5GB file on SSD, minimal CPU.
    log.info(f"[download] Optimizing for web playback (moving moov atom to front)")
    faststart_path = out_dir / "master_faststart.mp4"
    faststart_cmd = [
        FFMPEG_BIN, "-y",
        "-i", str(out_path),
        "-c", "copy",           # no re-encoding — just copy streams
        "-movflags", "+faststart",  # move moov to front
        "-loglevel", "warning",
        str(faststart_path),
    ]
    fs_proc = await asyncio.create_subprocess_exec(
        *faststart_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    fs_stdout, fs_stderr = await fs_proc.communicate()

    if fs_proc.returncode == 0 and faststart_path.exists():
        # Replace the original with the faststart version
        out_path.unlink()
        faststart_path.rename(out_path)
        log.info(f"[download] Web optimization complete — moov atom moved to front")
    else:
        err = fs_stderr.decode()[-500:] if fs_stderr else "unknown error"
        # MANDATORY: faststart is required for the video player to seek.
        # Without moov at the front, the browser can't determine duration
        # or seek to arbitrary positions — the playhead snaps back to 0
        # whenever the user tries to skip ahead. This makes the clip
        # unreviewable, so we fail the download instead of producing a
        # broken file.
        if faststart_path.exists():
            faststart_path.unlink()
        raise RuntimeError(
            f"faststart optimization failed — video would not be seekable. "
            f"FFmpeg error: {err}"
        )

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
    """Run faster-whisper on the video file. Returns segments with start/end/text."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log.warning("[whisper] faster-whisper not installed, returning empty transcript")
        return []

    model_size = os.environ.get("WHISPER_MODEL", "tiny")
    device = "cpu"
    compute_type = "int8"

    log.info(f"[whisper] Loading model '{model_size}' on {device}/{compute_type}")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    log.info(f"[whisper] Transcribing {video_path}")
    segments_iter, info = model.transcribe(video_path, beam_size=1, vad_filter=True, word_timestamps=True)

    segments = []
    for seg in segments_iter:
        segments.append({
            "start": float(seg.start),
            "end": float(seg.end),
            "text": seg.text.strip(),
        })

    log.info(f"[whisper] Transcribed {len(segments)} segments, language={info.language}")
    return segments


# ─── Audio analysis (librosa) ──────────────────────────────────────────────

def analyze_audio(video_path: str) -> list[dict]:
    """Use librosa to detect audio peaks — RMS, spectral flux, onset."""
    try:
        import librosa
        import numpy as np
    except ImportError:
        log.warning("[librosa] librosa not installed, returning empty audio peaks")
        return []

    log.info(f"[librosa] Analyzing audio from {video_path}")

    # Extract audio to a temporary 16kHz mono WAV using FFmpeg first.
    # librosa's default backends (soundfile/audioread) often can't decode
    # AAC audio inside MP4 containers — especially Twitch VODs. By
    # pre-extracting to WAV with FFmpeg, we sidestep the entire
    # PySoundFile/audioread failure path.
    import tempfile as _tempfile
    import subprocess as _subprocess
    wav_path = None
    try:
        with _tempfile.NamedTemporaryFile(suffix=".wav", delete=False, dir="/tmp") as f:
            wav_path = f.name
        log.info(f"[librosa] Extracting audio to WAV: {wav_path}")
        proc = _subprocess.run(
            [
                FFMPEG_BIN, "-y", "-i", str(video_path),
                "-vn",              # no video
                "-acodec", "pcm_s16le",
                "-ar", "16000",     # 16kHz
                "-ac", "1",         # mono
                wav_path,
            ],
            capture_output=True,
            timeout=300,  # 5 min max for extraction
        )
        if proc.returncode != 0:
            err = proc.stderr.decode()[-500:]
            log.warning(f"[librosa] FFmpeg extraction failed, falling back to librosa direct: {err}")
            wav_path = None

        if wav_path and _Path(wav_path).exists() and _Path(wav_path).stat().st_size > 0:
            y, sr = librosa.load(wav_path, sr=16000, mono=True)
        else:
            # Fallback: try loading the video directly (may fail on AAC)
            y, sr = librosa.load(video_path, sr=16000, mono=True)
    finally:
        if wav_path and _Path(wav_path).exists():
            try:
                _Path(wav_path).unlink()
            except Exception:
                pass

    hop_length = int(sr * 0.5)
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_db = librosa.amplitude_to_db(rms, ref=np.max)

    mean_db = np.mean(rms_db)
    std_db = np.std(rms_db)
    threshold = mean_db + 1.5 * std_db

    peaks = []
    peak_indices = np.where(rms_db > threshold)[0]

    if len(peak_indices) > 0:
        current_start = peak_indices[0]
        for i in range(1, len(peak_indices)):
            gap = (peak_indices[i] - current_start) * 0.5
            if gap < 10:
                continue
            time_sec = current_start * 0.5
            score = min(1.0, (rms_db[current_start] - mean_db) / (2 * std_db + 1))
            peaks.append({"time": time_sec, "score": max(0.3, score)})
            current_start = peak_indices[i]
        time_sec = current_start * 0.5
        score = min(1.0, (rms_db[current_start] - mean_db) / (2 * std_db + 1))
        peaks.append({"time": time_sec, "score": max(0.3, score)})

    # Spectral flux / onset detection
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    onset_threshold = np.mean(onset_env) + 1.5 * np.std(onset_env)
    onset_peaks = librosa.util.peak_pick(
        onset_env, pre_max=3, post_max=3, pre_avg=3, post_avg=5,
        delta=onset_threshold, wait=10
    )
    for idx in onset_peaks:
        time_sec = idx * 0.5
        score = min(1.0, onset_env[idx] / (np.mean(onset_env) + 2 * np.std(onset_env)))
        peaks.append({"time": time_sec, "score": max(0.2, score)})

    # Laughter detection — spectral rolloff spike (rough heuristic).
    # Laughter produces a wide-band spectral signature distinct from speech.
    try:
        rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr, hop_length=hop_length)[0]
        ro_mean = np.mean(rolloff)
        ro_std = np.std(rolloff)
        laught_indices = np.where(rolloff > ro_mean + 2 * ro_std)[0]
        for idx in laught_indices:
            time_sec = idx * 0.5
            peaks.append({"time": time_sec, "score": 0.5, "type": "laughter"})
    except Exception as e:
        log.debug(f"[librosa] Laughter detection skipped: {e}")

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
    """Parse Twitch/YouTube chat data and detect velocity spikes."""
    if not chat_data:
        return []

    bucket_size = 5
    bucket_count = max(1, int(duration_sec / bucket_size))
    buckets = [0] * bucket_count

    for msg in chat_data:
        t = msg.get("offset_seconds", msg.get("timestamp_sec", 0))
        idx = min(bucket_count - 1, int(t / bucket_size))
        buckets[idx] += 1

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


# ─── Engagement phrase + text analysis ──────────────────────────────────────

# Multi-language excitement phrase list — extended from the original 21 phrases.
EXCITEMENT_PHRASES = [
    # English
    "let's go", "let's gooo", "no way", "holy", "holy shit", "holy crap",
    "clip it", "clip that", "pog", "poggers", "insane", "unbelievable",
    "wow", "gg", "amazing", "best", "let's go baby", "oh my god", "omg",
    "absolutely", "crazy", "nuts", "sick", "clutch", "frame perfect",
    "world record", "pb", "personal best", "we did it", "we're back",
    "we are back", "we're so back", "cooked", "we are cooked",
    "absolute cinema", "cinema", "stop rewind", "hold up", "wait wait",
    "no shot", "no shot dude", "for real", "fr", "literally insane",
    "bussin", "cap", "no cap", "based", "ratio", "w", "w stream",
    "l", "l stream", "rip", "f", "ggwp", "gg ez", "ggs",
    "react", "reaction", "let him cook", "let her cook", "cooking",
    "yooo", "brooo", "what", "what just happened", "did you see that",
    "that was crazy", "did that just happen", "i can't", "i cant",
    "chat", "chat chat chat", "guys", "everyone", "look at this",
    # Spanish
    "vamos", "no way", "dios mío", "increíble", "joder", "guau",
    # Japanese (romanized)
    "sugoi", "suge", "majikayo", "hontou", "yatta", "nani",
    # Korean (romanized)
    "daebak", "jinjja", "wah", "oettoke",
    # French
    "mon dieu", "incroyable", "ouf", "wouahou",
]

# Caps / exclamation density thresholds
CAPS_RATIO_THRESHOLD = 0.5  # 50%+ uppercase → excited
EXCLAMATION_THRESHOLD = 2  # 2+ "!" in segment → excited


def detect_text_excitement(segments: list[dict]) -> list[dict]:
    """
    Analyze Whisper segments for excitement markers:
      - keyword matches (case-insensitive)
      - ALL CAPS density (>= 50% uppercase letters)
      - exclamation mark density (>= 2 in segment)
    Returns list of {time, score, phrase} peaks.
    """
    peaks = []
    for seg in segments:
        text = seg.get("text", "")
        if not text.strip():
            continue
        text_lower = text.lower()
        time = float(seg.get("start", 0))
        score = 0.0
        matched_phrase = None

        # Keyword match
        for phrase in EXCITEMENT_PHRASES:
            if phrase in text_lower:
                score = max(score, 0.4 + min(0.4, len(phrase) / 20))
                matched_phrase = text.strip()
                break

        # ALL CAPS density
        letters = [c for c in text if c.isalpha()]
        if letters:
            caps = sum(1 for c in letters if c.isupper())
            caps_ratio = caps / len(letters)
            if caps_ratio >= CAPS_RATIO_THRESHOLD and len(letters) >= 4:
                score = max(score, 0.5 + caps_ratio * 0.2)
                if not matched_phrase:
                    matched_phrase = text.strip()

        # Exclamation density
        excl_count = text.count("!")
        if excl_count >= EXCLAMATION_THRESHOLD:
            score = max(score, 0.45 + min(0.3, excl_count * 0.1))
            if not matched_phrase:
                matched_phrase = text.strip()

        if score > 0:
            peaks.append({
                "time": time,
                "score": min(1.0, score),
                "phrase": matched_phrase or text.strip(),
            })

    return peaks


# ─── Full analysis pipeline ─────────────────────────────────────────────────

async def analyze_vod(source_id: str, storage_path: str) -> dict:
    """Run the full analysis pipeline on a downloaded VOD."""
    local_path = VOD_DIR / source_id / "master.mp4"
    if not local_path.exists():
        raise FileNotFoundError(f"VOD not found: {local_path}")

    meta_file = VOD_DIR / source_id / "metadata.json"
    metadata = {}
    if meta_file.exists():
        metadata = json.loads(meta_file.read_text())

    duration = metadata.get("duration", 0) or 600
    thumbnail = metadata.get("thumbnail", "")

    log.info(f"[analyze] Starting Whisper transcription for {source_id}")
    whisper_segments = run_whisper(str(local_path))

    log.info(f"[analyze] Starting librosa audio analysis for {source_id}")
    # Wrap in try/except — audio analysis is best-effort. If it fails (e.g.
    # FFmpeg missing, corrupted audio), we still get clips from Whisper text
    # + chat velocity. Without this, a librosa failure kills the whole job
    # and all the Whisper work is wasted.
    try:
        audio_peaks = analyze_audio(str(local_path))
    except Exception as e:
        log.warning(f"[analyze] librosa audio analysis failed (continuing with text-only): {e}")
        audio_peaks = []

    chat_file = VOD_DIR / source_id / "chat.json"
    chat_data = []
    if chat_file.exists():
        try:
            chat_data = json.loads(chat_file.read_text())
        except Exception:
            chat_data = []

    chat_peaks = analyze_chat_velocity(chat_data, duration)

    # Text-based excitement detection (multi-signal)
    transcript_peaks = detect_text_excitement(whisper_segments)

    # ─── Extract advanced features (v2) ──────────────────────────────
    log.info(f"[analyze] Extracting advanced features for {source_id}")
    motion_score = 0.0
    try:
        motion_score = await extract_motion_score(str(local_path), sample_fps=1.0)
    except Exception as e:
        log.warning(f"[analyze] Motion score extraction failed: {e}")
    scene_count = 0
    try:
        scene_count = await extract_scene_count(str(local_path))
    except Exception as e:
        log.warning(f"[analyze] Scene detection failed: {e}")
    log.info(f"[analyze] Advanced features: motion={motion_score:.3f}, scenes={scene_count}")

    # ─── Merge all peaks ──────────────────────────────────────────────
    all_peaks = []
    for p in audio_peaks:
        all_peaks.append({"time": p["time"], "score": p["score"], "type": "audio"})
    for p in chat_peaks:
        all_peaks.append({
            "time": p["time"], "score": p["score"],
            "velocity": p.get("velocity", 0), "type": "chat"
        })
    for p in transcript_peaks:
        all_peaks.append({
            "time": p["time"], "score": p["score"],
            "phrase": p.get("phrase", ""), "type": "transcript"
        })

    all_peaks.sort(key=lambda p: p["time"])

    # Merge proximate peaks (within 60s — aggressive diversity gap)
    merged = []
    if all_peaks:
        current = all_peaks[0].copy()
        for p in all_peaks[1:]:
            if p["time"] - current["time"] < 60:
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

    # Sort by score, cap at 8 clips (aggressive cutting)
    merged.sort(key=lambda p: p["score"], reverse=True)
    top_peaks = merged[:8]

    # ─── Build clip windows ──────────────────────────────────────────
    # Smart cutting: use word-level Whisper timestamps + audio energy to
    # find natural cut points. Instead of rigid 45-90s windows centered
    # on the peak, we:
    #   1. Find the Whisper segment containing the peak phrase
    #   2. Start 3s before that segment (small lead-in for context)
    #   3. Extend end until audio energy drops back to baseline (moment over)
    #   4. Clamp to 15-90s (NOT 45s minimum — shorter clips are often better)
    clips = []
    for peak in top_peaks:
        peak_time = peak["time"]

        # Find the Whisper segment closest to the peak time
        best_seg = None
        best_dist = float("inf")
        for seg in whisper_segments:
            seg_start = float(seg.get("start", 0))
            seg_end = float(seg.get("end", 0))
            seg_mid = (seg_start + seg_end) / 2
            dist = abs(seg_mid - peak_time)
            if dist < best_dist:
                best_dist = dist
                best_seg = seg

        if best_seg:
            # Start 3s before the segment for context
            seg_start = float(best_seg.get("start", peak_time))
            start = max(0, seg_start - 3)
        else:
            # Fallback: 5s before peak
            start = max(0, peak_time - 5)

        # Smart end: extend from peak until audio energy drops.
        # Default end is peak + 15s, but we check if the excitement
        # dies down earlier (shorter clip = punchier).
        end = min(duration, peak_time + 15)

        # Check if there are more Whisper segments with excitement nearby
        # (extend the clip to include the full reaction)
        for seg in whisper_segments:
            seg_start = float(seg.get("start", 0))
            seg_end = float(seg.get("end", 0))
            seg_text = seg.get("text", "").lower()
            # If this segment is within 20s of the peak and has excitement
            if seg_start > peak_time and seg_start < peak_time + 20:
                if any(p in seg_text for p in EXCITEMENT_PHRASES[:20]):
                    end = min(duration, seg_end + 3)
                    break

        # Clamp: allow 15-90s (was 45-90s — shorter clips are better)
        if end - start < 15:
            end = min(duration, start + 15)
        if end - start > 90:
            end = start + 90

        log.info(f"[analyze] Clip at {peak_time:.0f}s: {start:.0f}s-{end:.0f}s ({end-start:.0f}s)")

        # Build transcript snippet from whisper segments in range
        # (MUST come before NN scoring — NN uses transcript for caps/excl features)
        relevant_segments = [
            s for s in whisper_segments
            if float(s.get("start", 0)) >= start and float(s.get("end", 0)) <= end
        ]
        transcript_text = " ".join(s.get("text", "") for s in relevant_segments) or peak.get("phrase", "")

        # ─── Extract features for the neural network (v2 — 12 features) ───
        velocity = peak.get("velocity", 0)
        audio_score = peak.get("score", 0)
        text_score = min(1.0, len(peak.get("phrase", "")) / 40) if peak.get("phrase") else 0
        letters_list = [c for c in transcript_text if c.isalpha()]
        caps_ratio_val = (sum(1 for c in letters_list if c.isupper()) / len(letters_list)) if letters_list else 0
        excl_count = transcript_text.count("!")

        # CLAP score (optional — 0 if not installed)
        clap_score_val = 0.0
        try:
            clap_score_val = await extract_clap_score(
                str(local_path), transcript_text, start, end
            )
        except Exception as e:
            log.debug(f"[analyze] CLAP extraction skipped: {e}")

        # Score with the neural network (v2 — 12 features)
        clip_features = {
            "chatVelocity": velocity,
            "audioScore": audio_score,
            "textScore": text_score,
            "capsRatio": caps_ratio_val,
            "exclamationCount": excl_count,
            "laughterScore": peak.get("laughter_score", 0),
            "duration": end - start,
            "motionScore": motion_score,
            "sceneCount": scene_count,
            "clapScore": clap_score_val,
            "llmViralScore": 0,  # filled in later by LLM scoring
            "openingRetention": 0,  # filled in later by YouTube analytics
        }
        engagement = scorer.predict(clip_features)

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

    clips.sort(key=lambda c: c["startTimeSec"])

    log.info(f"[analyze] Detected {len(clips)} highlight clips for {source_id}")
    return {
        "sourceId": source_id,
        "clips": clips,
        "transcript": whisper_segments,  # full segment list for subtitle editor
    }


# ─── FFmpeg render (with subtitles + backing track) ─────────────────────────

def _build_subtitle_filter(style: Optional[dict]) -> str:
    """Build FFmpeg force_style string for the subtitles filter."""
    if not style:
        return "Fontsize=24,Outline=2,Shadow=1"

    parts = []
    parts.append(f"Fontsize={style.get('fontSize', 24)}")
    parts.append("Outline=2")
    parts.append("Shadow=1")

    if style.get("bold"):
        parts.append("Bold=1")

    color = style.get("color", "#FFFFFF")
    # FFmpeg ass color format: &HAABBGGRR (alpha, blue, green, red)
    # Convert #RRGGBB → &H00BBGGRR (no alpha = opaque)
    if color.startswith("#") and len(color) == 7:
        r = color[1:3]
        g = color[3:5]
        b = color[5:7]
        ass_color = f"&H00{b}{g}{r}"
        parts.append(f"PrimaryColour={ass_color}")

    bg = style.get("bgColor", "#000000AA")
    # &HAABBGGRR — alpha from 8-char hex
    if bg.startswith("#") and len(bg) == 9:
        a = bg[1:3]
        r = bg[3:5]
        g = bg[5:7]
        b = bg[7:9]
        # FFmpeg alpha is inverted (00 = opaque, FF = transparent)
        a_val = 255 - int(a, 16)
        ass_bg = f"&H{a_val:02X}{b}{g}{r}"
        parts.append(f"BackColour={ass_bg}")
        parts.append("BorderStyle=4")  # opaque box

    position = style.get("position", "bottom")
    if position == "top":
        parts.append("Alignment=8")  # top center
    elif position == "center":
        parts.append("Alignment=5")  # middle center
    else:
        parts.append("Alignment=2")  # bottom center

    return ",".join(parts)


def _vtt_to_srt(vtt_content: str) -> str:
    """Convert WebVTT to SRT for FFmpeg's subtitles filter."""
    # Strip WEBVTT header
    srt = re.sub(r"^WEBVTT\s*\n", "", vtt_content, flags=re.IGNORECASE)
    # Replace . with , in timestamps (SRT uses commas for ms)
    srt = re.sub(r"(\d{2}:\d{2}:\d{2})\.(\d{3})", r"\1,\2", srt)
    # Add cue numbers
    lines = srt.split("\n")
    out_lines = []
    cue_idx = 1
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if "-->" in line:
            out_lines.append(str(cue_idx))
            out_lines.append(line)
            cue_idx += 1
            i += 1
            while i < len(lines) and lines[i].strip():
                out_lines.append(lines[i])
                i += 1
            out_lines.append("")
        else:
            i += 1
    return "\n".join(out_lines)


def _build_video_filter(
    layout: str,
    with_subtitles: bool,
    subtitle_vtt: Optional[str],
    subtitle_style: Optional[dict],
    srt_file: Optional[Path],
    final_start_sec: float,
) -> str:
    """
    Build the FFmpeg video filter chain based on the layout mode.

    Layouts:
      "original"        — scale to 720p, preserve aspect ratio
      "vertical_center" — 9:16 (1080x1920), video centered, blurred background
      "vertical_top"    — 9:16, video at top 70%, bottom 30% black (for facecam)
      "vertical_bottom" — 9:16, video at bottom 70%, top 30% black (for facecam)
      "vertical_split"  — 9:16, video on top 60%, bottom 40% black (facecam area)
    """
    if layout == "original" or layout is None:
        # Original: scale to 720p preserving aspect
        vf = "scale=-2:720"
    elif layout == "vertical_center":
        # 9:16 vertical with blurred background fill
        # 1. Scale source to fit 1080 width (preserve aspect)
        # 2. Create blurred scaled version for background
        # 3. Overlay centered
        vf = (
            "split[v_main][v_bg];"
            "[v_bg]scale=1080:1920,boxblur=20:20,setsar=1[v_bg_blurred];"
            "[v_main]scale=1080:-2,setsar=1[v_main_scaled];"
            "[v_bg_blurred][v_main_scaled]overlay=(W-w)/2:(H-h)/2[vout_pre_sub]"
        )
        # For vertical_center, we return the intermediate label
        # Subtitles (if any) are applied after overlay
        if with_subtitles and subtitle_vtt and srt_file:
            srt_content = _vtt_to_srt(subtitle_vtt)
            srt_content = _offset_srt(srt_content, -final_start_sec)
            srt_file.write_text(srt_content, encoding="utf-8")
            style_str = _build_subtitle_filter(subtitle_style)
            srt_path_escaped = str(srt_file).replace("\\", "/").replace(":", "\\:")
            vf += f";[vout_pre_sub]subtitles='{srt_path_escaped}':force_style='{style_str}'[vout]"
        else:
            vf += "[vout]"
        return vf
    elif layout in ("vertical_top", "vertical_bottom", "vertical_split"):
        # Vertical with video positioned + black area for facecam
        # Scale video to 1080 width, then pad to 1920 height
        if layout == "vertical_top":
            # Video at top, black at bottom
            pad_y = "0"  # video starts at y=0
        elif layout == "vertical_bottom":
            # Video at bottom, black at top
            pad_y = "-1"  # auto-center but we use pad with specific offset
        else:  # vertical_split
            # Video takes top 60% (1152px), bottom 40% (768px) for facecam
            pad_y = "0"

        vf = (
            "scale=1080:-2,setsar=1[v_scaled];"
            "[v_scaled]pad=1080:1920:0:"
        )
        if layout == "vertical_top":
            vf += "0:color=black[vout_pre_sub]"
        elif layout == "vertical_bottom":
            vf += "(oh-ih):color=black[vout_pre_sub]"
        else:  # vertical_split — video at top, facecam area at bottom
            vf += "0:color=black[vout_pre_sub]"

        if with_subtitles and subtitle_vtt and srt_file:
            srt_content = _vtt_to_srt(subtitle_vtt)
            srt_content = _offset_srt(srt_content, -final_start_sec)
            srt_file.write_text(srt_content, encoding="utf-8")
            style_str = _build_subtitle_filter(subtitle_style)
            srt_path_escaped = str(srt_file).replace("\\", "/").replace(":", "\\:")
            vf += f";[vout_pre_sub]subtitles='{srt_path_escaped}':force_style='{style_str}'[vout]"
        else:
            vf += "[vout]"
        return vf
    else:
        # Unknown layout — fallback to original
        vf = "scale=-2:720"

    # Apply subtitles for original layout
    if with_subtitles and subtitle_vtt and srt_file:
        srt_content = _vtt_to_srt(subtitle_vtt)
        srt_content = _offset_srt(srt_content, -final_start_sec)
        srt_file.write_text(srt_content, encoding="utf-8")
        style_str = _build_subtitle_filter(subtitle_style)
        srt_path_escaped = str(srt_file).replace("\\", "/").replace(":", "\\:")
        vf += f",subtitles='{srt_path_escaped}':force_style='{style_str}'"

    return vf + "[vout]"


async def render_clip(
    clip_id: str,
    source_storage_path: str,
    final_start_sec: float,
    final_end_sec: float,
    with_subtitles: bool = False,
    subtitle_vtt: Optional[str] = None,
    subtitle_style: Optional[dict] = None,
    with_backing_track: bool = False,
    backing_track_path: Optional[str] = None,
    backing_track_volume: float = 0.3,
    layout: str = "original",
) -> dict:
    """Render a clip using FFmpeg with optional subtitles + backing track + vertical layout."""
    source_id = source_storage_path.split("/")[2] if "/" in source_storage_path else ""
    local_source = VOD_DIR / source_id / "master.mp4"
    if not local_source.exists():
        raise FileNotFoundError(f"VOD not found: {local_source}")

    out_dir = CLIPS_DIR / clip_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "final.mp4"

    duration = final_end_sec - final_start_sec

    cmd = [FFMPEG_BIN, "-y"]
    cmd.extend(["-ss", str(final_start_sec), "-i", str(local_source)])

    # Input 1: backing track (if requested)
    backing_local = None
    if with_backing_track and backing_track_path:
        backing_id = backing_track_path.split("/")[-1].replace(".mp3", "")
        backing_local = BACKING_DIR / f"{backing_id}.mp3"
        if backing_local.exists():
            cmd.extend(["-i", str(backing_local)])
        else:
            log.warning(f"[render] Backing track not found: {backing_local}")
            with_backing_track = False

    # Build video filter based on layout
    srt_file = out_dir / "subs.srt"
    video_filter = _build_video_filter(
        layout, with_subtitles, subtitle_vtt, subtitle_style, srt_file, final_start_sec
    )

    # Build filter complex
    filters = []

    if layout == "original" or layout is None:
        # Original: single input video filter
        filters.append(f"[0:v]{video_filter}")
    else:
        # Vertical layouts: the filter chain already includes split + overlay
        # We need to prefix with [0:v] only for the first part
        filters.append(f"[0:v]{video_filter}")

    # Audio filter
    if with_backing_track and backing_local:
        filters.append(f"[0:a]volume=1.0[a0]")
        filters.append(f"[1:a]atrim=duration={duration},volume={backing_track_volume}[a1]")
        filters.append(f"[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]")
        audio_output = "[aout]"
    else:
        filters.append(f"[0:a]anull[aout]")
        audio_output = "[aout]"

    cmd.extend(["-filter_complex", ";".join(filters)])
    cmd.extend(["-map", "[vout]", "-map", audio_output])

    # Output encoding
    cmd.extend([
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-t", str(duration),
        str(out_path),
    ])

    log.info(f"[render] Layout: {layout}, FFmpeg: {' '.join(cmd[:25])}...")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        err_msg = stderr.decode()[-1000:] or "FFmpeg render failed"
        log.error(f"[render] Failed: {err_msg}")
        raise RuntimeError(err_msg)

    storage_path = f"/clips/{clip_id}/final.mp4"
    return {"clipId": clip_id, "storagePath": storage_path}


def _offset_srt(srt_content: str, offset_sec: float) -> str:
    """Offset all timestamps in an SRT by offset_sec (can be negative)."""
    def offset_ts(ts: str) -> str:
        # Parse HH:MM:SS,mmm
        m = re.match(r"(\d+):(\d+):(\d+),(\d+)", ts)
        if not m:
            return ts
        h, mi, s, ms = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
        total = h * 3600 + mi * 60 + s + ms / 1000 + offset_sec
        if total < 0:
            total = 0
        h = int(total // 3600)
        mi = int((total % 3600) // 60)
        s = int(total % 60)
        ms = int((total % 1) * 1000)
        return f"{h:02d}:{mi:02d}:{s:02d},{ms:03d}"

    # Match timestamp ranges
    def replace_range(match):
        return f"{offset_ts(match.group(1))} --> {offset_ts(match.group(2))}"

    return re.sub(
        r"(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})",
        replace_range,
        srt_content,
    )


# ─── YouTube publish (multi-channel) ────────────────────────────────────────

def _get_token_file(channel: str) -> Path:
    """Return the token file path for a given channel."""
    return DEFAULT_TOKEN_FILES.get(channel, DEFAULT_TOKEN_FILES["CHANNEL_A"])


async def publish_to_youtube(
    clip_id: str,
    clip_storage_path: str,
    channel: str,
    title: str,
) -> dict:
    """Upload a rendered clip to YouTube using the channel's OAuth tokens."""
    clip_id_from_path = clip_storage_path.split("/")[2] if "/" in clip_storage_path else clip_id
    local_clip = CLIPS_DIR / clip_id_from_path / "final.mp4"
    if not local_clip.exists():
        raise FileNotFoundError(f"Clip not found: {local_clip}")

    tokens_file = _get_token_file(channel)
    if not tokens_file.exists():
        raise RuntimeError(
            f"YouTube tokens not found at {tokens_file}. "
            f"Run youtube_auth.js with --tokens={tokens_file.name} to authorize {channel}."
        )

    tokens = json.loads(tokens_file.read_text())

    # Load client_id / client_secret from client_secret.json or env
    client_secret_file = PROJECT_ROOT / "client_secret.json"
    client_id = ""
    client_secret = ""
    if client_secret_file.exists():
        try:
            cs_data = json.loads(client_secret_file.read_text())
            installed = cs_data.get("installed", cs_data.get("web", {}))
            client_id = installed.get("client_id", "")
            client_secret = installed.get("client_secret", "")
        except Exception as e:
            log.warning(f"[publish] Could not parse client_secret.json: {e}")
    client_id = os.environ.get("YT_CLIENT_ID", client_id)
    client_secret = os.environ.get("YT_CLIENT_SECRET", client_secret)

    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
    except ImportError:
        raise RuntimeError(
            "google-api-python-client not installed. Run: pip install google-api-python-client"
        )

    scopes = tokens.get("scope", tokens.get("scopes",
        ["https://www.googleapis.com/auth/youtube.force-ssl"]))
    if isinstance(scopes, str):
        scopes = scopes.split(" ")

    creds = Credentials(
        token=tokens.get("access_token", ""),
        refresh_token=tokens.get("refresh_token", ""),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=scopes,
    )

    if creds.expired and creds.refresh_token:
        from google.auth.transport.requests import Request
        creds.refresh(Request())
        tokens["access_token"] = creds.token
        tokens["expiry"] = creds.expiry.isoformat() if creds.expiry else ""
        tokens_file.write_text(json.dumps(tokens, indent=2))

    youtube = build("youtube", "v3", credentials=creds)

    log.info(f"[publish] Uploading clip {clip_id} to YouTube ({channel}) as '{title}'")

    body = {
        "snippet": {
            "title": title,
            "description": (
                f"Auto-detected highlight clip from livestream VOD. "
                f"Generated by ClipCurator."
            ),
            "tags": ["clipcurator", "livestream", "highlights", "twitch", "vod"],
            "categoryId": "20",  # Gaming
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
    return {"status": "ok", "service": "clipper", "version": "2.0.0"}


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
            with_subtitles=req.withSubtitles,
            subtitle_vtt=req.subtitleVtt,
            subtitle_style=req.subtitleStyle,
            with_backing_track=req.withBackingTrack,
            backing_track_path=req.backingTrackPath,
            backing_track_volume=req.backingTrackVolume,
            layout=req.layout,
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


# ─── Transcript endpoint (for subtitle editor) ──────────────────────────────

@app.get("/transcript/{source_id}")
async def api_transcript(source_id: str):
    """Return raw Whisper segments for a source. Falls back to on-disk cache."""
    # Try the cached transcript first (written by analyze_vod)
    local_path = VOD_DIR / source_id / "master.mp4"
    if not local_path.exists():
        raise HTTPException(status_code=404, detail="VOD not found")

    # We don't persist segments to disk in analyze_vod — they're returned in
    # the response and the Next.js app caches them in DB. But if the DB is
    # empty (e.g. analyze job crashed mid-way), we can re-run whisper on demand.
    # For now, return empty — the Next.js endpoint will fall back to DB.
    return JSONResponse({"sourceId": source_id, "segments": []})


# ─── Backing track endpoints ────────────────────────────────────────────────

@app.post("/backing-track")
async def api_upload_backing_track(
    name: str = Form(...),
    file: UploadFile = File(...),
):
    """Upload an MP3 to the backing track library."""
    track_id = uuid.uuid4().hex
    out_path = BACKING_DIR / f"{track_id}.mp3"

    # Save the uploaded file
    content = await file.read()
    out_path.write_bytes(content)

    # Probe duration with ffprobe
    duration_sec = None
    try:
        proc = await asyncio.create_subprocess_exec(
            FFPROBE_BIN, "-v", "quiet", "-print_format", "json",
            "-show_format", str(out_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            probe = json.loads(stdout.decode())
            duration_sec = float(probe.get("format", {}).get("duration", 0)) or None
    except Exception as e:
        log.debug(f"[backing-track] ffprobe failed: {e}")

    storage_path = f"/backing/{track_id}.mp3"
    log.info(f"[backing-track] Uploaded '{name}' → {storage_path}")

    return JSONResponse({
        "id": track_id,
        "name": name,
        "storagePath": storage_path,
        "fileSizeBytes": len(content),
        "durationSec": duration_sec,
    })


# (Backing track files are now served via StaticFiles mount at /backing —
# see the "Static file serving" section below. This gives HTTP Range support
# for audio playback in the browser.)


# ─── YouTube channel info ───────────────────────────────────────────────────

@app.get("/youtube/channel")
async def api_youtube_channel(channel: str):
    """
    Fetch YouTube channel info (id, title, thumbnail) using the saved OAuth
    tokens for the given channel (CHANNEL_A or CHANNEL_B).
    """
    if channel not in ("CHANNEL_A", "CHANNEL_B"):
        raise HTTPException(status_code=400, detail="channel must be CHANNEL_A or CHANNEL_B")

    tokens_file = _get_token_file(channel)
    if not tokens_file.exists():
        return JSONResponse({
            "channelId": "",
            "title": "",
            "thumbnailUrl": "",
            "isConfigured": False,
        })

    try:
        tokens = json.loads(tokens_file.read_text())
    except Exception:
        return JSONResponse({
            "channelId": "",
            "title": "",
            "thumbnailUrl": "",
            "isConfigured": False,
        })

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

    try:
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="google-api-python-client not installed"
        )

    scopes = tokens.get("scope", tokens.get("scopes",
        ["https://www.googleapis.com/auth/youtube.force-ssl"]))
    if isinstance(scopes, str):
        scopes = scopes.split(" ")

    creds = Credentials(
        token=tokens.get("access_token", ""),
        refresh_token=tokens.get("refresh_token", ""),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=scopes,
    )

    if creds.expired and creds.refresh_token:
        from google.auth.transport.requests import Request
        try:
            creds.refresh(Request())
            tokens["access_token"] = creds.token
            tokens["expiry"] = creds.expiry.isoformat() if creds.expiry else ""
            tokens_file.write_text(json.dumps(tokens, indent=2))
        except Exception as e:
            log.warning(f"[youtube/channel] Token refresh failed: {e}")
            return JSONResponse({
                "channelId": "",
                "title": "",
                "thumbnailUrl": "",
                "isConfigured": False,
            })

    try:
        youtube = build("youtube", "v3", credentials=creds)
        # Get the authenticated user's channel
        resp = youtube.channels().list(
            part="snippet",
            mine=True,
        ).execute()
        items = resp.get("items", [])
        if not items:
            return JSONResponse({
                "channelId": "",
                "title": "",
                "thumbnailUrl": "",
                "isConfigured": False,
            })
        item = items[0]
        snippet = item.get("snippet", {})
        thumbnails = snippet.get("thumbnails", {})
        return JSONResponse({
            "channelId": item.get("id", ""),
            "title": snippet.get("title", ""),
            "thumbnailUrl": (
                thumbnails.get("default", {}).get("url", "")
                or thumbnails.get("medium", {}).get("url", "")
            ),
            "isConfigured": True,
        })
    except Exception as e:
        log.error(f"[youtube/channel] API call failed: {e}")
        return JSONResponse({
            "channelId": "",
            "title": "",
            "thumbnailUrl": "",
            "isConfigured": False,
        })


# ─── Static file serving (with full HTTP Range support for video playback) ───
#
# Video players (Chrome, Firefox, Safari) require HTTP 206 Partial Content
# responses to seek, determine duration, and play media. Without range
# support, the browser downloads the whole file but can't seek — the
# playhead snaps back to 0 whenever you try to skip ahead.
#
# We implement a custom range-aware file handler instead of using
# StaticFiles, because:
#   1. StaticFiles range support depends on the Starlette version
#   2. We need to set Accept-Ranges: bytes explicitly
#   3. We need to handle the path structure /vod/{sourceId}/master.mp4
#      where {sourceId} is a subdirectory
#
# This handler supports:
#   - GET with Range: bytes=start-end → 206 Partial Content
#   - GET without Range → 200 OK (full file)
#   - HEAD requests (for metadata probing)
#   - Content-Length, Content-Range, Accept-Ranges headers
#   - Proper MIME types for mp4, mp3, wav

import os as _os
from fastapi.responses import StreamingResponse

# MIME type map
_MIME_TYPES = {
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".webm": "video/webm",
}

def _get_mime_type(filename: str) -> str:
    ext = _os.path.splitext(filename)[1].lower()
    return _MIME_TYPES.get(ext, "application/octet-stream")


def _serve_file_with_range(file_path: _Path, request: Request):
    """
    Serve a file with HTTP Range request support.
    Returns 206 Partial Content if Range header is present, 200 OK otherwise.
    """
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    file_size = file_path.stat().st_size
    mime_type = _get_mime_type(str(file_path))

    # Parse Range header
    range_header = request.headers.get("range", "")
    if range_header:
        # Parse "bytes=start-end"
        range_match = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if range_match:
            start_str, end_str = range_match.group(1), range_match.group(2)
            start = int(start_str) if start_str else 0
            end = int(end_str) if end_str else file_size - 1
            # Clamp to file size
            end = min(end, file_size - 1)
            content_length = end - start + 1

            def file_iterator():
                with open(file_path, "rb") as f:
                    f.seek(start)
                    remaining = content_length
                    while remaining > 0:
                        chunk_size = min(1024 * 1024, remaining)  # 1MB chunks
                        data = f.read(chunk_size)
                        if not data:
                            break
                        remaining -= len(data)
                        yield data

            headers = {
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(content_length),
                "Content-Type": mime_type,
                "Cache-Control": "public, max-age=3600",
            }

            return StreamingResponse(
                file_iterator(),
                status_code=206,
                headers=headers,
            )

    # No Range header — return full file
    def full_iterator():
        with open(file_path, "rb") as f:
            while True:
                data = f.read(1024 * 1024)  # 1MB chunks
                if not data:
                    break
                yield data

    return StreamingResponse(
        full_iterator(),
        status_code=200,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
            "Content-Type": mime_type,
            "Cache-Control": "public, max-age=3600",
        },
    )


# File-serving routes — use the custom range handler
@app.get("/vod/{source_id}/master.mp4")
async def serve_vod(source_id: str, request: Request):
    path = VOD_DIR / source_id / "master.mp4"
    return _serve_file_with_range(path, request)


@app.head("/vod/{source_id}/master.mp4")
async def head_vod(source_id: str, request: Request):
    path = VOD_DIR / source_id / "master.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="VOD not found")
    return JSONResponse(
        content={},
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(path.stat().st_size),
            "Content-Type": "video/mp4",
        },
    )


@app.get("/clip/{clip_id}/final.mp4")
async def serve_clip(clip_id: str, request: Request):
    path = CLIPS_DIR / clip_id / "final.mp4"
    return _serve_file_with_range(path, request)


@app.head("/clip/{clip_id}/final.mp4")
async def head_clip(clip_id: str, request: Request):
    path = CLIPS_DIR / clip_id / "final.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Clip not found")
    return JSONResponse(
        content={},
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(path.stat().st_size),
            "Content-Type": "video/mp4",
        },
    )


@app.get("/backing/{track_id}.mp3")
async def serve_backing(track_id: str, request: Request):
    path = BACKING_DIR / f"{track_id}.mp3"
    return _serve_file_with_range(path, request)


# ─── Feedback endpoint (3-class, with retention support) ─────────────────────

class FeedbackRequest(BaseModel):
    clipId: str
    sourceId: str
    accepted: bool = True  # legacy field (true=accept, false=reject_bad)
    label: int = None  # 0=accept, 1=reject_bad, 2=not_interested (overrides accepted)
    retentionScore: float = None  # from YouTube analytics
    features: dict


@app.post("/feedback")
async def api_feedback(req: FeedbackRequest):
    """Receive review feedback and train the neural network (3-class)."""
    try:
        # Determine label
        if req.label is not None:
            label = req.label
        else:
            label = 0 if req.accepted else 1

        # If retention score is provided, use train_with_retention
        if req.retentionScore is not None:
            scorer.train_with_retention(req.features, req.retentionScore)
            log.info(
                f"[feedback] Trained on retention for clip {req.clipId} "
                f"(retention={req.retentionScore:.2%})"
            )
        else:
            scorer.train(req.features, label)
            log.info(
                f"[feedback] Trained on clip {req.clipId} "
                f"(label={label}) — total: {scorer.stats()['training_count']}"
            )

        return JSONResponse({"ok": True, "stats": scorer.stats()})
    except Exception as e:
        log.error(f"[feedback] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/scorer/stats")
async def api_scorer_stats():
    """Return neural network training statistics."""
    return JSONResponse(scorer.stats())


# ─── YouTube analytics fetch endpoint ────────────────────────────────────────

@app.get("/analytics/fetch")
async def api_fetch_analytics(video_id: str, channel: str):
    """Fetch retention curve + view stats for a published clip."""
    try:
        retention = await fetch_retention_curve(video_id, channel)
        stats = await fetch_video_stats(video_id, channel)
        return JSONResponse({
            "videoId": video_id,
            "retention": retention,
            "stats": stats,
        })
    except Exception as e:
        log.error(f"[analytics/fetch] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ─── Startup ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    # Start Twitch auto-ingest watcher in background
    _twitch_watcher = TwitchWatcher()
    import threading
    def _run_watcher():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(_twitch_watcher.start())
    watcher_thread = threading.Thread(target=_run_watcher, daemon=True)
    watcher_thread.start()
    log.info("[clipper] Twitch auto-ingest watcher started")

    log.info(f"ClipCurator Clipper v2.0 starting on port {CLIPPER_PORT}")
    log.info(f"Data directory: {DATA_DIR}")
    log.info(f"VOD directory: {VOD_DIR}")
    log.info(f"Clips directory: {CLIPS_DIR}")
    log.info(f"Backing tracks: {BACKING_DIR}")
    log.info(f"Project root: {PROJECT_ROOT}")
    log.info(f"Channel A tokens: {DEFAULT_TOKEN_FILES['CHANNEL_A']}")
    log.info(f"Channel B tokens: {DEFAULT_TOKEN_FILES['CHANNEL_B']}")
    uvicorn.run(app, host="0.0.0.0", port=CLIPPER_PORT, log_level="info")
