import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@clipforge/shared';
import {
  IngestManager,
  getBackoffDelay,
  DEFAULT_BACKOFF_SCHEDULE,
  IngestState
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpBase = path.join(__dirname, '..', '..', '..', 'storage', 'tmp-test-ingest');

function waitForState(
  manager: IngestManager,
  targetState: IngestState,
  timeoutMs = 10000
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (manager.getState() === targetState) return resolve();
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for state ${targetState}; current: ${manager.getState()}`));
    }, timeoutMs);
    const handler = (state: IngestState) => {
      if (state === targetState) {
        clearTimeout(timer);
        manager.off('stateChange', handler);
        resolve();
      }
    };
    manager.on('stateChange', handler);
  });
}

function cleanTmp(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup race
  }
}

test('getBackoffDelay follows exponential schedule and caps at 30s per ADR-001', () => {
  assert.equal(getBackoffDelay(0), 1000);
  assert.equal(getBackoffDelay(1), 2000);
  assert.equal(getBackoffDelay(2), 4000);
  assert.equal(getBackoffDelay(3), 8000);
  assert.equal(getBackoffDelay(4), 16000);
  assert.equal(getBackoffDelay(5), 30000);
  assert.equal(getBackoffDelay(6), 30000);
  assert.equal(getBackoffDelay(100), 30000);

  // Custom schedule
  const custom = [50, 100, 200];
  assert.equal(getBackoffDelay(0, custom), 50);
  assert.equal(getBackoffDelay(1, custom), 100);
  assert.equal(getBackoffDelay(2, custom), 200);
  assert.equal(getBackoffDelay(5, custom), 200);
});

test('IngestManager tracks state and persists session status in SQLite database', async () => {
  const { repo } = createDatabase(':memory:');
  const bufferDir = path.join(tmpBase, 'session-db-test');
  cleanTmp(bufferDir);

  const manager = new IngestManager({
    streamUrl: 'nonexistent_test_stream.ts',
    sessionId: 'sess_ingest_db',
    sourceLabel: 'gamer',
    sourceDomain: 'twitch.tv',
    channelSlug: 'gamer',
    bufferDir,
    backoffSchedule: [50, 100],
    db: repo
  });

  assert.equal(manager.getState(), 'idle');

  // Start manager
  await manager.start();

  // Session row should be created in DB with active status
  const session = repo.getSession('sess_ingest_db');
  assert.ok(session);
  assert.equal(session.id, 'sess_ingest_db');
  assert.equal(session.status, 'active');
  assert.equal(session.source_domain, 'twitch.tv');

  // Stop manager
  await manager.stop();

  assert.equal(manager.getState(), 'stopped');
  const updatedSession = repo.getSession('sess_ingest_db');
  assert.equal(updatedSession?.status, 'ended');
  assert.ok(updatedSession?.ended_at);

  cleanTmp(bufferDir);
});

test('IngestManager handles unexpected process termination with backoff schedule', async () => {
  const bufferDir = path.join(tmpBase, 'session-backoff-test');
  cleanTmp(bufferDir);

  const reconnectEvents: Array<{ attempt: number; delay: number }> = [];

  const manager = new IngestManager({
    streamUrl: 'nonexistent_test_stream.ts',
    sessionId: 'sess_backoff',
    sourceLabel: 'gamer',
    sourceDomain: 'twitch.tv',
    channelSlug: 'gamer',
    bufferDir,
    backoffSchedule: [50, 100, 200]
  });

  manager.on('reconnect', (attempt, delay) => {
    reconnectEvents.push({ attempt, delay });
  });

  try {
    await manager.start();

    // Wait for at least 2 reconnect attempts
    await new Promise<void>((resolve) => {
      const check = () => {
        if (reconnectEvents.length >= 2) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    assert.equal(manager.getState(), 'reconnecting');
    assert.ok(reconnectEvents.length >= 2);
    assert.equal(reconnectEvents[0].attempt, 1);
    assert.equal(reconnectEvents[0].delay, 50);
    assert.equal(reconnectEvents[1].attempt, 2);
    assert.equal(reconnectEvents[1].delay, 100);
  } finally {
    await manager.stop();
    assert.equal(manager.getState(), 'stopped');
    cleanTmp(bufferDir);
  }
});

test('IngestManager enforces hard termination limit after prolonged disconnect', async () => {
  const { repo } = createDatabase(':memory:');
  const bufferDir = path.join(tmpBase, 'session-hard-term');
  cleanTmp(bufferDir);

  const manager = new IngestManager({
    streamUrl: 'nonexistent_test_stream.ts',
    sessionId: 'sess_hard_term',
    sourceLabel: 'gamer',
    sourceDomain: 'twitch.tv',
    channelSlug: 'gamer',
    bufferDir,
    backoffSchedule: [20, 20],
    maxDisconnectTimeMs: 150, // 150ms hard ceiling
    db: repo
  });

  let errorEmitted = false;
  manager.on('error', () => {
    errorEmitted = true;
  });

  try {
    await manager.start();

    // Wait for hard termination
    await new Promise<void>((resolve) => {
      const check = () => {
        if (manager.getState() === 'error') {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    assert.equal(manager.getState(), 'error');
    assert.equal(errorEmitted, true);
    const session = repo.getSession('sess_hard_term');
    assert.equal(session?.status, 'error');
  } finally {
    await manager.stop();
    cleanTmp(bufferDir);
  }
});

test('Integration: local HLS stream reconnects cleanly after forced network disconnect', async () => {
  const sourceHlsDir = path.join(tmpBase, 'hls_source');
  const targetBufferDir = path.join(tmpBase, 'hls_target_buffer');
  cleanTmp(sourceHlsDir);
  cleanTmp(targetBufferDir);

  fs.mkdirSync(sourceHlsDir, { recursive: true });
  fs.mkdirSync(targetBufferDir, { recursive: true });

  // 1. Generate 30s synthetic HLS stream in sourceHlsDir
  const playlistFile = path.join(sourceHlsDir, 'live.m3u8');
  const segmentPattern = path.join(sourceHlsDir, 'source_%03d.ts');
  const genCmd = [
    'ffmpeg',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=320x240:rate=10',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440',
    '-t', '30',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_segment_filename', `"${segmentPattern}"`,
    `"${playlistFile}"`
  ].join(' ');

  execSync(genCmd, { stdio: 'ignore' });
  assert.ok(fs.existsSync(playlistFile), 'Source HLS playlist must be generated');

  // 2. Start controllable local HTTP server to serve the HLS stream
  let serverActive = true;
  const sockets = new Set<any>();

  const server = http.createServer((req, res) => {
    if (!serverActive) {
      res.writeHead(503);
      res.end('Disconnected');
      return;
    }

    const reqPath = req.url?.replace(/^\//, '') || 'live.m3u8';
    const filePath = path.join(sourceHlsDir, reqPath);

    if (fs.existsSync(filePath)) {
      const isM3u8 = filePath.endsWith('.m3u8');
      res.writeHead(200, {
        'Content-Type': isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as any).port;
  const streamUrl = `http://127.0.0.1:${port}/live.m3u8`;

  const { repo } = createDatabase(':memory:');
  const stateTransitions: IngestState[] = [];
  let reconnectCount = 0;

  const manager = new IngestManager({
    streamUrl,
    sessionId: 'sess_hls_integration',
    sourceLabel: 'test-stream',
    sourceDomain: 'local',
    channelSlug: 'test',
    bufferDir: targetBufferDir,
    backoffSchedule: [200, 400, 800],
    db: repo,
    onStateChange: (newState) => {
      stateTransitions.push(newState);
    }
  });

  manager.on('reconnect', () => {
    reconnectCount++;
  });

  try {
    // 3. Start ingest
    await manager.start();

    // Wait for ingest to transition to running
    await waitForState(manager, 'running', 8000);
    assert.equal(manager.getState(), 'running');

    // 4. Force disconnect: disable server response and destroy active sockets
    serverActive = false;
    for (const sock of sockets) {
      sock.destroy();
    }

    // 5. Ingest should detect disconnect and enter 'reconnecting'
    await waitForState(manager, 'reconnecting', 8000);
    assert.equal(manager.getState(), 'reconnecting');
    assert.ok(reconnectCount >= 1, 'Reconnect event should be triggered');

    // 6. Restore server after short outage
    serverActive = true;

    // 7. Ingest should reconnect and transition back to running within backoff schedule
    await waitForState(manager, 'running', 8000);
    assert.equal(manager.getState(), 'running');
    assert.ok(stateTransitions.includes('reconnecting'));
    assert.ok(stateTransitions.includes('running'));
  } finally {
    // 8. Clean shutdown
    await manager.stop();
    assert.equal(manager.getState(), 'stopped');

    // Close HTTP server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const sock of sockets) {
        sock.destroy();
      }
    });

    // Clean up
    cleanTmp(sourceHlsDir);
    cleanTmp(targetBufferDir);
  }
});
