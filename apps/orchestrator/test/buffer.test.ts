import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@clipforge/shared';
import {
  BufferManager,
  parseSegmentFilename,
  listBufferSegments,
  findOverlappingSegments,
  BufferSegment
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpBase = path.join(__dirname, '..', '..', '..', 'storage', 'tmp-test-buffer');

function cleanTmp(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup race
  }
}

function createDummySegments(bufferDir: string, count: number, sizeBytes = 1024): void {
  fs.mkdirSync(bufferDir, { recursive: true });
  const dummyData = Buffer.alloc(sizeBytes, 'x');
  for (let i = 0; i < count; i++) {
    const filename = `seg_${String(i).padStart(5, '0')}.ts`;
    fs.writeFileSync(path.join(bufferDir, filename), dummyData);
  }
}

test('parseSegmentFilename extracts monotonic indexes and time windows', () => {
  assert.deepEqual(parseSegmentFilename('seg_00000.ts', 2), {
    index: 0,
    start_t: 0,
    end_t: 2
  });
  assert.deepEqual(parseSegmentFilename('seg_00015.ts', 2), {
    index: 15,
    start_t: 30,
    end_t: 32
  });
  assert.deepEqual(parseSegmentFilename('seg_00042.ts', 5), {
    index: 42,
    start_t: 210,
    end_t: 215
  });
  assert.deepEqual(parseSegmentFilename('123.ts', 2), {
    index: 123,
    start_t: 246,
    end_t: 248
  });
  assert.equal(parseSegmentFilename('live.m3u8', 2), null);
  assert.equal(parseSegmentFilename('seg_00001.ts.tmp', 2), null);
});

test('findOverlappingSegments accurately returns segments intersecting target window', () => {
  const segments: BufferSegment[] = [
    { file: 'seg_00000.ts', path: '', index: 0, start_t: 0, end_t: 2, sizeBytes: 100, mtimeMs: 0 },
    { file: 'seg_00001.ts', path: '', index: 1, start_t: 2, end_t: 4, sizeBytes: 100, mtimeMs: 0 },
    { file: 'seg_00002.ts', path: '', index: 2, start_t: 4, end_t: 6, sizeBytes: 100, mtimeMs: 0 },
    { file: 'seg_00003.ts', path: '', index: 3, start_t: 6, end_t: 8, sizeBytes: 100, mtimeMs: 0 },
    { file: 'seg_00004.ts', path: '', index: 4, start_t: 8, end_t: 10, sizeBytes: 100, mtimeMs: 0 }
  ];

  // Window [3.0, 7.0] intersects segments 1 ([2,4]), 2 ([4,6]), and 3 ([6,8])
  const overlap1 = findOverlappingSegments(segments, 3.0, 7.0);
  assert.equal(overlap1.length, 3);
  assert.deepEqual(overlap1.map((s) => s.file), ['seg_00001.ts', 'seg_00002.ts', 'seg_00003.ts']);

  // Exact boundary [0.0, 2.0] returns only seg 0
  const overlap2 = findOverlappingSegments(segments, 0.0, 2.0);
  assert.equal(overlap2.length, 1);
  assert.equal(overlap2[0].file, 'seg_00000.ts');

  // Point intersection at boundary [4.0, 4.0] returns empty
  const overlap3 = findOverlappingSegments(segments, 4.0, 4.0);
  assert.equal(overlap3.length, 0);
});

test('BufferManager: evicts segments older than buffer retention plus margin', () => {
  const bufferDir = path.join(tmpBase, 'evict_retention_test');
  cleanTmp(bufferDir);

  // Create 10 segments of 2s each (span: [0, 20s])
  createDummySegments(bufferDir, 10);

  // Configure: bufferMinutes = 0.1 (6 seconds) + marginSeconds = 2 -> retention 8s
  // Live edge = 20s. Cutoff = 20 - 8 = 12s.
  // Candidates: segments ending <= 12s -> seg 0..5 (ending at 2, 4, 6, 8, 10, 12).
  const manager = new BufferManager({
    bufferDir,
    sessionId: 'sess_retention',
    bufferMinutes: 0.1, // 6s
    marginSeconds: 2,
    segmentSeconds: 2
  });

  const rangeBefore = manager.getBufferRange();
  assert.ok(rangeBefore);
  assert.equal(rangeBefore.segmentCount, 10);
  assert.equal(rangeBefore.duration_s, 20);

  const result = manager.runEvictionSweep();
  assert.equal(result.liveEdgeT, 20);
  assert.equal(result.cutoffT, 12);
  assert.equal(result.candidatesEvaluated, 6);
  assert.equal(result.evictedCount, 6);
  assert.equal(result.protectedCount, 0);

  // Segments 0..5 unlinked, 6..9 remain
  const remaining = listBufferSegments(bufferDir, 2);
  assert.equal(remaining.length, 4);
  assert.deepEqual(remaining.map((s) => s.file), [
    'seg_00006.ts',
    'seg_00007.ts',
    'seg_00008.ts',
    'seg_00009.ts'
  ]);

  cleanTmp(bufferDir);
});

test('BufferManager: protects segments overlapping queued and cutting clip jobs', () => {
  const bufferDir = path.join(tmpBase, 'evict_protect_test');
  cleanTmp(bufferDir);

  // 10 segments: [0, 20s]
  createDummySegments(bufferDir, 10);

  const { repo } = createDatabase(':memory:');
  const sessionId = 'sess_evict_protect';

  repo.createSession({
    id: sessionId,
    source_url: 'https://twitch.tv/gamer',
    source_label: 'gamer',
    source_domain: 'twitch.tv',
    channel_slug: 'gamer',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null
  });

  repo.createDetection({
    id: 'det_01',
    session_id: sessionId,
    source_label: 'gamer',
    source_domain: 'twitch.tv',
    t_stream: 6.0,
    t_wall: '2026-11-20T10:00:06Z',
    fused_score: 0.85,
    signals: '{}',
    status: 'clipped'
  });

  // Create queued clip job covering [4.0, 9.0] -> protects seg 2 ([4,6]), seg 3 ([6,8]), seg 4 ([8,10])
  repo.createClipJob({
    id: 'job_01',
    detection_id: 'det_01',
    session_id: sessionId,
    start_t: 4.0,
    end_t: 9.0,
    status: 'queued',
    output_path: 'clip.mp4',
    error: null,
    created_at: '2026-11-20T10:00:07Z',
    updated_at: '2026-11-20T10:00:07Z'
  });

  // Configure cutoff at 12s (candidates: seg 0..5)
  const manager = new BufferManager({
    bufferDir,
    sessionId,
    bufferMinutes: 0.1, // 6s
    marginSeconds: 2,
    segmentSeconds: 2,
    db: repo
  });

  const result1 = manager.runEvictionSweep();
  // Candidates: seg 0, 1, 2, 3, 4, 5 (6 candidates)
  assert.equal(result1.candidatesEvaluated, 6);
  // Protected: seg 2, 3, 4 (3 protected)
  assert.equal(result1.protectedCount, 3);
  assert.deepEqual(result1.protectedFiles.sort(), ['seg_00002.ts', 'seg_00003.ts', 'seg_00004.ts']);
  // Evicted: seg 0, 1, 5 (3 evicted)
  assert.equal(result1.evictedCount, 3);
  assert.deepEqual(result1.evictedFiles.sort(), ['seg_00000.ts', 'seg_00001.ts', 'seg_00005.ts']);

  // Verify files still on disk
  const filesAfterSweep1 = listBufferSegments(bufferDir, 2).map((s) => s.file);
  assert.ok(filesAfterSweep1.includes('seg_00002.ts'));
  assert.ok(filesAfterSweep1.includes('seg_00003.ts'));
  assert.ok(filesAfterSweep1.includes('seg_00004.ts'));
  assert.ok(!filesAfterSweep1.includes('seg_00000.ts'));
  assert.ok(!filesAfterSweep1.includes('seg_00001.ts'));

  // Move job to 'encoded' (finished)
  repo.updateClipJobStatus('job_01', 'encoded');

  // Second sweep: protected segments are now evictable
  const result2 = manager.runEvictionSweep();
  assert.equal(result2.protectedCount, 0);
  assert.equal(result2.evictedCount, 3);
  assert.deepEqual(result2.evictedFiles.sort(), ['seg_00002.ts', 'seg_00003.ts', 'seg_00004.ts']);

  cleanTmp(bufferDir);
});

test('Acceptance: accelerated 3-minute stream run asserts buffer size and protection', () => {
  const bufferDir = path.join(tmpBase, 'accelerated_3min_stream');
  cleanTmp(bufferDir);

  // 1. Simulate 3-minute stream: 90 segments of 2s each = 180 seconds
  createDummySegments(bufferDir, 90, 2048);

  const { repo } = createDatabase(':memory:');
  const sessionId = 'sess_3min_accel';

  repo.createSession({
    id: sessionId,
    source_url: 'https://twitch.tv/gamer',
    source_label: 'gamer',
    source_domain: 'twitch.tv',
    channel_slug: 'gamer',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null
  });

  repo.createDetection({
    id: 'det_burst_1',
    session_id: sessionId,
    source_label: 'gamer',
    source_domain: 'twitch.tv',
    t_stream: 35.0,
    t_wall: '2026-11-20T10:00:35Z',
    fused_score: 0.91,
    signals: '{}',
    status: 'clipped'
  });

  repo.createDetection({
    id: 'det_burst_2',
    session_id: sessionId,
    source_label: 'gamer',
    source_domain: 'twitch.tv',
    t_stream: 85.0,
    t_wall: '2026-11-20T10:01:25Z',
    fused_score: 0.82,
    signals: '{}',
    status: 'clipped'
  });

  // Clip Job 1: queued [30.0, 48.0] -> covers segments 15 to 24 (10 segments)
  repo.createClipJob({
    id: 'job_burst_1',
    detection_id: 'det_burst_1',
    session_id: sessionId,
    start_t: 30.0,
    end_t: 48.0,
    status: 'queued',
    output_path: 'clip1.mp4',
    error: null,
    created_at: '2026-11-20T10:00:36Z',
    updated_at: '2026-11-20T10:00:36Z'
  });

  // Clip Job 2: cutting [80.0, 94.0] -> covers segments 40 to 47 (8 segments)
  repo.createClipJob({
    id: 'job_burst_2',
    detection_id: 'det_burst_2',
    session_id: sessionId,
    start_t: 80.0,
    end_t: 94.0,
    status: 'cutting',
    output_path: 'clip2.mp4',
    error: null,
    created_at: '2026-11-20T10:01:26Z',
    updated_at: '2026-11-20T10:01:26Z'
  });

  // Target buffer: 1 minute (60s) + 10s margin = 70s retention
  // Live edge = 180s. Cutoff = 180 - 70 = 110s.
  // Candidate segments ending <= 110s: segments 0 to 54 (55 candidates).
  const manager = new BufferManager({
    bufferDir,
    sessionId,
    bufferMinutes: 1, // 60s
    marginSeconds: 10,
    segmentSeconds: 2,
    db: repo
  });

  const rangeBefore = manager.getBufferRange();
  assert.ok(rangeBefore);
  assert.equal(rangeBefore.segmentCount, 90);
  assert.equal(rangeBefore.duration_s, 180);

  const result = manager.runEvictionSweep();
  assert.equal(result.liveEdgeT, 180);
  assert.equal(result.cutoffT, 110);
  assert.equal(result.candidatesEvaluated, 55);

  // Job 1 protects seg 15..23 (9 segments) and Job 2 protects seg 40..46 (7 segments) = 16 protected
  assert.equal(result.protectedCount, 16);
  assert.equal(result.evictedCount, 39);

  // Verify that NONE of the protected segments were deleted
  const remainingFiles = listBufferSegments(bufferDir, 2).map((s) => s.file);

  // Segments covering Job 1 ([30, 48])
  for (let i = 15; i <= 23; i++) {
    const filename = `seg_${String(i).padStart(5, '0')}.ts`;
    assert.ok(remainingFiles.includes(filename), `Protected segment ${filename} must be retained`);
  }

  // Segments covering Job 2 ([80, 94])
  for (let i = 40; i <= 46; i++) {
    const filename = `seg_${String(i).padStart(5, '0')}.ts`;
    assert.ok(remainingFiles.includes(filename), `Protected segment ${filename} must be retained`);
  }

  // Segments after cutoff (> 110s: seg 55 to 89) must all be retained
  for (let i = 55; i <= 89; i++) {
    const filename = `seg_${String(i).padStart(5, '0')}.ts`;
    assert.ok(remainingFiles.includes(filename), `Active segment ${filename} must be retained`);
  }

  // Check disk usage summary
  const usage = manager.getDiskUsage();
  assert.ok(usage.segmentCount > 35);
  assert.ok(usage.totalBytes > 0);

  cleanTmp(bufferDir);
});
