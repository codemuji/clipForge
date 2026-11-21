"""Frame labelling tool for clipforge highlight detector (B-06).

Computes deterministic frame hashes and manages labelled ground-truth CSV datasets
in fixtures/labels/ for evaluating detector signal accuracy.
"""

import argparse
import csv
import hashlib
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
LABELS_DIR = REPO_ROOT / "fixtures" / "labels"
DEFAULT_LABELS_CSV = LABELS_DIR / "ground_truth.csv"

VALID_LABELS = {"idle", "lobby", "action", "elimination", "victory"}


def compute_frame_hash(image_or_path: Union[str, Path, Image.Image, np.ndarray]) -> str:
    """Computes a deterministic 16-hex perceptual/content SHA-256 hash of a video frame.
    
    Normalizes frame to 224x224 RGB to ensure invariance across file encodings/compression.
    """
    if isinstance(image_or_path, (str, Path)):
        p = Path(image_or_path)
        if not p.is_file():
            raise FileNotFoundError(f"Frame image not found: {p}")
        with Image.open(p) as img:
            rgb_img = img.convert("RGB").resize((224, 224), Image.BILINEAR)
    elif isinstance(image_or_path, Image.Image):
        rgb_img = image_or_path.convert("RGB").resize((224, 224), Image.BILINEAR)
    elif isinstance(image_or_path, np.ndarray):
        img = Image.fromarray(image_or_path).convert("RGB")
        rgb_img = img.resize((224, 224), Image.BILINEAR)
    else:
        raise TypeError(f"Unsupported image type: {type(image_or_path)}")

    raw_bytes = rgb_img.tobytes()
    return hashlib.sha256(raw_bytes).hexdigest()[:16]


def extract_frame_at_timestamp(video_path: Union[str, Path], t_stream: float) -> str:
    """Extracts a single frame from video at t_stream using ffmpeg into a temporary file."""
    v_path = Path(video_path)
    if not v_path.is_file():
        raise FileNotFoundError(f"Video file not found: {v_path}")

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        tmp_output = f.name

    res = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{t_stream:.3f}",
            "-i",
            str(v_path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            tmp_output,
        ],
        capture_output=True,
    )
    if res.returncode != 0:
        if os.path.exists(tmp_output):
            os.remove(tmp_output)
        raise RuntimeError(f"ffmpeg frame extraction failed: {res.stderr.decode()}")

    return tmp_output


def save_label(
    frame_hash: str,
    label: str,
    source: str = "",
    t_stream: float = 0.0,
    csv_path: Union[str, Path] = DEFAULT_LABELS_CSV,
) -> None:
    """Appends or updates a frame hash label entry in the labels CSV."""
    if label not in VALID_LABELS:
        raise ValueError(f"Invalid label '{label}'. Must be one of {sorted(VALID_LABELS)}")

    p = Path(csv_path)
    p.parent.mkdir(parents=True, exist_ok=True)

    records = load_labels(p) if p.is_file() else {}
    records[frame_hash] = {
        "label": label,
        "source": source,
        "t_stream": round(t_stream, 3),
    }

    with open(p, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["frame_hash", "label", "source", "t_stream"])
        for h, meta in sorted(records.items()):
            writer.writerow([h, meta["label"], meta["source"], meta["t_stream"]])


def load_labels(csv_path: Union[str, Path] = DEFAULT_LABELS_CSV) -> Dict[str, Dict[str, Any]]:
    """Loads frame hash labels from CSV into a dictionary keyed by frame_hash."""
    p = Path(csv_path)
    if not p.is_file():
        return {}

    labels = {}
    with open(p, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            h = row.get("frame_hash", "").strip()
            lbl = row.get("label", "").strip()
            src = row.get("source", "").strip()
            t_str = row.get("t_stream", "0.0").strip()
            if h and lbl:
                try:
                    t_val = float(t_str)
                except ValueError:
                    t_val = 0.0
                labels[h] = {"label": lbl, "source": src, "t_stream": t_val}

    return labels


def label_video_sample(
    video_path: Union[str, Path],
    timestamps: List[float],
    label: str,
    csv_path: Union[str, Path] = DEFAULT_LABELS_CSV,
) -> List[Tuple[str, float]]:
    """Extracts frames at timestamps, computes hashes, and saves them to labels CSV."""
    results = []
    v_path = Path(video_path)
    for t in timestamps:
        tmp_frame = extract_frame_at_timestamp(v_path, t)
        try:
            h = compute_frame_hash(tmp_frame)
            save_label(
                frame_hash=h,
                label=label,
                source=v_path.name,
                t_stream=t,
                csv_path=csv_path,
            )
            results.append((h, t))
        finally:
            if os.path.exists(tmp_frame):
                os.remove(tmp_frame)
    return results


def main():
    parser = argparse.ArgumentParser(description="clipforge Frame Labelling Tool")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Subcommand: hash
    hash_parser = subparsers.add_parser("hash", help="Compute hash for an image frame")
    hash_parser.add_argument("frame_path", type=str, help="Path to frame image")

    # Subcommand: add
    add_parser = subparsers.add_parser("add", help="Add or update a frame label")
    add_parser.add_argument("frame_path", type=str, help="Path to frame image")
    add_parser.add_argument("label", type=str, choices=sorted(VALID_LABELS), help="Target label")
    add_parser.add_argument("--source", type=str, default="", help="Video source name")
    add_parser.add_argument("--time", type=float, default=0.0, help="Stream timestamp in seconds")
    add_parser.add_argument("--csv", type=str, default=str(DEFAULT_LABELS_CSV), help="CSV path")

    # Subcommand: label-video
    v_parser = subparsers.add_parser("label-video", help="Sample and label frames from video")
    v_parser.add_argument("video_path", type=str, help="Path to video file")
    v_parser.add_argument("--label", type=str, required=True, choices=sorted(VALID_LABELS))
    v_parser.add_argument("--timestamps", type=float, nargs="+", required=True)
    v_parser.add_argument("--csv", type=str, default=str(DEFAULT_LABELS_CSV), help="CSV path")

    # Subcommand: list
    list_parser = subparsers.add_parser("list", help="List labelled frames")
    list_parser.add_argument("--csv", type=str, default=str(DEFAULT_LABELS_CSV), help="CSV path")

    args = parser.parse_args()

    if args.command == "hash":
        h = compute_frame_hash(args.frame_path)
        print(f"Frame hash: {h}")

    elif args.command == "add":
        h = compute_frame_hash(args.frame_path)
        save_label(h, args.label, args.source, args.time, args.csv)
        print(f"Saved: {h} -> {args.label} ({args.source} @ {args.time}s)")

    elif args.command == "label-video":
        labelled = label_video_sample(args.video_path, args.timestamps, args.label, args.csv)
        print(f"Labelled {len(labelled)} frames from {args.video_path}:")
        for h, t in labelled:
            print(f"  t={t:.2f}s: hash={h} ({args.label})")

    elif args.command == "list":
        labels = load_labels(args.csv)
        print(f"Loaded {len(labels)} labelled frames from {args.csv}:")
        for h, meta in sorted(labels.items()):
            print(f"  {h}: {meta['label']:<12} {meta['source']} @ {meta['t_stream']}s")


if __name__ == "__main__":
    main()
