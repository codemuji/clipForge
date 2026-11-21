import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger, Logger } from '@clipforge/shared';
import type { SamplerRequest } from '@clipforge/shared';
import { listBufferSegments } from '../buffer/segment-index.js';
import { MediaExtractor } from './extractor.js';
import { DetectorClient } from './detector-client.js';
import type {
  SamplerConfig,
  ChatCountProvider,
  SampleResult
} from './types.js';

export interface StreamSamplerOptions {
  sessionId: string;
  bufferDir: string;
  config: SamplerConfig;
  detectorClient: DetectorClient;
  chatProvider?: ChatCountProvider;
  mediaExtractor?: MediaExtractor;
  logger?: Logger;
  segmentSeconds?: number;
}

export class StreamSampler {
  public readonly sessionId: string;
  public readonly bufferDir: string;
  public readonly config: SamplerConfig;
  private readonly detectorClient: DetectorClient;
  private readonly mediaExtractor: MediaExtractor;
  private readonly chatProvider?: ChatCountProvider;
  private readonly logger: Logger;
  private readonly segmentSeconds: number;

  private lastSampledTStream: number = -1;
  private isRunning: boolean = false;
  private pollTimer?: NodeJS.Timeout;

  constructor(options: StreamSamplerOptions) {
    this.sessionId = options.sessionId;
    this.bufferDir = options.bufferDir;
    this.config = options.config;
    this.detectorClient = options.detectorClient;
    this.mediaExtractor = options.mediaExtractor || new MediaExtractor();
    this.chatProvider = options.chatProvider;
    this.logger = options.logger || createLogger('sampler', options.sessionId);
    this.segmentSeconds = options.segmentSeconds || 2;

    if (!fs.existsSync(this.config.scratchDir)) {
      fs.mkdirSync(this.config.scratchDir, { recursive: true });
    }
  }

  public getLastSampledTStream(): number {
    return this.lastSampledTStream;
  }

  public canSampleAt(tStream: number): boolean {
    return tStream > this.lastSampledTStream;
  }

  /**
   * Samples a specific stream timestamp tStream.
   * Strictly enforces monotonic progression: throws if tStream <= lastSampledTStream.
   */
  async sampleAt(tStream: number): Promise<SampleResult | null> {
    if (!this.canSampleAt(tStream)) {
      this.logger.warn(
        `Rejected non-monotonic sample request: requested t=${tStream} <= last_t=${this.lastSampledTStream}`,
        this.sessionId,
        { requested_t: tStream, last_t: this.lastSampledTStream }
      );
      throw new Error(
        `Non-monotonic stream sampling rejected: requested t=${tStream} must be strictly greater than lastSampledT=${this.lastSampledTStream}`
      );
    }

    const segments = listBufferSegments(this.bufferDir, this.segmentSeconds);
    if (segments.length === 0) {
      return null;
    }

    const liveEdge = segments[segments.length - 1].end_t;
    if (tStream > liveEdge + 0.1) {
      // Stream hasn't reached this point yet
      return null;
    }

    const windowId = crypto.randomUUID();
    const framePath = path.join(this.config.scratchDir, `frame_${windowId}.jpg`);
    const audioPath = path.join(this.config.scratchDir, `audio_${windowId}.wav`);

    const audioStartT = Math.max(0, tStream - this.config.audioWindowSeconds);

    const startTime = Date.now();

    // 1. Extract video frame (JPEG)
    await this.mediaExtractor.extractFrame({
      segments,
      tStream,
      outputPath: framePath
    });

    // 2. Extract audio window (16kHz WAV mono)
    await this.mediaExtractor.extractAudio({
      segments,
      startT: audioStartT,
      endT: tStream,
      sampleRate: this.config.audioSampleRate,
      outputPath: audioPath
    });

    // 3. Gather aggregate chat metrics
    const chat = this.chatProvider
      ? await this.chatProvider.getCounts(Math.max(0, tStream - this.config.intervalSeconds), tStream)
      : { messages_in_window: 0, unique_chatters: 0 };

    // 4. Construct SamplerRequest conforming to CONTRACTS.md §2
    const request: SamplerRequest = {
      session_id: this.sessionId,
      window_id: windowId,
      t_stream: tStream,
      t_wall: new Date().toISOString(),
      frame_path: framePath,
      audio_path: audioPath,
      audio_sample_rate: this.config.audioSampleRate,
      chat
    };

    // 5. Submit to detector service (with 1 retry, then null signals fallback)
    const { response, retried, fallback } = await this.detectorClient.analyze(request);

    // 6. Update monotonic water mark
    this.lastSampledTStream = tStream;

    const durationMs = Date.now() - startTime;

    return {
      request,
      response,
      retried,
      fallback,
      durationMs
    };
  }

  /**
   * Advances sampling by evaluating the latest available complete segment in the rolling buffer.
   */
  async step(): Promise<SampleResult | null> {
    const segments = listBufferSegments(this.bufferDir, this.segmentSeconds);
    if (segments.length === 0) {
      return null;
    }

    const liveEdge = segments[segments.length - 1].end_t;
    let nextT: number;

    if (this.lastSampledTStream < 0) {
      // First sample: start at earliest complete window
      const earliestAvailable = segments[0].start_t;
      nextT = Math.max(earliestAvailable + this.config.intervalSeconds, this.segmentSeconds);
    } else {
      nextT = this.lastSampledTStream + this.config.intervalSeconds;
    }

    if (nextT > liveEdge) {
      return null;
    }

    return this.sampleAt(nextT);
  }

  /**
   * Starts periodic polling of the buffer for new sample windows.
   */
  start(onSample?: (result: SampleResult) => void): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const pollInterval = Math.max(200, Math.min(1000, this.config.intervalSeconds * 500));

    const poll = async () => {
      if (!this.isRunning) return;
      try {
        const result = await this.step();
        if (result && onSample) {
          onSample(result);
        }
      } catch (err) {
        this.logger.error('Sampler step failed', this.sessionId, {
          error: err instanceof Error ? err.message : String(err)
        });
      }

      if (this.isRunning) {
        this.pollTimer = setTimeout(poll, pollInterval);
        this.pollTimer.unref?.();
      }
    };

    this.pollTimer = setTimeout(poll, pollInterval);
    this.pollTimer.unref?.();
  }

  /**
   * Stops periodic sampling and clears timers.
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
