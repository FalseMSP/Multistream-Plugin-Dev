import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { renderClip } from "@/lib/clipper-client";
import type { SubtitleStyle } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/clips/[id]/render-preview — render a clip on-demand without
// publishing. Used by the "Download" button in the review queue.
//
// Body: same shape as the render options:
//   finalStart, finalEnd, withSubtitles, subtitleVtt, subtitleStyle,
//   withBackingTrack, backingTrackId, backingTrackVolume
//
// Returns: { storagePath } — the client then opens /api/clips/[id]/download
// in a new tab to actually download the file.
//
// This is a synchronous render: the client waits for FFmpeg to finish
// (5-30s for a 60s clip). For longer clips, consider adding a job-queue
// variant — but for download UX, synchronous is simpler.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const finalStart = Number(body?.finalStart);
    const finalEnd = Number(body?.finalEnd);
    if (!Number.isFinite(finalStart) || !Number.isFinite(finalEnd)) {
      return NextResponse.json(
        { error: "finalStart and finalEnd must be numbers" },
        { status: 400 }
      );
    }
    if (finalEnd - finalStart < 1) {
      return NextResponse.json(
        { error: "clip must be at least 1 second long" },
        { status: 400 }
      );
    }

    const clip = await db.clip.findUnique({
      where: { id },
      include: { source: true, backingTrack: true },
    });
    if (!clip) {
      return NextResponse.json({ error: "clip not found" }, { status: 404 });
    }
    if (!clip.source?.storagePath) {
      return NextResponse.json(
        { error: "source VOD not downloaded yet" },
        { status: 409 }
      );
    }

    // Resolve backing track if requested
    const withBackingTrack = Boolean(body?.withBackingTrack);
    let backingTrackPath: string | undefined;
    if (withBackingTrack) {
      const btId =
        typeof body?.backingTrackId === "string" ? body.backingTrackId : clip.backingTrackId;
      if (btId) {
        const bt =
          clip.backingTrack ??
          (await db.backingTrack.findUnique({ where: { id: btId } }));
        if (bt) backingTrackPath = bt.storagePath;
      }
      if (!backingTrackPath) {
        return NextResponse.json(
          { error: "backing track selected but not found" },
          { status: 400 }
        );
      }
    }

    // Subtitle options
    const withSubtitles = Boolean(body?.withSubtitles);
    const subtitleVtt: string | undefined =
      typeof body?.subtitleVtt === "string" ? body.subtitleVtt : undefined;
    const subtitleStyle: SubtitleStyle | undefined = body?.subtitleStyle;

    // Call clipper synchronously
    const result = await renderClip({
      clipId: id,
      sourceStoragePath: clip.source.storagePath,
      finalStartSec: finalStart,
      finalEndSec: finalEnd,
      withSubtitles,
      subtitleVtt,
      subtitleStyle,
      withBackingTrack,
      backingTrackPath,
      backingTrackVolume:
        typeof body?.backingTrackVolume === "number"
          ? Math.min(1, Math.max(0, body.backingTrackVolume))
          : 0.3,
    });

    // Persist the storagePath on the clip so /download works later
    await db.clip.update({
      where: { id },
      data: {
        storagePath: result.storagePath,
        finalStartSec: finalStart,
        finalEndSec: finalEnd,
        withSubtitles,
        subtitleVtt: withSubtitles ? subtitleVtt ?? null : null,
        subtitleStyle:
          withSubtitles && subtitleStyle
            ? JSON.stringify(subtitleStyle)
            : null,
        withBackingTrack,
        backingTrackId: withBackingTrack
          ? (body?.backingTrackId ?? clip.backingTrackId)
          : null,
      },
    });

    return NextResponse.json({ storagePath: result.storagePath });
  } catch (err) {
    console.error("[POST /api/clips/[id]/render-preview]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
