"""HUD on-screen text detection using RapidOCR and configurable game profiles."""

import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
import yaml
from PIL import Image

from .schemas import HudTextDetail, HudTextSignal

logger = logging.getLogger("clipforge.detector.ocr")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
ROOT_HUD_CONFIG_PATH = REPO_ROOT / "config" / "hud_patterns.yaml"
LOCAL_HUD_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "hud_patterns.yaml"


@dataclass
class CropRegion:
    name: str
    box: List[float]  # [x_min, y_min, x_max, y_max]


@dataclass
class HudPattern:
    pattern: str
    weight: float = 0.90


@dataclass
class GameProfile:
    name: str
    crop_regions: List[CropRegion] = field(default_factory=list)
    patterns: List[HudPattern] = field(default_factory=list)


BUILTIN_PROFILES: Dict[str, Dict[str, Any]] = {
    "default": {
        "crop_regions": [
            {"name": "top_banner", "box": [0.20, 0.05, 0.80, 0.35]},
            {"name": "center", "box": [0.20, 0.35, 0.80, 0.65]},
        ],
        "patterns": [
            {"pattern": "VICTORY ROYALE", "weight": 1.00},
            {"pattern": "VICTORY", "weight": 0.90},
            {"pattern": "DEFEAT", "weight": 0.70},
            {"pattern": "FIRST BLOOD", "weight": 0.85},
            {"pattern": "ACE", "weight": 0.90},
            {"pattern": "OVERTIME", "weight": 0.75},
            {"pattern": "ELIMINATED", "weight": 0.70},
            {"pattern": "CHAMPION", "weight": 0.95},
        ],
    },
    "fortnite": {
        "crop_regions": [
            {"name": "top_banner", "box": [0.20, 0.08, 0.80, 0.30]},
        ],
        "patterns": [
            {"pattern": "VICTORY ROYALE", "weight": 1.00},
            {"pattern": "#1 VICTORY ROYALE", "weight": 1.00},
            {"pattern": "VICTORY", "weight": 0.90},
            {"pattern": "ELIMINATED", "weight": 0.70},
        ],
    },
    "valorant": {
        "crop_regions": [
            {"name": "round_end", "box": [0.25, 0.12, 0.75, 0.38]},
        ],
        "patterns": [
            {"pattern": "VICTORY", "weight": 0.95},
            {"pattern": "DEFEAT", "weight": 0.70},
            {"pattern": "CLUTCH", "weight": 0.90},
            {"pattern": "ACE", "weight": 0.95},
            {"pattern": "MATCH POINT", "weight": 0.80},
        ],
    },
}


def parse_profile(name: str, data: Dict[str, Any]) -> GameProfile:
    """Parses raw profile dictionary into GameProfile dataclass."""
    crop_regions = []
    for r in data.get("crop_regions", []):
        if isinstance(r, dict) and "box" in r:
            crop_regions.append(CropRegion(name=r.get("name", "crop"), box=list(r["box"])))

    patterns = []
    for p in data.get("patterns", []):
        if isinstance(p, dict) and "pattern" in p:
            patterns.append(HudPattern(pattern=str(p["pattern"]).strip(), weight=float(p.get("weight", 0.90))))
        elif isinstance(p, str) and p.strip():
            patterns.append(HudPattern(pattern=p.strip(), weight=0.90))

    return GameProfile(name=name, crop_regions=crop_regions, patterns=patterns)


def load_hud_config(config_path: Optional[Union[str, Path]] = None) -> Tuple[str, Dict[str, GameProfile]]:
    """Loads HUD configuration and game profiles from YAML file or defaults."""
    candidates = []
    if config_path:
        candidates.append(Path(config_path))
    candidates.extend([ROOT_HUD_CONFIG_PATH, LOCAL_HUD_CONFIG_PATH])

    for p in candidates:
        if p.is_file():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f) or {}
                profiles_data = data.get("profiles", {})
                default_profile = str(data.get("default_profile", "default"))
                profiles = {}
                for name, p_data in profiles_data.items():
                    profiles[name] = parse_profile(name, p_data)
                if profiles:
                    if default_profile not in profiles:
                        default_profile = next(iter(profiles.keys()))
                    return default_profile, profiles
            except Exception as e:
                logger.warning("Failed to parse HUD config at %s: %s", p, e)

    # Fallback to built-in profiles
    profiles = {name: parse_profile(name, d) for name, d in BUILTIN_PROFILES.items()}
    return "default", profiles


def match_hud_patterns(detected_texts: List[str], patterns: List[HudPattern]) -> List[HudPattern]:
    """Matches OCR detected strings against configured HUD patterns."""
    if not detected_texts or not patterns:
        return []

    matched: List[HudPattern] = []
    # Combine detected text strings
    full_text = " ".join(detected_texts).strip()
    full_text_clean = re.sub(r"[^a-zA-Z0-9\s]", " ", full_text).upper()
    full_text_spaceless = re.sub(r"\s+", "", full_text_clean)

    for pat in patterns:
        p_str = pat.pattern.strip()
        p_clean = re.sub(r"[^a-zA-Z0-9\s]", " ", p_str).upper().strip()
        p_spaceless = re.sub(r"\s+", "", p_clean)

        if not p_clean:
            continue

        # Check 1: exact word boundary match in cleaned text
        pattern_regex = r"\b" + re.escape(p_clean) + r"\b"
        if re.search(pattern_regex, full_text_clean):
            matched.append(pat)
            continue

        # Check 2: spaceless match for compound phrases (e.g. VICTORYROYALE for VICTORY ROYALE)
        if " " in p_str and len(p_spaceless) >= 5 and p_spaceless in full_text_spaceless:
            matched.append(pat)

    return matched


class HudTextExtractor:
    """Extracts on-screen HUD text from video frames via crop regions and RapidOCR."""

    def __init__(
        self,
        config_path: Optional[Union[str, Path]] = None,
        profile_name: Optional[str] = None,
        min_interval_seconds: float = 2.0,
        min_confidence: float = 0.50,
    ) -> None:
        self.config_path = config_path
        self.min_interval_seconds = min_interval_seconds
        self.min_confidence = min_confidence
        self._default_profile_name, self._profiles = load_hud_config(config_path)
        self._active_profile_name = profile_name or self._default_profile_name
        if self._active_profile_name not in self._profiles:
            self._active_profile_name = next(iter(self._profiles.keys()))

        self._ocr = None
        # Rate-limiting state per session
        self._last_call_stream_time: Dict[str, float] = {}
        self._last_call_wall_time: Dict[str, float] = {}
        self._last_signal: Dict[str, HudTextSignal] = {}

    @property
    def active_profile_name(self) -> str:
        return self._active_profile_name

    @property
    def active_profile(self) -> GameProfile:
        return self._profiles[self._active_profile_name]

    @property
    def profiles(self) -> Dict[str, GameProfile]:
        return self._profiles

    def set_profile(self, profile_name: str) -> bool:
        """Switches active game profile."""
        if profile_name in self._profiles:
            self._active_profile_name = profile_name
            return True
        return False

    def reload_config(self) -> None:
        """Reloads HUD profiles from configuration file."""
        self._default_profile_name, self._profiles = load_hud_config(self.config_path)
        if self._active_profile_name not in self._profiles:
            self._active_profile_name = self._default_profile_name

    def reset_session(self, session_id: Optional[str] = None) -> None:
        """Resets rate limiting and cached detection state for a session."""
        if session_id:
            self._last_call_stream_time.pop(session_id, None)
            self._last_call_wall_time.pop(session_id, None)
            self._last_signal.pop(session_id, None)
        else:
            self._last_call_stream_time.clear()
            self._last_call_wall_time.clear()
            self._last_signal.clear()

    def _get_ocr_engine(self):
        """Lazily initializes RapidOCR engine."""
        if self._ocr is None:
            from rapidocr_onnxruntime import RapidOCR
            self._ocr = RapidOCR()
        return self._ocr

    def _crop_box(self, img_w: int, img_h: int, box: List[float]) -> Tuple[int, int, int, int]:
        """Converts box coordinates (normalized or pixel) to clamped pixel coordinates."""
        if len(box) != 4:
            return 0, 0, img_w, img_h

        x1, y1, x2, y2 = box
        # If coordinates are <= 1.0, treat as normalized fractions
        if max(x1, y1, x2, y2) <= 1.0:
            left = int(x1 * img_w)
            top = int(y1 * img_h)
            right = int(x2 * img_w)
            bottom = int(y2 * img_h)
        else:
            left = int(x1)
            top = int(y1)
            right = int(x2)
            bottom = int(y2)

        left = max(0, min(left, img_w - 1))
        top = max(0, min(top, img_h - 1))
        right = max(left + 1, min(right, img_w))
        bottom = max(top + 1, min(bottom, img_h))
        return left, top, right, bottom

    def extract(
        self,
        frame_path: str,
        t_stream: Optional[float] = None,
        session_id: Optional[str] = None,
        force: bool = False,
    ) -> HudTextSignal:
        """Runs OCR on cropped HUD regions and returns hype score and matched patterns.
        
        Enforces rate limiting of at most 1 call per 2 seconds. When throttled, returns
        the cached signal from the previous run.
        """
        if not frame_path or not Path(frame_path).is_file():
            return HudTextSignal(value=None)

        sess_key = session_id or "default"
        now_wall = time.monotonic()

        # Check rate limiter unless force=True
        if not force:
            # 1. Stream time check
            if t_stream is not None and sess_key in self._last_call_stream_time:
                last_t = self._last_call_stream_time[sess_key]
                if 0.0 <= (t_stream - last_t) < self.min_interval_seconds:
                    return self._last_signal.get(
                        sess_key,
                        HudTextSignal(value=0.0, detail=HudTextDetail(matched=[])),
                    )

            # 2. Wall clock check (fallback when t_stream is absent or unchanging)
            if sess_key in self._last_call_wall_time:
                last_wall = self._last_call_wall_time[sess_key]
                if (now_wall - last_wall) < self.min_interval_seconds:
                    return self._last_signal.get(
                        sess_key,
                        HudTextSignal(value=0.0, detail=HudTextDetail(matched=[])),
                    )

        # Validate image file readability
        try:
            with Image.open(frame_path) as img:
                img_w, img_h = img.size
                if img_w <= 0 or img_h <= 0:
                    return HudTextSignal(value=None)
                # Convert to RGB
                img_rgb = img.convert("RGB")
        except Exception:
            return HudTextSignal(value=None)

        profile = self.active_profile
        crop_regions = profile.crop_regions
        patterns = profile.patterns

        # If no regions or patterns, return 0.0
        if not crop_regions or not patterns:
            sig = HudTextSignal(value=0.0, detail=HudTextDetail(matched=[]))
            self._update_state(sess_key, t_stream, now_wall, sig)
            return sig

        try:
            ocr = self._get_ocr_engine()
            detected_texts: List[str] = []

            for region in crop_regions:
                box = self._crop_box(img_w, img_h, region.box)
                crop_img = img_rgb.crop(box)
                crop_arr = np.array(crop_img)

                res, _ = ocr(crop_arr)
                if res:
                    for det in res:
                        # det structure: [box_points, text, confidence]
                        text = det[1]
                        conf = float(det[2])
                        if conf >= self.min_confidence and text:
                            detected_texts.append(text)

            matched_patterns = match_hud_patterns(detected_texts, patterns)

            if not matched_patterns:
                sig = HudTextSignal(value=0.0, detail=HudTextDetail(matched=[]))
            else:
                max_weight = max([p.weight for p in matched_patterns], default=0.0)
                # Cap at 1.0 and round to 3 decimals
                val = round(min(1.0, max_weight), 3)
                # Deduplicate pattern names maintaining order
                seen = set()
                matched_names = []
                for p in matched_patterns:
                    if p.pattern not in seen:
                        seen.add(p.pattern)
                        matched_names.append(p.pattern)
                sig = HudTextSignal(value=val, detail=HudTextDetail(matched=matched_names))

            self._update_state(sess_key, t_stream, now_wall, sig)
            return sig

        except Exception as e:
            logger.warning("Error running HUD text OCR: %s", e)
            return HudTextSignal(value=None)

    def _update_state(
        self,
        sess_key: str,
        t_stream: Optional[float],
        now_wall: float,
        sig: HudTextSignal,
    ) -> None:
        """Updates internal rate limiting timestamps and cached signal."""
        if t_stream is not None:
            self._last_call_stream_time[sess_key] = t_stream
        self._last_call_wall_time[sess_key] = now_wall
        self._last_signal[sess_key] = sig
