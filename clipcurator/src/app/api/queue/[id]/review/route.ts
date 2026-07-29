import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueueRenderFinalClip } from "@/lib/queue";
import type { Decision, SubtitleStyle } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/queue/[id]/review — accept, reject, or download a clip
//
// Body:
//   decision: "A" | "B" | "REJECT" | "DOWNLOAD"
//   finalStart: number
//   finalEnd: number
//   withSubtitles: boolean
//   subtitleVtt?: string  (WebVTT content)
//   subtitleStyle?: SubtitleStyle
//   withBackingTrack: boolean
//   backingTrackId?: string
//   backingTrackVolume?: number
//
// Behavior:
//   A / B  → save options, mark APPROVED_*, enqueue render → publish
//   REJECT → mark rejected, no render
//   DOWNLOAD → save options, mark RENDERED, enqueue render only (no publish)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const decision = body?.decision as Decision | "DOWNLOAD" | undefined;
    const finalStart = Number(body?.finalStart);
    const finalEnd = Number(body?.finalEnd);

    // Subtitle options
    const withSubtitles = Boolean(body?.withSubtitles);
    const subtitleVtt: string | undefined =
      typeof body?.subtitleVtt === "string" ? body.subtitleVtt : undefined;
    const subtitleStyle: SubtitleStyle | undefined =
      body?.subtitleStyle ?? undefined;

    // Backing track options
    const withBackingTrack = Boolean(body?.withBackingTrack);
    const backingTrackId: string | null =
      typeof body?.backingTrackId === "string" ? body.backingTrackId : null;
    const backingTrackVolume =
      typeof body?.backingTrackVolume === "number"
        ? Math.min(1, Math.max(0, body.backingTrackVolume))
        : 0.3;

    if (
      !decision ||
      !["A", "B", "REJECT", "DOWNLOAD"].includes(decision)
    ) {
      return NextResponse.json({ error: "invalid decision" }, { status: 400 });
    }
    if (!Number.isFinite(finalStart) || !Number.isFinite(finalEnd)) {
      return NextResponse.json(
        { error: "finalStart and finalEnd must be numbers" },
        { status: 400 }
      );
    }
    if (finalEnd - finalStart < 30) {
      return NextResponse.json(
        { error: "clip must be at least 30 seconds long" },
        { status: 400 }
      );
    }

    const clip = await db.clip.findUnique({ where: { id } });
    if (!clip) {
      return NextResponse.json({ error: "clip not found" }, { status: 404 });
    }

    if (decision === "REJECT") {
      const updated = await db.clip.update({
        where: { id },
        data: {
          status: "REJECTED",
          reviewerId: null,
          reviewedAt: new Date(),
          finalStartSec: finalStart,
          finalEndSec: finalEnd,
          publishedToChannelId: null,
        },
      });
      return NextResponse.json({ clip: updated });
    }

    // Validate channel config for A/B decisions
    if (decision === "A" || decision === "B") {
      const channelId = decision === "A" ? "CHANNEL_A" : "CHANNEL_B";
      const channel = await db.channel.findUnique({
        where: { id: channelId },
      });
      if (!channel || !channel.isConfigured) {
        return NextResponse.json(
          {
            error: `${channelId} is not configured. Visit Settings to authorize it.`,
          },
          { status: 400 }
        );
      }
    }

    // Save post-processing options on the clip
    const newStatus =
      decision === "DOWNLOAD"
        ? "RENDERED"
        : decision === "A"
          ? "APPROVED_A"
          : "APPROVED_B";
    const channelId =
      decision === "A"
        ? "CHANNEL_A"
        : decision === "B"
          ? "CHANNEL_B"
          : null;

    const updated = await db.clip.update({
      where: { id },
      data: {
        status: newStatus,
        reviewerId: null,
        reviewedAt: new Date(),
        finalStartSec: finalStart,
        finalEndSec: finalEnd,
        publishedToChannelId: channelId,
        withSubtitles,
        subtitleVtt: withSubtitles ? subtitleVtt ?? null : null,
        subtitleStyle: withSubtitles && subtitleStyle
          ? JSON.stringify(subtitleStyle)
          : null,
        withBackingTrack,
        backingTrackId: withBackingTrack ? backingTrackId : null,
        backingTrackVolume,
      },
    });

    // Enqueue render (which auto-enqueues publish if A/B)
    enqueueRenderFinalClip(clip.id);

    return NextResponse.json({ clip: updated });
  } catch (err) {
    console.error("[POST /api/queue/[id]/review]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
