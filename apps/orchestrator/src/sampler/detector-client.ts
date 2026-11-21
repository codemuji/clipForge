import fs from 'node:fs';
import type { Logger } from '@clipforge/shared';
import type { SamplerRequest, DetectorResponse } from '@clipforge/shared';
import type { DetectorClientConfig } from './types.js';

export class DetectorClient {
  private url: string;
  private timeoutMs: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private logger?: Logger;

  constructor(config: DetectorClientConfig, logger?: Logger) {
    this.url = config.url.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries ?? 1;
    this.retryDelayMs = config.retryDelayMs ?? 100;
    this.logger = logger;
  }

  /**
   * Calls the detector service at /v1/analyze with the sampled window.
   * If the call fails, retries once. If the retry fails, falls back to null signals.
   * Guarantees cleanup of window files if detector did not delete them.
   */
  async analyze(req: SamplerRequest): Promise<{
    response: DetectorResponse;
    retried: boolean;
    fallback: boolean;
  }> {
    const startTime = Date.now();
    let retried = false;
    let fallback = false;
    let response: DetectorResponse | null = null;

    try {
      response = await this.postAnalyze(req);
    } catch (firstErr) {
      if (this.maxRetries > 0) {
        retried = true;
        this.logger?.warn(
          'Detector request failed, retrying once',
          req.session_id,
          {
            window_id: req.window_id,
            error: firstErr instanceof Error ? firstErr.message : String(firstErr)
          }
        );

        if (this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }

        try {
          response = await this.postAnalyze(req);
        } catch (retryErr) {
          fallback = true;
          this.logger?.warn(
            'Detector unavailable after retry; falling back to null signals',
            req.session_id,
            {
              window_id: req.window_id,
              error: retryErr instanceof Error ? retryErr.message : String(retryErr)
            }
          );
        }
      } else {
        fallback = true;
      }
    }

    if (!response || fallback) {
      fallback = true;
      response = this.createFallbackResponse(req, Date.now() - startTime);
    }

    // Scratch file cleanup safety: if detector was offline, errored, or failed to unlink
    this.cleanupScratchFiles(req.frame_path, req.audio_path);

    return { response, retried, fallback };
  }

  private async postAnalyze(req: SamplerRequest): Promise<DetectorResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.url}/v1/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Detector returned HTTP ${res.status}: ${text}`);
      }

      const data = (await res.json()) as DetectorResponse;
      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private createFallbackResponse(req: SamplerRequest, elapsedMs: number): DetectorResponse {
    return {
      window_id: req.window_id,
      t_stream: req.t_stream,
      signals: {
        audio: { value: null },
        speech_keywords: { value: null },
        hud_text: { value: null },
        frame_classifier: { value: null }
      },
      latency_ms: elapsedMs,
      model_versions: {}
    };
  }

  private cleanupScratchFiles(...filePaths: string[]): void {
    if (process.env.DEBUG_KEEP_WINDOWS === '1') {
      return;
    }

    for (const filePath of filePaths) {
      if (!filePath) continue;
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Safe ignore
      }
    }
  }
}
