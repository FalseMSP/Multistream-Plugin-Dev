// Typed HTTP client for the Python clipper backend (clipper.py on port 8100).
//
// Every function maps 1:1 to a FastAPI endpoint. POST endpoints send JSON;
// multipart endpoints (backing track upload) send FormData.
//
// IMPORTANT: Node.js's built-in fetch (undici) has a default bodyTimeout of
// 5 minutes (300s) that silently kills long-running requests like Whisper
// transcription on a 2-hour VOD (can take 30+ min). We can't import undici
// directly from Next.js (it's not exposed as an importable module).
//
// Solution: use node:http directly for POST requests. node:http has no
// built-in timeout — we control it entirely via a manual timer.

import http from "node:http";
import { URL } from "node:url";
import type { Platform, SubtitleStyle } from "@/types";

const CLIPPER_URL =
  process.env.CLIPPER_URL || "http://localhost:8100";

// 30 minutes — Whisper 'tiny' on CPU is ~0.5× realtime, so a 2-hour VOD
// takes ~1 hour. 30 min covers most VODs; if you regularly process longer
// content, bump this.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

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

// Low-level POST using node:http — no undici, no hidden bodyTimeout.
// The only timeout is our own `timeoutMs` via a manual timer.
function httpPost(
  url: string,
  bodyJson: string,
  timeoutMs: number
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyJson),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: data });
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    // Manual timeout — kills the request if no response within timeoutMs
    const timer = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Clear the timer once the response starts arriving
    req.on("response", () => {
      clearTimeout(timer);
    });

    req.write(bodyJson);
    req.end();
  });
}

async function clipperPost<T>(
  path: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  let result: { status: number; body: string };
  try {
    result = await httpPost(
      `${CLIPPER_URL}${path}`,
      JSON.stringify(body),
      timeoutMs
    );
  } catch (err) {
    throw new ClipperError(
      err instanceof Error
        ? `clipper unreachable: ${err.message}`
        : "clipper unreachable",
      path,
      0
    );
  }

  if (result.status < 200 || result.status >= 300) {
    let detail: string;
    try {
      const errBody = JSON.parse(result.body);
      detail = errBody.detail ?? result.body;
    } catch {
      detail = result.body || `HTTP ${result.status}`;
    }
    throw new ClipperError(detail, path, result.status);
  }

  try {
    return JSON.parse(result.body) as T;
  } catch {
    // Some endpoints return empty body on success
    return {} as T;
  }
}

async function clipperGet<T>(
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  // For GET requests, use fetch with AbortSignal — GETs are short (health,
  // channel info, transcript) so the 5-min undici timeout isn't an issue.
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
  storagePath: string;
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
  transcript: TranscriptSegment[];
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export function analyzeVod(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  // Whisper + librosa can be very slow on a 3-hour VOD. Give it 60 min.
  return clipperPost<AnalyzeResponse>("/analyze", req, 60 * 60 * 1000);
}

// ─── Render ─────────────────────────────────────────────────────────────────

export interface RenderRequest {
  clipId: string;
  sourceStoragePath: string;
  finalStartSec: number;
  finalEndSec: number;
  withSubtitles: boolean;
  subtitleVtt?: string;
  subtitleStyle?: SubtitleStyle;
  withBackingTrack: boolean;
  backingTrackPath?: string;
  backingTrackVolume?: number;
  layout?: string;  // "original" | "vertical_center" | "vertical_top" | "vertical_bottom" | "vertical_split"
}
export interface RenderResponse {
  clipId: string;
  storagePath: string;
}

export function renderClip(req: RenderRequest): Promise<RenderResponse> {
  return clipperPost<RenderResponse>("/render", req);
}

// ─── Publish ────────────────────────────────────────────────────────────────

export interface PublishRequest {
  clipId: string;
  clipStoragePath: string;
  channel: string;
  title: string;
}
export interface PublishResponse {
  clipId: string;
  youtubeVideoId: string;
}

export function publishToYoutube(
  req: PublishRequest
): Promise<PublishResponse> {
  return clipperPost<PublishResponse>("/publish", req, 60 * 60 * 1000);
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

  // FormData uploads use fetch (short request, no undici timeout issue)
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
