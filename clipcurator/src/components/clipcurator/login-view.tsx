"use client";

import * as React from "react";
import { Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiUrl } from "@/lib/constants";

interface LoginViewProps {
  onLogin: () => void;
}

export function LoginView({ onLogin }: LoginViewProps) {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        onLogin();
      } else {
        const data = await res.json().catch(() => ({ error: "Login failed" }));
        setError(data.error || "Incorrect password");
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm border-zinc-800 bg-card">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
            <Scissors className="size-5" />
          </div>
          <CardTitle className="text-lg font-semibold text-zinc-100">
            ClipCurator
          </CardTitle>
          <p className="text-xs text-zinc-500">
            Enter the dashboard password to continue
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Dashboard password"
              autoFocus
              autoComplete="current-password"
              className="h-10"
              disabled={loading}
            />
            <Button
              type="submit"
              disabled={!password.trim() || loading}
              className="h-10 w-full bg-emerald-500 text-white hover:bg-emerald-600"
            >
              {loading ? "Signing in…" : "Sign in"}
            </Button>
            {error && (
              <p className="text-center text-sm text-rose-400">{error}</p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
