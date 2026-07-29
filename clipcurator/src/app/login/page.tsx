"use client";

// Login page — renders the LoginView component.
//
// This route is NOT behind auth (the middleware skips /login).
// After successful login, redirect to the home page (or the `redirect`
// query param if present).

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { LoginView } from "@/components/clipcurator/login-view";
import { apiUrl } from "@/lib/constants";

export default function LoginPage() {
  const searchParams = useSearchParams();
  const redirectPath = searchParams.get("redirect") || "/";

  const onLogin = React.useCallback(() => {
    // After login, go to the redirect target (or home).
    // apiUrl() prepends the basePath (e.g. /clipcurator).
    window.location.href = apiUrl(redirectPath);
  }, [redirectPath]);

  return <LoginView onLogin={onLogin} />;
}
