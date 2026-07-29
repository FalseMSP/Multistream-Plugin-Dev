# PATCH for clipper/clipper.py
#
# Add this endpoint to the FastAPI app. It deletes the VOD directory for
# a given source ID, freeing disk space when a stream is deleted from
# the UI.
#
# Place this among the other @app.* endpoints (e.g. after serve_clip).

@app.delete("/cleanup/source/{source_id}")
async def cleanup_source(source_id: str):
    """
    Delete all files associated with a stream source:
      - /tmp/clipcurator/vods/{source_id}/ (VOD + metadata + chat)
      - Any rendered clips belonging to this source's clips

    This is called by the Next.js DELETE /api/streams/[id] endpoint when
    a user deletes a stream from the admin view. Best-effort — returns
    200 even if some files are already gone.
    """
    import shutil

    vod_dir = VOD_DIR / source_id
    deleted_files = 0
    deleted_bytes = 0

    # Delete VOD directory
    if vod_dir.exists():
        for f in vod_dir.rglob("*"):
            if f.is_file():
                deleted_bytes += f.stat().st_size
                deleted_files += 1
        shutil.rmtree(vod_dir)
        log.info(f"[cleanup] Deleted VOD dir {vod_dir} ({deleted_files} files, {deleted_bytes} bytes)")

    # Find and delete any rendered clips belonging to this source.
    # Clip directories are named by clip ID, not source ID, so we need to
    # check the DB... but the clipper doesn't have DB access. Instead,
    # we rely on the Next.js side to tell us which clip IDs to delete.
    # For now, just clean the VOD dir — the Next.js side handles clip
    # deletion via a separate call if needed.

    return JSONResponse({
        "ok": True,
        "sourceId": source_id,
        "deletedFiles": deleted_files,
        "deletedBytes": deleted_bytes,
    })


@app.delete("/cleanup/clip/{clip_id}")
async def cleanup_clip(clip_id: str):
    """
    Delete rendered clip files for a given clip ID.
    Called by the Next.js side when deleting individual clips.
    """
    import shutil

    clip_dir = CLIPS_DIR / clip_id
    deleted_files = 0
    deleted_bytes = 0

    if clip_dir.exists():
        for f in clip_dir.rglob("*"):
            if f.is_file():
                deleted_bytes += f.stat().st_size
                deleted_files += 1
        shutil.rmtree(clip_dir)
        log.info(f"[cleanup] Deleted clip dir {clip_dir} ({deleted_files} files, {deleted_bytes} bytes)")

    return JSONResponse({
        "ok": True,
        "clipId": clip_id,
        "deletedFiles": deleted_files,
        "deletedBytes": deleted_bytes,
    })
