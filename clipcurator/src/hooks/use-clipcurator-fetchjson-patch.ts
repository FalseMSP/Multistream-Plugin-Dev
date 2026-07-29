// PATCH for src/hooks/use-clipcurator.ts
//
// Replace the fetchJson function (lines 37-47 in the v2 file) with this version
// that auto-redirects to /login on 401.
//
// The only change is adding the `if (res.status === 401)` block before the
// `if (!res.ok)` check.

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  // Session expired or not authenticated → redirect to login page.
  // The middleware returns 401 JSON for API routes when there's no valid
  // cc_session cookie. Instead of showing an error toast, send the user
  // to the login page so they can re-authenticate.
  if (res.status === 401) {
    if (typeof window !== "undefined") {
      // Preserve the current path so we can redirect back after login.
      const currentPath = window.location.pathname + window.location.search;
      const loginUrl = apiUrl(`/login?redirect=${encodeURIComponent(currentPath)}`);
      window.location.href = loginUrl;
    }
    throw new Error("Session expired — redirecting to login");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "request failed");
  }
  return res.json() as Promise<T>;
}
