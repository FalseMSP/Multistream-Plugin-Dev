/**
 * ClipCurator pipeline — real backend integration.
 *
 * All video processing (download, analyze, render, publish) is handled by
 * the Python FastAPI clipper service running on CLIPPER_URL (default
 * http://localhost:8100). This module provides typed wrappers for calling
 * the clipper API.
 *
 * The clipper service uses:
 *   - yt-dlp for downloading Twitch/YouTube VODs
 *   - FFmpeg for cutting/rendering clips
 *   - faster-whisper (CPU-optimized) for transcription
 *   - librosa for audio peak detection
 *   - YouTube Data API for publishing (uses tokens from .env)
 */

import type { Clip } from "@/types";

const CLIPPER_URL = process.env.CLIPPER_URL || "http://localhost:8100";

export interface DetectedClip {
  startTimeSec: number;
  endTimeSec: number;
  suggestedStart: number;
  suggestedEnd: number;
  engagementScore: number;
  chatVelocity: number;
  transcript: string;
  peakPhrase: string;
  thumbnailUrl: string;
}

export interface ClipperDownloadResponse {
  sourceId: string;
  title: string;
  streamerName: string;
  durationSec: number;
  storagePath: string;
}

export interface ClipperAnalyzeResponse {
  sourceId: string;
  clips: DetectedClip[];
}

export interface ClipperRenderResponse {
  clipId: string;
  storagePath: string;
}

export interface ClipperPublishResponse {
  clipId: string;
  youtubeVideoId: string;
}

// ─── Clipper API calls ──────────────────────────────────────────────────────

async function clipperFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CLIPPER_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Clipper ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Ask the clipper service to download a VOD using yt-dlp.
 * Returns metadata (title, streamer, duration) and the storage path.
 */
export async function downloadVod(
  sourceId: string,
  url: string,
  platform: string
): Promise<ClipperDownloadResponse> {
  return clipperFetch<ClipperDownloadResponse>("/download", {
    method: "POST",
    body: JSON.stringify({ sourceId, url, platform }),
  });
}

/**
 * Ask the clipper service to analyze a downloaded VOD.
 * Runs Whisper transcription + librosa audio analysis + chat velocity parsing.
 * Returns detected highlight clips.
 */
export async function analyzeStream(
  sourceId: string,
  storagePath: string
): Promise<ClipperAnalyzeResponse> {
  return clipperFetch<ClipperAnalyzeResponse>("/analyze", {
    method: "POST",
    body: JSON.stringify({ sourceId, storagePath }),
  });
}

/**
 * Ask the clipper service to render a final clip using FFmpeg.
 * Cuts the segment from the VOD and produces a standalone MP4.
 */
export async function renderFinalClip(
  clipId: string,
  sourceStoragePath: string,
  finalStartSec: number,
  finalEndSec: number
): Promise<ClipperRenderResponse> {
  return clipperFetch<ClipperRenderResponse>("/render", {
    method: "POST",
    body: JSON.stringify({
      clipId,
      sourceStoragePath,
      finalStartSec,
      finalEndSec,
    }),
  });
}

/**
 * Ask the clipper service to publish a rendered clip to YouTube.
 * Uses the YouTube Data API with tokens from the .env file.
 */
export async function publishToYoutube(
  clipId: string,
  clipStoragePath: string,
  channel: string,
  title: string
): Promise<ClipperPublishResponse> {
  return clipperFetch<ClipperPublishResponse>("/publish", {
    method: "POST",
    body: JSON.stringify({ clipId, clipStoragePath, channel, title }),
  });
}

/**
 * Auto-generate a YouTube title from a clip's peak phrase.
 */
export function generateTitle(clip: Clip, streamerName: string | null | undefined): string {
  const peak = clip.peakPhrase ?? "Best Moment";
  const streamer = streamerName ?? "Streamer";
  const variants = [
    `${peak} — ${streamer} Highlight`,
    `Best of ${streamer}: ${peak}`,
    `${streamer} | ${peak}`,
    `${peak} (${streamer} Clip)`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}
