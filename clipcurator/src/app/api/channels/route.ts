import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { CHANNEL_DEFAULTS } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/channels — list both channels, creating default rows if missing
export async function GET() {
  // Ensure both channel rows exist with defaults
  for (const id of ["CHANNEL_A", "CHANNEL_B"] as const) {
    const existing = await db.channel.findUnique({ where: { id } });
    if (!existing) {
      await db.channel.create({
        data: {
          id,
          label: CHANNEL_DEFAULTS[id].label,
          tokenFilePath: CHANNEL_DEFAULTS[id].tokenFile,
          isConfigured: false,
        },
      });
    }
  }

  const channels = await db.channel.findMany({
    orderBy: { id: "asc" },
  });
  return NextResponse.json({ channels });
}
