import test from 'node:test';
import assert from 'node:assert/strict';
import { PIPELINE_VERSION, createOrchestrator } from '../src/index.js';

test('orchestrator smoke test: initializes with valid version and status', () => {
  const orchestrator = createOrchestrator('test-session');
  assert.equal(orchestrator.version, '0.1.0');
  assert.equal(orchestrator.status, 'idle');
  assert.ok(orchestrator.logger);
});
