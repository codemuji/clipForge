import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrchestrator, findRepoRoot } from '../src/index.js';
import { UnlistedSourceError } from '@clipforge/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);
const testConfigPath = path.join(repoRoot, 'config', 'clipforge.example.yaml');

test('orchestrator loads config and verifies permitted sources', () => {
  const orchestrator = createOrchestrator('test-config-session');
  const config = orchestrator.loadConfig(testConfigPath);

  assert.equal(config.scoring.threshold, 0.72);
  assert.equal(config.buffer.minutes, 10);
  assert.ok(orchestrator.config);

  // Permitted source in example config
  assert.equal(orchestrator.verifySource('https://www.twitch.tv/example_channel'), true);

  // Unlisted source throws UnlistedSourceError
  assert.throws(
    () => orchestrator.verifySource('https://www.twitch.tv/unauthorized_channel'),
    (err: unknown) => {
      assert.ok(err instanceof UnlistedSourceError);
      return true;
    }
  );
});
