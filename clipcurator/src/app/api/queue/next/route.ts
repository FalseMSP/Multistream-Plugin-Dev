import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pickSampleVod } from "@/lib/pipeline";
import type { ClipWithSource } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/queue/next — returns the oldest PENDING clip + its presigned video URL
export async function GET() {
  const clip = await db.clip.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: { source: true },
  });

  if (!clip) {
    return NextResponse.json({ clip: null, videoUrl: null, queueLength: 0 });
  }

  // Mark as IN_REVIEW so it's not handed out twice in quick succession.
  await db.clip.update({
    where: { id: clip.id },
    data: { status: "IN_REVIEW" },
  });

  const queueLength = await db.clip.count({ where: { status: "PENDING" } });

  // Resolve the real playable video URL from the sample VOD mapping
  const sample = pickSampleVod(clip.source?.url ?? "");
  const videoUrl = sample.url;

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
    poster: sample.poster,
  };

  return NextResponse.json(payload);
}
