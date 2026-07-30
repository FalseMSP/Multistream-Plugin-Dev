import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueueRenderFinalClip } from "@/lib/queue";
import type { Decision, SubtitleStyle } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/queue/[id]/review — accept, reject, or download a clip
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

    const withSubtitles = Boolean(body?.withSubtitles);
    const subtitleVtt: string | undefined =
      typeof body?.subtitleVtt === "string" ? body.subtitleVtt : undefined;
    const subtitleStyle: SubtitleStyle | undefined = body?.subtitleStyle ?? undefined;

    const withBackingTrack = Boolean(body?.withBackingTrack);
    const backingTrackId: string | null =
      typeof body?.backingTrackId === "string" ? body.backingTrackId : null;
    const backingTrackVolume =
      typeof body?.backingTrackVolume === "number"
        ? Math.min(1, Math.max(0, body.backingTrackVolume))
        : 0.3;

    if (!decision || !["A", "B", "REJECT", "DOWNLOAD"].includes(decision)) {
      return NextResponse.json({ error: "invalid decision" }, { status: 400 });
    }
    if (!Number.isFinite(finalStart) || !Number.isFinite(finalEnd)) {
      return NextResponse.json({ error: "finalStart and finalEnd must be numbers" }, { status: 400 });
    }
    if (finalEnd - finalStart < 30) {
      return NextResponse.json({ error: "clip must be at least 30 seconds long" }, { status: 400 });
    }

    const clip = await db.clip.findUnique({
      where: { id },
      include: { source: true },
    });
    if (!clip) {
      return NextResponse.json({ error: "clip not found" }, { status: 404 });
    }

    // ─── Send feedback to the neural network ──────────────────────────
    // This trains the clip scorer on the user's accept/reject decision.
    // We do this BEFORE updating the clip status so we can extract features
    // from the current state.
    if (decision === "REJECT" || decision === "A" || decision === "B") {
      try {
        const clipperUrl = process.env.CLIPPER_URL || "http://localhost:8100";
        // Extract features from the clip's data (mirrors what the clipper
        // extracted during analysis)
        const transcript = clip.transcript ?? "";
        const letters = transcript.split("").filter((c) => c.isalpha());
        const capsRatio = letters.length > 0
          ? letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length / letters.length
          : 0;

        await fetch(`${clipperUrl}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clipId: clip.id,
            sourceId: clip.sourceId,
            accepted: decision !== "REJECT",
            features: {
              chatVelocity: clip.chatVelocity ?? 0,
              audioScore: clip.engagementScore ?? 0,  // approximation
              textScore: clip.peakPhrase ? Math.min(1, clip.peakPhrase.length / 40) : 0,
              capsRatio: capsRatio,
              exclamationCount: (transcript.match(/!/g) || []).length,
              laughterScore: 0,  // not stored per-clip in DB
              duration: finalEnd - finalStart,
            },
          }),
          signal: AbortSignal.timeout(5000),
        });
        console.log(`[review] Feedback sent to neural network (accepted=${decision !== "REJECT"})`);

        // Also store in DB for audit/future retraining
        await db.clipReviewFeedback.create({
          data: {
            clipId: clip.id,
            sourceId: clip.sourceId,
            accepted: decision !== "REJECT",
            engagementScore: clip.engagementScore,
            features: JSON.stringify({
              chatVelocity: clip.chatVelocity ?? 0,
              audioScore: clip.engagementScore ?? 0,
              textScore: clip.peakPhrase ? Math.min(1, clip.peakPhrase.length / 40) : 0,
              capsRatio,
              exclamationCount: (transcript.match(/!/g) || []).length,
              duration: finalEnd - finalStart,
            }),
            channel: decision === "A" ? "CHANNEL_A" : decision === "B" ? "CHANNEL_B" : null,
          },
        });
      } catch (err) {
        // Feedback is best-effort — don't fail the review if the clipper is unreachable
        console.warn("[review] Failed to send feedback to clipper:", err);
      }
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
      const channel = await db.channel.findUnique({ where: { id: channelId } });
      if (!channel || !channel.isConfigured) {
        return NextResponse.json(
          { error: `${channelId} is not configured. Visit Settings to authorize it.` },
          { status: 400 }
        );
      }
    }

    const newStatus =
      decision === "DOWNLOAD" ? "RENDERED" : decision === "A" ? "APPROVED_A" : "APPROVED_B";
    const channelId = decision === "A" ? "CHANNEL_A" : decision === "B" ? "CHANNEL_B" : null;

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
        subtitleStyle: withSubtitles && subtitleStyle ? JSON.stringify(subtitleStyle) : null,
        withBackingTrack,
        backingTrackId: withBackingTrack ? backingTrackId : null,
        backingTrackVolume,
      },
    });

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
