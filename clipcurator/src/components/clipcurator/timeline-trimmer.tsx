"use client";

// Custom-built timeline trimmer. No charting libraries — pure React + pointer events.
//
// Renders (top → bottom):
//   • time ruler (tick marks every 10s, labels every 60s)
//   • fake waveform bars (60-80, deterministic per duration)
//   • trim region overlay (translucent emerald + 4px handles)
//   • playhead (white vertical line)
//   • AI suggestion markers (small gray triangles)
//
// Interaction:
//   • click → seek
//   • drag left handle → trimStart (clamped: [0, trimEnd - 10])
//   • drag right handle → trimEnd (clamped: [trimStart + 10, duration])
//   • drag middle → move both together (preserves duration, clamped)
//   • touch targets ≥44px (wide invisible handles + visible thin bar)

import * as React from "react";
import { cn } from "@/lib/utils";
import { formatTime, durationQualityClass } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ChevronLeft,
  ChevronRight,
  RotateCcw,
} from "lucide-react";

export interface TimelineTrimmerProps {
  duration: number;
  currentTime: number;
  trimStart: number;
  trimEnd: number;
  suggestedStart: number;
  suggestedEnd: number;
  onSeek: (t: number) => void;
  onTrimChange: (start: number, end: number) => void;
}

const MIN_CLIP_LEN = 10; // seconds — reduced from 30 to allow tighter cuts

// Deterministic seeded RNG so the waveform doesn't flicker on re-render.
function seededWaveform(seed: number, count: number): number[] {
  let h = 1779033703 ^ seed;
  const rng = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const base = Math.sin(i * 0.3) * 0.5 + 0.5;
    const noise = rng() * 0.5;
    out.push(Math.min(1, Math.max(0.08, base * 0.5 + noise)));
  }
  return out;
}

type DragMode = "start" | "end" | "middle" | null;

export function TimelineTrimmer({
  duration,
  currentTime,
  trimStart,
  trimEnd,
  suggestedStart,
  suggestedEnd,
  onSeek,
  onTrimChange,
}: TimelineTrimmerProps) {
  const safeDuration = Math.max(1, duration || 0);
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const dragModeRef = React.useRef<DragMode>(null);
  const dragOffsetRef = React.useRef<number>(0); // for middle drag
  const [activeDrag, setActiveDrag] = React.useState<DragMode>(null);

  const barCount = React.useMemo(() => {
    if (safeDuration <= 60) return 60;
    if (safeDuration <= 300) return 70;
    return 80;
  }, [safeDuration]);

  const waveform = React.useMemo(
    () => seededWaveform(Math.round(safeDuration * 1000), barCount),
    [safeDuration, barCount]
  );

  const pct = (t: number) => `${(t / safeDuration) * 100}%`;

  const clampStart = (s: number, e: number) =>
    Math.max(0, Math.min(s, e - MIN_CLIP_LEN));
  const clampEnd = (e: number, s: number) =>
    Math.min(safeDuration, Math.max(e, s + MIN_CLIP_LEN));

  // Convert a clientX to a time value relative to the track.
  const clientXToTime = React.useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(safeDuration, ratio * safeDuration));
    },
    [safeDuration]
  );

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Ignore clicks that originated from a handle / middle drag.
    if (dragModeRef.current) return;
    const t = clientXToTime(e.clientX);
    onSeek(t);
  };

  const startDrag = (mode: DragMode, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragModeRef.current = mode;
    setActiveDrag(mode);
    if (mode === "middle") {
      const t = clientXToTime(e.clientX);
      dragOffsetRef.current = t - trimStart;
    }
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const mode = dragModeRef.current;
    if (!mode) return;
    const t = clientXToTime(e.clientX);
    if (mode === "start") {
      onTrimChange(clampStart(t, trimEnd), trimEnd);
    } else if (mode === "end") {
      onTrimChange(trimStart, clampEnd(t, trimStart));
    } else if (mode === "middle") {
      const len = trimEnd - trimStart;
      let newStart = t - dragOffsetRef.current;
      newStart = Math.max(0, Math.min(newStart, safeDuration - len));
      onTrimChange(newStart, newStart + len);
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragModeRef.current) return;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragModeRef.current = null;
    setActiveDrag(null);
  };

  // ── Ruler ticks ────────────────────────────────────────────────────────
  const ticks: { t: number; major: boolean }[] = [];
  if (safeDuration > 0) {
    const step = safeDuration > 600 ? 30 : 10;
    for (let t = 0; t <= safeDuration; t += step) {
      ticks.push({ t, major: t % 60 === 0 });
    }
  }

  const trimLen = Math.max(0, trimEnd - trimStart);
  const durClass = durationQualityClass(trimLen);

  // ── Nudge buttons ─────────────────────────────────────────────────────
  const nudgeStart = (delta: number) => {
    onTrimChange(clampStart(trimStart + delta, trimEnd), trimEnd);
  };
  const nudgeEnd = (delta: number) => {
    onTrimChange(trimStart, clampEnd(trimEnd + delta, trimStart));
  };
  const resetToAi = () => {
    onTrimChange(suggestedStart, suggestedEnd);
  };

  return (
    <div className="w-full select-none">
      <div
        ref={trackRef}
        className="relative h-[120px] w-full overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60 sm:h-[120px] md:h-[120px]"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* Ruler */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-5 border-b border-zinc-800/80">
          {ticks.map(({ t, major }) => (
            <div
              key={t}
              className="absolute top-0 flex flex-col items-center"
              style={{ left: pct(t) }}
            >
              <div
                className={cn(
                  "w-px",
                  major ? "h-3 bg-zinc-500" : "h-1.5 bg-zinc-700"
                )}
              />
              {major && (
                <span className="mt-0.5 -translate-x-1/2 text-[10px] tabular-nums text-zinc-500">
                  {formatTime(t)}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Waveform bars */}
        <div className="pointer-events-none absolute inset-x-0 top-7 bottom-2 flex items-center gap-px px-1">
          {waveform.map((h, i) => {
            const inTrim =
              (i / barCount) * safeDuration >= trimStart - 0.1 &&
              (i / barCount) * safeDuration <= trimEnd + 0.1;
            return (
              <div
                key={i}
                className={cn(
                  "flex-1 rounded-full",
                  inTrim ? "bg-emerald-500/60" : "bg-zinc-700"
                )}
                style={{ height: `${Math.max(8, h * 100)}%` }}
              />
            );
          })}
        </div>

        {/* Click-to-seek layer (sits below handles, above waveform) */}
        <div
          className="absolute inset-x-0 top-7 bottom-2 cursor-pointer"
          onClick={handleTrackClick}
        />

        {/* Trim region overlay */}
        <div
          className="absolute top-7 bottom-2 cursor-grab rounded-sm border-x-[3px] border-emerald-500 bg-emerald-500/15 active:cursor-grabbing"
          style={{
            left: pct(trimStart),
            width: `calc(${pct(trimEnd)} - ${pct(trimStart)})`,
          }}
          onPointerDown={(e) => startDrag("middle", e)}
        >
          {/* Center drag affordance */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-8 w-1 rounded-full bg-emerald-400/40" />
          </div>
        </div>

        {/* Left handle (wide invisible touch target + visible thin bar) */}
        <div
          className={cn(
            "absolute top-7 bottom-2 z-10 cursor-ew-resize touch-none",
            "w-11 -ml-5 flex items-center justify-center"
          )}
          style={{ left: pct(trimStart) }}
          onPointerDown={(e) => startDrag("start", e)}
        >
          <div
            className={cn(
              "h-full w-1 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.6)]",
              activeDrag === "start" && "w-1.5"
            )}
          />
          <div className="absolute -top-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-emerald-400" />
          <div className="absolute -bottom-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-emerald-400" />
        </div>

        {/* Right handle */}
        <div
          className={cn(
            "absolute top-7 bottom-2 z-10 cursor-ew-resize touch-none",
            "w-11 -ml-5 flex items-center justify-center"
          )}
          style={{ left: pct(trimEnd) }}
          onPointerDown={(e) => startDrag("end", e)}
        >
          <div
            className={cn(
              "h-full w-1 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.6)]",
              activeDrag === "end" && "w-1.5"
            )}
          />
          <div className="absolute -top-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-emerald-400" />
          <div className="absolute -bottom-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-emerald-400" />
        </div>

        {/* AI suggestion markers */}
        <SuggestionMarker
          pos={pct(suggestedStart)}
          label={`AI suggested start: ${formatTime(suggestedStart)}`}
        />
        <SuggestionMarker
          pos={pct(suggestedEnd)}
          label={`AI suggested end: ${formatTime(suggestedEnd)}`}
        />

        {/* Playhead */}
        <div
          className="pointer-events-none absolute top-5 bottom-0 z-20 w-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]"
          style={{ left: pct(currentTime) }}
        >
          <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-white" />
        </div>
      </div>

      {/* Live duration feedback */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-zinc-400">
          Duration:{" "}
          <span className={cn("font-mono font-semibold", durClass)}>
            {formatTime(trimLen)}
          </span>{" "}
          <span className="text-zinc-500">
            (min 0:{MIN_CLIP_LEN.toString().padStart(2, "0")}, ideal 15–60s)
          </span>
        </div>
        <div className="text-xs text-zinc-400">
          Trim:{" "}
          <span className="font-mono">
            {formatTime(trimStart)} – {formatTime(trimEnd)}
          </span>
        </div>
      </div>

      {/* Nudge buttons */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => nudgeStart(-5)}
          className="h-8"
        >
          <ChevronLeft className="size-3.5" />
          Start −5s
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => nudgeStart(5)}
          className="h-8"
        >
          Start +5s
          <ChevronRight className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => nudgeEnd(-5)}
          className="h-8"
        >
          <ChevronLeft className="size-3.5" />
          End −5s
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => nudgeEnd(5)}
          className="h-8"
        >
          End +5s
          <ChevronRight className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={resetToAi}
          className="h-8 text-emerald-400 hover:text-emerald-300"
        >
          <RotateCcw className="size-3.5" />
          Reset to AI
        </Button>
      </div>
    </div>
  );
}

function SuggestionMarker({
  pos,
  label,
}: {
  pos: string;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2"
          style={{ left: pos }}
          aria-label={label}
        >
          {/* Downward triangle */}
          <div
            className="h-0 w-0"
            style={{
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: "6px solid rgb(161 161 170 / 0.9)",
            }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
