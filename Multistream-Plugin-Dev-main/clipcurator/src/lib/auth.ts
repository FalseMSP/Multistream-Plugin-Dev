/**
 * ClipCurator auth — mirrors the multistream dashboard password + session approach.
 *
 * Uses DASHBOARD_PASSWORD from the parent project's .env (same env var the
 * multistream dashboard uses). Sessions are in-process (Map<token, expiry>)
 * with HttpOnly / SameSite=Strict cookies, 8h lifetime — identical semantics
 * to src/dashboard/auth.js in the multistream bot.
 *
 * Every ClipCurator API route (except /api/auth/login) requires a valid session
 * cookie. The frontend shows a login page if unauthenticated.
 */

import crypto from "crypto";

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? "";
const COOKIE_NAME = "cc_session";
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

/** Active session tokens → expiry timestamp */
const _sessions = new Map<string, number>();

export function isPasswordConfigured(): boolean {
  return !!DASHBOARD_PASSWORD;
}

export function getPassword(): string {
  return DASHBOARD_PASSWORD;
}

export function getCookieName(): string {
  return COOKIE_NAME;
}

export function getCookieMaxAge(): number {
  return COOKIE_MAX_AGE;
}

export function createSession(): string {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + COOKIE_MAX_AGE * 1000;
  _sessions.set(token, expires);
  return token;
}

export function isValidSession(token: string | null): boolean {
  if (!token) return false;
  const expires = _sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) {
    _sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string | null): void {
  if (token) _sessions.delete(token);
}

/** Parse Cookie header into a key→value map */
export function parseCookies(cookieHeader: string): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((c) => c.trim().split("=").map(decodeURIComponent))
  );
}

/** Extract the session token from a request's Cookie header */
export function getSessionToken(cookieHeader: string): string | null {
  return parseCookies(cookieHeader)[COOKIE_NAME] ?? null;
}

/** Check if a request is authenticated */
export function isAuthenticated(cookieHeader: string): boolean {
  return isValidSession(getSessionToken(cookieHeader));
}

/** Constant-time password comparison (same algorithm as multistream auth.js) */
export function checkPassword(submitted: string): boolean {
  if (!DASHBOARD_PASSWORD || !submitted) return false;
  const a = Buffer.from(String(submitted));
  const b = Buffer.from(DASHBOARD_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Build Set-Cookie header for a freshly-created session token */
export function sessionCookieHeader(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; Path=/`;
}

/** Build Set-Cookie header that clears the session cookie */
export function clearSessionCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/`;
}
