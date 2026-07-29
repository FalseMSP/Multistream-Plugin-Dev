// In-memory job queue (BullMQ substitute for the sandbox).
//
// In production this runs on Redis + BullMQ and dispatches work to the
// Python FastAPI clipper service. Here we keep the same job types and
// lifecycle states but execute everything in-process so the demo is
// fully observable from the UI.
//
// Job lifecycle:  QUEUED → ACTIVE → COMPLETED | FAILED
// Each job emits progress events that the SSE endpoint forwards to the UI.

import { db } from "@/lib/db";
import { analyzeStream, generateYoutubeId, generateTitle, pickSampleVod } from "./pipeline";
import { SAMPLE_VODS } from "./constants";
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
  // Defer execution to next tick so the caller can return immediately.
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

function setProgress(job: Job, progress: number) {
  job.progress = Math.min(100, Math.max(0, progress));
  job.updatedAt = Date.now();
  emit();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

  // Simulate 3-5s download with progress
  const totalSteps = 10;
  for (let i = 1; i <= totalSteps; i++) {
    await sleep(250 + Math.random() * 200);
    setProgress(job, (i / totalSteps) * 100);
  }

  // Resolve which sample VOD this URL maps to (or pick first if unknown)
  const sample = pickSampleVod(source.url);
  const durationSec = sample.durationSec;

  await db.streamSource.update({
    where: { id: source.id },
    data: {
      status: "DOWNLOADING", // will move to ANALYZING next
      storagePath: `/vods/${source.id}/master.mp4`,
      durationSec,
      downloadedAt: new Date(),
    },
  });

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

  // Simulate Whisper + librosa + chat velocity analysis
  const totalSteps = 12;
  for (let i = 1; i <= totalSteps; i++) {
    await sleep(300 + Math.random() * 250);
    setProgress(job, (i / totalSteps) * 100);
  }

  const durationSec = source.durationSec ?? 600;
  const seedKey = source.id;
  const detected = analyzeStream(source.url, durationSec, seedKey);
  const sample = pickSampleVod(source.url);
  const thumbnailUrl = sample.poster || "";

  // Persist detected clips
  const created: Clip[] = [];
  for (const d of detected) {
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
        thumbnailUrl,
      },
    });
    created.push(clip as unknown as Clip);
  }

  await db.streamSource.update({
    where: { id: source.id },
    data: { status: "READY", clipCount: created.length },
  });
}

// ─── render-final-clip ───────────────────────────────────────────────────────
async function runRenderFinalClip(job: Job) {
  if (!job.clipId) throw new Error("clipId required");
  const clip = await db.clip.findUnique({ where: { id: job.clipId } });
  if (!clip) throw new Error("clip not found");

  // Simulate FFmpeg render (1.5-3s)
  const totalSteps = 6;
  for (let i = 1; i <= totalSteps; i++) {
    await sleep(250 + Math.random() * 200);
    setProgress(job, (i / totalSteps) * 100);
  }

  await db.clip.update({
    where: { id: clip.id },
    data: {
      storagePath: `/clips/${clip.id}/final.mp4`,
    },
  });

  // Auto-enqueue publish-to-youtube if a channel was selected
  // (We only render after a publish decision is made.)
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

  // Simulate YouTube API upload (2-4s)
  const totalSteps = 8;
  for (let i = 1; i <= totalSteps; i++) {
    await sleep(300 + Math.random() * 250);
    setProgress(job, (i / totalSteps) * 100);
  }

  // 5% chance of failure (to exercise retry path)
  if (Math.random() < 0.05 && clip.publishAttempts < 3) {
    throw new Error("YouTube API rate limited (simulated). Will retry.");
  }

  const youtubeId = generateYoutubeId();
  await db.clip.update({
    where: { id: clip.id },
    data: {
      status: "PUBLISHED",
      youtubeVideoId: youtubeId,
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

// For demo convenience: enqueue a quick demo stream that uses a known
// sample VOD so the reviewer has something to look at immediately.
export function enqueueDemoStream(url?: string) {
  const sample = url
    ? SAMPLE_VODS.find((v) => v.url === url) ?? SAMPLE_VODS[0]
    : SAMPLE_VODS[Math.floor(Math.random() * SAMPLE_VODS.length)];
  return sample;
}
