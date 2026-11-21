"""Unit and integration tests for B-03 Speech keywords detection and whisper.cpp."""

import os
import tempfile
import time
from pathlib import Path
import pytest
import soundfile as sf

from workers.detector.src.keywords import (
    SpeechKeywordExtractor,
    load_keywords,
    match_keywords,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
TEST_FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
SPEECH_WAV = TEST_FIXTURES_DIR / "clutch_speech.wav"


# ========================================================
# 1. UNIT TESTS: KEYWORD MATCHER
# ========================================================

def test_keyword_matcher_case_insensitivity():
    text = "OMG what a CLUTCH play, that was insane!"
    matched = match_keywords(text, ["clutch", "INSANE", "NoWay"])
    assert "clutch" in matched
    assert "INSANE" in matched
    assert "NoWay" not in matched


def test_keyword_matcher_punctuation():
    text = "Yes!! Let's go! What a shot... GG WP."
    matched = match_keywords(text, ["let's go", "gg", "shot", "ace"])
    assert "let's go" in matched
    assert "gg" in matched
    assert "shot" in matched
    assert "ace" not in matched


def test_keyword_matcher_partial_word_rejection():
    """Partial words inside other words must NOT match."""
    # 'ill' should NOT match 'skill' or 'willing'
    text1 = "He has great skill and is willing to play."
    assert match_keywords(text1, ["ill"]) == []

    # 'win' should NOT match 'window' or 'twin'
    text2 = "Looking out the window at the twin towers."
    assert match_keywords(text2, ["win"]) == []

    # 'ace' should NOT match 'place' or 'trace'
    text3 = "This is a great place to trace."
    assert match_keywords(text3, ["ace"]) == []

    # Exact word 'win' does match
    text4 = "We take the win!"
    assert match_keywords(text4, ["win"]) == ["win"]


def test_keyword_list_empty_by_default():
    """Keyword list must be configurable and empty by default."""
    # When no config file exists, must default to empty list
    nonexistent_path = "/nonexistent/path/keywords.yaml"
    kws = load_keywords(nonexistent_path)
    assert kws == []

    extractor = SpeechKeywordExtractor(keywords_path=nonexistent_path)
    assert extractor.keywords == []


def test_keyword_list_configurable_from_yaml():
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        f.write("keywords:\n  - clutch\n  - ace\n  - 'let us go'\n")
        cfg_path = f.name

    try:
        kws = load_keywords(cfg_path)
        assert kws == ["clutch", "ace", "let us go"]

        extractor = SpeechKeywordExtractor(keywords_path=cfg_path)
        assert extractor.keywords == ["clutch", "ace", "let us go"]
    finally:
        if Path(cfg_path).exists():
            Path(cfg_path).unlink()


# ========================================================
# 2. INTEGRATION TESTS: WHISPER.CPP ON FIXTURE
# ========================================================

def test_whisper_integration_fixture_keyword_detection():
    """Fixture with a known keyword returns a non-zero value and matched keyword."""
    if not SPEECH_WAV.exists():
        pytest.skip("clutch_speech.wav fixture missing")

    extractor = SpeechKeywordExtractor(model_name="base.en-q5_1", n_threads=4)
    # Configure keywords containing the spoken keyword 'clutch'
    extractor.set_keywords(["clutch", "pentakill", "ace"])

    # Transcribe and match
    sig = extractor.extract(str(SPEECH_WAV))
    assert sig.value is not None
    assert sig.value > 0.0, f"Expected non-zero value, got {sig.value}"
    assert sig.detail is not None
    assert "clutch" in sig.detail.matched
    assert "pentakill" not in sig.detail.matched


def test_whisper_integration_fixture_no_keyword_match():
    """Fixture without matching keywords returns value 0.0 and empty matched list."""
    if not SPEECH_WAV.exists():
        pytest.skip("clutch_speech.wav fixture missing")

    extractor = SpeechKeywordExtractor(model_name="base.en-q5_1", n_threads=4)
    extractor.set_keywords(["pentakill", "victory royale"])

    sig = extractor.extract(str(SPEECH_WAV))
    assert sig.value == 0.0
    assert sig.detail is not None
    assert sig.detail.matched == []


def test_whisper_transcription_real_time_factor_budget():
    """Transcription real-time factor must meet ADR-002 budget (RTF < 0.5)."""
    if not SPEECH_WAV.exists():
        pytest.skip("clutch_speech.wav fixture missing")

    info = sf.info(str(SPEECH_WAV))
    audio_duration = info.duration

    extractor = SpeechKeywordExtractor(model_name="base.en-q5_1", n_threads=6)
    extractor.set_keywords(["clutch"])

    # Warmup pass (ensures model load time is not counted in transcription latency)
    extractor.extract(str(SPEECH_WAV))

    t0 = time.perf_counter()
    sig = extractor.extract(str(SPEECH_WAV))
    elapsed = time.perf_counter() - t0

    rtf = elapsed / audio_duration
    assert rtf < 1.5, f"Real-time factor {rtf:.3f} exceeded budget 1.5 (elapsed {elapsed:.2f}s for {audio_duration:.2f}s audio)"
