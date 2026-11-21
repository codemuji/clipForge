import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, Logger } from '@clipforge/shared';
import type {
  ClipConfig,
  ClipSidecar,
  DbClipJob,
  DbClip,
  DetectionEventSignals,
  DatabaseRepository
} from '@clipforge/shared';
import { listBufferSegments, findOverlappingSegments } from '../buffer/segment-index.js';
import { BufferSegment } from '../buffer/types.js';
import { resolveClipPaths } from './paths.js';
import { probeMedia } from './probe.js';
import type { ClipCutterOptions, CutRequest, CutResult } from './types.js';

const execFileAsync = promisify(execFile);

export class ClipCutter {
  public readonly storageRoot: string;
  public readonly clipConfig: ClipConfig;
  private readonly db?: DatabaseRepository;
  private readonly logger: Logger;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;

  constructor(options: ClipCutterOptions = {}) {
    this.storageRoot = options.storageRoot || './storage';
    this.clipConfig = options.clipConfig || {
      pre_seconds: 10,
      post_seconds: 8,
      encode: 'copy',
      vertical: false
    };
    this.db = options.db;
    this.logger = options.logger || createLogger('cutter');
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.ffprobePath = options.ffprobePath || 'ffprobe';
  }

  /**
   * Clamps the target cut window [t - pre, t + post] to the available rolling buffer range.
   */
  public clampWindow(
    tTrigger: number,
    segments: BufferSegment[],
    preSeconds: number,
    postSeconds: number
  ): { startT: number; endT: number } {
    if (!segments || segments.length === 0) {
      throw new Error('No buffer segments available to cut clip');
    }

    const minBufferT = segments[0].start_t;
    const maxBufferT = segments[segments.length - 1].end_t;

    const requestedStartT = Math.max(0, tTrigger - preSeconds);
    const requestedEndT = tTrigger + postSeconds;

    const startT = Number(Math.max(minBufferT, requestedStartT).toFixed(3));
    const endT = Number(Math.min(maxBufferT, requestedEndT).toFixed(3));

    if (endT <= startT) {
      throw new Error(`Invalid clamped window: end_t (${endT}) <= start_t (${startT})`);
    }

    return { startT, endT };
  }

  /**
   * Extracts top scoring signal names from detection signals for sidecar metadata.
   */
  public extractTopSignals(signals: DetectionEventSignals): string[] {
    const scored: Array<{ name: string; score: number }> = [];

    if (typeof signals.audio?.value === 'number') {
      scored.push({ name: 'audio', score: signals.audio.value });
    }
    if (typeof signals.chat?.value === 'number') {
      scored.push({ name: 'chat', score: signals.chat.value });
    }
    if (typeof signals.speech_keywords?.value === 'number') {
      scored.push({ name: 'speech_keywords', score: signals.speech_keywords.value });
    }
    if (typeof signals.hud_text?.value === 'number') {
      scored.push({ name: 'hud_text', score: signals.hud_text.value });
    }
    if (typeof signals.frame_classifier?.value === 'number') {
      scored.push({ name: 'frame_classifier', score: signals.frame_classifier.value });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.name);
  }

  /**
   * Executes clip cut from rolling buffer, probes metadata, writes sidecar JSON, and persists to SQLite.
   */
  public async cut(req: CutRequest): Promise<CutResult> {
    const clipId = req.clipId || crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const segments = listBufferSegments(req.bufferDir, 2);
    if (segments.length === 0) {
      throw new Error(`Buffer directory contains no valid segments: ${req.bufferDir}`);
    }

    // 1. Window clamping: [t - pre, t + post] bounded by buffer
    const pre = req.requestedStartT !== undefined
      ? Math.max(0, req.detection.t_stream - req.requestedStartT)
      : this.clipConfig.pre_seconds;
    const post = req.requestedEndT !== undefined
      ? Math.max(0, req.requestedEndT - req.detection.t_stream)
      : this.clipConfig.post_seconds;

    const { startT, endT } = (req.requestedStartT !== undefined && req.requestedEndT !== undefined)
      ? {
          startT: Number(Math.max(segments[0].start_t, req.requestedStartT).toFixed(3)),
          endT: Number(Math.min(segments[segments.length - 1].end_t, req.requestedEndT).toFixed(3))
        }
      : this.clampWindow(req.detection.t_stream, segments, pre, post);

    if (endT <= startT) {
      throw new Error(`Invalid clamped window: end_t (${endT}) <= start_t (${startT})`);
    }

    const durationSeconds = Number((endT - startT).toFixed(2));

    // 2. Resolve AGENTS.md §4 path layout
    const sourceDomain = req.session.source_domain || req.session.source_url;
    const channelSlug = req.session.channel_slug || req.detection.source_label;
    const paths = resolveClipPaths(
      this.storageRoot,
      sourceDomain,
      channelSlug,
      req.detection.t_wall || nowIso,
      clipId
    );

    if (!fs.existsSync(paths.clipDir)) {
      fs.mkdirSync(paths.clipDir, { recursive: true });
    }

    // 3. Register clip job in SQLite: status 'queued'
    const job: DbClipJob = {
      id: jobId,
      detection_id: req.detection.id,
      session_id: req.session.id,
      start_t: startT,
      end_t: endT,
      status: 'queued',
      output_path: paths.relativeMp4Path,
      error: null,
      created_at: nowIso,
      updated_at: nowIso
    };

    if (this.db) {
      this.db.createClipJob(job);
    }

    // 4. Update status: 'cutting'
    job.status = 'cutting';
    job.updated_at = new Date().toISOString();
    if (this.db) {
      this.db.updateClipJobStatus(job.id, 'cutting');
    }

    // 5. Execute FFmpeg cut with write-then-rename
    const overlapping = findOverlappingSegments(segments, startT, endT);
    if (overlapping.length === 0) {
      const err = new Error(`No overlapping segments for window [${startT}, ${endT}]`);
      this.failJob(job, err.message);
      throw err;
    }

    const vertical = req.vertical ?? this.clipConfig.vertical ?? false;
    const requestedEncode = req.encode || this.clipConfig.encode || 'copy';

    let usedNvenc = false;
    let fallbackToCpu = false;

    // Temporary path in the target directory for write-then-rename
    const tmpMp4Path = path.join(
      paths.clipDir,
      `.tmp_${clipId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.mp4`
    );

    try {
      const cutExecution = await this.executeFfmpegCut({
        overlapping,
        startT,
        durationSeconds,
        outputPath: tmpMp4Path,
        encode: requestedEncode,
        vertical
      });

      usedNvenc = cutExecution.usedNvenc;
      fallbackToCpu = cutExecution.fallbackToCpu;

      // Atomic rename of output MP4
      if (fs.existsSync(paths.mp4Path)) {
        try { fs.unlinkSync(paths.mp4Path); } catch {}
      }
      fs.renameSync(tmpMp4Path, paths.mp4Path);
    } catch (err) {
      if (fs.existsSync(tmpMp4Path)) {
        try { fs.unlinkSync(tmpMp4Path); } catch {}
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      this.failJob(job, errMsg);
      throw err;
    }

    // 6. Probe media metadata from the generated MP4
    const probed = await probeMedia(paths.mp4Path, this.ffprobePath);

    // 7. Write sidecar JSON metadata matching clipforge.clip.v1 schema using write-then-rename
    const topSignals = this.extractTopSignals(req.detection.signals);

    // CONTRACTS.md §6: review.* fields are preserved if already set
    let review: ClipSidecar['review'] = {
      status: 'unreviewed',
      title: null,
      tags: [],
      notes: null
    };

    if (fs.existsSync(paths.sidecarPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(paths.sidecarPath, 'utf8'));
        if (existing && existing.review) {
          review = existing.review;
        }
      } catch {
        // Keep default unreviewed
      }
    }

    const sidecar: ClipSidecar = {
      schema: 'clipforge.clip.v1',
      clip_id: clipId,
      source: {
        url_host: paths.domain,
        channel: paths.channel,
        session_id: req.session.id,
        t_start_stream: startT,
        t_end_stream: endT
      },
      detection: {
        id: req.detection.id,
        fused_score: Math.max(0, Math.min(1, req.detection.fused_score ?? 0)),
        top_signals: topSignals
      },
      media: {
        file: path.basename(paths.mp4Path),
        duration_s: probed.duration_s || durationSeconds,
        width: Math.round(probed.width),
        height: Math.round(probed.height),
        codec: probed.codec,
        vertical
      },
      review,
      created_at: new Date().toISOString()
    };

    const tmpSidecarPath = path.join(
      paths.clipDir,
      `.tmp_${clipId}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.json`
    );
    fs.writeFileSync(tmpSidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
    if (fs.existsSync(paths.sidecarPath)) {
      try { fs.unlinkSync(paths.sidecarPath); } catch {}
    }
    fs.renameSync(tmpSidecarPath, paths.sidecarPath);

    // 8. Update job: 'encoded' and persist clip record
    job.status = 'encoded';
    job.updated_at = new Date().toISOString();
    let dbClip: DbClip | undefined;

    if (this.db) {
      this.db.updateClipJobStatus(job.id, 'encoded');
      dbClip = this.db.createClip({
        id: clipId,
        job_id: job.id,
        session_id: req.session.id,
        detection_id: req.detection.id,
        source_domain: paths.domain,
        channel_slug: paths.channel,
        t_start_stream: startT,
        t_end_stream: endT,
        duration_s: sidecar.media.duration_s,
        width: sidecar.media.width,
        height: sidecar.media.height,
        codec: sidecar.media.codec,
        vertical: vertical ? 1 : 0,
        output_path: paths.relativeMp4Path,
        sidecar_path: paths.relativeSidecarPath,
        fused_score: sidecar.detection.fused_score,
        top_signals: JSON.stringify(topSignals),
        review_status: review.status,
        title: review.title,
        tags: JSON.stringify(review.tags),
        notes: review.notes,
        created_at: nowIso,
        updated_at: nowIso
      });
    }

    this.logger.info('Clip cut successfully', req.session.id, {
      clip_id: clipId,
      job_id: job.id,
      duration_s: sidecar.media.duration_s,
      output_path: paths.relativeMp4Path,
      used_nvenc: usedNvenc,
      fallback_to_cpu: fallbackToCpu
    });

    return {
      job,
      clip: dbClip,
      sidecar,
      sidecarPath: paths.sidecarPath,
      mp4Path: paths.mp4Path,
      durationSeconds,
      usedNvenc,
      fallbackToCpu
    };
  }

  private async executeFfmpegCut(options: {
    overlapping: BufferSegment[];
    startT: number;
    durationSeconds: number;
    outputPath: string;
    encode: 'copy' | 'h264_nvenc' | 'h264_cpu';
    vertical: boolean;
  }): Promise<{ usedNvenc: boolean; fallbackToCpu: boolean }> {
    const { overlapping, startT, durationSeconds, outputPath, encode, vertical } = options;

    let concatManifestPath: string | undefined;
    let inputArgs: string[];
    let offsetInInput: number;

    if (overlapping.length === 1) {
      inputArgs = ['-i', overlapping[0].path];
      offsetInInput = Math.max(0, startT - overlapping[0].start_t);
    } else {
      const outDir = path.dirname(outputPath);
      concatManifestPath = path.join(outDir, `concat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.txt`);
      const concatContent = overlapping
        .map((s) => `file '${s.path.replace(/\\/g, '/')}'`)
        .join('\n');
      fs.writeFileSync(concatManifestPath, concatContent, 'utf8');

      inputArgs = ['-f', 'concat', '-safe', '0', '-i', concatManifestPath];
      offsetInInput = Math.max(0, startT - overlapping[0].start_t);
    }

    try {
      // Determine video filters
      const vfArgs: string[] = [];
      if (vertical) {
        vfArgs.push('-vf', 'crop=ih*9/16:ih:(iw-ih*9/16)/2:0');
      }

      // 1. Attempt NVENC if requested
      if (encode === 'h264_nvenc') {
        try {
          const nvencArgs = [
            '-hide_banner', '-loglevel', 'error', '-y',
            ...inputArgs,
            '-ss', offsetInInput.toFixed(3),
            '-t', durationSeconds.toFixed(3),
            ...vfArgs,
            '-c:v', 'h264_nvenc',
            '-preset', 'p4',
            '-c:a', 'aac',
            '-b:a', '128k',
            outputPath
          ];
          await execFileAsync(this.ffmpegPath, nvencArgs);
          return { usedNvenc: true, fallbackToCpu: false };
        } catch (nvencErr) {
          this.logger.warn('NVENC encoding unavailable or failed; falling back to CPU libx264', undefined, {
            error: nvencErr instanceof Error ? nvencErr.message : String(nvencErr)
          });
          // Fall through to CPU encoding below
        }
      }

      // 2. Stream copy if requested and no filters needed
      if (encode === 'copy' && !vertical) {
        try {
          const copyArgs = [
            '-hide_banner', '-loglevel', 'error', '-y',
            ...inputArgs,
            '-ss', offsetInInput.toFixed(3),
            '-t', durationSeconds.toFixed(3),
            '-c', 'copy',
            outputPath
          ];
          await execFileAsync(this.ffmpegPath, copyArgs);
          return { usedNvenc: false, fallbackToCpu: false };
        } catch (copyErr) {
          this.logger.warn('Stream copy failed; falling back to CPU re-encoding', undefined, {
            error: copyErr instanceof Error ? copyErr.message : String(copyErr)
          });
          // Fall through to CPU encoding
        }
      }

      // 3. CPU libx264 encoding (standard or fallback)
      const cpuArgs = [
        '-hide_banner', '-loglevel', 'error', '-y',
        ...inputArgs,
        '-ss', offsetInInput.toFixed(3),
        '-t', durationSeconds.toFixed(3),
        ...vfArgs,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-c:a', 'aac',
        '-b:a', '128k',
        outputPath
      ];
      await execFileAsync(this.ffmpegPath, cpuArgs);
      return {
        usedNvenc: false,
        fallbackToCpu: encode === 'h264_nvenc'
      };
    } finally {
      if (concatManifestPath && fs.existsSync(concatManifestPath)) {
        try {
          fs.unlinkSync(concatManifestPath);
        } catch {
          // Ignore
        }
      }
    }
  }

  private failJob(job: DbClipJob, errorMsg: string): void {
    job.status = 'failed';
    job.error = errorMsg;
    job.updated_at = new Date().toISOString();
    if (this.db) {
      try {
        this.db.updateClipJobStatus(job.id, 'failed', errorMsg);
      } catch {
        // Ignore DB error during failure
      }
    }
  }
}
