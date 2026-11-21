"""Unit tests for SamplerRequest and DetectorResponse schemas and validation."""

import json
from pathlib import Path
import pytest
import jsonschema
from pydantic import ValidationError

from workers.detector.src.schemas import (
    AudioSignal,
    ChatWindowCounts,
    DetectorResponse,
    DetectorSignals,
    FrameClassifierSignal,
    HudTextSignal,
    ModelVersions,
    SamplerRequest,
    SpeechKeywordsSignal,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
SCHEMAS_DIR = REPO_ROOT / "packages" / "shared" / "schemas"


def load_json_schema(filename: str) -> dict:
    with open(SCHEMAS_DIR / filename, "r", encoding="utf-8") as f:
        return json.load(f)


def test_sampler_request_valid():
    data = {
        "session_id": "session_test_123",
        "window_id": "win_abc_456",
        "t_stream": 12.5,
        "t_wall": "2026-11-20T10:15:03.120Z",
        "frame_path": "/tmp/frame.jpg",
        "audio_path": "/tmp/window.wav",
        "audio_sample_rate": 16000,
        "chat": {
            "messages_in_window": 15,
            "unique_chatters": 8,
        },
    }
    req = SamplerRequest(**data)
    assert req.session_id == "session_test_123"
    assert req.window_id == "win_abc_456"
    assert req.t_stream == 12.5
    assert req.chat.messages_in_window == 15

    # Validate against shared JSON Schema
    schema = load_json_schema("sampler-request.schema.json")
    jsonschema.validate(instance=req.model_dump(), schema=schema)


def test_sampler_request_invalid():
    # Missing session_id
    with pytest.raises(ValidationError):
        SamplerRequest(
            window_id="win_1",
            t_stream=1.0,
            t_wall="2026-11-20T10:15:03.120Z",
            frame_path="/tmp/f.jpg",
            audio_path="/tmp/a.wav",
            chat={"messages_in_window": 1, "unique_chatters": 1},
        )

    # Negative t_stream
    with pytest.raises(ValidationError):
        SamplerRequest(
            session_id="s1",
            window_id="win_1",
            t_stream=-5.0,
            t_wall="2026-11-20T10:15:03.120Z",
            frame_path="/tmp/f.jpg",
            audio_path="/tmp/a.wav",
            chat={"messages_in_window": 1, "unique_chatters": 1},
        )

    # Negative chat count
    with pytest.raises(ValidationError):
        SamplerRequest(
            session_id="s1",
            window_id="win_1",
            t_stream=1.0,
            t_wall="2026-11-20T10:15:03.120Z",
            frame_path="/tmp/f.jpg",
            audio_path="/tmp/a.wav",
            chat={"messages_in_window": -1, "unique_chatters": 1},
        )


def test_detector_response_null_signals():
    """Missing signals must return value: null, never omitted."""
    resp = DetectorResponse(
        window_id="win_abc_456",
        t_stream=12.5,
        signals=DetectorSignals(
            audio=AudioSignal(value=None),
            speech_keywords=SpeechKeywordsSignal(value=None),
            hud_text=HudTextSignal(value=None),
            frame_classifier=FrameClassifierSignal(value=None),
        ),
        latency_ms=45.2,
        model_versions=ModelVersions(),
    )

    dumped = resp.model_dump()

    # Ensure all four signals exist and their value is None (null)
    assert "audio" in dumped["signals"]
    assert dumped["signals"]["audio"]["value"] is None
    assert "speech_keywords" in dumped["signals"]
    assert dumped["signals"]["speech_keywords"]["value"] is None
    assert "hud_text" in dumped["signals"]
    assert dumped["signals"]["hud_text"]["value"] is None
    assert "frame_classifier" in dumped["signals"]
    assert dumped["signals"]["frame_classifier"]["value"] is None

    # Validate against shared JSON Schema
    schema = load_json_schema("detector-response.schema.json")
    jsonschema.validate(instance=dumped, schema=schema)


def test_detector_response_populated_signals():
    """Populated signals conform to CONTRACTS §3."""
    resp = DetectorResponse(
        window_id="win_abc_456",
        t_stream=1234.5,
        signals=DetectorSignals(
            audio=AudioSignal(value=0.81, detail={"lufs": -14.2, "lufs_delta": 6.1}),
            speech_keywords=SpeechKeywordsSignal(value=0.0, detail={"matched": []}),
            hud_text=HudTextSignal(value=0.75, detail={"matched": ["VICTORY"]}),
            frame_classifier=FrameClassifierSignal(value=0.44, label="action"),
        ),
        latency_ms=310.0,
        model_versions=ModelVersions(
            whisper="base.en-q5",
            ocr="paddle-small",
            frame="mnv3s-v0.2",
        ),
    )

    dumped = resp.model_dump()
    schema = load_json_schema("detector-response.schema.json")
    jsonschema.validate(instance=dumped, schema=schema)
