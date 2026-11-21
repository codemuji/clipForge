"""Tests for MobileNetV3-small frame classifier (B-05).

Verifies preprocessing, label map configuration, ONNX Runtime inference latency (< 30 ms),
CPU fallback, labelled fixture frame predictions, and GPU tests marked needs_gpu.
"""

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Generator

import jsonschema
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from workers.detector.src.app import app
from workers.detector.src.classifier import (
    DEFAULT_LABEL_MAP,
    FrameClassifier,
    load_classifier_config,
    preprocess_frame,
)
from workers.detector.src.schemas import FrameClassifierSignal

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
FIXTURES_DIR = REPO_ROOT / "fixtures"
SCHEMAS_DIR = REPO_ROOT / "packages" / "shared" / "schemas"
DETECTOR_SCHEMA_PATH = SCHEMAS_DIR / "detector-response.schema.json"


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def quiet_frame() -> Generator[str, None, None]:
    """Extracts a frame from fixtures/quiet_session.mp4 at t=10.0s."""
    mp4_path = FIXTURES_DIR / "quiet_session.mp4"
    if not mp4_path.is_file():
        pytest.skip("quiet_session.mp4 fixture missing")

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        tmp_path = f.name

    res = subprocess.run(
        ["ffmpeg", "-y", "-ss", "10.0", "-i", str(mp4_path), "-frames:v", "1", tmp_path],
        capture_output=True,
    )
    assert res.returncode == 0, f"ffmpeg failed: {res.stderr.decode()}"
    yield tmp_path
    Path(tmp_path).unlink(missing_ok=True)


@pytest.fixture
def victory_frame() -> Generator[str, None, None]:
    """Extracts a frame from fixtures/hud_overlay.mp4 at t=22.0s."""
    mp4_path = FIXTURES_DIR / "hud_overlay.mp4"
    if not mp4_path.is_file():
        pytest.skip("hud_overlay.mp4 fixture missing")

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        tmp_path = f.name

    res = subprocess.run(
        ["ffmpeg", "-y", "-ss", "22.0", "-i", str(mp4_path), "-frames:v", "1", tmp_path],
        capture_output=True,
    )
    assert res.returncode == 0, f"ffmpeg failed: {res.stderr.decode()}"
    yield tmp_path
    Path(tmp_path).unlink(missing_ok=True)


# =====================================================================
# Unit Tests: Preprocessing & Label Map
# =====================================================================


def test_preprocess_frame_shape_and_dtype(quiet_frame: str):
    """Preprocessing outputs (1, 3, 224, 224) float32 tensor."""
    tensor = preprocess_frame(quiet_frame)
    assert isinstance(tensor, np.ndarray)
    assert tensor.shape == (1, 3, 224, 224)
    assert tensor.dtype == np.float32


def test_preprocess_frame_from_pil_and_numpy():
    """preprocess_frame accepts PIL Image and numpy ndarray."""
    img = Image.new("RGB", (640, 480), color=(128, 64, 32))
    tensor_pil = preprocess_frame(img)
    assert tensor_pil.shape == (1, 3, 224, 224)

    arr = np.ones((480, 640, 3), dtype=np.uint8) * 100
    tensor_arr = preprocess_frame(arr)
    assert tensor_arr.shape == (1, 3, 224, 224)


def test_preprocess_frame_missing_file():
    """Missing file raises FileNotFoundError."""
    with pytest.raises(FileNotFoundError):
        preprocess_frame("non_existent_frame_12345.jpg")


def test_load_classifier_config_defaults():
    """Default label map has 5 classes with non-empty names and valid weights."""
    label_map = load_classifier_config()
    assert len(label_map) >= 5
    for idx, entry in label_map.items():
        assert "name" in entry
        assert "weight" in entry
        assert 0.0 <= entry["weight"] <= 1.0


# =====================================================================
# Unit Tests: Inference, Fallback, & Latency Budget
# =====================================================================


def test_classifier_latency_budget(quiet_frame: str):
    """Inference latency on 224x224 frame must be under 30 ms budget."""
    clf = FrameClassifier()
    # Warmup pass
    clf.extract(quiet_frame)
    sig = clf.extract(quiet_frame)
    assert sig.value is not None
    assert clf.last_latency_ms < 30.0, f"Inference took {clf.last_latency_ms} ms (budget: < 30 ms)"


def test_classifier_logged_cpu_fallback(quiet_frame: str, caplog):
    """FrameClassifier logs CPU fallback when CUDA is requested or unavailable."""
    with caplog.at_level("INFO"):
        clf = FrameClassifier(preferred_provider="CUDAExecutionProvider")
        provider = clf.active_provider
        assert provider in ["CUDAExecutionProvider", "CPUExecutionProvider"]
        if provider == "CPUExecutionProvider":
            assert any("CPUExecutionProvider" in rec.message for rec in caplog.records)


def test_classifier_missing_frame_returns_null_signal():
    """Missing or non-existent frame returns value=None, label=None."""
    clf = FrameClassifier()
    sig = clf.extract("non_existent_frame.jpg")
    assert sig.value is None
    assert sig.label is None


# =====================================================================
# Integration Tests: Labelled Fixture Frames
# =====================================================================


def test_quiet_session_frame_prediction(quiet_frame: str):
    """quiet_session.mp4 frame classifies as idle with value <= 0.25."""
    clf = FrameClassifier()
    sig = clf.extract(quiet_frame)
    assert sig.value is not None
    assert sig.label == "idle"
    assert sig.value <= 0.25


def test_victory_overlay_frame_prediction(victory_frame: str):
    """hud_overlay.mp4 at t=22s classifies as victory with value >= 0.70."""
    clf = FrameClassifier()
    sig = clf.extract(victory_frame)
    assert sig.value is not None
    assert sig.label == "victory"
    assert sig.value >= 0.70


# =====================================================================
# API & Schema Validation Tests
# =====================================================================


def test_get_classifier_labels_endpoint(client: TestClient):
    """GET /v1/classifier/labels returns 200 with labels and active provider."""
    res = client.get("/v1/classifier/labels")
    assert res.status_code == 200
    data = res.json()
    assert "active_provider" in data
    assert "labels" in data
    assert len(data["labels"]) >= 5


def test_analyze_includes_frame_classifier_signal(client: TestClient, victory_frame: str):
    """POST /v1/analyze includes frame_classifier signal conforming to schema."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        audio_tmp = f.name
    # Generate 1s silent wav
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", audio_tmp],
        capture_output=True,
    )

    req_body = {
        "session_id": "test_session_b05",
        "window_id": "win_b05_001",
        "t_stream": 22.0,
        "t_wall": "2026-11-21T12:00:00.000Z",
        "frame_path": victory_frame,
        "audio_path": audio_tmp,
        "audio_sample_rate": 16000,
        "chat": {"messages_in_window": 0, "unique_chatters": 0},
    }

    res = client.post("/v1/analyze", json=req_body)
    assert res.status_code == 200
    data = res.json()

    # Schema validation
    if DETECTOR_SCHEMA_PATH.is_file():
        with open(DETECTOR_SCHEMA_PATH, "r", encoding="utf-8") as f:
            schema = json.load(f)
        jsonschema.validate(instance=data, schema=schema)

    assert "frame_classifier" in data["signals"]
    fc_sig = data["signals"]["frame_classifier"]
    assert fc_sig["value"] is not None
    assert fc_sig["value"] >= 0.70
    assert fc_sig["label"] == "victory"
    assert data["model_versions"]["frame"] == "mnv3s-v0.2"


# =====================================================================
# GPU Tests (marked needs_gpu)
# =====================================================================


@pytest.mark.needs_gpu
def test_gpu_cuda_inference_and_vram_budget(victory_frame: str):
    """Asserts CUDA execution provider and < 1 GB VRAM usage on GPU."""
    import onnxruntime as ort
    assert "CUDAExecutionProvider" in ort.get_available_providers(), "CUDA execution provider not installed"

    clf = FrameClassifier(preferred_provider="CUDAExecutionProvider")
    sig = clf.extract(victory_frame)
    assert clf.active_provider == "CUDAExecutionProvider"
    assert sig.value is not None

    # Check VRAM via nvidia-smi if available
    res = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,nounits,noheader"],
        capture_output=True,
        text=True,
    )
    if res.returncode == 0:
        used_mb = float(res.stdout.strip().split("\n")[0])
        assert used_mb < 1000.0, f"VRAM use was {used_mb} MB (budget: < 1000 MB)"
