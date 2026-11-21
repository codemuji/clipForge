import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  MediaExtractor,
  DetectorClient,
  StreamSampler,
  SamplerConfig,
  BufferSegment
} from '../src/index.js';
import type { SamplerRequest, DetectorResponse } from '@clipforge/shared';

const TMP_BASE = path.resolve('storage', 'tmp', 'test_sampler_' + Date.now());

function cleanTmp(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

test('StreamSampler: enforces strict t_stream monotonicity', async () => {
  const scratchDir = path.join(TMP_BASE, 'mono_scratch');
  const bufferDir = path.join(TMP_BASE, 'mono_buffer');
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.mkdirSync(bufferDir, { recursive: true });

  const client = new DetectorClient({
    url: 'http://127.0.0.1:9998',
    timeoutMs: 500,
    maxRetries: 0
  });

  const sampler = new StreamSampler({
    sessionId: 'test-mono-session',
    bufferDir,
    config: {
      intervalSeconds: 2.0,
      audioWindowSeconds: 5.0,
      audioSampleRate: 16000,
      scratchDir
    },
    detectorClient: client
  });

  // Initially lastSampledTStream is -1, can sample any t >= 0
  assert.equal(sampler.getLastSampledTStream(), -1);
  assert.equal(sampler.canSampleAt(0.0), true);
  assert.equal(sampler.canSampleAt(2.0), true);

  // Buffer is empty: sampleAt returns null
  const emptyRes = await sampler.sampleAt(2.0);
  assert.equal(emptyRes, null);

  // Now create dummy segment files to test monotonicity rejection
  // seg_00000.ts covers [0, 2], seg_00001.ts covers [2, 4], seg_00002.ts covers [4, 6]
  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '0', '-t', '2', '-i', fixturePath,
    '-c', 'copy', path.join(bufferDir, 'seg_00000.ts')
  ]);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '2', '-t', '2', '-i', fixturePath,
    '-c', 'copy', path.join(bufferDir, 'seg_00001.ts')
  ]);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '4', '-t', '2', '-i', fixturePath,
    '-c', 'copy', path.join(bufferDir, 'seg_00002.ts')
  ]);

  // First sample at t = 2.0 (offline detector will fall back to null signals)
  const res1 = await sampler.sampleAt(2.0);
  assert.ok(res1);
  assert.equal(res1.request.t_stream, 2.0);
  assert.equal(sampler.getLastSampledTStream(), 2.0);

  // canSampleAt checks
  assert.equal(sampler.canSampleAt(2.0), false); // Cannot sample same t
  assert.equal(sampler.canSampleAt(1.5), false); // Cannot sample backwards
  assert.equal(sampler.canSampleAt(4.0), true);  // Can sample forward

  // Calling sampleAt with t <= 2.0 must throw error enforcing monotonicity
  await assert.rejects(
    async () => {
      await sampler.sampleAt(2.0);
    },
    /Non-monotonic stream sampling rejected/
  );

  await assert.rejects(
    async () => {
      await sampler.sampleAt(1.0);
    },
    /Non-monotonic stream sampling rejected/
  );

  // Forward sample at t = 4.0 succeeds
  const res2 = await sampler.sampleAt(4.0);
  assert.ok(res2);
  assert.equal(res2.request.t_stream, 4.0);
  assert.equal(sampler.getLastSampledTStream(), 4.0);

  cleanTmp(TMP_BASE);
});

test('DetectorClient: handles happy path, retry, and null signal fallback', async () => {
  let requestCount = 0;
  let simulatedFailureCount = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/analyze') {
      requestCount++;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (simulatedFailureCount > 0) {
          simulatedFailureCount--;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error' }));
          return;
        }

        const parsed = JSON.parse(body) as SamplerRequest;
        const response: DetectorResponse = {
          window_id: parsed.window_id,
          t_stream: parsed.t_stream,
          signals: {
            audio: { value: 0.85, detail: { lufs: -14.2, lufs_delta: 6.5 } },
            speech_keywords: { value: 0.9, detail: { matched: ['clutch', 'letsgo'] } },
            hud_text: { value: 0.0, detail: { matched: [] } },
            frame_classifier: { value: 0.72, label: 'action' }
          },
          latency_ms: 120,
          model_versions: { whisper: 'base.en-q5', ocr: 'paddle-small', frame: 'mnv3s-v0.2' }
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
  const detectorUrl = `http://127.0.0.1:${port}`;

  const scratchDir = path.join(TMP_BASE, 'det_scratch');
  fs.mkdirSync(scratchDir, { recursive: true });

  const dummyFrame = path.join(scratchDir, 'dummy_frame.jpg');
  const dummyAudio = path.join(scratchDir, 'dummy_audio.wav');

  try {
    const client = new DetectorClient({
      url: detectorUrl,
      timeoutMs: 1000,
      maxRetries: 1,
      retryDelayMs: 50
    });

    // 1. Happy path: initial attempt succeeds
    fs.writeFileSync(dummyFrame, 'fake-jpeg');
    fs.writeFileSync(dummyAudio, 'fake-wav');
    requestCount = 0;
    simulatedFailureCount = 0;

    const req1: SamplerRequest = {
      session_id: 'test-sess',
      window_id: 'win-001',
      t_stream: 10.0,
      t_wall: new Date().toISOString(),
      frame_path: dummyFrame,
      audio_path: dummyAudio,
      audio_sample_rate: 16000,
      chat: { messages_in_window: 12, unique_chatters: 8 }
    };

    const res1 = await client.analyze(req1);
    assert.equal(requestCount, 1);
    assert.equal(res1.retried, false);
    assert.equal(res1.fallback, false);
    assert.equal(res1.response.window_id, 'win-001');
    assert.equal(res1.response.signals.audio.value, 0.85);
    assert.equal(res1.response.signals.speech_keywords.value, 0.9);

    // 2. Transient failure: first attempt returns 500, retry succeeds
    fs.writeFileSync(dummyFrame, 'fake-jpeg');
    fs.writeFileSync(dummyAudio, 'fake-wav');
    requestCount = 0;
    simulatedFailureCount = 1;

    const req2: SamplerRequest = {
      session_id: 'test-sess',
      window_id: 'win-002',
      t_stream: 12.0,
      t_wall: new Date().toISOString(),
      frame_path: dummyFrame,
      audio_path: dummyAudio,
      audio_sample_rate: 16000,
      chat: { messages_in_window: 5, unique_chatters: 4 }
    };

    const res2 = await client.analyze(req2);
    assert.equal(requestCount, 2); // 1 initial + 1 retry
    assert.equal(res2.retried, true);
    assert.equal(res2.fallback, false);
    assert.equal(res2.response.window_id, 'win-002');
    assert.equal(res2.response.signals.audio.value, 0.85);

    // 3. Persistent failure: both attempts return 500, falls back to null signals
    fs.writeFileSync(dummyFrame, 'fake-jpeg');
    fs.writeFileSync(dummyAudio, 'fake-wav');
    requestCount = 0;
    simulatedFailureCount = 5; // Will fail both attempts

    const req3: SamplerRequest = {
      session_id: 'test-sess',
      window_id: 'win-003',
      t_stream: 14.0,
      t_wall: new Date().toISOString(),
      frame_path: dummyFrame,
      audio_path: dummyAudio,
      audio_sample_rate: 16000,
      chat: { messages_in_window: 0, unique_chatters: 0 }
    };

    const res3 = await client.analyze(req3);
    assert.equal(requestCount, 2); // Attempted exactly 1 retry
    assert.equal(res3.retried, true);
    assert.equal(res3.fallback, true);
    assert.equal(res3.response.window_id, 'win-003');
    assert.equal(res3.response.signals.audio.value, null);
    assert.equal(res3.response.signals.speech_keywords.value, null);
    assert.equal(res3.response.signals.hud_text.value, null);
    assert.equal(res3.response.signals.frame_classifier.value, null);

    // Scratch files must be unlinked after fallback
    assert.equal(fs.existsSync(dummyFrame), false, 'Temporary frame must be cleaned up on fallback');
    assert.equal(fs.existsSync(dummyAudio), false, 'Temporary audio must be cleaned up on fallback');

    // 4. Offline / Connection Refused: port where nothing listens
    const offlineClient = new DetectorClient({
      url: 'http://127.0.0.1:54321', // Unopened port
      timeoutMs: 300,
      maxRetries: 1,
      retryDelayMs: 20
    });

    fs.writeFileSync(dummyFrame, 'fake-jpeg');
    fs.writeFileSync(dummyAudio, 'fake-wav');

    const resOffline = await offlineClient.analyze({
      session_id: 'test-sess',
      window_id: 'win-offline',
      t_stream: 16.0,
      t_wall: new Date().toISOString(),
      frame_path: dummyFrame,
      audio_path: dummyAudio,
      audio_sample_rate: 16000,
      chat: { messages_in_window: 0, unique_chatters: 0 }
    });

    assert.equal(resOffline.fallback, true);
    assert.equal(resOffline.response.signals.audio.value, null);
    assert.equal(fs.existsSync(dummyFrame), false);
    assert.equal(fs.existsSync(dummyAudio), false);
  } finally {
    server.close();
    cleanTmp(TMP_BASE);
  }
});

test('MediaExtractor: extracts valid JPEG frame and 16kHz WAV audio under real-time budget', async () => {
  const extractor = new MediaExtractor();
  const extractDir = path.join(TMP_BASE, 'extract_test');
  fs.mkdirSync(extractDir, { recursive: true });

  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  assert.ok(fs.existsSync(fixturePath), 'Fixture loud_burst.mp4 must exist');

  // Segment 6 seconds into three 2-second segments:
  // seg_00000.ts [0, 2], seg_00001.ts [2, 4], seg_00002.ts [4, 6]
  const seg0Path = path.join(extractDir, 'seg_00000.ts');
  const seg1Path = path.join(extractDir, 'seg_00001.ts');
  const seg2Path = path.join(extractDir, 'seg_00002.ts');

  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '0', '-t', '2', '-i', fixturePath,
    '-c', 'copy', seg0Path
  ]);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '2', '-t', '2', '-i', fixturePath,
    '-c', 'copy', seg1Path
  ]);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', '4', '-t', '2', '-i', fixturePath,
    '-c', 'copy', seg2Path
  ]);

  const segments: BufferSegment[] = [
    { file: 'seg_00000.ts', path: seg0Path, index: 0, start_t: 0, end_t: 2, sizeBytes: fs.statSync(seg0Path).size, mtimeMs: Date.now() },
    { file: 'seg_00001.ts', path: seg1Path, index: 1, start_t: 2, end_t: 4, sizeBytes: fs.statSync(seg1Path).size, mtimeMs: Date.now() },
    { file: 'seg_00002.ts', path: seg2Path, index: 2, start_t: 4, end_t: 6, sizeBytes: fs.statSync(seg2Path).size, mtimeMs: Date.now() }
  ];

  // 1. Frame extraction at t = 3.5s (inside seg_00001)
  const frameOut = path.join(extractDir, 'test_frame.jpg');
  const tFrameStart = Date.now();
  await extractor.extractFrame({
    segments,
    tStream: 3.5,
    outputPath: frameOut
  });
  const frameDuration = Date.now() - tFrameStart;

  assert.ok(fs.existsSync(frameOut), 'Frame file must be created');
  const frameBuf = fs.readFileSync(frameOut);
  assert.ok(frameBuf.length > 500, 'Frame must have non-trivial size');
  // Check JPEG magic bytes: FF D8 FF
  assert.equal(frameBuf[0], 0xff);
  assert.equal(frameBuf[1], 0xd8);
  assert.equal(frameBuf[2], 0xff);
  assert.ok(frameDuration < 500, `Frame extraction took ${frameDuration}ms, must be < 500ms`);

  // 2. Audio extraction spanning 2 segments: [1.0, 5.0] (4 seconds across seg 0, 1, 2)
  const audioOut = path.join(extractDir, 'test_audio.wav');
  const tAudioStart = Date.now();
  await extractor.extractAudio({
    segments,
    startT: 1.0,
    endT: 5.0,
    sampleRate: 16000,
    outputPath: audioOut
  });
  const audioDuration = Date.now() - tAudioStart;

  assert.ok(fs.existsSync(audioOut), 'Audio file must be created');
  const audioBuf = fs.readFileSync(audioOut);
  assert.ok(audioBuf.length > 1000, 'Audio file must have non-trivial size');
  // RIFF header
  assert.equal(audioBuf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(audioBuf.subarray(8, 12).toString('ascii'), 'WAVE');
  // Sample rate is at offset 24 (little-endian 32-bit int)
  const sampleRate = audioBuf.readUInt32LE(24);
  assert.equal(sampleRate, 16000, 'Audio sample rate must be 16000 Hz');
  // Channels at offset 22 (little-endian 16-bit int)
  const channels = audioBuf.readUInt16LE(22);
  assert.equal(channels, 1, 'Audio must be mono (1 channel)');

  assert.ok(audioDuration < 500, `Audio extraction took ${audioDuration}ms, must be < 500ms`);

  cleanTmp(TMP_BASE);
});

test('StreamSampler: end-to-end sampling against stub detector with chat counts', async () => {
  const scratchDir = path.join(TMP_BASE, 'e2e_scratch');
  const bufferDir = path.join(TMP_BASE, 'e2e_buffer');
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.mkdirSync(bufferDir, { recursive: true });

  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  for (let i = 0; i < 4; i++) {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(i * 2), '-t', '2', '-i', fixturePath,
      '-c', 'copy', path.join(bufferDir, `seg_${String(i).padStart(5, '0')}.ts`)
    ]);
  }

  // Stub detector server
  const analyzedRequests: SamplerRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body) as SamplerRequest;
      analyzedRequests.push(parsed);

      const resp: DetectorResponse = {
        window_id: parsed.window_id,
        t_stream: parsed.t_stream,
        signals: {
          audio: { value: 0.77, detail: { lufs: -15.0, lufs_delta: 4.2 } },
          speech_keywords: { value: 0.0, detail: { matched: [] } },
          hud_text: { value: 0.0, detail: { matched: [] } },
          frame_classifier: { value: 0.35, label: 'gameplay' }
        },
        latency_ms: 45,
        model_versions: { whisper: 'base.en-q5', ocr: 'paddle-small', frame: 'mnv3s-v0.2' }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resp));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  try {
    const client = new DetectorClient({
      url: `http://127.0.0.1:${port}`,
      timeoutMs: 1000,
      maxRetries: 1
    });

    // Mock chat provider
    const mockChatProvider = {
      getCounts: (startT: number, endT: number) => ({
        messages_in_window: Math.round(endT * 5),
        unique_chatters: Math.round(endT * 3)
      })
    };

    const sampler = new StreamSampler({
      sessionId: 'sess-e2e-1',
      bufferDir,
      config: {
        intervalSeconds: 2.0,
        audioWindowSeconds: 5.0,
        audioSampleRate: 16000,
        scratchDir
      },
      detectorClient: client,
      chatProvider: mockChatProvider
    });

    // Step 1: samples at t = 2.0
    const step1 = await sampler.step();
    assert.ok(step1);
    assert.equal(step1.request.t_stream, 2.0);
    assert.equal(step1.request.session_id, 'sess-e2e-1');
    assert.equal(step1.request.chat.messages_in_window, 10);
    assert.equal(step1.request.chat.unique_chatters, 6);
    assert.equal(step1.response.signals.audio.value, 0.77);
    assert.equal(step1.retried, false);
    assert.equal(step1.fallback, false);

    // Step 2: samples at t = 4.0
    const step2 = await sampler.step();
    assert.ok(step2);
    assert.equal(step2.request.t_stream, 4.0);
    assert.equal(step2.request.chat.messages_in_window, 20);
    assert.equal(step2.response.signals.audio.value, 0.77);

    // Step 3: samples at t = 6.0
    const step3 = await sampler.step();
    assert.ok(step3);
    assert.equal(step3.request.t_stream, 6.0);

    // Step 4: samples at t = 8.0 (live edge of 4 segments x 2s = 8s)
    const step4 = await sampler.step();
    assert.ok(step4);
    assert.equal(step4.request.t_stream, 8.0);

    // Step 5: beyond live edge -> returns null
    const step5 = await sampler.step();
    assert.equal(step5, null);

    // Verify all 4 analyzed requests received by stub detector
    assert.equal(analyzedRequests.length, 4);
    assert.equal(analyzedRequests[0].t_stream, 2.0);
    assert.equal(analyzedRequests[1].t_stream, 4.0);
    assert.equal(analyzedRequests[2].t_stream, 6.0);
    assert.equal(analyzedRequests[3].t_stream, 8.0);

    // Check monotonic progression
    for (let i = 1; i < analyzedRequests.length; i++) {
      assert.ok(
        analyzedRequests[i].t_stream > analyzedRequests[i - 1].t_stream,
        'Stream timestamps must be strictly monotonic'
      );
    }
  } finally {
    server.close();
    cleanTmp(TMP_BASE);
  }
});
