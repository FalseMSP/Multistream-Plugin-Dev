// PATCH for src/hooks/use-clipcurator.ts
//
// Add this hook anywhere in the file (e.g. after useReprocessStream).
// It provides the delete-stream mutation used by the admin-streams-view.

export function useDeleteStream() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<{ ok: boolean; deletedClips: number }>(
        apiUrl(`/api/streams/${id}`),
        { method: "DELETE" }
      ),
    onSuccess: (data) => {
      toast({
        title: "Stream deleted",
        description: `${data.deletedClips} clips removed. VOD files cleaned up.`,
      });
      qc.invalidateQueries({ queryKey: qk.streams });
      qc.invalidateQueries({ queryKey: qk.stats });
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
