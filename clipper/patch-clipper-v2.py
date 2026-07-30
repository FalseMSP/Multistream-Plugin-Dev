#!/usr/bin/env python3
"""
Patch clipper.py for v2: word-level Whisper + new features + 3-class scoring.
"""

import re
import sys
from pathlib import Path


def patch_clipper(filepath: str):
    fp = Path(filepath)
    content = fp.read_text(encoding="utf-8")
    original = content

    # ─── 1. Add imports ──────────────────────────────────────────────────
    if "from clip_scorer import ClipScorer" not in content:
        insert_after = 'log = logging.getLogger("clipper")'
        scorer_import = '''
# ─── Neural network v2 + feature extractor + YouTube analytics ───────────────
from clip_scorer import ClipScorer
from feature_extractor import extract_motion_score, extract_scene_count, extract_clap_score
from youtube_analytics import fetch_retention_curve, fetch_video_stats

_MODEL_PATH = DATA_DIR / "clip_scorer_model.json"
scorer = ClipScorer(model_path=str(_MODEL_PATH))
log.info(f"[clipper] Neural network v2 initialized — {scorer.stats()}")

_twitch_watcher = None
'''
        content = content.replace(insert_after, insert_after + scorer_import, 1)
        print("  ✓ Added v2 imports")

    # ─── 2. Enable word-level Whisper ────────────────────────────────────
    # Change model.transcribe(video_path, beam_size=1, vad_filter=True)
    # to model.transcribe(video_path, beam_size=1, vad_filter=True, word_timestamps=True)
    old_whisper = "model.transcribe(video_path, beam_size=1, vad_filter=True)"
    new_whisper = "model.transcribe(video_path, beam_size=1, vad_filter=True, word_timestamps=True)"
    if old_whisper in content:
        content = content.replace(old_whisper, new_whisper, 1)
        print("  ✓ Enabled word-level Whisper timestamps")

    # ─── 3. Add feature extraction in analyze_vod ────────────────────────
    # After librosa analysis, extract motion score + scene count + CLAP
    # Find the "log.info(f"[analyze] Starting librosa audio analysis..."" line
    # and insert feature extraction before the merge step
    feature_extraction = '''
    # ─── Extract advanced features (v2) ──────────────────────────────
    log.info(f"[analyze] Extracting advanced features for {source_id}")

    # Motion score — frame difference energy (detects action)
    motion_score = 0.0
    try:
        motion_score = await extract_motion_score(str(local_path), sample_fps=1.0)
    except Exception as e:
        log.warning(f"[analyze] Motion score extraction failed: {e}")

    # Scene count — PySceneDetect (optional, falls back to 0)
    scene_count = 0
    try:
        scene_count = await extract_scene_count(str(local_path))
    except Exception as e:
        log.warning(f"[analyze] Scene detection failed: {e}")

    log.info(f"[analyze] Advanced features: motion={motion_score:.3f}, scenes={scene_count}")

'''

    # Insert before the merge step
    merge_marker = "    # ─── Merge all peaks ──────────────────────────────────────────────"
    if merge_marker in content and "extract_motion_score" not in content.split(merge_marker)[0]:
        content = content.replace(merge_marker, feature_extraction + merge_marker, 1)
        print("  ✓ Added advanced feature extraction")

    # ─── 4. Replace engagement scoring with NN + new features ───────────
    # Add CLAP score per-clip (after the clips are built)
    old_scoring = '''        # Engagement score: weighted blend
        chat_boost = 0
        velocity = peak.get("velocity", 0)
        if velocity > 0:
            chat_boost = min(0.3, velocity / 500)
        engagement = min(0.99, 0.4 + peak["score"] * 0.4 + chat_boost)'''

    new_scoring = '''        # ─── Extract features for the neural network (v2) ──────────────
        velocity = peak.get("velocity", 0)
        audio_score = peak.get("score", 0)
        text_score = min(1.0, len(peak.get("phrase", "")) / 40) if peak.get("phrase") else 0
        clip_transcript_text = transcript_text
        letters_list = [c for c in clip_transcript_text if c.isalpha()]
        caps_ratio_val = (sum(1 for c in letters_list if c.isupper()) / len(letters_list)) if letters_list else 0
        excl_count = clip_transcript_text.count("!")

        # CLAP score (optional — 0 if not installed)
        clap_score_val = 0.0
        try:
            clap_score_val = await extract_clap_score(
                str(local_path), clip_transcript_text, start, end
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
        nn_score = scorer.predict(clip_features)
        engagement = nn_score'''

    if old_scoring in content:
        content = content.replace(old_scoring, new_scoring, 1)
        print("  ✓ Replaced scoring with NN v2 (12 features)")
    else:
        # Try regex
        pattern = r'# Engagement score: weighted blend.*?engagement = min\(0\.99, 0\.4 \+ peak\["score"\] \* 0\.4 \+ chat_boost\)'
        if re.search(pattern, content, re.DOTALL):
            content = re.sub(pattern, new_scoring, content, count=1, flags=re.DOTALL)
            print("  ✓ Replaced scoring with NN v2 (regex match)")
        else:
            print("  ✗ Could not find scoring block — manual patching needed")

    # ─── 5. More aggressive cutting ──────────────────────────────────────
    content = content.replace("top_peaks = merged[:20]", "top_peaks = merged[:8]")
    content = content.replace(
        'if p["time"] - current["time"] < 15:',
        'if p["time"] - current["time"] < 60:',
    )
    print("  ✓ Aggressive cutting: 8 clips max, 60s diversity gap")

    # ─── 6. Update feedback endpoint for 3-class ─────────────────────────
    feedback_endpoint = '''

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
        # (which maps high retention → accept, low → reject_bad)
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
'''

    if "/feedback" not in content:
        startup_marker = "# ─── Startup"
        if startup_marker in content:
            content = content.replace(startup_marker, feedback_endpoint + "\n\n" + startup_marker, 1)
        else:
            content += feedback_endpoint
        print("  ✓ Added 3-class feedback + analytics endpoints")
    else:
        # Replace existing feedback endpoint
        print("  ✓ Feedback endpoint already exists — skipping")

    # ─── 7. Start Twitch watcher ─────────────────────────────────────────
    if "from twitch_watcher import TwitchWatcher" not in content:
        twitch_import = "from twitch_watcher import TwitchWatcher\n"
        # Add to the import block
        content = content.replace(
            "from youtube_analytics import fetch_retention_curve, fetch_video_stats",
            "from youtube_analytics import fetch_retention_curve, fetch_video_stats\n" + twitch_import,
            1,
        )
        print("  ✓ Added Twitch watcher import")

    if "_twitch_watcher" not in content.split("if __name__")[1] if "__main__" in content else True:
        old_main = '''if __name__ == "__main__":
    import uvicorn
    log.info(f"ClipCurator Clipper v2.0 starting on port {CLIPPER_PORT}")'''

        new_main = '''if __name__ == "__main__":
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

    log.info(f"ClipCurator Clipper v2.0 starting on port {CLIPPER_PORT}")'''

        if old_main in content:
            content = content.replace(old_main, new_main, 1)
            print("  ✓ Added Twitch watcher startup")

    if content == original:
        print("\n  No changes made — file may already be patched")
        return False

    fp.write_text(content, encoding="utf-8")
    print("\n  ✓ clipper.py patched for v2")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 patch-clipper-v2.py /path/to/clipper/clipper.py")
        sys.exit(1)
    patch_clipper(sys.argv[1])
