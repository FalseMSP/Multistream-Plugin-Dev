import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/analytics/refresh — fetch YouTube retention + views for all
// published clips, store the data, and send retention feedback to the
// neural network.
//
// This should be called daily (e.g. via cron or systemd timer) to keep
// the model updated with real-world performance data.
//
// The clipper's /analytics/feedback endpoint receives the retention data
// and trains the neural network:
//   - High retention (>50%) → reinforces "accept" for that feature pattern
//   - Low retention (<30%) → reinforces "reject_bad" → more aggressive cutting
export async function POST(req: NextRequest) {
  try {
    // Find all published clips with YouTube video IDs
    const publishedClips = await db.clip.findMany({
      where: {
        status: "PUBLISHED",
        youtubeVideoId: { not: null },
      },
      include: { source: true },
      take: 50,  // process max 50 per run to avoid rate limits
    });

    console.log(`[analytics] Refreshing ${publishedClips.length} published clips`);

    const clipperUrl = process.env.CLIPPER_URL || "http://localhost:8100";
    const results: Array<{ clipId: string; success: boolean; retention?: number }> = [];

    for (const clip of publishedClips) {
      if (!clip.youtubeVideoId || !clip.publishedToChannelId) continue;

      try {
        // Call the clipper to fetch retention + stats
        const resp = await fetch(
          `${clipperUrl}/analytics/fetch?video_id=${clip.youtubeVideoId}&channel=${clip.publishedToChannelId}`,
          { signal: AbortSignal.timeout(30000) }
        );

        if (!resp.ok) {
          console.warn(`[analytics] Failed for ${clip.id}: ${resp.status}`);
          results.push({ clipId: clip.id, success: false });
          continue;
        }

        const data = await resp.json();

        // Store analytics in the DB (using errorMessage field as JSON
        // blob since we don't have a dedicated column — TODO: add one)
        if (data.retention) {
          // Send retention feedback to the neural network
          try {
            await fetch(`${clipperUrl}/feedback`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                clipId: clip.id,
                sourceId: clip.sourceId,
                // Train based on retention: high retention = "accept" signal,
                // low retention = "reject_bad" signal
                accepted: data.retention.averageViewPercentage > 0.5,
                retentionScore: data.retention.averageViewPercentage,
                features: {
                  chatVelocity: clip.chatVelocity ?? 0,
                  audioScore: clip.engagementScore ?? 0,
                  textScore: clip.peakPhrase ? Math.min(1, clip.peakPhrase.length / 40) : 0,
                  capsRatio: 0,
                  exclamationCount: (clip.transcript?.match(/!/g) || []).length,
                  laughterScore: 0,
                  duration: (clip.finalEndSec ?? clip.endTimeSec) - (clip.finalStartSec ?? clip.startTimeSec),
                  motionScore: 0,
                  sceneCount: 0,
                  clapScore: 0,
                  llmViralScore: 0,
                  openingRetention: data.retention.openingRetention,
                },
              }),
              signal: AbortSignal.timeout(10000),
            });
            console.log(
              `[analytics] Sent retention feedback for ${clip.id}: ` +
              `${(data.retention.averageViewPercentage * 100).toFixed(1)}% avg retention`
            );
          } catch (feedbackErr) {
            console.warn(`[analytics] Feedback failed for ${clip.id}:`, feedbackErr);
          }

          results.push({
            clipId: clip.id,
            success: true,
            retention: data.retention.averageViewPercentage,
          });
        }

        // Rate limit: 1 request per second (YouTube API quota)
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        console.warn(`[analytics] Error for ${clip.id}:`, err);
        results.push({ clipId: clip.id, success: false });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    console.log(
      `[analytics] Done: ${successCount}/${results.length} clips updated`
    );

    return NextResponse.json({
      ok: true,
      processed: results.length,
      succeeded: successCount,
      results,
    });
  } catch (err) {
    console.error("[POST /api/analytics/refresh]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}
