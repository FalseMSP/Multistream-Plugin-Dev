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
  | "FAILED";
export type Channel = "CHANNEL_A" | "CHANNEL_B";
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
  createdAt: string;
  updatedAt: string;
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
  publishedTo: Channel | null;
  publishedAt: string | null;
  engagementScore: number;
  transcript: string | null;
  chatVelocity: number | null;
  thumbnailUrl: string | null;
  peakPhrase: string | null;
  publishAttempts: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  source?: StreamSource;
}

export interface ClipWithSource extends Clip {
  source: StreamSource | null;
}

export interface QueuePayload {
  clip: ClipWithSource | null;
  queueLength: number;
}

export interface ReviewRequest {
  decision: Decision;
  finalStart: number;
  finalEnd: number;
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
