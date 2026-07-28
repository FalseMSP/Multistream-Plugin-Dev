import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { subscribe } from "@/lib/queue";
import { checkApiAuth } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/queue/sse — Server-Sent Events stream (auth-gated)
export async function GET(req: NextRequest) {
  const deny = checkApiAuth(req);
  if (deny) return deny;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = async () => {
        try {
          const pending = await db.clip.count({ where: { status: "PENDING" } });
          const inReview = await db.clip.count({ where: { status: "IN_REVIEW" } });
          const publishing = await db.clip.count({ where: { status: "PUBLISHING" } });
          const failed = await db.clip.count({ where: { status: "FAILED" } });

          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          const publishedToday = await db.clip.count({
            where: { status: "PUBLISHED", publishedAt: { gte: startOfDay } },
          });
          const rejectedToday = await db.clip.count({
            where: { status: "REJECTED", reviewedAt: { gte: startOfDay } },
          });

          const payload = {
            ts: Date.now(),
            pending,
            inReview,
            publishing,
            publishedToday,
            rejectedToday,
            failed,
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
          );
        } catch (err) {
          console.error("[SSE] send error", err);
        }
      };

      await send();
      const interval = setInterval(send, 2000);
      const unsubscribe = subscribe(() => { send(); });

      const close = () => {
        clearInterval(interval);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", close);
      setTimeout(close, 10 * 60 * 1000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
