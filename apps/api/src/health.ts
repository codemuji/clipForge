import fs from 'node:fs';
import { execSync } from 'node:child_process';
import type { HealthResponse } from './types.js';

export interface HealthCheckOptions {
  detectorUrl?: string;
  storagePath?: string;
}

export async function checkHealth(options: HealthCheckOptions = {}): Promise<HealthResponse> {
  const detectorUrl = options.detectorUrl || 'http://127.0.0.1:8731';
  const storagePath = options.storagePath || './storage';

  // 1. Check detector reachability
  let detectorReachable = false;
  try {
    const res = await fetch(`${detectorUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(500)
    });
    detectorReachable = res.ok;
  } catch {
    detectorReachable = false;
  }

  // 2. Check buffer disk free space (in GB)
  let bufferFreeGb = 10.0;
  try {
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(storagePath);
      bufferFreeGb = Math.round(((stats.bavail * stats.bsize) / (1024 * 1024 * 1024)) * 10) / 10;
    }
  } catch {
    bufferFreeGb = 10.0;
  }

  // 3. Check GPU status
  let gpuAvailable = false;
  let gpuName: string | undefined;
  try {
    const stdout = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    });
    const name = stdout.trim().split('\n')[0];
    if (name) {
      gpuAvailable = true;
      gpuName = name.trim();
    }
  } catch {
    gpuAvailable = false;
  }

  const status: 'ok' | 'degraded' = bufferFreeGb > 1.0 ? 'ok' : 'degraded';

  return {
    status,
    detector: {
      reachable: detectorReachable,
      url: detectorUrl
    },
    buffer_free_gb: bufferFreeGb,
    gpu: {
      available: gpuAvailable,
      ...(gpuName ? { name: gpuName } : {})
    }
  };
}
