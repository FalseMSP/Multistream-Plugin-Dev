#!/usr/bin/env python3
"""
Patch clipper.py to integrate the neural network scorer + feedback endpoint
+ Twitch auto-ingest watcher.

Usage:
    python3 patch-clipper.py /path/to/clipper/clipper.py
"""

import re
import sys
from pathlib import Path


def patch_clipper(filepath: str):
    fp = Path(filepath)
    content = fp.read_text(encoding="utf-8")
    original = content

    # ─── 1. Add imports for clip_scorer + twitch_watcher ──────────────────
    # Insert after the existing "from dotenv import load_dotenv" line
    if "from clip_scorer import ClipScorer" not in content:
        # Find a good insertion point — after the logging setup
        insert_after = 'log = logging.getLogger("clipper")'
        if insert_after in content:
            scorer_import = '''
# ─── Neural network clip scorer + Twitch auto-ingest ─────────────────────────
from clip_scorer import ClipScorer
from twitch_watcher import TwitchWatcher

# Initialize the neural network scorer (loads saved weights if available)
_MODEL_PATH = DATA_DIR / "clip_scorer_model.json"
scorer = ClipScorer(model_path=str(_MODEL_PATH))
log.info(f"[clipper] Neural network scorer initialized — {scorer.stats()}")

# Twitch auto-ingest watcher (started in __main__)
_twitch_watcher = None
'''
            content = content.replace(
                insert_after,
                insert_after + scorer_import,
                1,
            )
            print("  ✓ Added clip_scorer + twitch_watcher imports")
        else:
            print("  ✗ Could not find insertion point for imports")

    # ─── 2. Replace the engagement scoring in analyze_vod ─────────────────
    # Find the "engagement = min(0.99, 0.4 + peak["score"] * 0.4 + chat_boost)" line
    # and replace with neural network scoring
    old_scoring = '''        # Engagement score: weighted blend
        chat_boost = 0
        velocity = peak.get("velocity", 0)
        if velocity > 0:
            chat_boost = min(0.3, velocity / 500)
        engagement = min(0.99, 0.4 + peak["score"] * 0.4 + chat_boost)'''

    new_scoring = '''        # ─── Extract features for the neural network ──────────────────
        velocity = peak.get("velocity", 0)
        audio_score = peak.get("score", 0)
        text_score = 0
        if peak.get("phrase"):
            text_score = min(1.0, len(peak["phrase"]) / 40)
        # Count caps + exclamations from transcript
        clip_transcript = transcript_text
        letters = [c for c in clip_transcript if c.isalpha()]
        caps_ratio = (sum(1 for c in letters if c.isupper()) / len(letters)) if letters else 0
        excl_count = clip_transcript.count("!")

        # Score with the neural network
        clip_features = {
            "chatVelocity": velocity,
            "audioScore": audio_score,
            "textScore": text_score,
            "capsRatio": caps_ratio,
            "exclamationCount": excl_count,
            "laughterScore": peak.get("laughter_score", 0),
            "duration": end - start,
        }
        nn_score = scorer.predict(clip_features)
        engagement = nn_score'''

    if old_scoring in content:
        content = content.replace(old_scoring, new_scoring, 1)
        print("  ✓ Replaced engagement scoring with neural network")
    else:
        print("  ✗ Could not find engagement scoring block — trying alternate pattern")
        # Try a more flexible match
        pattern = r'# Engagement score: weighted blend\s*\n\s*chat_boost = 0\s*\n\s*velocity = peak\.get\("velocity", 0\)\s*\n\s*if velocity > 0:\s*\n\s*chat_boost = min\(0\.3, velocity / 500\)\s*\n\s*engagement = min\(0\.99, 0\.4 \+ peak\["score"\] \* 0\.4 \+ chat_boost\)'
        if re.search(pattern, content):
            content = re.sub(pattern, new_scoring, content, count=1)
            print("  ✓ Replaced engagement scoring (regex match)")
        else:
            print("  ✗ Could not find engagement scoring — manual patching needed")

    # ─── 3. More aggressive cutting: reduce cap from 20 to 8 ──────────────
    content = content.replace("top_peaks = merged[:20]", "top_peaks = merged[:8]")
    print("  ✓ Reduced max clips from 20 to 8")

    # ─── 4. Add diversity penalty (merge peaks within 60s, not 15s) ───────
    content = content.replace(
        'if p["time"] - current["time"] < 15:',
        'if p["time"] - current["time"] < 60:',
    )
    print("  ✓ Increased diversity gap from 15s to 60s")

    # ─── 5. Add /feedback endpoint ────────────────────────────────────────
    feedback_endpoint = '''

# ─── Feedback endpoint (for neural network online learning) ──────────────────

class FeedbackRequest(BaseModel):
    clipId: str
    sourceId: str
    accepted: bool  # True = published, False = rejected
    features: dict  # {chatVelocity, audioScore, textScore, capsRatio, ...}


@app.post("/feedback")
async def api_feedback(req: FeedbackRequest):
    """Receive review feedback and train the neural network."""
    try:
        scorer.train(req.features, req.accepted)
        stats = scorer.stats()
        log.info(
            f"[feedback] Trained on clip {req.clipId} "
            f"(accepted={req.accepted}) — total training: {stats['training_count']}"
        )
        return JSONResponse({"ok": True, "stats": stats})
    except Exception as e:
        log.error(f"[feedback] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/scorer/stats")
async def api_scorer_stats():
    """Return neural network training statistics."""
    return JSONResponse(scorer.stats())
'''

    if "/feedback" not in content:
        # Insert before the Startup section
        startup_marker = "# ─── Startup"
        if startup_marker in content:
            content = content.replace(
                startup_marker,
                feedback_endpoint + "\n\n" + startup_marker,
                1,
            )
            print("  ✓ Added /feedback endpoint")
        else:
            content += feedback_endpoint
            print("  ✓ Added /feedback endpoint (appended)")

    # ─── 6. Start Twitch watcher in __main__ ──────────────────────────────
    if "_twitch_watcher" not in content.split("if __name__")[1]:
        old_main = '''if __name__ == "__main__":
    import uvicorn
    log.info(f"ClipCurator Clipper v2.0 starting on port {CLIPPER_PORT}")'''

        new_main = '''if __name__ == "__main__":
    import uvicorn

    # Start Twitch auto-ingest watcher in background
    _twitch_watcher = TwitchWatcher()

    async def _startup():
        await _twitch_watcher.start()

    # Schedule watcher in uvicorn's event loop
    import threading
    def _run_watcher():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(_twitch_watcher.start())

    watcher_thread = threading.Thread(target=_run_watcher, daemon=True)
    watcher_thread.start()
    log.info("[clipper] Twitch auto-ingest watcher started in background")

    log.info(f"ClipCurator Clipper v2.0 starting on port {CLIPPER_PORT}")'''

        if old_main in content:
            content = content.replace(old_main, new_main, 1)
            print("  ✓ Added Twitch watcher startup")
        else:
            print("  ✗ Could not find __main__ block — Twitch watcher not started")

    if content == original:
        print("\n  No changes made — file may already be patched")
        return False

    fp.write_text(content, encoding="utf-8")
    print("\n  ✓ clipper.py patched successfully")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 patch-clipper.py /path/to/clipper/clipper.py")
        sys.exit(1)
    patch_clipper(sys.argv[1])
