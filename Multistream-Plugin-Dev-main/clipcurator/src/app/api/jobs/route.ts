import { NextRequest, NextResponse } from "next/server";
import { listJobs } from "@/lib/queue";
import { checkApiAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/jobs — list current in-memory job queue state (auth-gated)
export async function GET(req: NextRequest) {
  const deny = checkApiAuth(req);
  if (deny) return deny;

  return NextResponse.json({ jobs: listJobs() });
}
