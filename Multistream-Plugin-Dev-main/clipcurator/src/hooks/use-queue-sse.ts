"use client";

import { useEffect } from "react";
import { useQueueStore } from "@/store/queue";

// Subscribes to the /api/queue/sse Server-Sent Events stream and feeds
// live stats into the Zustand store. Reconnects on disconnect.
export function useQueueSse() {
  const setStats = useQueueStore((s) => s.setStats);
  const setQueueLength = useQueueStore((s) => s.setQueueLength);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      es = new EventSource("/api/queue/sse");
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          setStats({
            pending: data.pending ?? 0,
            inReview: data.inReview ?? 0,
            publishing: data.publishing ?? 0,
            publishedToday: data.publishedToday ?? 0,
            rejectedToday: data.rejectedToday ?? 0,
            failed: data.failed ?? 0,
          });
          setQueueLength(data.pending ?? 0);
        } catch {
          // ignore malformed events
        }
      };
      es.onerror = () => {
        es?.close();
        if (!closed) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [setStats, setQueueLength]);
}
