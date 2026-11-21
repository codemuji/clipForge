"""Integration test for detector service scaffold with realistic frame and WAV files."""

import json
import tempfile
import wave
from pathlib import Path
from PIL import Image
import jsonschema
from fastapi.testclient import TestClient

from workers.detector.src.app import app

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
SCHEMAS_DIR = REPO_ROOT / "packages" / "shared" / "schemas"
client = TestClient(app)


def test_analyze_integration_roundtrip():
    # 1. Create realistic 16kHz mono WAV file (1 second of silence/tone)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f_wav:
        wav_path = f_wav.name

    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 16000)

    # 2. Create realistic JPEG frame (1920x1080)
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f_img:
        frame_path = f_img.name

    img = Image.new("RGB", (640, 360), color=(30, 30, 40))
    img.save(frame_path, "JPEG")

    payload = {
        "session_id": "sess_integration_01",
        "window_id": "win_integration_01",
        "t_stream": 150.0,
        "t_wall": "2026-11-20T12:00:00.000Z",
        "frame_path": frame_path,
        "audio_path": wav_path,
        "audio_sample_rate": 16000,
        "chat": {
            "messages_in_window": 35,
            "unique_chatters": 20,
        },
    }

    try:
        response = client.post("/v1/analyze", json=payload)
        assert response.status_code == 200

        data = response.json()
        assert data["window_id"] == "win_integration_01"
        assert data["t_stream"] == 150.0
        assert data["latency_ms"] < 2500.0  # Detector timeout budget is 2500ms

        # Validate against JSON schema
        with open(SCHEMAS_DIR / "detector-response.schema.json", "r", encoding="utf-8") as f:
            schema = json.load(f)
        jsonschema.validate(instance=data, schema=schema)

        # Verify audio signal is computed
        assert data["signals"]["audio"]["value"] is not None
        assert 0.0 <= data["signals"]["audio"]["value"] <= 1.0
        assert "detail" in data["signals"]["audio"]
        assert "lufs" in data["signals"]["audio"]["detail"]
        assert "lufs_delta" in data["signals"]["audio"]["detail"]

        # Verify speech_keywords default (no keywords configured -> 0.0, matched: [])
        assert data["signals"]["speech_keywords"]["value"] == 0.0
        assert data["signals"]["speech_keywords"]["detail"]["matched"] == []

        # Verify remaining signals remain null (pending B-04 and B-05)
        for key in ["hud_text", "frame_classifier"]:
            assert data["signals"][key]["value"] is None

        # Verify input files deleted per contract
        assert not Path(frame_path).exists()
        assert not Path(wav_path).exists()

    finally:
        for p in [frame_path, wav_path]:
            if Path(p).exists():
                Path(p).unlink()


def test_analyze_integration_with_keywords():
    """POST /v1/analyze with configured keywords and speech audio returns non-zero speech score."""
    speech_fixture = REPO_ROOT / "workers" / "detector" / "tests" / "fixtures" / "clutch_speech.wav"
    if not speech_fixture.exists():
        pytest.skip("clutch_speech.wav fixture missing")

    # Configure keywords
    kw_resp = client.post("/v1/keywords", json={"keywords": ["clutch", "ace"]})
    assert kw_resp.status_code == 200

    # Copy speech fixture to temp file so analyze can delete it per contract
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f_wav:
        f_wav.write(speech_fixture.read_bytes())
        wav_path = f_wav.name

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f_img:
        f_img.write(b"dummy image")
        frame_path = f_img.name

    payload = {
        "session_id": "sess_integration_kws",
        "window_id": "win_integration_kws",
        "t_stream": 10.0,
        "t_wall": "2026-11-20T12:00:00.000Z",
        "frame_path": frame_path,
        "audio_path": wav_path,
        "audio_sample_rate": 16000,
        "chat": {"messages_in_window": 5, "unique_chatters": 3},
    }

    try:
        response = client.post("/v1/analyze", json=payload)
        assert response.status_code == 200

        data = response.json()
        assert data["signals"]["speech_keywords"]["value"] > 0.0
        assert "clutch" in data["signals"]["speech_keywords"]["detail"]["matched"]

    finally:
        # Reset keywords back to empty list default
        client.post("/v1/keywords", json={"keywords": []})
        for p in [frame_path, wav_path]:
            if Path(p).exists():
                Path(p).unlink()
