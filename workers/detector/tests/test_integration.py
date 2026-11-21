"""Integration test for detector service scaffold with realistic frame and WAV files."""

import json
import subprocess
import tempfile
import wave
from pathlib import Path
from PIL import Image
import jsonschema
from fastapi.testclient import TestClient

from workers.detector.src.app import app, frame_classifier, hud_extractor

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
SCHEMAS_DIR = REPO_ROOT / "packages" / "shared" / "schemas"
SCHEMA_PATH = SCHEMAS_DIR / "detector-response.schema.json"
client = TestClient(app)

# Warmup engines so disk load time does not affect request latency assertions
hud_extractor._get_ocr_engine()
frame_classifier._init_session()


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
        assert data["latency_ms"] < 5000.0  # Detector timeout budget is 5000ms (CONTRACTS §2)

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

        # Verify hud_text signal (B-04): image without text -> 0.0 with empty matched list
        assert data["signals"]["hud_text"]["value"] == 0.0
        assert data["signals"]["hud_text"]["detail"]["matched"] == []

        # Verify frame_classifier signal (B-05)
        assert data["signals"]["frame_classifier"]["value"] is not None
        assert 0.0 <= data["signals"]["frame_classifier"]["value"] <= 1.0
        assert isinstance(data["signals"]["frame_classifier"]["label"], str)

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


def test_analyze_integration_with_hud_overlay():
    """POST /v1/analyze with HUD overlay frame returns high hud_text score and matched pattern."""
    hud_fixture = REPO_ROOT / "fixtures" / "hud_overlay.mp4"
    if not hud_fixture.exists():
        pytest.skip("hud_overlay.mp4 fixture missing")

    # Extract single frame at t=22.0s
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f_img:
        frame_path = f_img.name

    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            "22.0",
            "-i",
            str(hud_fixture),
            "-frames:v",
            "1",
            frame_path,
        ],
        capture_output=True,
        check=True,
    )

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f_wav:
        f_wav.write(b"dummy audio")
        wav_path = f_wav.name

    # Check HUD profile endpoints
    prof_resp = client.get("/v1/hud/profiles")
    assert prof_resp.status_code == 200
    assert "default" in prof_resp.json()["profiles"]

    pats_resp = client.get("/v1/hud/patterns")
    assert pats_resp.status_code == 200
    assert any(p["pattern"] == "VICTORY ROYALE" for p in pats_resp.json()["patterns"])

    payload = {
        "session_id": "sess_integration_hud",
        "window_id": "win_integration_hud_01",
        "t_stream": 22.0,
        "t_wall": "2026-11-20T12:00:22.000Z",
        "frame_path": frame_path,
        "audio_path": wav_path,
        "audio_sample_rate": 16000,
        "chat": {"messages_in_window": 8, "unique_chatters": 6},
    }

    try:
        response = client.post("/v1/analyze", json=payload)
        assert response.status_code == 200

        data = response.json()
        assert data["signals"]["hud_text"]["value"] is not None
        assert data["signals"]["hud_text"]["value"] >= 0.85
        assert any("VICTORY" in m for m in data["signals"]["hud_text"]["detail"]["matched"])

        # Validate with JSON Schema
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        jsonschema.validate(instance=data, schema=schema)

        # Confirm cleanup
        assert not Path(frame_path).exists()
        assert not Path(wav_path).exists()

    finally:
        for p in [frame_path, wav_path]:
            if Path(p).exists():
                Path(p).unlink()
