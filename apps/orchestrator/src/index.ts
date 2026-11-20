import { createLogger, Logger, ClipforgeConfigType } from '@clipforge/shared';
import { loadOrchestratorConfig, assertSourceAllowed, isSourceAllowed } from './config.js';

export const PIPELINE_VERSION = '0.1.0';

export interface OrchestratorInstance {
  version: string;
  logger: Logger;
  status: 'idle' | 'running' | 'stopping' | 'error';
  config?: ClipforgeConfigType;
  loadConfig: (path?: string) => ClipforgeConfigType;
  verifySource: (url: string) => boolean;
}

export function createOrchestrator(sessionId: string = 'global'): OrchestratorInstance {
  const logger = createLogger('orchestrator', sessionId);
  let loadedConfig: ClipforgeConfigType | undefined;

  return {
    version: PIPELINE_VERSION,
    logger,
    status: 'idle',
    get config() {
      return loadedConfig;
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
      if (!loadedConfig) {
        throw new Error('Cannot verify source: Orchestrator configuration not loaded');
      }
      assertSourceAllowed(loadedConfig, url, logger);
      return true;
    }
  };
}

export * from './config.js';
