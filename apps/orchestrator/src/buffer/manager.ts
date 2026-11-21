import fs from 'node:fs';
import { createLogger, Logger } from '@clipforge/shared';
import {
  BufferManagerOptions,
  BufferRange,
  BufferSegment,
  EvictionResult
} from './types.js';
import {
  listBufferSegments,
  findOverlappingSegments
} from './segment-index.js';

export class BufferManager {
  private options: Required<BufferManagerOptions>;
  private logger: Logger;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: BufferManagerOptions) {
    this.options = {
      bufferMinutes: 10,
      segmentSeconds: 2,
      marginSeconds: 60,
      evictionIntervalMs: 5000,
      db: options.db as any,
      logger: options.logger as any,
      onEvicted: options.onEvicted || (() => {}),
      onProtectedSkipped: options.onProtectedSkipped || (() => {}),
      ...options
    };
    this.logger = options.logger || createLogger('buffer', options.sessionId);
  }

  public start(): void {
    if (this.sweepTimer) return;

    this.sweepTimer = setInterval(() => {
      try {
        this.runEvictionSweep();
      } catch (err) {
        this.logger.error('Error during scheduled buffer eviction sweep', this.options.sessionId, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }, this.options.evictionIntervalMs);

    // Ensure timer does not prevent process exit
    this.sweepTimer.unref?.();
  }

  public stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Executes a single eviction sweep:
   * 1. Finds current live edge t_edge.
   * 2. Calculates retention cutoff: t_cutoff = t_edge - (bufferMinutes * 60 + marginSeconds).
   * 3. Selects segments ending before or at t_cutoff.
   * 4. Enforces clip job protection query via SQLite: protected segments are retained.
   * 5. Unlinks evictable segments and returns summary metrics.
   */
  public runEvictionSweep(): EvictionResult {
    const segments = listBufferSegments(this.options.bufferDir, this.options.segmentSeconds);

    if (segments.length === 0) {
      return {
        liveEdgeT: 0,
        cutoffT: 0,
        candidatesEvaluated: 0,
        evictedCount: 0,
        protectedCount: 0,
        evictedFiles: [],
        protectedFiles: []
      };
    }

    const liveEdgeT = Math.max(...segments.map((s) => s.end_t));
    const retentionSeconds = (this.options.bufferMinutes * 60) + this.options.marginSeconds;
    const cutoffT = Math.max(0, liveEdgeT - retentionSeconds);

    const candidates = segments.filter((seg) => seg.end_t <= cutoffT);

    const evictedFiles: string[] = [];
    const protectedFiles: string[] = [];
    const evictedSegments: BufferSegment[] = [];
    const protectedSegments: BufferSegment[] = [];

    for (const seg of candidates) {
      let isProtected = false;

      if (this.options.db) {
        try {
          isProtected = this.options.db.isSegmentProtected(
            this.options.sessionId,
            seg.start_t,
            seg.end_t
          );
        } catch (err) {
          this.logger.error('Failed to query segment protection from database', this.options.sessionId, {
            segment: seg.file,
            error: err instanceof Error ? err.message : String(err)
          });
          // On DB error, fail-safe: protect segment
          isProtected = true;
        }
      }

      if (isProtected) {
        protectedFiles.push(seg.file);
        protectedSegments.push(seg);
      } else {
        try {
          if (fs.existsSync(seg.path)) {
            fs.unlinkSync(seg.path);
          }
          evictedFiles.push(seg.file);
          evictedSegments.push(seg);
        } catch (err) {
          this.logger.error('Failed to unlink evicted buffer segment', this.options.sessionId, {
            segment: seg.file,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    if (evictedFiles.length > 0) {
      this.logger.info(
        `Evicted ${evictedFiles.length} buffer segments older than cutoff ${cutoffT.toFixed(1)}s`,
        this.options.sessionId,
        {
          evicted_count: evictedFiles.length,
          protected_skipped: protectedFiles.length,
          live_edge_t: liveEdgeT,
          cutoff_t: cutoffT
        }
      );
      this.options.onEvicted(evictedSegments);
    }

    if (protectedFiles.length > 0) {
      this.options.onProtectedSkipped(protectedSegments);
    }

    return {
      liveEdgeT,
      cutoffT,
      candidatesEvaluated: candidates.length,
      evictedCount: evictedFiles.length,
      protectedCount: protectedFiles.length,
      evictedFiles,
      protectedFiles
    };
  }

  public getBufferRange(): BufferRange | null {
    const segments = listBufferSegments(this.options.bufferDir, this.options.segmentSeconds);
    if (segments.length === 0) return null;

    const start_t = segments[0].start_t;
    const end_t = segments[segments.length - 1].end_t;
    const totalBytes = segments.reduce((sum, s) => sum + s.sizeBytes, 0);

    return {
      start_t,
      end_t,
      duration_s: Math.max(0, end_t - start_t),
      segmentCount: segments.length,
      totalBytes
    };
  }

  public getSegmentsForWindow(start_t: number, end_t: number): BufferSegment[] {
    const segments = listBufferSegments(this.options.bufferDir, this.options.segmentSeconds);
    return findOverlappingSegments(segments, start_t, end_t);
  }

  public getDiskUsage(): { segmentCount: number; totalBytes: number; totalMB: number } {
    const range = this.getBufferRange();
    if (!range) {
      return { segmentCount: 0, totalBytes: 0, totalMB: 0 };
    }
    return {
      segmentCount: range.segmentCount,
      totalBytes: range.totalBytes,
      totalMB: Number((range.totalBytes / (1024 * 1024)).toFixed(2))
    };
  }
}
