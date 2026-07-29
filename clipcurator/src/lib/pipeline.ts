// Mock video processing pipeline.
//
// In production this lives in the Python FastAPI clipper service
// (yt-dlp + FFmpeg + Whisper + librosa + chat-velocity parser).
// In the sandbox we simulate the full pipeline in-process so the
// UI/UX flow (submit → download → analyze → render → review → publish)
// can be exercised end-to-end without external services.
//
// The engagement-detection algorithm below mirrors the Python spec
// from the project README:
//   - chat velocity spikes (2.5× std above mean)
//   - audio dB peaks
//   - transcript highlights (laughter / caps / repeated phrases)
//   - merge proximate peaks (within 15s)
//   - pad each window to 45–90s
//   - hard cap at 20 clips per stream

import { HIGHLIGHT_PHRASES, SAMPLE_VODS, TRANSCRIPT_TEMPLATES } from "./constants";
import type { Clip } from "@/types";

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

// Deterministic pseudo-random so re-analyzing the same URL gives
// the same clip set (makes the demo reproducible).
function seeded(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

// Simulate chat velocity over the VOD: ~1 msg/sec baseline with random spikes.
function simulateChatVelocity(durationSec: number, rng: () => number) {
  const samples: number[] = [];
  const bucketSize = 5; // 5s buckets
  const bucketCount = Math.max(1, Math.floor(durationSec / bucketSize));
  for (let i = 0; i < bucketCount; i++) {
    const baseline = 1 + rng() * 3;
    const spike = rng() > 0.85 ? rng() * 140 : 0; // occasional big spike
    samples.push(Math.round(baseline + spike));
  }
  return { samples, bucketSize };
}

function detectChatPeaks(samples: number[]) {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance =
    samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  const std = Math.sqrt(variance);
  const threshold = mean + 2.5 * std;
  const peaks: { index: number; value: number; score: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] > threshold) {
      const score = Math.min(1, (samples[i] - mean) / (3 * std + 1));
      peaks.push({ index: i, value: samples[i], score });
    }
  }
  return peaks;
}

// Simulate audio peak detection: ~5-10 loud segments per VOD.
function detectAudioPeaks(durationSec: number, rng: () => number) {
  const count = 4 + Math.floor(rng() * 6);
  const peaks: { time: number; score: number }[] = [];
  for (let i = 0; i < count; i++) {
    peaks.push({
      time: rng() * (durationSec - 30) + 15,
      score: 0.4 + rng() * 0.5,
    });
  }
  return peaks;
}

// Simulate transcript highlights: pick 6-12 random timecodes.
function detectTranscriptPeaks(durationSec: number, rng: () => number) {
  const count = 6 + Math.floor(rng() * 7);
  const peaks: { time: number; score: number; phrase: string }[] = [];
  for (let i = 0; i < count; i++) {
    peaks.push({
      time: rng() * (durationSec - 30) + 15,
      score: 0.3 + rng() * 0.6,
      phrase: pick(HIGHLIGHT_PHRASES, rng),
    });
  }
  return peaks;
}

// Merge peaks that fall within `withinSec` of each other.
function mergeProximatePeaks(
  peaks: { time: number; score: number; phrase?: string; chatValue?: number }[],
  withinSec: number
) {
  if (peaks.length === 0) return [];
  const sorted = [...peaks].sort((a, b) => a.time - b.time);
  const merged: {
    time: number;
    score: number;
    phrase?: string;
    chatValue?: number;
  }[] = [];
  let current = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.time - current.time <= withinSec) {
      current.score = Math.max(current.score, next.score);
      if (next.chatValue) {
        current.chatValue = Math.max(current.chatValue ?? 0, next.chatValue);
      }
      if (next.phrase && (!current.phrase || next.score > current.score)) {
        current.phrase = next.phrase;
      }
      current.time = (current.time + next.time) / 2;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

function buildTranscript(peak: { time: number; phrase?: string }, rng: () => number, durationSec: number) {
  const template = pick(TRANSCRIPT_TEMPLATES, rng);
  const peakPhrase = peak.phrase ?? pick(HIGHLIGHT_PHRASES, rng);
  const filled = template.replace(/\{peak\}/g, peakPhrase);
  // Timestamp prefix
  const mm = Math.floor(peak.time / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(peak.time % 60)
    .toString()
    .padStart(2, "0");
  return `[${mm}:${ss}] ${filled}`;
}

// MAIN ENTRY: simulate analyzing a VOD and producing detected clips.
export function analyzeStream(
  vodUrl: string,
  durationSec: number,
  seedKey: string
): DetectedClip[] {
  const rng = seeded(seedKey + vodUrl + durationSec);

  const { samples, bucketSize } = simulateChatVelocity(durationSec, rng);
  const chatPeaksRaw = detectChatPeaks(samples).map((p) => ({
    time: p.index * bucketSize,
    score: p.score,
    chatValue: p.value,
  }));
  const audioPeaksRaw = detectAudioPeaks(durationSec, rng).map((p) => ({
    time: p.time,
    score: p.score,
  }));
  const transcriptPeaksRaw = detectTranscriptPeaks(durationSec, rng).map((p) => ({
    time: p.time,
    score: p.score,
    phrase: p.phrase,
  }));

  const merged = mergeProximatePeaks(
    [...chatPeaksRaw, ...audioPeaksRaw, ...transcriptPeaksRaw],
    15
  );

  // Sort by score descending, take top 20 max
  merged.sort((a, b) => b.score - a.score);
  const top = merged.slice(0, 20);

  const clips: DetectedClip[] = top.map((peak) => {
    // STRATEGY: start 15s before peak, end 30-75s after
    const start = Math.max(0, peak.time - 15);
    let end = Math.min(durationSec, peak.time + 30 + rng() * 45);

    // Enforce minimum 45s
    if (end - start < 45) {
      end = Math.min(durationSec, start + 45);
    }
    // Enforce maximum 90s
    if (end - start > 90) {
      end = start + 90;
    }

    const peakPhrase = peak.phrase ?? pick(HIGHLIGHT_PHRASES, rng);
    const transcript = buildTranscript(peak, rng, durationSec);

    // Engagement score: weighted blend of signals
    const chatBoost = peak.chatValue ? Math.min(0.3, peak.chatValue / 500) : 0;
    const engagementScore = Math.min(
      0.99,
      0.4 + peak.score * 0.4 + chatBoost + rng() * 0.1
    );

    return {
      startTimeSec: start,
      endTimeSec: end,
      suggestedStart: start,
      suggestedEnd: end,
      engagementScore: Number(engagementScore.toFixed(2)),
      chatVelocity: peak.chatValue ?? Math.round(20 + rng() * 100),
      transcript,
      peakPhrase,
      thumbnailUrl: "", // populated by client from video poster
    };
  });

  // Sort clips by start time
  clips.sort((a, b) => a.startTimeSec - b.startTimeSec);
  return clips;
}

// Pick a sample VOD by URL (falls back to the first sample if no match).
export function pickSampleVod(url: string) {
  const found = SAMPLE_VODS.find((v) => v.url === url);
  return found ?? SAMPLE_VODS[0];
}

// Generate a fake YouTube video ID (11 chars).
export function generateYoutubeId(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = "";
  for (let i = 0; i < 11; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Auto-generate a YouTube title from a clip's transcript peak phrase.
export function generateTitle(clip: Clip, streamerName: string | null | undefined): string {
  const peak = clip.peakPhrase ?? "Best Moment";
  const streamer = streamerName ?? "Streamer";
  // Variety: occasionally prepend "Best of"
  const variants = [
    `${peak} — ${streamer} Highlight`,
    `Best of ${streamer}: ${peak}`,
    `${streamer} | ${peak}`,
    `${peak} (${streamer} Clip)`,
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}
