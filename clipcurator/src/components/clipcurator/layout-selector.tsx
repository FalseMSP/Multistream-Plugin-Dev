"use client";

import * as React from "react";
import { Smartphone, Square, Layout, Move } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useQueueStore, type VideoLayout } from "@/store/queue";

const LAYOUT_OPTIONS: {
  id: VideoLayout;
  label: string;
  description: string;
}[] = [
  { id: "original", label: "Original", description: "Keep source aspect ratio (use for vertical Twitch streams)" },
  { id: "vertical_center", label: "Center + Blur", description: "9:16 with video centered, blurred background fill" },
  { id: "vertical_top", label: "Video Top", description: "9:16, video at top, facecam area at bottom" },
  { id: "vertical_bottom", label: "Video Bottom", description: "9:16, video at bottom, facecam area at top" },
  { id: "vertical_split", label: "Split", description: "9:16, video on top, facecam on bottom (adjustable)" },
];

export function LayoutSelector() {
  const layout = useQueueStore((s) => s.layout);
  const setLayout = useQueueStore((s) => s.setLayout);
  const splitRatio = useQueueStore((s) => s.splitRatio);
  const setSplitRatio = useQueueStore((s) => s.setSplitRatio);

  return (
    <Card className="border-zinc-800 bg-card">
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center gap-2">
          <Layout className="size-4 text-emerald-400" />
          <h3 className="text-sm font-semibold text-zinc-100">Video Layout</h3>
        </div>

        <div className="grid grid-cols-5 gap-2">
          {LAYOUT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setLayout(opt.id)}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-md border p-2 transition",
                layout === opt.id
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700"
              )}
              title={opt.description}
            >
              <LayoutPreview layout={opt.id} splitRatio={splitRatio} />
              <span className={cn(
                "text-[10px] font-medium",
                layout === opt.id ? "text-emerald-300" : "text-zinc-400"
              )}>
                {opt.label}
              </span>
            </button>
          ))}
        </div>

        {layout === "vertical_split" && (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
            <Label className="mb-2 flex items-center gap-1.5 text-xs text-zinc-400">
              <Move className="size-3" />
              Facecam area: {Math.round(splitRatio * 100)}%
            </Label>
            <Slider
              value={[Math.round(splitRatio * 100)]}
              onValueChange={([v]) => setSplitRatio(v / 100)}
              min={20}
              max={50}
              step={5}
            />
            <div className="mt-1 flex justify-between text-[10px] text-zinc-600">
              <span>20% (smaller)</span>
              <span>50% (equal split)</span>
            </div>
          </div>
        )}

        <p className="text-xs text-zinc-500">
          {LAYOUT_OPTIONS.find((o) => o.id === layout)?.description}
        </p>

        {layout === "original" && (
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2 text-xs text-emerald-300/70">
            <Smartphone className="mr-1 inline size-3" />
            If you stream vertically on Twitch, your VOD is already 9:16 —
            use "Original" to publish without any transform.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LayoutPreview({ layout, splitRatio }: { layout: VideoLayout; splitRatio: number }) {
  return (
    <div className="relative h-12 w-7 overflow-hidden rounded-sm border border-zinc-700 bg-black">
      {layout === "original" && (
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/40 to-blue-500/40" />
      )}
      {layout === "vertical_center" && (
        <>
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/15 to-blue-500/15" />
          <div className="absolute inset-x-1 top-1/2 h-5 -translate-y-1/2 rounded-sm bg-gradient-to-br from-emerald-500/50 to-blue-500/50" />
        </>
      )}
      {layout === "vertical_top" && (
        <>
          <div className="absolute inset-x-0 top-0 h-3/4 bg-gradient-to-br from-emerald-500/50 to-blue-500/50" />
          <div className="absolute inset-x-0 bottom-0 h-1/4 bg-zinc-800" />
          <div className="absolute bottom-0.5 left-1/2 h-1.5 w-3 -translate-x-1/2 rounded-full bg-zinc-600" />
        </>
      )}
      {layout === "vertical_bottom" && (
        <>
          <div className="absolute inset-x-0 top-0 h-1/4 bg-zinc-800" />
          <div className="absolute top-0.5 left-1/2 h-1.5 w-3 -translate-x-1/2 rounded-full bg-zinc-600" />
          <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-br from-emerald-500/50 to-blue-500/50" />
        </>
      )}
      {layout === "vertical_split" && (
        <>
          <div
            className="absolute inset-x-0 top-0 bg-gradient-to-br from-emerald-500/50 to-blue-500/50"
            style={{ height: `${(1 - splitRatio) * 100}%` }}
          />
          <div
            className="absolute inset-x-0 bottom-0 bg-zinc-800"
            style={{ height: `${splitRatio * 100}%` }}
          />
          <div
            className="absolute left-1/2 -translate-x-1/2 rounded-full bg-zinc-600"
            style={{ bottom: `${splitRatio * 50}%`, height: "3px", width: "6px" }}
          />
        </>
      )}
    </div>
  );
}
