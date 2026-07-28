import type { Platform } from "@/types";

// Channel A and B branding
export const CHANNELS = {
  CHANNEL_A: {
    id: "CHANNEL_A",
    label: "Channel A",
    color: "emerald",
    tailwind: "bg-emerald-500 hover:bg-emerald-600 text-white",
    accent: "text-emerald-400",
    description: "Main highlights channel",
  },
  CHANNEL_B: {
    id: "CHANNEL_B",
    label: "Channel B",
    color: "blue",
    tailwind: "bg-blue-500 hover:bg-blue-600 text-white",
    accent: "text-blue-400",
    description: "Secondary clips channel",
  },
} as const;

export function urlPlatform(url: string): Platform {
  const lower = url.toLowerCase();
  if (lower.includes("twitch.tv")) return "TWITCH";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "YOUTUBE";
  // Default to TWITCH for unknown URLs
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
