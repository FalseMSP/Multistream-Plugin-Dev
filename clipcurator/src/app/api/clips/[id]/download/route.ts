import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/clips/[id]/download — download the rendered clip MP4.
//
// Returns a 302 redirect to the clipper's /clip/{id}/final.mp4 endpoint
// (which is rewritten in next.config.ts to http://localhost:8100/clip/...).
// The browser will follow the redirect and download the file directly from
// the clipper, avoiding buffering the whole file through Next.js.
//
// If the clip hasn't been rendered yet (no storagePath), returns 409.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const clip = await db.clip.findUnique({ where: { id } });
  if (!clip) {
    return NextResponse.json({ error: "clip not found" }, { status: 404 });
  }
  if (!clip.storagePath) {
    return NextResponse.json(
      { error: "clip has not been rendered yet" },
      { status: 409 }
    );
  }

  // storagePath is "/clips/{clipId}/final.mp4" — but the next.config.ts
  // rewrite rule matches "/clip/:path*" (singular). So we strip the leading
  // /clips/ and replace with /clip/ to match the rewrite rule.
  // Final URL: /clipcurator/clip/{clipId}/final.mp4
  const clipperPath = clip.storagePath.replace(/^\/clips\//, "/clip/");
  const downloadUrl = `${process.env.NEXT_PUBLIC_BASE_PATH ?? "/clipcurator"}${clipperPath}`;

  // Use a 302 so the browser downloads the file with a sensible filename.
  // Content-Disposition is set by the clipper's FileResponse (filename="final.mp4").
  return NextResponse.redirect(downloadUrl, 302);
}
