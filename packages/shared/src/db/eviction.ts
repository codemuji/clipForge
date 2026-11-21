import { DatabaseSync } from 'node:sqlite';

export interface BufferSegment {
  file: string;
  start_t: number;
  end_t: number;
}

/**
 * Checks if a given buffer segment time window [start_t, end_t] is protected
 * by any active or queued clip job.
 * Per CONTRACTS.md §5 and ADR-003 §4.3:
 * "A buffer segment cannot be deleted while any clip_jobs row with status in (queued, cutting) covers its time range."
 */
export function isSegmentProtected(
  db: DatabaseSync,
  sessionId: string,
  segmentStartT: number,
  segmentEndT: number
): boolean {
  const query = `
    SELECT 1 FROM clip_jobs
    WHERE status IN ('queued', 'cutting')
      AND session_id = ?
      AND NOT (end_t <= ? OR start_t >= ?)
    LIMIT 1;
  `;
  const stmt = db.prepare(query);
  const row = stmt.get(sessionId, segmentStartT, segmentEndT);
  return row !== undefined;
}

/**
 * Given a list of candidate buffer segments, filters and returns only those
 * that are safe to evict (i.e. NOT protected by pending clip jobs).
 */
export function getEvictableSegments(
  db: DatabaseSync,
  sessionId: string,
  candidateSegments: BufferSegment[]
): BufferSegment[] {
  return candidateSegments.filter((seg) => !isSegmentProtected(db, sessionId, seg.start_t, seg.end_t));
}
