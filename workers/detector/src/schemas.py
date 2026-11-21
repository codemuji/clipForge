"""Pydantic schemas matching CONTRACTS.md §2-§3 and packages/shared/schemas/*.json."""

from typing import Any, List, Optional
from pydantic import BaseModel, ConfigDict, Field, model_serializer


class ChatWindowCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages_in_window: int = Field(..., ge=0, description="Total chat messages in window")
    unique_chatters: int = Field(..., ge=0, description="Distinct chat authors in window")


class SamplerRequest(BaseModel):
    """CONTRACTS §2: Sampler -> Detector request schema."""
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(..., min_length=1)
    window_id: str = Field(..., min_length=1)
    t_stream: float = Field(..., ge=0.0)
    t_wall: str = Field(..., description="ISO 8601 UTC timestamp")
    frame_path: str = Field(...)
    audio_path: str = Field(...)
    audio_sample_rate: int = Field(default=16000, gt=0)
    chat: ChatWindowCounts = Field(...)


class AudioDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lufs: Optional[float] = None
    lufs_delta: Optional[float] = None


class AudioSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    detail: Optional[AudioDetail] = None

    @model_serializer(mode="wrap")
    def serialize_model(self, handler):
        d = handler(self)
        if d.get("detail") is None:
            d.pop("detail", None)
        return d


class SpeechKeywordsDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    matched: List[str] = Field(default_factory=list)


class SpeechKeywordsSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    detail: Optional[SpeechKeywordsDetail] = None

    @model_serializer(mode="wrap")
    def serialize_model(self, handler):
        d = handler(self)
        if d.get("detail") is None:
            d.pop("detail", None)
        return d


class HudTextDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    matched: List[str] = Field(default_factory=list)


class HudTextSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    detail: Optional[HudTextDetail] = None

    @model_serializer(mode="wrap")
    def serialize_model(self, handler):
        d = handler(self)
        if d.get("detail") is None:
            d.pop("detail", None)
        return d


class FrameClassifierSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    label: Optional[str] = None


class DetectorSignals(BaseModel):
    model_config = ConfigDict(extra="forbid")

    audio: AudioSignal = Field(default_factory=AudioSignal)
    speech_keywords: SpeechKeywordsSignal = Field(default_factory=SpeechKeywordsSignal)
    hud_text: HudTextSignal = Field(default_factory=HudTextSignal)
    frame_classifier: FrameClassifierSignal = Field(default_factory=FrameClassifierSignal)


class ModelVersions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    whisper: str = "base.en-q5"
    ocr: str = "paddle-small"
    frame: str = "mnv3s-v0.2"


class DetectorResponse(BaseModel):
    """CONTRACTS §3: Detector -> Scorer response schema."""
    model_config = ConfigDict(extra="forbid")

    window_id: str = Field(...)
    t_stream: float = Field(..., ge=0.0)
    signals: DetectorSignals = Field(default_factory=DetectorSignals)
    latency_ms: float = Field(..., ge=0.0)
    model_versions: ModelVersions = Field(default_factory=ModelVersions)


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    status: str = "ok"
    detector: str = "online"
    model_versions: ModelVersions = Field(default_factory=ModelVersions)
    gpu: Optional[dict[str, Any]] = None
