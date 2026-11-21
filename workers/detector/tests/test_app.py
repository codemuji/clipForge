"""Unit tests for FastAPI app endpoints, error handling, and window file cleanup."""

import os
import tempfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from workers.detector.src.app import app

client = TestClient(app)


def test_health_endpoint():
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["detector"] == "online"
    assert "model_versions" in data
    assert "whisper" in data["model_versions"]
    assert "ocr" in data["model_versions"]
    assert "frame" in data["model_versions"]
    assert "gpu" in data


def test_analyze_endpoint_valid():
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f_img:
        f_img.write(b"fake image data")
        frame_path = f_img.name

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f_wav:
        f_wav.write(b"fake audio data")
        audio_path = f_wav.name

    payload = {
        "session_id": "test_session_1",
        "window_id": "win_12345",
        "t_stream": 10.0,
        "t_wall": "2026-11-20T10:15:03.120Z",
        "frame_path": frame_path,
        "audio_path": audio_path,
        "audio_sample_rate": 16000,
        "chat": {"messages_in_window": 10, "unique_chatters": 5},
    }

    try:
        resp = client.post("/v1/analyze", json=payload)
        assert resp.status_code == 200
        data = resp.json()

        assert data["window_id"] == "win_12345"
        assert data["t_stream"] == 10.0
        assert data["latency_ms"] >= 0.0

        # Assert missing signals return value: null, never omitted
        signals = data["signals"]
        for key in ["audio", "speech_keywords", "hud_text", "frame_classifier"]:
            assert key in signals
            assert signals[key]["value"] is None

        # Assert input files were deleted automatically
        assert not Path(frame_path).exists()
        assert not Path(audio_path).exists()

    finally:
        # Cleanup in case of test failure
        for p in [frame_path, audio_path]:
            if Path(p).exists():
                Path(p).unlink()


def test_analyze_endpoint_debug_keep_windows():
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f_img:
        f_img.write(b"fake image data")
        frame_path = f_img.name

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f_wav:
        f_wav.write(b"fake audio data")
        audio_path = f_wav.name

    payload = {
        "session_id": "test_session_2",
        "window_id": "win_keep_files",
        "t_stream": 20.0,
        "t_wall": "2026-11-20T10:15:03.120Z",
        "frame_path": frame_path,
        "audio_path": audio_path,
        "audio_sample_rate": 16000,
        "chat": {"messages_in_window": 0, "unique_chatters": 0},
    }

    os.environ["DEBUG_KEEP_WINDOWS"] = "1"
    try:
        resp = client.post("/v1/analyze", json=payload)
        assert resp.status_code == 200

        # When DEBUG_KEEP_WINDOWS=1, files must NOT be deleted
        assert Path(frame_path).exists()
        assert Path(audio_path).exists()

    finally:
        os.environ.pop("DEBUG_KEEP_WINDOWS", None)
        for p in [frame_path, audio_path]:
            if Path(p).exists():
                Path(p).unlink()


def test_analyze_endpoint_validation_error():
    # Missing required field 'frame_path'
    payload = {
        "session_id": "test_session",
        "window_id": "win_fail",
        "t_stream": 5.0,
        "t_wall": "2026-11-20T10:15:03.120Z",
        "audio_path": "/some/audio.wav",
        "chat": {"messages_in_window": 0, "unique_chatters": 0},
    }
    resp = client.post("/v1/analyze", json=payload)
    assert resp.status_code == 422
