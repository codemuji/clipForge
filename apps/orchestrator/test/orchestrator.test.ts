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
import {
  PipelineOrchestrator,
  DetectorClient,
  createOrchestrator
} from '../src/index.js';

const TMP_BASE = path.resolve('storage', 'tmp', 'test_orchestrator_' + Date.now());

function cleanTmp(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

test('createOrchestrator factory returns valid OrchestratorInstance with config and status', () => {
  const orchestrator = createOrchestrator('test-factory-session');
  assert.equal(orchestrator.version, '0.1.0');
  assert.equal(orchestrator.status, 'idle');

  const cfg = orchestrator.loadConfig();
  assert.ok(cfg);
  assert.equal(cfg.scoring.threshold, 0.72);
});

test('PipelineOrchestrator: refuses unlisted source URL with UnlistedSourceError', async () => {
  const orchestrator = new PipelineOrchestrator({
    storageRoot: TMP_BASE,
    config: {
      sources: [{ url: 'https://twitch.tv/allowed_channel', label: 'allowed', enabled: true }],
      buffer: { minutes: 10, segment_seconds: 2 },
      sampling: { interval_seconds: 2, audio_window_seconds: 5 },
      scoring: { threshold: 0.7, cooldown_seconds: 30, debounce_windows: 1, weights: { audio: 1.0, chat: 0, speech_keywords: 0, hud_text: 0, frame_classifier: 0 } },
      clip: { pre_seconds: 2, post_seconds: 2, encode: 'copy', vertical: false },
      detector: { url: 'http://127.0.0.1:9999', timeout_ms: 1000 },
      storage: { root: TMP_BASE, retention_days: 7 }
    }
  });

  await assert.rejects(async () => {
    await orchestrator.start('https://youtube.com/unlisted_streamer');
  }, /Source URL is not permitted by allow-list/);

  assert.equal(orchestrator.getStatus(), 'error');
  cleanTmp(TMP_BASE);
});

test('PipelineOrchestrator: end-to-end fixture run against loud_burst.mp4 produces at least one clip', async () => {
  const testDir = path.join(TMP_BASE, 'e2e_fixture');
  const bufferDir = path.join(testDir, 'buffer');
  const storageRoot = path.join(testDir, 'storage');

  fs.mkdirSync(bufferDir, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  assert.ok(fs.existsSync(fixturePath), 'Fixture loud_burst.mp4 must exist');

  // Slice 4 segments (2s each, total 8s) from loud_burst.mp4
  const seg0 = path.join(bufferDir, 'seg_00000.ts');
  const seg1 = path.join(bufferDir, 'seg_00001.ts');
  const seg2 = path.join(bufferDir, 'seg_00002.ts');
  const seg3 = path.join(bufferDir, 'seg_00003.ts');

  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0', '-t', '2', '-i', fixturePath, '-c', 'copy', seg0]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2', '-t', '2', '-i', fixturePath, '-c', 'copy', seg1]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '4', '-t', '2', '-i', fixturePath, '-c', 'copy', seg2]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '6', '-t', '2', '-i', fixturePath, '-c', 'copy', seg3]);

  // Setup stub detector server that returns loud audio score (0.95) when t_stream is near burst (3.0s - 5.0s)
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/analyze') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body) as SamplerRequest;
        // Loud burst at t = 4.0
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
          latency_ms: 15,
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
    sources: [{ url: 'https://twitch.tv/fixture_stream', label: 'fixture_stream', enabled: true }],
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

  const sessionId = 'sess_e2e_loud_burst';
  const orchestrator = new PipelineOrchestrator({
    sessionId,
    storageRoot,
    config,
    db: repo,
    detectorUrl: `http://127.0.0.1:${port}`
  });

  try {
    // Copy pre-sliced segments to orchestrator bufferDir
    const orchestratorBufferDir = path.join(storageRoot, 'buffer', sessionId);
    fs.mkdirSync(orchestratorBufferDir, { recursive: true });
    fs.copyFileSync(seg0, path.join(orchestratorBufferDir, 'seg_00000.ts'));
    fs.copyFileSync(seg1, path.join(orchestratorBufferDir, 'seg_00001.ts'));
    fs.copyFileSync(seg2, path.join(orchestratorBufferDir, 'seg_00002.ts'));
    fs.copyFileSync(seg3, path.join(orchestratorBufferDir, 'seg_00003.ts'));

    // Start orchestrator on fixture stream
    await orchestrator.start('https://twitch.tv/fixture_stream');
    assert.equal(orchestrator.getStatus(), 'running');

    // Run sequential segment processing across the 8-second fixture
    const result = await orchestrator.processSegmentsSequentially({
      startT: 0.0,
      endT: 8.0,
      stepSeconds: 2.0
    });

    // PLAN.md Acceptance criterion: "full fixture run produces at least one clip for the loud-burst fixture"
    assert.ok(result.clips.length >= 1, `Must produce at least one clip; produced ${result.clips.length}`);
    assert.ok(result.detections.length >= 1, 'Must detect hype events');

    const clip = result.clips[0];
    assert.equal(clip.job.status, 'encoded');
    assert.ok(fs.existsSync(clip.mp4Path), `Output clip MP4 must exist at: ${clip.mp4Path}`);
    assert.ok(fs.existsSync(clip.sidecarPath), `Output clip sidecar must exist at: ${clip.sidecarPath}`);
    assert.ok(fs.statSync(clip.mp4Path).size > 1000, 'Output clip MP4 must have content');

    // Verify sidecar schema
    const sidecar = JSON.parse(fs.readFileSync(clip.sidecarPath, 'utf8'));
    assert.equal(sidecar.schema, 'clipforge.clip.v1');
    assert.equal(sidecar.source.channel, 'fixture_stream');
    assert.ok(sidecar.detection.fused_score >= 0.70);

    // Verify SQLite records
    const dbClips = repo.listClips();
    assert.ok(dbClips.length >= 1);
    assert.equal(dbClips[0].review_status, 'unreviewed');
    assert.equal(dbClips[0].source_domain, 'twitch.tv');

    const dbJobs = repo.listClipJobs({ sessionId });
    assert.ok(dbJobs.length >= 1);
    assert.equal(dbJobs[0].status, 'encoded');
  } finally {
    await orchestrator.stop();
    server.close();
    cleanTmp(TMP_BASE);
  }
});

test('PipelineOrchestrator: graceful shutdown (Ctrl+C) drains pending cutting jobs before exit', async () => {
  const testDir = path.join(TMP_BASE, 'graceful_shutdown');
  const storageRoot = path.join(testDir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });

  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  const sessionId = 'sess_drain_test';
  const bufferDir = path.join(storageRoot, 'buffer', sessionId);
  fs.mkdirSync(bufferDir, { recursive: true });

  const seg0 = path.join(bufferDir, 'seg_00000.ts');
  const seg1 = path.join(bufferDir, 'seg_00001.ts');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0', '-t', '2', '-i', fixturePath, '-c', 'copy', seg0]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2', '-t', '2', '-i', fixturePath, '-c', 'copy', seg1]);

  const { repo } = createDatabase(':memory:');

  const orchestrator = new PipelineOrchestrator({
    sessionId,
    storageRoot,
    config: {
      sources: [{ url: 'https://twitch.tv/streamer', label: 'streamer', enabled: true }],
      buffer: { minutes: 10, segment_seconds: 2 },
      sampling: { interval_seconds: 2.0, audio_window_seconds: 4.0 },
      scoring: { threshold: 0.70, cooldown_seconds: 30, debounce_windows: 1, weights: { audio: 1.0, chat: 0, speech_keywords: 0, hud_text: 0, frame_classifier: 0 } },
      clip: { pre_seconds: 1.0, post_seconds: 1.0, encode: 'copy', vertical: false },
      detector: { url: 'http://127.0.0.1:9999', timeout_ms: 1000 },
      storage: { root: storageRoot, retention_days: 7 }
    },
    db: repo
  });

  await orchestrator.start('https://twitch.tv/streamer');
  assert.equal(orchestrator.getStatus(), 'running');

  // Trigger a clip cut directly through the cutter
  const session = orchestrator.getSession()!;
  const detection: any = {
    id: 'det_drain_01',
    session_id: sessionId,
    source_label: 'streamer',
    source_domain: 'twitch.tv',
    t_stream: 2.0,
    t_wall: new Date().toISOString(),
    fused_score: 0.92,
    signals: { audio: { value: 0.92 } },
    status: 'scored'
  };

  // Insert detection in DB to satisfy foreign key constraint
  repo.createDetection({
    id: detection.id,
    session_id: sessionId,
    source_label: detection.source_label,
    source_domain: detection.source_domain,
    t_stream: detection.t_stream,
    t_wall: detection.t_wall,
    fused_score: detection.fused_score,
    signals: JSON.stringify(detection.signals),
    status: detection.status
  });

  // Trigger cut
  const cutPromise = (orchestrator as any).triggerClipCut(detection);

  // Immediately call stop() while cut job is cutting in the background
  const stopPromise = orchestrator.stop();

  // Wait for stop() to finish
  await stopPromise;

  assert.equal(orchestrator.getStatus(), 'idle');

  // Await the cut result to verify it completed cleanly and was not killed prematurely
  const cutResult = await cutPromise;
  assert.equal(cutResult.job.status, 'encoded');
  assert.ok(fs.existsSync(cutResult.mp4Path));
  assert.ok(fs.existsSync(cutResult.sidecarPath));

  // Verify session status in DB is ended
  const dbSession = repo.getSession(sessionId);
  assert.equal(dbSession?.status, 'ended');
  assert.ok(dbSession?.ended_at);

  cleanTmp(TMP_BASE);
});
