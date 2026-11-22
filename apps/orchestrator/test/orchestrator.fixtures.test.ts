import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createDatabase } from '@clipforge/shared';
import type {
  ClipforgeConfigType,
  DetectorResponse,
  SamplerRequest
} from '@clipforge/shared';
import { PipelineOrchestrator } from '../src/index.js';

const TMP_BASE = path.resolve('storage', 'tmp', 'test_fixtures_' + Date.now());

function cleanTmp(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

test('Full fixture run produces at least one clip for loud_burst.mp4 fixture', async () => {
  const testDir = path.join(TMP_BASE, 'loud_burst_fixture_run');
  const bufferDir = path.join(testDir, 'buffer');
  const storageRoot = path.join(testDir, 'storage');

  fs.mkdirSync(bufferDir, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  assert.ok(fs.existsSync(fixturePath), 'Fixture loud_burst.mp4 must exist');

  // Slice 4 segments (2s each) from loud_burst.mp4
  const seg0 = path.join(bufferDir, 'seg_00000.ts');
  const seg1 = path.join(bufferDir, 'seg_00001.ts');
  const seg2 = path.join(bufferDir, 'seg_00002.ts');
  const seg3 = path.join(bufferDir, 'seg_00003.ts');

  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0', '-t', '2', '-i', fixturePath, '-c', 'copy', seg0]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2', '-t', '2', '-i', fixturePath, '-c', 'copy', seg1]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '4', '-t', '2', '-i', fixturePath, '-c', 'copy', seg2]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '6', '-t', '2', '-i', fixturePath, '-c', 'copy', seg3]);

  // Stub detector server simulating audio energy burst
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/analyze') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body) as SamplerRequest;
        const isLoud = parsed.t_stream >= 3.0 && parsed.t_stream <= 5.0;
        const response: DetectorResponse = {
          window_id: parsed.window_id,
          t_stream: parsed.t_stream,
          signals: {
            audio: { value: isLoud ? 0.95 : 0.20, detail: { lufs: isLoud ? -10.0 : -28.0 } },
            speech_keywords: { value: null },
            hud_text: { value: null },
            frame_classifier: { value: isLoud ? 0.85 : 0.10, label: isLoud ? 'hype' : 'idle' }
          },
          latency_ms: 10,
          model_versions: { whisper: 'base', ocr: 'paddle', frame: 'mnv3' }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  const { repo } = createDatabase(':memory:');

  const config: ClipforgeConfigType = {
    sources: [{ url: 'https://twitch.tv/fixture_channel', label: 'fixture_channel', enabled: true }],
    buffer: { minutes: 10, segment_seconds: 2 },
    sampling: { interval_seconds: 2.0, audio_window_seconds: 4.0 },
    scoring: {
      threshold: 0.70,
      cooldown_seconds: 30,
      debounce_windows: 1,
      weights: { audio: 0.60, chat: 0.0, speech_keywords: 0.0, hud_text: 0.0, frame_classifier: 0.40 }
    },
    clip: {
      pre_seconds: 2.0,
      post_seconds: 2.0,
      encode: 'copy',
      vertical: false
    },
    detector: {
      url: `http://127.0.0.1:${port}`,
      timeout_ms: 2000
    },
    storage: {
      root: storageRoot,
      retention_days: 7
    }
  };

  const sessionId = 'sess_fixture_test_loud';
  const orchestrator = new PipelineOrchestrator({
    sessionId,
    storageRoot,
    config,
    db: repo,
    detectorUrl: `http://127.0.0.1:${port}`
  });

  try {
    const orchestratorBufferDir = path.join(storageRoot, 'buffer', sessionId);
    fs.mkdirSync(orchestratorBufferDir, { recursive: true });
    fs.copyFileSync(seg0, path.join(orchestratorBufferDir, 'seg_00000.ts'));
    fs.copyFileSync(seg1, path.join(orchestratorBufferDir, 'seg_00001.ts'));
    fs.copyFileSync(seg2, path.join(orchestratorBufferDir, 'seg_00002.ts'));
    fs.copyFileSync(seg3, path.join(orchestratorBufferDir, 'seg_00003.ts'));

    await orchestrator.start('https://twitch.tv/fixture_channel');

    const result = await orchestrator.processSegmentsSequentially({
      startT: 0.0,
      endT: 8.0,
      stepSeconds: 2.0
    });

    assert.ok(result.clips.length >= 1, 'Full fixture run must produce at least one clip');
    const clip = result.clips[0];

    assert.ok(fs.existsSync(clip.mp4Path), 'Clip MP4 must exist');
    assert.ok(fs.existsSync(clip.sidecarPath), 'Clip sidecar JSON must exist');
    assert.ok(fs.statSync(clip.mp4Path).size > 1000, 'Clip MP4 must be valid non-empty file');

    const sidecar = JSON.parse(fs.readFileSync(clip.sidecarPath, 'utf8'));
    assert.equal(sidecar.schema, 'clipforge.clip.v1');
    assert.equal(sidecar.source.channel, 'fixture_channel');

    const dbClips = repo.listClips();
    assert.ok(dbClips.length >= 1, 'Clip record must be persisted in SQLite clips table');
    assert.equal(dbClips[0].review_status, 'unreviewed');
  } finally {
    await orchestrator.stop();
    server.close();
    cleanTmp(TMP_BASE);
  }
});
