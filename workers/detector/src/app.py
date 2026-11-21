"""FastAPI application for the clipforge detector service."""

import os
import shutil
import subprocess
import time
from typing import Any, Dict, List

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .audio import AudioSignalExtractor
from .cleanup import cleanup_window_files
from .classifier import FrameClassifier
from .keywords import SpeechKeywordExtractor
from .ocr import HudTextExtractor
from .schemas import (
    AudioSignal,
    DetectorResponse,
    DetectorSignals,
    FrameClassifierSignal,
    HealthResponse,
    HudTextSignal,
    ModelVersions,
    SamplerRequest,
    SpeechKeywordsSignal,
)

app = FastAPI(
    title="clipforge detector",
    description="Local Autonomous Highlight Clipping Detector Worker",
    version="0.1.0",
)

# Signal extractors
audio_extractor = AudioSignalExtractor()
keyword_extractor = SpeechKeywordExtractor()
hud_extractor = HudTextExtractor()
frame_classifier = FrameClassifier()


class KeywordsUpdate(BaseModel):
    keywords: List[str]


class ProfileUpdate(BaseModel):
    profile: str


def get_gpu_info() -> Dict[str, Any]:
    """Queries GPU status if available on the system."""
    if not shutil.which("nvidia-smi"):
        return {"available": False, "reason": "nvidia-smi not found"}
    try:
        res = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                "--format=csv,nounits,noheader",
            ],
            capture_output=True,
            text=True,
            timeout=2.0,
            check=True,
        )
        parts = [p.strip() for p in res.stdout.strip().split(",")]
        if len(parts) >= 4:
            return {
                "available": True,
                "name": parts[0],
                "memory_used_mb": float(parts[1]),
                "memory_total_mb": float(parts[2]),
                "gpu_utilization_pct": float(parts[3]),
            }
        return {"available": True, "raw": res.stdout.strip()}
    except Exception as e:
        return {"available": False, "error": str(e)}


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Returns detector service health, active model versions, and GPU status."""
    return HealthResponse(
        status="ok",
        detector="online",
        model_versions=ModelVersions(),
        gpu=get_gpu_info(),
    )


@app.get("/v1/keywords")
def get_keywords() -> Dict[str, List[str]]:
    """Returns active speech keyword list."""
    return {"keywords": keyword_extractor.keywords}


@app.post("/v1/keywords")
def set_keywords(payload: KeywordsUpdate) -> Dict[str, Any]:
    """Updates active speech keyword list."""
    keyword_extractor.set_keywords(payload.keywords)
    return {"status": "ok", "keywords": keyword_extractor.keywords}


@app.get("/v1/hud/profiles")
def get_hud_profiles() -> Dict[str, Any]:
    """Returns available game profiles and active profile name."""
    return {
        "active_profile": hud_extractor.active_profile_name,
        "profiles": list(hud_extractor.profiles.keys()),
    }


@app.post("/v1/hud/profile")
def set_hud_profile(payload: ProfileUpdate) -> Dict[str, Any]:
    """Switches active game HUD profile."""
    ok = hud_extractor.set_profile(payload.profile)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown profile: {payload.profile}. Available: {list(hud_extractor.profiles.keys())}",
        )
    return {"status": "ok", "active_profile": hud_extractor.active_profile_name}


@app.get("/v1/hud/patterns")
def get_hud_patterns() -> Dict[str, Any]:
    """Returns configured crop regions and patterns for active profile."""
    prof = hud_extractor.active_profile
    return {
        "profile": prof.name,
        "crop_regions": [{"name": r.name, "box": r.box} for r in prof.crop_regions],
        "patterns": [{"pattern": p.pattern, "weight": p.weight} for p in prof.patterns],
    }


@app.get("/v1/classifier/labels")
def get_classifier_labels() -> Dict[str, Any]:
    """Returns active frame classifier label map and execution provider info."""
    return {
        "active_provider": frame_classifier.active_provider,
        "labels": frame_classifier.label_map,
    }


@app.post("/v1/session/{session_id}/reset")
def reset_session(session_id: str) -> Dict[str, str]:
    """Resets detector rolling baselines (e.g. audio energy) for a session."""
    audio_extractor.reset_session(session_id)
    hud_extractor.reset_session(session_id)
    return {"status": "ok", "session_id": session_id, "message": "Baseline reset"}


@app.post("/v1/analyze", response_model=DetectorResponse)
def analyze(req: SamplerRequest) -> DetectorResponse:
    """Evaluates a stream window (audio + frame) and returns hype signal scores.
    
    Accepts SamplerRequest (CONTRACTS §2) and returns DetectorResponse (CONTRACTS §3).
    Automatically deletes frame_path and audio_path after processing unless DEBUG_KEEP_WINDOWS=1.
    """
    t_start = time.perf_counter()

    try:
        # 1. Audio Energy Signal Extraction (B-02)
        audio_sig = audio_extractor.extract(
            audio_path=req.audio_path,
            session_id=req.session_id,
            sample_rate=req.audio_sample_rate,
        )

        # 2. Speech Keywords Signal Extraction (B-03)
        keyword_sig = keyword_extractor.extract(
            audio_path=req.audio_path,
        )

        # 3. HUD On-Screen Text Signal Extraction (B-04)
        hud_sig = hud_extractor.extract(
            frame_path=req.frame_path,
            t_stream=req.t_stream,
            session_id=req.session_id,
        )

        # 4. Frame Classifier Signal Extraction (B-05)
        frame_sig = frame_classifier.extract(
            frame_path=req.frame_path,
        )

        signals = DetectorSignals(
            audio=audio_sig,
            speech_keywords=keyword_sig,
            hud_text=hud_sig,
            frame_classifier=frame_sig,
        )

        latency_ms = round((time.perf_counter() - t_start) * 1000.0, 2)

        return DetectorResponse(
            window_id=req.window_id,
            t_stream=req.t_stream,
            signals=signals,
            latency_ms=latency_ms,
            model_versions=ModelVersions(),
        )
    finally:
        # Guarantee input file cleanup even if processing raises an exception
        cleanup_window_files([req.frame_path, req.audio_path])
