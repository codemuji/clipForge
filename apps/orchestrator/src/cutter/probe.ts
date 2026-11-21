import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbedMediaMetadata } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Probes video container and streams using ffprobe.
 */
export async function probeMedia(
  filePath: string,
  ffprobePath: string = 'ffprobe'
): Promise<ProbedMediaMetadata> {
  let fileSize = 0;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch {
    // Ignore if file stat fails
  }

  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=width,height,codec_name',
      '-show_entries', 'format=duration,size',
      '-of', 'json',
      filePath
    ]);

    const data = JSON.parse(stdout);
    const videoStream = Array.isArray(data.streams)
      ? data.streams.find((s: any) => typeof s.width === 'number' && typeof s.height === 'number')
      : undefined;

    const width = videoStream?.width ?? 1280;
    const height = videoStream?.height ?? 720;
    const codec = videoStream?.codec_name ?? 'h264';
    const duration = data.format?.duration ? parseFloat(data.format.duration) : 0;

    return {
      width,
      height,
      duration_s: Number(duration.toFixed(2)),
      codec,
      file_size_bytes: fileSize
    };
  } catch {
    // Graceful fallback if ffprobe fails
    return {
      width: 1280,
      height: 720,
      duration_s: 0,
      codec: 'h264',
      file_size_bytes: fileSize
    };
  }
}
