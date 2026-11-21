"""Audio energy, LUFS loudness, and rolling baseline extraction."""

from dataclasses import dataclass, field
import os
from pathlib import Path
from typing import Dict, Optional
import numpy as np
import soundfile as sf

from .schemas import AudioDetail, AudioSignal


@dataclass
class SessionAudioState:
    baseline_lufs: Optional[float] = None
    window_count: int = 0


class AudioSignalExtractor:
    """Extracts loudness (LUFS proxy), short-term delta, and normalized audio score [0, 1].
    
    Maintains a rolling baseline per session_id that resets on session start.
    """

    def __init__(self) -> None:
        self._sessions: Dict[str, SessionAudioState] = {}

    def reset_session(self, session_id: str) -> None:
        """Explicitly resets rolling baseline state for a session."""
        self._sessions.pop(session_id, None)

    def reset_all(self) -> None:
        """Clears all session baselines."""
        self._sessions.clear()

    def compute_lufs(self, samples: np.ndarray) -> float:
        """Computes calibrated LUFS / dBFS loudness from audio sample array."""
        if len(samples) == 0:
            return -100.0
        mean_sq = float(np.mean(samples ** 2))
        if mean_sq <= 1e-12:
            return -100.0
        # Standard RMS energy with BS.1770 -0.69 calibration offset
        return float(10.0 * np.log10(mean_sq) - 0.69)

    def compute_score(self, current_lufs: float, baseline_lufs: float) -> tuple[float, float]:
        """Fuses absolute loudness and relative baseline delta into a [0, 1] hype score."""
        lufs_delta = max(0.0, current_lufs - baseline_lufs)

        # 1. Absolute level component: quiet (-50 LUFS) to loud broadcast (-15 LUFS) -> [0.0, 0.5]
        abs_score = float(np.clip((current_lufs - (-50.0)) / 35.0, 0.0, 1.0) * 0.5)

        # 2. Relative jump component: +0 dB to +18 dB delta -> [0.0, 0.5]
        delta_score = float(np.clip(lufs_delta / 18.0, 0.0, 1.0) * 0.5)

        score = float(np.clip(abs_score + delta_score, 0.0, 1.0))
        return score, lufs_delta

    def extract(self, audio_path: str, session_id: str, sample_rate: int = 16000) -> AudioSignal:
        """Reads audio WAV and computes normalized audio hype signal and details."""
        if not audio_path or not Path(audio_path).is_file():
            return AudioSignal(value=None)

        try:
            data, sr = sf.read(audio_path, dtype="float32")
        except Exception:
            # Corrupted or unreadable audio file
            return AudioSignal(value=None)

        if data.size == 0:
            return AudioSignal(value=None)

        # Flatten multi-channel audio to mono
        if data.ndim > 1:
            data = np.mean(data, axis=1)

        current_lufs = self.compute_lufs(data)

        # Session baseline tracking
        if session_id not in self._sessions:
            # Baseline resets on session start
            # Clamp initial baseline so a loud stream start doesn't anchor baseline high
            state = SessionAudioState(
                baseline_lufs=min(current_lufs, -25.0),
                window_count=1,
            )
            self._sessions[session_id] = state
        else:
            state = self._sessions[session_id]
            state.window_count += 1
            if state.baseline_lufs is None:
                state.baseline_lufs = min(current_lufs, -25.0)
            else:
                # Asymmetric tracking: adapts downward quickly (0.3), upward slowly (0.05)
                if current_lufs < state.baseline_lufs:
                    state.baseline_lufs = 0.3 * current_lufs + 0.7 * state.baseline_lufs
                else:
                    state.baseline_lufs = 0.05 * current_lufs + 0.95 * state.baseline_lufs

        baseline = state.baseline_lufs if state.baseline_lufs is not None else current_lufs
        score, lufs_delta = self.compute_score(current_lufs, baseline)

        return AudioSignal(
            value=round(score, 3),
            detail=AudioDetail(
                lufs=round(current_lufs, 2),
                lufs_delta=round(lufs_delta, 2),
            ),
        )
