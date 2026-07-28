import { NextRequest, NextResponse } from "next/server";
import {
  checkPassword,
  createSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  isPasswordConfigured,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/login — submit password, get session cookie
export async function POST(req: NextRequest) {
  try {
    // If no password configured, auto-login (any request succeeds)
    if (!isPasswordConfigured()) {
      const token = createSession();
      return NextResponse.json(
        { ok: true, message: "No password configured — auto-login" },
        { headers: { "Set-Cookie": sessionCookieHeader(token) } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const password: string = (body?.password ?? "").trim();

    if (!password) {
      return NextResponse.json(
        { error: "password is required" },
        { status: 400 }
      );
    }

    if (checkPassword(password)) {
      const token = createSession();
      return NextResponse.json(
        { ok: true },
        { headers: { "Set-Cookie": sessionCookieHeader(token) } }
      );
    } else {
      return NextResponse.json(
        { error: "Incorrect password" },
        { status: 401 }
      );
    }
  } catch (err) {
    console.error("[POST /api/auth/login]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 }
    );
  }
}

// POST /api/auth/logout — clear session
export async function DELETE() {
  return NextResponse.json(
    { ok: true },
    { headers: { "Set-Cookie": clearSessionCookieHeader() } }
  );
}

// GET /api/auth/login — check if auth is required & configured
export async function GET() {
  return NextResponse.json({
    requiresAuth: isPasswordConfigured(),
  });
}
