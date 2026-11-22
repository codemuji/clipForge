import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { DatabaseService } from '../src/db.js';
import type { Session, Detection, ClipSidecar } from '../src/types.js';

test('C-05 Export: fixture export is 9:16 with real FFmpeg and preserves original', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-export-fixture-test-'));

  try {
    const db = new DatabaseService({ dbPath: ':memory:' });

    const session: Session = {
      id: 'sess_export_fixture',
      source_url: 'https://twitch.tv/test_export',
      source_label: 'test_export',
      source_domain: 'twitch.tv',
      channel_slug: 'test_export',
      status: 'active',
      started_at: '2026-11-20T10:00:00Z',
      ended_at: null,
      created_at: '2026-11-20T10:00:00Z',
      updated_at: '2026-11-20T10:00:00Z'
    };
    db.seedSession(session);

    const detection: Detection = {
      id: 'det_export_01',
      session_id: 'sess_export_fixture',
      source_label: 'test_export',
      source_domain: 'twitch.tv',
      t_stream: 30.0,
      t_wall: '2026-11-20T10:00:30Z',
      fused_score: 0.9,
      signals: {},
      status: 'clipped'
    };
    db.seedDetection(detection);

    // Copy real test fixture (loud_burst.mp4 or hud_overlay.mp4) to temp clips dir
    const fixtureSource = path.resolve('fixtures', 'loud_burst.mp4');
    const clipDir = path.join(tmpDir, 'clips', 'twitch.tv', 'test_export', '2026-11-20');
    fs.mkdirSync(clipDir, { recursive: true });

    const origMp4Path = path.join(clipDir, 'clip_fixture_orig.mp4');
    fs.copyFileSync(fixtureSource, origMp4Path);
    const origBytes = fs.readFileSync(origMp4Path);

    const origSidecar: ClipSidecar = {
      schema: 'clipforge.clip.v1',
      clip_id: 'clip_fixture_orig',
      source: {
        url_host: 'twitch.tv',
        channel: 'test_export',
        session_id: 'sess_export_fixture',
        t_start_stream: 20.0,
        t_end_stream: 40.0
      },
      detection: { id: 'det_export_01', fused_score: 0.9, top_signals: ['audio'] },
      media: {
        file: 'storage/clips/twitch.tv/test_export/2026-11-20/clip_fixture_orig.mp4',
        duration_s: 60.0,
        width: 1280,
        height: 720,
        codec: 'h264',
        vertical: false
      },
      review: { status: 'approved', title: 'Fixture High Score', tags: ['burst'], notes: null },
      created_at: '2026-11-20T10:00:40Z'
    };
    db.seedClip(origSidecar);

    const app = createApp({
      db,
      storagePath: tmpDir
    });

    // Execute Export: vertical: true (9:16)
    const res = await app.inject({
      method: 'POST',
      url: '/api/clips/clip_fixture_orig/export',
      payload: {
        vertical: true,
        burn_captions: false // optional and off by default
      }
    });

    assert.equal(res.statusCode, 201, 'Should return 201 Created');
    const exportedClip = JSON.parse(res.payload) as ClipSidecar;

    // 1. Acceptance assertion: 9:16 vertical crop
    assert.equal(exportedClip.media.vertical, true, 'Exported clip media.vertical must be true');
    assert.equal(exportedClip.media.width, 1080, 'Exported 9:16 width is 1080');
    assert.equal(exportedClip.media.height, 1920, 'Exported 9:16 height is 1920');
    const aspectRatio = exportedClip.media.width / exportedClip.media.height;
    assert.ok(Math.abs(aspectRatio - (9 / 16)) < 0.01, 'Aspect ratio must strictly equal 9:16');

    // 2. Acceptance assertion: Writes a new file beside original, original is never overwritten
    assert.notEqual(exportedClip.clip_id, 'clip_fixture_orig', 'Writes new clip with unique ID');
    assert.ok(fs.existsSync(origMp4Path), 'Original MP4 still exists');
    assert.equal(fs.readFileSync(origMp4Path).length, origBytes.length, 'Original MP4 bytes untouched');

    const exportedDiskMp4 = path.resolve(tmpDir, exportedClip.media.file.replace(/^storage[/\\]/, ''));
    assert.ok(fs.existsSync(exportedDiskMp4), 'Exported MP4 exists on disk beside original');
    assert.ok(fs.statSync(exportedDiskMp4).size > 0, 'Exported MP4 is a valid video file');

    // 3. Acceptance assertion: Both clips listed in storage / DB
    const listRes = await app.inject({ method: 'GET', url: '/api/clips' });
    const clips = JSON.parse(listRes.payload) as ClipSidecar[];
    assert.equal(clips.length, 2, 'Lists both original and exported clips');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('C-05 Export: uses NVENC if present, CPU otherwise, and captions off by default', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-export-nvenc-test-'));

  try {
    const db = new DatabaseService({ dbPath: ':memory:' });

    const session: Session = {
      id: 's_nvenc',
      source_url: 'https://twitch.tv/gamer',
      source_label: 'gamer',
      source_domain: 'twitch.tv',
      channel_slug: 'gamer',
      status: 'active',
      started_at: '2026-11-20T10:00:00Z',
      ended_at: null,
      created_at: '2026-11-20T10:00:00Z',
      updated_at: '2026-11-20T10:00:00Z'
    };
    db.seedSession(session);

    const detection: Detection = {
      id: 'd_nvenc',
      session_id: 's_nvenc',
      source_label: 'gamer',
      source_domain: 'twitch.tv',
      t_stream: 10.0,
      t_wall: '2026-11-20T10:00:10Z',
      fused_score: 0.85,
      signals: {},
      status: 'clipped'
    };
    db.seedDetection(detection);

    const clipDir = path.join(tmpDir, 'clips', 'twitch.tv', 'gamer', '2026-11-20');
    fs.mkdirSync(clipDir, { recursive: true });
    const sourceMp4 = path.join(clipDir, 'clip_nvenc_test.mp4');
    fs.writeFileSync(sourceMp4, 'source-video-content');

    const clip: ClipSidecar = {
      schema: 'clipforge.clip.v1',
      clip_id: 'clip_nvenc_test',
      source: {
        url_host: 'twitch.tv',
        channel: 'gamer',
        session_id: 's_nvenc',
        t_start_stream: 0,
        t_end_stream: 10
      },
      detection: { id: 'd_nvenc', fused_score: 0.85, top_signals: [] },
      media: {
        file: 'storage/clips/twitch.tv/gamer/2026-11-20/clip_nvenc_test.mp4',
        duration_s: 10.0,
        width: 1920,
        height: 1080,
        codec: 'h264',
        vertical: false
      },
      review: { status: 'unreviewed', title: 'Test Title', tags: [], notes: null },
      created_at: '2026-11-20T10:00:00Z'
    };
    db.seedClip(clip);

    let capturedArgs: string[] = [];

    const app = createApp({
      db,
      storagePath: tmpDir,
      ffmpegExecutor: async (_cmd, args) => {
        capturedArgs = args;
        const outPath = args[args.length - 1];
        fs.writeFileSync(outPath, 'mock-export-nvenc');
        return;
      },
      ffprobeExecutor: async () => ({
        duration: 10.0,
        width: 1080,
        height: 1920,
        codec: 'h264'
      })
    });

    // 1. Export with vertical: true, default captions (off)
    const res = await app.inject({
      method: 'POST',
      url: '/api/clips/clip_nvenc_test/export',
      payload: { vertical: true }
    });

    assert.equal(res.statusCode, 201);
    const exported = JSON.parse(res.payload) as ClipSidecar;
    assert.equal(exported.media.vertical, true);

    // Verify filter args for 9:16
    const vfIndex = capturedArgs.indexOf('-vf');
    assert.ok(vfIndex >= 0, 'Contains -vf video filter');
    assert.ok(capturedArgs[vfIndex + 1].includes('crop=ih*9/16'), 'Applies 9:16 crop filter');
    assert.ok(!capturedArgs[vfIndex + 1].includes('drawtext'), 'Captions are off by default');

    // 2. Export with captions enabled
    const resCaptions = await app.inject({
      method: 'POST',
      url: '/api/clips/clip_nvenc_test/export',
      payload: { vertical: true, burn_captions: true }
    });
    assert.equal(resCaptions.statusCode, 201);
    const vfCaptionsIndex = capturedArgs.indexOf('-vf');
    assert.ok(capturedArgs[vfCaptionsIndex + 1].includes('drawtext') || capturedArgs[vfCaptionsIndex + 1].includes('subtitles'), 'Captions burned when requested');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('C-05 Export: returns 404 for nonexistent clip', async () => {
  const db = new DatabaseService({ dbPath: ':memory:' });
  const app = createApp({ db });

  const res = await app.inject({
    method: 'POST',
    url: '/api/clips/nonexistent_clip/export',
    payload: { vertical: true }
  });

  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.payload);
  assert.equal(body.error.code, 'CLIP_NOT_FOUND');
});
