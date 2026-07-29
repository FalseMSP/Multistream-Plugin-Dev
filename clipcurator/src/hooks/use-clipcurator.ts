"use client";

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useQueueStore } from "@/store/queue";
import { useToast } from "@/hooks/use-toast";
import { apiUrl } from "@/lib/constants";
import type {
  Channel,
  ChannelId,
  BackingTrack,
  ClipWithSource,
  Decision,
  ReviewRequest,
  SubtitleSegment,
  SubtitleStyle,
} from "@/types";

// ─── Query keys ─────────────────────────────────────────────────────────────
export const qk = {
  stats: ["stats"] as const,
  streams: ["streams"] as const,
  clips: (params: Record<string, string | number>) =>
    ["clips", params] as const,
  queueNext: ["queue", "next"] as const,
  jobs: ["jobs"] as const,
  channels: ["channels"] as const,
  backingTracks: ["backing-tracks"] as const,
  transcript: (sourceId: string) => ["transcript", sourceId] as const,
  subtitles: (clipId: string) => ["subtitles", clipId] as const,
};

// ─── Fetch helpers ──────────────────────────────────────────────────────────
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
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
      }>(apiUrl("/api/stats")),
    refetchInterval: 3000,
  });
}

// ─── Streams ────────────────────────────────────────────────────────────────
export function useStreams() {
  return useQuery({
    queryKey: qk.streams,
    queryFn: () => fetchJson<{ sources: any[] }>(apiUrl("/api/streams")),
    refetchInterval: 2000,
  });
}

export function useSubmitStream() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (url: string) =>
      fetchJson<{ source: any }>(apiUrl("/api/streams"), {
        method: "POST",
        body: JSON.stringify({ url }),
      }),
    onSuccess: (data) => {
      toast({
        title: "Stream submitted",
        description: `Downloading ${data.source.title ?? data.source.url}…`,
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
      fetchJson<{ ok: boolean }>(apiUrl(`/api/streams/${id}/reprocess`), {
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
      fetchJson<QueueNextResponse>(apiUrl("/api/queue/next")),
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

export interface ReviewArgs {
  clipId: string;
  decision: Decision | "DOWNLOAD";
  finalStart: number;
  finalEnd: number;
  withSubtitles: boolean;
  subtitleVtt?: string;
  subtitleStyle?: SubtitleStyle;
  withBackingTrack: boolean;
  backingTrackId?: string | null;
  backingTrackVolume?: number;
}

export function useSubmitReview() {
  const qc = useQueryClient();
  const setCurrentClip = useQueueStore((s) => s.setCurrentClip);
  const { toast } = useToast();
  return useMutation({
    mutationFn: (args: ReviewArgs) => {
      const body: ReviewRequest = {
        decision: args.decision,
        finalStart: args.finalStart,
        finalEnd: args.finalEnd,
        withSubtitles: args.withSubtitles,
        subtitleVtt: args.subtitleVtt,
        subtitleStyle: args.subtitleStyle,
        withBackingTrack: args.withBackingTrack,
        backingTrackId: args.backingTrackId,
        backingTrackVolume: args.backingTrackVolume,
      };
      return fetchJson<{ clip: any }>(
        apiUrl(`/api/queue/${args.clipId}/review`),
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
    },
    onSuccess: (data, vars) => {
      const label =
        vars.decision === "REJECT"
          ? "Rejected"
          : vars.decision === "DOWNLOAD"
            ? "Rendered for download"
            : `Publishing to Channel ${vars.decision}`;
      toast({
        title: label,
        description:
          vars.decision === "REJECT"
            ? "Clip archived."
            : vars.decision === "DOWNLOAD"
              ? "Render complete — use the Download button to save the MP4."
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

// ─── Render preview (download button) ───────────────────────────────────────
export function useRenderPreview() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (args: ReviewArgs) => {
      const res = await fetch(apiUrl(`/api/clips/${args.clipId}/render-preview`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          finalStart: args.finalStart,
          finalEnd: args.finalEnd,
          withSubtitles: args.withSubtitles,
          subtitleVtt: args.subtitleVtt,
          subtitleStyle: args.subtitleStyle,
          withBackingTrack: args.withBackingTrack,
          backingTrackId: args.backingTrackId,
          backingTrackVolume: args.backingTrackVolume,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? "render failed");
      }
      return res.json() as Promise<{ storagePath: string }>;
    },
    onSuccess: (data, vars) => {
      toast({
        title: "Render complete",
        description: "Starting download…",
      });
      // Trigger browser download via the download endpoint
      const downloadUrl = apiUrl(`/api/clips/${vars.clipId}/download`);
      window.open(downloadUrl, "_blank");
    },
    onError: (err: Error) => {
      toast({
        title: "Render failed",
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
      return fetchJson<{
        items: ClipWithSource[];
        total: number;
        page: number;
        pageSize: number;
      }>(apiUrl(`/api/clips?${qs.toString()}`));
    },
    refetchInterval: 4000,
  });
}

// ─── Jobs ───────────────────────────────────────────────────────────────────
export function useJobs() {
  return useQuery({
    queryKey: qk.jobs,
    queryFn: () => fetchJson<{ jobs: any[] }>(apiUrl("/api/jobs")),
    refetchInterval: 1500,
  });
}

// ─── Channels ───────────────────────────────────────────────────────────────
export function useChannels() {
  return useQuery({
    queryKey: qk.channels,
    queryFn: () => fetchJson<{ channels: Channel[] }>(apiUrl("/api/channels")),
    refetchInterval: 10000,
  });
}

export function useUpdateChannel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (args: { id: ChannelId; label?: string }) =>
      fetchJson<{ channel: Channel }>(apiUrl(`/api/channels/${args.id}`), {
        method: "PUT",
        body: JSON.stringify({ label: args.label }),
      }),
    onSuccess: () => {
      toast({ title: "Channel updated" });
      qc.invalidateQueries({ queryKey: qk.channels });
    },
    onError: (err: Error) => {
      toast({
        title: "Update failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
}

export function useRefreshChannel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: ChannelId) =>
      fetchJson<{ channel: Channel }>(apiUrl(`/api/channels/${id}`), {
        method: "POST",
        body: JSON.stringify({ action: "refresh" }),
      }),
    onSuccess: (data) => {
      if (data.channel.isConfigured) {
        toast({
          title: `${data.channel.label} connected`,
          description: data.channel.youtubeChannelName ?? undefined,
        });
      } else {
        toast({
          title: "Channel not configured",
          description:
            "Tokens missing or invalid. Run the OAuth flow on the server.",
          variant: "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: qk.channels });
    },
    onError: (err: Error) => {
      toast({
        title: "Refresh failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
}

// ─── Backing tracks ─────────────────────────────────────────────────────────
export function useBackingTracks() {
  return useQuery({
    queryKey: qk.backingTracks,
    queryFn: () =>
      fetchJson<{ tracks: BackingTrack[] }>(apiUrl("/api/backing-tracks")),
    refetchInterval: 30000,
  });
}

export function useUploadBackingTrack() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (args: { name: string; file: File }) => {
      const formData = new FormData();
      formData.append("name", args.name);
      formData.append("file", args.file);
      const res = await fetch(apiUrl("/api/backing-tracks"), {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? "upload failed");
      }
      return res.json() as Promise<{ track: BackingTrack }>;
    },
    onSuccess: () => {
      toast({ title: "Backing track uploaded" });
      qc.invalidateQueries({ queryKey: qk.backingTracks });
    },
    onError: (err: Error) => {
      toast({
        title: "Upload failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
}

export function useDeleteBackingTrack() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ ok: boolean }>(apiUrl(`/api/backing-tracks/${id}`), {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast({ title: "Backing track deleted" });
      qc.invalidateQueries({ queryKey: qk.backingTracks });
    },
    onError: (err: Error) => {
      toast({
        title: "Delete failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
}

// ─── Transcript (Whisper segments for subtitle editor) ──────────────────────
export function useTranscript(
  sourceId: string | null | undefined,
  start?: number,
  end?: number
) {
  return useQuery({
    queryKey: sourceId
      ? [...qk.transcript(sourceId), start ?? null, end ?? null]
      : ["transcript", "disabled"],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (start != null) params.set("start", String(start));
      if (end != null) params.set("end", String(end));
      const qs = params.toString();
      const url = apiUrl(
        `/api/sources/${sourceId}/transcript${qs ? `?${qs}` : ""}`
      );
      return fetchJson<{ sourceId: string; segments: SubtitleSegment[] }>(url);
    },
    enabled: !!sourceId,
  });
}

// ─── Subtitles (per-clip saved VTT) ─────────────────────────────────────────
export function useClipSubtitles(clipId: string | null | undefined) {
  return useQuery({
    queryKey: clipId ? qk.subtitles(clipId) : ["subtitles", "disabled"],
    queryFn: () =>
      fetchJson<{
        withSubtitles: boolean;
        subtitleVtt: string | null;
        subtitleStyle: SubtitleStyle | null;
      }>(apiUrl(`/api/clips/${clipId}/subtitles`)),
    enabled: !!clipId,
  });
}
