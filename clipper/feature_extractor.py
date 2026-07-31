"""
Feature extractor — extracts advanced features from video files.

Features:
  1. Motion score — frame-to-frame difference energy (detects action)
  2. Scene count — number of scene changes (PySceneDetect, optional)
  3. CLAP score — audio-text similarity (CLAP model, optional)

All features are optional and fall back gracefully if dependencies
are missing. The motion score + scene count functions are SYNCHRONOUS
(no async) to avoid event loop conflicts when called from both
sync (pretrain) and async (clipper) contexts.
"""

import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

log = logging.getLogger("feature-extractor")


def extract_motion_score(video_path: str, sample_fps: float = 1.0) -> float:
    """
    Extract a motion score (0-1) by sampling frames and computing
    frame-to-frame difference energy.

    SYNCHRONOUS — uses subprocess.run() instead of asyncio.
    Safe to call from both sync and async contexts.

    A high motion score indicates action-packed content (gameplay,
    fast movement). Low score indicates static content (talking head,
    menu screen).
    """
    try:
        import numpy as np

        with tempfile.TemporaryDirectory() as tmpdir:
            # Extract frames at sample_fps using FFmpeg
            # Scale down to 64x36 (tiny) for fast comparison
            cmd = [
                "ffmpeg", "-y",
                "-i", video_path,
                "-vf", f"fps={sample_fps},scale=64:36",
                "-pix_fmt", "gray",
                "-q:v", "2",
                f"{tmpdir}/frame_%06d.jpg",
            ]

            proc = subprocess.run(cmd, capture_output=True, timeout=120)
            if proc.returncode != 0:
                log.warning(f"[motion] FFmpeg failed: {proc.stderr.decode()[-200:]}")
                return 0.0

            # Load frames and compute differences
            frame_files = sorted(Path(tmpdir).glob("frame_*.jpg"))
            if len(frame_files) < 2:
                return 0.0

            frames = []
            for f in frame_files:
                try:
                    from PIL import Image
                    img = Image.open(f).convert("L")
                    frames.append(np.array(img, dtype=np.float32))
                except ImportError:
                    # No PIL — use ffmpeg to convert to raw
                    raw_cmd = [
                        "ffmpeg", "-y",
                        "-i", str(f),
                        "-pix_fmt", "gray",
                        "-f", "rawvideo",
                        "-",
                    ]
                    raw_proc = subprocess.run(raw_cmd, capture_output=True)
                    if raw_proc.returncode == 0:
                        arr = np.frombuffer(raw_proc.stdout, dtype=np.uint8)
                        frames.append(arr.astype(np.float32))

            if len(frames) < 2:
                return 0.0

            # Compute mean absolute difference between consecutive frames
            diffs = []
            for i in range(1, len(frames)):
                if frames[i].shape == frames[i-1].shape:
                    diff = np.abs(frames[i] - frames[i-1])
                    diffs.append(np.mean(diff))

            if not diffs:
                return 0.0

            mean_diff = float(np.mean(diffs))
            # Normalize: 0-50 range maps to 0-1
            motion_score = min(1.0, mean_diff / 50.0)

            log.info(f"[motion] Score: {motion_score:.3f} (mean_diff: {mean_diff:.1f})")
            return motion_score

    except Exception as e:
        log.warning(f"[motion] Extraction failed: {e}")
        return 0.0


def extract_scene_count(video_path: str) -> int:
    """
    Count scene changes using PySceneDetect (optional).
    Returns 0 if PySceneDetect is not installed.

    SYNCHRONOUS — safe to call from any context.
    """
    try:
        from scenedetect import detect, ContentDetector
    except ImportError:
        log.debug("[scenes] PySceneDetect not installed — skipping")
        return 0

    try:
        scenes = detect(video_path, ContentDetector(threshold=27.0))
        scene_count = len(scenes)
        log.info(f"[scenes] Detected {scene_count} scenes")
        return scene_count
    except Exception as e:
        log.warning(f"[scenes] Detection failed: {e}")
        return 0


async def extract_clap_score(
    video_path: str,
    transcript: str,
    clip_start: float,
    clip_end: float,
) -> float:
    """
    Compute CLAP (Contrastive Language-Audio Pretraining) similarity
    score between the clip's audio and an excitement text prompt.

    This one IS async because it loads a large model and does GPU/CPU inference.
    Only called from the async clipper context.

    Returns 0.0 if CLAP is not installed or fails.
    Set CLIPPER_ENABLE_CLAP=false to disable entirely.
    """
    if os.environ.get("CLIPPER_ENABLE_CLAP", "true").lower() == "false":
        return 0.0

    try:
        import torch
        import torchaudio
        from transformers import ClapModel, ClapProcessor
    except ImportError:
        log.debug("[clap] transformers/torch not installed — skipping")
        return 0.0

    try:
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            wav_path = f.name

        duration = clip_end - clip_start
        import asyncio
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y",
            "-ss", str(clip_start),
            "-i", video_path,
            "-t", str(duration),
            "-vn",
            "-ar", "48000",
            "-ac", "1",
            "-acodec", "pcm_s16le",
            wav_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()

        if proc.returncode != 0:
            return 0.0

        # Load CLAP model (cached after first load)
        if not hasattr(extract_clap_score, "_model"):
            log.info("[clap] Loading CLAP model (first time)...")
            extract_clap_score._model = ClapModel.from_pretrained(
                "laion/clap-htsat-unfused"
            )
            extract_clap_score._processor = ClapProcessor.from_pretrained(
                "laion/clap-htsat-unfused"
            )

        model = extract_clap_score._model
        processor = extract_clap_score._processor

        # Load audio
        waveform, sr = torchaudio.load(wav_path)
        if sr != 48000:
            waveform = torchaudio.functional.resample(waveform, sr, 48000)

        prompts = [
            "exciting viral gaming moment with laughter and cheering",
            "boring uneventful static gameplay",
        ]

        inputs = processor(
            text=prompts,
            audios=waveform.numpy()[0],
            return_tensors="pt",
            sampling_rate=48000,
        )

        with torch.no_grad():
            outputs = model(**inputs)
            logits = outputs.logits_per_audio[0]
            probs = torch.softmax(logits, dim=0)
            exciting_prob = float(probs[0])

        log.info(f"[clap] Score: {exciting_prob:.3f}")
        return exciting_prob

    except Exception as e:
        log.warning(f"[clap] Extraction failed: {e}")
        return 0.0
    finally:
        try:
            os.unlink(wav_path)
        except Exception:
            pass
