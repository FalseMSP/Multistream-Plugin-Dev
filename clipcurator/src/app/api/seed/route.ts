import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueueDownloadVod } from "@/lib/queue";
import { SAMPLE_VODS } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/seed — populate the DB with a few demo streams + clips so the
// reviewer has something to look at immediately. Idempotent.
export async function POST() {
  // Wipe existing demo data (preserve nothing in this sandbox)
  await db.clip.deleteMany();
  await db.streamSource.deleteMany();
  await db.jobLog.deleteMany();

  // Submit each sample VOD as a fresh StreamSource
  for (const sample of SAMPLE_VODS) {
    const source = await db.streamSource.create({
      data: {
        url: sample.url,
        platform: sample.platform,
        title: sample.title,
        streamerName: sample.streamerName,
        durationSec: sample.durationSec,
        status: "PENDING",
      },
    });
    enqueueDownloadVod(source.id);
  }

  return NextResponse.json({
    ok: true,
    enqueued: SAMPLE_VODS.length,
    samples: SAMPLE_VODS,
  });
}
