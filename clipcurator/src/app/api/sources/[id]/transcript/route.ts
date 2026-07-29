import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTranscript, ClipperError } from "@/lib/clipper-client";
import type { SubtitleSegment } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sources/[id]/transcript — return Whisper transcript segments
// for a source, optionally filtered to a time range.
//
// Query params:
//   start — filter segments ending after this time (seconds)
//   end   — filter segments starting before this time (seconds)
//
// Tries the DB first (transcriptJson saved by analyze job). If missing,
// falls back to fetching from the clipper's /transcript/{sourceId} endpoint.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const startQ = url.searchParams.get("start");
    const endQ = url.searchParams.get("end");
    const start = startQ != null ? Number(startQ) : null;
    const end = endQ != null ? Number(endQ) : null;

    const source = await db.streamSource.findUnique({ where: { id } });
    if (!source) {
      return NextResponse.json({ error: "source not found" }, { status: 404 });
    }

    let segments: SubtitleSegment[] = [];

    if (source.transcriptJson) {
      try {
        segments = JSON.parse(source.transcriptJson) as SubtitleSegment[];
      } catch {
        segments = [];
      }
    }

    // Fallback: ask the clipper (it may have transcripts on disk that
    // weren't persisted to DB yet, e.g. if the analyze job crashed mid-way).
    if (segments.length === 0) {
      try {
        const resp = await getTranscript(id);
        segments = resp.segments as SubtitleSegment[];
        // Cache for next time
        if (segments.length > 0) {
          await db.streamSource.update({
            where: { id },
            data: { transcriptJson: JSON.stringify(segments) },
          });
        }
      } catch (err) {
        // If clipper doesn't have it either, return empty
        if (!(err instanceof ClipperError && err.status === 404)) {
          console.warn("[transcript] clipper fetch failed:", err);
        }
      }
    }

    // Filter by time range if provided
    let filtered = segments;
    if (start != null && Number.isFinite(start)) {
      filtered = filtered.filter((s) => s.end > start);
    }
    if (end != null && Number.isFinite(end)) {
      filtered = filtered.filter((s) => s.start < end);
    }

    return NextResponse.json({
      sourceId: id,
      segments: filtered,
    });
  } catch (err) {
    console.error("[GET /api/sources/[id]/transcript]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
