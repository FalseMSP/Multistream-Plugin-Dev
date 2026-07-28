"use client";

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useQueueStore } from "@/store/queue";
import { useToast } from "@/hooks/use-toast";
import type { ClipWithSource, Decision, ReviewRequest } from "@/types";

// ─── Query keys ─────────────────────────────────────────────────────────────
export const qk = {
  stats: ["stats"] as const,
  streams: ["streams"] as const,
  clips: (params: Record<string, string | number>) =>
    ["clips", params] as const,
  queueNext: ["queue", "next"] as const,
  jobs: ["jobs"] as const,
};

// ─── Fetch helpers ──────────────────────────────────────────────────────────
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    if (res.status === 401) {
      // Redirect to login — the app shell will handle this
      throw new Error("Authentication required");
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "request failed");
  }
  return res.json() as Promise<T>;
}

// ─── Stats ──────────────────────────────────────────────────────────────────
export function useStats() {
  return useQuery({
    queryKey: qk.stats,
    queryFn: () =>
      fetchJson<{
        pending: number;
        inReview: number;
        publishing: number;
        failed: number;
        totalClips: number;
        publishedToday: number;
        rejectedToday: number;
        rejectionRate: number;
        streams: number;
        streamsReady: number;
        streamsFailed: number;
      }>("/api/stats"),
    refetchInterval: 3000,
  });
}

// ─── Streams ────────────────────────────────────────────────────────────────
export function useStreams() {
  return useQuery({
    queryKey: qk.streams,
    queryFn: () =>
      fetchJson<{ sources: any[] }>("/api/streams"),
    refetchInterval: 2000,
  });
}

export function useSubmitStream() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (url: string) =>
      fetchJson<{ source: any }>("/api/streams", {
        method: "POST",
        body: JSON.stringify({ url }),
      }),
    onSuccess: (data) => {
      toast({
        title: "Stream submitted",
        description: `Processing ${data.source.title ?? data.source.url}…`,
      });
      qc.invalidateQueries({ queryKey: qk.streams });
      qc.invalidateQueries({ queryKey: qk.stats });
    },
    onError: (err: Error) => {
      toast({
        title: "Submission failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
}

export function useReprocessStream() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ ok: boolean }>(`/api/streams/${id}/reprocess`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast({ title: "Re-processing started" });
      qc.invalidateQueries({ queryKey: qk.streams });
      qc.invalidateQueries({ queryKey: qk.stats });
    },
    onError: (err: Error) => {
      toast({
        title: "Re-process failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
}

// ─── Queue ──────────────────────────────────────────────────────────────────
interface QueueNextResponse {
  clip: ClipWithSource | null;
  videoUrl: string | null;
  poster: string;
  queueLength: number;
}

export function useLoadNextClip() {
  const qc = useQueryClient();
  const setCurrentClip = useQueueStore((s) => s.setCurrentClip);
  const setQueueLength = useQueueStore((s) => s.setQueueLength);
  const setLoading = useQueueStore((s) => s.setLoading);
  const { toast } = useToast();
  return useMutation({
    mutationFn: () =>
      fetchJson<QueueNextResponse>("/api/queue/next"),
    onMutate: () => setLoading(true),
    onSuccess: (data) => {
      setCurrentClip(data.clip, data.videoUrl, data.poster);
      setQueueLength(data.queueLength);
      if (!data.clip) {
        toast({ title: "Queue is empty", description: "No pending clips to review." });
      }
      qc.invalidateQueries({ queryKey: qk.stats });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to load clip",
        description: err.message,
        variant: "destructive",
      });
    },
    onSettled: () => setLoading(false),
  });
}

export function useSubmitReview() {
  const qc = useQueryClient();
  const setCurrentClip = useQueueStore((s) => s.setCurrentClip);
  const { toast } = useToast();
  return useMutation({
    mutationFn: (args: { clipId: string; decision: Decision; finalStart: number; finalEnd: number }) => {
      const body: ReviewRequest = {
        decision: args.decision,
        finalStart: args.finalStart,
        finalEnd: args.finalEnd,
      };
      return fetchJson<{ clip: any }>(`/api/queue/${args.clipId}/review`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data, vars) => {
      const label = vars.decision === "REJECT" ? "Rejected" : `Published to Channel ${vars.decision}`;
      toast({
        title: label,
        description:
          vars.decision === "REJECT"
            ? "Clip archived."
            : "Render + upload started in background.",
      });
      setCurrentClip(null, null, "");
      qc.invalidateQueries({ queryKey: qk.stats });
      qc.invalidateQueries({ queryKey: qk.streams });
    },
    onError: (err: Error) => {
      toast({
        title: "Review submission failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
}

// ─── Clips (history) ────────────────────────────────────────────────────────
export function useClips(params: Record<string, string | number>) {
  return useQuery({
    queryKey: qk.clips(params),
    queryFn: () => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
      return fetchJson<{ items: ClipWithSource[]; total: number; page: number; pageSize: number }>(
        `/api/clips?${qs.toString()}`
      );
    },
    refetchInterval: 4000,
  });
}

// ─── Jobs (in-memory queue state for /queue UI) ─────────────────────────────
export function useJobs() {
  return useQuery({
    queryKey: qk.jobs,
    queryFn: () => fetchJson<{ jobs: any[] }>("/api/jobs"),
    refetchInterval: 1500,
  });
}
