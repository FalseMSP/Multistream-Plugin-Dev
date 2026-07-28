"use client";

import { create } from "zustand";
import type { ClipWithSource } from "@/types";

export interface QueueState {
  currentClip: ClipWithSource | null;
  videoUrl: string | null;
  poster: string;
  queueLength: number;
  isLoading: boolean;
  isSubmitting: boolean;
  // Local trim state (mirrors what the timeline component is editing)
  trimStart: number;
  trimEnd: number;
  // Live SSE-driven stats
  stats: {
    pending: number;
    inReview: number;
    publishing: number;
    publishedToday: number;
    rejectedToday: number;
    failed: number;
  };
  // Actions are provided by hooks — store is purely state here.
  setCurrentClip: (clip: ClipWithSource | null, videoUrl: string | null, poster: string) => void;
  setQueueLength: (n: number) => void;
  setLoading: (b: boolean) => void;
  setSubmitting: (b: boolean) => void;
  setTrim: (start: number, end: number) => void;
  setStats: (s: Partial<QueueState["stats"]>) => void;
  reset: () => void;
}

export const useQueueStore = create<QueueState>((set) => ({
  currentClip: null,
  videoUrl: null,
  poster: "",
  queueLength: 0,
  isLoading: false,
  isSubmitting: false,
  trimStart: 0,
  trimEnd: 0,
  stats: {
    pending: 0,
    inReview: 0,
    publishing: 0,
    publishedToday: 0,
    rejectedToday: 0,
    failed: 0,
  },
  setCurrentClip: (clip, videoUrl, poster) =>
    set({
      currentClip: clip,
      videoUrl,
      poster,
      trimStart: clip?.suggestedStart ?? 0,
      trimEnd: clip?.suggestedEnd ?? 0,
    }),
  setQueueLength: (n) => set({ queueLength: n }),
  setLoading: (b) => set({ isLoading: b }),
  setSubmitting: (b) => set({ isSubmitting: b }),
  setTrim: (start, end) => set({ trimStart: start, trimEnd: end }),
  setStats: (s) =>
    set((state) => ({ stats: { ...state.stats, ...s } })),
  reset: () =>
    set({
      currentClip: null,
      videoUrl: null,
      poster: "",
      trimStart: 0,
      trimEnd: 0,
      queueLength: 0,
    }),
}));
