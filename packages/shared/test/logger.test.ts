import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger, createLogger } from '../src/logger.js';

test('logger emits structured JSON log entries complying with CONTRACTS §8', () => {
  const logger = createLogger('test-component', 'sess-123');
  const entry = logger.info('Test log message', 'corr-456', { extra_info: 'sample' });

  assert.equal(entry.component, 'test-component');
  assert.equal(entry.session_id, 'sess-123');
  assert.equal(entry.correlation_id, 'corr-456');
  assert.equal(entry.level, 'info');
  assert.equal(entry.msg, 'Test log message');
  assert.equal(entry.extra_info, 'sample');
  assert.ok(entry.ts);
});

test('logger falls back to sessionId when correlationId is omitted', () => {
  const logger = new Logger('pipeline', 'sess-default');
  const entry = logger.warn('Warning event');

  assert.equal(entry.correlation_id, 'sess-default');
  assert.equal(entry.level, 'warn');
});
