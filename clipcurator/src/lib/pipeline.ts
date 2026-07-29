// Title generation for YouTube uploads.
//
// The rest of the old mock pipeline (analyzeStream, pickSampleVod,
// generateYoutubeId) has been removed — real video processing now lives
// in the Python clipper backend (clipper/clipper.py) and is called via
// src/lib/clipper-client.ts.

import type { Clip } from "@/types";

// Auto-generate a YouTube title from a clip's peak phrase + streamer name.
//
// Called by the publish job (src/lib/queue.ts → runPublishToYoutube) right
// before handing the title to the clipper's /publish endpoint.
export function generateTitle(
  clip: Clip,
  streamerName: string | null | undefined
): string {
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

// Convert a list of subtitle segments to WebVTT format.
// Used by the subtitle editor when saving user edits.
export function segmentsToVtt(
  segments: { start: number; end: number; text: string }[]
): string {
  const lines = ["WEBVTT", ""];
  for (const seg of segments) {
    lines.push(formatVttTimestamp(seg.start) + " --> " + formatVttTimestamp(seg.end));
    lines.push(seg.text);
    lines.push("");
  }
  return lines.join("\n");
}

// Convert WebVTT content back to segment list.
// Used when loading an existing VTT into the editor.
export function vttToSegments(vtt: string): { start: number; end: number; text: string }[] {
  const segments: { start: number; end: number; text: string }[] = [];
  const blocks = vtt.replace(/^WEBVTT\s*\n/i, "").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    // Skip cue identifier line if present (e.g. "1", "2", ...)
    let timecodeLine = lines[0];
    let textLines = lines.slice(1);
    if (!timecodeLine.includes("-->")) {
      timecodeLine = lines[1];
      textLines = lines.slice(2);
    }
    const match = timecodeLine.match(
      /([\d:.]+)\s*-->\s*([\d:.]+)/
    );
    if (!match) continue;
    const start = parseVttTimestamp(match[1]);
    const end = parseVttTimestamp(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    segments.push({ start, end, text: textLines.join("\n").trim() });
  }
  return segments;
}

function formatVttTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

function parseVttTimestamp(ts: string): number {
  const match = ts.match(/(\d+):(\d+):(\d+)\.(\d+)/);
  if (!match) {
    // Try without hours
    const m2 = ts.match(/(\d+):(\d+)\.(\d+)/);
    if (!m2) return NaN;
    return Number(m2[1]) * 60 + Number(m2[2]) + Number(m2[3]) / 1000;
  }
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, "0");
}
