"use client";

// Lifts a single <video> element ref + playback state into React context so
// the queue view, the timeline trimmer, and any future children can all
// call seek/play/pause/setPlaybackRate without prop drilling.

import * as React from "react";

export interface VideoContextValue {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  // Live state (updated via timeupdate / loadedmetadata listeners)
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  // Imperative API
  seek: (t: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setPlaybackRate: (r: number) => void;
  // Bump to re-attach listeners after a fresh <video> mounts (e.g. src change).
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

  // Attach listeners once the <video> mounts or after a forced reload.
  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const onTime = () => setCurrentTime(el.currentTime || 0);
    const onMeta = () =>
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onRate = () => setPlaybackRateState(el.playbackRate || 1);

    el.addEventListener("timeupdate", onTime);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ratechange", onRate);

    // Initialize duration if metadata is already loaded.
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setDuration(el.duration);
    }

    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ratechange", onRate);
    };
  }, [reloadKey]);

  const seek = React.useCallback((t: number) => {
    const el = videoRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(t, el.duration || t));
    try {
      el.currentTime = clamped;
      setCurrentTime(clamped);
    } catch {
      /* may throw if metadata not loaded */
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
