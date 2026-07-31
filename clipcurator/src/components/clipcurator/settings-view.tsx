"use client";

// Settings view — configure YouTube channels and manage backing tracks.
//
// Two main sections:
//   1. Channel configuration — label each channel, see YouTube connection
//      status, refresh connection.
//   2. Backing track library — upload, list, delete MP3s used as background
//      music for clips.

import * as React from "react";
import {
  Youtube,
  Music,
  Upload,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Twitch,
  Plus,
  Radio,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

import {
  useChannels,
  useUpdateChannel,
  useRefreshChannel,
  useBackingTracks,
  useUploadBackingTrack,
  useDeleteBackingTrack,
  useTwitchChannels,
  useAddTwitchChannel,
  useDeleteTwitchChannel,
  useToggleTwitchAutoIngest,
} from "@/hooks/use-clipcurator";
import { CHANNEL_DEFAULTS, API_BASE } from "@/lib/constants";
import type { Channel, ChannelId } from "@/types";

export function SettingsView() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
        <p className="text-sm text-zinc-500">
          Configure YouTube channels, Twitch auto-ingest, and backing tracks.
        </p>
      </div>

      <ChannelConfigSection />
      <TwitchChannelSection />
      <BackingTrackSection />
    </div>
  );
}

// ─── Twitch auto-ingest ─────────────────────────────────────────────────────

function TwitchChannelSection() {
  const { data, isLoading } = useTwitchChannels();
  const addChannel = useAddTwitchChannel();
  const [channelName, setChannelName] = React.useState("");

  const channels = data?.channels ?? [];

  const onAdd = () => {
    const trimmed = channelName.trim();
    if (!trimmed) return;
    addChannel.mutate(trimmed, {
      onSuccess: () => setChannelName(""),
    });
  };

  return (
    <Card className="mb-6 border-zinc-800 bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Twitch className="size-4 text-purple-400" />
          Twitch Auto-Ingest
        </CardTitle>
        <CardDescription>
          Add Twitch channels to monitor. When a stream ends, ClipCurator
          automatically downloads the VOD and processes it for clips.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add channel form */}
        <div className="flex gap-2">
          <Input
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
            placeholder="Twitch username (e.g. ishowspeed)"
            className="h-9 flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") onAdd();
            }}
          />
          <Button
            size="sm"
            onClick={onAdd}
            disabled={addChannel.isPending || !channelName.trim()}
          >
            {addChannel.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Add
          </Button>
        </div>

        {/* Channel list */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <Twitch className="size-8 text-zinc-700" />
            <p className="text-sm text-zinc-500">
              No Twitch channels being monitored.
            </p>
            <p className="text-xs text-zinc-600">
              Add a channel above to auto-ingest VODs when streams end.
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {channels.map((ch: any) => (
              <TwitchChannelRow key={ch.id} channel={ch} />
            ))}
          </ul>
        )}

        {/* Info box */}
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400">
          <p className="mb-1 font-medium text-zinc-300">How auto-ingest works:</p>
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>The watcher polls Twitch every 60 seconds</li>
            <li>When a stream goes live → offline, it waits 5 minutes</li>
            <li>Fetches the latest VOD URL via Twitch API</li>
            <li>Auto-submits to ClipCurator for download + analysis</li>
          </ol>
          <p className="mt-2 text-zinc-500">
            Requires <code className="rounded bg-zinc-800 px-1 text-emerald-300">TWITCH_CLIENT_ID</code> and{" "}
            <code className="rounded bg-zinc-800 px-1 text-emerald-300">TWITCH_CLIENT_SECRET</code> in .env
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function TwitchChannelRow({ channel }: { channel: any }) {
  const del = useDeleteTwitchChannel();
  const toggle = useToggleTwitchAutoIngest();

  return (
    <li className="flex items-center gap-3 rounded-md border border-zinc-800/80 bg-zinc-950/40 px-3 py-2">
      <Twitch className="size-4 shrink-0 text-purple-400" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-200">
          {channel.displayName ?? channel.channelName}
        </p>
        <p className="text-xs text-zinc-500">
          {channel.isLive ? (
            <span className="flex items-center gap-1 text-red-400">
              <Radio className="size-3 animate-pulse" />
              Live now
            </span>
          ) : (
            "Offline"
          )}
          {channel.lastIngestedAt && (
            <span className="ml-2">
              · Last ingested: {new Date(channel.lastIngestedAt).toLocaleDateString()}
            </span>
          )}
        </p>
      </div>

      {/* Auto-ingest toggle */}
      <Button
        size="sm"
        variant={channel.autoIngest ? "default" : "outline"}
        className="h-7 px-2 text-xs"
        onClick={() => toggle.mutate({ id: channel.id, autoIngest: !channel.autoIngest })}
        disabled={toggle.isPending}
      >
        {channel.autoIngest ? "Auto" : "Manual"}
      </Button>

      <Button
        size="icon"
        variant="ghost"
        className="size-7 text-zinc-500 hover:text-rose-400"
        onClick={() => del.mutate(channel.id)}
        disabled={del.isPending}
        aria-label="Remove channel"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );
}

// ─── Channel config ─────────────────────────────────────────────────────────

function ChannelConfigSection() {
  const { data, isLoading } = useChannels();
  const channels = data?.channels ?? [];

  return (
    <Card className="mb-6 border-zinc-800 bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Youtube className="size-4 text-red-400" />
          YouTube Channels
        </CardTitle>
        <CardDescription>
          Configure which YouTube account each channel publishes to. Tokens are
          stored per channel — Channel A uses <code>.youtube-tokens.json</code>,
          Channel B uses <code>.youtube-tokens-b.json</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : channels.length === 0 ? (
          <p className="text-sm text-zinc-500">No channels configured.</p>
        ) : (
          channels.map((ch) => (
            <ChannelCard key={ch.id} channel={ch} />
          ))
        )}

        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400">
          <p className="mb-1 font-medium text-zinc-300">How to authorize a channel:</p>
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              On the server, run{" "}
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-emerald-300">
                node youtube_auth.js
              </code>{" "}
              for Channel A, or with the{" "}
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-emerald-300">
                --tokens=.youtube-tokens-b.json
              </code>{" "}
              flag for Channel B.
            </li>
            <li>Complete the OAuth flow in your browser.</li>
            <li>
              Come back here and click{" "}
              <span className="font-medium text-zinc-200">Refresh</span> — the
              channel name + avatar will appear.
            </li>
          </ol>
        </div>
      </CardContent>
    </Card>
  );
}

function ChannelCard({ channel }: { channel: Channel }) {
  const update = useUpdateChannel();
  const refresh = useRefreshChannel();
  const [label, setLabel] = React.useState(channel.label);

  React.useEffect(() => {
    setLabel(channel.label);
  }, [channel.label]);

  const defaults =
    channel.id === "CHANNEL_A"
      ? CHANNEL_DEFAULTS.CHANNEL_A
      : CHANNEL_DEFAULTS.CHANNEL_B;

  const accentClass =
    channel.id === "CHANNEL_A"
      ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
      : "text-blue-400 bg-blue-500/10 border-blue-500/30";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex size-10 items-center justify-center rounded-md border",
              accentClass
            )}
          >
            <Youtube className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-100">
                {channel.id === "CHANNEL_A" ? "Channel A" : "Channel B"}
              </h3>
              {channel.isConfigured ? (
                <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                  <CheckCircle2 className="mr-1 size-3" />
                  Connected
                </Badge>
              ) : (
                <Badge className="bg-rose-500/15 text-rose-300 border-rose-500/30">
                  <XCircle className="mr-1 size-3" />
                  Not configured
                </Badge>
              )}
            </div>
            <p className="text-xs text-zinc-500">{defaults.description}</p>
          </div>
        </div>

        {channel.isConfigured && channel.youtubeChannelName && (
          <div className="flex items-center gap-2">
            <Avatar className="size-8">
              <AvatarImage src={channel.youtubeChannelAvatar ?? undefined} />
              <AvatarFallback className="bg-zinc-800 text-xs text-zinc-300">
                {channel.youtubeChannelName.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="text-right">
              <p className="text-sm font-medium text-zinc-200">
                {channel.youtubeChannelName}
              </p>
              {channel.youtubeVideoId && (
                <p className="text-xs text-zinc-500">
                  ID: {channel.youtubeChannelId}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Display label (e.g. 'Main Highlights')"
          className="h-9"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => update.mutate({ id: channel.id as ChannelId, label })}
            disabled={update.isPending || label === channel.label}
          >
            Save label
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => refresh.mutate(channel.id as ChannelId)}
            disabled={refresh.isPending}
          >
            <RefreshCw className={cn("size-3.5", refresh.isPending && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1 text-xs text-zinc-600">
        <span>Token file:</span>
        <code className="rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-400">
          {channel.tokenFilePath}
        </code>
      </div>
    </div>
  );
}

// ─── Backing track library ──────────────────────────────────────────────────

function BackingTrackSection() {
  const { data, isLoading } = useBackingTracks();
  const upload = useUploadBackingTrack();
  const del = useDeleteBackingTrack();
  const tracks = data?.tracks ?? [];

  const [name, setName] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const onUpload = () => {
    if (!name.trim() || !file) return;
    upload.mutate(
      { name: name.trim(), file },
      {
        onSuccess: () => {
          setName("");
          setFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
        },
      }
    );
  };

  return (
    <Card className="border-zinc-800 bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Music className="size-4 text-emerald-400" />
          Backing Track Library
        </CardTitle>
        <CardDescription>
          Upload MP3/WAV/M4A files to use as background music. Selected per
          clip in the review queue.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Upload form */}
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Track name (e.g. 'Lofi Beat')"
            className="h-9"
          />
          <Input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="h-9 max-w-[240px] file:mr-2 file:rounded file:border file:border-zinc-700 file:bg-zinc-800 file:px-2 file:py-0.5 file:text-xs file:text-zinc-300"
          />
          <Button
            size="sm"
            onClick={onUpload}
            disabled={upload.isPending || !name.trim() || !file}
          >
            {upload.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            Upload
          </Button>
        </div>

        {/* Track list */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : tracks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <Music className="size-8 text-zinc-700" />
            <p className="text-sm text-zinc-500">No backing tracks uploaded yet.</p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {tracks.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 rounded-md border border-zinc-800/80 bg-zinc-950/40 px-3 py-2"
              >
                <Music className="size-4 shrink-0 text-zinc-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-200">
                    {t.name}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {t.durationSec
                      ? `${Math.floor(t.durationSec / 60)}:${String(
                          Math.floor(t.durationSec % 60)
                        ).padStart(2, "0")}`
                      : "—"}
                    {t.fileSizeBytes
                      ? ` · ${(t.fileSizeBytes / 1024 / 1024).toFixed(1)} MB`
                      : ""}
                  </p>
                </div>
                <a
                  href={`${API_BASE}${t.storagePath}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-500 hover:text-zinc-300"
                  aria-label="Preview track"
                >
                  <ExternalLink className="size-4" />
                </a>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 text-zinc-500 hover:text-rose-400"
                  onClick={() => del.mutate(t.id)}
                  disabled={del.isPending}
                  aria-label="Delete track"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
