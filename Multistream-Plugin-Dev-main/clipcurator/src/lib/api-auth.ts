/**
 * Shared auth-check utility for ClipCurator API routes.
 *
 * Returns null if the request is authenticated (or if no password is configured),
 * or a NextResponse with 401 if not authenticated.
 *
 * Usage in route handlers:
 *   const deny = await checkApiAuth(req);
 *   if (deny) return deny;
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "./require-auth";

export function checkApiAuth(req: NextRequest): NextResponse | null {
  const result = requireAuth(req.headers.get("cookie") || "");

  if (!result.authenticated) {
    return NextResponse.json(
      { error: "Authentication required. Log in via /api/auth/login." },
      { status: 401 }
    );
  }

  return null; // authenticated — proceed
}
