import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkApiAuth } from "@/lib/api-auth";
import { enqueueDownloadVod } from "@/lib/queue";
import { isValidStreamUrl, urlPlatform } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/streams — submit a stream URL for processing (auth-gated)
export async function POST(req: NextRequest) {
  const deny = checkApiAuth(req);
  if (deny) return deny;

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

    // Create a StreamSource — the clipper backend will handle download + analysis
    const source = await db.streamSource.create({
      data: {
        url,
        platform,
        title: null, // will be filled by clipper backend
        streamerName: null, // will be filled by clipper backend
        durationSec: null,
        status: "PENDING",
      },
    });

    // Enqueue download job — this will call the real Python clipper
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

// GET /api/streams — list all stream sources (auth-gated)
export async function GET(req: NextRequest) {
  const deny = checkApiAuth(req);
  if (deny) return deny;

  const sources = await db.streamSource.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ sources });
}
