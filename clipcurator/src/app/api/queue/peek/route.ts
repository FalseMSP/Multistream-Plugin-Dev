import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/queue/peek — returns the next PENDING clip + its video URL,
// WITHOUT marking it as IN_REVIEW. Used by the client to preload/buffer
// the next clip's video while the user reviews the current one.
//
// This is separate from /api/queue/next (which DOES mark as IN_REVIEW)
// so that peeking doesn't affect queue state.
export async function GET() {
  const clip = await db.clip.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: { source: true },
  });

  if (!clip) {
    return NextResponse.json({
      clip: null,
      videoUrl: null,
      poster: "",
    });
  }

  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/clipcurator";
  const storagePath = clip.source?.storagePath ?? null;
  const videoUrl = storagePath ? `${basePath}${storagePath}` : null;
  const poster = clip.thumbnailUrl ?? "";

  return NextResponse.json({
    clip: {
      ...clip,
      source: clip.source ?? null,
    },
    videoUrl,
    poster,
  });
}
