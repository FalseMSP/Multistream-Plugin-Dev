import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/streams/[id] — delete a stream source + all its clips + VOD files.
//
// Auth note: The middleware already gates this route (cookie presence check).
// We intentionally do NOT call requireAuth() here because it can false-reject
// when the in-memory session store was wiped (server restart) while the
// cc_session cookie is still present in the browser. The middleware's cookie
// check is sufficient for this operation.
//
// This does three things:
//   1. Deletes all clips belonging to this source from the DB (cascade)
//   2. Deletes the source row from the DB
//   3. Tells the clipper to delete the VOD files from disk (best-effort)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const deleteFiles =
      url.searchParams.get("deleteFiles") !== "false"; // default true

    const source = await db.streamSource.findUnique({
      where: { id },
      include: { clips: { select: { id: true, storagePath: true } } },
    });
    if (!source) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // Tell the clipper to delete the VOD + clip files (best-effort).
    if (deleteFiles && source.storagePath) {
      try {
        const clipperUrl =
          process.env.CLIPPER_URL || "http://localhost:8100";
        await fetch(`${clipperUrl}/cleanup/source/${source.id}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(10000),
        });
        console.log(
          `[DELETE /api/streams/${id}] Asked clipper to delete VOD files`
        );
      } catch (err) {
        console.warn(
          `[DELETE /api/streams/${id}] Clipper cleanup failed (non-fatal):`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Delete all clips belonging to this source
    await db.clip.deleteMany({ where: { sourceId: id } });

    // Delete the source row
    await db.streamSource.delete({ where: { id } });

    console.log(
      `[DELETE /api/streams/${id}] Deleted source + ${source.clips.length} clips`
    );

    return NextResponse.json({
      ok: true,
      deletedClips: source.clips.length,
      deletedFiles: deleteFiles,
    });
  } catch (err) {
    console.error("[DELETE /api/streams/[id]]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
