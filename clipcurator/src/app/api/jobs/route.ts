import { NextResponse } from "next/server";
import { listJobs } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/jobs — list current in-memory job queue state
export async function GET() {
  return NextResponse.json({ jobs: listJobs() });
}
