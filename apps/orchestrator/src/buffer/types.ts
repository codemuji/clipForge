import type { Logger, DatabaseRepository } from '@clipforge/shared';

export interface BufferSegment {
  file: string; // e.g. seg_00042.ts
  path: string; // absolute path to file
  index: number; // parsed integer index
  start_t: number; // start stream time in seconds
  end_t: number; // end stream time in seconds
  sizeBytes: number;
  mtimeMs: number;
}

export interface BufferManagerOptions {
  bufferDir: string;
  sessionId: string;
  bufferMinutes?: number; // Retention window in minutes (default: 10)
  segmentSeconds?: number; // Segment duration in seconds (default: 2)
  marginSeconds?: number; // Grace safety margin in seconds (default: 60)
  evictionIntervalMs?: number; // Sweep check interval in ms (default: 5000)
  db?: DatabaseRepository; // SQLite repository for clip job protection check
  logger?: Logger; // Structured logger
  onEvicted?: (evicted: BufferSegment[]) => void;
  onProtectedSkipped?: (skipped: BufferSegment[]) => void;
}

export interface BufferRange {
  start_t: number;
  end_t: number;
  duration_s: number;
  segmentCount: number;
  totalBytes: number;
}

export interface EvictionResult {
  liveEdgeT: number;
  cutoffT: number;
  candidatesEvaluated: number;
  evictedCount: number;
  protectedCount: number;
  evictedFiles: string[];
  protectedFiles: string[];
}
