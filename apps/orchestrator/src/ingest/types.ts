import type { Logger, DatabaseRepository } from '@clipforge/shared';

export type IngestState = 'idle' | 'starting' | 'running' | 'reconnecting' | 'stopped' | 'error';

export interface IngestOptions {
  streamUrl: string;
  sessionId: string;
  sourceLabel: string;
  sourceDomain: string;
  channelSlug: string;
  bufferDir: string;
  segmentDuration?: number; // Segment duration in seconds (default: 2)
  maxListSegments?: number; // HLS playlist size (default: 300)
  backoffSchedule?: number[]; // Exponential backoff intervals in ms (default: [1000, 2000, 4000, 8000, 16000, 30000])
  maxDisconnectTimeMs?: number; // Maximum disconnect time before hard error (default: 300000 / 5 minutes)
  fetcher?: 'direct' | 'streamlink' | 'yt-dlp' | 'auto'; // Stream ingest tool (default: 'auto')
  ffmpegPath?: string; // Custom path to ffmpeg binary (default: 'ffmpeg')
  db?: DatabaseRepository; // SQLite repository for session state persistence
  logger?: Logger; // Structured logger
  onStateChange?: (state: IngestState, prevState: IngestState) => void;
  onSegment?: (segmentPath: string, index: number) => void;
}

export interface IngestMetrics {
  state: IngestState;
  sessionId: string;
  reconnectAttempts: number;
  totalReconnects: number;
  lastStateChange: string;
  segmentsCount: number;
  lastSegmentFile?: string;
  lastSegmentTime?: string;
  error?: string;
}
