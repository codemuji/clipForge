import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ClipforgeConfig,
  SamplerRequest,
  DetectorResponse,
  DetectionEvent,
  ClipJob,
  ClipSidecar
} from '../src/contracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('all required JSON schemas exist and are valid JSON', () => {
  const schemaDir = path.join(__dirname, '..', '..', 'schemas');
  const requiredSchemas = [
    'config.schema.json',
    'sampler-request.schema.json',
    'detector-response.schema.json',
    'detection-event.schema.json',
    'clip-job.schema.json',
    'clip-sidecar.schema.json'
  ];

  for (const file of requiredSchemas) {
    const fullPath = path.join(schemaDir, file);
    assert.ok(fs.existsSync(fullPath), `Missing schema file: ${file}`);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const parsed = JSON.parse(content);
    assert.ok(parsed.$id, `Schema ${file} is missing $id`);
    assert.equal(parsed.type, 'object', `Schema ${file} top-level type should be object`);
  }
});

test('contracts TypeScript shapes conform to CONTRACTS.md examples', () => {
  const sampleConfig: ClipforgeConfig = {
    sources: [{ url: 'https://www.twitch.tv/my-channel', label: 'my-channel', enabled: true }],
    buffer: { minutes: 10, segment_seconds: 2 },
    sampling: { interval_seconds: 1.5, audio_window_seconds: 5 },
    scoring: {
      threshold: 0.72,
      cooldown_seconds: 45,
      debounce_windows: 2,
      weights: { audio: 0.35, chat: 0.25, speech_keywords: 0.15, hud_text: 0.15, frame_classifier: 0.10 }
    },
    clip: { pre_seconds: 10, post_seconds: 8, encode: 'copy', vertical: false },
    detector: { url: 'http://127.0.0.1:8731', timeout_ms: 2500 },
    storage: { root: './storage', retention_days: 30 }
  };
  assert.equal(sampleConfig.scoring.threshold, 0.72);

  const sampleSidecar: ClipSidecar = {
    schema: 'clipforge.clip.v1',
    clip_id: 'clip_01H123',
    source: {
      url_host: 'twitch.tv',
      channel: 'my-channel',
      session_id: 'sess_1',
      t_start_stream: 1224.5,
      t_end_stream: 1242.5
    },
    detection: {
      id: 'det_01H456',
      fused_score: 0.78,
      top_signals: ['audio', 'chat']
    },
    media: {
      file: 'clip_01H123.mp4',
      duration_s: 18.0,
      width: 1920,
      height: 1080,
      codec: 'h264',
      vertical: false
    },
    review: {
      status: 'unreviewed',
      title: null,
      tags: [],
      notes: null
    },
    created_at: '2026-11-20T10:15:19Z'
  };
  assert.equal(sampleSidecar.schema, 'clipforge.clip.v1');
});
