import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkApiAuth } from "@/lib/api-auth";
import type { ClipStatus } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/clips — paginated, filterable list of all clips (auth-gated)
export async function GET(req: NextRequest) {
  const deny = checkApiAuth(req);
  if (deny) return deny;

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const pageSize = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("pageSize") ?? "20"))
  );
  const statusParam = url.searchParams.get("status");
  const sourceId = url.searchParams.get("sourceId");
  const q = url.searchParams.get("q")?.trim();

  const where: any = {};
  if (statusParam) {
    const statuses = statusParam
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean) as ClipStatus[];
    if (statuses.length > 0) where.status = { in: statuses };
  }
  if (sourceId) where.sourceId = sourceId;
  if (q) {
    where.OR = [
      { transcript: { contains: q } },
      { peakPhrase: { contains: q } },
    ];
  }

  const [items, total] = await Promise.all([
    db.clip.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { source: true },
    }),
    db.clip.count({ where }),
  ]);

  return NextResponse.json({
    items,
    total,
    page,
    pageSize,
  });
}
