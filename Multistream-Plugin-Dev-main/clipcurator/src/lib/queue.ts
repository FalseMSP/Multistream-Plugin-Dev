/**
 * Job queue — dispatches work to the real Python clipper backend.
 *
 * In production this could run on Redis + BullMQ, but for now we keep the
 * same in-process job tracking with real HTTP calls to the clipper service.
 *
 * Job lifecycle:  QUEUED → ACTIVE → COMPLETED | FAILED
 * Each job emits progress events that the SSE endpoint forwards to the UI.
 */

import { db } from "@/lib/db";
import {
  downloadVod,
  analyzeStream,
  renderFinalClip,
  publishToYoutube,
  generateTitle,
} from "./pipeline";
import type { Clip } from "@/types";

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
  const snapshot = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
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

function createJob(type: JobType, refs: { sourceId?: string; clipId?: string }): Job {
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
  // Defer execution to next tick
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

  // Persist to JobLog table (best-effort)
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

function setProgress(job: Job, progress: number) {
  job.progress = Math.min(100, Math.max(0, progress));
  job.updatedAt = Date.now();
  emit();
}

// ─── download-vod ────────────────────────────────────────────────────────────
async function runDownloadVod(job: Job) {
  if (!job.sourceId) throw new Error("sourceId required");
  const source = await db.streamSource.findUnique({ where: { id: job.sourceId } });
  if (!source) throw new Error("stream source not found");

  await db.streamSource.update({
    where: { id: source.id },
    data: { status: "DOWNLOADING", errorMessage: null },
  });

  setProgress(job, 10);

  // Call the real clipper backend to download the VOD
  const result = await downloadVod(source.id, source.url, source.platform);

  setProgress(job, 80);

  await db.streamSource.update({
    where: { id: source.id },
    data: {
      title: result.title,
      streamerName: result.streamerName,
      durationSec: result.durationSec,
      storagePath: result.storagePath,
      downloadedAt: new Date(),
      status: "DOWNLOADING", // will move to ANALYZING next
    },
  });

  setProgress(job, 100);

  // Auto-enqueue analyze-stream
  enqueueAnalyzeStream(source.id);
}

// ─── analyze-stream ──────────────────────────────────────────────────────────
async function runAnalyzeStream(job: Job) {
  if (!job.sourceId) throw new Error("sourceId required");
  const source = await db.streamSource.findUnique({ where: { id: job.sourceId } });
  if (!source) throw new Error("stream source not found");

  await db.streamSource.update({
    where: { id: source.id },
    data: { status: "ANALYZING" },
  });

  setProgress(job, 10);

  // Call the real clipper backend to analyze the VOD
  const result = await analyzeStream(source.id, source.storagePath ?? "");

  setProgress(job, 70);

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

  await db.streamSource.update({
    where: { id: source.id },
    data: { status: "READY", clipCount: created.length },
  });

  setProgress(job, 100);
}

// ─── render-final-clip ───────────────────────────────────────────────────────
async function runRenderFinalClip(job: Job) {
  if (!job.clipId) throw new Error("clipId required");
  const clip = await db.clip.findUnique({
    where: { id: job.clipId },
    include: { source: true },
  });
  if (!clip) throw new Error("clip not found");
  if (!clip.source) throw new Error("source missing for clip");

  setProgress(job, 10);

  // Call the real clipper backend to render the clip via FFmpeg
  const result = await renderFinalClip(
    clip.id,
    clip.source.storagePath ?? "",
    clip.finalStartSec ?? clip.suggestedStart,
    clip.finalEndSec ?? clip.suggestedEnd
  );

  await db.clip.update({
    where: { id: clip.id },
    data: { storagePath: result.storagePath },
  });

  setProgress(job, 100);

  // Auto-enqueue publish-to-youtube if a channel was selected
  if (clip.status === "APPROVED_A" || clip.status === "APPROVED_B") {
    enqueuePublishToYoutube(clip.id);
  }
}

// ─── publish-to-youtube ──────────────────────────────────────────────────────
async function runPublishToYoutube(job: Job) {
  if (!job.clipId) throw new Error("clipId required");
  const clip = await db.clip.findUnique({
    where: { id: job.clipId },
    include: { source: true },
  });
  if (!clip) throw new Error("clip not found");
  if (!clip.source) throw new Error("source missing");

  const channel = clip.publishedTo;
  if (!channel) throw new Error("publishedTo not set");

  await db.clip.update({
    where: { id: clip.id },
    data: { status: "PUBLISHING", publishAttempts: { increment: 1 } },
  });

  setProgress(job, 10);

  // Call the real clipper backend to upload to YouTube
  const title = generateTitle(clip, clip.source.streamerName);
  const result = await publishToYoutube(
    clip.id,
    clip.storagePath ?? "",
    channel,
    title
  );

  setProgress(job, 90);

  await db.clip.update({
    where: { id: clip.id },
    data: {
      status: "PUBLISHED",
      youtubeVideoId: result.youtubeVideoId,
      publishedAt: new Date(),
      errorMessage: null,
    },
  });

  setProgress(job, 100);
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
