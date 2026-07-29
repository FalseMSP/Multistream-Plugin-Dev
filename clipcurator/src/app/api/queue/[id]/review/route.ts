import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueueRenderFinalClip } from "@/lib/queue";
import type { Decision } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/queue/[id]/review — accept or reject a clip
// Body: { decision: "A" | "B" | "REJECT", finalStart: number, finalEnd: number }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const decision = body?.decision as Decision | undefined;
    const finalStart = Number(body?.finalStart);
    const finalEnd = Number(body?.finalEnd);

    if (!decision || !["A", "B", "REJECT"].includes(decision)) {
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
          publishedTo: null,
        },
      });
      return NextResponse.json({ clip: updated });
    }

    // APPROVED — kick off render → publish pipeline
    const channel = decision === "A" ? "CHANNEL_A" : "CHANNEL_B";
    const updated = await db.clip.update({
      where: { id },
      data: {
        status: decision === "A" ? "APPROVED_A" : "APPROVED_B",
        reviewerId: null,
        reviewedAt: new Date(),
        finalStartSec: finalStart,
        finalEndSec: finalEnd,
        publishedTo: channel,
      },
    });

    // Render the final clip (FFmpeg), then auto-enqueue YouTube publish
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
