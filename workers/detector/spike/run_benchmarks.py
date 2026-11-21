"""
Detector Model Spike Benchmark (S0-2)
Measures:
1. whisper.cpp base.en and small.en (+ quantized), real-time factor on CPU.
2. PaddleOCR (RapidOCR / PP-OCR) vs Tesseract on 50 HUD crop frames: accuracy and time per call.
3. MobileNetV3-small on RTX 3050 with ONNX Runtime CUDA: time per frame and VRAM use (+ CPU fallback).
"""

import os
import sys
import time
import json
import wave
import struct
import math
import subprocess
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Set up paths
SPIKE_DIR = Path(__file__).resolve().parent
DATA_DIR = SPIKE_DIR / "data"
MODELS_DIR = SPIKE_DIR / "models"
RESULTS_FILE = SPIKE_DIR / "benchmark_results.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

TESSERACT_EXE = SPIKE_DIR.parent / "tesseract" / "tesseract.exe"
if TESSERACT_EXE.exists():
    import pytesseract
    pytesseract.pytesseract.tesseract_cmd = str(TESSERACT_EXE)
    os.environ["TESSDATA_PREFIX"] = str(TESSERACT_EXE.parent / "tessdata")


def get_gpu_memory_mb():
    """Query current GPU VRAM usage via nvidia-smi."""
    try:
        res = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total,memory.free", "--format=csv,nounits,noheader"],
            capture_output=True, text=True, check=True
        )
        parts = res.stdout.strip().split(",")
        return {
            "used_mb": float(parts[0].strip()),
            "total_mb": float(parts[1].strip()),
            "free_mb": float(parts[2].strip()),
        }
    except Exception as e:
        return {"error": str(e), "used_mb": 0.0, "total_mb": 0.0, "free_mb": 0.0}


# ==========================================
# 1. WHISPER.CPP BENCHMARK
# ==========================================
def generate_synthetic_audio(wav_path: Path, duration_s: float = 10.0, sample_rate: int = 16000):
    """Generate a clean 16kHz mono WAV file with synthetic tone bursts (simulating speech windows)."""
    num_samples = int(duration_s * sample_rate)
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        # Tone + modulation
        samples = []
        for i in range(num_samples):
            t = float(i) / sample_rate
            # 220Hz carrier with 4Hz envelope modulation
            val = 0.5 * math.sin(2 * math.pi * 220 * t) * (0.5 + 0.5 * math.sin(2 * math.pi * 4 * t))
            int_val = int(val * 32767)
            samples.append(struct.pack("<h", max(-32768, min(32767, int_val))))
        wf.writeframes(b"".join(samples))


def benchmark_whisper():
    print("\n--- Running whisper.cpp Benchmarks ---")
    results = {}
    from pywhispercpp.model import Model

    test_wav = DATA_DIR / "test_audio_10s.wav"
    audio_duration = 10.0
    generate_synthetic_audio(test_wav, duration_s=audio_duration)

    models_to_test = [
        ("base.en", "base.en"),
        ("base.en-q5_1", "base.en-q5_1"),
        ("small.en", "small.en"),
        ("small.en-q5_1", "small.en-q5_1"),
    ]

    for label, model_name in models_to_test:
        print(f"Testing whisper.cpp [{label}] with 6 threads...")
        try:
            m = Model(model_name, n_threads=6)
            # Warmup
            m.transcribe(str(test_wav))
            # Timed runs
            times = []
            for _ in range(3):
                t0 = time.perf_counter()
                segments = m.transcribe(str(test_wav))
                t1 = time.perf_counter()
                times.append(t1 - t0)
            
            avg_time = float(np.mean(times))
            rtf = avg_time / audio_duration
            p95_time = float(np.percentile(times, 95))
            
            results[label] = {
                "audio_duration_s": audio_duration,
                "avg_transcribe_time_s": round(avg_time, 3),
                "rtf": round(rtf, 4),
                "p95_time_s": round(p95_time, 3),
                "threads": 6,
                "meets_budget": rtf < 0.5,
            }
            print(f"  -> {label}: avg {avg_time:.2f}s, RTF={rtf:.3f} (Budget < 0.5: {'PASS' if rtf < 0.5 else 'FAIL'})")
        except Exception as e:
            print(f"  -> Failed to benchmark {label}: {e}")
            results[label] = {"error": str(e), "meets_budget": False}

    return results


# ==========================================
# 2. OCR BENCHMARK (PaddleOCR vs Tesseract)
# ==========================================
def generate_hud_crop_dataset(num_frames: int = 50):
    """Generate 50 synthetic HUD crop images with ground-truth text, typical of game HUDs."""
    crops_dir = DATA_DIR / "hud_crops"
    crops_dir.mkdir(parents=True, exist_ok=True)
    
    hud_vocab = [
        "KILLS: 14", "DEFEAT", "VICTORY", "ROUND 3/5", "SCORE: 2450",
        "HP: 100/100", "AMMO: 30/90", "OVERTIME", "HEADSHOT", "COMBO x4",
        "STREAK: 5", "RANK: #1", "ACE!", "FIRST BLOOD", "LEVEL UP",
        "PING: 24ms", "FPS: 144", "TIME 02:45", "MATCH POINT", "ZONE SHRINKING",
        "ARMOR: 75", "SHIELD 50", "ASSISTS: 8", "DEATHS: 2", "DAMAGE: 3120",
        "ULTIMATE READY", "WARNING", "DEFEND A", "ATTACK B", "RELOAD",
        "LEADERBOARD", "KILLSTREAK", "CRITICAL HIT", "REVIVING...", "KNOCKED DOWN",
        "WINNER", "DRAW", "FINAL ROUND", "NEXUS 80%", "STAMINA: 90",
        "GOLD: 12500", "XP: 84000", "OBJECTIVE", "SURVIVED", "STAGE CLEAR",
        "WAVE 12/20", "ENERGY: 100", "BOUNTY $500", "SPEED: 280", "TARGET SPOTTED"
    ]
    
    samples = []
    for i in range(num_frames):
        text = hud_vocab[i % len(hud_vocab)]
        # Typical HUD crop dimensions: 240x60 or 320x80
        w, h = 280, 70
        # Dark HUD background with varying transparency and contrast
        bg_val = np.random.randint(15, 50)
        img = Image.new("RGB", (w, h), color=(bg_val, bg_val, bg_val + 5))
        draw = ImageDraw.Draw(img)
        
        # HUD border or subtle box
        draw.rectangle([2, 2, w - 3, h - 3], outline=(bg_val + 40, bg_val + 40, bg_val + 50), width=1)
        
        # High contrast text color (white, bright cyan, neon yellow, neon red)
        colors = [(255, 255, 255), (0, 255, 255), (255, 220, 0), (255, 80, 80), (100, 255, 100)]
        text_color = colors[i % len(colors)]
        
        # Draw text centered
        draw.text((15, 20), text, fill=text_color)
        
        # Add subtle game background noise / gradient
        arr = np.array(img).astype(np.int16)
        noise = np.random.randint(-10, 10, arr.shape, dtype=np.int16)
        arr = np.clip(arr + noise, 0, 255).astype(np.uint8)
        img = Image.fromarray(arr)
        
        img_path = crops_dir / f"hud_{i:03d}.png"
        img.save(img_path)
        samples.append({"path": str(img_path), "ground_truth": text})
        
    return samples


def levenshtein_similarity(s1: str, s2: str) -> float:
    """Compute character-level normalized similarity between two strings."""
    s1, s2 = s1.strip().upper(), s2.strip().upper()
    if not s1 and not s2:
        return 1.0
    if not s1 or not s2:
        return 0.0
    
    m, n = len(s1), len(s2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if s1[i - 1] == s2[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    dist = dp[m][n]
    max_len = max(m, n)
    return max(0.0, 1.0 - (dist / max_len))


def benchmark_ocr():
    print("\n--- Running OCR Comparison (PaddleOCR / RapidOCR vs Tesseract) ---")
    samples = generate_hud_crop_dataset(num_frames=50)
    
    # 1. RapidOCR (PaddleOCR ONNX)
    from rapidocr_onnxruntime import RapidOCR
    rapid_engine = RapidOCR()
    
    # Warmup
    rapid_engine(samples[0]["path"])
    
    rapid_times = []
    rapid_exact_matches = 0
    rapid_similarities = []
    
    for item in samples:
        t0 = time.perf_counter()
        result, elapse_list = rapid_engine(item["path"])
        t1 = time.perf_counter()
        rapid_times.append((t1 - t0) * 1000.0)  # ms
        
        extracted_text = ""
        if result:
            extracted_text = " ".join([line[1] for line in result]).strip()
        
        gt = item["ground_truth"]
        sim = levenshtein_similarity(extracted_text, gt)
        rapid_similarities.append(sim)
        if sim >= 0.95 or extracted_text.upper() == gt.upper():
            rapid_exact_matches += 1

    # 2. Tesseract OCR
    import pytesseract
    # Warmup
    pytesseract.image_to_string(Image.open(samples[0]["path"]), config="--psm 7")
    
    tess_times = []
    tess_exact_matches = 0
    tess_similarities = []
    
    for item in samples:
        img = Image.open(item["path"])
        t0 = time.perf_counter()
        extracted_text = pytesseract.image_to_string(img, config="--psm 7").strip()
        t1 = time.perf_counter()
        tess_times.append((t1 - t0) * 1000.0)  # ms
        
        gt = item["ground_truth"]
        sim = levenshtein_similarity(extracted_text, gt)
        tess_similarities.append(sim)
        if sim >= 0.95 or extracted_text.upper() == gt.upper():
            tess_exact_matches += 1

    results = {
        "dataset_frames": 50,
        "paddleocr": {
            "engine": "PaddleOCR (RapidOCR PP-OCRv4 ONNX)",
            "exact_match_pct": round(rapid_exact_matches / 50.0 * 100.0, 1),
            "char_similarity_avg_pct": round(float(np.mean(rapid_similarities)) * 100.0, 1),
            "latency_mean_ms": round(float(np.mean(rapid_times)), 2),
            "latency_p50_ms": round(float(np.median(rapid_times)), 2),
            "latency_p95_ms": round(float(np.percentile(rapid_times, 95)), 2),
            "meets_budget": float(np.mean(rapid_times)) < 2000.0,  # 1 call per 2s
        },
        "tesseract": {
            "engine": "Tesseract 5.4.0 (--psm 7)",
            "exact_match_pct": round(tess_exact_matches / 50.0 * 100.0, 1),
            "char_similarity_avg_pct": round(float(np.mean(tess_similarities)) * 100.0, 1),
            "latency_mean_ms": round(float(np.mean(tess_times)), 2),
            "latency_p50_ms": round(float(np.median(tess_times)), 2),
            "latency_p95_ms": round(float(np.percentile(tess_times, 95)), 2),
            "meets_budget": float(np.mean(tess_times)) < 2000.0,
        }
    }
    
    print(f"PaddleOCR Accuracy: {results['paddleocr']['exact_match_pct']}% exact ({results['paddleocr']['char_similarity_avg_pct']}% sim), Latency: {results['paddleocr']['latency_mean_ms']:.1f}ms")
    print(f"Tesseract Accuracy: {results['tesseract']['exact_match_pct']}% exact ({results['tesseract']['char_similarity_avg_pct']}% sim), Latency: {results['tesseract']['latency_mean_ms']:.1f}ms")
    return results


# ==========================================
# 3. MOBILENETV3-SMALL BENCHMARK (RTX 3050 CUDA & CPU)
# ==========================================
def export_mobilenetv3_to_onnx(onnx_path: Path):
    """Export standard MobileNetV3-small to ONNX format."""
    import torch
    import torchvision.models as models
    
    if onnx_path.exists():
        return
    
    print("Exporting MobileNetV3-Small to ONNX...")
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.DEFAULT)
    model.eval()
    
    dummy_input = torch.randn(1, 3, 224, 224)
    torch.onnx.export(
        model,
        dummy_input,
        str(onnx_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch_size"}, "output": {0: "batch_size"}},
        opset_version=17,
    )
    print(f"Model exported to {onnx_path} ({onnx_path.stat().st_size / (1024*1024):.1f} MB)")


def benchmark_mobilenetv3():
    print("\n--- Running MobileNetV3-small Benchmarks (RTX 3050 CUDA & CPU) ---")
    import onnxruntime as ort
    
    onnx_path = MODELS_DIR / "mobilenetv3_small.onnx"
    export_mobilenetv3_to_onnx(onnx_path)
    
    gpu_before = get_gpu_memory_mb()
    
    # 1. CUDA Execution Provider
    cuda_available = "CUDAExecutionProvider" in ort.get_available_providers()
    cuda_results = {}
    if cuda_available:
        try:
            print("Benchmarking with CUDAExecutionProvider on RTX 3050...")
            session_cuda = ort.InferenceSession(str(onnx_path), providers=["CUDAExecutionProvider"])
            gpu_after_load = get_gpu_memory_mb()
            
            # Warmup
            dummy = np.random.randn(1, 3, 224, 224).astype(np.float32)
            input_name = session_cuda.get_inputs()[0].name
            for _ in range(20):
                session_cuda.run(None, {input_name: dummy})
            
            gpu_after_warmup = get_gpu_memory_mb()
            
            # 100 inference passes
            latencies = []
            for _ in range(100):
                t0 = time.perf_counter()
                session_cuda.run(None, {input_name: dummy})
                t1 = time.perf_counter()
                latencies.append((t1 - t0) * 1000.0)  # ms
            
            vram_model_mb = max(0.0, gpu_after_warmup["used_mb"] - gpu_before["used_mb"])
            mean_lat = float(np.mean(latencies))
            p95_lat = float(np.percentile(latencies, 95))
            
            cuda_results = {
                "available": True,
                "latency_mean_ms": round(mean_lat, 2),
                "latency_p50_ms": round(float(np.median(latencies)), 2),
                "latency_p95_ms": round(p95_lat, 2),
                "latency_min_ms": round(float(np.min(latencies)), 2),
                "vram_allocated_mb": round(vram_model_mb, 1),
                "vram_total_used_mb": round(gpu_after_warmup["used_mb"], 1),
                "vram_budget_limit_mb": 1024.0,  # 1 GB
                "latency_budget_limit_ms": 30.0,  # 30 ms
                "meets_latency_budget": mean_lat < 30.0,
                "meets_vram_budget": vram_model_mb < 1024.0,
            }
            print(f"  -> CUDA: mean {mean_lat:.2f}ms (p95: {p95_lat:.2f}ms), VRAM model: ~{vram_model_mb:.1f}MB (Total GPU: {gpu_after_warmup['used_mb']}MB)")
        except Exception as e:
            print(f"  -> CUDA benchmark failed: {e}")
            cuda_results = {"available": False, "error": str(e)}
    else:
        cuda_results = {"available": False, "error": "CUDAExecutionProvider not available"}

    # 2. CPU Execution Provider (Fallback)
    print("Benchmarking with CPUExecutionProvider (fallback)...")
    session_cpu = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    dummy = np.random.randn(1, 3, 224, 224).astype(np.float32)
    input_name = session_cpu.get_inputs()[0].name
    for _ in range(10):
        session_cpu.run(None, {input_name: dummy})
    
    cpu_latencies = []
    for _ in range(50):
        t0 = time.perf_counter()
        session_cpu.run(None, {input_name: dummy})
        t1 = time.perf_counter()
        cpu_latencies.append((t1 - t0) * 1000.0)
        
    cpu_mean = float(np.mean(cpu_latencies))
    cpu_p95 = float(np.percentile(cpu_latencies, 95))
    cpu_results = {
        "latency_mean_ms": round(cpu_mean, 2),
        "latency_p50_ms": round(float(np.median(cpu_latencies)), 2),
        "latency_p95_ms": round(cpu_p95, 2),
        "meets_latency_budget": cpu_mean < 30.0,
    }
    print(f"  -> CPU: mean {cpu_mean:.2f}ms (p95: {cpu_p95:.2f}ms)")
    
    return {
        "cuda": cuda_results,
        "cpu_fallback": cpu_results,
    }


def main():
    print("=== Starting Detector Stack Spike Benchmarks (S0-2) ===")
    whisper_data = benchmark_whisper()
    ocr_data = benchmark_ocr()
    mobilenet_data = benchmark_mobilenetv3()
    
    final_report = {
        "hardware": {
            "cpu": "AMD Ryzen 5 7000-series (HS)",
            "gpu": "NVIDIA GeForce RTX 3050 Laptop GPU (6144 MB VRAM)",
            "os": "Windows 11 / WSL2",
            "python": sys.version.split()[0],
        },
        "whisper": whisper_data,
        "ocr": ocr_data,
        "mobilenetv3": mobilenet_data,
    }
    
    with open(RESULTS_FILE, "w") as f:
        json.dump(final_report, f, indent=2)
    print(f"\nAll benchmark results successfully written to {RESULTS_FILE}")


if __name__ == "__main__":
    main()
