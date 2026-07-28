"use client";

// Queue view — the heart of ClipCurator.
//
// Desktop: two-column grid [1fr_320px] — left has video + timeline + actions,
//         right has metadata sidebar.
// Mobile: single column. Metadata collapses into an Accordion, action buttons
//         become a sticky bottom bar.

import * as React from "react";
import {
  Upload,
  X,
  Keyboard,
  MessageSquare,
  RotateCcw,
  Gauge,
  Clock,
  Sparkles,
  User,
  Inbox,
  Twitch,
  Youtube,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";

import { useQueueStore } from "@/store/queue";
import { useLoadNextClip, useSubmitReview } from "@/hooks/use-clipcurator";
import { VideoProvider, useVideo } from "./video-context";
import { TimelineTrimmer } from "./timeline-trimmer";
import { cn } from "@/lib/utils";
import { formatTime, platformBadgeClass } from "@/lib/format";
import type { ClipWithSource, Decision } from "@/types";

interface QueueViewProps {
  onNavigate: (view: "dashboard" | "queue" | "history" | "admin") => void;
}

export function QueueView({ onNavigate }: QueueViewProps) {
  // Wrap everything in a VideoProvider so the inner video element + timeline
  // share the same ref/state.
  return (
    <VideoProvider>
      <QueueViewInner onNavigate={onNavigate} />
    </VideoProvider>
  );
}

function QueueViewInner({ onNavigate }: QueueViewProps) {
  const currentClip = useQueueStore((s) => s.currentClip);
  const videoUrl = useQueueStore((s) => s.videoUrl);
  const poster = useQueueStore((s) => s.poster);
  const queueLength = useQueueStore((s) => s.queueLength);
  const isLoading = useQueueStore((s) => s.isLoading);
  const trimStart = useQueueStore((s) => s.trimStart);
  const trimEnd = useQueueStore((s) => s.trimEnd);
  const setTrim = useQueueStore((s) => s.setTrim);

  const loadNext = useLoadNextClip();
  const submitReview = useSubmitReview();
  const video = useVideo();

  const hasLoadedOnceRef = React.useRef(false);

  // Auto-load the first clip on mount if none is present.
  React.useEffect(() => {
    if (!hasLoadedOnceRef.current && !currentClip && !isLoading) {
      hasLoadedOnceRef.current = true;
      loadNext.mutate();
    }
  }, [currentClip, isLoading, loadNext]);

  const decide = React.useCallback(
    (decision: Decision) => {
      if (!currentClip) return;
      submitReview.mutate({
        clipId: currentClip.id,
        decision,
        finalStart: trimStart,
        finalEnd: trimEnd,
      });
    },
    [currentClip, submitReview, trimStart, trimEnd]
  );

  const resetToAi = React.useCallback(() => {
    if (!currentClip) return;
    setTrim(currentClip.suggestedStart, currentClip.suggestedEnd);
    video.seek(currentClip.suggestedStart);
  }, [currentClip, setTrim, video]);

  // Reload listeners when a new clip / videoUrl arrives; seek to suggested start.
  // Deps intentionally limited to clip id + url so we don't re-run on every timeupdate.
  React.useEffect(() => {
    if (currentClip && videoUrl) {
      video.reload();
      const t = setTimeout(() => {
        video.seek(currentClip.suggestedStart);
      }, 250);
      return () => clearTimeout(t);
    }
  }, [currentClip, videoUrl, video]);

  // After a successful review, the store clears currentClip → load next.
  React.useEffect(() => {
    if (
      !submitReview.isPending &&
      hasLoadedOnceRef.current &&
      !currentClip &&
      !isLoading
    ) {
      const t = setTimeout(() => loadNext.mutate(), 350);
      return () => clearTimeout(t);
    }
  }, [currentClip, isLoading, submitReview.isPending, loadNext]);

  // Keyboard shortcuts.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement;
      const tag = ae?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        ae?.isContentEditable
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!currentClip) return;

      switch (e.key) {
        case " ":
        case "Spacebar":
          e.preventDefault();
          video.togglePlay();
          break;
        case "a":
        case "A":
          e.preventDefault();
          decide("A");
          break;
        case "b":
        case "B":
          e.preventDefault();
          decide("B");
          break;
        case "r":
        case "R":
          e.preventDefault();
          decide("REJECT");
          break;
        case "ArrowLeft": {
          e.preventDefault();
          const delta = e.shiftKey ? -5 : -0.5;
          setTrim(Math.max(0, trimStart + delta), trimEnd);
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          const delta = e.shiftKey ? 5 : 0.5;
          const dur = video.duration || trimEnd + delta;
          setTrim(trimStart, Math.min(dur, trimEnd + delta));
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentClip, trimStart, trimEnd, video.duration, video, decide, setTrim]);

  // ── States ─────────────────────────────────────────────────────────────
  if (isLoading && !currentClip) {
    return <QueueSkeleton />;
  }

  if (!currentClip) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <Inbox className="size-12 text-zinc-700" />
        <h2 className="text-xl font-semibold text-zinc-200">Queue is empty</h2>
        <p className="max-w-md text-sm text-zinc-500">
          Submit a stream URL to generate highlight clips for review.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            onClick={() => onNavigate("dashboard")}
            className="bg-emerald-500 text-white hover:bg-emerald-600"
          >
            Go to dashboard
          </Button>
          <Button
            variant="outline"
            onClick={() => loadNext.mutate()}
            disabled={isLoading}
          >
            Retry load
          </Button>
        </div>
        <p className="text-xs text-zinc-600">
          Queue length: <span className="font-mono">{queueLength}</span>
        </p>
      </div>
    );
  }

  const clip = currentClip;
  const src = clip.source;
  const duration =
    video.duration || src?.durationSec || clip.endTimeSec || 60;
  const trimLen = Math.max(0, trimEnd - trimStart);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Top bar: clip id + queue pos */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="bg-zinc-900 text-zinc-300">
            Clip <span className="font-mono">{clip.id.slice(0, 8)}</span>
          </Badge>
          {src && (
            <Badge
              variant="outline"
              className={platformBadgeClass(src.platform)}
            >
              {src.platform === "TWITCH" ? (
                <Twitch className="size-3" />
              ) : (
                <Youtube className="size-3" />
              )}
              {src.streamerName ?? src.platform}
            </Badge>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          Queue: <span className="font-mono text-emerald-400">{queueLength}</span>{" "}
          pending
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Left column: video + timeline + actions */}
        <div className="flex flex-col gap-3">
          <VideoPlayer src={videoUrl ?? ""} poster={poster} />

          {/* Speed control */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Speed</span>
            <Select
              value={String(video.playbackRate)}
              onValueChange={(v) => video.setPlaybackRate(Number(v))}
            >
              <SelectTrigger size="sm" className="w-[88px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1×</SelectItem>
                <SelectItem value="1.5">1.5×</SelectItem>
                <SelectItem value="2">2×</SelectItem>
              </SelectContent>
            </Select>
            <span className="ml-auto text-xs text-zinc-500">
              <span className="font-mono">{formatTime(video.currentTime)}</span>{" "}
              / <span className="font-mono">{formatTime(duration)}</span>
            </span>
          </div>

          {/* Timeline */}
          <Card className="border-zinc-800 bg-card">
            <CardContent className="py-4">
              <TimelineTrimmer
                duration={duration}
                currentTime={video.currentTime}
                trimStart={trimStart}
                trimEnd={trimEnd}
                suggestedStart={clip.suggestedStart}
                suggestedEnd={clip.suggestedEnd}
                onSeek={(t) => video.seek(t)}
                onTrimChange={(s, e) => setTrim(s, e)}
              />
            </CardContent>
          </Card>

          {/* Action buttons (desktop) */}
          <div className="hidden gap-2 lg:flex">
            <ActionButton
              onClick={() => decide("A")}
              disabled={submitReview.isPending}
              accent="emerald"
              icon={<Upload className="size-4" />}
              label="Publish to Channel A"
              shortcut="A"
            />
            <ActionButton
              onClick={() => decide("B")}
              disabled={submitReview.isPending}
              accent="blue"
              icon={<Upload className="size-4" />}
              label="Publish to Channel B"
              shortcut="B"
            />
            <ActionButton
              onClick={() => decide("REJECT")}
              disabled={submitReview.isPending}
              accent="rose"
              icon={<X className="size-4" />}
              label="Reject Clip"
              shortcut="R"
            />
          </div>
        </div>

        {/* Right column: metadata sidebar (desktop) */}
        <div className="hidden lg:block">
          <MetadataSidebar clip={clip} trimLen={trimLen} onResetAi={resetToAi} />
        </div>
      </div>

      {/* Mobile: metadata accordion */}
      <div className="mt-4 lg:hidden">
        <Accordion
          type="single"
          collapsible
          className="rounded-md border border-zinc-800 bg-card px-3"
        >
          <AccordionItem value="meta" className="border-b-0">
            <AccordionTrigger className="py-3 text-sm font-medium">
              Clip details & metadata
            </AccordionTrigger>
            <AccordionContent>
              <MetadataSidebar
                clip={clip}
                trimLen={trimLen}
                onResetAi={resetToAi}
                embedded
              />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {/* Mobile: sticky bottom action bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-3 gap-2 border-t border-zinc-800 bg-zinc-950/95 p-3 backdrop-blur lg:hidden">
        <ActionButton
          onClick={() => decide("A")}
          disabled={submitReview.isPending}
          accent="emerald"
          icon={<Upload className="size-4" />}
          label="Chan A"
          shortcut="A"
          compact
        />
        <ActionButton
          onClick={() => decide("B")}
          disabled={submitReview.isPending}
          accent="blue"
          icon={<Upload className="size-4" />}
          label="Chan B"
          shortcut="B"
          compact
        />
        <ActionButton
          onClick={() => decide("REJECT")}
          disabled={submitReview.isPending}
          accent="rose"
          icon={<X className="size-4" />}
          label="Reject"
          shortcut="R"
          compact
        />
      </div>

      {/* Spacer so mobile sticky bar doesn't cover content */}
      <div className="h-20 lg:hidden" aria-hidden />
    </div>
  );
}

// ── Video player ────────────────────────────────────────────────────────
function VideoPlayer({ src, poster }: { src: string; poster: string }) {
  const { videoRef, isPlaying, togglePlay } = useVideo();
  return (
    <div className="relative overflow-hidden rounded-lg bg-black">
      <video
        ref={videoRef}
        src={src}
        poster={poster || undefined}
        controls
        playsInline
        className="aspect-video w-full bg-black"
      />
      {!isPlaying && (
        <button
          type="button"
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/30 transition hover:bg-black/20"
          aria-label="Play"
        >
          <span className="flex size-14 items-center justify-center rounded-full bg-emerald-500/90 text-white shadow-lg">
            <svg viewBox="0 0 24 24" className="ml-1 size-6 fill-current">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </button>
      )}
    </div>
  );
}

// ── Action button ───────────────────────────────────────────────────────
function ActionButton({
  onClick,
  disabled,
  accent,
  icon,
  label,
  shortcut,
  compact,
}: {
  onClick: () => void;
  disabled?: boolean;
  accent: "emerald" | "blue" | "rose";
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  compact?: boolean;
}) {
  const cls = {
    emerald: "bg-emerald-500 hover:bg-emerald-600 text-white",
    blue: "bg-blue-500 hover:bg-blue-600 text-white",
    rose: "bg-rose-500 hover:bg-rose-600 text-white",
  }[accent];
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-12 flex-1 gap-2 text-sm font-semibold",
        cls,
        compact && "h-11 text-xs"
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      <kbd
        className={cn(
          "ml-auto rounded border border-white/30 bg-white/10 px-1.5 py-0.5 font-mono text-[10px] leading-none",
          compact && "sr-only"
        )}
      >
        {shortcut}
      </kbd>
    </Button>
  );
}

// ── Metadata sidebar ────────────────────────────────────────────────────
function MetadataSidebar({
  clip,
  trimLen,
  onResetAi,
  embedded,
}: {
  clip: ClipWithSource;
  trimLen: number;
  onResetAi: () => void;
  embedded?: boolean;
}) {
  const src = clip.source;
  const score = Math.min(1, Math.max(0, clip.engagementScore ?? 0));
  const scorePct = Math.round(score * 100);
  const ringColor =
    score >= 0.7
      ? "text-emerald-400"
      : score >= 0.4
        ? "text-amber-400"
        : "text-rose-400";

  const [transcriptOpen, setTranscriptOpen] = React.useState(false);

  return (
    <Card
      className={cn(
        "border-zinc-800 bg-card",
        embedded && "border-0 bg-transparent shadow-none"
      )}
    >
      <CardContent className={cn("space-y-4", embedded && "p-0")}>
        {/* Engagement score */}
        <div className="flex items-center gap-3">
          <div className="relative flex size-14 items-center justify-center">
            <svg viewBox="0 0 36 36" className="size-14 -rotate-90">
              <circle
                cx="18"
                cy="18"
                r="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                className="text-zinc-800"
              />
              <circle
                cx="18"
                cy="18"
                r="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeDasharray={`${scorePct} 100`}
                strokeLinecap="round"
                className={ringColor}
                pathLength={100}
              />
            </svg>
            <span className={cn("absolute text-sm font-bold tabular-nums", ringColor)}>
              {score.toFixed(2)}
            </span>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-500">
              <Gauge className="size-3.5" /> Engagement Score
            </p>
            <p className="text-sm text-zinc-300">
              {scorePct >= 70 ? "High" : scorePct >= 40 ? "Medium" : "Low"} engagement
            </p>
          </div>
        </div>

        {/* Metadata grid */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <MetaItem icon={<Clock className="size-3.5" />} label="Duration">
            <span
              className={cn(
                "font-mono",
                trimLen >= 30 ? "text-emerald-400" : "text-rose-400"
              )}
            >
              {formatTime(trimLen)}
            </span>
          </MetaItem>
          <MetaItem icon={<MessageSquare className="size-3.5" />} label="Chat Peak">
            <span className="font-mono">
              {Math.round(clip.chatVelocity ?? 0)} msg/s
            </span>
          </MetaItem>
          <MetaItem icon={<User className="size-3.5" />} label="Streamer" full>
            <span className="truncate">
              {src?.streamerName ?? "Unknown"}
              {src && (
                <Badge
                  variant="outline"
                  className={cn("ml-2 align-middle", platformBadgeClass(src.platform))}
                >
                  {src.platform === "TWITCH" ? "Twitch" : "YouTube"}
                </Badge>
              )}
            </span>
          </MetaItem>
          <MetaItem icon={<Sparkles className="size-3.5" />} label="Peak Phrase" full>
            <span className="italic text-zinc-300">
              “{clip.peakPhrase ?? "—"}”
            </span>
          </MetaItem>
        </div>

        {/* Transcript dialog */}
        <Dialog open={transcriptOpen} onOpenChange={setTranscriptOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="w-full">
              <MessageSquare className="size-4" />
              View transcript
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Transcript</DialogTitle>
              <DialogDescription>
                Whisper-generated transcript for this clip.
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-[60vh]">
              <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-200">
                {clip.transcript ?? "No transcript available."}
              </p>
            </ScrollArea>
          </DialogContent>
        </Dialog>

        {/* Reset to AI suggestion */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onResetAi}
          className="w-full text-emerald-400 hover:text-emerald-300"
        >
          <RotateCcw className="size-4" />
          Reset to AI suggestion
        </Button>

        {/* Keyboard shortcuts */}
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
            <Keyboard className="size-3.5" /> Shortcuts
          </p>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <ShortcutRow keys="Space" desc="Play / pause" />
            <ShortcutRow keys="A" desc="Channel A" />
            <ShortcutRow keys="B" desc="Channel B" />
            <ShortcutRow keys="R" desc="Reject" />
            <ShortcutRow keys="← →" desc="Nudge 0.5s" />
            <ShortcutRow keys="⇧← →" desc="Nudge 5s" />
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function MetaItem({
  icon,
  label,
  children,
  full,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={cn("min-w-0", full && "col-span-2")}>
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500">
        {icon}
        {label}
      </p>
      <div className="mt-0.5 truncate text-sm text-zinc-200">{children}</div>
    </div>
  );
}

function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
        {keys}
      </kbd>
      <span>{desc}</span>
    </li>
  );
}

// ── Loading skeleton ────────────────────────────────────────────────────
function QueueSkeleton() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          <Skeleton className="aspect-video w-full rounded-lg" />
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-40 w-full rounded-md" />
          <div className="hidden gap-2 lg:flex">
            <Skeleton className="h-12 flex-1" />
            <Skeleton className="h-12 flex-1" />
            <Skeleton className="h-12 flex-1" />
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-40 w-full rounded-md" />
          <Skeleton className="h-32 w-full rounded-md" />
          <Skeleton className="h-32 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}
