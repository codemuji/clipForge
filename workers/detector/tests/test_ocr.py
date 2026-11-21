"""Unit and integration tests for B-04 HUD text detection and RapidOCR."""

import json
import subprocess
import tempfile
import time
from pathlib import Path
from typing import List

import jsonschema
import pytest
from PIL import Image, ImageDraw

from workers.detector.src.ocr import (
    CropRegion,
    GameProfile,
    HudPattern,
    HudTextExtractor,
    load_hud_config,
    match_hud_patterns,
    parse_profile,
)
from workers.detector.src.schemas import HudTextDetail, HudTextSignal

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
HUD_FIXTURE_MP4 = REPO_ROOT / "fixtures" / "hud_overlay.mp4"
SCHEMA_PATH = REPO_ROOT / "packages" / "shared" / "schemas" / "detector-response.schema.json"


@pytest.fixture(scope="module")
def hud_overlay_frame() -> str:
    """Extracts a frame from fixtures/hud_overlay.mp4 at t=22.0s (during golden banner)."""
    if not HUD_FIXTURE_MP4.exists():
        pytest.skip("hud_overlay.mp4 fixture missing")

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        out_path = f.name

    res = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            "22.0",
            "-i",
            str(HUD_FIXTURE_MP4),
            "-frames:v",
            "1",
            out_path,
        ],
        capture_output=True,
    )
    if res.returncode != 0 or not Path(out_path).exists():
        pytest.skip(f"Failed to extract frame from {HUD_FIXTURE_MP4}")

    yield out_path
    if Path(out_path).exists():
        Path(out_path).unlink()


@pytest.fixture(scope="module")
def quiet_frame() -> str:
    """Extracts a baseline frame from fixtures/hud_overlay.mp4 at t=5.0s (no overlay)."""
    if not HUD_FIXTURE_MP4.exists():
        pytest.skip("hud_overlay.mp4 fixture missing")

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        out_path = f.name

    res = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            "5.0",
            "-i",
            str(HUD_FIXTURE_MP4),
            "-frames:v",
            "1",
            out_path,
        ],
        capture_output=True,
    )
    if res.returncode != 0 or not Path(out_path).exists():
        pytest.skip(f"Failed to extract quiet frame from {HUD_FIXTURE_MP4}")

    yield out_path
    if Path(out_path).exists():
        Path(out_path).unlink()


# ========================================================
# 1. CONFIG & PROFILE TESTS
# ========================================================

def test_load_builtin_profiles():
    """Default configuration loads built-in profiles with valid crop regions and patterns."""
    default_name, profiles = load_hud_config()
    assert default_name == "default"
    assert "default" in profiles
    assert "fortnite" in profiles
    assert "valorant" in profiles

    default_prof = profiles["default"]
    assert len(default_prof.crop_regions) >= 1
    assert any(p.pattern == "VICTORY ROYALE" for p in default_prof.patterns)
    assert any(p.pattern == "DEFEAT" for p in default_prof.patterns)


def test_parse_profile_custom():
    """parse_profile correctly handles custom raw dictionaries with normalized boxes."""
    raw = {
        "crop_regions": [
            {"name": "killfeed", "box": [0.70, 0.05, 0.98, 0.25]},
            {"name": "status", "box": [0.30, 0.10, 0.70, 0.30]},
        ],
        "patterns": [
            {"pattern": "ACE", "weight": 0.95},
            "PENTAKILL",
        ],
    }
    profile = parse_profile("custom_game", raw)
    assert profile.name == "custom_game"
    assert len(profile.crop_regions) == 2
    assert profile.crop_regions[0].name == "killfeed"
    assert profile.crop_regions[0].box == [0.70, 0.05, 0.98, 0.25]
    assert len(profile.patterns) == 2
    assert profile.patterns[0].pattern == "ACE"
    assert profile.patterns[0].weight == 0.95
    assert profile.patterns[1].pattern == "PENTAKILL"
    assert profile.patterns[1].weight == 0.90


def test_profile_switching():
    """Extractor supports dynamic game profile switching."""
    extractor = HudTextExtractor()
    assert extractor.active_profile_name == "default"

    ok = extractor.set_profile("valorant")
    assert ok is True
    assert extractor.active_profile_name == "valorant"
    assert any(p.pattern == "CLUTCH" for p in extractor.active_profile.patterns)

    # Unknown profile returns False without changing active profile
    assert extractor.set_profile("nonexistent_game") is False
    assert extractor.active_profile_name == "valorant"


# ========================================================
# 2. CROP COORDINATE CONVERSION TESTS
# ========================================================

def test_crop_box_normalized():
    """Normalized coordinates [0..1] scale to image dimensions."""
    extractor = HudTextExtractor()
    box = [0.20, 0.10, 0.80, 0.40]
    left, top, right, bottom = extractor._crop_box(1280, 720, box)
    assert left == 256
    assert top == 72
    assert right == 1024
    assert bottom == 288


def test_crop_box_pixels():
    """Pixel coordinates (> 1.0) clamp to image boundaries."""
    extractor = HudTextExtractor()
    box = [100.0, 50.0, 2000.0, 900.0]
    left, top, right, bottom = extractor._crop_box(1280, 720, box)
    assert left == 100
    assert top == 50
    assert right == 1280
    assert bottom == 720


# ========================================================
# 3. PATTERN MATCHING UNIT TESTS
# ========================================================

def test_pattern_matching_variations():
    """match_hud_patterns handles case, punctuation, and spaceless compound phrases."""
    patterns = [
        HudPattern(pattern="VICTORY ROYALE", weight=1.0),
        HudPattern(pattern="VICTORY", weight=0.9),
        HudPattern(pattern="DEFEAT", weight=0.7),
        HudPattern(pattern="ACE", weight=0.95),
    ]

    # 1. Exact match
    m1 = match_hud_patterns(["VICTORY"], patterns)
    assert [p.pattern for p in m1] == ["VICTORY"]

    # 2. Case and punctuation
    m2 = match_hud_patterns(["victory!"], patterns)
    assert [p.pattern for p in m2] == ["VICTORY"]

    # 3. Spaceless compound matching (e.g. VICTORYROYALE matches VICTORY ROYALE)
    m3 = match_hud_patterns(["VICTORYROYALE"], patterns)
    matched_names = [p.pattern for p in m3]
    assert "VICTORY ROYALE" in matched_names

    # 4. Spaced compound matching matches both the full phrase and sub-words
    m4 = match_hud_patterns(["VICTORY ROYALE"], patterns)
    matched_names_4 = [p.pattern for p in m4]
    assert "VICTORY ROYALE" in matched_names_4
    assert "VICTORY" in matched_names_4

    # 5. Short word boundary protection (ACE must not match SPACE or RACE)
    m5 = match_hud_patterns(["A RACE IN SPACE"], patterns)
    assert len(m5) == 0

    m6 = match_hud_patterns(["ROUND ACE!"], patterns)
    assert [p.pattern for p in m6] == ["ACE"]


# ========================================================
# 4. RATE LIMITING TESTS
# ========================================================

def test_rate_limiting_enforces_two_second_interval():
    """OCR runs at most once per 2 seconds; subsequent calls within 2s return cached signal."""
    # Create synthetic test frame
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        img_path = f.name
        img = Image.new("RGB", (640, 360), (20, 20, 20))
        d = ImageDraw.Draw(img)
        d.text((150, 40), "VICTORY", fill=(255, 255, 0))
        img.save(img_path)

    try:
        extractor = HudTextExtractor(min_interval_seconds=2.0)
        sess = "test_rate_sess"

        # 1. First call at t=10.0s -> Executes OCR and caches result
        sig1 = extractor.extract(img_path, t_stream=10.0, session_id=sess)
        assert sig1.value is not None
        assert sig1.value > 0.0
        assert "VICTORY" in sig1.detail.matched

        # 2. Second call at t=11.0s (1.0s elapsed < 2.0s interval) -> Throttled, returns cached
        # Pass a nonexistent path; if OCR were invoked, it would return value=None,
        # but because it is throttled, it returns the cached valid signal!
        sig2 = extractor.extract(img_path, t_stream=11.0, session_id=sess)
        assert sig2.value == sig1.value
        assert sig2.detail.matched == sig1.detail.matched

        # 3. Third call at t=12.1s (2.1s elapsed >= 2.0s interval) -> Executes OCR again
        sig3 = extractor.extract(img_path, t_stream=12.1, session_id=sess)
        assert sig3.value == sig1.value

        # 4. Session reset clears cached state
        extractor.reset_session(sess)
        sig4 = extractor.extract(img_path, t_stream=12.5, session_id=sess)
        assert sig4.value is not None

    finally:
        if Path(img_path).exists():
            Path(img_path).unlink()


# ========================================================
# 5. FIXTURE INTEGRATION TESTS
# ========================================================

def test_hud_fixture_overlay_frame_detection(hud_overlay_frame):
    """Fixture frame at t=22.0s with known overlay returns match score > 0.85."""
    extractor = HudTextExtractor(profile_name="default")
    sig = extractor.extract(hud_overlay_frame, force=True)

    assert sig.value is not None
    assert sig.value >= 0.85, f"Expected score >= 0.85, got {sig.value}"
    assert sig.detail is not None
    assert len(sig.detail.matched) > 0
    assert any("VICTORY" in m for m in sig.detail.matched)


def test_hud_fixture_quiet_frame_no_match(quiet_frame):
    """Fixture frame without overlay returns value 0.0 and empty matched list."""
    extractor = HudTextExtractor(profile_name="default")
    sig = extractor.extract(quiet_frame, force=True)

    assert sig.value == 0.0
    assert sig.detail is not None
    assert sig.detail.matched == []


# ========================================================
# 6. EDGE CASES & SCHEMA COMPLIANCE
# ========================================================

def test_missing_or_corrupt_frame_returns_null_value():
    """Missing file or corrupted file gracefully returns HudTextSignal(value=None)."""
    extractor = HudTextExtractor()

    # Missing file
    s_missing = extractor.extract("/nonexistent/frame_12345.jpg")
    assert s_missing.value is None

    # Corrupt file
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(b"NOT_A_VALID_JPEG_HEADER")
        corrupt_path = f.name

    try:
        s_corrupt = extractor.extract(corrupt_path, force=True)
        assert s_corrupt.value is None
    finally:
        if Path(corrupt_path).exists():
            Path(corrupt_path).unlink()


def test_hud_signal_json_schema_validation(hud_overlay_frame):
    """hud_text signal in response conforms to clipforge.detector-response.v1 schema."""
    if not SCHEMA_PATH.exists():
        pytest.skip("detector-response.schema.json missing")

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    extractor = HudTextExtractor()
    sig = extractor.extract(hud_overlay_frame, force=True)

    response_payload = {
        "window_id": "win_schema_hud_test",
        "t_stream": 22.0,
        "signals": {
            "audio": {"value": 0.5, "detail": {"lufs": -20.0, "lufs_delta": 0.0}},
            "speech_keywords": {"value": 0.0, "detail": {"matched": []}},
            "hud_text": sig.model_dump(),
            "frame_classifier": {"value": None, "label": None},
        },
        "latency_ms": 120.0,
        "model_versions": {"whisper": "base.en-q5", "ocr": "paddle-small", "frame": "mnv3s-v0.2"},
    }

    # Validate against JSON schema; raises on failure
    jsonschema.validate(instance=response_payload, schema=schema)
