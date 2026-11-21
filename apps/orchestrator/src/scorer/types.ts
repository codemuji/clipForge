import type {
  ScoringConfig,
  ScoringWeights,
  DetectionEventSignals,
  DetectionEvent
} from '@clipforge/shared';
import type { DatabaseRepository } from '@clipforge/shared';
import type { Logger } from '@clipforge/shared';

export interface SignalFusionResult {
  fusedScore: number | null;
  activeWeights: Record<string, number>;
}

export interface ScoredWindow {
  tStream: number;
  tWall: string;
  fusedScore: number | null;
  signals: DetectionEventSignals;
  activeWeights: Record<string, number>;
  isAboveThreshold: boolean;
  consecutiveAboveThreshold: number;
  inCooldown: boolean;
  shouldClip: boolean;
  event: DetectionEvent | null;
}

export interface HypeScorerOptions {
  sessionId: string;
  sourceLabel: string;
  sourceDomain: string;
  config: ScoringConfig;
  db?: DatabaseRepository;
  logger?: Logger;
}
