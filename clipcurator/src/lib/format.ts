// Formatting + styling helpers shared across the ClipCurator UI.

import type { ClipStatus, SourceStatus } from "@/types";

/**
 * Format seconds as `M:SS` (or `H:MM:SS` for long durations).
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s
      .toString()
      .padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Tailwind badge classes for a given clip status.
 * PENDING=amber, IN_REVIEW=blue, APPROVED_A=emerald, APPROVED_B=blue,
 * REJECTED=rose, PUBLISHING=blue (pulse), PUBLISHED=emerald, FAILED=rose.
 */
export function statusBadgeClass(status: string | undefined | null): string {
  switch (status) {
    case "PENDING":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    case "IN_REVIEW":
      return "bg-sky-500/15 text-sky-300 border-sky-500/30";
    case "APPROVED_A":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "APPROVED_B":
      return "bg-blue-500/15 text-blue-300 border-blue-500/30";
    case "REJECTED":
    case "FAILED":
      return "bg-rose-500/15 text-rose-300 border-rose-500/30";
    case "PUBLISHING":
      return "bg-blue-500/15 text-blue-300 border-blue-500/30 animate-pulse";
    case "PUBLISHED":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    default:
      return "bg-zinc-500/15 text-zinc-300 border-zinc-500/30";
  }
}

/**
 * Human-readable label for a clip status.
 */
export function statusLabel(status: string | undefined | null): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "IN_REVIEW":
      return "In Review";
    case "APPROVED_A":
      return "Approved A";
    case "APPROVED_B":
      return "Approved B";
    case "REJECTED":
      return "Rejected";
    case "PUBLISHING":
      return "Publishing";
    case "PUBLISHED":
      return "Published";
    case "FAILED":
      return "Failed";
    default:
      return "—";
  }
}

/**
 * Tailwind badge classes for a given stream-source status.
 */
export function sourceStatusBadgeClass(
  status: string | undefined | null
): string {
  switch (status) {
    case "PENDING":
      return "bg-amber-500/15 text-amber-300 border-amber-500/30";
    case "DOWNLOADING":
      return "bg-sky-500/15 text-sky-300 border-sky-500/30 animate-pulse";
    case "ANALYZING":
      return "bg-blue-500/15 text-blue-300 border-blue-500/30 animate-pulse";
    case "READY":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "FAILED":
      return "bg-rose-500/15 text-rose-300 border-rose-500/30";
    default:
      return "bg-zinc-500/15 text-zinc-300 border-zinc-500/30";
  }
}

export function sourceStatusLabel(
  status: string | undefined | null
): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "DOWNLOADING":
      return "Downloading";
    case "ANALYZING":
      return "Analyzing";
    case "READY":
      return "Ready";
    case "FAILED":
      return "Failed";
    default:
      return "—";
  }
}

/** Platform badge class for TWITCH / YOUTUBE. */
export function platformBadgeClass(platform: string | undefined | null): string {
  switch (platform) {
    case "TWITCH":
      return "bg-purple-500/15 text-purple-300 border-purple-500/30";
    case "YOUTUBE":
      return "bg-red-500/15 text-red-300 border-red-500/30";
    default:
      return "bg-zinc-500/15 text-zinc-300 border-zinc-500/30";
  }
}

/**
 * Relative-time formatter (e.g. "5m ago", "2h ago", "3d ago").
 * Falls back to a short absolute date for old items.
 */
export function relativeTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Truncate a long string for table display. */
export function truncate(s: string | null | undefined, max = 48): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Color class for trim duration feedback. */
export function durationQualityClass(seconds: number): string {
  if (seconds < 30) return "text-rose-400";
  if (seconds < 45) return "text-amber-400";
  if (seconds <= 90) return "text-emerald-400";
  return "text-amber-400";
}

/** Map a `publishedTo` channel to a short badge label. */
export function channelLabel(
  channel: string | null | undefined
): string | null {
  if (channel === "CHANNEL_A") return "Channel A";
  if (channel === "CHANNEL_B") return "Channel B";
  return null;
}

export type { ClipStatus, SourceStatus };
