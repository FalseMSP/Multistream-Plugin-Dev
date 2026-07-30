"use client";

import { useEffect } from "react";
import { useQueueStore } from "@/store/queue";
import { apiUrl } from "@/lib/constants";

// Subscribes to the /api/queue/sse Server-Sent Events stream and feeds
// live stats into the Zustand store. Reconnects on disconnect.
//
// On 401 (session expired), redirects to /login — EventSource doesn't
// expose HTTP status codes directly, so we detect auth failure by
// checking if the connection closes immediately after opening.
export function useQueueSse() {
  const setStats = useQueueStore((s) => s.setStats);
  const setQueueLength = useQueueStore((s) => s.setQueueLength);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let messageCount = 0;
    let connectionTime = 0;

    const connect = () => {
      if (closed) return;
      // EventSource (like fetch) does NOT auto-prefix basePath — must do it manually.
      connectionTime = Date.now();
      messageCount = 0;
      es = new EventSource(apiUrl("/api/queue/sse"));

      es.onopen = () => {
        // Connection opened successfully — reset message count
      };

      es.onmessage = (ev) => {
        messageCount++;
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
        if (closed) return;

        // If the connection closed within 2 seconds and we never received
        // a single message, it's almost certainly a 401 (session expired).
        // The middleware returns 401 JSON for API routes, which EventSource
        // treats as a fatal error and closes immediately.
        const elapsed = Date.now() - connectionTime;
        if (elapsed < 2000 && messageCount === 0) {
          // Likely auth failure — redirect to login
          const currentPath = window.location.pathname + window.location.search;
          const loginUrl = apiUrl(
            `/login?redirect=${encodeURIComponent(currentPath)}`
          );
          window.location.href = loginUrl;
          return;
        }

        // Otherwise, normal disconnect — reconnect after 2s
        reconnectTimer = setTimeout(connect, 2000);
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
