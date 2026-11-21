"""MobileNetV3-small frame classifier for visual stream state detection.

Evaluates 224x224 RGB video frames to classify stream state (action, lobby, victory,
elimination, idle) using ONNX Runtime with CUDAExecutionProvider and automatic logged
CPUExecutionProvider fallback. Meets the < 30 ms latency and < 1 GB VRAM budget.
"""

import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
import yaml
from PIL import Image

from .schemas import FrameClassifierSignal

logger = logging.getLogger("clipforge.detector.classifier")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
DEFAULT_MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "mobilenetv3_small.onnx"
SPIKE_MODEL_PATH = Path(__file__).resolve().parent.parent / "spike" / "models" / "mobilenetv3_small.onnx"
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "classifier.yaml"

DEFAULT_LABEL_MAP: Dict[int, Dict[str, Any]] = {
    0: {"name": "idle", "weight": 0.05, "description": "Static or inactive display"},
    1: {"name": "lobby", "weight": 0.15, "description": "Menu, lobby, character selection"},
    2: {"name": "action", "weight": 0.75, "description": "Active combat, movement, high gameplay"},
    3: {"name": "elimination", "weight": 0.85, "description": "Player knockout or death screen"},
    4: {"name": "victory", "weight": 0.95, "description": "Victory screen, champion celebration"},
}

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def preprocess_frame(
    image_or_path: Union[str, Path, Image.Image, np.ndarray],
    target_size: Tuple[int, int] = (224, 224),
    mean: Tuple[float, float, float] = IMAGENET_MEAN,
    std: Tuple[float, float, float] = IMAGENET_STD,
) -> np.ndarray:
    """Preprocesses an input image frame for MobileNetV3-small ONNX inference.
    
    1. Loads / converts image to 224x224 RGB.
    2. Scales pixel values to [0.0, 1.0].
    3. Normalizes using ImageNet channel mean and std.
    4. Transposes from (H, W, C) to (1, C, H, W) float32 tensor.
    """
    if isinstance(image_or_path, (str, Path)):
        p = Path(image_or_path)
        if not p.is_file():
            raise FileNotFoundError(f"Frame image not found: {p}")
        with Image.open(p) as img:
            img_rgb = img.convert("RGB")
            img_resized = img_rgb.resize(target_size, Image.BILINEAR)
    elif isinstance(image_or_path, Image.Image):
        img_resized = image_or_path.convert("RGB").resize(target_size, Image.BILINEAR)
    elif isinstance(image_or_path, np.ndarray):
        img = Image.fromarray(image_or_path).convert("RGB")
        img_resized = img.resize(target_size, Image.BILINEAR)
    else:
        raise TypeError(f"Unsupported image type: {type(image_or_path)}")

    # Convert to float32 [0.0, 1.0]
    arr = np.array(img_resized, dtype=np.float32) / 255.0

    # Normalize channels
    norm_mean = np.array(mean, dtype=np.float32)
    norm_std = np.array(std, dtype=np.float32)
    norm_arr = (arr - norm_mean) / norm_std

    # Transpose HWC -> CHW and add batch dimension -> (1, 3, 224, 224)
    tensor = np.transpose(norm_arr, (2, 0, 1))[np.newaxis, ...].astype(np.float32)
    return tensor


def load_classifier_config(config_path: Optional[Union[str, Path]] = None) -> Dict[int, Dict[str, Any]]:
    """Loads label map from configuration file or falls back to defaults."""
    candidates = []
    if config_path:
        candidates.append(Path(config_path))
    candidates.append(DEFAULT_CONFIG_PATH)

    for p in candidates:
        if p.is_file():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f) or {}
                raw_labels = data.get("labels", {})
                if raw_labels:
                    label_map = {}
                    for k, v in raw_labels.items():
                        idx = int(k)
                        label_map[idx] = {
                            "name": str(v.get("name", f"class_{idx}")),
                            "weight": float(v.get("weight", 0.5)),
                            "description": str(v.get("description", "")),
                        }
                    return label_map
            except Exception as e:
                logger.warning("Failed to load classifier config from %s: %s", p, e)

    return dict(DEFAULT_LABEL_MAP)


class FrameClassifier:
    """MobileNetV3-small ONNX frame classifier with CUDA and logged CPU fallback."""

    def __init__(
        self,
        model_path: Optional[Union[str, Path]] = None,
        config_path: Optional[Union[str, Path]] = None,
        preferred_provider: str = "CUDAExecutionProvider",
    ) -> None:
        self.model_path = self._resolve_model_path(model_path)
        self.label_map = load_classifier_config(config_path)
        self.preferred_provider = preferred_provider

        self._session = None
        self._active_provider: Optional[str] = None
        self._last_latency_ms: float = 0.0

    def _resolve_model_path(self, model_path: Optional[Union[str, Path]]) -> Path:
        """Finds existing MobileNetV3-small ONNX model file."""
        if model_path and Path(model_path).is_file():
            return Path(model_path)
        if DEFAULT_MODEL_PATH.is_file():
            return DEFAULT_MODEL_PATH
        if SPIKE_MODEL_PATH.is_file():
            return SPIKE_MODEL_PATH
        return DEFAULT_MODEL_PATH

    @property
    def active_provider(self) -> str:
        """Returns the active execution provider (CUDAExecutionProvider or CPUExecutionProvider)."""
        if self._active_provider is None:
            self._init_session()
        return self._active_provider or "CPUExecutionProvider"

    @property
    def last_latency_ms(self) -> float:
        return self._last_latency_ms

    def _init_session(self):
        """Initializes ONNX Runtime inference session with CUDA and logged CPU fallback."""
        if self._session is not None:
            return self._session

        import onnxruntime as ort

        if not self.model_path.is_file():
            raise FileNotFoundError(
                f"MobileNetV3-small ONNX model not found at {self.model_path}. "
                "Ensure workers/detector/models/mobilenetv3_small.onnx is present."
            )

        # 1. Attempt CUDAExecutionProvider if requested
        if self.preferred_provider == "CUDAExecutionProvider":
            try:
                available = ort.get_available_providers()
                if "CUDAExecutionProvider" in available:
                    sess = ort.InferenceSession(
                        str(self.model_path),
                        providers=["CUDAExecutionProvider"],
                    )
                    if "CUDAExecutionProvider" in sess.get_providers():
                        self._session = sess
                        self._active_provider = "CUDAExecutionProvider"
                        logger.info("FrameClassifier initialized with CUDAExecutionProvider on GPU.")
                        return self._session
            except Exception as e:
                logger.warning(
                    "CUDAExecutionProvider unavailable or failed to initialize (%s), falling back to CPUExecutionProvider",
                    e,
                )

        # 2. CPU fallback
        logger.info("FrameClassifier using CPUExecutionProvider (CPU fallback)")
        self._session = ort.InferenceSession(
            str(self.model_path),
            providers=["CPUExecutionProvider"],
        )
        self._active_provider = "CPUExecutionProvider"

        # Warm-up run to compile execution graph and avoid first-run latency spike
        try:
            dummy = np.zeros((1, 3, 224, 224), dtype=np.float32)
            self._session.run(None, {self._session.get_inputs()[0].name: dummy})
        except Exception as e:
            logger.debug("Classifier warmup failed: %s", e)

        return self._session

    def extract(self, frame_path: str) -> FrameClassifierSignal:
        """Evaluates video frame and returns FrameClassifierSignal conforming to CONTRACTS §3."""
        if not frame_path or not Path(frame_path).is_file():
            return FrameClassifierSignal(value=None, label=None)

        try:
            tensor = preprocess_frame(frame_path)
        except Exception as e:
            logger.warning("Failed to preprocess frame at %s: %s", frame_path, e)
            return FrameClassifierSignal(value=None, label=None)

        try:
            session = self._init_session()
            input_name = session.get_inputs()[0].name

            t0 = time.perf_counter()
            outputs = session.run(None, {input_name: tensor})[0]
            self._last_latency_ms = round((time.perf_counter() - t0) * 1000.0, 2)

            # Compute numerically stable softmax
            logits = outputs[0]
            exp_logits = np.exp(logits - np.max(logits))
            probs = exp_logits / np.sum(exp_logits)
            pred_idx = int(np.argmax(probs))

            label_entry = self.label_map.get(pred_idx, {"name": "action", "weight": 0.5})
            label_name = str(label_entry["name"])
            val = float(label_entry["weight"])

            return FrameClassifierSignal(value=val, label=label_name)

        except Exception as e:
            logger.warning("Error running frame classifier ONNX inference: %s", e)
            return FrameClassifierSignal(value=None, label=None)
