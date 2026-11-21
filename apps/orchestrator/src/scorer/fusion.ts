import type { ScoringWeights, DetectionEventSignals } from '@clipforge/shared';
import type { SignalFusionResult } from './types.js';

/**
 * Fuses multi-modal detection signals using configured weights.
 * Applies strict weight renormalization over non-null signals per CONTRACTS.md §3.
 * Returns fusedScore = null if all signals are null (acceptance: all-null emits nothing).
 */
export function fuseSignals(
  signals: DetectionEventSignals,
  weights: ScoringWeights
): SignalFusionResult {
  const signalMap: Record<keyof ScoringWeights, number | null | undefined> = {
    audio: signals.audio?.value,
    chat: signals.chat?.value,
    speech_keywords: signals.speech_keywords?.value,
    hud_text: signals.hud_text?.value,
    frame_classifier: signals.frame_classifier?.value
  };

  const activeEntries: Array<{ key: keyof ScoringWeights; value: number; weight: number }> = [];
  let totalActiveWeight = 0;

  for (const [key, val] of Object.entries(signalMap) as Array<[keyof ScoringWeights, number | null | undefined]>) {
    if (typeof val === 'number' && !isNaN(val)) {
      const rawWeight = weights[key] ?? 0;
      if (rawWeight > 0) {
        activeEntries.push({ key, value: val, weight: rawWeight });
        totalActiveWeight += rawWeight;
      }
    }
  }

  // All-null rule: if no signals have non-null values with positive weights, return null
  if (activeEntries.length === 0 || totalActiveWeight <= 0) {
    return {
      fusedScore: null,
      activeWeights: {}
    };
  }

  // Weight renormalization: w'_i = w_i / totalActiveWeight
  const activeWeights: Record<string, number> = {};
  let weightedSum = 0;

  for (const entry of activeEntries) {
    const renormalizedWeight = entry.weight / totalActiveWeight;
    activeWeights[entry.key] = Number(renormalizedWeight.toFixed(4));
    weightedSum += renormalizedWeight * entry.value;
  }

  const fusedScore = Number(Math.min(1.0, Math.max(0.0, weightedSum)).toFixed(4));

  return {
    fusedScore,
    activeWeights
  };
}
