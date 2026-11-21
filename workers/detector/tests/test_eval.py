"""Unit tests for detector labelling tool and evaluation metrics (B-06).

Verifies frame hash computation, ground-truth CSV storage, evaluation metrics calculation,
threshold sweep behavior on toy set, and CLI commands.
"""

import csv
import tempfile
from pathlib import Path
from typing import Generator

import numpy as np
import pytest
from PIL import Image

from workers.detector.src.eval import (
    calculate_metrics,
    evaluate_from_csv,
    run_threshold_sweep,
)
from workers.detector.src.label_tool import (
    VALID_LABELS,
    compute_frame_hash,
    load_labels,
    save_label,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
LABELS_DIR = REPO_ROOT / "fixtures" / "labels"
TOY_LABELS_CSV = LABELS_DIR / "toy_labels.csv"
GROUND_TRUTH_CSV = LABELS_DIR / "ground_truth.csv"


# =====================================================================
# Unit Tests: Frame Hashing and Storage
# =====================================================================


def test_compute_frame_hash_deterministic():
    """Identical frame contents produce identical 16-hex hashes."""
    img1 = Image.new("RGB", (320, 240), color=(100, 150, 200))
    img2 = Image.new("RGB", (320, 240), color=(100, 150, 200))
    img3 = Image.new("RGB", (320, 240), color=(50, 25, 12))

    h1 = compute_frame_hash(img1)
    h2 = compute_frame_hash(img2)
    h3 = compute_frame_hash(img3)

    assert len(h1) == 16
    assert h1 == h2
    assert h1 != h3


def test_compute_frame_hash_from_file_and_numpy():
    """Accepts file paths and numpy ndarray inputs."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        tmp_img = f.name
    img = Image.new("RGB", (128, 128), color=(20, 40, 60))
    img.save(tmp_img, "PNG")

    try:
        h_file = compute_frame_hash(tmp_img)
        arr = np.array(img)
        h_arr = compute_frame_hash(arr)
        assert h_file == h_arr
    finally:
        Path(tmp_img).unlink(missing_ok=True)


def test_save_and_load_labels_csv():
    """save_label appends valid entries and load_labels reads them accurately."""
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as f:
        tmp_csv = f.name

    try:
        save_label("hash_001", "idle", source="stream1.mp4", t_stream=10.5, csv_path=tmp_csv)
        save_label("hash_002", "victory", source="stream1.mp4", t_stream=25.0, csv_path=tmp_csv)

        records = load_labels(tmp_csv)
        assert len(records) == 2
        assert records["hash_001"]["label"] == "idle"
        assert records["hash_001"]["t_stream"] == 10.5
        assert records["hash_002"]["label"] == "victory"
        assert records["hash_002"]["source"] == "stream1.mp4"
    finally:
        Path(tmp_csv).unlink(missing_ok=True)


def test_save_label_rejects_invalid_label():
    """save_label raises ValueError when given an unknown label."""
    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as f:
        tmp_csv = f.name

    try:
        with pytest.raises(ValueError) as excinfo:
            save_label("hash_invalid", "unknown_state", csv_path=tmp_csv)
        assert "Invalid label" in str(excinfo.value)
    finally:
        Path(tmp_csv).unlink(missing_ok=True)


# =====================================================================
# Unit Tests: Evaluation Metrics & Threshold Sweep on Toy Set
# =====================================================================


def test_calculate_metrics_perfect_classification():
    """Perfect classification achieves 1.0 precision, recall, and F1."""
    y_true = [1, 1, 1, 0, 0]
    y_pred = [1, 1, 1, 0, 0]

    m = calculate_metrics(y_true, y_pred)
    assert m["precision"] == 1.0
    assert m["recall"] == 1.0
    assert m["f1"] == 1.0
    assert m["accuracy"] == 1.0
    assert m["tp"] == 3
    assert m["tn"] == 2
    assert m["fp"] == 0
    assert m["fn"] == 0


def test_calculate_metrics_mixed_classification():
    """Mixed predictions correctly reflect TP, FP, FN, TN and metric formulas."""
    y_true = [1, 1, 0, 0]
    y_pred = [1, 0, 1, 0]

    m = calculate_metrics(y_true, y_pred)
    assert m["tp"] == 1
    assert m["fn"] == 1
    assert m["fp"] == 1
    assert m["tn"] == 1
    assert m["precision"] == 0.5  # 1 / (1 + 1)
    assert m["recall"] == 0.5     # 1 / (1 + 1)
    assert m["f1"] == 0.5


def test_calculate_metrics_all_negative_predictions():
    """All-negative predictions yield zero recall and zero F1."""
    y_true = [1, 1, 0, 0]
    y_pred = [0, 0, 0, 0]

    m = calculate_metrics(y_true, y_pred)
    assert m["tp"] == 0
    assert m["recall"] == 0.0
    assert m["f1"] == 0.0
    assert m["tn"] == 2


def test_run_threshold_sweep_toy_set():
    """Threshold sweep correctly sweeps thresholds and computes metrics at each step."""
    y_true = [1, 1, 1, 0, 0]
    scores = [0.95, 0.85, 0.65, 0.20, 0.05]

    sweep = run_threshold_sweep(y_true, scores, thresholds=[0.1, 0.5, 0.7, 0.9])
    assert len(sweep) == 4

    # At threshold 0.1: all positive except 0.05 (4 positive: 3 TP, 1 FP)
    step_01 = sweep[0]
    assert step_01["threshold"] == 0.1
    assert step_01["tp"] == 3
    assert step_01["fp"] == 1

    # At threshold 0.7: scores >= 0.7 are 0.95 and 0.85 (2 TP, 0 FP, 1 FN)
    step_07 = sweep[2]
    assert step_07["threshold"] == 0.7
    assert step_07["tp"] == 2
    assert step_07["fp"] == 0
    assert step_07["fn"] == 1
    assert step_07["precision"] == 1.0


# =====================================================================
# Integration Tests: Toy Dataset CSV Evaluation
# =====================================================================


def test_evaluate_from_csv_toy_dataset():
    """evaluate_from_csv executes threshold sweep against fixtures/labels/toy_labels.csv."""
    assert TOY_LABELS_CSV.is_file(), "toy_labels.csv fixture missing"

    sweep, best = evaluate_from_csv(TOY_LABELS_CSV)
    assert len(sweep) == 9  # 0.1 to 0.9
    assert best["f1"] > 0.0
    assert "threshold" in best
    assert "precision" in best
    assert "recall" in best


def test_ground_truth_labels_csv_validity():
    """fixtures/labels/ground_truth.csv contains valid hashes and recognized labels."""
    assert GROUND_TRUTH_CSV.is_file(), "ground_truth.csv fixture missing"
    records = load_labels(GROUND_TRUTH_CSV)
    assert len(records) >= 5
    for h, meta in records.items():
        assert len(h) == 16
        assert meta["label"] in VALID_LABELS
        assert meta["t_stream"] >= 0.0
