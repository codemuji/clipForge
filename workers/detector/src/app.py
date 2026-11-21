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
from .keywords import SpeechKeywordExtractor
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


class KeywordsUpdate(BaseModel):
    keywords: List[str]


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


@app.post("/v1/session/{session_id}/reset")
def reset_session(session_id: str) -> Dict[str, str]:
    """Resets detector rolling baselines (e.g. audio energy) for a session."""
    audio_extractor.reset_session(session_id)
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

        # 3. Remaining signals (HUD B-04, Frame Classifier B-05)
        # Missing signals return value: None (serialized as null in JSON)
        signals = DetectorSignals(
            audio=audio_sig,
            speech_keywords=keyword_sig,
            hud_text=HudTextSignal(value=None),
            frame_classifier=FrameClassifierSignal(value=None),
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
