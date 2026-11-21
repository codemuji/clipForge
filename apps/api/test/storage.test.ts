import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStorageTree, getRevealCommand, revealInExplorer } from '../src/storage.js';
import { createApp } from '../src/app.js';

test('buildStorageTree: correctly reflects disk hierarchy, file sizes, and stats on temp directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-storage-test-'));

  try {
    // Create nested directory structure matching storage layout
    // storage/clips/twitch.tv/my-channel/2026-11-20/
    const clipsDir = path.join(tmpDir, 'clips', 'twitch.tv', 'my-channel', '2026-11-20');
    fs.mkdirSync(clipsDir, { recursive: true });

    // storage/buffer/session-01/
    const bufferDir = path.join(tmpDir, 'buffer', 'session-01');
    fs.mkdirSync(bufferDir, { recursive: true });

    // storage/db/
    const dbDir = path.join(tmpDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });

    // storage/empty-folder/
    const emptyDir = path.join(tmpDir, 'empty-folder');
    fs.mkdirSync(emptyDir, { recursive: true });

    // Write files
    fs.writeFileSync(path.join(clipsDir, 'clip_01.mp4'), 'mp4-video-content-sample');
    fs.writeFileSync(path.join(clipsDir, 'clip_01.json'), JSON.stringify({ schema: 'clipforge.clip.v1' }));
    fs.writeFileSync(path.join(bufferDir, 'segment_001.ts'), 'ts-video-segment-payload');
    fs.writeFileSync(path.join(dbDir, 'clipforge.sqlite'), 'sqlite-db-mock-header');

    const result = buildStorageTree(tmpDir);

    // Verify stats
    assert.equal(result.stats.total_files, 4, 'Should count exactly 4 files');
    assert.ok(result.stats.total_directories >= 6, 'Should count directories correctly');
    assert.ok(result.stats.total_bytes > 0, 'Total bytes should be > 0');

    // Verify tree root
    assert.equal(result.tree.type, 'directory');
    assert.ok(Array.isArray(result.tree.children), 'Root should have children');

    // Verify directory sorting: buffer, clips, db, empty-folder
    const childNames = result.tree.children?.map((c) => c.name);
    assert.ok(childNames?.includes('buffer'));
    assert.ok(childNames?.includes('clips'));
    assert.ok(childNames?.includes('db'));
    assert.ok(childNames?.includes('empty-folder'));

    // Check clips node navigation
    const clipsNode = result.tree.children?.find((c) => c.name === 'clips');
    assert.ok(clipsNode && clipsNode.type === 'directory');

    // Check file node properties
    const twitchNode = clipsNode?.children?.find((c) => c.name === 'twitch.tv');
    const channelNode = twitchNode?.children?.find((c) => c.name === 'my-channel');
    const dateNode = channelNode?.children?.find((c) => c.name === '2026-11-20');
    const mp4Node = dateNode?.children?.find((c) => c.name === 'clip_01.mp4');

    assert.ok(mp4Node, 'clip_01.mp4 node exists');
    assert.equal(mp4Node?.type, 'file');
    assert.equal(mp4Node?.extension, '.mp4');
    assert.ok(mp4Node?.size_bytes && mp4Node.size_bytes > 0);
    assert.ok(mp4Node?.modified_at, 'Has ISO modified timestamp');

    // Test subpath querying
    const subResult = buildStorageTree(tmpDir, 'clips/twitch.tv');
    assert.equal(subResult.tree.name, 'twitch.tv');
    assert.equal(subResult.stats.total_files, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildStorageTree: rejects path traversal outside storage root', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-traversal-test-'));
  try {
    assert.throws(
      () => buildStorageTree(tmpDir, '../outside'),
      /path traversal outside storage directory/i
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getRevealCommand: returns expected OS commands for Windows, Linux, and macOS', () => {
  const sampleFilePath = path.join('storage', 'clips', 'sample.mp4');
  const sampleDirPath = path.join('storage', 'clips');

  // win32
  const winFile = getRevealCommand(sampleFilePath, 'win32', false);
  assert.equal(winFile.command, 'explorer.exe');
  assert.equal(winFile.args[0], `/select,${path.normalize(sampleFilePath)}`);

  const winDir = getRevealCommand(sampleDirPath, 'win32', true);
  assert.equal(winDir.command, 'explorer.exe');
  assert.equal(winDir.args[0], path.normalize(sampleDirPath));

  // linux
  const linuxFile = getRevealCommand(sampleFilePath, 'linux', false);
  assert.equal(linuxFile.command, 'xdg-open');
  assert.equal(linuxFile.args[0], path.dirname(path.normalize(sampleFilePath)));

  const linuxDir = getRevealCommand(sampleDirPath, 'linux', true);
  assert.equal(linuxDir.command, 'xdg-open');
  assert.equal(linuxDir.args[0], path.normalize(sampleDirPath));

  // darwin (macOS)
  const macFile = getRevealCommand(sampleFilePath, 'darwin', false);
  assert.equal(macFile.command, 'open');
  assert.deepEqual(macFile.args, ['-R', path.normalize(sampleFilePath)]);

  const macDir = getRevealCommand(sampleDirPath, 'darwin', true);
  assert.equal(macDir.command, 'open');
  assert.deepEqual(macDir.args, [path.normalize(sampleDirPath)]);
});

test('revealInExplorer: executes reveal callback with verified target and rejects invalid paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-reveal-test-'));

  try {
    const testFile = path.join(tmpDir, 'test.mp4');
    fs.writeFileSync(testFile, 'test');

    let executedCommand = '';
    let executedArgs: string[] = [];

    const result = revealInExplorer(tmpDir, 'test.mp4', {
      platform: 'linux',
      spawnFn: (cmd, args) => {
        executedCommand = cmd;
        executedArgs = args;
      }
    });

    assert.equal(result.success, true);
    assert.equal(executedCommand, 'xdg-open');
    assert.ok(executedArgs.length > 0);

    // Rejection on nonexistent file
    assert.throws(
      () => revealInExplorer(tmpDir, 'nonexistent.mp4'),
      /Target path does not exist/
    );

    // Rejection on path traversal
    assert.throws(
      () => revealInExplorer(tmpDir, '../../etc/passwd'),
      /outside storage directory/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('API endpoints: GET /api/storage/tree and POST /api/storage/reveal', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-api-storage-test-'));

  try {
    const clipsDir = path.join(tmpDir, 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });
    fs.writeFileSync(path.join(clipsDir, 'test_clip.mp4'), 'test-video');

    let mockSpawnCalled = false;
    let mockCommand = '';

    const app = createApp({
      storagePath: tmpDir,
      revealPlatform: 'win32',
      revealExecutor: (cmd) => {
        mockSpawnCalled = true;
        mockCommand = cmd;
      }
    });

    // 1. GET /api/storage/tree
    const treeRes = await app.inject({
      method: 'GET',
      url: '/api/storage/tree'
    });

    assert.equal(treeRes.statusCode, 200);
    const treeData = JSON.parse(treeRes.payload);
    assert.ok(treeData.tree);
    assert.equal(treeData.stats.total_files, 1);
    assert.equal(treeData.tree.children[0].name, 'clips');

    // 2. POST /api/storage/reveal (valid file)
    const revealRes = await app.inject({
      method: 'POST',
      url: '/api/storage/reveal',
      payload: { path: 'clips/test_clip.mp4' }
    });

    assert.equal(revealRes.statusCode, 200);
    const revealData = JSON.parse(revealRes.payload);
    assert.equal(revealData.success, true);
    assert.equal(mockSpawnCalled, true);
    assert.equal(mockCommand, 'explorer.exe');

    // 3. POST /api/storage/reveal (nonexistent file -> 404)
    const notFoundRes = await app.inject({
      method: 'POST',
      url: '/api/storage/reveal',
      payload: { path: 'clips/missing.mp4' }
    });

    assert.equal(notFoundRes.statusCode, 404);
    const notFoundData = JSON.parse(notFoundRes.payload);
    assert.equal(notFoundData.error.code, 'TARGET_NOT_FOUND');

    // 4. POST /api/storage/reveal (traversal -> 400)
    const traversalRes = await app.inject({
      method: 'POST',
      url: '/api/storage/reveal',
      payload: { path: '../outside.txt' }
    });

    assert.equal(traversalRes.statusCode, 400);
    const traversalData = JSON.parse(traversalRes.payload);
    assert.equal(traversalData.error.code, 'STORAGE_REVEAL_ERROR');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
