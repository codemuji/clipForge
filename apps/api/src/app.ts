import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { DatabaseService } from './db.js';
import { checkHealth } from './health.js';

export interface AppOptions {
  db?: DatabaseService;
  dbPath?: string;
  detectorUrl?: string;
  storagePath?: string;
  logger?: boolean;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false
  });

  const db = options.db || new DatabaseService({ dbPath: options.dbPath });
  const detectorUrl = options.detectorUrl || 'http://127.0.0.1:8731';
  const storagePath = options.storagePath || './storage';

  // Standardized error handler per CONTRACTS.md §7
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const statusCode = ('statusCode' in error && typeof error.statusCode === 'number') ? error.statusCode : 500;
    const errorCode = ('code' in error && typeof error.code === 'string') ? error.code : 'INTERNAL_ERROR';
    const correlationId = (request.headers['x-correlation-id'] as string) || request.id || 'corr_unknown';
    reply.status(statusCode).send({
      error: {
        code: errorCode,
        message: error.message || 'An unexpected error occurred',
        correlation_id: correlationId
      }
    });
  });

  // Standardized 404 handler per CONTRACTS.md §7
  app.setNotFoundHandler((request, reply) => {
    const correlationId = (request.headers['x-correlation-id'] as string) || request.id || 'corr_unknown';
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        correlation_id: correlationId
      }
    });
  });

  // GET /api/sessions - list sessions
  app.get('/api/sessions', async () => {
    return db.getSessions();
  });

  // GET /api/detections?session_id=&min_score= - list detections
  app.get<{
    Querystring: {
      session_id?: string;
      min_score?: string;
    };
  }>('/api/detections', async (request) => {
    const { session_id, min_score } = request.query;
    const minScoreNum = min_score !== undefined ? parseFloat(min_score) : undefined;
    return db.getDetections({
      sessionId: session_id,
      minScore: minScoreNum
    });
  });

  // POST /api/detections/:id/dismiss - marks detection dismissed
  app.post<{
    Params: {
      id: string;
    };
  }>('/api/detections/:id/dismiss', async (request, reply) => {
    const { id } = request.params;
    const updated = db.dismissDetection(id);
    if (!updated) {
      return reply.status(404).send({
        error: {
          code: 'DETECTION_NOT_FOUND',
          message: `Detection not found: ${id}`,
          correlation_id: id
        }
      });
    }
    return updated;
  });

  // GET /api/clips?status=&source= - list clips with sidecar data
  app.get<{
    Querystring: {
      status?: string;
      source?: string;
    };
  }>('/api/clips', async (request) => {
    const { status, source } = request.query;
    return db.getClips({
      status,
      source
    });
  });

  // GET /api/clips/:id - one clip
  app.get<{
    Params: {
      id: string;
    };
  }>('/api/clips/:id', async (request, reply) => {
    const { id } = request.params;
    const clip = db.getClipById(id);
    if (!clip) {
      return reply.status(404).send({
        error: {
          code: 'CLIP_NOT_FOUND',
          message: `Clip not found: ${id}`,
          correlation_id: id
        }
      });
    }
    return clip;
  });

  // PATCH /api/clips/:id/review - updates only review.* fields per CONTRACTS §6 & §7
  app.patch<{
    Params: {
      id: string;
    };
    Body: {
      status?: string;
      title?: string | null;
      tags?: string[];
      notes?: string | null;
    };
  }>('/api/clips/:id/review', async (request, reply) => {
    const { id } = request.params;
    const body = request.body || {};

    const validStatuses = ['unreviewed', 'approved', 'rejected', 'favorited'];
    if (body.status && !validStatuses.includes(body.status)) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_STATUS',
          message: `Status must be one of: ${validStatuses.join(', ')}`,
          correlation_id: id
        }
      });
    }

    const updated = db.updateClipReview(id, body);
    if (!updated) {
      return reply.status(404).send({
        error: {
          code: 'CLIP_NOT_FOUND',
          message: `Clip not found: ${id}`,
          correlation_id: id
        }
      });
    }

    return updated;
  });

  // GET /api/health - returns {status, detector, buffer_free_gb, gpu}
  app.get('/api/health', async () => {
    return checkHealth({
      detectorUrl,
      storagePath
    });
  });

  return app;
}
