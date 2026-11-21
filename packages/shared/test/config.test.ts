import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfigYaml,
  validateConfig,
  isSourceAllowed,
  assertSourceAllowed,
  ConfigValidationError,
  UnlistedSourceError,
  createLogger
} from '../src/index.js';

const validYaml = `
sources:
  - url: "https://www.twitch.tv/permitted_gamer"
    label: "permitted-gamer"
    enabled: true
  - url: "https://youtube.com/live/stream123"
    label: "youtube-channel"
    enabled: false

buffer:
  minutes: 10
  segment_seconds: 2

sampling:
  interval_seconds: 1.5
  audio_window_seconds: 5

scoring:
  threshold: 0.72
  cooldown_seconds: 45
  debounce_windows: 2
  weights:
    audio: 0.35
    chat: 0.25
    speech_keywords: 0.15
    hud_text: 0.15
    frame_classifier: 0.10

clip:
  pre_seconds: 10
  post_seconds: 8
  encode: "copy"
  vertical: false

detector:
  url: "http://127.0.0.1:8731"
  timeout_ms: 2500

storage:
  root: "./storage"
  retention_days: 30
`;

test('valid config parses and validates without errors', () => {
  const config = parseConfigYaml(validYaml);
  assert.equal(config.scoring.threshold, 0.72);
  assert.equal(config.buffer.minutes, 10);
  assert.equal(config.sources.length, 2);
  assert.equal(config.clip.encode, 'copy');
});

test('missing required field produces a field-level error message', () => {
  const missingFieldYaml = validYaml.replace('threshold: 0.72', '');
  assert.throws(
    () => parseConfigYaml(missingFieldYaml),
    (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError);
      assert.ok(err.message.includes('scoring') || err.message.includes('threshold'));
      assert.ok(err.fieldErrors['scoring.threshold'] || err.fieldErrors['scoring'] || err.message.length > 0);
      return true;
    }
  );
});

test('out-of-range threshold (< 0 or > 1) fails with field-level validation error', () => {
  const invalidThresholdYaml = validYaml.replace('threshold: 0.72', 'threshold: 1.55');
  assert.throws(
    () => parseConfigYaml(invalidThresholdYaml),
    (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError);
      assert.ok(err.message.includes('Threshold must be <= 1.0') || err.message.includes('threshold'));
      return true;
    }
  );

  const negativeThresholdYaml = validYaml.replace('threshold: 0.72', 'threshold: -0.1');
  assert.throws(
    () => parseConfigYaml(negativeThresholdYaml),
    (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError);
      assert.ok(err.message.includes('Threshold must be >= 0.0') || err.message.includes('threshold'));
      return true;
    }
  );
});

test('unlisted source is refused with UnlistedSourceError and logged error', () => {
  const config = parseConfigYaml(validYaml);
  const logger = createLogger('test-allowlist');

  // Allowed source
  assert.equal(isSourceAllowed(config, 'https://www.twitch.tv/permitted_gamer'), true);
  assert.equal(isSourceAllowed(config, 'https://www.twitch.tv/permitted_gamer/'), true); // handles trailing slash
  const source = assertSourceAllowed(config, 'https://www.twitch.tv/permitted_gamer', logger);
  assert.equal(source.label, 'permitted-gamer');

  // Disabled source refused
  assert.equal(isSourceAllowed(config, 'https://youtube.com/live/stream123'), false);
  assert.throws(
    () => assertSourceAllowed(config, 'https://youtube.com/live/stream123', logger),
    (err: unknown) => {
      assert.ok(err instanceof UnlistedSourceError);
      return true;
    }
  );

  // Unlisted source refused
  assert.equal(isSourceAllowed(config, 'https://kick.com/unknown_streamer'), false);
  assert.throws(
    () => assertSourceAllowed(config, 'https://kick.com/unknown_streamer', logger),
    (err: unknown) => {
      assert.ok(err instanceof UnlistedSourceError);
      return true;
    }
  );
});

test('invalid YAML syntax fails with syntax error', () => {
  const badSyntax = `
sources:
  - url: [invalid yaml
`;
  assert.throws(
    () => parseConfigYaml(badSyntax),
    (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError);
      assert.ok(err.message.includes('YAML syntax error'));
      return true;
    }
  );
});
