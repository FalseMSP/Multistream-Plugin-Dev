/**
 * requireAuth — middleware helper for ClipCurator API routes.
 *
 * Reads the session cookie from the request, validates it against the
 * in-process session store, and returns the session token if valid.
 * If invalid, returns null (caller should respond with 401).
 */

import {
  isAuthenticated,
  getSessionToken,
  isPasswordConfigured,
} from "./auth";

export interface AuthResult {
  authenticated: boolean;
  token: string | null;
}

/**
 * Check auth on an incoming Next.js API request.
 * Returns { authenticated: true, token } if the session cookie is valid,
 * or { authenticated: false, token: null } if not.
 *
 * If DASHBOARD_PASSWORD is not configured, all requests are allowed
 * (mirrors the multistream dashboard's behaviour).
 */
export function requireAuth(cookieHeader: string): AuthResult {
  // If no password is set, auth is bypassed (open access like the bot dashboard)
  if (!isPasswordConfigured()) {
    return { authenticated: true, token: null };
  }

  const token = getSessionToken(cookieHeader);
  if (isAuthenticated(cookieHeader)) {
    return { authenticated: true, token };
  }

  return { authenticated: false, token: null };
}
