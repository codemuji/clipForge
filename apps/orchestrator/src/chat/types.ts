import type { SamplerChatCounts, SignalChat } from '@clipforge/shared';

export interface ChatAdapterConfig {
  /**
   * Whether platform chat ingestion and signal computation is active.
   * Default: false (off by default per PLAN.md acceptance)
   */
  enabled?: boolean;

  /**
   * Source platform or adapter type.
   * Default: 'none'
   */
  platform?: 'none' | 'mock' | 'twitch' | 'youtube' | 'kick';

  /**
   * Channel identifier or slug.
   */
  channel?: string;

  /**
   * Baseline message velocity (messages per second) corresponding to normal activity.
   * Used for normalizing hype velocity into [0, 1].
   * Default: 5.0
   */
  baselineVelocity?: number;

  /**
   * Rolling retention window in seconds for in-memory event timestamps.
   * Events older than this cutoff are automatically evicted from memory.
   * Default: 120.0
   */
  baselineWindowSeconds?: number;

  /**
   * Maximum events per minute before rate-limiting drops incoming events.
   * Default: 600
   */
  maxEventsPerMinute?: number;
}

export interface EphemeralChatEvent {
  t: number;           // Stream timestamp in seconds
  chatterId: number;   // In-memory ephemeral numeric index; no PII or usernames
}

export interface ChatWindowStats extends SamplerChatCounts {
  windowStartT: number;
  windowEndT: number;
  durationSeconds: number;
  velocity: number;    // Messages per second
}
