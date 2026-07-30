import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/twitch-channels — list all watched channels
export async function GET() {
  const channels = await db.twitchChannel.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ channels });
}

// POST /api/twitch-channels — add a channel to watch
// Body: { channelName: string, autoIngest?: boolean }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const channelName = String(body?.channelName ?? "").trim().toLowerCase();

    if (!channelName) {
      return NextResponse.json({ error: "channelName is required" }, { status: 400 });
    }

    // Validate: Twitch usernames are 4-25 chars, alphanumeric + underscore
    if (!/^[a-z0-9_]{4,25}$/.test(channelName)) {
      return NextResponse.json(
        { error: "Invalid Twitch username (4-25 chars, alphanumeric + underscore)" },
        { status: 400 }
      );
    }

    // Check for duplicate
    const existing = await db.twitchChannel.findUnique({
      where: { channelName },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Channel already being watched" },
        { status: 409 }
      );
    }

    const channel = await db.twitchChannel.create({
      data: {
        channelName,
        displayName: body?.channelName?.trim(),
        autoIngest: body?.autoIngest ?? true,
      },
    });

    return NextResponse.json({ channel }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/twitch-channels]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
