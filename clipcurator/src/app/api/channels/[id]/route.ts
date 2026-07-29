import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getYouTubeChannel, ClipperError } from "@/lib/clipper-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/channels/[id] — update channel label
// Body: { label?: string }
//
// To (re)authorize a channel (fetch YouTube channel info from tokens):
//   POST /api/channels/[id]  with body { action: "refresh" }
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!["CHANNEL_A", "CHANNEL_B"].includes(id)) {
      return NextResponse.json({ error: "invalid channel id" }, { status: 400 });
    }
    const body = await req.json().catch(() => ({}));
    const label: string | undefined =
      typeof body?.label === "string" ? body.label.slice(0, 64) : undefined;

    const existing = await db.channel.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "channel not found" }, { status: 404 });
    }

    const updated = await db.channel.update({
      where: { id },
      data: {
        ...(label !== undefined ? { label } : {}),
      },
    });

    return NextResponse.json({ channel: updated });
  } catch (err) {
    console.error("[PUT /api/channels/[id]]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}

// POST /api/channels/[id] — refresh YouTube channel info from tokens
// Body: { action: "refresh" }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!["CHANNEL_A", "CHANNEL_B"].includes(id)) {
      return NextResponse.json({ error: "invalid channel id" }, { status: 400 });
    }
    const body = await req.json().catch(() => ({}));
    if (body?.action !== "refresh") {
      return NextResponse.json(
        { error: 'expected { "action": "refresh" }' },
        { status: 400 }
      );
    }

    const channel = await db.channel.findUnique({ where: { id } });
    if (!channel) {
      return NextResponse.json({ error: "channel not found" }, { status: 404 });
    }

    // Ask the clipper to fetch YouTube channel info using this channel's tokens
    let info;
    try {
      info = await getYouTubeChannel(id as "CHANNEL_A" | "CHANNEL_B");
    } catch (err) {
      const msg =
        err instanceof ClipperError
          ? err.message
          : "failed to fetch channel info from clipper";
      // Mark as not configured
      await db.channel.update({
        where: { id },
        data: { isConfigured: false, errorMessage: msg },
      });
      return NextResponse.json(
        { error: msg },
        { status: 400 }
      );
    }

    const updated = await db.channel.update({
      where: { id },
      data: {
        youtubeChannelId: info.channelId || null,
        youtubeChannelName: info.title || null,
        youtubeChannelAvatar: info.thumbnailUrl || null,
        isConfigured: info.isConfigured,
      },
    });

    return NextResponse.json({ channel: updated });
  } catch (err) {
    console.error("[POST /api/channels/[id]]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
