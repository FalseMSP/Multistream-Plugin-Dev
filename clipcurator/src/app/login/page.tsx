"use client";

// Login page — renders the LoginView component.
//
// This route is NOT behind auth (the middleware skips /login).
// After successful login, redirect to the home page (or the `redirect`
// query param if present).
//
// IMPORTANT: In Next.js 16, useSearchParams() requires a <Suspense>
// boundary around the component that calls it. Without it, the page
// throws during SSR and renders blank — which looks like "the login
// prompt never appears". We wrap the inner component in <Suspense>.

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { LoginView } from "@/components/clipcurator/login-view";
import { apiUrl } from "@/lib/constants";

function LoginRedirectHandler() {
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "/";

  const onLogin = React.useCallback(() => {
    // After login, go to the redirect target (or home).
    // apiUrl() prepends the basePath (e.g. /clipcurator).
    window.location.href = apiUrl(redirectPath);
  }, [redirectPath]);

  return <LoginView onLogin={onLogin} />;
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="text-sm text-zinc-500">Loading…</div>
        </div>
      }
    >
      <LoginRedirectHandler />
    </Suspense>
  );
}
