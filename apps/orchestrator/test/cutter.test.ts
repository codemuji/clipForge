import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDatabase } from '@clipforge/shared';
import type {
  DbSession,
  DetectionEvent,
  ClipSidecar
} from '@clipforge/shared';
import {
  ClipCutter,
  normalizeSourceDomain,
  normalizeChannelSlug,
  resolveClipPaths,
  probeMedia,
  BufferSegment
} from '../src/index.js';

const TMP_BASE = path.resolve('storage', 'tmp', 'test_cutter_' + Date.now());

function cleanTmp(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

test('normalizeSourceDomain: strips protocols, ports, trailing slashes, and leading www.', () => {
  assert.equal(normalizeSourceDomain('https://www.twitch.tv/shroud'), 'twitch.tv');
  assert.equal(normalizeSourceDomain('http://www.youtube.com:8080/watch?v=123'), 'youtube.com');
  assert.equal(normalizeSourceDomain('www.kick.com/streamer'), 'kick.com');
  assert.equal(normalizeSourceDomain('https://kick.com'), 'kick.com');
  assert.equal(normalizeSourceDomain('local'), 'local');
  assert.equal(normalizeSourceDomain(''), 'local');
});

test('normalizeChannelSlug: cleans slugs for filesystem safety', () => {
  assert.equal(normalizeChannelSlug('shroud'), 'shroud');
  assert.equal(normalizeChannelSlug('My Cool Channel! #1'), 'my_cool_channel_1');
  assert.equal(normalizeChannelSlug('test/channel\\slug'), 'test_channel_slug');
  assert.equal(normalizeChannelSlug(''), 'default');
});

test('resolveClipPaths: conforms to AGENTS §4 layout and generates correct relative paths', () => {
  const root = './storage';
  const paths = resolveClipPaths(
    root,
    'https://www.twitch.tv/my-channel',
    'My-Channel',
    '2026-11-20T10:15:04Z',
    'clip_01HXYZ'
  );

  assert.equal(paths.domain, 'twitch.tv');
  assert.equal(paths.channel, 'my-channel');
  assert.equal(paths.dateStr, '2026-11-20');
  assert.equal(paths.relativeMp4Path, 'storage/clips/twitch.tv/my-channel/2026-11-20/clip_01HXYZ.mp4');
  assert.equal(paths.relativeSidecarPath, 'storage/clips/twitch.tv/my-channel/2026-11-20/clip_01HXYZ.json');
  assert.ok(paths.mp4Path.endsWith(path.join('twitch.tv', 'my-channel', '2026-11-20', 'clip_01HXYZ.mp4')));
  assert.ok(paths.sidecarPath.endsWith(path.join('twitch.tv', 'my-channel', '2026-11-20', 'clip_01HXYZ.json')));
});

test('clampWindow: bounds [t - pre, t + post] to available buffer segment range', () => {
  const cutter = new ClipCutter();
  const segments: BufferSegment[] = [
    { file: 'seg_00010.ts', path: '/dummy/seg_00010.ts', index: 10, start_t: 20.0, end_t: 22.0, sizeBytes: 1000, mtimeMs: 1 },
    { file: 'seg_00011.ts', path: '/dummy/seg_00011.ts', index: 11, start_t: 22.0, end_t: 24.0, sizeBytes: 1000, mtimeMs: 2 },
    { file: 'seg_00012.ts', path: '/dummy/seg_00012.ts', index: 12, start_t: 24.0, end_t: 26.0, sizeBytes: 1000, mtimeMs: 3 },
    { file: 'seg_00013.ts', path: '/dummy/seg_00013.ts', index: 13, start_t: 26.0, end_t: 28.0, sizeBytes: 1000, mtimeMs: 4 }
  ];

  // 1. Within range: t=24.0, pre=2, post=2 -> [22.0, 26.0]
  const win1 = cutter.clampWindow(24.0, segments, 2.0, 2.0);
  assert.equal(win1.startT, 22.0);
  assert.equal(win1.endT, 26.0);

  // 2. Start clamped to buffer minimum: t=21.0, pre=5, post=2 -> requested start 16.0, clamped to 20.0
  const win2 = cutter.clampWindow(21.0, segments, 5.0, 2.0);
  assert.equal(win2.startT, 20.0);
  assert.equal(win2.endT, 23.0);

  // 3. End clamped to buffer maximum: t=27.0, pre=2, post=5 -> requested end 32.0, clamped to 28.0
  const win3 = cutter.clampWindow(27.0, segments, 2.0, 5.0);
  assert.equal(win3.startT, 25.0);
  assert.equal(win3.endT, 28.0);

  // 4. Empty segments: throws error
  assert.throws(() => cutter.clampWindow(24.0, [], 2.0, 2.0), /No buffer segments/);

  // 5. Inverted/out-of-range window: throws error
  assert.throws(() => cutter.clampWindow(10.0, segments, 0.0, 0.0), /Invalid clamped window/);
});

test('extractTopSignals: correctly extracts and ranks active non-null signals', () => {
  const cutter = new ClipCutter();
  const top1 = cutter.extractTopSignals({
    audio: { value: 0.95 },
    chat: { value: 0.80 },
    speech_keywords: { value: 0.40 },
    hud_text: { value: null },
    frame_classifier: { value: 0.60 }
  });
  assert.deepEqual(top1, ['audio', 'chat', 'frame_classifier', 'speech_keywords']);

  const top2 = cutter.extractTopSignals({
    audio: { value: null },
    chat: { value: null },
    speech_keywords: { value: null },
    hud_text: { value: null },
    frame_classifier: { value: null }
  });
  assert.deepEqual(top2, []);
});

test('probeMedia: extracts stream resolution and duration from valid media file', async () => {
  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  assert.ok(fs.existsSync(fixturePath), 'Fixture loud_burst.mp4 must exist');

  const meta = await probeMedia(fixturePath);
  assert.ok(meta.width > 0, 'Width must be positive');
  assert.ok(meta.height > 0, 'Height must be positive');
  assert.ok(meta.duration_s > 0, 'Duration must be positive');
  assert.ok(meta.file_size_bytes > 0, 'File size must be positive');
});

test('ClipCutter: end-to-end clip cut against fixture buffer with atomic sidecar and DB persistence', async () => {
  const testDir = path.join(TMP_BASE, 'e2e_cut');
  const bufferDir = path.join(testDir, 'buffer');
  const storageRoot = path.join(testDir, 'storage');

  fs.mkdirSync(bufferDir, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  assert.ok(fs.existsSync(fixturePath), 'Fixture loud_burst.mp4 must exist');

  // Slice 3 segments (2s each) from loud_burst.mp4
  const seg0Path = path.join(bufferDir, 'seg_00000.ts');
  const seg1Path = path.join(bufferDir, 'seg_00001.ts');
  const seg2Path = path.join(bufferDir, 'seg_00002.ts');

  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0', '-t', '2', '-i', fixturePath, '-c', 'copy', seg0Path]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2', '-t', '2', '-i', fixturePath, '-c', 'copy', seg1Path]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '4', '-t', '2', '-i', fixturePath, '-c', 'copy', seg2Path]);

  // Setup DB
  const { repo } = createDatabase(':memory:');
  const session: DbSession = repo.createSession({
    id: 'sess_cutter_test',
    source_url: 'https://www.twitch.tv/test_streamer',
    source_label: 'test_streamer',
    source_domain: 'twitch.tv',
    channel_slug: 'test_streamer',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null
  });

  const detection: DetectionEvent = {
    id: 'det_test_01',
    session_id: session.id,
    source_label: session.source_label,
    source_domain: session.source_domain,
    t_stream: 3.0,
    t_wall: '2026-11-20T10:05:00Z',
    fused_score: 0.88,
    signals: {
      audio: { value: 0.92, detail: { lufs: -12.0 } },
      chat: { value: 0.75, detail: { messages: 15 } },
      speech_keywords: { value: 0.50, detail: { matched: ['poggers'] } },
      hud_text: { value: null },
      frame_classifier: { value: 0.70, label: 'action' }
    },
    status: 'scored'
  };

  repo.createDetection({
    id: detection.id,
    session_id: detection.session_id,
    source_label: detection.source_label,
    source_domain: detection.source_domain,
    t_stream: detection.t_stream,
    t_wall: detection.t_wall,
    fused_score: detection.fused_score,
    signals: JSON.stringify(detection.signals),
    status: detection.status
  });

  const cutter = new ClipCutter({
    storageRoot,
    clipConfig: {
      pre_seconds: 1.0,
      post_seconds: 1.5,
      encode: 'copy',
      vertical: false
    },
    db: repo
  });

  // Execute cut
  const result = await cutter.cut({
    detection,
    session,
    bufferDir,
    clipId: 'clip_test_001'
  });

  // Verify cut result
  assert.equal(result.job.id.length > 0, true);
  assert.equal(result.job.status, 'encoded');
  assert.equal(result.job.start_t, 2.0); // 3.0 - 1.0
  assert.equal(result.job.end_t, 4.5);   // 3.0 + 1.5
  assert.equal(result.durationSeconds, 2.5);

  // Verify output files exist and are non-empty
  assert.ok(fs.existsSync(result.mp4Path), 'Output MP4 must exist');
  assert.ok(fs.existsSync(result.sidecarPath), 'Output sidecar JSON must exist');
  assert.ok(fs.statSync(result.mp4Path).size > 1000, 'Output MP4 must have content');

  // Verify no temporary files remain in clip dir
  const clipDirFiles = fs.readdirSync(path.dirname(result.mp4Path));
  const tmpFiles = clipDirFiles.filter((f) => f.startsWith('.tmp_'));
  assert.equal(tmpFiles.length, 0, 'Temporary files must be renamed and cleaned up');

  // Verify Sidecar JSON structure matching clipforge.clip.v1 schema
  const sidecarRaw = fs.readFileSync(result.sidecarPath, 'utf8');
  const sidecar = JSON.parse(sidecarRaw) as ClipSidecar;
  assert.equal(sidecar.schema, 'clipforge.clip.v1');
  assert.equal(sidecar.clip_id, 'clip_test_001');
  assert.equal(sidecar.source.url_host, 'twitch.tv');
  assert.equal(sidecar.source.channel, 'test_streamer');
  assert.equal(sidecar.source.session_id, session.id);
  assert.equal(sidecar.source.t_start_stream, 2.0);
  assert.equal(sidecar.source.t_end_stream, 4.5);
  assert.equal(sidecar.detection.id, detection.id);
  assert.equal(sidecar.detection.fused_score, 0.88);
  assert.deepEqual(sidecar.detection.top_signals, ['audio', 'chat', 'frame_classifier', 'speech_keywords']);
  assert.equal(sidecar.media.file, 'clip_test_001.mp4');
  assert.ok(sidecar.media.width > 0);
  assert.ok(sidecar.media.height > 0);
  assert.ok(sidecar.media.duration_s > 0);
  assert.equal(sidecar.media.vertical, false);
  assert.equal(sidecar.review.status, 'unreviewed');
  assert.equal(sidecar.review.title, null);
  assert.deepEqual(sidecar.review.tags, []);

  // Verify schema validation against schema file
  const schemaPath = path.resolve('packages', 'shared', 'schemas', 'clip-sidecar.schema.json');
  assert.ok(fs.existsSync(schemaPath));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  for (const requiredKey of schema.required) {
    assert.ok(requiredKey in sidecar, `Sidecar must include required key: ${requiredKey}`);
  }

  // Verify DB records
  const dbJob = repo.getClipJob(result.job.id);
  assert.ok(dbJob);
  assert.equal(dbJob.status, 'encoded');
  assert.equal(dbJob.error, null);

  const dbClip = repo.getClip('clip_test_001');
  assert.ok(dbClip);
  assert.equal(dbClip.source_domain, 'twitch.tv');
  assert.equal(dbClip.channel_slug, 'test_streamer');
  assert.equal(dbClip.t_start_stream, 2.0);
  assert.equal(dbClip.t_end_stream, 4.5);
  assert.equal(dbClip.review_status, 'unreviewed');

  cleanTmp(TMP_BASE);
});

test('ClipCutter: fails job and persists failed status in DB on unrecoverable cut error', async () => {
  const testDir = path.join(TMP_BASE, 'fail_cut');
  const bufferDir = path.join(testDir, 'buffer');
  const storageRoot = path.join(testDir, 'storage');

  fs.mkdirSync(bufferDir, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  const seg0Path = path.join(bufferDir, 'seg_00000.ts');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0', '-t', '2', '-i', fixturePath, '-c', 'copy', seg0Path]);

  const { repo } = createDatabase(':memory:');
  const session: DbSession = repo.createSession({
    id: 'sess_fail_test',
    source_url: 'https://kick.com/fails',
    source_label: 'fails',
    source_domain: 'kick.com',
    channel_slug: 'fails',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null
  });

  const detection: DetectionEvent = {
    id: 'det_fail_01',
    session_id: session.id,
    source_label: session.source_label,
    source_domain: session.source_domain,
    t_stream: 1.0,
    t_wall: '2026-11-20T10:05:00Z',
    fused_score: 0.90,
    signals: { audio: { value: 0.9 }, chat: { value: null }, speech_keywords: { value: null }, hud_text: { value: null }, frame_classifier: { value: null } },
    status: 'scored'
  };

  repo.createDetection({
    id: detection.id,
    session_id: detection.session_id,
    source_label: detection.source_label,
    source_domain: detection.source_domain,
    t_stream: detection.t_stream,
    t_wall: detection.t_wall,
    fused_score: detection.fused_score,
    signals: JSON.stringify(detection.signals),
    status: detection.status
  });

  // Use invalid ffmpeg path to trigger guaranteed failure during executeFfmpegCut
  const cutter = new ClipCutter({
    storageRoot,
    ffmpegPath: 'non_existent_ffmpeg_binary_xyz',
    db: repo
  });

  await assert.rejects(async () => {
    await cutter.cut({
      detection,
      session,
      bufferDir
    });
  });

  const jobs = repo.listClipJobs({ sessionId: session.id });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'failed');
  assert.ok(jobs[0].error && jobs[0].error.length > 0);

  cleanTmp(TMP_BASE);
});

test('ClipCutter: encoding modes (h264_cpu, vertical crop, and NVENC fallback)', async () => {
  const testDir = path.join(TMP_BASE, 'encode_cut');
  const bufferDir = path.join(testDir, 'buffer');
  const storageRoot = path.join(testDir, 'storage');

  fs.mkdirSync(bufferDir, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const fixturePath = path.resolve('fixtures', 'loud_burst.mp4');
  const seg0Path = path.join(bufferDir, 'seg_00000.ts');
  const seg1Path = path.join(bufferDir, 'seg_00001.ts');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0', '-t', '2', '-i', fixturePath, '-c', 'copy', seg0Path]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2', '-t', '2', '-i', fixturePath, '-c', 'copy', seg1Path]);

  const { repo } = createDatabase(':memory:');
  const session: DbSession = repo.createSession({
    id: 'sess_encode_test',
    source_url: 'https://youtube.com/gaming',
    source_label: 'gaming',
    source_domain: 'youtube.com',
    channel_slug: 'gaming',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null
  });

  const detection: DetectionEvent = {
    id: 'det_enc_01',
    session_id: session.id,
    source_label: session.source_label,
    source_domain: session.source_domain,
    t_stream: 1.5,
    t_wall: '2026-11-20T10:05:00Z',
    fused_score: 0.85,
    signals: { audio: { value: 0.85 }, chat: { value: null }, speech_keywords: { value: null }, hud_text: { value: null }, frame_classifier: { value: null } },
    status: 'scored'
  };

  repo.createDetection({
    id: detection.id,
    session_id: detection.session_id,
    source_label: detection.source_label,
    source_domain: detection.source_domain,
    t_stream: detection.t_stream,
    t_wall: detection.t_wall,
    fused_score: detection.fused_score,
    signals: JSON.stringify(detection.signals),
    status: detection.status
  });

  const cutter = new ClipCutter({
    storageRoot,
    db: repo
  });

  // 1. Test vertical crop with h264_cpu
  const verticalResult = await cutter.cut({
    detection,
    session,
    bufferDir,
    clipId: 'clip_vert_01',
    requestedStartT: 0.5,
    requestedEndT: 2.5,
    encode: 'h264_cpu',
    vertical: true
  });

  assert.equal(verticalResult.job.status, 'encoded');
  assert.equal(verticalResult.sidecar.media.vertical, true);
  const probedVert = await probeMedia(verticalResult.mp4Path);
  assert.ok(probedVert.width < probedVert.height, `Vertical video width (${probedVert.width}) must be < height (${probedVert.height})`);

  // 2. Test NVENC fallback: requesting h264_nvenc
  // In dev / CI environments without NVENC, this must gracefully fall back to CPU libx264
  const nvencResult = await cutter.cut({
    detection,
    session,
    bufferDir,
    clipId: 'clip_nvenc_01',
    requestedStartT: 0.5,
    requestedEndT: 2.0,
    encode: 'h264_nvenc',
    vertical: false
  });

  assert.equal(nvencResult.job.status, 'encoded');
  assert.ok(fs.existsSync(nvencResult.mp4Path));
  assert.ok(nvencResult.usedNvenc || nvencResult.fallbackToCpu, 'Must either succeed with NVENC or fall back to CPU');

  cleanTmp(TMP_BASE);
});
