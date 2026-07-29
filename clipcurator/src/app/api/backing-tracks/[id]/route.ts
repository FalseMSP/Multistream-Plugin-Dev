import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/backing-tracks/[id] — delete a backing track
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const track = await db.backingTrack.findUnique({ where: { id } });
    if (!track) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // Detach from any clips that reference it, then delete the row.
    // (The actual file on disk is left for the clipper to clean up later —
    // we don't want to make a sync HTTP call to the clipper from here.)
    await db.clip.updateMany({
      where: { backingTrackId: id },
      data: { backingTrackId: null, withBackingTrack: false },
    });
    await db.backingTrack.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/backing-tracks/[id]]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
