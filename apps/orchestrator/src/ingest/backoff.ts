export const DEFAULT_BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Calculates exponential backoff delay based on retry attempt index.
 * Follows ADR-001 §6: 1s, 2s, 4s, 8s, 16s, capped at 30s.
 *
 * @param attempt 0-based retry attempt index
 * @param schedule Optional custom backoff schedule array in milliseconds
 * @returns delay in milliseconds
 */
export function getBackoffDelay(
  attempt: number,
  schedule: number[] = DEFAULT_BACKOFF_SCHEDULE
): number {
  if (schedule.length === 0) {
    return 1000;
  }
  const safeAttempt = Math.max(0, attempt);
  const index = Math.min(safeAttempt, schedule.length - 1);
  return schedule[index];
}
