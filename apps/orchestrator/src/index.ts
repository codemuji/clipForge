import { createLogger } from '@clipforge/shared';

export const PIPELINE_VERSION = '0.1.0';

export function createOrchestrator(sessionId: string = 'global') {
  const logger = createLogger('orchestrator', sessionId);
  return {
    version: PIPELINE_VERSION,
    logger,
    status: 'idle' as const
  };
}
