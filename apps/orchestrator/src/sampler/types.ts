import type {
  SamplerRequest,
  DetectorResponse,
  SamplerChatCounts
} from '@clipforge/shared';
import { BufferSegment } from '../buffer/types.js';

export interface SamplerConfig {
  intervalSeconds: number;
  audioWindowSeconds: number;
  audioSampleRate: number;
  scratchDir: string;
}

export interface DetectorClientConfig {
  url: string;
  timeoutMs: number;
  maxRetries?: number; // Default: 1
  retryDelayMs?: number; // Default: 100
}

export interface ChatCountProvider {
  getCounts(
    windowStartT: number,
    windowEndT: number
  ): SamplerChatCounts | Promise<SamplerChatCounts>;
}

export interface MediaExtractorOptions {
  ffmpegPath?: string;
}

export interface FrameExtractionOptions {
  segments: BufferSegment[];
  tStream: number;
  outputPath: string;
}

export interface AudioExtractionOptions {
  segments: BufferSegment[];
  startT: number;
  endT: number;
  sampleRate?: number;
  outputPath: string;
}

export interface SampleResult {
  request: SamplerRequest;
  response: DetectorResponse;
  retried: boolean;
  fallback: boolean;
  durationMs: number;
}
