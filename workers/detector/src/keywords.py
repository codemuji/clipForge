"""Speech keywords extraction and whisper.cpp transcription."""

import os
import re
from pathlib import Path
from typing import List, Optional, Union
import yaml

from .schemas import SpeechKeywordsDetail, SpeechKeywordsSignal

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
DEFAULT_KEYWORDS_PATH = REPO_ROOT / "config" / "keywords.yaml"


def normalize_text(text: str) -> str:
    """Normalizes text for robust keyword matching (lowercase, standardized spaces)."""
    return text.lower().strip()


def match_keywords(text: str, keywords: List[str]) -> List[str]:
    """Matches keyword strings in transcript text.
    
    Rules:
    - Case-insensitive.
    - Punctuation-tolerant.
    - Word boundary enforced: partial words (e.g. 'ill' in 'skill') must NOT match.
    """
    if not text or not keywords:
        return []

    norm_text = normalize_text(text)
    matched: List[str] = []

    for kw in keywords:
        kw_clean = kw.strip()
        if not kw_clean:
            continue
        # Use word boundaries (\b). Handle apostrophes/hyphens gracefully.
        kw_regex = re.escape(kw_clean.lower())
        pattern = rf"(?<!\w){kw_regex}(?!\w)"
        if re.search(pattern, norm_text):
            matched.append(kw_clean)

    return matched


def load_keywords(config_path: Optional[Union[str, Path]] = None) -> List[str]:
    """Loads keyword trigger list from YAML configuration.
    
    Empty list by default per Acceptance criteria.
    """
    path = config_path or os.environ.get("KEYWORDS_CONFIG_PATH") or DEFAULT_KEYWORDS_PATH
    p = Path(path)

    if not p.is_file():
        return []

    try:
        with open(p, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if not data:
            return []
        
        raw_keywords = data.get("keywords", [])
        keywords: List[str] = []
        for item in raw_keywords:
            if isinstance(item, str):
                keywords.append(item.strip())
            elif isinstance(item, dict) and "word" in item:
                keywords.append(str(item["word"]).strip())
        return [k for k in keywords if k]
    except Exception:
        return []


class SpeechKeywordExtractor:
    """Transcribes audio windows via whisper.cpp and matches configured speech keywords."""

    def __init__(
        self,
        model_name: str = "base.en-q5_1",
        n_threads: int = 6,
        keywords_path: Optional[Union[str, Path]] = None,
    ) -> None:
        self.model_name = model_name
        self.n_threads = n_threads
        self.keywords_path = keywords_path
        self._keywords: List[str] = load_keywords(keywords_path)
        self._model = None

    @property
    def keywords(self) -> List[str]:
        return self._keywords

    def set_keywords(self, keywords: List[str]) -> None:
        """Dynamically sets the active keywords list."""
        self._keywords = list(keywords)

    def reload_keywords(self) -> None:
        """Reloads keywords from configuration."""
        self._keywords = load_keywords(self.keywords_path)

    def _get_model(self):
        """Lazily initializes and caches the whisper.cpp model."""
        if self._model is None:
            from pywhispercpp.model import Model
            local_models_dir = Path(__file__).resolve().parent.parent / "models"
            if (local_models_dir / f"ggml-{self.model_name}.bin").exists():
                self._model = Model(self.model_name, models_dir=str(local_models_dir), n_threads=self.n_threads)
            else:
                self._model = Model(self.model_name, n_threads=self.n_threads)
        return self._model

    def extract(self, audio_path: str) -> SpeechKeywordsSignal:
        """Transcribes audio window and evaluates keyword match score."""
        if not audio_path or not Path(audio_path).is_file():
            return SpeechKeywordsSignal(value=None)

        # Validate that audio file is valid and readable
        try:
            import soundfile as sf
            info = sf.info(audio_path)
            if info.frames == 0:
                return SpeechKeywordsSignal(value=None)
        except Exception:
            return SpeechKeywordsSignal(value=None)

        # If keyword list is empty, return 0.0 with empty matched list
        # This saves CPU cycles when no keywords are configured
        if not self._keywords:
            return SpeechKeywordsSignal(
                value=0.0,
                detail=SpeechKeywordsDetail(matched=[]),
            )

        try:
            model = self._get_model()
            segments = model.transcribe(audio_path)
            transcript = " ".join([seg.text for seg in segments]).strip()
        except Exception:
            return SpeechKeywordsSignal(value=None)

        matched = match_keywords(transcript, self._keywords)

        if not matched:
            value = 0.0
        else:
            # First match gives 0.75 score, additional matches saturate to 1.0
            value = min(1.0, 0.5 + 0.25 * len(matched))

        return SpeechKeywordsSignal(
            value=round(value, 3),
            detail=SpeechKeywordsDetail(matched=matched),
        )
