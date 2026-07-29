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
 * This means:
 *
 *   - Page routes: middleware checks cookie presence → redirect to /login
 *     if missing. (A present-but-invalid cookie would let the page render,
 *     but every API call would 401 and the client-side fetchJson handler
 *     would then redirect to /login. Slight redundancy, acceptable UX.)
 *
 *   - API routes: middleware checks cookie presence → 401 if missing.
 *     The route handler then calls requireAuth() to validate the session
 *     against the in-memory store.
 *
 * If DASHBOARD_PASSWORD is not set, all requests are allowed (open access,
 * same as the dashboard).
 *
 * Paths that skip auth:
 *   /login            — the login page itself
 *   /api/auth/*       — login, logout, check endpoints
 *   /_next, /favicon  — static assets
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
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip auth for login page, auth API, and static assets
  if (SKIP_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // If no password configured, auto-allow (open access — same as dashboard)
  if (!DASHBOARD_PASSWORD) {
    return NextResponse.next();
  }

  // Lightweight cookie presence check.
  // (Real session validation happens in the API route via requireAuth().)
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionCookie) {
    // Cookie present — let the request through. API routes will validate
    // the token against the in-memory session store.
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
  // request.nextUrl.clone() preserves the basePath — setting pathname to
  // "/login" produces a redirect to /clipcurator/login.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Match all request paths except static internals.
  // Note: middleware always runs on the Edge runtime in Next.js — do NOT
  // set `runtime` here (it's only valid on route handlers / pages, and
  // setting it on middleware causes a compile error).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|logo.svg).*)",
  ],
};
