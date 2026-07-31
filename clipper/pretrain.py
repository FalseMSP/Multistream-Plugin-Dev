#!/usr/bin/env python3
"""
pretrain.py v3 — Pre-train the clip scorer neural network on popular streamer clips.

v3 fixes:
  - Fixed extract_motion_score — now uses the SYNC version (feature_extractor.py was updated)
  - Improved audio score extraction (dynamic range instead of peak ratio)
  - Added aspect ratio detection (vertical vs horizontal)
  - Shorts-focused search terms
"""

import argparse
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from clip_scorer import ClipScorer
# Import the SYNC versions (no longer async)
from feature_extractor import extract_motion_score, extract_scene_count

import logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pretrain")

DATA_DIR = Path(os.environ.get("CLIPPER_DATA_DIR", "/tmp/clipcurator"))
PRETRAIN_DIR = DATA_DIR / "pretrain"
PRETRAIN_DIR.mkdir(parents=True, exist_ok=True)
MODEL_PATH = DATA_DIR / "clip_scorer_model.json"

DEFAULT_SEARCHES = [
    "ishowspeed shorts",
    "xqc shorts funny",
    "kai cenat shorts",
    "twitch clips shorts viral",
    "streamer funny shorts",
    "poki shorts",
    "asmongold shorts react",
    "critikal shorts funny",
]

_VENV_BIN = Path(sys.executable).parent
YTDLP_BIN = str(_VENV_BIN / "yt-dlp")
if not Path(YTDLP_BIN).exists():
    YTDLP_BIN = "yt-dlp"

CLIPPER_DIR = Path(__file__).resolve().parent
COOKIES_FILE = CLIPPER_DIR / "cookies.txt"


async def search_and_download_clips(search_term: str, count: int = 5) -> list:
    clips = []
    out_template = str(PRETRAIN_DIR / "%(id)s.%(ext)s")
    search_query = f"ytsearch{count}:{search_term}"

    cmd = [
        YTDLP_BIN,
        "--format", "best",
        "--output", out_template,
        "--no-playlist",
        "--no-warnings",
        "--no-check-certificates",
        "--write-info-json",
        "--no-progress",
    ]

    if COOKIES_FILE.exists():
        cmd.extend(["--cookies", str(COOKIES_FILE)])

    cmd.append(search_query)

    log.info(f"[pretrain] Searching: '{search_term}' (top {count})")
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    if proc.returncode != 0:
        log.warning(f"[pretrain] Search failed: {stderr.decode()[-200:]}")
        return []

    for info_file in PRETRAIN_DIR.glob("*.info.json"):
        try:
            meta = json.loads(info_file.read_text())
            clip_id = meta.get("id", "")
            for ext in [".mp4", ".webm", ".mkv", ".m4a"]:
                path = PRETRAIN_DIR / f"{clip_id}{ext}"
                if path.exists():
                    clips.append({
                        "path": str(path),
                        "title": meta.get("title", ""),
                        "duration": meta.get("duration", 0),
                        "view_count": meta.get("view_count", 0),
                        "width": meta.get("width", 0),
                        "height": meta.get("height", 0),
                    })
                    break
            info_file.unlink()
        except Exception:
            continue

    log.info(f"[pretrain] Downloaded {len(clips)} clips")
    return clips


def run_whisper_on_clip(video_path: str) -> list:
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


def extract_audio_score(video_path: str) -> float:
    """Audio excitement score via dynamic range (loud peaks vs median)."""
    try:
        import librosa
        import numpy as np
        import subprocess

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            wav_path = f.name

        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", video_path, "-vn",
             "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", wav_path],
            capture_output=True, timeout=60,
        )
        if proc.returncode != 0:
            return 0.0

        y, sr = librosa.load(wav_path, sr=16000, mono=True)
        os.unlink(wav_path)

        hop = int(sr * 0.5)
        rms = librosa.feature.rms(y=y, hop_length=hop)[0]
        rms_db = librosa.amplitude_to_db(rms, ref=np.max)

        p95 = float(np.percentile(rms_db, 95))
        p50 = float(np.percentile(rms_db, 50))
        dynamic_range = p95 - p50

        return min(1.0, max(0.0, dynamic_range / 15.0))
    except Exception as e:
        log.debug(f"[pretrain] Audio failed: {e}")
        return 0.0


def detect_aspect_ratio(video_path: str) -> tuple:
    try:
        import subprocess
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_streams", video_path],
            capture_output=True, timeout=10,
        )
        if proc.returncode == 0:
            data = json.loads(proc.stdout.decode())
            for stream in data.get("streams", []):
                if stream.get("codec_type") == "video":
                    return (int(stream.get("width", 0)), int(stream.get("height", 0)))
    except Exception:
        pass
    return (0, 0)


def extract_features(clip_path: str, whisper_segments: list, clip_meta: dict = None) -> dict:
    # Audio score (dynamic range — actually returns non-zero for exciting clips)
    audio_score = extract_audio_score(clip_path)

    # Motion score — NOW SYNC, just call it directly (no asyncio.run needed!)
    motion_score = extract_motion_score(clip_path, sample_fps=1.0)

    # Scene count (also sync now)
    scene_count = extract_scene_count(clip_path)

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

    duration = clip_meta.get("duration", 60) if clip_meta else 60

    w, h = detect_aspect_ratio(clip_path)
    is_vertical = w > 0 and h > 0 and w < h
    if clip_meta:
        clip_meta["is_vertical"] = is_vertical
        clip_meta["aspect_ratio"] = f"{w}x{h}"

    return {
        "chatVelocity": 0,
        "audioScore": audio_score,
        "textScore": text_score,
        "capsRatio": caps_ratio,
        "exclamationCount": excl_count,
        "laughterScore": 0,
        "duration": duration,
        "motionScore": motion_score,
        "sceneCount": scene_count,
        "clapScore": 0,
        "llmViralScore": 0,
        "openingRetention": 0,
    }


def extract_boring_segment(video_path: str, duration: float) -> dict:
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
        log.debug(f"[pretrain] Boring failed: {e}")
        return None
    finally:
        if os.path.exists(seg_path):
            os.unlink(seg_path)


async def main():
    parser = argparse.ArgumentParser(description="Pre-train clip scorer v3")
    parser.add_argument("--search", type=str, default=None)
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--model", type=str, default=str(MODEL_PATH))
    args = parser.parse_args()

    searches = args.search.split(",") if args.search else DEFAULT_SEARCHES

    log.info("=" * 60)
    log.info("ClipCurator Pre-Training v3")
    log.info("=" * 60)
    log.info(f"Search terms: {len(searches)}, clips per term: {args.count}")
    log.info("")

    scorer = ClipScorer(model_path=args.model)
    log.info(f"Current model: {scorer.stats()}")

    log.info("\nPhase 1: Downloading popular clips...")
    all_clips = []
    for term in searches:
        clips = await search_and_download_clips(term.strip(), args.count)
        all_clips.extend(clips)

    log.info(f"Downloaded {len(all_clips)} clips total")
    if not all_clips:
        log.error("No clips downloaded — check internet / yt-dlp / cookies")
        return

    log.info("\nPhase 2: Extracting features + training as 'accept'...")
    positive = 0
    vertical_count = 0
    for i, clip in enumerate(all_clips):
        log.info(f"  [{i+1}/{len(all_clips)}] {clip['title'][:50]}")
        try:
            segments = run_whisper_on_clip(clip["path"])
            if not segments:
                continue
            features = extract_features(clip["path"], segments, clip)
            scorer.train(features, label=0)
            positive += 1
            if clip.get("is_vertical"):
                vertical_count += 1
            log.info(
                f"    ✓ [{'VERT' if clip.get('is_vertical') else 'HORZ'}] "
                f"audio={features['audioScore']:.2f} "
                f"motion={features['motionScore']:.2f} "
                f"text={features['textScore']:.2f} "
                f"scenes={features['sceneCount']}"
            )
        except Exception as e:
            log.warning(f"    ✗ {e}")
        try:
            os.unlink(clip["path"])
        except Exception:
            pass

    log.info("\nPhase 3: Training boring segments as 'reject_bad'...")
    negative = 0
    for term in searches[:3]:
        try:
            clips = await search_and_download_clips(
                term.replace("shorts", "full stream").replace("clips", "stream"),
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
                        log.info(f"    ✓ boring segment trained")
                try:
                    os.unlink(clip["path"])
                except Exception:
                    pass
        except Exception as e:
            log.warning(f"  {e}")

    scorer.save()

    log.info("\n" + "=" * 60)
    log.info("Pre-training complete!")
    log.info("=" * 60)
    log.info(f"Positive (accept):     {positive}")
    log.info(f"Negative (reject_bad): {negative}")
    log.info(f"Vertical clips:        {vertical_count}/{positive}")
    log.info(f"Total training:        {scorer.stats()['training_count']}")
    log.info(f"Model saved to:        {args.model}")


if __name__ == "__main__":
    asyncio.run(main())
