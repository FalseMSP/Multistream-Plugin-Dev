// In-memory job queue that dispatches work to the Python clipper backend
// (clipper.py on port 8100).
//
// Job lifecycle:  QUEUED → ACTIVE → COMPLETED | FAILED
//
// Each job calls a real clipper endpoint:
//   download-vod       → POST /download   (yt-dlp)
//   analyze-stream     → POST /analyze    (Whisper + librosa + chat velocity + laughter)
//   render-final-clip  → POST /render     (FFmpeg + optional subtitles + backing track)
//   publish-to-youtube → POST /publish    (YouTube Data API v3, multi-channel)
//
// Progress is reported via a heartbeat timer that bumps the progress % every
// few seconds while the HTTP call is in flight, so the UI shows activity
// even when yt-dlp or Whisper takes minutes.

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
  setTimeout(() => runJob(id), 50);
  return job;
}

async function runJob(id: string) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "ACTIVE";
  job.updatedAt = Date.now();
  emit();

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
  } catch (err) {
    job.status = "FAILED";
    job.error = err instanceof Error ? err.message : String(err);
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

function startHeartbeat(
  job: Job,
  intervalMs: number,
  step: number,
  cap: number
): () => void {
  const timer = setInterval(() => {
    if (job.progress < cap) {
      job.progress = Math.min(cap, job.progress + step);
      job.updatedAt = Date.now();
      emit();
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

  await db.streamSource.update({
    where: { id: source.id },
    data: { status: "DOWNLOADING", errorMessage: null, progress: 5 },
  });

  const stopHeartbeat = startHeartbeat(job, 3000, 2, 90);

  try {
    const result = await downloadVod({
      sourceId: source.id,
      url: source.url,
      platform: source.platform as "TWITCH" | "YOUTUBE",
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

    enqueueAnalyzeStream(source.id);
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

  await db.streamSource.update({
    where: { id: source.id },
    data: { status: "ANALYZING", progress: 10 },
  });

  const stopHeartbeat = startHeartbeat(job, 5000, 1, 90);

  let result;
  try {
    result = await analyzeVod({
      sourceId: source.id,
      storagePath: source.storagePath,
    });
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

  // Persist the full Whisper transcript on the source — the subtitle editor
  // fetches this via /api/sources/[id]/transcript and filters to the clip range.
  await db.streamSource.update({
    where: { id: source.id },
    data: {
      status: "READY",
      clipCount: created.length,
      progress: 100,
      transcriptJson: JSON.stringify(result.transcript),
    },
  });
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

  // Build render request with all post-processing options.
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
    result = await renderClip(renderReq);
  } finally {
    stopHeartbeat();
  }

  await db.clip.update({
    where: { id: clip.id },
    data: { storagePath: result.storagePath },
  });

  // Auto-enqueue publish if a channel was selected during review.
  // (Download-only renders just leave the clip as RENDERED.)
  if (clip.status === "APPROVED_A" || clip.status === "APPROVED_B") {
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

  // Make sure the channel is configured before attempting upload.
  const channelRow = await db.channel.findUnique({ where: { id: channel } });
  if (!channelRow || !channelRow.isConfigured) {
    throw new Error(
      `${channel} is not configured — visit Settings to authorize it`
    );
  }

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
    result = await publishToYoutube({
      clipId: clip.id,
      clipStoragePath: clip.storagePath,
      channel,
      title,
    });
  } catch (err) {
    await db.clip.update({
      where: { id: clip.id },
      data: {
        status: "FAILED",
        errorMessage:
          err instanceof Error ? err.message : "YouTube publish failed",
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
