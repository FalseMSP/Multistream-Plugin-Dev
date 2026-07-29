"use client";

// Dashboard view: KPI stat cards + submit-stream form + recent streams list.
//
// All fake/demo data has been removed. The only way to populate the system
// is to submit a real Twitch/YouTube VOD URL.

import * as React from "react";
import { motion } from "framer-motion";
import {
  Activity,
  CheckCircle2,
  Clock,
  Film,
  Rocket,
  XCircle,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

import { useStats, useStreams, useSubmitStream } from "@/hooks/use-clipcurator";
import { isValidStreamUrl } from "@/lib/constants";
import {
  platformBadgeClass,
  relativeTime,
  sourceStatusBadgeClass,
  sourceStatusLabel,
} from "@/lib/format";
import { cn } from "@/lib/utils";

interface DashboardViewProps {
  onNavigate: (view: "dashboard" | "queue" | "history" | "admin" | "settings") => void;
}

export function DashboardView({ onNavigate }: DashboardViewProps) {
  const stats = useStats();
  const streams = useStreams();
  const submit = useSubmitStream();

  const [url, setUrl] = React.useState("");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || !isValidStreamUrl(trimmed)) return;
    submit.mutate(trimmed);
    setUrl("");
  };

  const s = stats.data;
  const pending = s?.pending ?? 0;
  const publishedToday = s?.publishedToday ?? 0;
  const rejectionRate = s?.rejectionRate ?? 0;
  const totalClips = s?.totalClips ?? 0;
  const streamsReady = s?.streamsReady ?? 0;
  const totalStreams = s?.streams ?? 0;
  const failed = s?.failed ?? 0;

  const recentStreams = (streams.data?.sources ?? []).slice(0, 5);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          icon={<Clock className="size-4" />}
          accent="emerald"
          label="Pending Review"
          value={pending}
          sublabel="Awaiting decision"
          loading={stats.isLoading}
        />
        <StatCard
          icon={<CheckCircle2 className="size-4" />}
          accent="blue"
          label="Published Today"
          value={publishedToday}
          sublabel="Live on YouTube"
          loading={stats.isLoading}
        />
        <StatCard
          icon={<XCircle className="size-4" />}
          accent="rose"
          label="Rejection Rate"
          value={`${rejectionRate}%`}
          sublabel="Today's rejected share"
          loading={stats.isLoading}
        />
        <StatCard
          icon={<Film className="size-4" />}
          accent="zinc"
          label="Total Clips"
          value={totalClips}
          sublabel="All-time detected"
          loading={stats.isLoading}
        />
        <StatCard
          icon={<Activity className="size-4" />}
          accent="zinc"
          label="Streams Processed"
          value={`${streamsReady} / ${totalStreams}`}
          sublabel="Ready / submitted"
          loading={stats.isLoading}
        />
        <StatCard
          icon={<XCircle className="size-4" />}
          accent="rose"
          label="Failed Clips"
          value={failed}
          sublabel="Needs attention"
          loading={stats.isLoading}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Submit stream URL */}
        <Card className="border-zinc-800 bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Rocket className="size-4 text-emerald-400" />
              Submit Stream URL
            </CardTitle>
            <CardDescription>
              Paste a Twitch or YouTube VOD URL — ClipCurator will download,
              transcribe (Whisper), analyze audio (librosa) + chat velocity, and
              surface highlight clips for review.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://twitch.tv/videos/123456 or https://youtube.com/watch?v=..."
                className="h-10 flex-1"
                inputMode="url"
                autoComplete="off"
              />
              <Button
                type="submit"
                disabled={!url.trim() || !isValidStreamUrl(url.trim()) || submit.isPending}
                className="h-10 bg-emerald-500 text-white hover:bg-emerald-600"
              >
                <Upload className="size-4" />
                {submit.isPending ? "Submitting…" : "Submit"}
              </Button>
            </form>

            <p className="text-xs text-zinc-500">
              The clipper backend downloads via yt-dlp, so any URL yt-dlp
              supports will work (Twitch VODs, YouTube videos, YouTube Live
              replays, etc.).
            </p>
          </CardContent>
        </Card>

        {/* Recent streams */}
        <Card className="border-zinc-800 bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Film className="size-4 text-emerald-400" />
              Recent Streams
            </CardTitle>
            <CardDescription>
              Latest submitted VODs and their processing status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {streams.isLoading ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : recentStreams.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <Film className="size-8 text-zinc-700" />
                <p className="text-sm text-zinc-500">No streams submitted yet.</p>
                <p className="text-xs text-zinc-600">
                  Submit a VOD URL above to get started.
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {recentStreams.map((src) => {
                  const status = src.status as string;
                  const isWorking =
                    status === "DOWNLOADING" || status === "ANALYZING";
                  return (
                    <li
                      key={src.id}
                      className="flex items-center gap-3 rounded-md border border-zinc-800/80 bg-zinc-950/40 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-zinc-200">
                            {src.streamerName ?? src.title ?? src.url}
                          </span>
                          <Badge
                            variant="outline"
                            className={platformBadgeClass(src.platform)}
                          >
                            {src.platform === "TWITCH" ? "Twitch" : "YouTube"}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-zinc-500">
                          {src.title ?? src.url} · {relativeTime(src.createdAt)}
                        </p>
                        {isWorking && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <Progress
                              value={src.progress ?? 0}
                              className="h-1.5 flex-1"
                            />
                            <span className="text-xs tabular-nums text-zinc-400">
                              {Math.round(src.progress ?? 0)}%
                            </span>
                          </div>
                        )}
                      </div>
                      <Badge
                        variant="outline"
                        className={cn("shrink-0", sourceStatusBadgeClass(status))}
                      >
                        {sourceStatusLabel(status)}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-3 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNavigate("admin")}
              >
                Manage streams →
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* CTA to queue if there are pending clips */}
      {pending > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-6 flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <Clock className="size-5 text-emerald-400" />
            <div>
              <p className="text-sm font-medium text-emerald-200">
                {pending} clip{pending === 1 ? "" : "s"} waiting for review
              </p>
              <p className="text-xs text-emerald-300/70">
                Open the queue to start trimming and publishing.
              </p>
            </div>
          </div>
          <Button
            onClick={() => onNavigate("queue")}
            className="bg-emerald-500 text-white hover:bg-emerald-600"
          >
            Open review queue
          </Button>
        </motion.div>
      )}
    </div>
  );
}

interface StatCardProps {
  icon: React.ReactNode;
  accent: "emerald" | "blue" | "rose" | "zinc";
  label: string;
  value: number | string;
  sublabel: string;
  loading?: boolean;
}

function StatCard({ icon, accent, label, value, sublabel, loading }: StatCardProps) {
  const accentMap: Record<StatCardProps["accent"], string> = {
    emerald: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    blue: "text-blue-400 bg-blue-500/10 border-blue-500/20",
    rose: "text-rose-400 bg-rose-500/10 border-rose-500/20",
    zinc: "text-zinc-300 bg-zinc-500/10 border-zinc-500/20",
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <Card className="border-zinc-800 bg-card">
        <CardContent className="flex items-start gap-3 py-4">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md border",
              accentMap[accent]
            )}
          >
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
            {loading ? (
              <Skeleton className="mt-1 h-7 w-16" />
            ) : (
              <p className="font-mono text-2xl font-semibold tabular-nums text-zinc-100">
                {value}
              </p>
            )}
            <p className="truncate text-xs text-zinc-500">{sublabel}</p>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
