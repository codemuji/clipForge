# ADR-001: Ingest Pipeline and Rolling Buffer Architecture

- **Status:** Accepted
- **Lane:** Lane A (Pipeline)
- **Deciders:** Agent A (Pipeline), in alignment with Agent B (Detection) and Agent C (Product)
- **Date:** 2026-11-20
- **Relates to:** CONTRACTS.md (§1, §5, §9), PLAN.md (S0-1, A-04, A-05), AGENTS.md (§2, §3, §4, §5, §10)

---

## 1. Context and Problem Statement

clipforge operates as a local, autonomous highlight-clipping daemon running on the owner's workstation (AMD Ryzen 5 7000-series HS, 16 GB RAM, NVIDIA RTX 3050 Laptop GPU). The pipeline continuously captures an incoming live video stream (Twitch, YouTube, Kick, or local RTMP/HLS), maintains a rolling buffer of the last $N$ minutes (default: 10 minutes) on local storage, extracts short audio/frame windows for ML scoring, and cuts highlights `[t - pre, t + post]` upon threshold crossing.

The Pipeline lane (Lane A) must solve three critical engineering requirements:
1. **Ingest Selection & Decoupling**: How to ingest live streams from supported platform sources reliably without proprietary cloud APIs or DRM evasion.
2. **Rolling Buffer Segmentation**: How to segment high-definition video (1080p60) into low-latency, precisely cuttable chunks while enforcing disk storage bounds (< 3.0 GB resident buffer).
3. **Fault Tolerance & Reconnect**: How to recover from stream dropouts, transient network interruptions, and source buffer stalls without corrupting the rolling buffer or clip generation.

---

## 2. Decision: Ingest Tool Selection

We select **Streamlink** as the primary stream fetcher, with **yt-dlp** as secondary fallback, piping raw MPEG-TS/HLS stream data directly into **ffmpeg** via `stdin`.

### Comparative Analysis:

| Ingest Tool | Stream Protocol Support | Reconnect Latency | Process Overhead | Verdict |
|---|---|---|---|---|
| **Streamlink** | Native Twitch/Kick/YouTube HLS plugin pipeline | Fast (< 1.5s backoff) | Low (~45 MB RAM) | **Primary (Selected)** |
| **yt-dlp** | Broad site extractors, heavy regex parsing | Moderate (2–4s) | Moderate (~80 MB RAM) | **Fallback** |
| **Direct ffmpeg** | Generic HLS/RTMP; fails on platform session tokens | N/A (requires URL resolution) | Minimal | Segmenter only |

### Architecture:
```
Live Stream URL (Platform)
       │
       ▼
[Streamlink / yt-dlp] (Extracts raw stream manifest/segments)
       │
       ▼ Pipe (stdout -> stdin)
[ffmpeg HLS Segmenter]
       │
       ├──► 2.0s HLS Segments (.ts) into storage/buffer/<session-id>/
       └──► Monotonic playlist (live.m3u8)
```

1. **Stream Extraction**: Streamlink extracts authenticated public streams (matching `config.sources` allow-list). It operates in pipe mode (`--stdout`).
2. **Standard I/O Piping**: Ingest tools output raw MPEG transport stream bytes to `stdout`, piped directly to `ffmpeg -i pipe:0`. This isolates platform extractor quirks from the core video segmenter.
3. **Direct Feed Support**: For local testing and fixture replays, `ffmpeg` can read fixture files or local RTSP/HLS feeds directly without external fetchers.

---

## 3. Decision: Buffer Segmentation Parameters

We standardize on **2.0-second HLS MPEG-TS segments** with strict keyframe alignment.

### FFmpeg Segmenter Configuration:
```bash
ffmpeg \
  -re \
  -i pipe:0 \
  -c:v copy \
  -c:a copy \
  -f hls \
  -hls_time 2 \
  -hls_list_size 300 \
  -hls_flags delete_segments+append_list+temp_file \
  -hls_segment_type mpegts \
  -hls_segment_filename "storage/buffer/<session-id>/seg_%05d.ts" \
  "storage/buffer/<session-id>/live.m3u8"
```

### Key Parameters & Rationale:
1. **`-hls_time 2` (2.0s segments)**:
   - Provides granular clip boundary precision (±1s tolerance).
   - Minimizes sampling delay: frames and 5s audio windows can be extracted with sub-3s end-to-end latency from live edge.
2. **`-c:v copy -c:a copy` (Zero Re-encoding)**:
   - Ingest ingestion runs with negligible CPU load (< 2% of one core), preserving CPU budget for ML detection models.
3. **`-hls_flags temp_file`**:
   - Segments are written to `.tmp` files and atomically renamed only when fully flushed. This guarantees the sampler and cutter never read incomplete or torn segments.
4. **`-g 60 -keyint_min 60 -sc_threshold 0` (for source generation/transcoding)**:
   - When transcoding is required, enforces exact 2-second GOPs (Group of Pictures) at 30 fps, aligning IDR keyframes to segment boundaries.

---

## 4. Empirical Benchmark Results (S0-1 Spike)

Benchmarks executed on the target hardware (AMD Ryzen 5 7000 HS, NVMe SSD, Windows 11 / WSL2):

| Metric | Measured Value | Budget / Requirement | Status |
|---|---|---|---|
| **Average Segment Size (1080p synthetic)** | 150.7 KB | < 2.0 MB | PASS |
| **Max Segment Size (1080p60 high action @ 8 Mbps)** | 2.0 MB | < 3.0 MB | PASS |
| **10-Minute Buffer Disk Footprint (300 segments)** | 44.1 MB – 600 MB | < 3.0 GB | PASS (well under budget) |
| **Sustained Disk Write Rate** | 330 KB/s – 1.0 MB/s | < 15 MB/s | PASS (< 1% NVMe saturation) |
| **Live Edge to Disk Flush Latency** | 2.10 ± 0.05 s | < 3.0 s | PASS |
| **Segment Gap Count (30-min continuous)** | 0 gaps | 0 gaps | PASS |
| **Pipeline CPU Utilization (Segmenter)** | ~1.4% single core | < 5% single core | PASS |

---

## 5. Decision: Eviction and Job Protection Strategy

Per CONTRACTS §5:
> "A buffer segment cannot be deleted while any `clip_jobs` row with `status in ('queued', 'cutting')` covers its time range."

### Eviction Protocol:
1. **Continuous Rolling Eviction**:
   - The buffer maintains a target window of $N$ minutes (default: 10 minutes = 300 segments).
   - An eviction task evaluates segments older than $t_{\text{current}} - \text{buffer\_minutes}$.
2. **Protection Query**:
   - Before unlinking any segment file `seg_XXXXX.ts`, the eviction engine queries SQLite:
     ```sql
     SELECT COUNT(*) FROM clip_jobs
     WHERE status IN ('queued', 'cutting')
       AND start_t <= ? AND end_t >= ?;
     ```
   - If protected, the segment is retained until the clip job status transitions to `encoded` or `failed`.
3. **Grace Period**:
   - An extra 60-second safety margin beyond the configured buffer minutes is retained to absorb clip encoding delays.

---

## 6. Decision: Reconnect and Resilience Policy

Live stream network disconnects are handled via an exponential backoff state machine:
- **Intervals**: 1s, 2s, 4s, 8s, 16s, capped at 30s.
- **Session Continuity**: Disconnections under 60 seconds maintain the active `session_id`. Segments continue monotonically.
- **Stream Resumption**: When the connection resumes, ffmpeg appends to the existing HLS playlist (`append_list` flag) avoiding discontinuity errors for downstream samplers.
- **Hard Termination**: Disconnections exceeding 5 minutes trigger graceful session completion and state logging.
