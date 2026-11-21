import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '@clipforge/shared';
import type { ScoringWeights, DetectionEventSignals } from '@clipforge/shared';
import { fuseSignals, HypeScorer } from '../src/index.js';

const TEST_WEIGHTS: ScoringWeights = {
  audio: 0.35,
  chat: 0.25,
  speech_keywords: 0.15,
  hud_text: 0.15,
  frame_classifier: 0.10
};

test('fuseSignals: handles full signals, weight renormalization on nulls, and all-null rule', () => {
  // 1. Full signals: exact weighted sum
  const fullSignals: DetectionEventSignals = {
    audio: { value: 0.8, detail: { lufs: -14.0 } },
    chat: { value: 0.9, detail: { messages: 20 } },
    speech_keywords: { value: 0.5, detail: { matched: ['clutch'] } },
    hud_text: { value: 0.0, detail: { matched: [] } },
    frame_classifier: { value: 0.4, label: 'action' }
  };

  const resFull = fuseSignals(fullSignals, TEST_WEIGHTS);
  // Expected: 0.35*0.8 + 0.25*0.9 + 0.15*0.5 + 0.15*0.0 + 0.10*0.4
  // = 0.28 + 0.225 + 0.075 + 0 + 0.04 = 0.6200
  assert.equal(resFull.fusedScore, 0.62);
  assert.equal(resFull.activeWeights.audio, 0.35);
  assert.equal(resFull.activeWeights.chat, 0.25);
  assert.equal(resFull.activeWeights.frame_classifier, 0.10);

  // 2. Partial signals with nulls: renormalize weights over active non-null subset
  // audio (0.35) and frame_classifier (0.10) active -> total 0.45
  const partialSignals: DetectionEventSignals = {
    audio: { value: 0.8 },
    chat: { value: null },
    speech_keywords: { value: null },
    hud_text: { value: null },
    frame_classifier: { value: 0.5 }
  };

  const resPartial = fuseSignals(partialSignals, TEST_WEIGHTS);
  // Expected: (0.35*0.8 + 0.10*0.5) / 0.45 = (0.28 + 0.05) / 0.45 = 0.33 / 0.45 = 0.7333
  assert.equal(resPartial.fusedScore, 0.7333);
  assert.equal(resPartial.activeWeights.audio, Number((0.35 / 0.45).toFixed(4)));
  assert.equal(resPartial.activeWeights.frame_classifier, Number((0.10 / 0.45).toFixed(4)));
  assert.equal(resPartial.activeWeights.chat, undefined);

  // 3. Single active signal: renormalized weight is 1.0, score equals signal value
  const singleSignal: DetectionEventSignals = {
    audio: { value: 0.85 },
    chat: { value: null },
    speech_keywords: { value: null },
    hud_text: { value: null },
    frame_classifier: { value: null }
  };

  const resSingle = fuseSignals(singleSignal, TEST_WEIGHTS);
  assert.equal(resSingle.fusedScore, 0.85);
  assert.equal(resSingle.activeWeights.audio, 1.0);

  // 4. All-null signals: emits nothing (fusedScore = null)
  const allNullSignals: DetectionEventSignals = {
    audio: { value: null },
    chat: { value: null },
    speech_keywords: { value: null },
    hud_text: { value: null },
    frame_classifier: { value: null }
  };

  const resNull = fuseSignals(allNullSignals, TEST_WEIGHTS);
  assert.equal(resNull.fusedScore, null);
  assert.deepEqual(resNull.activeWeights, {});
});

test('HypeScorer: all-null emits nothing and does not persist to SQLite', () => {
  const { db, repo } = createDatabase(':memory:');

  const scorer = new HypeScorer({
    sessionId: 'sess_null_test',
    sourceLabel: 'my-channel',
    sourceDomain: 'twitch.tv',
    config: {
      threshold: 0.72,
      cooldown_seconds: 45,
      debounce_windows: 2,
      weights: TEST_WEIGHTS
    },
    db: repo
  });

  const res = scorer.score({
    tStream: 10.0,
    signals: {
      audio: { value: null },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });

  assert.equal(res.fusedScore, null);
  assert.equal(res.event, null);
  assert.equal(res.shouldClip, false);
  assert.equal(res.isAboveThreshold, false);
  assert.equal(res.consecutiveAboveThreshold, 0);

  // Verify nothing was inserted into SQLite
  const detections = repo.listDetections({ sessionId: 'sess_null_test' });
  assert.equal(detections.length, 0);
});

test('HypeScorer: enforces debounce timeline across consecutive windows', () => {
  const scorer = new HypeScorer({
    sessionId: 'sess_debounce_test',
    sourceLabel: 'my-channel',
    sourceDomain: 'twitch.tv',
    config: {
      threshold: 0.72,
      cooldown_seconds: 45,
      debounce_windows: 2, // Must stay above threshold for 2 consecutive windows
      weights: TEST_WEIGHTS
    }
  });

  // Window 1: score = 0.75 (above threshold, consecutive = 1 < 2 -> shouldClip = false)
  const w1 = scorer.score({
    tStream: 2.0,
    signals: {
      audio: { value: 0.75 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w1.fusedScore, 0.75);
  assert.equal(w1.isAboveThreshold, true);
  assert.equal(w1.consecutiveAboveThreshold, 1);
  assert.equal(w1.shouldClip, false);

  // Window 2: score = 0.78 (above threshold, consecutive = 2 >= 2 -> debounce met! shouldClip = true)
  const w2 = scorer.score({
    tStream: 4.0,
    signals: {
      audio: { value: 0.78 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w2.fusedScore, 0.78);
  assert.equal(w2.isAboveThreshold, true);
  assert.equal(w2.shouldClip, true, 'Second consecutive above-threshold window must trigger clip');
  assert.equal(scorer.getConsecutiveAboveThreshold(), 0, 'Consecutive counter resets after clip trigger');

  // Window 3: score = 0.60 (drops below threshold -> consecutive = 0, shouldClip = false)
  const w3 = scorer.score({
    tStream: 6.0,
    signals: {
      audio: { value: 0.60 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w3.fusedScore, 0.60);
  assert.equal(w3.isAboveThreshold, false);
  assert.equal(w3.consecutiveAboveThreshold, 0);
  assert.equal(w3.shouldClip, false);

  // Window 4: score = 0.80 (first window above threshold -> consecutive = 1 < 2 -> shouldClip = false)
  const w4 = scorer.score({
    tStream: 8.0,
    signals: {
      audio: { value: 0.80 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w4.fusedScore, 0.80);
  assert.equal(w4.isAboveThreshold, true);
  assert.equal(w4.consecutiveAboveThreshold, 1);
  assert.equal(w4.shouldClip, false);

  // Window 5: drops below threshold again -> reset
  const w5 = scorer.score({
    tStream: 10.0,
    signals: {
      audio: { value: 0.50 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w5.consecutiveAboveThreshold, 0);
  assert.equal(w5.shouldClip, false);
});

test('HypeScorer: enforces cooldown timeline and persists detections to SQLite', () => {
  const { db, repo } = createDatabase(':memory:');

  repo.createSession({
    id: 'sess_cooldown_test',
    source_url: 'https://kick.com/streamer',
    source_label: 'tournament-stream',
    source_domain: 'kick.com',
    channel_slug: 'streamer',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null
  });

  const scorer = new HypeScorer({
    sessionId: 'sess_cooldown_test',
    sourceLabel: 'tournament-stream',
    sourceDomain: 'kick.com',
    config: {
      threshold: 0.70,
      cooldown_seconds: 45.0, // 45s cooldown
      debounce_windows: 1,    // 1 window debounce for clear cooldown timeline
      weights: TEST_WEIGHTS
    },
    db: repo
  });

  // t = 10.0: score = 0.85 -> triggers first clip!
  const w1 = scorer.score({
    tStream: 10.0,
    signals: {
      audio: { value: 0.85 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w1.shouldClip, true);
  assert.equal(w1.inCooldown, false);
  assert.equal(scorer.getLastTriggeredTStream(), 10.0);
  assert.equal(scorer.isInCooldown(10.0), true);

  // t = 12.0: score = 0.95 -> in cooldown (12.0 < 10.0 + 45.0 = 55.0) -> shouldClip = false
  const w2 = scorer.score({
    tStream: 12.0,
    signals: {
      audio: { value: 0.95 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w2.isAboveThreshold, true);
  assert.equal(w2.inCooldown, true);
  assert.equal(w2.shouldClip, false, 'Score during cooldown must NOT trigger clip');
  assert.equal(w2.event !== null, true, 'Event is still scored and recorded');

  // t = 30.0: score = 0.90 -> still in cooldown (remaining = 55 - 30 = 25s)
  const w3 = scorer.score({
    tStream: 30.0,
    signals: {
      audio: { value: 0.90 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w3.inCooldown, true);
  assert.equal(w3.shouldClip, false);
  assert.equal(scorer.getCooldownRemaining(30.0), 25.0);

  // t = 54.9: score = 0.80 -> 0.1s before cooldown expires -> still in cooldown!
  const w4 = scorer.score({
    tStream: 54.9,
    signals: {
      audio: { value: 0.80 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w4.inCooldown, true);
  assert.equal(w4.shouldClip, false);

  // t = 55.0: score = 0.75 -> cooldown has expired (55.0 >= 55.0) -> triggers new clip!
  const w5 = scorer.score({
    tStream: 55.0,
    signals: {
      audio: { value: 0.75 },
      chat: { value: null },
      speech_keywords: { value: null },
      hud_text: { value: null },
      frame_classifier: { value: null }
    }
  });
  assert.equal(w5.inCooldown, false);
  assert.equal(w5.shouldClip, true, 'Threshold crossing after cooldown expires must trigger clip');
  assert.equal(scorer.getLastTriggeredTStream(), 55.0);

  // Verify SQLite persisted all 5 scored detections
  const dbDetections = repo.listDetections({ sessionId: 'sess_cooldown_test' });
  assert.equal(dbDetections.length, 5);
  assert.equal(dbDetections[0].t_stream, 10.0);
  assert.equal(dbDetections[0].status, 'scored');
  assert.equal(dbDetections[4].t_stream, 55.0);
});
