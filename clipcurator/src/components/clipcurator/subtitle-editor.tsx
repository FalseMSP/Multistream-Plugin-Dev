"use client";

// Subtitle editor — lets the user view, edit, and style burned-in subtitles
// for the current clip.
//
// Workflow:
//   1. Fetch Whisper transcript segments from /api/sources/[id]/transcript
//      (filtered to the clip's time range).
//   2. Convert to VTT for preview + editing.
//   3. User can:
//      - Toggle subtitles on/off (withSubtitles)
//      - Edit text per segment (inline textarea)
//      - Adjust segment start/end times (numeric inputs + drag handles)
//      - Add / delete segments
//      - Click a segment to seek the video
//      - Style: font size, color, position, bold
//   4. Parent (queue-view) reads state from the queue store on submit.
//
// The video element comes from VideoContext — same one used by the player.

import * as React from "react";
import {
  Captions,
  Plus,
  Trash2,
  Loader2,
  Type,
  Palette,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { useQueueStore } from "@/store/queue";
import { useTranscript } from "@/hooks/use-clipcurator";
import { useVideo } from "./video-context";
import { segmentsToVtt } from "@/lib/pipeline";
import type { SubtitleSegment, SubtitleStyle } from "@/types";
import { DEFAULT_SUBTITLE_STYLE } from "@/types";

interface SubtitleEditorProps {
  // Clip's source ID + trim range — used to fetch the right transcript slice.
  sourceId: string;
  clipStart: number;
  clipEnd: number;
  // Called whenever the VTT changes — parent uses this to include VTT in
  // the review/submit body.
  onVttChange?: (vtt: string | null) => void;
}

export function SubtitleEditor({
  sourceId,
  clipStart,
  clipEnd,
  onVttChange,
}: SubtitleEditorProps) {
  const withSubtitles = useQueueStore((s) => s.withSubtitles);
  const setWithSubtitles = useQueueStore((s) => s.setWithSubtitles);
  const subtitleStyle = useQueueStore((s) => s.subtitleStyle);
  const setSubtitleStyle = useQueueStore((s) => s.setSubtitleStyle);

  const { data, isLoading } = useTranscript(sourceId, clipStart, clipEnd);
  const video = useVideo();

  // Local editable segments — initialized from the fetched transcript,
  // then user edits mutate this state. The parent reads the VTT via onVttChange.
  const [segments, setSegments] = React.useState<SubtitleSegment[]>([]);

  React.useEffect(() => {
    if (data?.segments) {
      // Offset segments so they're relative to clipStart (the burned-in
      // subtitle file will start at 0 = clipStart of the source video).
      const offset = data.segments.length > 0 ? data.segments[0].start : 0;
      // Actually, keep absolute times — the render endpoint will offset them.
      // The VTT we generate uses absolute source-video timestamps, and the
      // clipper's render endpoint will subtract clipStart when burning in.
      setSegments(data.segments);
    }
  }, [data]);

  // Push VTT up to parent whenever segments or toggle changes.
  React.useEffect(() => {
    if (withSubtitles && segments.length > 0) {
      onVttChange?.(segmentsToVtt(segments));
    } else {
      onVttChange?.(null);
    }
  }, [withSubtitles, segments, onVttChange]);

  const seekToSegment = (s: SubtitleSegment) => {
    video.seek(s.start);
  };

  const updateSegment = (index: number, patch: Partial<SubtitleSegment>) => {
    setSegments((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...patch } : s))
    );
  };

  const deleteSegment = (index: number) => {
    setSegments((prev) => prev.filter((_, i) => i !== index));
  };

  const addSegment = () => {
    const t = video.currentTime || clipStart;
    setSegments((prev) => [
      ...prev,
      { start: t, end: t + 3, text: "New subtitle" },
    ]);
  };

  return (
    <Card className="border-zinc-800 bg-card">
      <CardContent className="space-y-4 py-4">
        {/* Header with toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Captions className="size-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-zinc-100">
              Burned-in Subtitles
            </h3>
            {withSubtitles && segments.length > 0 && (
              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-300">
                {segments.length} cues
              </Badge>
            )}
          </div>
          <Switch
            checked={withSubtitles}
            onCheckedChange={setWithSubtitles}
            aria-label="Enable subtitles"
          />
        </div>

        {!withSubtitles ? (
          <p className="text-xs text-zinc-500">
            Toggle on to burn Whisper-generated subtitles into the rendered
            clip. You can edit the text and timing below.
          </p>
        ) : isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" />
            Loading transcript…
          </div>
        ) : segments.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-sm text-zinc-500">
              No transcript available for this clip.
            </p>
            <Button size="sm" variant="outline" onClick={addSegment}>
              <Plus className="size-3.5" />
              Add a subtitle manually
            </Button>
          </div>
        ) : (
          <>
            {/* Segment list */}
            <div className="max-h-[300px] space-y-1.5 overflow-y-auto pr-1">
              {segments.map((s, i) => (
                <SegmentRow
                  key={i}
                  segment={s}
                  onChange={(patch) => updateSegment(i, patch)}
                  onDelete={() => deleteSegment(i)}
                  onSeek={() => seekToSegment(s)}
                />
              ))}
            </div>

            <Button size="sm" variant="ghost" onClick={addSegment} className="w-full">
              <Plus className="size-3.5" />
              Add subtitle
            </Button>

            {/* Style controls */}
            <StyleControls
              style={subtitleStyle}
              onChange={setSubtitleStyle}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Segment row ────────────────────────────────────────────────────────────

function SegmentRow({
  segment,
  onChange,
  onDelete,
  onSeek,
}: {
  segment: SubtitleSegment;
  onChange: (patch: Partial<SubtitleSegment>) => void;
  onDelete: () => void;
  onSeek: () => void;
}) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-zinc-950/40 p-2">
      <div className="flex items-center gap-2">
        {/* Click timestamp to seek */}
        <button
          type="button"
          onClick={onSeek}
          className="flex shrink-0 items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300 hover:bg-zinc-700"
          title="Seek to this segment"
        >
          {formatTime(segment.start)}
        </button>
        <span className="text-[10px] text-zinc-600">→</span>
        <Input
          type="number"
          step="0.1"
          min="0"
          value={Number(segment.end.toFixed(2))}
          onChange={(e) =>
            onChange({ end: Math.max(segment.start + 0.1, Number(e.target.value)) })
          }
          className="h-6 w-20 px-1 py-0 text-xs"
        />
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto size-6 text-zinc-500 hover:text-rose-400"
          onClick={onDelete}
          aria-label="Delete subtitle"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
      <Input
        type="number"
        step="0.1"
        min="0"
        value={Number(segment.start.toFixed(2))}
        onChange={(e) =>
          onChange({ start: Math.min(segment.end - 0.1, Number(e.target.value)) })
        }
        className="mt-1 hidden h-6 w-20 px-1 py-0 text-xs"
      />
      <textarea
        value={segment.text}
        onChange={(e) => onChange({ text: e.target.value })}
        rows={2}
        className="mt-1.5 w-full resize-y rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-200 focus:border-emerald-500/50 focus:outline-none"
        placeholder="Subtitle text…"
      />
    </div>
  );
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// ─── Style controls ─────────────────────────────────────────────────────────

function StyleControls({
  style,
  onChange,
}: {
  style: SubtitleStyle;
  onChange: (patch: Partial<SubtitleStyle>) => void;
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
        <Palette className="size-3.5" />
        Style
      </p>
      <div className="grid grid-cols-2 gap-3">
        {/* Font size */}
        <div>
          <Label className="mb-1 flex items-center gap-1 text-[11px] text-zinc-500">
            <Type className="size-3" />
            Font size: {style.fontSize}px
          </Label>
          <Slider
            value={[style.fontSize]}
            onValueChange={([v]) => onChange({ fontSize: v })}
            min={12}
            max={48}
            step={1}
          />
        </div>

        {/* Position */}
        <div>
          <Label className="mb-1 flex items-center gap-1 text-[11px] text-zinc-500">
            Position
          </Label>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={style.position === "top" ? "default" : "outline"}
              className="h-7 flex-1 px-2"
              onClick={() => onChange({ position: "top" })}
            >
              <AlignVerticalJustifyStart className="size-3" />
            </Button>
            <Button
              size="sm"
              variant={style.position === "center" ? "default" : "outline"}
              className="h-7 flex-1 px-2"
              onClick={() => onChange({ position: "center" })}
            >
              <AlignVerticalJustifyCenter className="size-3" />
            </Button>
            <Button
              size="sm"
              variant={style.position === "bottom" ? "default" : "outline"}
              className="h-7 flex-1 px-2"
              onClick={() => onChange({ position: "bottom" })}
            >
              <AlignVerticalJustifyEnd className="size-3" />
            </Button>
          </div>
        </div>

        {/* Text color */}
        <div>
          <Label className="mb-1 block text-[11px] text-zinc-500">
            Text color
          </Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={style.color}
              onChange={(e) => onChange({ color: e.target.value })}
              className="size-7 rounded border border-zinc-700 bg-transparent"
            />
            <code className="text-xs text-zinc-400">{style.color}</code>
          </div>
        </div>

        {/* Background color */}
        <div>
          <Label className="mb-1 block text-[11px] text-zinc-500">
            Background
          </Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={style.bgColor.slice(0, 7)}
              onChange={(e) => onChange({ bgColor: e.target.value + "AA" })}
              className="size-7 rounded border border-zinc-700 bg-transparent"
            />
            <code className="text-xs text-zinc-400">{style.bgColor}</code>
          </div>
        </div>

        {/* Bold toggle */}
        <div className="col-span-2 flex items-center gap-2">
          <Switch
            checked={style.bold}
            onCheckedChange={(b) => onChange({ bold: b })}
            id="sub-bold"
          />
          <Label htmlFor="sub-bold" className="text-xs text-zinc-400">
            Bold text
          </Label>
        </div>
      </div>

      {/* Preview */}
      <div className="mt-3 overflow-hidden rounded bg-black">
        <div
          className={cn(
            "relative flex aspect-video items-center justify-center px-4",
            style.position === "top" && "items-start pt-3",
            style.position === "bottom" && "items-end pb-3",
            style.position === "center" && "items-center"
          )}
        >
          <span
            className="rounded px-1.5 py-0.5 text-center"
            style={{
              fontSize: `${Math.max(10, style.fontSize / 2)}px`,
              color: style.color,
              backgroundColor: style.bgColor,
              fontFamily: style.fontFamily,
              fontWeight: style.bold ? 700 : 400,
            }}
          >
            Preview subtitle text
          </span>
        </div>
      </div>
    </div>
  );
}
