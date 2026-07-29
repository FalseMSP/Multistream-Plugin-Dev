// ClipCurator shared types
// Mirrors the Prisma schema but as plain TS types for client/server reuse.

export type Role = "ADMIN" | "REVIEWER";
export type Platform = "TWITCH" | "YOUTUBE";
export type SourceStatus =
  | "PENDING"
  | "DOWNLOADING"
  | "ANALYZING"
  | "READY"
  | "FAILED";
export type ClipStatus =
  | "PENDING"
  | "IN_REVIEW"
  | "APPROVED_A"
  | "APPROVED_B"
  | "REJECTED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED"
  | "RENDERED";
export type ChannelId = "CHANNEL_A" | "CHANNEL_B";
export type Decision = "A" | "B" | "REJECT";

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  avatarUrl: string | null;
  createdAt: string;
}

export interface StreamSource {
  id: string;
  url: string;
  platform: Platform;
  title: string | null;
  streamerName: string | null;
  durationSec: number | null;
  downloadedAt: string | null;
  status: SourceStatus;
  storagePath: string | null;
  errorMessage: string | null;
  progress: number;
  clipCount: number;
  submittedById: string | null;
  transcriptJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Channel {
  id: ChannelId;
  label: string;
  youtubeChannelId: string | null;
  youtubeChannelName: string | null;
  youtubeChannelAvatar: string | null;
  tokenFilePath: string;
  isConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackingTrack {
  id: string;
  name: string;
  storagePath: string;
  fileSizeBytes: number | null;
  durationSec: number | null;
  createdAt: string;
}

export interface Clip {
  id: string;
  sourceId: string;
  startTimeSec: number;
  endTimeSec: number;
  suggestedStart: number;
  suggestedEnd: number;
  status: ClipStatus;
  reviewerId: string | null;
  reviewedAt: string | null;
  finalStartSec: number | null;
  finalEndSec: number | null;
  storagePath: string | null;
  youtubeVideoId: string | null;
  publishedToChannelId: ChannelId | null;
  publishedAt: string | null;
  engagementScore: number;
  transcript: string | null;
  chatVelocity: number | null;
  thumbnailUrl: string | null;
  peakPhrase: string | null;
  // Post-processing options
  withSubtitles: boolean;
  subtitleVtt: string | null;
  subtitleStyle: string | null;
  withBackingTrack: boolean;
  backingTrackVolume: number;
  backingTrackId: string | null;
  // Retry tracking
  publishAttempts: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  source?: StreamSource;
  backingTrack?: BackingTrack | null;
}

export interface ClipWithSource extends Clip {
  source: StreamSource | null;
}

export interface QueuePayload {
  clip: ClipWithSource | null;
  queueLength: number;
}

// ─── Subtitle types ────────────────────────────────────────────────────────

export interface SubtitleSegment {
  start: number; // seconds
  end: number;   // seconds
  text: string;
}

export interface SubtitleStyle {
  fontSize: number;     // px, default 24
  color: string;        // hex, default "#FFFFFF"
  bgColor: string;      // hex with alpha, default "#000000AA"
  position: "top" | "bottom" | "center";
  fontFamily: string;   // default "Arial, sans-serif"
  bold: boolean;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: 24,
  color: "#FFFFFF",
  bgColor: "#000000AA",
  position: "bottom",
  fontFamily: "Arial, sans-serif",
  bold: true,
};

// ─── Review / render request ───────────────────────────────────────────────

export interface ReviewRequest {
  decision: Decision;
  finalStart: number;
  finalEnd: number;
  withSubtitles: boolean;
  subtitleVtt?: string;
  subtitleStyle?: SubtitleStyle;
  withBackingTrack: boolean;
  backingTrackId?: string | null;
  backingTrackVolume?: number;
}

export interface RenderOptions {
  finalStartSec: number;
  finalEndSec: number;
  withSubtitles: boolean;
  subtitleVtt?: string;
  subtitleStyle?: SubtitleStyle;
  withBackingTrack: boolean;
  backingTrackPath?: string | null;
  backingTrackVolume?: number;
}

export interface Stats {
  pending: number;
  inReview: number;
  publishedToday: number;
  rejectedToday: number;
  rejectionRate: number;
  totalClips: number;
  failedClips: number;
}

export interface PaginatedClips {
  items: ClipWithSource[];
  total: number;
  page: number;
  pageSize: number;
}
