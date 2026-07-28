"use client";

// History view — paginated, filterable table of all clips.

import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  Film,
  Search,
  Youtube,
  ExternalLink,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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

import { useClips } from "@/hooks/use-clipcurator";
import {
  channelLabel,
  formatTime,
  platformBadgeClass,
  relativeTime,
  statusBadgeClass,
  statusLabel,
  truncate,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Twitch, Youtube as YoutubeIcon } from "lucide-react";
import type { ClipStatus } from "@/types";

const PAGE_SIZE = 10;

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "IN_REVIEW", label: "In Review" },
  { value: "APPROVED_A", label: "Approved A" },
  { value: "APPROVED_B", label: "Approved B" },
  { value: "REJECTED", label: "Rejected" },
  { value: "PUBLISHING", label: "Publishing" },
  { value: "PUBLISHED", label: "Published" },
  { value: "FAILED", label: "Failed" },
];

export function HistoryView() {
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState<string>("ALL");
  const [q, setQ] = React.useState("");

  // Debounce the search query.
  const [debouncedQ, setDebouncedQ] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const params: Record<string, string | number> = {
    page,
    pageSize: PAGE_SIZE,
  };
  if (status !== "ALL") params.status = status;
  if (debouncedQ) params.q = debouncedQ;

  const { data, isLoading, isFetching } = useClips(params);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Clip History</h1>
          <p className="text-sm text-zinc-500">
            {total} clip{total === 1 ? "" : "s"} · page {page} of {totalPages}
          </p>
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-4 border-zinc-800 bg-card">
        <CardContent className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
          <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
            <SelectTrigger className="h-9 w-full sm:w-[180px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search transcript or peak phrase…"
              className="h-9 pl-8"
            />
          </div>
          {isFetching && (
            <span className="text-xs text-zinc-500">Refreshing…</span>
          )}
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="border-zinc-800 bg-card">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800">
                  <TableHead className="text-zinc-400">Created</TableHead>
                  <TableHead className="text-zinc-400">Streamer</TableHead>
                  <TableHead className="text-zinc-400">Peak Phrase</TableHead>
                  <TableHead className="text-zinc-400">Engagement</TableHead>
                  <TableHead className="text-zinc-400">Duration</TableHead>
                  <TableHead className="text-zinc-400">Status</TableHead>
                  <TableHead className="text-zinc-400">Published To</TableHead>
                  <TableHead className="text-zinc-400">YouTube ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((clip) => {
                  const dur =
                    clip.finalEndSec != null && clip.finalStartSec != null
                      ? clip.finalEndSec - clip.finalStartSec
                      : clip.endTimeSec - clip.startTimeSec;
                  return (
                    <TableRow key={clip.id} className="border-zinc-800/70">
                      <TableCell className="text-xs text-zinc-400">
                        {relativeTime(clip.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="max-w-[140px] truncate text-sm text-zinc-200">
                            {clip.source?.streamerName ?? "—"}
                          </span>
                          {clip.source?.platform && (
                            <Badge
                              variant="outline"
                              className={cn(
                                "px-1.5 py-0",
                                platformBadgeClass(clip.source.platform)
                              )}
                            >
                              {clip.source.platform === "TWITCH" ? (
                                <Twitch className="size-3" />
                              ) : (
                                <YoutubeIcon className="size-3" />
                              )}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <span className="truncate text-sm italic text-zinc-300">
                          “{truncate(clip.peakPhrase, 40)}”
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "font-mono text-sm tabular-nums",
                            clip.engagementScore >= 0.7
                              ? "text-emerald-400"
                              : clip.engagementScore >= 0.4
                                ? "text-amber-400"
                                : "text-rose-400"
                          )}
                        >
                          {clip.engagementScore.toFixed(2)}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-sm text-zinc-300">
                        {formatTime(dur)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            statusBadgeClass(clip.status as ClipStatus)
                          )}
                        >
                          {statusLabel(clip.status as ClipStatus)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {clip.publishedTo ? (
                          <Badge
                            variant="outline"
                            className={cn(
                              clip.publishedTo === "CHANNEL_A"
                                ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                                : "border-blue-500/30 bg-blue-500/15 text-blue-300"
                            )}
                          >
                            {channelLabel(clip.publishedTo)}
                          </Badge>
                        ) : (
                          <span className="text-xs text-zinc-600">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {clip.youtubeVideoId ? (
                          <a
                            href={`https://youtu.be/${clip.youtubeVideoId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-xs text-blue-400 hover:underline"
                          >
                            <Youtube className="size-3" />
                            {clip.youtubeVideoId}
                            <ExternalLink className="size-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-zinc-600">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" />
            Prev
          </Button>
          <span className="text-xs text-zinc-400">
            Page <span className="font-mono text-zinc-200">{page}</span> /{" "}
            <span className="font-mono">{totalPages}</span>
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <Film className="size-12 text-zinc-700" />
      <div>
        <p className="text-sm font-medium text-zinc-300">No clips found</p>
        <p className="text-xs text-zinc-500">
          Try adjusting filters, or submit a stream URL to generate clips.
        </p>
      </div>
    </div>
  );
}
