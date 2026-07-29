import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/stats — dashboard summary numbers
export async function GET() {
  const pending = await db.clip.count({ where: { status: "PENDING" } });
  const inReview = await db.clip.count({ where: { status: "IN_REVIEW" } });
  const publishing = await db.clip.count({ where: { status: "PUBLISHING" } });
  const failed = await db.clip.count({ where: { status: "FAILED" } });
  const totalClips = await db.clip.count();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const publishedToday = await db.clip.count({
    where: { status: "PUBLISHED", publishedAt: { gte: startOfDay } },
  });
  const rejectedToday = await db.clip.count({
    where: { status: "REJECTED", reviewedAt: { gte: startOfDay } },
  });

  const reviewedToday = publishedToday + rejectedToday;
  const rejectionRate =
    reviewedToday === 0 ? 0 : Math.round((rejectedToday / reviewedToday) * 100);

  const streams = await db.streamSource.count();
  const streamsReady = await db.streamSource.count({ where: { status: "READY" } });
  const streamsFailed = await db.streamSource.count({ where: { status: "FAILED" } });

  return NextResponse.json({
    pending,
    inReview,
    publishing,
    failed,
    totalClips,
    publishedToday,
    rejectedToday,
    rejectionRate,
    streams,
    streamsReady,
    streamsFailed,
  });
}
