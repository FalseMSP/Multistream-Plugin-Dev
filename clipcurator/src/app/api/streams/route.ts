import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueueAnalyzeStream } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/streams/[id]/reprocess — re-run analysis on a FAILED stream
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const source = await db.streamSource.findUnique({ where: { id } });
    if (!source) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    await db.streamSource.update({
      where: { id },
      data: { status: "PENDING", errorMessage: null, progress: 0 },
    });

    // If we already have the VOD downloaded, skip straight to analyze.
    if (source.downloadedAt && source.storagePath) {
      enqueueAnalyzeStream(id);
    } else {
      const { enqueueDownloadVod } = await import("@/lib/queue");
      enqueueDownloadVod(id);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/streams/[id]/reprocess]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
