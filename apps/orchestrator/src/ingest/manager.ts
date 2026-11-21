import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, Logger } from '@clipforge/shared';
import { IngestOptions, IngestState, IngestMetrics } from './types.js';
import { getBackoffDelay, DEFAULT_BACKOFF_SCHEDULE } from './backoff.js';

export class IngestManager extends EventEmitter {
  private options: IngestOptions;
  private state: IngestState = 'idle';
  private childProcess: ChildProcess | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disconnectStartTime: number | null = null;
  private reconnectAttempts = 0;
  private totalReconnects = 0;
  private isStopping = false;
  private logger: Logger;
  private lastStateChange: string = new Date().toISOString();
  private segmentsCount = 0;
  private lastSegmentFile?: string;
  private lastSegmentTime?: string;
  private dirWatcher: fs.FSWatcher | null = null;
  private seenSegments = new Set<string>();

  constructor(options: IngestOptions) {
    super();
    this.options = {
      segmentDuration: 2,
      maxListSegments: 300,
      backoffSchedule: DEFAULT_BACKOFF_SCHEDULE,
      maxDisconnectTimeMs: 300000, // 5 minutes per ADR-001
      fetcher: 'auto',
      ffmpegPath: 'ffmpeg',
      ...options
    };
    this.logger = options.logger || createLogger('ingest', options.sessionId);
  }

  public getState(): IngestState {
    return this.state;
  }

  public getMetrics(): IngestMetrics {
    return {
      state: this.state,
      sessionId: this.options.sessionId,
      reconnectAttempts: this.reconnectAttempts,
      totalReconnects: this.totalReconnects,
      lastStateChange: this.lastStateChange,
      segmentsCount: this.segmentsCount,
      lastSegmentFile: this.lastSegmentFile,
      lastSegmentTime: this.lastSegmentTime
    };
  }

  /**
   * Starts the ingest pipeline: creates buffer directory, updates SQLite session,
   * spawns the ingest process, and monitors segment output.
   */
  public async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      return;
    }

    this.isStopping = false;
    this.disconnectStartTime = null;

    // 1. Ensure buffer directory exists
    if (!fs.existsSync(this.options.bufferDir)) {
      fs.mkdirSync(this.options.bufferDir, { recursive: true });
    }

    // 2. Ensure SQLite session row exists and mark active
    if (this.options.db) {
      try {
        const existing = this.options.db.getSession(this.options.sessionId);
        if (!existing) {
          this.options.db.createSession({
            id: this.options.sessionId,
            source_url: this.options.streamUrl,
            source_label: this.options.sourceLabel,
            source_domain: this.options.sourceDomain,
            channel_slug: this.options.channelSlug,
            status: 'active',
            started_at: new Date().toISOString(),
            ended_at: null
          });
        } else {
          this.options.db.updateSessionStatus(this.options.sessionId, 'active');
        }
      } catch (err) {
        this.logger.error('Failed to sync session with SQLite store', this.options.sessionId, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // 3. Setup buffer directory watcher
    this.initBufferWatcher();

    // 4. Transition to starting and spawn
    this.transitionState('starting');
    this.spawnIngestProcess();
  }

  /**
   * Gracefully stops the ingest pipeline, terminates child processes,
   * updates SQLite session to 'ended', and cleans up timers.
   */
  public async stop(): Promise<void> {
    this.isStopping = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }

    if (this.childProcess) {
      const proc = this.childProcess;
      this.childProcess = null;
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Ignore if already dead
          }
          resolve();
        }, 2000);

        proc.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });

        try {
          proc.kill('SIGINT');
        } catch {
          resolve();
        }
      });
    }

    const endedAt = new Date().toISOString();
    if (this.options.db) {
      try {
        this.options.db.updateSessionStatus(this.options.sessionId, 'ended', endedAt);
      } catch (err) {
        this.logger.error('Failed to update session ended status in DB', this.options.sessionId, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    this.transitionState('stopped');
  }

  private transitionState(newState: IngestState, reason?: string): void {
    if (this.state === newState) return;

    const prevState = this.state;
    this.state = newState;
    this.lastStateChange = new Date().toISOString();

    this.logger.info(`Ingest state transitioned: ${prevState} -> ${newState}`, this.options.sessionId, {
      prev_state: prevState,
      new_state: newState,
      reason,
      reconnect_attempts: this.reconnectAttempts,
      total_reconnects: this.totalReconnects
    });

    // Update SQLite session status when applicable
    if (this.options.db) {
      try {
        if (newState === 'error') {
          this.options.db.updateSessionStatus(this.options.sessionId, 'error');
        } else if (newState === 'running') {
          this.options.db.updateSessionStatus(this.options.sessionId, 'active');
        }
      } catch (err) {
        this.logger.error('Error persisting state transition to DB', this.options.sessionId, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    this.options.onStateChange?.(newState, prevState);
    this.emit('stateChange', newState, prevState);
  }

  private spawnIngestProcess(): void {
    if (this.isStopping) return;

    const playlistPath = path.join(this.options.bufferDir, 'live.m3u8');
    const segmentPattern = path.join(this.options.bufferDir, 'seg_%05d.ts');
    const segmentDuration = this.options.segmentDuration || 2;
    const maxSegments = this.options.maxListSegments || 300;

    const ffmpegArgs = [
      '-re',
      '-i', this.options.streamUrl,
      '-c', 'copy',
      '-f', 'hls',
      '-hls_time', String(segmentDuration),
      '-hls_list_size', String(maxSegments),
      '-hls_flags', 'delete_segments+append_list+temp_file',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', segmentPattern,
      playlistPath
    ];

    const binary = this.options.ffmpegPath || 'ffmpeg';

    try {
      const child = spawn(binary, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.childProcess = child;

      let hasEstablishedStream = false;
      let stderrBuf = '';

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrBuf += text;
        // Keep only last 2048 chars for error diagnostic
        if (stderrBuf.length > 2048) {
          stderrBuf = stderrBuf.slice(-2048);
        }

        // Confirm active streaming when ffmpeg reports stream mapping or output creation
        if (!hasEstablishedStream && (text.includes('Stream mapping') || text.includes('Output #0') || text.includes('Opening'))) {
          hasEstablishedStream = true;
          if (this.state === 'starting' || this.state === 'reconnecting') {
            this.reconnectAttempts = 0;
            this.disconnectStartTime = null;
            this.transitionState('running');
          }
        }
      });

      child.on('error', (err: Error) => {
        this.handleProcessExit(-1, err.message);
      });

      child.on('exit', (code: number | null, signal: string | null) => {
        const exitMsg = `code=${code}, signal=${signal}: ${stderrBuf.trim()}`;
        this.handleProcessExit(code ?? -1, exitMsg);
      });
    } catch (err) {
      this.handleProcessExit(-1, err instanceof Error ? err.message : String(err));
    }
  }

  private handleProcessExit(exitCode: number, errorDetail: string): void {
    this.childProcess = null;

    if (this.isStopping) {
      this.transitionState('stopped');
      return;
    }

    // Check if network drop duration exceeded hard limit
    const now = Date.now();
    if (this.disconnectStartTime === null) {
      this.disconnectStartTime = now;
    }

    const elapsedMs = now - this.disconnectStartTime;
    const maxDisconnect = this.options.maxDisconnectTimeMs || 300000;

    if (elapsedMs >= maxDisconnect) {
      if (this.dirWatcher) {
        this.dirWatcher.close();
        this.dirWatcher = null;
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const hardError = `Ingest hard termination: disconnected for ${Math.round(elapsedMs / 1000)}s (budget ${maxDisconnect / 1000}s)`;
      this.logger.error(hardError, this.options.sessionId, { error: errorDetail });
      this.transitionState('error', hardError);
      this.emit('error', new Error(hardError));
      return;
    }

    // Calculate backoff
    this.reconnectAttempts++;
    this.totalReconnects++;
    const delay = getBackoffDelay(this.reconnectAttempts - 1, this.options.backoffSchedule);

    this.transitionState('reconnecting', errorDetail);

    this.logger.warn(
      `Stream ingest disconnected (attempt ${this.reconnectAttempts}). Reconnecting in ${delay}ms...`,
      this.options.sessionId,
      {
        attempt: this.reconnectAttempts,
        backoff_delay_ms: delay,
        elapsed_disconnect_s: Math.round(elapsedMs / 1000),
        detail: errorDetail.slice(-200)
      }
    );

    this.emit('reconnect', this.reconnectAttempts, delay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isStopping) {
        this.spawnIngestProcess();
      }
    }, delay);
  }

  private initBufferWatcher(): void {
    if (this.dirWatcher) return;

    // Scan initial files to prevent false segment events
    try {
      const existing = fs.readdirSync(this.options.bufferDir);
      for (const f of existing) {
        if (f.endsWith('.ts')) {
          this.seenSegments.add(f);
        }
      }
    } catch {
      // Ignore directory read if not populated yet
    }

    try {
      this.dirWatcher = fs.watch(this.options.bufferDir, (eventType, filename) => {
        if (!filename || filename.includes('.tmp')) {
          return;
        }

        // Active output file written by ffmpeg confirms active stream
        if ((filename.endsWith('.ts') || filename.endsWith('.m3u8')) &&
            (this.state === 'starting' || this.state === 'reconnecting')) {
          this.reconnectAttempts = 0;
          this.disconnectStartTime = null;
          this.transitionState('running');
        }

        if (filename.endsWith('.ts') && !this.seenSegments.has(filename)) {
          this.seenSegments.add(filename);
          this.segmentsCount++;
          this.lastSegmentFile = filename;
          this.lastSegmentTime = new Date().toISOString();

          const fullPath = path.join(this.options.bufferDir, filename);
          this.options.onSegment?.(fullPath, this.segmentsCount);
          this.emit('segment', fullPath, this.segmentsCount);
        }
      });
      this.dirWatcher.unref();
    } catch {
      // Buffer watcher fallback handled gracefully
    }
  }
}
