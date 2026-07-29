import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueueDownloadVod } from "@/lib/queue";
import { isValidStreamUrl, urlPlatform } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/streams — submit a stream URL for processing.
//
// We create the StreamSource immediately with just the URL + platform.
// The real title, streamer name, and duration come back from yt-dlp via
// the download job (see src/lib/queue.ts → runDownloadVod), which updates
// the source row after the clipper's /download endpoint returns.
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

    const platform = urlPlatform(url);

    const source = await db.streamSource.create({
      data: {
        url,
        platform,
        // Title / streamerName / durationSec are filled in by the download
        // job after yt-dlp runs. Leaving them null here is intentional.
        title: null,
        streamerName: null,
        durationSec: null,
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
