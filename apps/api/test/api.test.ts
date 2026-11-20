import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { DatabaseService } from '../src/db.js';
import type { Session, Detection, ClipSidecar } from '../src/types.js';

function createSeededDatabase(): DatabaseService {
  const db = new DatabaseService({ dbPath: ':memory:' });

  const session1: Session = {
    id: 'sess_01',
    source_url: 'https://www.twitch.tv/my-channel',
    source_label: 'my-channel',
    source_domain: 'twitch.tv',
    channel_slug: 'my-channel',
    status: 'active',
    started_at: '2026-11-20T10:00:00.000Z',
    ended_at: null,
    created_at: '2026-11-20T10:00:00.000Z',
    updated_at: '2026-11-20T10:00:00.000Z'
  };

  const session2: Session = {
    id: 'sess_02',
    source_url: 'https://www.youtube.com/tourney-live',
    source_label: 'tourney-live',
    source_domain: 'youtube.com',
    channel_slug: 'tourney-live',
    status: 'ended',
    started_at: '2026-11-19T18:00:00.000Z',
    ended_at: '2026-11-19T20:30:00.000Z',
    created_at: '2026-11-19T18:00:00.000Z',
    updated_at: '2026-11-19T20:30:00.000Z'
  };

  db.seedSession(session1);
  db.seedSession(session2);

  const detection1: Detection = {
    id: 'det_01',
    session_id: 'sess_01',
    source_label: 'my-channel',
    source_domain: 'twitch.tv',
    t_stream: 120.0,
    t_wall: '2026-11-20T10:02:00.000Z',
    fused_score: 0.85,
    signals: {
      audio: { value: 0.88, detail: { lufs: -13.0 } },
      chat: { value: 0.80, detail: { messages_in_window: 40 } }
    },
    status: 'clipped'
  };

  const detection2: Detection = {
    id: 'det_02',
    session_id: 'sess_01',
    source_label: 'my-channel',
    source_domain: 'twitch.tv',
    t_stream: 180.0,
    t_wall: '2026-11-20T10:03:00.000Z',
    fused_score: 0.65,
    signals: {
      audio: { value: 0.60 },
      chat: { value: 0.70 }
    },
    status: 'scored'
  };

  const detection3: Detection = {
    id: 'det_03',
    session_id: 'sess_02',
    source_label: 'tourney-live',
    source_domain: 'youtube.com',
    t_stream: 540.0,
    t_wall: '2026-11-19T18:09:00.000Z',
    fused_score: 0.92,
    signals: {
      audio: { value: 0.95 },
      speech_keywords: { value: 0.85, detail: { matched: ['clutch', 'win'] } }
    },
    status: 'clipped'
  };

  db.seedDetection(detection1);
  db.seedDetection(detection2);
  db.seedDetection(detection3);

  const clip1: ClipSidecar = {
    schema: 'clipforge.clip.v1',
    clip_id: 'clip_01',
    source: {
      url_host: 'twitch.tv',
      channel: 'my-channel',
      session_id: 'sess_01',
      t_start_stream: 110.0,
      t_end_stream: 128.0
    },
    detection: {
      id: 'det_01',
      fused_score: 0.85,
      top_signals: ['audio', 'chat']
    },
    media: {
      file: 'storage/clips/twitch.tv/my-channel/2026-11-20/clip_01.mp4',
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
    created_at: '2026-11-20T10:02:15.000Z'
  };

  const clip2: ClipSidecar = {
    schema: 'clipforge.clip.v1',
    clip_id: 'clip_02',
    source: {
      url_host: 'youtube.com',
      channel: 'tourney-live',
      session_id: 'sess_02',
      t_start_stream: 530.0,
      t_end_stream: 548.0
    },
    detection: {
      id: 'det_03',
      fused_score: 0.92,
      top_signals: ['audio', 'speech_keywords']
    },
    media: {
      file: 'storage/clips/youtube.com/tourney-live/2026-11-19/clip_02.mp4',
      duration_s: 18.0,
      width: 1920,
      height: 1080,
      codec: 'h264',
      vertical: false
    },
    review: {
      status: 'approved',
      title: 'Grand finals game winning play',
      tags: ['clutch', 'finals'],
      notes: 'Crisp audio'
    },
    created_at: '2026-11-19T18:09:20.000Z'
  };

  db.seedClip(clip1);
  db.seedClip(clip2);

  return db;
}

test('GET /api/health reports service health, detector state, and disk metrics', async () => {
  const db = createSeededDatabase();
  const app = createApp({ db });

  const response = await app.inject({
    method: 'GET',
    url: '/api/health'
  });

  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.ok(data.status === 'ok' || data.status === 'degraded');
  assert.ok(data.detector);
  assert.equal(typeof data.detector.reachable, 'boolean');
  assert.equal(typeof data.buffer_free_gb, 'number');
  assert.ok(data.gpu);
  assert.equal(typeof data.gpu.available, 'boolean');

  db.close();
});

test('GET /api/sessions returns all seeded sessions matching CONTRACTS §7', async () => {
  const db = createSeededDatabase();
  const app = createApp({ db });

  const response = await app.inject({
    method: 'GET',
    url: '/api/sessions'
  });

  assert.equal(response.statusCode, 200);
  const sessions = JSON.parse(response.body);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, 'sess_01');
  assert.equal(sessions[0].source_domain, 'twitch.tv');
  assert.equal(sessions[1].id, 'sess_02');
  assert.equal(sessions[1].channel_slug, 'tourney-live');

  db.close();
});

test('GET /api/detections returns detections with parsed signals and filters by score and session', async () => {
  const db = createSeededDatabase();
  const app = createApp({ db });

  // 1. All detections
  const allRes = await app.inject({
    method: 'GET',
    url: '/api/detections'
  });
  assert.equal(allRes.statusCode, 200);
  const allDets = JSON.parse(allRes.body);
  assert.equal(allDets.length, 3);
  assert.equal(typeof allDets[0].signals, 'object');
  assert.ok(allDets[0].signals.audio);

  // 2. Filter by session_id
  const sessionRes = await app.inject({
    method: 'GET',
    url: '/api/detections?session_id=sess_01'
  });
  assert.equal(sessionRes.statusCode, 200);
  const sessionDets = JSON.parse(sessionRes.body);
  assert.equal(sessionDets.length, 2);
  assert.ok(sessionDets.every((d: any) => d.session_id === 'sess_01'));

  // 3. Filter by min_score
  const scoreRes = await app.inject({
    method: 'GET',
    url: '/api/detections?min_score=0.80'
  });
  assert.equal(scoreRes.statusCode, 200);
  const scoreDets = JSON.parse(scoreRes.body);
  assert.equal(scoreDets.length, 2);
  assert.ok(scoreDets.every((d: any) => d.fused_score >= 0.80));

  // 4. Combined filter
  const combinedRes = await app.inject({
    method: 'GET',
    url: '/api/detections?session_id=sess_01&min_score=0.80'
  });
  assert.equal(combinedRes.statusCode, 200);
  const combinedDets = JSON.parse(combinedRes.body);
  assert.equal(combinedDets.length, 1);
  assert.equal(combinedDets[0].id, 'det_01');

  db.close();
});

test('GET /api/clips returns clips with sidecar data and supports status and source filtering', async () => {
  const db = createSeededDatabase();
  const app = createApp({ db });

  // 1. All clips
  const allRes = await app.inject({
    method: 'GET',
    url: '/api/clips'
  });
  assert.equal(allRes.statusCode, 200);
  const allClips = JSON.parse(allRes.body);
  assert.equal(allClips.length, 2);
  assert.equal(allClips[0].schema, 'clipforge.clip.v1');
  assert.ok(allClips[0].source);
  assert.ok(allClips[0].detection);
  assert.ok(allClips[0].media);
  assert.ok(allClips[0].review);

  // 2. Filter by status
  const statusRes = await app.inject({
    method: 'GET',
    url: '/api/clips?status=approved'
  });
  assert.equal(statusRes.statusCode, 200);
  const approvedClips = JSON.parse(statusRes.body);
  assert.equal(approvedClips.length, 1);
  assert.equal(approvedClips[0].clip_id, 'clip_02');
  assert.equal(approvedClips[0].review.status, 'approved');

  // 3. Filter by source
  const sourceRes = await app.inject({
    method: 'GET',
    url: '/api/clips?source=twitch.tv'
  });
  assert.equal(sourceRes.statusCode, 200);
  const twitchClips = JSON.parse(sourceRes.body);
  assert.equal(twitchClips.length, 1);
  assert.equal(twitchClips[0].clip_id, 'clip_01');

  db.close();
});

test('GET /api/clips/:id returns a single clip or 404 with standard error shape', async () => {
  const db = createSeededDatabase();
  const app = createApp({ db });

  // 1. Found clip
  const foundRes = await app.inject({
    method: 'GET',
    url: '/api/clips/clip_01'
  });
  assert.equal(foundRes.statusCode, 200);
  const clip = JSON.parse(foundRes.body);
  assert.equal(clip.clip_id, 'clip_01');
  assert.equal(clip.source.channel, 'my-channel');

  // 2. Not found clip returns error shape
  const notFoundRes = await app.inject({
    method: 'GET',
    url: '/api/clips/nonexistent_clip_id'
  });
  assert.equal(notFoundRes.statusCode, 404);
  const errData = JSON.parse(notFoundRes.body);
  assert.ok(errData.error);
  assert.equal(errData.error.code, 'CLIP_NOT_FOUND');
  assert.equal(errData.error.correlation_id, 'nonexistent_clip_id');
  assert.ok(errData.error.message.includes('nonexistent_clip_id'));

  db.close();
});

test('404 on unhandled routes returns error format matching CONTRACTS.md §7', async () => {
  const db = createSeededDatabase();
  const app = createApp({ db });

  const res = await app.inject({
    method: 'GET',
    url: '/api/unknown_endpoint'
  });

  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.body);
  assert.ok(body.error);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.ok(body.error.correlation_id);
  assert.ok(body.error.message.includes('not found'));

  db.close();
});
