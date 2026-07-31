#!/usr/bin/env python3
"""
pretrain.py — Pre-train the clip scorer neural network on popular streamer clips.

Downloads popular clips from YouTube (ishowspeed, xqc, kai cenat, etc.),
extracts the same features the clipper uses, and trains the model:
  - Popular clips (high view count) → label=0 (accept)
  - Random boring segments from VODs → label=1 (reject_bad)

This gives the neural network a head start — it already knows what "good"
clips look like before the user reviews anything.

Usage:
    cd /home/ubuntu/discord-chat-mirror2/clipper
    .venv/bin/python pretrain.py

    # Or with custom search terms:
    .venv/bin/python pretrain.py --search "ishowspeed clips,xqc best moments,kai cenat highlights"

    # Adjust number of clips to download:
    .venv/bin/python pretrain.py --count 30

Requirements:
    - yt-dlp (already installed in venv)
    - faster-whisper (already installed)
    - librosa (already installed)
    - numpy (already installed)
    - ffmpeg (system)

This script is CPU-intensive and takes 30-60 minutes depending on how
many clips you download. Run it once after setup, then the model learns
from your own reviews on top of this baseline.
"""

import argparse
import asyncio
import json
import os
import sys
import math
import tempfile
from pathlib import Path

# Add the clipper directory to the path so we can import our modules
sys.path.insert(0, str(Path(__file__).resolve().parent))

from clip_scorer import ClipScorer
from feature_extractor import extract_motion_score

import logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pretrain")

# ─── Config ──────────────────────────────────────────────────────────────────

DATA_DIR = Path(os.environ.get("CLIPPER_DATA_DIR", "/tmp/clipcurator"))
PRETRAIN_DIR = DATA_DIR / "pretrain"
PRETRAIN_DIR.mkdir(parents=True, exist_ok=True)

MODEL_PATH = DATA_DIR / "clip_scorer_model.json"

# Default search terms — popular streamers with viral clips
DEFAULT_SEARCHES = [
    "ishowspeed clips funny",
    "xqc best moments",
    "kai cenat highlights",
    "twitch best clips 2024",
    "streamer funny moments compilation",
    "poki clips",
    "asmongold reacts",
    "critikal clips funny",
]

# Resolve yt-dlp binary (same logic as clipper.py)
_VENV_BIN = Path(sys.executable).parent
YTDLP_BIN = str(_VENV_BIN / "yt-dlp")
if not Path(YTDLP_BIN).exists():
    YTDLP_BIN = "yt-dlp"


async def search_and_download_clips(search_term: str, count: int = 5) -> list:
    """Search YouTube for clips, download top results, return list of file paths."""
    clips = []

    out_template = str(PRETRAIN_DIR / "%(id)s.%(ext)s")
    search_query = f"ytsearch{count}:{search_term}"

    cmd = [
        YTDLP_BIN,
        "--format", "best[ext=mp4]/best",
        "--output", out_template,
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "--no-check-certificates",
        "--dump-json",
        search_query,
    ]

    log.info(f"[pretrain] Searching: '{search_term}' (top {count})")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        log.warning(f"[pretrain] Search failed: {stderr.decode()[-200:]}")
        return []

    for line in stdout.decode().strip().split("\n"):
        if not line:
            continue
        try:
            meta = json.loads(line)
            clip_id = meta.get("id", "")
            for ext in [".mp4", ".webm", ".mkv"]:
                path = PRETRAIN_DIR / f"{clip_id}{ext}"
                if path.exists():
                    clips.append({
                        "path": str(path),
                        "title": meta.get("title", ""),
                        "duration": meta.get("duration", 0),
                        "view_count": meta.get("view_count", 0),
                    })
                    break
        except json.JSONDecodeError:
            continue

    log.info(f"[pretrain] Downloaded {len(clips)} clips")
    return clips


def run_whisper_on_clip(video_path: str) -> list:
    """Run Whisper on a clip, return segments."""
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return []

    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    segments_iter, _ = model.transcribe(
        video_path, beam_size=1, vad_filter=True, word_timestamps=True
    )

    return [
        {"start": float(s.start), "end": float(s.end), "text": s.text.strip()}
        for s in segments_iter
    ]


def extract_features(clip_path: str, whisper_segments: list) -> dict:
    """Extract all 12 features from a clip."""
    import numpy as np

    # Audio score
    audio_score = 0.0
    try:
        import librosa
        import subprocess

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            wav_path = f.name

        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", clip_path, "-vn",
             "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", wav_path],
            capture_output=True, timeout=60,
        )

        if proc.returncode == 0:
            y, sr = librosa.load(wav_path, sr=16000, mono=True)
            rms = librosa.feature.rms(y=y, hop_length=int(sr * 0.5))[0]
            rms_db = librosa.amplitude_to_db(rms, ref=np.max)
            mean_db = np.mean(rms_db)
            std_db = np.std(rms_db)
            peak_ratio = np.mean(rms_db > mean_db + 1.5 * std_db)
            audio_score = float(min(1.0, peak_ratio * 5))

        os.unlink(wav_path)
    except Exception as e:
        log.debug(f"[pretrain] Audio failed: {e}")

    # Motion score
    motion_score = 0.0
    try:
        loop = asyncio.new_event_loop()
        motion_score = loop.run_until_complete(
            extract_motion_score(clip_path, sample_fps=1.0)
        )
        loop.close()
    except Exception as e:
        log.debug(f"[pretrain] Motion failed: {e}")

    # Text features
    transcript = " ".join(s["text"] for s in whisper_segments)
    letters = [c for c in transcript if c.isalpha()]
    caps_ratio = (sum(1 for c in letters if c.isupper()) / len(letters)) if letters else 0
    excl_count = transcript.count("!")

    EXCITEMENT = [
        "let's go", "no way", "holy", "clip it", "pog", "insane",
        "unbelievable", "wow", "gg", "amazing", "crazy", "sick",
        "oh my god", "omg", "what", "bro", "chat", "yooo",
    ]
    text_lower = transcript.lower()
    text_score = 0.0
    for phrase in EXCITEMENT:
        if phrase in text_lower:
            text_score = max(text_score, 0.4 + len(phrase) / 40)
            break

    # Duration
    duration = 60.0
    try:
        import subprocess
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", clip_path],
            capture_output=True, timeout=10,
        )
        if proc.returncode == 0:
            meta = json.loads(proc.stdout.decode())
            duration = float(meta.get("format", {}).get("duration", 60))
    except Exception:
        pass

    return {
        "chatVelocity": 0,
        "audioScore": audio_score,
        "textScore": text_score,
        "capsRatio": caps_ratio,
        "exclamationCount": excl_count,
        "laughterScore": 0,
        "duration": duration,
        "motionScore": motion_score,
        "sceneCount": 0,
        "clapScore": 0,
        "llmViralScore": 0,
        "openingRetention": 0,
    }


def extract_boring_segment(video_path: str, duration: float) -> dict:
    """Extract features from a random boring segment (negative example)."""
    import random
    import subprocess

    if duration < 60:
        return None

    seg_start = random.uniform(10, duration - 40)

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        seg_path = f.name

    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-ss", str(seg_start), "-i", video_path,
             "-t", "30", "-c", "copy", seg_path],
            capture_output=True, timeout=30,
        )
        if proc.returncode != 0:
            return None

        segments = run_whisper_on_clip(seg_path)
        features = extract_features(seg_path, segments)
        features["duration"] = 30.0
        return features
    except Exception as e:
        log.debug(f"[pretrain] Boring segment failed: {e}")
        return None
    finally:
        if os.path.exists(seg_path):
            os.unlink(seg_path)


async def main():
    parser = argparse.ArgumentParser(description="Pre-train clip scorer on popular clips")
    parser.add_argument("--search", type=str, default=None,
                        help=f"Comma-separated search terms")
    parser.add_argument("--count", type=int, default=5,
                        help="Clips per search term (default: 5)")
    parser.add_argument("--model", type=str, default=str(MODEL_PATH),
                        help=f"Model path (default: {MODEL_PATH})")
    args = parser.parse_args()

    searches = args.search.split(",") if args.search else DEFAULT_SEARCHES

    log.info("=" * 60)
    log.info("ClipCurator Pre-Training")
    log.info("=" * 60)
    log.info(f"Search terms: {len(searches)}")
    log.info(f"Clips per term: {args.count}")
    log.info("")

    scorer = ClipScorer(model_path=args.model)
    log.info(f"Current model: {scorer.stats()}")

    # ─── Phase 1: Download popular clips ────────────────────────────────
    log.info("")
    log.info("Phase 1: Downloading popular clips from YouTube...")

    all_clips = []
    for term in searches:
        clips = await search_and_download_clips(term.strip(), args.count)
        all_clips.extend(clips)

    log.info(f"Downloaded {len(all_clips)} clips total")

    if not all_clips:
        log.error("No clips downloaded — check internet / yt-dlp")
        return

    # ─── Phase 2: Train as "accept" ─────────────────────────────────────
    log.info("")
    log.info("Phase 2: Extracting features + training as 'accept'...")

    positive = 0
    for i, clip in enumerate(all_clips):
        log.info(f"  [{i+1}/{len(all_clips)}] {clip['title'][:50]}")
        try:
            segments = run_whisper_on_clip(clip["path"])
            if not segments:
                continue
            features = extract_features(clip["path"], segments)
            scorer.train(features, label=0)
            positive += 1
            log.info(f"    ✓ audio={features['audioScore']:.2f} motion={features['motionScore']:.2f}")
        except Exception as e:
            log.warning(f"    ✗ {e}")
        try:
            os.unlink(clip["path"])
        except Exception:
            pass

    # ─── Phase 3: Train boring segments as "reject_bad" ─────────────────
    log.info("")
    log.info("Phase 3: Training boring segments as 'reject_bad'...")

    negative = 0
    for term in searches[:3]:
        try:
            clips = await search_and_download_clips(
                term.replace("clips", "full stream").replace("best moments", "stream"),
                count=2,
            )
            for clip in clips:
                if clip["duration"] < 120:
                    continue
                for _ in range(2):
                    features = extract_boring_segment(clip["path"], clip["duration"])
                    if features:
                        scorer.train(features, label=1)
                        negative += 1
                        log.info(f"    ✓ boring segment trained (reject_bad)")
                try:
                    os.unlink(clip["path"])
                except Exception:
                    pass
        except Exception as e:
            log.warning(f"  {e}")

    # ─── Save ───────────────────────────────────────────────────────────
    scorer.save()

    log.info("")
    log.info("=" * 60)
    log.info("Pre-training complete!")
    log.info("=" * 60)
    log.info(f"Positive (accept):     {positive}")
    log.info(f"Negative (reject_bad): {negative}")
    log.info(f"Total training:        {scorer.stats()['training_count']}")
    log.info(f"Model saved to:        {args.model}")
    log.info("")
    log.info("The NN now has a baseline. Your reviews will fine-tune it further.")


if __name__ == "__main__":
    asyncio.run(main())
