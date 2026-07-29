import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueueDownloadVod } from "@/lib/queue";
import { isValidStreamUrl, urlPlatform, SAMPLE_VODS } from "@/lib/constants";
import { pickSampleVod } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/streams — submit a stream URL for processing
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const url: string = (body?.url ?? "").trim();

    if (!url) {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }
    if (!isValidStreamUrl(url)) {
      return NextResponse.json({ error: "invalid URL" }, { status: 400 });
    }

    // Resolve sample VOD for demo (we always have a real video URL to play)
    const sample = pickSampleVod(url);
    const platform = urlPlatform(url);

    const source = await db.streamSource.create({
      data: {
        url,
        platform,
        title: sample.title,
        streamerName: sample.streamerName,
        durationSec: sample.durationSec,
        status: "PENDING",
      },
    });

    enqueueDownloadVod(source.id);

    return NextResponse.json({ source }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/streams]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}

// GET /api/streams — list all stream sources (newest first)
export async function GET() {
  const sources = await db.streamSource.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ sources });
}

// Convenience export so /api/streams?demo=true can return a list of
// sample VODs the user can submit with one click.
export async function PUT() {
  return NextResponse.json({ samples: SAMPLE_VODS });
}
