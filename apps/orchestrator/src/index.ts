import { createLogger, Logger, ClipforgeConfigType } from '@clipforge/shared';
import { loadOrchestratorConfig, assertSourceAllowed, isSourceAllowed } from './config.js';
import { PipelineOrchestrator } from './orchestrator/orchestrator.js';
import type { PipelineOrchestratorOptions } from './orchestrator/types.js';

export const PIPELINE_VERSION = '0.1.0';

export interface OrchestratorInstance {
  version: string;
  logger: Logger;
  status: 'idle' | 'running' | 'stopping' | 'error';
  config?: ClipforgeConfigType;
  loadConfig: (path?: string) => ClipforgeConfigType;
  verifySource: (url: string) => boolean;
  pipeline?: PipelineOrchestrator;
  start: (sourceUrl?: string) => Promise<void>;
  stop: () => Promise<void>;
}

export function createOrchestrator(
  sessionId: string = 'global',
  options?: PipelineOrchestratorOptions
): OrchestratorInstance {
  const logger = options?.logger || createLogger('orchestrator', sessionId);
  let loadedConfig: ClipforgeConfigType | undefined = options?.config;

  let pipelineInstance: PipelineOrchestrator | undefined;

  return {
    version: PIPELINE_VERSION,
    logger,
    get status() {
      if (pipelineInstance) {
        const s = pipelineInstance.getStatus();
        if (s === 'running' || s === 'starting') return 'running';
        if (s === 'stopping' || s === 'draining') return 'stopping';
        if (s === 'error') return 'error';
        return 'idle';
      }
      return 'idle';
    },
    get config() {
      return loadedConfig || pipelineInstance?.config;
    },
    get pipeline() {
      return pipelineInstance;
    },
    loadConfig(customPath?: string) {
      loadedConfig = loadOrchestratorConfig(customPath);
      logger.info('Loaded pipeline configuration', sessionId, {
        sources_count: loadedConfig.sources.length,
        threshold: loadedConfig.scoring.threshold,
        buffer_minutes: loadedConfig.buffer.minutes
      });
      return loadedConfig;
    },
    verifySource(url: string) {
      const cfg = loadedConfig || this.loadConfig();
      assertSourceAllowed(cfg, url, logger);
      return true;
    },
    async start(sourceUrl?: string) {
      const cfg = loadedConfig || this.loadConfig();
      pipelineInstance = new PipelineOrchestrator({
        ...options,
        config: cfg,
        sessionId,
        logger
      });
      await pipelineInstance.start(sourceUrl);
    },
    async stop() {
      if (pipelineInstance) {
        await pipelineInstance.stop();
      }
    }
  };
}

export * from './config.js';
export * from './ingest/index.js';
export * from './buffer/index.js';
export * from './sampler/index.js';
export * from './chat/index.js';
export * from './scorer/index.js';
export * from './cutter/index.js';
export * from './orchestrator/index.js';
