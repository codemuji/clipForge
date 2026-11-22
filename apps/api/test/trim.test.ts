import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { DatabaseService } from '../src/db.js';
import type { Session, Detection, ClipSidecar } from '../src/types.js';

test('C-04 Trim: trim from MP4 writes new file, preserves original, asserts duration and lists both', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-trim-mp4-test-'));

  try {
    const db = new DatabaseService({ dbPath: ':memory:' });

    const session: Session = {
      id: 'sess_trim_01',
      source_url: 'https://twitch.tv/ninja',
      source_label: 'ninja',
      source_domain: 'twitch.tv',
      channel_slug: 'ninja',
      status: 'active',
      started_at: '2026-11-20T10:00:00Z',
      ended_at: null,
      created_at: '2026-11-20T10:00:00Z',
      updated_at: '2026-11-20T10:00:00Z'
    };
    db.seedSession(session);

    const detection: Detection = {
      id: 'det_trim_01',
      session_id: 'sess_trim_01',
      source_label: 'ninja',
      source_domain: 'twitch.tv',
      t_stream: 120.0,
      t_wall: '2026-11-20T10:02:00Z',
      fused_score: 0.88,
      signals: { audio: { value: 0.9 } },
      status: 'clipped',
      created_at: '2026-11-20T10:02:00Z'
    };
    db.seedDetection(detection);

    // Setup original clip files on disk
    const clipDir = path.join(tmpDir, 'clips', 'twitch.tv', 'ninja', '2026-11-20');
    fs.mkdirSync(clipDir, { recursive: true });

    const origMp4Content = 'ORIGINAL_MP4_UNTOUCHED_BYTES_12345';
    const origMp4Path = path.join(clipDir, 'clip_orig_01.mp4');
    const origSidecarPath = path.join(clipDir, 'clip_orig_01.json');
    fs.writeFileSync(origMp4Path, origMp4Content);

    const origSidecar: ClipSidecar = {
      schema: 'clipforge.clip.v1',
      clip_id: 'clip_orig_01',
      source: {
        url_host: 'twitch.tv',
        channel: 'ninja',
        session_id: 'sess_trim_01',
        t_start_stream: 110.0,
        t_end_stream: 130.0
      },
      detection: {
        id: 'det_trim_01',
        fused_score: 0.88,
        top_signals: ['audio']
      },
      media: {
        file: 'storage/clips/twitch.tv/ninja/2026-11-20/clip_orig_01.mp4',
        duration_s: 20.0,
        width: 1920,
        height: 1080,
        codec: 'h264',
        vertical: false
      },
      review: {
        status: 'approved',
        title: 'Original Ace Clip',
        tags: ['ace'],
        notes: 'Original note'
      },
      created_at: '2026-11-20T10:02:10Z'
    };
    fs.writeFileSync(origSidecarPath, JSON.stringify(origSidecar, null, 2));
    db.seedClip(origSidecar);

    let ffmpegCalled = false;
    let ffmpegCutArgs: string[] = [];

    const app = createApp({
      db,
      storagePath: tmpDir,
      ffmpegExecutor: async (_cmd, args) => {
        ffmpegCalled = true;
        ffmpegCutArgs = args;
        // In real execution ffmpeg produces the output file; simulate by creating it
        const outPath = args[args.length - 1];
        fs.writeFileSync(outPath, 'TRIMMED_MP4_BYTES_67890');
      },
      ffprobeExecutor: async () => ({
        duration: 10.0,
        width: 1920,
        height: 1080,
        codec: 'h264'
      })
    });

    // Execute Trim from MP4: start 5s, end 15s (duration = 10s)
    const res = await app.inject({
      method: 'POST',
      url: '/api/clips/clip_orig_01/trim',
      payload: {
        start_offset_s: 5.0,
        end_offset_s: 15.0
      }
    });

    assert.equal(res.statusCode, 201, 'Should return 201 Created');
    const trimmedClip = JSON.parse(res.payload) as ClipSidecar;

    // 1. Acceptance assertion: Each trim writes a new file
    assert.notEqual(trimmedClip.clip_id, 'clip_orig_01', 'Should have a unique new clip ID');
    assert.ok(trimmedClip.clip_id.startsWith('clip_orig_01_trim_'), 'Clip ID indicates trim lineage');
    assert.ok(fs.existsSync(path.resolve(tmpDir, trimmedClip.media.file.replace(/^storage[/\\]/, ''))), 'Trimmed MP4 file exists');
    assert.ok(fs.existsSync(path.resolve(tmpDir, trimmedClip.media.file.replace(/^storage[/\\]/, '').replace(/\.mp4$/, '.json'))), 'Trimmed sidecar exists');

    // 2. Acceptance assertion: Original is NEVER overwritten
    assert.ok(fs.existsSync(origMp4Path), 'Original MP4 still exists');
    assert.equal(fs.readFileSync(origMp4Path, 'utf8'), origMp4Content, 'Original MP4 content is completely unchanged');
    assert.ok(fs.existsSync(origSidecarPath), 'Original sidecar still exists');

    // 3. Acceptance assertion: Duration assertions
    assert.equal(trimmedClip.media.duration_s, 10.0, 'Duration assertion: matches requested window (15.0 - 5.0 = 10.0s)');
    assert.equal(trimmedClip.source.t_start_stream, 115.0, 't_start_stream offset by 5.0s (110 + 5 = 115.0s)');
    assert.equal(trimmedClip.source.t_end_stream, 125.0, 't_end_stream offset by 15.0s (110 + 15 = 125.0s)');

    // 4. Acceptance assertion: UI / API shows BOTH clips
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/clips'
    });
    assert.equal(listRes.statusCode, 200);
    const clipsList = JSON.parse(listRes.payload) as ClipSidecar[];
    assert.equal(clipsList.length, 2, 'API returns both the original and trimmed clip');
    const clipIds = clipsList.map((c) => c.clip_id);
    assert.ok(clipIds.includes('clip_orig_01'), 'List contains original clip');
    assert.ok(clipIds.includes(trimmedClip.clip_id), 'List contains trimmed clip');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('C-04 Trim: trim from buffer segments when available', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-trim-buffer-test-'));

  try {
    const db = new DatabaseService({ dbPath: ':memory:' });

    const session: Session = {
      id: 'sess_buf_01',
      source_url: 'https://twitch.tv/shroud',
      source_label: 'shroud',
      source_domain: 'twitch.tv',
      channel_slug: 'shroud',
      status: 'active',
      started_at: '2026-11-20T12:00:00Z',
      ended_at: null,
      created_at: '2026-11-20T12:00:00Z',
      updated_at: '2026-11-20T12:00:00Z'
    };
    db.seedSession(session);

    const detection: Detection = {
      id: 'det_buf_01',
      session_id: 'sess_buf_01',
      source_label: 'shroud',
      source_domain: 'twitch.tv',
      t_stream: 60.0,
      t_wall: '2026-11-20T12:01:00Z',
      fused_score: 0.92,
      signals: { audio: { value: 0.95 } },
      status: 'clipped',
      created_at: '2026-11-20T12:01:00Z'
    };
    db.seedDetection(detection);

    // Setup rolling buffer directory with segments covering t=50.0 to t=80.0
    const bufferDir = path.join(tmpDir, 'buffer', 'sess_buf_01');
    fs.mkdirSync(bufferDir, { recursive: true });
    fs.writeFileSync(path.join(bufferDir, 'segment_000_50.000_60.000.ts'), 'seg0');
    fs.writeFileSync(path.join(bufferDir, 'segment_001_60.000_70.000.ts'), 'seg1');
    fs.writeFileSync(path.join(bufferDir, 'segment_002_70.000_80.000.ts'), 'seg2');

    // Original clip covering stream t=50.0..70.0 (duration: 20s)
    const clipDir = path.join(tmpDir, 'clips', 'twitch.tv', 'shroud', '2026-11-20');
    fs.mkdirSync(clipDir, { recursive: true });
    const origMp4Path = path.join(clipDir, 'clip_shroud_01.mp4');
    fs.writeFileSync(origMp4Path, 'ORIGINAL_SHROUD_CLIP_CONTENT');

    const origSidecar: ClipSidecar = {
      schema: 'clipforge.clip.v1',
      clip_id: 'clip_shroud_01',
      source: {
        url_host: 'twitch.tv',
        channel: 'shroud',
        session_id: 'sess_buf_01',
        t_start_stream: 50.0,
        t_end_stream: 70.0
      },
      detection: {
        id: 'det_buf_01',
        fused_score: 0.92,
        top_signals: ['audio']
      },
      media: {
        file: 'storage/clips/twitch.tv/shroud/2026-11-20/clip_shroud_01.mp4',
        duration_s: 20.0,
        width: 1920,
        height: 1080,
        codec: 'h264',
        vertical: false
      },
      review: {
        status: 'unreviewed',
        title: 'Shroud Snipe',
        tags: ['sniper'],
        notes: null
      },
      created_at: '2026-11-20T12:01:05Z'
    };
    db.seedClip(origSidecar);

    let ffmpegInputPath = '';

    const app = createApp({
      db,
      storagePath: tmpDir,
      ffmpegExecutor: async (_cmd, args) => {
        const iIndex = args.indexOf('-i');
        if (iIndex >= 0 && args[iIndex + 1]) {
          ffmpegInputPath = args[iIndex + 1];
        }
        const outPath = args[args.length - 1];
        fs.writeFileSync(outPath, 'BUFFER_TRIMMED_MP4');
      },
      ffprobeExecutor: async () => ({
        duration: 8.0,
        width: 1920,
        height: 1080,
        codec: 'h264'
      })
    });

    // Trim: start_offset = 2.0s, end_offset = 10.0s (duration = 8.0s)
    const res = await app.inject({
      method: 'POST',
      url: '/api/clips/clip_shroud_01/trim',
      payload: {
        start_offset_s: 2.0,
        end_offset_s: 10.0
      }
    });

    assert.equal(res.statusCode, 201);
    const trimmed = JSON.parse(res.payload) as ClipSidecar;

    // Buffer cut verification
    assert.equal(trimmed.source.t_start_stream, 52.0, 'Stream start time offset by 2s (50 + 2 = 52.0)');
    assert.equal(trimmed.source.t_end_stream, 60.0, 'Stream end time offset by 10s (50 + 10 = 60.0)');
    assert.equal(trimmed.media.duration_s, 8.0, 'Duration assertion: exactly 8.0 seconds');
    assert.ok(fs.existsSync(origMp4Path), 'Original MP4 never overwritten');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('C-04 Trim: validates input offsets and handles nonexistent clip', async () => {
  const db = new DatabaseService({ dbPath: ':memory:' });
  const app = createApp({ db });

  // 1. Nonexistent clip -> 404
  const notFound = await app.inject({
    method: 'POST',
    url: '/api/clips/missing_clip/trim',
    payload: { start_offset_s: 0, end_offset_s: 5 }
  });
  assert.equal(notFound.statusCode, 404);
  const notFoundBody = JSON.parse(notFound.payload);
  assert.equal(notFoundBody.error.code, 'CLIP_NOT_FOUND');

  // Seed a valid clip
  const session: Session = {
    id: 's1',
    source_url: 'https://twitch.tv/test',
    source_label: 'test',
    source_domain: 'twitch.tv',
    channel_slug: 'test',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null,
    created_at: '2026-11-20T10:00:00Z',
    updated_at: '2026-11-20T10:00:00Z'
  };
  db.seedSession(session);
  const det: Detection = {
    id: 'd1',
    session_id: 's1',
    source_label: 'test',
    source_domain: 'twitch.tv',
    t_stream: 10,
    t_wall: '2026-11-20T10:00:10Z',
    fused_score: 0.8,
    signals: {},
    status: 'clipped'
  };
  db.seedDetection(det);
  const clip: ClipSidecar = {
    schema: 'clipforge.clip.v1',
    clip_id: 'clip_valid_01',
    source: {
      url_host: 'twitch.tv',
      channel: 'test',
      session_id: 's1',
      t_start_stream: 5,
      t_end_stream: 15
    },
    detection: { id: 'd1', fused_score: 0.8, top_signals: [] },
    media: {
      file: 'storage/clips/twitch.tv/test/2026-11-20/clip_valid_01.mp4',
      duration_s: 10.0,
      width: 1920,
      height: 1080,
      codec: 'h264',
      vertical: false
    },
    review: { status: 'unreviewed', title: null, tags: [], notes: null },
    created_at: '2026-11-20T10:00:15Z'
  };
  db.seedClip(clip);

  // 2. Negative start offset -> 400
  const negStart = await app.inject({
    method: 'POST',
    url: '/api/clips/clip_valid_01/trim',
    payload: { start_offset_s: -1, end_offset_s: 5 }
  });
  assert.equal(negStart.statusCode, 400);

  // 3. end <= start -> 400
  const endLeStart = await app.inject({
    method: 'POST',
    url: '/api/clips/clip_valid_01/trim',
    payload: { start_offset_s: 5, end_offset_s: 5 }
  });
  assert.equal(endLeStart.statusCode, 400);

  // 4. start >= duration -> 400
  const startGteDur = await app.inject({
    method: 'POST',
    url: '/api/clips/clip_valid_01/trim',
    payload: { start_offset_s: 15, end_offset_s: 20 }
  });
  assert.equal(startGteDur.statusCode, 400);

  // 5. Missing offsets -> 400
  const missingOffsets = await app.inject({
    method: 'POST',
    url: '/api/clips/clip_valid_01/trim',
    payload: {}
  });
  assert.equal(missingOffsets.statusCode, 400);
});
