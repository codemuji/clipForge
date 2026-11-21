import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase, runMigrations, DatabaseRepository } from '../src/index.js';

test('database migrations: run cleanly on empty DB and are idempotent', () => {
  const db = new DatabaseSync(':memory:');

  // First run applies migration
  const firstApplied = runMigrations(db);
  assert.equal(firstApplied.length, 1);
  assert.equal(firstApplied[0], '001_initial_schema');

  // Second run applies nothing (idempotent)
  const secondApplied = runMigrations(db);
  assert.equal(secondApplied.length, 0);

  // Tables exist and can be queried
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  const tableNames = tables.map((t) => t.name);
  assert.ok(tableNames.includes('sessions'));
  assert.ok(tableNames.includes('detections'));
  assert.ok(tableNames.includes('clip_jobs'));
  assert.ok(tableNames.includes('clips'));
  assert.ok(tableNames.includes('_migrations'));
});

test('database repository: covers sessions, detections, clip_jobs, and clips CRUD', () => {
  const { repo } = createDatabase(':memory:');

  // 1. Sessions
  const session = repo.createSession({
    id: 'sess_test_01',
    source_url: 'https://twitch.tv/gamer',
    source_label: 'gamer',
    source_domain: 'twitch.tv',
    channel_slug: 'gamer',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null
  });
  assert.equal(session.id, 'sess_test_01');
  assert.equal(repo.getSession('sess_test_01')?.status, 'active');

  repo.updateSessionStatus('sess_test_01', 'ended', '2026-11-20T11:00:00Z');
  assert.equal(repo.getSession('sess_test_01')?.status, 'ended');
  assert.equal(repo.getSession('sess_test_01')?.ended_at, '2026-11-20T11:00:00Z');

  // 2. Detections
  const det = repo.createDetection({
    id: 'det_test_01',
    session_id: 'sess_test_01',
    source_label: 'gamer',
    source_domain: 'twitch.tv',
    t_stream: 120.0,
    t_wall: '2026-11-20T10:02:00Z',
    fused_score: 0.85,
    signals: JSON.stringify({ audio: { value: 0.9 } }),
    status: 'scored'
  });
  assert.equal(det.id, 'det_test_01');
  assert.equal(repo.listDetections({ sessionId: 'sess_test_01', minScore: 0.8 }).length, 1);
  assert.equal(repo.listDetections({ sessionId: 'sess_test_01', minScore: 0.9 }).length, 0);

  repo.updateDetectionStatus('det_test_01', 'clipped');
  assert.equal(repo.getDetection('det_test_01')?.status, 'clipped');

  // 3. Clip Jobs
  const job = repo.createClipJob({
    id: 'clip_job_01',
    detection_id: 'det_test_01',
    session_id: 'sess_test_01',
    start_t: 110.0,
    end_t: 128.0,
    status: 'queued',
    output_path: 'storage/clips/twitch.tv/gamer/2026-11-20/clip_job_01.mp4',
    error: null,
    created_at: '2026-11-20T10:02:01Z',
    updated_at: '2026-11-20T10:02:01Z'
  });
  assert.equal(job.id, 'clip_job_01');
  assert.equal(repo.listClipJobs({ status: 'queued' }).length, 1);

  repo.updateClipJobStatus('clip_job_01', 'encoded');
  assert.equal(repo.getClipJob('clip_job_01')?.status, 'encoded');

  // 4. Clips & Sidecar metadata
  const clip = repo.createClip({
    id: 'clip_job_01',
    job_id: 'clip_job_01',
    session_id: 'sess_test_01',
    detection_id: 'det_test_01',
    source_domain: 'twitch.tv',
    channel_slug: 'gamer',
    t_start_stream: 110.0,
    t_end_stream: 128.0,
    duration_s: 18.0,
    width: 1920,
    height: 1080,
    codec: 'h264',
    vertical: 0,
    output_path: 'storage/clips/twitch.tv/gamer/2026-11-20/clip_job_01.mp4',
    sidecar_path: 'storage/clips/twitch.tv/gamer/2026-11-20/clip_job_01.json',
    fused_score: 0.85,
    top_signals: JSON.stringify(['audio']),
    review_status: 'unreviewed',
    title: null,
    tags: '[]',
    notes: null,
    created_at: '2026-11-20T10:02:15Z',
    updated_at: '2026-11-20T10:02:15Z'
  });
  assert.equal(clip.id, 'clip_job_01');
  assert.equal(repo.listClips({ status: 'unreviewed' }).length, 1);

  repo.updateClipReview('clip_job_01', {
    status: 'approved',
    title: 'Epic Clutch',
    tags: ['hype', 'clutch'],
    notes: 'Approved for highlight reel'
  });
  const updatedClip = repo.getClip('clip_job_01');
  assert.equal(updatedClip?.review_status, 'approved');
  assert.equal(updatedClip?.title, 'Epic Clutch');
  assert.equal(updatedClip?.tags, JSON.stringify(['hype', 'clutch']));
  assert.equal(updatedClip?.notes, 'Approved for highlight reel');
});

test('buffer eviction protection query: enforces CONTRACTS §5 protection rule', () => {
  const { repo } = createDatabase(':memory:');

  repo.createSession({
    id: 'sess_evict',
    source_url: 'https://twitch.tv/gamer',
    source_label: 'gamer',
    source_domain: 'twitch.tv',
    channel_slug: 'gamer',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null
  });

  repo.createDetection({
    id: 'det_evict_1',
    session_id: 'sess_evict',
    source_label: 'gamer',
    source_domain: 'twitch.tv',
    t_stream: 100.0,
    t_wall: '2026-11-20T10:01:40Z',
    fused_score: 0.88,
    signals: '{}',
    status: 'clipped'
  });

  // Clip job 1: covering [90.0, 108.0], queued
  repo.createClipJob({
    id: 'job_active_1',
    detection_id: 'det_evict_1',
    session_id: 'sess_evict',
    start_t: 90.0,
    end_t: 108.0,
    status: 'queued',
    output_path: 'clip1.mp4',
    error: null,
    created_at: '2026-11-20T10:01:41Z',
    updated_at: '2026-11-20T10:01:41Z'
  });

  // Segment [92.0, 94.0] is inside [90.0, 108.0] -> PROTECTED
  assert.equal(repo.isSegmentProtected('sess_evict', 92.0, 94.0), true);

  // Segment [89.0, 91.0] overlaps the start -> PROTECTED
  assert.equal(repo.isSegmentProtected('sess_evict', 89.0, 91.0), true);

  // Segment [107.0, 109.0] overlaps the end -> PROTECTED
  assert.equal(repo.isSegmentProtected('sess_evict', 107.0, 109.0), true);

  // Segment [80.0, 82.0] is entirely before [90.0, 108.0] -> NOT PROTECTED (evictable)
  assert.equal(repo.isSegmentProtected('sess_evict', 80.0, 82.0), false);

  // Segment [110.0, 112.0] is entirely after [90.0, 108.0] -> NOT PROTECTED (evictable)
  assert.equal(repo.isSegmentProtected('sess_evict', 110.0, 112.0), false);

  // Segment in a different session -> NOT PROTECTED
  assert.equal(repo.isSegmentProtected('sess_other', 92.0, 94.0), false);

  // When job moves to 'encoded', it no longer protects the segment!
  repo.updateClipJobStatus('job_active_1', 'encoded');
  assert.equal(repo.isSegmentProtected('sess_evict', 92.0, 94.0), false);

  // Filter evictable segments list
  repo.updateClipJobStatus('job_active_1', 'cutting'); // re-activate
  const candidates = [
    { file: 'seg_00040.ts', start_t: 80.0, end_t: 82.0 },
    { file: 'seg_00046.ts', start_t: 92.0, end_t: 94.0 }, // protected
    { file: 'seg_00055.ts', start_t: 110.0, end_t: 112.0 }
  ];
  const evictable = repo.getEvictableSegments('sess_evict', candidates);
  assert.equal(evictable.length, 2);
  assert.deepEqual(evictable.map((e) => e.file), ['seg_00040.ts', 'seg_00055.ts']);
});
