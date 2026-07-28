"use client";

// Admin → Streams view — manage stream sources.

import * as React from "react";
import {
  AlertTriangle,
  Film,
  RefreshCw,
  Twitch,
  Youtube,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useReprocessStream, useStreams } from "@/hooks/use-clipcurator";
import {
  platformBadgeClass,
  relativeTime,
  sourceStatusBadgeClass,
  sourceStatusLabel,
  truncate,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SourceStatus } from "@/types";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "DOWNLOADING", label: "Downloading" },
  { value: "ANALYZING", label: "Analyzing" },
  { value: "READY", label: "Ready" },
  { value: "FAILED", label: "Failed" },
];

export function AdminStreamsView() {
  const streams = useStreams();
  const reprocess = useReprocessStream();
  const [statusFilter, setStatusFilter] = React.useState<string>("ALL");

  const all = streams.data?.sources ?? [];
  const filtered =
    statusFilter === "ALL"
      ? all
      : all.filter((s) => s.status === statusFilter);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Stream Sources</h1>
          <p className="text-sm text-zinc-500">
            {all.length} stream{all.length === 1 ? "" : "s"} submitted · auto-refreshing every 2s
          </p>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="border-zinc-800 bg-card">
        <CardContent className="p-0">
          {streams.isLoading ? (
            <div className="space-y-2 p-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Film className="size-12 text-zinc-700" />
              <div>
                <p className="text-sm font-medium text-zinc-300">
                  No streams found
                </p>
                <p className="text-xs text-zinc-500">
                  {statusFilter === "ALL"
                    ? "Submit a stream URL from the dashboard to get started."
                    : `No streams with status "${statusFilter}".`}
                </p>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800">
                  <TableHead className="text-zinc-400">Created</TableHead>
                  <TableHead className="text-zinc-400">URL</TableHead>
                  <TableHead className="text-zinc-400">Platform</TableHead>
                  <TableHead className="text-zinc-400">Streamer</TableHead>
                  <TableHead className="text-zinc-400">Status</TableHead>
                  <TableHead className="text-zinc-400">Progress</TableHead>
                  <TableHead className="text-zinc-400">Clips</TableHead>
                  <TableHead className="text-zinc-400">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((src) => {
                  const status = src.status as SourceStatus;
                  const isWorking =
                    status === "DOWNLOADING" || status === "ANALYZING";
                  const isFailed = status === "FAILED";
                  return (
                    <TableRow key={src.id} className="border-zinc-800/70">
                      <TableCell className="text-xs text-zinc-400">
                        {relativeTime(src.createdAt)}
                      </TableCell>
                      <TableCell className="max-w-[240px]">
                        <span
                          className="block truncate font-mono text-xs text-zinc-300"
                          title={src.url}
                        >
                          {truncate(src.url, 60)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={platformBadgeClass(src.platform)}
                        >
                          {src.platform === "TWITCH" ? (
                            <Twitch className="size-3" />
                          ) : (
                            <Youtube className="size-3" />
                          )}
                          {src.platform === "TWITCH" ? "Twitch" : "YouTube"}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[140px] truncate text-sm text-zinc-200">
                        {src.streamerName ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={sourceStatusBadgeClass(status)}
                          >
                            {sourceStatusLabel(status)}
                          </Badge>
                          {isFailed && src.errorMessage && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className="text-rose-400 hover:text-rose-300"
                                  aria-label="Show error"
                                >
                                  <AlertTriangle className="size-3.5" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent
                                side="top"
                                className="max-w-xs text-left"
                              >
                                {src.errorMessage}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="w-[140px]">
                        {isWorking ? (
                          <div className="flex items-center gap-2">
                            <Progress
                              value={src.progress ?? 0}
                              className="h-1.5 flex-1"
                            />
                            <span className="text-xs tabular-nums text-zinc-400">
                              {Math.round(src.progress ?? 0)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-600">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm text-zinc-300">
                        {src.clipCount ?? 0}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!isFailed || reprocess.isPending}
                          onClick={() => reprocess.mutate(src.id)}
                          className={cn(
                            "h-8",
                            isFailed &&
                              "border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
                          )}
                        >
                          <RefreshCw className="size-3.5" />
                          Re-process
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Error log for failed streams (expandable below) */}
      {filtered.some((s) => s.status === "FAILED" && s.errorMessage) && (
        <Card className="mt-4 border-rose-500/30 bg-rose-500/5">
          <CardContent className="space-y-2 py-4">
            <p className="flex items-center gap-2 text-sm font-medium text-rose-300">
              <AlertTriangle className="size-4" />
              Failed streams
            </p>
            <ul className="space-y-1 text-xs text-rose-200/80">
              {filtered
                .filter((s) => s.status === "FAILED" && s.errorMessage)
                .map((s) => (
                  <li key={s.id} className="font-mono">
                    <span className="text-rose-400">{s.id.slice(0, 8)}</span> ·{" "}
                    {s.errorMessage}
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
