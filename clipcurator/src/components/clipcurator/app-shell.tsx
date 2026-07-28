"use client";

// App shell — auth gate + sticky header with logo + nav + queue badge + active view below.
// If DASHBOARD_PASSWORD is set in .env, the user must log in before accessing
// any content. Auth mirrors the multistream dashboard's cookie-based approach.

import * as React from "react";
import {
  LayoutDashboard,
  ListVideo,
  History,
  Settings2,
  Scissors,
  Menu,
  LogOut,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { useQueueSse } from "@/hooks/use-queue-sse";
import { useQueueStore } from "@/store/queue";
import { useStats } from "@/hooks/use-clipcurator";

import { DashboardView } from "./dashboard-view";
import { QueueView } from "./queue-view";
import { HistoryView } from "./history-view";
import { AdminStreamsView } from "./admin-streams-view";
import { LoginView } from "./login-view";

type View = "dashboard" | "queue" | "history" | "admin";

const NAV: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard className="size-4" /> },
  { id: "queue", label: "Queue", icon: <ListVideo className="size-4" /> },
  { id: "history", label: "History", icon: <History className="size-4" /> },
  { id: "admin", label: "Admin", icon: <Settings2 className="size-4" /> },
];

export function AppShell() {
  const [authenticated, setAuthenticated] = React.useState<boolean | null>(null);
  const [requiresAuth, setRequiresAuth] = React.useState(true);
  const [view, setView] = React.useState<View>("dashboard");

  // Hooks must be called unconditionally — we use them in the authenticated UI
  useQueueSse();
  const stats = useStats();
  const storeStats = useQueueStore((s) => s.stats);
  const queueLength = useQueueStore((s) => s.queueLength);
  const pending =
    storeStats.pending || stats.data?.pending || queueLength || 0;

  // Check auth status on mount
  React.useEffect(() => {
    (async () => {
      try {
        const authRes = await fetch("/api/auth/login");
        const authData = await authRes.json();
        setRequiresAuth(authData.requiresAuth ?? true);

        if (!authData.requiresAuth) {
          setAuthenticated(true);
          return;
        }

        const testRes = await fetch("/api/stats");
        if (testRes.ok) {
          setAuthenticated(true);
        } else if (testRes.status === 401) {
          setAuthenticated(false);
        } else {
          setAuthenticated(false);
        }
      } catch {
        setAuthenticated(false);
      }
    })();
  }, []);

  const onLoginSuccess = () => setAuthenticated(true);

  const logout = async () => {
    try { await fetch("/api/auth/login", { method: "DELETE" }); } catch {}
    setAuthenticated(false);
  };

  const navigate = (v: View) => setView(v);

  // Loading state
  if (authenticated === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-zinc-500">
          <Scissors className="size-5 animate-pulse text-emerald-400" />
          <span className="text-sm">Loading ClipCurator…</span>
        </div>
      </div>
    );
  }

  // Not authenticated — show login
  if (!authenticated) {
    return <LoginView onLogin={onLoginSuccess} />;
  }

  // Authenticated — show main app
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-50 h-14 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/60">
        <div className="mx-auto flex h-full w-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
              <Scissors className="size-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight text-zinc-100 sm:text-base">
              ClipCurator
            </span>
          </div>

          {/* Center nav (desktop) */}
          <nav className="ml-4 hidden items-center gap-1 md:flex">
            {NAV.map((item) => {
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate(item.id)}
                  className={cn(
                    "relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition",
                    active
                      ? "text-emerald-300"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  )}
                >
                  {item.icon}
                  {item.label}
                  {active && (
                    <span className="absolute -bottom-[1px] left-2 right-2 h-0.5 rounded-full bg-emerald-500" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                "border-zinc-700 px-2 py-1 text-xs tabular-nums",
                pending > 0
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 animate-pulse"
                  : "bg-zinc-900 text-zinc-500"
              )}
              aria-label={`${pending} clips pending review`}
            >
              <span
                className={cn(
                  "mr-1 inline-block size-1.5 rounded-full",
                  pending > 0 ? "bg-emerald-400" : "bg-zinc-600"
                )}
              />
              Queue: {pending} pending
            </Badge>

            <Avatar className="size-8 ring-1 ring-zinc-700">
              <AvatarFallback className="bg-zinc-800 text-xs text-zinc-300">
                RV
              </AvatarFallback>
            </Avatar>

            {requiresAuth && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-zinc-400 hover:text-zinc-200"
                onClick={logout}
                aria-label="Sign out"
              >
                <LogOut className="size-4" />
              </Button>
            )}

            {/* Mobile nav trigger */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 md:hidden"
                  aria-label="Open navigation"
                >
                  <Menu className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel className="text-zinc-400">
                  Navigate
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {NAV.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    onClick={() => navigate(item.id)}
                    className={cn(
                      view === item.id && "bg-zinc-800/60 text-emerald-300"
                    )}
                  >
                    {item.icon}
                    {item.label}
                  </DropdownMenuItem>
                ))}
                {requiresAuth && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={logout} className="text-rose-300">
                      <LogOut className="size-4" />
                      Sign out
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Active view */}
      <main className="flex-1">
        {view === "dashboard" && <DashboardView onNavigate={navigate} />}
        {view === "queue" && <QueueView onNavigate={navigate} />}
        {view === "history" && <HistoryView />}
        {view === "admin" && <AdminStreamsView />}
      </main>
    </div>
  );
}
