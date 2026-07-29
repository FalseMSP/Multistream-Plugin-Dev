import type { Platform } from "@/types";

// ─── basePath-aware API helper ──────────────────────────────────────────────
// Next.js auto-prefixes <Link> and <Image> with basePath, but raw fetch() and
// EventSource calls are NOT auto-prefixed. Without this, every API call from
// the browser hits the server root (/api/...) instead of /clipcurator/api/...
// and 404s — which makes every button silently fail.
//
// Keep this in sync with `basePath` in next.config.ts. If you change one,
// change the other (or set NEXT_PUBLIC_BASE_PATH env var to override both).
export const API_BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "/clipcurator";

export function apiUrl(path: string): string {
  // Avoid double-slash if caller accidentally passes "/api/..." with leading /
  // and API_BASE already ends in /clipcurator (no trailing slash).
  if (path.startsWith("/")) return `${API_BASE}${path}`;
  return `${API_BASE}/${path}`;
}
// ─────────────────────────────────────────────────────────────────────────────

// Channel A and B branding defaults.
// Actual labels are user-editable via the Settings page and stored in the
// Channel table. These are just fallbacks for when the DB rows don't exist yet.
export const CHANNEL_DEFAULTS = {
  CHANNEL_A: {
    id: "CHANNEL_A" as const,
    label: "Channel A",
    tailwind: "bg-emerald-500 hover:bg-emerald-600 text-white",
    accent: "text-emerald-400",
    description: "Primary highlights channel",
    tokenFile: ".youtube-tokens.json",
  },
  CHANNEL_B: {
    id: "CHANNEL_B" as const,
    label: "Channel B",
    tailwind: "bg-blue-500 hover:bg-blue-600 text-white",
    accent: "text-blue-400",
    description: "Secondary clips channel",
    tokenFile: ".youtube-tokens-b.json",
  },
} as const;

export function urlPlatform(url: string): Platform {
  const lower = url.toLowerCase();
  if (lower.includes("twitch.tv")) return "TWITCH";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "YOUTUBE";
  // Default to TWITCH for unknown URLs — the clipper will try yt-dlp anyway.
  return "TWITCH";
}

export function isValidStreamUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
