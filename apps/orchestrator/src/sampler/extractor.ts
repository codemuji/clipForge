import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findOverlappingSegments } from '../buffer/segment-index.js';
import type {
  FrameExtractionOptions,
  AudioExtractionOptions,
  MediaExtractorOptions
} from './types.js';

const execFileAsync = promisify(execFile);

export class MediaExtractor {
  private ffmpegPath: string;

  constructor(options: MediaExtractorOptions = {}) {
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
  }

  /**
   * Extracts a single video frame (JPEG) from the buffer segment corresponding to tStream.
   */
  async extractFrame(options: FrameExtractionOptions): Promise<string> {
    const { segments, tStream, outputPath } = options;
    if (!segments || segments.length === 0) {
      throw new Error('No buffer segments available for frame extraction');
    }

    // Find segment covering tStream, or clamp to latest available segment
    let targetSeg = segments.find((s) => s.start_t <= tStream && tStream < s.end_t);
    if (!targetSeg) {
      targetSeg = segments[segments.length - 1];
    }

    // Calculate offset within the segment and clamp to stay within segment bounds
    const segDuration = targetSeg.end_t - targetSeg.start_t;
    const maxOffset = Math.max(0, segDuration - 0.05);
    const offset = Math.min(Math.max(0, tStream - targetSeg.start_t), maxOffset);

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', targetSeg.path,
      '-ss', offset.toFixed(3),
      '-frames:v', '1',
      '-pix_fmt', 'yuv420p',
      '-strict', 'unofficial',
      '-update', '1',
      '-q:v', '2',
      outputPath
    ];

    try {
      await execFileAsync(this.ffmpegPath, args);
      return outputPath;
    } catch (err) {
      throw new Error(`FFmpeg frame extraction failed for t=${tStream}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Extracts an audio window (WAV, mono, 16kHz PCM) across the buffer segments in [startT, endT].
   */
  async extractAudio(options: AudioExtractionOptions): Promise<string> {
    const { segments, startT, endT, sampleRate = 16000, outputPath } = options;
    if (!segments || segments.length === 0) {
      throw new Error('No buffer segments available for audio extraction');
    }

    const duration = Math.max(0.1, endT - startT);
    const overlapping = findOverlappingSegments(segments, startT, endT);
    if (overlapping.length === 0) {
      throw new Error(`No overlapping segments found for audio window [${startT}, ${endT}]`);
    }

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    if (overlapping.length === 1) {
      const seg = overlapping[0];
      const offset = Math.max(0, startT - seg.start_t);
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', seg.path,
        '-ss', offset.toFixed(3),
        '-t', duration.toFixed(3),
        '-ar', String(sampleRate),
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        outputPath
      ];

      try {
        await execFileAsync(this.ffmpegPath, args);
        return outputPath;
      } catch (err) {
        throw new Error(`FFmpeg single-segment audio extraction failed for [${startT}, ${endT}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Multiple segments: generate concat manifest
    const concatListPath = path.join(outDir, `concat_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.txt`);
    const concatContent = overlapping
      .map((s) => `file '${s.path.replace(/\\/g, '/')}'`)
      .join('\n');

    fs.writeFileSync(concatListPath, concatContent, 'utf8');

    try {
      const firstSegStart = overlapping[0].start_t;
      const offset = Math.max(0, startT - firstSegStart);

      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-ss', offset.toFixed(3),
        '-t', duration.toFixed(3),
        '-ar', String(sampleRate),
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        outputPath
      ];

      await execFileAsync(this.ffmpegPath, args);
      return outputPath;
    } catch (err) {
      throw new Error(`FFmpeg multi-segment audio extraction failed for [${startT}, ${endT}]: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try {
        if (fs.existsSync(concatListPath)) {
          fs.unlinkSync(concatListPath);
        }
      } catch {
        // Ignore unlink failure for temporary manifest
      }
    }
  }
}
