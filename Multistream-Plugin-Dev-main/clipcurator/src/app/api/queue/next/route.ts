import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkApiAuth } from "@/lib/api-auth";
import type { ClipWithSource } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/queue/next — returns the oldest PENDING clip + video URL (auth-gated)
export async function GET(req: NextRequest) {
  const deny = checkApiAuth(req);
  if (deny) return deny;

  const clip = await db.clip.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: { source: true },
  });

  if (!clip) {
    return NextResponse.json({ clip: null, videoUrl: null, queueLength: 0, poster: "" });
  }

  // Mark as IN_REVIEW so it's not handed out twice
  await db.clip.update({
    where: { id: clip.id },
    data: { status: "IN_REVIEW" },
  });

  const queueLength = await db.clip.count({ where: { status: "PENDING" } });

  // Build the video URL: served via Next.js rewrites to the clipper backend
  // Format: /vod/{sourceId}/master.mp4 (proxied through Next.js to avoid CORS)
  const videoUrl = clip.source?.storagePath
    ? `/vod/${clip.source.id}/master.mp4`
    : null;

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
