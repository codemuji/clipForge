import type {
  ClipforgeConfigType,
  DetectionEvent,
  DatabaseRepository,
  DbSession,
  Logger
} from '@clipforge/shared';
import type { DetectorClient } from '../sampler/detector-client.js';
import type { ChatSignalAdapter } from '../chat/adapter.js';
import type { CutResult } from '../cutter/types.js';

export type PipelineStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'draining' | 'error';

export interface PipelineOrchestratorOptions {
  config?: ClipforgeConfigType;
  configPath?: string;
  storageRoot?: string;
  dbPath?: string;
  db?: DatabaseRepository;
  logger?: Logger;
  ffmpegPath?: string;
  ffprobePath?: string;
  detectorClient?: DetectorClient;
  detectorUrl?: string;
  chatAdapter?: ChatSignalAdapter;
  sessionId?: string;
  sourceUrl?: string;
  sourceLabel?: string;
  pollIntervalMs?: number;
  onClipCut?: (result: CutResult) => void;
  onDetection?: (event: DetectionEvent) => void;
  onStateChange?: (status: PipelineStatus, prevStatus: PipelineStatus) => void;
}

export interface PipelineMetrics {
  status: PipelineStatus;
  sessionId: string;
  sourceUrl?: string;
  sourceDomain?: string;
  channelSlug?: string;
  segmentsProcessed: number;
  detectionsCount: number;
  clipsCutCount: number;
  activeCutsCount: number;
  startedAt?: string;
}
