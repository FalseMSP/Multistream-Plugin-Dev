"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/lib/constants";
import { useToast } from "@/hooks/use-toast";

// LLM viral potential scoring.
//
// Calls POST /api/clips/[id]/llm-score which uses the z-ai-web-dev-sdk
// to ask the LLM to score the clip's viral potential 0-100 based on
// the transcript + features.
//
// The score is stored on the clip and factored into the neural network's
// input features (feature index 10: llm_viral_score).

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

export function useLlmScoreClip() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (clipId: string) =>
      fetchJson<{ score: number; reasoning: string }>(
        apiUrl(`/api/clips/${clipId}/llm-score`),
        { method: "POST" }
      ),
    onSuccess: (data) => {
      toast({
        title: "LLM score generated",
        description: `Viral potential: ${Math.round(data.score * 100)}/100`,
      });
      qc.invalidateQueries({ queryKey: ["queue", "next"] });
    },
    onError: (err: Error) => {
      toast({
        title: "LLM scoring failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });
}
