import crypto from 'node:crypto';
import { createLogger, Logger } from '@clipforge/shared';
import type {
  ScoringConfig,
  DetectionEventSignals,
  DetectionEvent,
  DatabaseRepository
} from '@clipforge/shared';
import { fuseSignals } from './fusion.js';
import type { HypeScorerOptions, ScoredWindow } from './types.js';

export class HypeScorer {
  public readonly sessionId: string;
  public readonly sourceLabel: string;
  public readonly sourceDomain: string;
  public readonly config: ScoringConfig;
  private readonly db?: DatabaseRepository;
  private readonly logger: Logger;

  private consecutiveAboveThreshold: number = 0;
  private lastTriggeredTStream: number = -Infinity;

  constructor(options: HypeScorerOptions) {
    this.sessionId = options.sessionId;
    this.sourceLabel = options.sourceLabel;
    this.sourceDomain = options.sourceDomain;
    this.config = options.config;
    this.db = options.db;
    this.logger = options.logger || createLogger('scorer', options.sessionId);
  }

  /**
   * Scores an incoming detection window against configured weights, threshold, debounce, and cooldown.
   * If all signals are null, emits nothing (no DB record, no event, no clip trigger).
   */
  public score(input: {
    tStream: number;
    tWall?: string;
    signals: DetectionEventSignals;
  }): ScoredWindow {
    const tWall = input.tWall || new Date().toISOString();
    const { fusedScore, activeWeights } = fuseSignals(input.signals, this.config.weights);

    // All-null rule: emits nothing per PLAN.md acceptance
    if (fusedScore === null) {
      return {
        tStream: input.tStream,
        tWall,
        fusedScore: null,
        signals: input.signals,
        activeWeights: {},
        isAboveThreshold: false,
        consecutiveAboveThreshold: 0,
        inCooldown: this.isInCooldown(input.tStream),
        shouldClip: false,
        event: null
      };
    }

    // 1. Threshold check
    const isAboveThreshold = fusedScore >= this.config.threshold;
    if (isAboveThreshold) {
      this.consecutiveAboveThreshold++;
    } else {
      this.consecutiveAboveThreshold = 0;
    }

    // 2. Debounce check: score must stay above threshold for debounce_windows
    const isDebounced = this.consecutiveAboveThreshold >= this.config.debounce_windows;

    // 3. Cooldown check: no second clip from the same burst
    const inCooldown = this.isInCooldown(input.tStream);

    // 4. Clip trigger decision
    const shouldClip = isDebounced && !inCooldown;

    if (shouldClip) {
      this.lastTriggeredTStream = input.tStream;
      // Reset debounce counter after successful trigger
      this.consecutiveAboveThreshold = 0;
      this.logger.info('Hype threshold crossed, clip trigger emitted', this.sessionId, {
        t_stream: input.tStream,
        fused_score: fusedScore,
        threshold: this.config.threshold,
        active_weights: activeWeights
      });
    } else if (isAboveThreshold && inCooldown) {
      this.logger.debug('Threshold crossed but suppressed by cooldown', this.sessionId, {
        t_stream: input.tStream,
        fused_score: fusedScore,
        cooldown_remaining_s: this.getCooldownRemaining(input.tStream)
      });
    }

    // 5. Construct DetectionEvent matching CONTRACTS.md §4
    const event: DetectionEvent = {
      id: crypto.randomUUID(),
      session_id: this.sessionId,
      source_label: this.sourceLabel,
      source_domain: this.sourceDomain,
      t_stream: input.tStream,
      t_wall: tWall,
      fused_score: fusedScore,
      signals: input.signals,
      status: 'scored'
    };

    // 6. Persist scored detection to SQLite if database repository is attached
    if (this.db) {
      try {
        this.db.createDetection({
          id: event.id,
          session_id: event.session_id,
          source_label: event.source_label,
          source_domain: event.source_domain,
          t_stream: event.t_stream,
          t_wall: event.t_wall,
          fused_score: event.fused_score,
          signals: JSON.stringify(event.signals),
          status: 'scored'
        });
      } catch (err) {
        this.logger.error('Failed to persist detection event to SQLite', this.sessionId, {
          detection_id: event.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return {
      tStream: input.tStream,
      tWall,
      fusedScore,
      signals: input.signals,
      activeWeights,
      isAboveThreshold,
      consecutiveAboveThreshold: this.consecutiveAboveThreshold,
      inCooldown,
      shouldClip,
      event
    };
  }

  public isInCooldown(tStream: number): boolean {
    return tStream < this.lastTriggeredTStream + this.config.cooldown_seconds;
  }

  public getCooldownRemaining(tStream: number): number {
    return Math.max(0, Number(((this.lastTriggeredTStream + this.config.cooldown_seconds) - tStream).toFixed(2)));
  }

  public getConsecutiveAboveThreshold(): number {
    return this.consecutiveAboveThreshold;
  }

  public getLastTriggeredTStream(): number {
    return this.lastTriggeredTStream;
  }

  public reset(): void {
    this.consecutiveAboveThreshold = 0;
    this.lastTriggeredTStream = -Infinity;
  }
}
