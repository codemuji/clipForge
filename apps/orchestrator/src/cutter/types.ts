import type {
  DetectionEvent,
  ClipConfig,
  ClipSidecar,
  DbSession,
  DbClipJob,
  DbClip,
  DatabaseRepository,
  Logger
} from '@clipforge/shared';

export interface ClipCutterOptions {
  storageRoot?: string; // Default: './storage'
  clipConfig?: ClipConfig;
  db?: DatabaseRepository;
  logger?: Logger;
  ffmpegPath?: string;
  ffprobePath?: string;
}

export interface CutRequest {
  detection: DetectionEvent;
  session: DbSession;
  bufferDir: string;
  clipId?: string;
  requestedStartT?: number;
  requestedEndT?: number;
  vertical?: boolean;
  encode?: 'copy' | 'h264_nvenc' | 'h264_cpu';
}

export interface CutResult {
  job: DbClipJob;
  clip?: DbClip;
  sidecar: ClipSidecar;
  sidecarPath: string;
  mp4Path: string;
  durationSeconds: number;
  usedNvenc: boolean;
  fallbackToCpu: boolean;
}

export interface ProbedMediaMetadata {
  width: number;
  height: number;
  duration_s: number;
  codec: string;
  file_size_bytes: number;
}
