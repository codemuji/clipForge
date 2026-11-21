"""Unit and fixture tests for B-02 Audio signal extractor."""

import os
import subprocess
import tempfile
import wave
from pathlib import Path
import numpy as np
import pytest
import soundfile as sf

from workers.detector.src.audio import AudioSignalExtractor, SessionAudioState

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
FIXTURES_DIR = REPO_ROOT / "fixtures"


def create_sine_wav(path: str, duration_s: float = 5.0, freq: float = 440.0, amplitude: float = 0.5, sr: int = 16000):
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False, dtype=np.float32)
    samples = amplitude * np.sin(2 * np.pi * freq * t)
    sf.write(path, samples, sr, format="WAV", subtype="PCM_16")


# ========================================================
# 1. UNIT TESTS ON SYNTHETIC SIGNALS
# ========================================================

def test_audio_extractor_missing_file():
    extractor = AudioSignalExtractor()
    sig = extractor.extract("/nonexistent/file.wav", session_id="s1")
    assert sig.value is None
    assert sig.detail is None


def test_audio_extractor_empty_file():
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        empty_path = f.name
    try:
        extractor = AudioSignalExtractor()
        sig = extractor.extract(empty_path, session_id="s1")
        assert sig.value is None
    finally:
        if Path(empty_path).exists():
            Path(empty_path).unlink()


def test_audio_extractor_synthetic_signals():
    extractor = AudioSignalExtractor()
    session_id = "test_synthetic_session"

    with tempfile.TemporaryDirectory() as td:
        quiet_path = os.path.join(td, "quiet.wav")
        loud_path = os.path.join(td, "loud.wav")

        # 1. Quiet baseline: amplitude 0.002 (~ -54 dBFS)
        create_sine_wav(quiet_path, duration_s=5.0, amplitude=0.002)
        # 2. Loud burst: amplitude 0.8 (~ -2 dBFS)
        create_sine_wav(loud_path, duration_s=5.0, amplitude=0.8)

        # First quiet window establishes baseline
        q_sig1 = extractor.extract(quiet_path, session_id=session_id)
        assert q_sig1.value is not None
        assert q_sig1.value < 0.3, f"Quiet window must score < 0.3, got {q_sig1.value}"
        assert q_sig1.detail is not None
        assert q_sig1.detail.lufs < -45.0
        assert q_sig1.detail.lufs_delta == 0.0

        # Second quiet window maintains low score
        q_sig2 = extractor.extract(quiet_path, session_id=session_id)
        assert q_sig2.value < 0.3

        # Sudden loud burst window
        l_sig = extractor.extract(loud_path, session_id=session_id)
        assert l_sig.value is not None
        assert l_sig.value > 0.7, f"Loud burst must score > 0.7, got {l_sig.value}"
        assert l_sig.detail is not None
        assert l_sig.detail.lufs > -10.0
        assert l_sig.detail.lufs_delta > 20.0


def test_audio_baseline_resets_on_session_start():
    extractor = AudioSignalExtractor()

    with tempfile.TemporaryDirectory() as td:
        quiet_path = os.path.join(td, "quiet.wav")
        loud_path = os.path.join(td, "loud.wav")
        create_sine_wav(quiet_path, duration_s=5.0, amplitude=0.002)
        create_sine_wav(loud_path, duration_s=5.0, amplitude=0.8)

        # Run session A with quiet baseline then loud burst
        extractor.extract(quiet_path, session_id="session_A")
        sig_a_loud = extractor.extract(loud_path, session_id="session_A")
        assert sig_a_loud.value > 0.7

        # Session B starts fresh: baseline resets
        assert "session_B" not in extractor._sessions
        sig_b_quiet = extractor.extract(quiet_path, session_id="session_B")
        assert "session_B" in extractor._sessions
        assert sig_b_quiet.value < 0.3
        assert sig_b_quiet.detail.lufs_delta == 0.0

        # Explicit reset of session A
        extractor.reset_session("session_A")
        assert "session_A" not in extractor._sessions


# ========================================================
# 2. FIXTURE TESTS
# ========================================================

def extract_fixture_wav(mp4_path: Path, start_s: float, duration_s: float, out_path: str):
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(start_s),
            "-t", str(duration_s),
            "-i", str(mp4_path),
            "-ar", "16000",
            "-ac", "1",
            out_path,
        ],
        check=True,
        capture_output=True,
    )


def test_fixture_quiet_session_scores():
    """All windows of quiet_session.mp4 must score below 0.3."""
    mp4_path = FIXTURES_DIR / "quiet_session.mp4"
    if not mp4_path.exists():
        pytest.skip("quiet_session.mp4 fixture missing")

    extractor = AudioSignalExtractor()
    session_id = "quiet_fixture_session"

    with tempfile.TemporaryDirectory() as td:
        for t in [0.0, 10.0, 25.0, 40.0]:
            chunk_path = os.path.join(td, f"q_{int(t)}.wav")
            extract_fixture_wav(mp4_path, start_s=t, duration_s=5.0, out_path=chunk_path)
            sig = extractor.extract(chunk_path, session_id=session_id)
            assert sig.value is not None
            assert sig.value < 0.3, f"quiet_session at t={t}s scored {sig.value} (expected < 0.3)"


def test_fixture_loud_burst_scores():
    """loud_burst.mp4: quiet baseline scores < 0.3; burst (t=25-35s) scores > 0.7."""
    mp4_path = FIXTURES_DIR / "loud_burst.mp4"
    if not mp4_path.exists():
        pytest.skip("loud_burst.mp4 fixture missing")

    extractor = AudioSignalExtractor()
    session_id = "loud_fixture_session"

    with tempfile.TemporaryDirectory() as td:
        # Pre-burst quiet window (t=10s)
        pre_path = os.path.join(td, "pre_burst.wav")
        extract_fixture_wav(mp4_path, start_s=10.0, duration_s=5.0, out_path=pre_path)
        pre_sig = extractor.extract(pre_path, session_id=session_id)
        assert pre_sig.value is not None
        assert pre_sig.value < 0.3, f"Pre-burst at t=10s scored {pre_sig.value} (expected < 0.3)"

        # Burst window (t=28s, peak energy)
        burst_path = os.path.join(td, "burst.wav")
        extract_fixture_wav(mp4_path, start_s=28.0, duration_s=5.0, out_path=burst_path)
        burst_sig = extractor.extract(burst_path, session_id=session_id)
        assert burst_sig.value is not None
        assert burst_sig.value > 0.7, f"Loud burst at t=28s scored {burst_sig.value} (expected > 0.7)"
        assert burst_sig.detail.lufs_delta > 15.0


def test_fixture_hud_overlay_audio_scores():
    """hud_overlay.mp4: low-level constant tone scores below 0.3 throughout."""
    mp4_path = FIXTURES_DIR / "hud_overlay.mp4"
    if not mp4_path.exists():
        pytest.skip("hud_overlay.mp4 fixture missing")

    extractor = AudioSignalExtractor()
    session_id = "hud_fixture_session"

    with tempfile.TemporaryDirectory() as td:
        for t in [5.0, 22.0, 35.0]:
            chunk_path = os.path.join(td, f"hud_{int(t)}.wav")
            extract_fixture_wav(mp4_path, start_s=t, duration_s=5.0, out_path=chunk_path)
            sig = extractor.extract(chunk_path, session_id=session_id)
            assert sig.value is not None
            assert sig.value < 0.3, f"hud_overlay audio at t={t}s scored {sig.value} (expected < 0.3)"
