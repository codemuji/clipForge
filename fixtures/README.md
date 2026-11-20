# clipforge Test Fixtures

This directory contains deterministic test fixtures for local testing and CI.
In accordance with AGENTS.md §5 and §10:
- Deterministic tests run strictly against fixture files in `fixtures/`, never against live streams.
- CI does not require external network access.
- All fixture videos are synthesized programmatically using FFmpeg lavfi filters (CC0 / Public Domain / Self-Generated). No third-party copyrighted footage is included.
- All files are small (~2.6 MB each, well under the 20 MB git tracking limit).

---

## 1. Fixture Inventory

### `quiet_session.mp4`
- **Duration:** 60.0 seconds (1800 frames @ 30 fps, 1280×720, H.264 Baseline, AAC 16 kHz mono).
- **Video Content:** Synthetic moving SMPTE color bars (`testsrc`) without HUD text.
- **Audio Content:** Continuous low-amplitude 200 Hz tone at approximately -35 LUFS (`volume=0.02`).
- **Expected Detections:**
  - `audio.value`: Low (< 0.25).
  - `speech_keywords.value`: 0.0 (no speech).
  - `hud_text.value`: 0.0 (no overlay text).
  - `fused_score`: < 0.30 throughout. Zero clips cut.

### `loud_burst.mp4`
- **Duration:** 60.0 seconds (1800 frames @ 30 fps, 1280×720, H.264 Baseline, AAC 16 kHz mono).
- **Video Content:** Synthetic moving pattern without HUD text.
- **Audio Content:**
  - `0.0s – 25.0s`: Baseline low audio (`volume=0.02`).
  - `25.0s – 35.0s`: High-energy audio burst (`volume=1.0`, peak volume jump +18 dB, peak at t=30.0s).
  - `35.0s – 60.0s`: Returns to baseline low audio (`volume=0.02`).
- **Expected Detections:**
  - `25.0s – 35.0s`: Audio score surges to > 0.80, crossing the default 0.72 fused threshold.
  - Generates exactly 1 clip job covering `[t_stream - 10s, t_stream + 8s]`.

### `hud_overlay.mp4`
- **Duration:** 60.0 seconds (1800 frames @ 30 fps, 1280×720, H.264 Baseline, AAC 16 kHz mono).
- **Video Content:**
  - `0.0s – 20.0s`: Baseline moving pattern without overlay.
  - `20.0s – 25.0s`: Prominent golden banner overlay: `"VICTORY ROYALE"` centered at y=100.
  - `25.0s – 60.0s`: Baseline moving pattern without overlay.
- **Audio Content:** Constant low-level tone (`volume=0.03`).
- **Expected Detections:**
  - `20.0s – 25.0s`: OCR / HUD pattern matching triggers on `VICTORY ROYALE` with score > 0.85.

---

## 2. Generation Command

All fixtures can be deterministically regenerated with:
```bash
# 1. Quiet baseline
ffmpeg -y -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i "sine=frequency=200:sample_rate=16000,volume=0.02" -t 60 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k fixtures/quiet_session.mp4

# 2. Loud burst hype event
ffmpeg -y -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i "sine=frequency=440:sample_rate=16000,volume='if(between(t,25,35),1.0,0.02)':eval=frame" -t 60 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k fixtures/loud_burst.mp4

# 3. HUD overlay text event
ffmpeg -y -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i "sine=frequency=250:sample_rate=16000,volume=0.03" -vf "drawtext=fontfile=/Windows/Fonts/arial.ttf:text='VICTORY ROYALE':fontcolor=yellow:fontsize=48:x=(w-text_w)/2:y=100:enable='between(t,20,25)'" -t 60 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k fixtures/hud_overlay.mp4
```

## 3. Licence

These fixture clips were generated synthetically using FFmpeg built-in generators (`lavfi`) and are released into the public domain under **Creative Commons CC0 1.0 Universal**.
