import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { SubtitleStyle } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/clips/[id]/subtitles — return the clip's saved VTT (if any)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const clip = await db.clip.findUnique({ where: { id } });
  if (!clip) {
    return NextResponse.json({ error: "clip not found" }, { status: 404 });
  }
  return NextResponse.json({
    withSubtitles: clip.withSubtitles,
    subtitleVtt: clip.subtitleVtt,
    subtitleStyle: clip.subtitleStyle
      ? (JSON.parse(clip.subtitleStyle) as SubtitleStyle)
      : null,
  });
}

// PUT /api/clips/[id]/subtitles — save edited VTT + style on the clip
// Body: { withSubtitles, subtitleVtt, subtitleStyle }
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const withSubtitles = Boolean(body?.withSubtitles);
    const subtitleVtt: string | null =
      typeof body?.subtitleVtt === "string" ? body.subtitleVtt : null;
    const subtitleStyle: string | null =
      body?.subtitleStyle != null ? JSON.stringify(body.subtitleStyle) : null;

    const clip = await db.clip.update({
      where: { id },
      data: {
        withSubtitles,
        subtitleVtt: withSubtitles ? subtitleVtt : null,
        subtitleStyle: withSubtitles ? subtitleStyle : null,
      },
    });

    return NextResponse.json({ clip });
  } catch (err) {
    console.error("[PUT /api/clips/[id]/subtitles]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
