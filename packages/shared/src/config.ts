import { z } from 'zod';
import YAML from 'yaml';
import fs from 'node:fs';
import { createLogger, Logger } from './logger.js';

export const SourceConfigSchema = z.object({
  url: z.string().url('Source URL must be a valid URL'),
  label: z.string().min(1, 'Source label must not be empty'),
  enabled: z.boolean().default(true)
});

export const BufferConfigSchema = z.object({
  minutes: z.number().int().min(1, 'Buffer minutes must be at least 1'),
  segment_seconds: z.number().positive('Segment seconds must be positive')
});

export const SamplingConfigSchema = z.object({
  interval_seconds: z.number().positive('Sampling interval must be positive'),
  audio_window_seconds: z.number().positive('Audio window seconds must be positive')
});

export const ScoringWeightsSchema = z.object({
  audio: z.number().min(0).max(1),
  chat: z.number().min(0).max(1),
  speech_keywords: z.number().min(0).max(1),
  hud_text: z.number().min(0).max(1),
  frame_classifier: z.number().min(0).max(1)
}).refine(
  (w) => {
    const sum = w.audio + w.chat + w.speech_keywords + w.hud_text + w.frame_classifier;
    return Math.abs(sum - 1.0) <= 0.05;
  },
  { message: 'Scoring weights must sum to approximately 1.0 (±0.05)' }
);

export const ScoringConfigSchema = z.object({
  threshold: z.number().min(0, 'Threshold must be >= 0.0').max(1, 'Threshold must be <= 1.0'),
  cooldown_seconds: z.number().min(0, 'Cooldown seconds must be non-negative'),
  debounce_windows: z.number().int().min(1, 'Debounce windows must be at least 1'),
  weights: ScoringWeightsSchema
});

export const ClipConfigSchema = z.object({
  pre_seconds: z.number().min(0, 'pre_seconds must be non-negative'),
  post_seconds: z.number().min(0, 'post_seconds must be non-negative'),
  encode: z.enum(['copy', 'h264_nvenc', 'h264_cpu']),
  vertical: z.boolean().default(false)
});

export const DetectorConfigSchema = z.object({
  url: z.string().url('Detector URL must be a valid URL'),
  timeout_ms: z.number().int().min(100, 'Detector timeout must be at least 100ms')
});

export const StorageConfigSchema = z.object({
  root: z.string().min(1, 'Storage root must not be empty'),
  retention_days: z.number().int().min(1, 'Retention days must be at least 1')
});

export const ClipforgeConfigSchema = z.object({
  sources: z.array(SourceConfigSchema),
  buffer: BufferConfigSchema,
  sampling: SamplingConfigSchema,
  scoring: ScoringConfigSchema,
  clip: ClipConfigSchema,
  detector: DetectorConfigSchema,
  storage: StorageConfigSchema
});

export type ClipforgeConfigType = z.infer<typeof ClipforgeConfigSchema>;
export type SourceConfigType = z.infer<typeof SourceConfigSchema>;

export class ConfigValidationError extends Error {
  public fieldErrors: Record<string, string[]>;

  constructor(message: string, fieldErrors: Record<string, string[]>) {
    super(message);
    this.name = 'ConfigValidationError';
    this.fieldErrors = fieldErrors;
  }
}

export class UnlistedSourceError extends Error {
  public sourceUrl: string;

  constructor(sourceUrl: string) {
    super(`Source URL is not permitted by allow-list: ${sourceUrl}`);
    this.name = 'UnlistedSourceError';
    this.sourceUrl = sourceUrl;
  }
}

export function validateConfig(raw: unknown): ClipforgeConfigType {
  const result = ClipforgeConfigSchema.safeParse(raw);
  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors;
    const formatted = Object.entries(fieldErrors)
      .map(([field, errs]) => `${field}: ${errs?.join(', ')}`)
      .join('; ');
    throw new ConfigValidationError(`Invalid configuration: ${formatted}`, fieldErrors);
  }
  return result.data;
}

export function parseConfigYaml(yamlString: string): ClipforgeConfigType {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlString);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`YAML syntax error in configuration: ${msg}`, { syntax: [msg] });
  }
  return validateConfig(parsed);
}

export function loadConfigFile(filePath: string): ClipforgeConfigType {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Configuration file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseConfigYaml(content);
}

export function isSourceAllowed(config: ClipforgeConfigType, streamUrl: string): boolean {
  const normalizedTarget = streamUrl.trim().toLowerCase().replace(/\/+$/, '');
  return config.sources.some((s) => {
    if (!s.enabled) return false;
    const normalizedSource = s.url.trim().toLowerCase().replace(/\/+$/, '');
    return normalizedSource === normalizedTarget;
  });
}

export function assertSourceAllowed(
  config: ClipforgeConfigType,
  streamUrl: string,
  logger?: Logger
): SourceConfigType {
  const normalizedTarget = streamUrl.trim().toLowerCase().replace(/\/+$/, '');
  const matched = config.sources.find((s) => {
    const normalizedSource = s.url.trim().toLowerCase().replace(/\/+$/, '');
    return normalizedSource === normalizedTarget;
  });

  if (!matched || !matched.enabled) {
    const log = logger || createLogger('config');
    log.error(`Refused stream ingestion: URL not found in configured allow-list or is disabled`, 'unlisted-source', {
      stream_url: streamUrl
    });
    throw new UnlistedSourceError(streamUrl);
  }

  return matched;
}
