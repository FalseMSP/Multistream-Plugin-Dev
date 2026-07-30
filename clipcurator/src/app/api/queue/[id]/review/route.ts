import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueueRenderFinalClip } from "@/lib/queue";
import type { Decision } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/queue/[id]/review — accept, reject, not-interested, or download
//
// decision values:
//   "A" | "B"        → publish to channel A/B (trains NN as "accept")
//   "REJECT"         → bad clip (trains NN as "reject_bad")
//   "NOT_INTERESTED" → duplicate/already clipped (trains NN as "not_interested")
//   "DOWNLOAD"       → render for download only (no training)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const decision = body?.decision as string | undefined;
    const finalStart = Number(body?.finalStart);
    const finalEnd = Number(body?.finalEnd);

    const withSubtitles = Boolean(body?.withSubtitles);
    const subtitleVtt: string | undefined =
      typeof body?.subtitleVtt === "string" ? body.subtitleVtt : undefined;
    const subtitleStyle = body?.subtitleStyle ?? undefined;

    const withBackingTrack = Boolean(body?.withBackingTrack);
    const backingTrackId: string | null =
      typeof body?.backingTrackId === "string" ? body.backingTrackId : null;
    const backingTrackVolume =
      typeof body?.backingTrackVolume === "number"
        ? Math.min(1, Math.max(0, body.backingTrackVolume))
        : 0.3;

    if (!decision || !["A", "B", "REJECT", "NOT_INTERESTED", "DOWNLOAD"].includes(decision)) {
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

    // ─── Send feedback to the neural network (3-class) ────────────────
    // label: 0=accept, 1=reject_bad, 2=not_interested
    if (["A", "B", "REJECT", "NOT_INTERESTED"].includes(decision)) {
      const label = decision === "A" || decision === "B" ? 0
                  : decision === "REJECT" ? 1
                  : 2;  // NOT_INTERESTED

      try {
        const clipperUrl = process.env.CLIPPER_URL || "http://localhost:8100";
        const transcript = clip.transcript ?? "";
        const letters = transcript.split("").filter((c) => /[a-zA-Z]/.test(c));
        const caps = transcript.split("").filter((c) => c === c.toUpperCase() && /[A-Z]/.test(c));
        const capsRatio = letters.length > 0 ? caps.length / letters.length : 0;

        // Extract LLM score from thumbnailUrl (stored as JSON blob)
        let llmScore = 0;
        try {
          const thumbData = JSON.parse(clip.thumbnailUrl ?? "{}");
          if (thumbData.llmScore) llmScore = thumbData.llmScore;
        } catch {}

        await fetch(`${clipperUrl}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clipId: clip.id,
            sourceId: clip.sourceId,
            accepted: label === 0,
            label: label,  // 0=accept, 1=reject_bad, 2=not_interested
            features: {
              chatVelocity: clip.chatVelocity ?? 0,
              audioScore: clip.engagementScore ?? 0,
              textScore: clip.peakPhrase ? Math.min(1, clip.peakPhrase.length / 40) : 0,
              capsRatio: capsRatio,
              exclamationCount: (transcript.match(/!/g) || []).length,
              laughterScore: 0,
              duration: finalEnd - finalStart,
              motionScore: 0,
              sceneCount: 0,
              clapScore: 0,
              llmViralScore: llmScore,
              openingRetention: 0,  // filled in later when YouTube data arrives
            },
          }),
          signal: AbortSignal.timeout(5000),
        });
        console.log(`[review] Feedback sent to NN (label=${label}, decision=${decision})`);
      } catch (err) {
        console.warn("[review] Failed to send feedback:", err);
      }
    }

    // ─── Handle the decision ──────────────────────────────────────────
    if (decision === "REJECT" || decision === "NOT_INTERESTED") {
      const updated = await db.clip.update({
        where: { id },
        data: {
          status: decision === "REJECT" ? "REJECTED" : "REJECTED",
          reviewerId: null,
          reviewedAt: new Date(),
          finalStartSec: finalStart,
          finalEndSec: finalEnd,
          publishedToChannelId: null,
          errorMessage: decision === "NOT_INTERESTED" ? "not_interested" : null,
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
