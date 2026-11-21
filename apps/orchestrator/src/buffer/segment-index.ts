import fs from 'node:fs';
import path from 'node:path';
import { BufferSegment } from './types.js';

const SEGMENT_REGEX = /(?:seg_)?(\d+)\.ts$/;

/**
 * Parses segment index and stream timestamp window [start_t, end_t] from filename.
 */
export function parseSegmentFilename(
  filename: string,
  segmentSeconds: number = 2
): { index: number; start_t: number; end_t: number } | null {
  const match = filename.match(SEGMENT_REGEX);
  if (!match) return null;

  const index = parseInt(match[1], 10);
  const start_t = index * segmentSeconds;
  const end_t = (index + 1) * segmentSeconds;

  return { index, start_t, end_t };
}

/**
 * Lists, stats, and sorts all existing buffer segment files in bufferDir by stream start time.
 */
export function listBufferSegments(
  bufferDir: string,
  segmentSeconds: number = 2
): BufferSegment[] {
  if (!fs.existsSync(bufferDir)) {
    return [];
  }

  const entries = fs.readdirSync(bufferDir);
  const segments: BufferSegment[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.ts') || entry.includes('.tmp')) {
      continue;
    }

    const parsed = parseSegmentFilename(entry, segmentSeconds);
    if (!parsed) continue;

    const fullPath = path.join(bufferDir, entry);
    try {
      const stat = fs.statSync(fullPath);
      segments.push({
        file: entry,
        path: fullPath,
        index: parsed.index,
        start_t: parsed.start_t,
        end_t: parsed.end_t,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs
      });
    } catch {
      // File could be deleted or renamed concurrently
    }
  }

  segments.sort((a, b) => a.start_t - b.start_t);
  return segments;
}

/**
 * Returns all segments that overlap the target time window [start_t, end_t].
 */
export function findOverlappingSegments(
  segments: BufferSegment[],
  start_t: number,
  end_t: number
): BufferSegment[] {
  return segments.filter((seg) => !((seg.end_t <= start_t) || (seg.start_t >= end_t)));
}
