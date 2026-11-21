import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ChatSignalAdapter } from '../src/index.js';

test('ChatSignalAdapter: disabled by default and returns null signal', () => {
  // Default configuration: enabled is omitted -> must default to false
  const adapter = new ChatSignalAdapter();
  assert.equal(adapter.isEnabled(), false);
  assert.equal(adapter.config.platform, 'none');

  // getCounts when disabled returns zero counts
  const counts = adapter.getCounts(0, 10);
  assert.deepEqual(counts, { messages_in_window: 0, unique_chatters: 0 });

  // computeSignal when disabled returns null value per CONTRACTS §3
  const signal = adapter.computeSignal(0, 10);
  assert.equal(signal.value, null);

  // Recording events when disabled is rejected
  const recorded = adapter.recordEvent(1.0, 'alice');
  assert.equal(recorded, false);
  assert.equal(adapter.getInMemoryEventCount(), 0);
});

test('ChatSignalAdapter: aggregates counts from fixture log file', () => {
  const adapter = new ChatSignalAdapter({
    enabled: true,
    platform: 'mock',
    baselineVelocity: 2.0,
    baselineWindowSeconds: 120.0
  });

  assert.equal(adapter.isEnabled(), true);

  const fixturePath = path.resolve('fixtures', 'chat_fixture.txt');
  const count = adapter.loadFixtureLog(fixturePath);
  assert.equal(count, 23, 'Must ingest all 23 message lines from fixture');

  // Window 1: Initial quiet period [0.0, 5.0] (5s window)
  // Contains 5 messages at t = 1.0, 1.5, 2.0, 3.5, 4.0 from 4 chatters (alpha, beta, gamma, delta)
  const stats1 = adapter.getWindowStats(0.0, 5.0);
  assert.equal(stats1.messages_in_window, 5);
  assert.equal(stats1.unique_chatters, 4);
  assert.equal(stats1.velocity, 1.0); // 5 msgs / 5s = 1.0 msg/s

  const signal1 = adapter.computeSignal(0.0, 5.0);
  assert.ok(signal1.value !== null && signal1.value > 0);
  assert.equal(signal1.detail?.messages, 5);
  assert.equal(signal1.detail?.velocity, 1.0);

  // Window 2: Quiet lull [5.0, 24.0] (19s window)
  // Contains 2 messages at t = 10.0 (alpha) and t = 20.0 (beta)
  const stats2 = adapter.getWindowStats(5.0, 24.0);
  assert.equal(stats2.messages_in_window, 2);
  assert.equal(stats2.unique_chatters, 2);
  assert.equal(stats2.velocity, 0.11); // 2 / 19 = 0.11

  // Window 3: Hype burst [25.0, 30.0] (5s window)
  // Contains 14 messages (t=25.0 to 30.0) from 11 unique chatters
  const stats3 = adapter.getWindowStats(25.0, 30.0);
  assert.equal(stats3.messages_in_window, 14);
  assert.equal(stats3.unique_chatters, 11);
  assert.equal(stats3.velocity, 2.8); // 14 / 5 = 2.8 msgs/s

  const signal3 = adapter.computeSignal(25.0, 30.0);
  assert.ok(signal3.value !== null);
  assert.ok(signal3.value > 0.65, `Burst hype score (${signal3.value}) must be > 0.65`);
  assert.ok(signal3.value > (signal1.value ?? 0), 'Burst hype score must be higher than baseline');
  assert.equal(signal3.detail?.messages, 14);
  assert.equal(signal3.detail?.velocity, 2.8);

  // Window 4: Empty window [31.0, 44.0]
  const stats4 = adapter.getWindowStats(31.0, 44.0);
  assert.equal(stats4.messages_in_window, 0);
  assert.equal(stats4.unique_chatters, 0);
  assert.equal(stats4.velocity, 0);
  const signal4 = adapter.computeSignal(31.0, 44.0);
  assert.equal(signal4.value, 0.0);
});

test('ChatSignalAdapter: enforces zero raw message or username storage', () => {
  const adapter = new ChatSignalAdapter({ enabled: true });

  const rawUser = 'SuperSecretUser123';
  const rawText = 'This is confidential secret text that must not be stored';
  const logLine = `[12.5] ${rawUser}: ${rawText}`;

  adapter.parseLogContent(logLine);
  assert.equal(adapter.getInMemoryEventCount(), 1);

  // Inspect internal serialized representation
  const serialized = JSON.stringify(adapter);
  assert.equal(serialized.includes(rawText), false, 'Raw message text must never exist in memory or serialization');
  assert.equal(serialized.includes('SuperSecretUser123'), false, 'Usernames must never be stored in event structures');

  // Verify internal event shape
  const internalEvents = (adapter as any).events;
  assert.equal(internalEvents.length, 1);
  const event = internalEvents[0];
  assert.equal(typeof event.t, 'number');
  assert.equal(typeof event.chatterId, 'number');
  assert.equal('text' in event, false);
  assert.equal('message' in event, false);
  assert.equal('user' in event, false);
  assert.equal('username' in event, false);
});

test('ChatSignalAdapter: enforces rate limiting and rolling window pruning', () => {
  const adapter = new ChatSignalAdapter({
    enabled: true,
    maxEventsPerMinute: 5, // Strict limit for test
    baselineWindowSeconds: 10.0 // 10s retention window
  });

  // 1. Ingest 5 events within 1 minute
  for (let i = 1; i <= 5; i++) {
    const ok = adapter.recordEvent(1.0 + i * 0.1, `user_${i}`);
    assert.equal(ok, true);
  }

  // 6th event within the minute exceeds limit -> dropped
  const dropped = adapter.recordEvent(1.6, 'user_excess');
  assert.equal(dropped, false, 'Event exceeding rate limit must be dropped');

  // Advance time past 60s rate limit window and 10s baseline window to trigger eviction
  // Record event at t = 70.0 (past 60s rate-limit window)
  const okLater = adapter.recordEvent(70.0, 'user_late');
  assert.equal(okLater, true);

  // Events from t = 1.x are older than 70.0 - 10.0 = 60.0, so they must be pruned
  assert.equal(adapter.getInMemoryEventCount(), 1);
  const remainingStats = adapter.getWindowStats(0, 5);
  assert.equal(remainingStats.messages_in_window, 0, 'Pruned events must no longer appear in window stats');
});
