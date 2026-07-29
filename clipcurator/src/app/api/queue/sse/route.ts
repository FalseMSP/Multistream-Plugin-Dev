import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { subscribe } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/queue/sse — Server-Sent Events stream.
// Emits a JSON event every 2s OR when the in-memory job queue changes,
// containing: pending count, in-review count, today's published count,
// today's rejected count, and the latest active jobs.
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = async () => {
        try {
          const pending = await db.clip.count({ where: { status: "PENDING" } });
          const inReview = await db.clip.count({ where: { status: "IN_REVIEW" } });
          const publishing = await db.clip.count({ where: { status: "PUBLISHING" } });
          const publishedTotal = await db.clip.count({ where: { status: "PUBLISHED" } });
          const failed = await db.clip.count({ where: { status: "FAILED" } });

          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          const publishedToday = await db.clip.count({
            where: {
              status: "PUBLISHED",
              publishedAt: { gte: startOfDay },
            },
          });
          const rejectedToday = await db.clip.count({
            where: {
              status: "REJECTED",
              reviewedAt: { gte: startOfDay },
            },
          });

          const payload = {
            ts: Date.now(),
            pending,
            inReview,
            publishing,
            publishedTotal,
            publishedToday,
            rejectedToday,
            failed,
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
          );
        } catch (err) {
          // best-effort; don't kill the stream
          console.error("[SSE] send error", err);
        }
      };

      // Initial flush
      await send();

      // Polling fallback (every 2s) — guarantees updates even without
      // a job-queue event firing.
      const interval = setInterval(send, 2000);

      // Subscribe to in-memory job queue changes for snappier UX.
      const unsubscribe = subscribe(() => {
        // Reuse the same sender
        send();
      });

      // Handle client disconnect
      const close = () => {
        clearInterval(interval);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close);

      // Safety: if no signal support, close after 10 minutes
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
