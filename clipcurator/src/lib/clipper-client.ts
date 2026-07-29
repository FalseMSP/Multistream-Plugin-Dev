// Typed HTTP client for the Python clipper backend (clipper.py on port 8100).
//
// Every function maps 1:1 to a FastAPI endpoint. POST endpoints send JSON;
// multipart endpoints (backing track upload) send FormData.
// Timeouts are generous because yt-dlp downloads, Whisper transcription,
// and FFmpeg rendering can each take minutes on a long VOD.

import type { Platform, SubtitleStyle } from "@/types";

const CLIPPER_URL =
  process.env.CLIPPER_URL || "http://localhost:8100";

// 10 minutes — long enough for a 2-hour VOD download on a slow connection,
// short enough that a truly stuck process gets killed.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class ClipperError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ClipperError";
  }
}

async function clipperPost<T>(
  path: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CLIPPER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ClipperError(
      err instanceof Error
        ? `clipper unreachable: ${err.message}`
        : "clipper unreachable",
      path,
      0
    );
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const detail =
      (errBody as { detail?: string })?.detail ?? res.statusText;
    throw new ClipperError(detail, path, res.status);
  }

  return res.json() as Promise<T>;
}

async function clipperGet<T>(
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CLIPPER_URL}${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ClipperError(
      err instanceof Error
        ? `clipper unreachable: ${err.message}`
        : "clipper unreachable",
      path,
      0
    );
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const detail =
      (errBody as { detail?: string })?.detail ?? res.statusText;
    throw new ClipperError(detail, path, res.status);
  }

  return res.json() as Promise<T>;
}

// ─── Download ───────────────────────────────────────────────────────────────

export interface DownloadRequest {
  sourceId: string;
  url: string;
  platform: Platform;
}
export interface DownloadResponse {
  sourceId: string;
  title: string;
  streamerName: string;
  durationSec: number;
  storagePath: string; // /vods/{sourceId}/master.mp4
  thumbnailUrl: string;
}

export function downloadVod(
  req: DownloadRequest
): Promise<DownloadResponse> {
  return clipperPost<DownloadResponse>("/download", req);
}

// ─── Analyze ────────────────────────────────────────────────────────────────

export interface AnalyzeRequest {
  sourceId: string;
  storagePath: string;
}
export interface AnalyzedClip {
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
export interface AnalyzeResponse {
  sourceId: string;
  clips: AnalyzedClip[];
  transcript: TranscriptSegment[]; // full Whisper segments — for subtitle editor
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export function analyzeVod(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  // Whisper + librosa can be very slow on a 3-hour VOD. Give it 30 min.
  return clipperPost<AnalyzeResponse>("/analyze", req, 30 * 60 * 1000);
}

// ─── Render ─────────────────────────────────────────────────────────────────

export interface RenderRequest {
  clipId: string;
  sourceStoragePath: string;
  finalStartSec: number;
  finalEndSec: number;
  withSubtitles: boolean;
  subtitleVtt?: string;       // WebVTT content (only if withSubtitles)
  subtitleStyle?: SubtitleStyle;
  withBackingTrack: boolean;
  backingTrackPath?: string;  // /backing/{id}.mp3 (only if withBackingTrack)
  backingTrackVolume?: number; // 0-1, default 0.3
}
export interface RenderResponse {
  clipId: string;
  storagePath: string; // /clips/{clipId}/final.mp4
}

export function renderClip(req: RenderRequest): Promise<RenderResponse> {
  return clipperPost<RenderResponse>("/render", req);
}

// ─── Publish ────────────────────────────────────────────────────────────────

export interface PublishRequest {
  clipId: string;
  clipStoragePath: string;
  channel: string; // CHANNEL_A | CHANNEL_B — clipper uses this to pick token file
  title: string;
}
export interface PublishResponse {
  clipId: string;
  youtubeVideoId: string;
}

export function publishToYoutube(
  req: PublishRequest
): Promise<PublishResponse> {
  return clipperPost<PublishResponse>("/publish", req, 30 * 60 * 1000);
}

// ─── Transcript ─────────────────────────────────────────────────────────────

export interface TranscriptResponse {
  sourceId: string;
  segments: TranscriptSegment[];
}

export function getTranscript(sourceId: string): Promise<TranscriptResponse> {
  return clipperGet<TranscriptResponse>(`/transcript/${sourceId}`);
}

// ─── Backing tracks ─────────────────────────────────────────────────────────

export interface BackingTrackResponse {
  id: string;
  name: string;
  storagePath: string;
  fileSizeBytes: number | null;
  durationSec: number | null;
}

export async function uploadBackingTrack(
  name: string,
  file: File
): Promise<BackingTrackResponse> {
  const formData = new FormData();
  formData.append("name", name);
  formData.append("file", file);

  const res = await fetch(`${CLIPPER_URL}/backing-track`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new ClipperError(
      (errBody as { detail?: string })?.detail ?? res.statusText,
      "/backing-track",
      res.status
    );
  }

  return res.json() as Promise<BackingTrackResponse>;
}

// ─── YouTube channel info ───────────────────────────────────────────────────

export interface YouTubeChannelInfo {
  channelId: string;
  title: string;
  thumbnailUrl: string;
  isConfigured: boolean;
}

export function getYouTubeChannel(
  channel: "CHANNEL_A" | "CHANNEL_B"
): Promise<YouTubeChannelInfo> {
  return clipperGet<YouTubeChannelInfo>(
    `/youtube/channel?channel=${channel}`
  );
}

// ─── Health check ───────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
}

export function checkHealth(): Promise<HealthResponse> {
  return clipperGet<HealthResponse>("/health", 5000);
}
