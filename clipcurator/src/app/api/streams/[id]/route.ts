import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/require-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/streams/[id] — delete a stream source + all its clips + VOD files.
//
// This does three things:
//   1. Deletes all clips belonging to this source from the DB (cascade)
//   2. Deletes the source row from the DB
//   3. Tells the clipper to delete the VOD files from disk (best-effort —
//      if the clipper is down, the DB rows are still deleted)
//
// Query param:
//   ?deleteFiles=true — also delete VOD + clip files from the clipper's disk.
//                       Defaults to true. Set to false to only delete DB rows.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const __auth = requireAuth(req.headers.get("cookie") ?? "");
  if (!__auth.authenticated) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

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
    // We do this BEFORE deleting DB rows so we still have the storagePaths.
    if (deleteFiles && source.storagePath) {
      try {
        const clipperUrl =
          process.env.CLIPPER_URL || "http://localhost:8100";
        // Delete the VOD directory: /vods/{sourceId}
        await fetch(`${clipperUrl}/cleanup/source/${source.id}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(10000),
        });
        console.log(
          `[DELETE /api/streams/${id}] Asked clipper to delete VOD files`
        );
      } catch (err) {
        // Best-effort — the clipper might be down. Log but don't fail.
        console.warn(
          `[DELETE /api/streams/${id}] Clipper cleanup failed (non-fatal):`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Delete all clips belonging to this source (cascade in schema, but
    // being explicit so we can also clean up clip files if needed).
    await db.clip.deleteMany({ where: { sourceId: id } });

    // Delete the source row
    await db.streamSource.delete({ where: { id } });

    console.log(`[DELETE /api/streams/${id}] Deleted source + ${source.clips.length} clips`);

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
