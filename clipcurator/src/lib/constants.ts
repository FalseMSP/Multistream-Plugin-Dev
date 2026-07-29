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

// Public-domain sample VODs used as mock "downloaded streams"
// (avoids needing real yt-dlp / Twitch API access in the sandbox)
export const SAMPLE_VODS: {
  url: string;
  title: string;
  streamerName: string;
  platform: Platform;
  durationSec: number;
  poster: string;
}[] = [
  {
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    title: "Big Buck Bunny — Live Stream Replay",
    streamerName: "BigBunnyLive",
    platform: "TWITCH",
    durationSec: 596,
    poster:
      "https://image.tmdb.org/t/p/original/2pZdtkrM7DuTk1iN4DIdH8m0HoQ.jpg",
  },
  {
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    title: "Elephants Dream — Premiere Stream",
    streamerName: "OrangeAnimation",
    platform: "YOUTUBE",
    durationSec: 653,
    poster:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Elephants_Dream_s5_both.jpg/1280px-Elephants_Dream_s5_both.jpg",
  },
  {
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    title: "For Bigger Blazes — Gaming Marathon",
    streamerName: "BiggerBlazes",
    platform: "TWITCH",
    durationSec: 15,
    poster: "",
  },
  {
    url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
    title: "Sintel — Cinematic Playthrough",
    streamerName: "SintelGameplay",
    platform: "TWITCH",
    durationSec: 888,
    poster:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/Sintel_poster.jpg/800px-Sintel_poster.jpg",
  },
];

// Realistic streamer highlight phrases (mock Whisper output)
export const HIGHLIGHT_PHRASES = [
  "LET'S GOOOO!",
  "No way that just happened",
  "Chat, are you seeing this?",
  "HOLY — did you see that?!",
  "Clip it, clip it, CLIP IT",
  "That's a new PB chat",
  "GG chat, GG",
  "Wait wait wait — hold up",
  "That was absolutely insane",
  "I can't believe we pulled that off",
  "Pog moment right there",
  "Absolute cinema",
  "Chat we are COOKED",
  "Stop — rewind that",
  "Easiest W of my life",
  "Bro I'm actually crying",
  "Killer play, killer play",
  "We're so back",
  "It's over, it's finally over",
  "Sub goal smashed chat",
];

// Mock transcript templates
export const TRANSCRIPT_TEMPLATES = [
  "All right chat let's see what we can do here. {peak} I genuinely did not think that would work. {peak} Okay calm down, calm down. {peak} Where did that even come from? I'm actually shaking. {peak} Chat you're insane today, I love it.",
  "So I've been grinding this for like three hours. {peak} And we finally got it. {peak} I told you the strat works, I told you! {peak} Look at that gameplay, look at it. {peak} This is going on the highlight reel for sure.",
  "Chat, real talk for a second. {peak} This community is unreal. {peak} We hit the goal, we hit sub goal, we hit everything. {peak} I could not do this without you. {peak} Absolute legends, every single one of you.",
  "We are ENTERING the final boss. {peak} Big breath chat, big breath. {peak} Okay here we go, no hesitation. {peak} YES, YES, YES! {peak} Did you see that dodge? Frame perfect baby!",
  "Okay so the plan was simple. {peak} But then everything went sideways. {peak} And somehow we still came out on top. {peak} That's the content right there. {peak} That's why we stream, chat. That's why we stream.",
];

export function urlPlatform(url: string): Platform {
  const lower = url.toLowerCase();
  if (lower.includes("twitch.tv")) return "TWITCH";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "YOUTUBE";
  // For sandbox: accept any URL — default to TWITCH
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
