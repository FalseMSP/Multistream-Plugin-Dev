import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/twitch-channels/[id] — stop watching a channel
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const channel = await db.twitchChannel.findUnique({ where: { id } });
    if (!channel) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    await db.twitchChannel.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/twitch-channels/[id]]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}

// PUT /api/twitch-channels/[id] — toggle autoIngest
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const channel = await db.twitchChannel.findUnique({ where: { id } });
    if (!channel) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const updated = await db.twitchChannel.update({
      where: { id },
      data: {
        autoIngest: body?.autoIngest ?? !channel.autoIngest,
      },
    });

    return NextResponse.json({ channel: updated });
  } catch (err) {
    console.error("[PUT /api/twitch-channels/[id]]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
