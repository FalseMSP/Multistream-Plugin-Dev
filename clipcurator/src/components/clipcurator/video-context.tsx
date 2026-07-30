"use client";

// Lifts a single <video> element ref + playback state into React context so
// the queue view, the timeline trimmer, and any future children can all
// call seek/play/pause/setPlaybackRate without prop drilling.
//
// Handles the case where el.duration is Infinity (happens when the MP4's
// moov atom hasn't been read yet — common for non-faststart MP4s). In that
// case we fall back to a duration provided by the DB (source.durationSec)
// so the timeline can still render and seek works once metadata loads.

import * as React from "react";

export interface VideoContextValue {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  seek: (t: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setPlaybackRate: (r: number) => void;
  reload: () => void;
}

const VideoContext = React.createContext<VideoContextValue | null>(null);

export function VideoProvider({ children }: { children: React.ReactNode }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [playbackRate, setPlaybackRateState] = React.useState(1);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const onTime = () => setCurrentTime(el.currentTime || 0);
    const onMeta = () => {
      // el.duration can be Infinity if the MP4's moov atom is at the end
      // and the browser hasn't read it yet. In that case, keep duration at 0
      // — the queue-view falls back to source.durationSec from the DB.
      // Once the browser reads the moov atom (via range request), it fires
      // durationchange again with the real value.
      const d = el.duration;
      if (Number.isFinite(d) && d > 0) {
        setDuration(d);
      }
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onRate = () => setPlaybackRateState(el.playbackRate || 1);
    const onCanPlay = () => {
      // Sometimes durationchange fires before the element is actually ready.
      // loadedmetadata + canplay together cover all cases.
      const d = el.duration;
      if (Number.isFinite(d) && d > 0) {
        setDuration(d);
      }
    };

    el.addEventListener("timeupdate", onTime);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ratechange", onRate);

    if (Number.isFinite(el.duration) && el.duration > 0) {
      setDuration(el.duration);
    }

    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ratechange", onRate);
    };
  }, [reloadKey]);

  const seek = React.useCallback((t: number) => {
    const el = videoRef.current;
    if (!el) return;
    // Clamp to [0, duration]. If duration is Infinity or 0, just use t.
    const maxTime = Number.isFinite(el.duration) && el.duration > 0
      ? el.duration
      : t;
    const clamped = Math.max(0, Math.min(t, maxTime));
    try {
      el.currentTime = clamped;
      setCurrentTime(clamped);
    } catch {
      // Setting currentTime can throw if:
      // - Metadata isn't loaded yet (no duration)
      // - The browser can't seek (e.g. no moov atom)
      // In that case, we set currentTime state anyway so the UI updates,
      // and the actual seek will happen once metadata loads.
      setCurrentTime(clamped);
    }
  }, []);

  const play = React.useCallback(() => {
    void videoRef.current?.play().catch(() => undefined);
  }, []);

  const pause = React.useCallback(() => {
    videoRef.current?.pause();
  }, []);

  const togglePlay = React.useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, []);

  const setPlaybackRate = React.useCallback((r: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.playbackRate = r;
    setPlaybackRateState(r);
  }, []);

  const reload = React.useCallback(() => {
    setReloadKey((k) => k + 1);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
  }, []);

  const value = React.useMemo<VideoContextValue>(
    () => ({
      videoRef,
      currentTime,
      duration,
      isPlaying,
      playbackRate,
      seek,
      play,
      pause,
      togglePlay,
      setPlaybackRate,
      reload,
    }),
    [
      videoRef,
      currentTime,
      duration,
      isPlaying,
      playbackRate,
      seek,
      play,
      pause,
      togglePlay,
      setPlaybackRate,
      reload,
    ]
  );

  return <VideoContext.Provider value={value}>{children}</VideoContext.Provider>;
}

export function useVideo(): VideoContextValue {
  const ctx = React.useContext(VideoContext);
  if (!ctx) {
    throw new Error("useVideo must be used inside <VideoProvider>");
  }
  return ctx;
}
