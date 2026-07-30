import { NextRequest, NextResponse } from "next/server";

/**
 * ClipCurator middleware — lightweight auth gate.
 *
 * IMPORTANT: Next.js middleware runs on the Edge runtime, which does NOT
 * have Node.js APIs (no `node:crypto`, no `fs`, etc.). So this middleware
 * does NOT import src/lib/auth.ts. Instead it does a lightweight cookie
 * presence check + redirect logic.
 *
 * The actual session validation (is the token in the in-memory store?)
 * happens in the API routes via requireAuth() from src/lib/require-auth.ts.
 *
 * If DASHBOARD_PASSWORD is not set, all requests are allowed (open access,
 * same as the dashboard).
 *
 * Paths that skip auth:
 *   /login            — the login page itself
 *   /api/auth/*       — login, logout, check endpoints
 *   /_next, /favicon  — static assets
 *   /vod, /vods       — VOD video files (served by clipper via rewrite)
 *   /clip, /clips     — rendered clip files (served by clipper via rewrite)
 *   /backing          — backing track audio files (served by clipper via rewrite)
 *
 * Video/audio file paths skip auth because:
 *   1. The <video> element can't handle a redirect to /login (gets HTML, fails silently)
 *   2. The videoUrl is only returned by /api/queue/next which already requires auth
 *   3. The source IDs in the paths are CUIDs — not guessable
 */

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? "";
const SESSION_COOKIE_NAME = "cc_session";

// Paths that should NOT be auth-gated.
// These are basePath-stripped (e.g. /clipcurator/login → /login).
const SKIP_PREFIXES = [
  "/login",
  "/_next",
  "/favicon.ico",
  "/robots.txt",
  "/logo.svg",
  "/api/auth",
  // Static file paths — served by clipper via next.config.ts rewrites.
  // These MUST skip auth because <video>/<audio> elements can't handle
  // redirects to /login (they'd get HTML instead of the media file).
  "/vod",
  "/vods",
  "/clip",
  "/clips",
  "/backing",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip auth for login page, auth API, static assets, and media files
  if (SKIP_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // If no password configured, auto-allow (open access — same as dashboard)
  if (!DASHBOARD_PASSWORD) {
    return NextResponse.next();
  }

  // Lightweight cookie presence check.
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionCookie) {
    return NextResponse.next();
  }

  // Not authenticated.
  // For API routes: return 401 JSON so fetch() callers get a clean error.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Not authenticated", requiresAuth: true },
      { status: 401 }
    );
  }

  // For page routes: redirect to /login (same origin, basePath-aware).
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|logo.svg).*)",
  ],
};
