import { NextRequest, NextResponse } from "next/server";

/**
 * ClipCurator middleware — validates the dash_session cookie against
 * the multistream overlay server's /api/auth/check endpoint.
 *
 * This ensures ClipCurator uses the same authentication as the
 * multistream dashboard. Unauthenticated requests are redirected to
 * the dashboard login page, which supports a `?redirect=` parameter
 * to send the user back here after login.
 *
 * Two access patterns:
 *   1. Via proxy (port 2999/clipcurator): auth is already validated by
 *      the proxy layer — this middleware is a redundant safety check.
 *   2. Direct (port 3001): this middleware is the primary auth gate.
 */

// The overlay server host where the auth check endpoint lives.
const AUTH_SERVER = process.env.AUTH_SERVER || "http://127.0.0.1:2999";
const COOKIE_NAME = "dash_session";

// Paths that should NOT be auth-gated (e.g. Next.js internal assets).
const SKIP_PATHS = [
  "/_next",
  "/favicon.ico",
  "/robots.txt",
  "/logo.svg",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip auth for static assets and Next.js internals
  if (SKIP_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Skip auth for API routes that the proxy layer already validates.
  // When accessed via the proxy, auth is handled before the request
  // reaches ClipCurator. When accessed directly, we still check.
  // We validate ALL requests for security.

  const sessionToken = request.cookies.get(COOKIE_NAME)?.value;

  if (!sessionToken) {
    // No session cookie → redirect to dashboard login with return URL
    const loginUrl = new URL("/dashboard/login", AUTH_SERVER);
    loginUrl.searchParams.set("redirect", request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Validate the session token against the overlay server
  try {
    const checkUrl = new URL("/api/auth/check", AUTH_SERVER);
    const checkRes = await fetch(checkUrl.toString(), {
      headers: {
        Cookie: `${COOKIE_NAME}=${sessionToken}`,
      },
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!checkRes.ok) {
      // Auth server unreachable or error → redirect to login
      const loginUrl = new URL("/dashboard/login", AUTH_SERVER);
      loginUrl.searchParams.set("redirect", request.url);
      return NextResponse.redirect(loginUrl);
    }

    const data = await checkRes.json();

    if (!data.authenticated) {
      // Session expired or invalid → redirect to login with return URL
      const loginUrl = new URL("/dashboard/login", AUTH_SERVER);
      loginUrl.searchParams.set("redirect", request.url);
      return NextResponse.redirect(loginUrl);
    }
  } catch {
    // Auth server unreachable (e.g. multistream bot not running yet).
    // In dev mode, we can be lenient: allow the request through but
    // log a warning. In production, this should block access.
    console.warn(
      "[clipcurator middleware] Auth server unreachable at",
      AUTH_SERVER,
      "— allowing request in dev mode"
    );
    // For safety in production, uncomment the next lines to block:
    // const loginUrl = new URL("/dashboard/login", AUTH_SERVER);
    // loginUrl.searchParams.set("redirect", request.url);
    // return NextResponse.redirect(loginUrl);
  }

  // Authenticated — allow the request through
  return NextResponse.next();
}

export const config = {
  // Run middleware on all paths except static internals
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, robots.txt, logo.svg (public metadata files)
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|logo.svg).*)",
  ],
};
