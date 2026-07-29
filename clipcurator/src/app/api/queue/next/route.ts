import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { ClipWithSource } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/queue/next — returns the oldest PENDING clip + its video URL.
//
// The video URL is the clip's source storagePath (e.g. /vods/{sourceId}/master.mp4).
// next.config.ts rewrites /vod/:path* → http://localhost:8100/vod/:path*,
// so the browser loads the real VOD file served by the Python clipper.
export async function GET() {
  const clip = await db.clip.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: { source: true, backingTrack: true },
  });

  if (!clip) {
    return NextResponse.json({
      clip: null,
      videoUrl: null,
      queueLength: 0,
      poster: "",
    });
  }

  // Mark as IN_REVIEW so it's not handed out twice in quick succession.
  await db.clip.update({
    where: { id: clip.id },
    data: { status: "IN_REVIEW" },
  });

  const queueLength = await db.clip.count({ where: { status: "PENDING" } });

  // Real VOD file path — served by clipper.py via the next.config.ts rewrite.
  const videoUrl = clip.source?.storagePath ?? null;
  const poster = clip.thumbnailUrl ?? "";

  const payload: {
    clip: ClipWithSource | null;
    videoUrl: string | null;
    queueLength: number;
    poster: string;
  } = {
    clip: {
      ...clip,
      status: "IN_REVIEW" as const,
      source: clip.source ?? null,
    },
    videoUrl,
    queueLength,
    poster,
  };

  return NextResponse.json(payload);
}
