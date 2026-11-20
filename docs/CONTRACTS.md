# CONTRACTS.md — clipforge interfaces

Version: 0.1.0. Bump the minor version for additive changes, major for breaking ones. Every agent codes against these shapes. The schemas are the source of truth; `packages/shared/schemas/*.json` must match this document.

## 1. Config (`config/clipforge.yaml`)

```yaml
sources:                    # allow-list; orchestrator refuses anything not listed
  - url: "https://www.twitch.tv/<your-channel>"
    label: "my-channel"
    enabled: true

buffer:
  minutes: 10               # rolling window kept on disk
  segment_seconds: 2

sampling:
  interval_seconds: 1.5
  audio_window_seconds: 5

scoring:
  threshold: 0.72           # fused score that triggers a clip
  cooldown_seconds: 45      # no second clip from the same burst
  debounce_windows: 2       # score must stay above threshold for N windows
  weights:
    audio: 0.35
    chat: 0.25
    speech_keywords: 0.15
    hud_text: 0.15
    frame_classifier: 0.10

clip:
  pre_seconds: 10
  post_seconds: 8
  encode: "copy"            # "copy" | "h264_nvenc" | "h264_cpu"
  vertical: false           # true = 9:16 crop with center-weighted box

detector:
  url: "http://127.0.0.1:8731"
  timeout_ms: 2500

storage:
  root: "./storage"
  retention_days: 30        # clips are never auto-deleted; buffer only
```

## 2. Sampler → Detector request

`POST {detector.url}/v1/analyze`

```json
{
  "session_id": "string",
  "window_id": "string (uuid)",
  "t_stream": 1234.5,
  "t_wall": "2026-11-20T10:15:03.120Z",
  "frame_path": "/abs/path/frame.jpg",
  "audio_path": "/abs/path/window.wav",
  "audio_sample_rate": 16000,
  "chat": { "messages_in_window": 42, "unique_chatters": 31 }
}
```

Notes:
- `chat` holds aggregate counts only. No message text, no usernames (see AGENTS.md §10).
- The detector deletes `frame_path` and `audio_path` after responding, unless `DEBUG_KEEP_WINDOWS=1`.

## 3. Detector → Scorer response

```json
{
  "window_id": "string (uuid)",
  "t_stream": 1234.5,
  "signals": {
    "audio": { "value": 0.81, "detail": { "lufs": -14.2, "lufs_delta": 6.1 } },
    "speech_keywords": { "value": 0.0, "detail": { "matched": [] } },
    "hud_text": { "value": 0.0, "detail": { "matched": [] } },
    "frame_classifier": { "value": 0.44, "label": "action" }
  },
  "latency_ms": 310,
  "model_versions": { "whisper": "base.en-q5", "ocr": "paddle-small", "frame": "mnv3s-v0.2" }
}
```

Rules:
- Every `value` is a float in `[0, 1]`.
- Missing signals are sent with `value: null`, not omitted. The scorer re-normalizes weights over the non-null signals.
- `chat` signal is computed by the orchestrator, not the detector. The orchestrator fills it into `signals.chat` before scoring.

## 4. Detection event (SQLite `detections` table and API)

```json
{
  "id": "det_01H...",
  "session_id": "string",
  "source_label": "my-channel",
  "source_domain": "twitch.tv",
  "t_stream": 1234.5,
  "t_wall": "2026-11-20T10:15:03.120Z",
  "fused_score": 0.78,
  "signals": { "...": "same shape as §3 signals, with chat filled in" },
  "status": "scored | clipped | dismissed | error"
}
```

## 5. Clip job (SQLite `clip_jobs` table)

```json
{
  "id": "clip_01H...",
  "detection_id": "det_01H...",
  "start_t": 1224.5,
  "end_t": 1242.5,
  "status": "queued | cutting | encoded | failed | reviewed",
  "output_path": "storage/clips/twitch.tv/my-channel/2026-11-20/clip_01H....mp4",
  "error": null,
  "created_at": "2026-11-20T10:15:04Z",
  "updated_at": "2026-11-20T10:15:19Z"
}
```

Eviction rule: a buffer segment cannot be deleted while any `clip_jobs` row with `status in (queued, cutting)` covers its time range.

## 6. Clip sidecar (`<clip-id>.json`, written beside each mp4)

```json
{
  "schema": "clipforge.clip.v1",
  "clip_id": "clip_01H...",
  "source": {
    "url_host": "twitch.tv",
    "channel": "my-channel",
    "session_id": "string",
    "t_start_stream": 1224.5,
    "t_end_stream": 1242.5
  },
  "detection": {
    "id": "det_01H...",
    "fused_score": 0.78,
    "top_signals": ["audio", "chat"]
  },
  "media": {
    "file": "clip_01H....mp4",
    "duration_s": 18.0,
    "width": 1920,
    "height": 1080,
    "codec": "h264",
    "vertical": false
  },
  "review": {
    "status": "unreviewed",
    "title": null,
    "tags": [],
    "notes": null
  },
  "created_at": "2026-11-20T10:15:19Z"
}
```

Rules:
- Sidecar is written after the mp4 is fully flushed, using write-then-rename.
- `review.*` fields are written only by the dashboard. The orchestrator never overwrites them.

## 7. REST API (dashboard ↔ api; api ↔ SQLite)

Base: `http://127.0.0.1:4317/api`

| Method | Path | Purpose |
|---|---|---|
| GET | `/sessions` | list sessions |
| GET | `/detections?session_id=&min_score=` | list detections |
| GET | `/clips?status=&source=` | list clips with sidecar data |
| GET | `/clips/:id` | one clip |
| PATCH | `/clips/:id/review` | body: `{status, title, tags, notes}` |
| POST | `/clips/:id/trim` | body: `{start_offset_s, end_offset_s}`; re-cuts from source buffer or from clip mp4 |
| POST | `/clips/:id/export` | body: `{vertical, burn_captions}`; writes a new file beside original |
| POST | `/detections/:id/dismiss` | marks detection dismissed |
| GET | `/health` | returns `{status, detector, buffer_free_gb, gpu}` |

Errors use `{error: {code, message, correlation_id}}`.

## 8. Logging

Structured JSON lines. Required fields: `ts`, `level`, `component`, `session_id`, `correlation_id`, `msg`. Correlation ID is the detection ID when one exists, otherwise a session-scoped ID.

## 9. Timestamps

- `t_stream`: seconds from the start of the ingested session. Monotonic. Used for all cuts.
- `t_wall`: ISO 8601 UTC. Used for display and file paths only.
- Never cut using `t_wall`.
