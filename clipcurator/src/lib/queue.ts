// PATCHED src/lib/queue.ts — fixes two bugs that caused downloads to appear
// stuck at 5%:
//
// Bug 1: The heartbeat updated the in-memory JOB progress but NOT the
//        StreamSource's progress field in the DB. The dashboard reads
//        source.progress, so even when downloading worked, it looked frozen.
//        FIX: The heartbeat now also updates source.progress in the DB.
//
// Bug 2: When downloadVod() threw (clipper unreachable, yt-dlp failed),
//        runJob's catch block marked the JOB as FAILED but never updated
//        the source — so it stayed at DOWNLOADING/5% forever.
//        FIX: Each job function now has its own try/catch that marks the
//        source/clip as FAILED with an error message before re-throwing.
//
// Also added console.log/error calls throughout so errors show up in
// journalctl instead of being silently swallowed.

import { db } from "@/lib/db";
import {
  downloadVod,
  analyzeVod,
  renderClip,
  publishToYoutube,
  type RenderRequest,
} from "@/lib/clipper-client";
import { generateTitle } from "@/lib/pipeline";
import type { Clip, SubtitleStyle } from "@/types";

type JobType =
  | "download-vod"
  | "analyze-stream"
  | "render-final-clip"
  | "publish-to-youtube";

interface Job {
  id: string;
  type: JobType;
  sourceId?: string;
  clipId?: string;
  status: "QUEUED" | "ACTIVE" | "COMPLETED" | "FAILED";
  progress: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

type ProgressListener = (jobs: Job[]) => void;

const jobs = new Map<string, Job>();
const listeners = new Set<ProgressListener>();
let jobCounter = 0;

function emit() {
  const snapshot = Array.from(jobs.values()).sort(
    (a, b) => b.createdAt - a.createdAt
  );
  for (const l of listeners) l(snapshot);
}

export function subscribe(listener: ProgressListener): () => void {
  listeners.add(listener);
  listener(Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt));
  return () => listeners.delete(listener);
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function createJob(
  type: JobType,
  refs: { sourceId?: string; clipId?: string }
): Job {
  jobCounter += 1;
  const id = `job_${Date.now()}_${jobCounter}`;
  const job: Job = {
    id,
    type,
    ...refs,
    status: "QUEUED",
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  emit();
  console.log(`[queue] Job ${id} created: ${type}`, refs);
  setTimeout(() => runJob(id), 50);
  return job;
}

async function runJob(id: string) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "ACTIVE";
  job.updatedAt = Date.now();
  emit();
  console.log(`[queue] Job ${id} starting: ${job.type}`);

  try {
    switch (job.type) {
      case "download-vod":
        await runDownloadVod(job);
        break;
      case "analyze-stream":
        await runAnalyzeStream(job);
        break;
      case "render-final-clip":
        await runRenderFinalClip(job);
        break;
      case "publish-to-youtube":
        await runPublishToYoutube(job);
        break;
    }
    job.status = "COMPLETED";
    job.progress = 100;
    console.log(`[queue] Job ${id} completed: ${job.type}`);
  } catch (err) {
    job.status = "FAILED";
    job.error = err instanceof Error ? err.message : String(err);
    console.error(`[queue] Job ${id} FAILED: ${job.type}`, err);
  }
  job.updatedAt = Date.now();
  emit();

  // Persist to JobLog table (best-effort, never throws)
  try {
    await db.jobLog.create({
      data: {
        id: job.id,
        sourceId: job.sourceId,
        clipId: job.clipId,
        jobType: job.type,
        status: job.status,
        progress: job.progress,
        error: job.error,
      },
    });
  } catch {
    // ignore — job log is best-effort
  }
}

// Heartbeat: bumps the in-memory job progress AND the source/clip progress
// in the DB so the dashboard shows activity during long operations.
function startHeartbeat(
  job: Job,
  intervalMs: number,
  step: number,
  cap: number,
  dbUpdate?: (progress: number) => Promise<void>
): () => void {
  const timer = setInterval(async () => {
    if (job.progress < cap) {
      job.progress = Math.min(cap, job.progress + step);
      job.updatedAt = Date.now();
      emit();
      // Also update the DB so the dashboard polling sees progress
      if (dbUpdate) {
        try {
          await dbUpdate(job.progress);
        } catch {
          // best-effort — don't kill the heartbeat on DB errors
        }
      }
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

// ─── download-vod ────────────────────────────────────────────────────────────
async function runDownloadVod(job: Job) {
  if (!job.sourceId) throw new Error("sourceId required");
  const source = await db.streamSource.findUnique({
    where: { id: job.sourceId },
  });
  if (!source) throw new Error("stream source not found");

  console.log(`[download] Starting download for source ${source.id}`, {
    url: source.url,
    platform: source.platform,
  });

  await db.streamSource.update({
    where: { id: source.id },
    data: { status: "DOWNLOADING", errorMessage: null, progress: 5 },
  });

  // Heartbeat updates BOTH the job progress AND the source progress in the DB
  const stopHeartbeat = startHeartbeat(
    job,
    3000,
    2,
    90,
    async (progress) => {
      await db.streamSource.update({
        where: { id: source.id },
        data: { progress },
      });
    }
  );

  try {
    console.log(`[download] Calling clipper /download for ${source.url}`);
    const result = await downloadVod({
      sourceId: source.id,
      url: source.url,
      platform: source.platform as "TWITCH" | "YOUTUBE",
    });
    console.log(`[download] Clipper returned successfully`, {
      title: result.title,
      durationSec: result.durationSec,
      storagePath: result.storagePath,
    });

    await db.streamSource.update({
      where: { id: source.id },
      data: {
        status: "DOWNLOADING", // will move to ANALYZING next
        title: result.title,
        streamerName: result.streamerName,
        durationSec: result.durationSec,
        storagePath: result.storagePath,
        downloadedAt: new Date(),
        progress: 95,
      },
    });

    console.log(`[download] Enqueuing analysis for source ${source.id}`);
    enqueueAnalyzeStream(source.id);
  } catch (err) {
    // Mark the SOURCE as failed — without this, the source stays at
    // DOWNLOADING/5% forever and the user has no idea what went wrong.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[download] Failed for source ${source.id}:`, errMsg);
    await db.streamSource.update({
      where: { id: source.id },
      data: {
        status: "FAILED",
        errorMessage: errMsg,
        progress: 0,
      },
    });
    throw err;
  } finally {
    stopHeartbeat();
  }
}

// ─── analyze-stream ──────────────────────────────────────────────────────────
async function runAnalyzeStream(job: Job) {
  if (!job.sourceId) throw new Error("sourceId required");
  const source = await db.streamSource.findUnique({
    where: { id: job.sourceId },
  });
  if (!source) throw new Error("stream source not found");
  if (!source.storagePath) {
    throw new Error("source has no storagePath — download may have failed");
  }

  console.log(`[analyze] Starting analysis for source ${source.id}`);

  await db.streamSource.update({
    where: { id: source.id },
    data: { status: "ANALYZING", progress: 10 },
  });

  const stopHeartbeat = startHeartbeat(
    job,
    5000,
    1,
    90,
    async (progress) => {
      await db.streamSource.update({
        where: { id: source.id },
        data: { progress },
      });
    }
  );

  let result;
  try {
    console.log(`[analyze] Calling clipper /analyze for source ${source.id}`);
    result = await analyzeVod({
      sourceId: source.id,
      storagePath: source.storagePath,
    });
    console.log(`[analyze] Clipper returned ${result.clips.length} clips`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[analyze] Failed for source ${source.id}:`, errMsg);
    await db.streamSource.update({
      where: { id: source.id },
      data: {
        status: "FAILED",
        errorMessage: errMsg,
        progress: 0,
      },
    });
    throw err;
  } finally {
    stopHeartbeat();
  }

  // Persist detected clips
  const created: Clip[] = [];
  for (const d of result.clips) {
    const clip = await db.clip.create({
      data: {
        sourceId: source.id,
        startTimeSec: d.startTimeSec,
        endTimeSec: d.endTimeSec,
        suggestedStart: d.suggestedStart,
        suggestedEnd: d.suggestedEnd,
        status: "PENDING",
        engagementScore: d.engagementScore,
        transcript: d.transcript,
        chatVelocity: d.chatVelocity,
        peakPhrase: d.peakPhrase,
        thumbnailUrl: d.thumbnailUrl,
      },
    });
    created.push(clip as unknown as Clip);
  }

  // Persist the full Whisper transcript on the source
  await db.streamSource.update({
    where: { id: source.id },
    data: {
      status: "READY",
      clipCount: created.length,
      progress: 100,
      transcriptJson: JSON.stringify(result.transcript),
    },
  });

  console.log(`[analyze] Source ${source.id} READY with ${created.length} clips`);
}

// ─── render-final-clip ───────────────────────────────────────────────────────
async function runRenderFinalClip(job: Job) {
  if (!job.clipId) throw new Error("clipId required");
  const clip = await db.clip.findUnique({
    where: { id: job.clipId },
    include: { source: true, backingTrack: true },
  });
  if (!clip) throw new Error("clip not found");
  if (!clip.source) throw new Error("source missing");
  if (!clip.source.storagePath) {
    throw new Error("source has no storagePath — VOD not downloaded");
  }
  if (clip.finalStartSec == null || clip.finalEndSec == null) {
    throw new Error("clip has no final trim — review not submitted");
  }

  console.log(`[render] Starting render for clip ${clip.id}`);

  const renderReq: RenderRequest = {
    clipId: clip.id,
    sourceStoragePath: clip.source.storagePath,
    finalStartSec: clip.finalStartSec,
    finalEndSec: clip.finalEndSec,
    withSubtitles: clip.withSubtitles,
    subtitleVtt: clip.withSubtitles ? clip.subtitleVtt ?? undefined : undefined,
    subtitleStyle: clip.subtitleStyle
      ? (JSON.parse(clip.subtitleStyle) as SubtitleStyle)
      : undefined,
    withBackingTrack: clip.withBackingTrack,
    backingTrackPath:
      clip.withBackingTrack && clip.backingTrack
        ? clip.backingTrack.storagePath
        : undefined,
    backingTrackVolume: clip.withBackingTrack
      ? clip.backingTrackVolume
      : undefined,
  };

  const stopHeartbeat = startHeartbeat(job, 2000, 3, 90);

  let result;
  try {
    console.log(`[render] Calling clipper /render for clip ${clip.id}`);
    result = await renderClip(renderReq);
    console.log(`[render] Clipper returned: ${result.storagePath}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[render] Failed for clip ${clip.id}:`, errMsg);
    await db.clip.update({
      where: { id: clip.id },
      data: {
        status: "FAILED",
        errorMessage: errMsg,
      },
    });
    throw err;
  } finally {
    stopHeartbeat();
  }

  await db.clip.update({
    where: { id: clip.id },
    data: { storagePath: result.storagePath },
  });

  // Auto-enqueue publish if a channel was selected during review.
  if (clip.status === "APPROVED_A" || clip.status === "APPROVED_B") {
    console.log(`[render] Enqueuing publish for clip ${clip.id}`);
    enqueuePublishToYoutube(clip.id);
  }
}

// ─── publish-to-youtube ──────────────────────────────────────────────────────
async function runPublishToYoutube(job: Job) {
  if (!job.clipId) throw new Error("clipId required");
  const clip = await db.clip.findUnique({
    where: { id: job.clipId },
    include: { source: true, publishedToChannel: true },
  });
  if (!clip) throw new Error("clip not found");
  if (!clip.source) throw new Error("source missing");
  if (!clip.storagePath) {
    throw new Error("clip has no storagePath — render may have failed");
  }

  const channel = clip.publishedToChannelId;
  if (!channel) throw new Error("publishedToChannelId not set");

  const channelRow = await db.channel.findUnique({ where: { id: channel } });
  if (!channelRow || !channelRow.isConfigured) {
    throw new Error(
      `${channel} is not configured — visit Settings to authorize it`
    );
  }

  console.log(`[publish] Starting publish for clip ${clip.id} to ${channel}`);

  await db.clip.update({
    where: { id: clip.id },
    data: { status: "PUBLISHING", publishAttempts: { increment: 1 } },
  });

  const title = generateTitle(
    clip as unknown as Clip,
    clip.source.streamerName
  );

  const stopHeartbeat = startHeartbeat(job, 2000, 2, 90);

  let result;
  try {
    console.log(`[publish] Calling clipper /publish for clip ${clip.id}`);
    result = await publishToYoutube({
      clipId: clip.id,
      clipStoragePath: clip.storagePath,
      channel,
      title,
    });
    console.log(`[publish] Published! YouTube ID: ${result.youtubeVideoId}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[publish] Failed for clip ${clip.id}:`, errMsg);
    await db.clip.update({
      where: { id: clip.id },
      data: {
        status: "FAILED",
        errorMessage: errMsg,
      },
    });
    throw err;
  } finally {
    stopHeartbeat();
  }

  await db.clip.update({
    where: { id: clip.id },
    data: {
      status: "PUBLISHED",
      youtubeVideoId: result.youtubeVideoId,
      publishedAt: new Date(),
      errorMessage: null,
    },
  });
}

// ─── Public enqueue helpers ──────────────────────────────────────────────────
export function enqueueDownloadVod(sourceId: string) {
  return createJob("download-vod", { sourceId });
}

export function enqueueAnalyzeStream(sourceId: string) {
  return createJob("analyze-stream", { sourceId });
}

export function enqueueRenderFinalClip(clipId: string) {
  return createJob("render-final-clip", { clipId });
}

export function enqueuePublishToYoutube(clipId: string) {
  return createJob("publish-to-youtube", { clipId });
}
