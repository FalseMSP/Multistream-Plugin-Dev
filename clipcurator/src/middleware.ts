import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, isPasswordConfigured } from "@/lib/auth";

/**
 * ClipCurator middleware — validates the `cc_session` cookie against
 * the in-process session store (src/lib/auth.ts).
 *
 * Uses the SAME password as the multistream dashboard (DASHBOARD_PASSWORD
 * env var). Sessions are independent — logging into the dashboard doesn't
 * log you into ClipCurator and vice versa — but the password is the same.
 *
 * Unauthenticated requests are redirected to /login (same origin).
 * API routes get a 401 JSON response instead of a redirect (so fetch()
 * calls don't silently follow a redirect to an HTML page).
 *
 * Paths that skip auth:
 *   /login            — the login page itself
 *   /api/auth/*       — login, logout, check endpoints
 *   /_next, /favicon  — static assets
 */

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
  if (!isPasswordConfigured()) {
    return NextResponse.next();
  }

  // Check session cookie against in-memory store
  const cookieHeader = request.headers.get("cookie") ?? "";
  if (isAuthenticated(cookieHeader)) {
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
  // Preserve the original URL as a redirect param so we can send the user
  // back after they log in.
  loginUrl.search = "";
  loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on Node.js runtime so we can import src/lib/auth.ts (which uses
  // Node.js crypto for session tokens + password comparison).
  runtime: "nodejs" as const,
  // Match all request paths except static internals.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|logo.svg).*)",
  ],
};
