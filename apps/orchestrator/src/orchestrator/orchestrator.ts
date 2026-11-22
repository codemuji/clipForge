import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  createLogger,
  Logger,
  ClipforgeConfigType,
  createDatabase,
  DatabaseRepository,
  DbSession,
  DetectionEvent
} from '@clipforge/shared';
import { loadOrchestratorConfig, isSourceAllowed, assertSourceAllowed } from '../config.js';
import { IngestManager } from '../ingest/manager.js';
import { BufferManager } from '../buffer/manager.js';
import { listBufferSegments } from '../buffer/segment-index.js';
import { StreamSampler } from '../sampler/sampler.js';
import { DetectorClient } from '../sampler/detector-client.js';
import { ChatSignalAdapter } from '../chat/adapter.js';
import { HypeScorer } from '../scorer/scorer.js';
import { ClipCutter } from '../cutter/cutter.js';
import { normalizeSourceDomain, normalizeChannelSlug } from '../cutter/paths.js';
import type { CutResult } from '../cutter/types.js';
import type {
  PipelineStatus,
  PipelineOrchestratorOptions,
  PipelineMetrics
} from './types.js';

export class PipelineOrchestrator extends EventEmitter {
  public readonly sessionId: string;
  public readonly storageRoot: string;
  public readonly config: ClipforgeConfigType;
  public readonly db: DatabaseRepository;
  public readonly logger: Logger;

  private status: PipelineStatus = 'idle';
  private session?: DbSession;
  private bufferDir: string;
  private scratchDir: string;
  private ffmpegPath: string;
  private ffprobePath: string;

  private bufferManager?: BufferManager;
  private ingestManager?: IngestManager;
  private sampler?: StreamSampler;
  private detectorClient: DetectorClient;
  private chatAdapter?: ChatSignalAdapter;
  private scorer?: HypeScorer;
  private cutter?: ClipCutter;

  private pollTimer?: NodeJS.Timeout;
  private readonly activeCuts: Set<Promise<CutResult>> = new Set();
  private isProcessingSample: boolean = false;
  private boundSigintHandler?: () => void;
  private boundSigtermHandler?: () => void;

  private segmentsProcessedCount: number = 0;
  private detectionsCount: number = 0;
  private clipsCutCount: number = 0;
  private startedAt?: string;

  constructor(private options: PipelineOrchestratorOptions = {}) {
    super();

    // 1. Config resolution
    if (options.config) {
      this.config = options.config;
    } else {
      this.config = loadOrchestratorConfig(options.configPath);
    }

    this.sessionId = options.sessionId || `sess_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
    this.storageRoot = path.resolve(options.storageRoot || this.config.storage.root || './storage');
    this.logger = options.logger || createLogger('orchestrator', this.sessionId);
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.ffprobePath = options.ffprobePath || 'ffprobe';

    // 2. Storage directories
    this.bufferDir = path.join(this.storageRoot, 'buffer', this.sessionId);
    this.scratchDir = path.join(this.storageRoot, 'tmp', this.sessionId);

    // 3. Database initialization
    if (options.db) {
      this.db = options.db;
    } else {
      const dbPath = options.dbPath || path.join(this.storageRoot, 'db', 'clipforge.sqlite');
      const { repo } = createDatabase(dbPath);
      this.db = repo;
    }

    // 4. Detector client
    this.detectorClient = options.detectorClient || new DetectorClient({
      url: options.detectorUrl || this.config.detector.url || 'http://127.0.0.1:8731',
      timeoutMs: this.config.detector.timeout_ms || 2500
    });

    // 5. Chat adapter
    this.chatAdapter = options.chatAdapter;
  }

  public getStatus(): PipelineStatus {
    return this.status;
  }

  public getSession(): DbSession | undefined {
    return this.session;
  }

  public getMetrics(): PipelineMetrics {
    return {
      status: this.status,
      sessionId: this.sessionId,
      sourceUrl: this.session?.source_url,
      sourceDomain: this.session?.source_domain,
      channelSlug: this.session?.channel_slug,
      segmentsProcessed: this.segmentsProcessedCount,
      detectionsCount: this.detectionsCount,
      clipsCutCount: this.clipsCutCount,
      activeCutsCount: this.activeCuts.size,
      startedAt: this.startedAt
    };
  }

  /**
   * Starts the end-to-end highlight-clipping daemon.
   */
  public async start(customSourceUrl?: string): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') {
      return;
    }

    this.transitionStatus('starting');
    this.startedAt = new Date().toISOString();

    try {
      // 1. Resolve source
      let sourceUrl = customSourceUrl || this.options.sourceUrl;
      let sourceLabel = this.options.sourceLabel;

      if (!sourceUrl) {
        const enabledSource = this.config.sources.find((s) => s.enabled);
        if (!enabledSource) {
          const err = new Error('No enabled stream sources found in configuration');
          this.logger.error(err.message, this.sessionId);
          throw err;
        }
        sourceUrl = enabledSource.url;
        sourceLabel = enabledSource.label;
      }

      // Check allow-list for non-local streams
      const isLocalFile = fs.existsSync(sourceUrl);
      if (!isLocalFile) {
        assertSourceAllowed(this.config, sourceUrl, this.logger);
      }

      const domain = isLocalFile ? 'local' : normalizeSourceDomain(sourceUrl);
      const channel = sourceLabel ? normalizeChannelSlug(sourceLabel) : normalizeChannelSlug(path.basename(sourceUrl, path.extname(sourceUrl)));

      // 2. Ensure filesystem directories exist
      fs.mkdirSync(this.bufferDir, { recursive: true });
      fs.mkdirSync(this.scratchDir, { recursive: true });
      fs.mkdirSync(path.join(this.storageRoot, 'clips'), { recursive: true });

      // 3. Register session in SQLite
      this.session = this.db.createSession({
        id: this.sessionId,
        source_url: sourceUrl,
        source_label: sourceLabel || channel,
        source_domain: domain,
        channel_slug: channel,
        status: 'active',
        started_at: this.startedAt,
        ended_at: null
      });

      this.logger.info('Starting pipeline orchestrator', this.sessionId, {
        source_url: sourceUrl,
        domain,
        channel,
        buffer_dir: this.bufferDir
      });

      // 4. Instantiate BufferManager
      this.bufferManager = new BufferManager({
        sessionId: this.sessionId,
        bufferDir: this.bufferDir,
        bufferMinutes: this.config.buffer.minutes,
        segmentSeconds: this.config.buffer.segment_seconds,
        db: this.db,
        logger: this.logger
      });
      this.bufferManager.start();

      // 5. Instantiate HypeScorer
      this.scorer = new HypeScorer({
        sessionId: this.sessionId,
        sourceLabel: this.session.source_label,
        sourceDomain: this.session.source_domain,
        config: this.config.scoring,
        db: this.db,
        logger: this.logger
      });

      // 6. Instantiate ClipCutter
      this.cutter = new ClipCutter({
        storageRoot: this.storageRoot,
        clipConfig: this.config.clip,
        db: this.db,
        logger: this.logger,
        ffmpegPath: this.ffmpegPath,
        ffprobePath: this.ffprobePath
      });

      // 7. Instantiate StreamSampler
      this.sampler = new StreamSampler({
        sessionId: this.sessionId,
        bufferDir: this.bufferDir,
        config: {
          intervalSeconds: this.config.sampling.interval_seconds,
          audioWindowSeconds: this.config.sampling.audio_window_seconds,
          audioSampleRate: 16000,
          scratchDir: this.scratchDir
        },
        detectorClient: this.detectorClient,
        chatProvider: this.chatAdapter,
        segmentSeconds: this.config.buffer.segment_seconds,
        logger: this.logger
      });

      // 8. Instantiate IngestManager
      this.ingestManager = new IngestManager({
        sessionId: this.sessionId,
        streamUrl: sourceUrl,
        sourceLabel: this.session.source_label,
        sourceDomain: domain,
        channelSlug: channel,
        bufferDir: this.bufferDir,
        segmentDuration: this.config.buffer.segment_seconds,
        db: this.db,
        logger: this.logger,
        ffmpegPath: this.ffmpegPath,
        onSegment: () => {
          // Trigger sampling on segment arrival
          this.processLatestBufferEdge().catch((err) => {
            this.logger.error('Error during segment edge processing', this.sessionId, { error: err.message });
          });
        }
      });

      // 9. Start periodic poll timer as backup to segment events
      const pollInterval = this.options.pollIntervalMs || (this.config.sampling.interval_seconds * 1000);
      this.pollTimer = setInterval(() => {
        this.processLatestBufferEdge().catch((err) => {
          this.logger.error('Error during scheduled buffer sampling poll', this.sessionId, { error: err.message });
        });
      }, pollInterval);
      this.pollTimer.unref?.();

      // 10. Start stream ingestion
      await this.ingestManager.start();

      // 11. Attach signal listeners for graceful exit
      this.setupSignalHandlers();

      this.transitionStatus('running');
    } catch (err) {
      this.transitionStatus('error');
      throw err;
    }
  }

  /**
   * Samples the latest available edge in the rolling buffer and passes signals to scorer.
   */
  public async processLatestBufferEdge(): Promise<boolean> {
    if (this.status !== 'running' || this.isProcessingSample || !this.sampler || !this.scorer || !this.cutter || !this.session) {
      return false;
    }

    const segments = listBufferSegments(this.bufferDir, this.config.buffer.segment_seconds);
    if (segments.length === 0) {
      return false;
    }

    const latestSegment = segments[segments.length - 1];
    // We sample at latest segment end_t minus a small offset
    const targetT = latestSegment.end_t;

    if (!this.sampler.canSampleAt(targetT)) {
      return false;
    }

    this.isProcessingSample = true;
    try {
      const sample = await this.sampler.sampleAt(targetT);
      if (!sample) {
        return false;
      }

      this.segmentsProcessedCount++;

      // Score window
      const scored = this.scorer.score({
        tStream: sample.request.t_stream,
        signals: sample.response.signals
      });

      if (scored.event) {
        this.detectionsCount++;
        this.options.onDetection?.(scored.event);
        this.emit('detection', scored.event);
      }

      if (scored.shouldClip && scored.event) {
        this.triggerClipCut(scored.event);
      }

      return true;
    } finally {
      this.isProcessingSample = false;
    }
  }

  /**
   * Spawns an asynchronous clip cutting job and tracks it in activeCuts for graceful draining.
   */
  private triggerClipCut(detection: DetectionEvent): Promise<CutResult> {
    if (!this.cutter || !this.session) {
      throw new Error('Cannot cut clip: cutter or session uninitialized');
    }

    const cutPromise = this.cutter.cut({
      detection,
      session: this.session,
      bufferDir: this.bufferDir
    }).then((result) => {
      this.clipsCutCount++;
      this.options.onClipCut?.(result);
      this.emit('clip', result);
      return result;
    }).catch((err) => {
      this.logger.error('Failed to cut clip for detection', this.sessionId, {
        detection_id: detection.id,
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }).finally(() => {
      this.activeCuts.delete(cutPromise);
    });

    this.activeCuts.add(cutPromise);
    return cutPromise;
  }

  /**
   * Deterministically processes all segments in buffer sequentially.
   * Useful for unit tests, offline fixture validation, and soak testing.
   */
  public async processSegmentsSequentially(options: {
    startT?: number;
    endT?: number;
    stepSeconds?: number;
  } = {}): Promise<{ clips: CutResult[]; detections: DetectionEvent[] }> {
    if (!this.sampler || !this.scorer || !this.cutter || !this.session) {
      throw new Error('Pipeline components must be initialized before processing');
    }

    const segments = listBufferSegments(this.bufferDir, this.config.buffer.segment_seconds);
    if (segments.length === 0) {
      return { clips: [], detections: [] };
    }

    const minT = options.startT ?? segments[0].start_t;
    const maxT = options.endT ?? segments[segments.length - 1].end_t;
    const step = options.stepSeconds ?? this.config.sampling.interval_seconds;

    const collectedClips: CutResult[] = [];
    const collectedDetections: DetectionEvent[] = [];

    for (let t = minT + step; t <= maxT; t += step) {
      const roundedT = Number(t.toFixed(3));
      if (!this.sampler.canSampleAt(roundedT)) continue;

      const sample = await this.sampler.sampleAt(roundedT);
      if (!sample) continue;

      this.segmentsProcessedCount++;
      const scored = this.scorer.score({
        tStream: sample.request.t_stream,
        signals: sample.response.signals
      });

      if (scored.event) {
        this.detectionsCount++;
        collectedDetections.push(scored.event);
        this.options.onDetection?.(scored.event);
        this.emit('detection', scored.event);
      }

      if (scored.shouldClip && scored.event) {
        const cutResult = await this.triggerClipCut(scored.event);
        collectedClips.push(cutResult);
      }
    }

    // Await all cuts
    await Promise.allSettled(Array.from(this.activeCuts));

    return {
      clips: collectedClips,
      detections: collectedDetections
    };
  }

  /**
   * Graceful shutdown:
   * Stops ingest and sampling, drains all in-flight cutting jobs, cleans up timers,
   * updates SQLite session to 'ended', and resets status to 'idle'.
   */
  public async stop(): Promise<void> {
    if (this.status === 'stopping' || this.status === 'draining' || this.status === 'idle') {
      return;
    }

    this.transitionStatus('stopping');
    this.logger.info('Stopping pipeline orchestrator...', this.sessionId);

    // 1. Remove signal handlers
    this.removeSignalHandlers();

    // 2. Clear poll timer
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    // 3. Stop Ingest process
    if (this.ingestManager) {
      try {
        await this.ingestManager.stop();
      } catch (err) {
        this.logger.warn('Error stopping ingest manager', this.sessionId, { error: String(err) });
      }
      this.ingestManager = undefined;
    }

    // 4. Stop BufferManager eviction timer
    if (this.bufferManager) {
      this.bufferManager.stop();
      this.bufferManager = undefined;
    }

    // 5. Drain pending clip cuts
    this.transitionStatus('draining');
    if (this.activeCuts.size > 0) {
      this.logger.info(`Draining ${this.activeCuts.size} active clip jobs before shutdown...`, this.sessionId);
      await Promise.allSettled(Array.from(this.activeCuts));
      this.activeCuts.clear();
      this.logger.info('All clip jobs finished successfully', this.sessionId);
    }

    // 6. Update session status to ended
    if (this.session) {
      try {
        this.db.updateSessionStatus(this.session.id, 'ended', new Date().toISOString());
      } catch (err) {
        this.logger.warn('Error updating session status on stop', this.sessionId, { error: String(err) });
      }
    }

    // 7. Cleanup scratch dir
    try {
      if (fs.existsSync(this.scratchDir)) {
        fs.rmSync(this.scratchDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }

    this.transitionStatus('idle');
    this.logger.info('Pipeline orchestrator stopped cleanly', this.sessionId);
  }

  private transitionStatus(next: PipelineStatus): void {
    const prev = this.status;
    this.status = next;
    this.options.onStateChange?.(next, prev);
    this.emit('stateChange', next, prev);
  }

  private setupSignalHandlers(): void {
    this.boundSigintHandler = async () => {
      this.logger.info('Received shutdown signal (SIGINT / Ctrl+C), beginning graceful drain...', this.sessionId);
      await this.stop();
    };

    this.boundSigtermHandler = async () => {
      this.logger.info('Received termination signal (SIGTERM), beginning graceful drain...', this.sessionId);
      await this.stop();
    };

    process.once('SIGINT', this.boundSigintHandler);
    process.once('SIGTERM', this.boundSigtermHandler);
  }

  private removeSignalHandlers(): void {
    if (this.boundSigintHandler) {
      process.removeListener('SIGINT', this.boundSigintHandler);
      this.boundSigintHandler = undefined;
    }
    if (this.boundSigtermHandler) {
      process.removeListener('SIGTERM', this.boundSigtermHandler);
      this.boundSigtermHandler = undefined;
    }
  }
}
