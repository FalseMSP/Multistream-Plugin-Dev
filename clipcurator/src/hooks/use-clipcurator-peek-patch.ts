// Add this hook to src/hooks/use-clipcurator.ts (anywhere after useLoadNextClip)

export function usePeekNextClip() {
  return useQuery({
    queryKey: ["queue", "peek"] as const,
    queryFn: () =>
      fetchJson<{
        clip: ClipWithSource | null;
        videoUrl: string | null;
        poster: string;
      }>(apiUrl("/api/queue/peek")),
    refetchInterval: 5000, // refresh every 5s so we always know the next clip
  });
}
