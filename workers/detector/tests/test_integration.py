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

        # Verify input files deleted per contract
        assert not Path(frame_path).exists()
        assert not Path(wav_path).exists()

    finally:
        for p in [frame_path, wav_path]:
            if Path(p).exists():
                Path(p).unlink()
