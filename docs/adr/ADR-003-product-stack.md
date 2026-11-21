# ADR-003: Product Stack, SQLite Schema, and Dashboard Wireframes

- **Status:** Accepted
- **Lane:** Lane C (Product)
- **Deciders:** Agent C (Product), in alignment with Agent A (Pipeline) and Agent B (Detection)
- **Date:** 2026-11-20
- **Relates to:** CONTRACTS.md (§4, §5, §6, §7), PLAN.md (S0-3, A-03, C-01, C-02, C-03, C-04, C-05, C-06), AGENTS.md (§2, §3, §4, §6, §7)

---

## 1. Context and Problem Statement

clipforge is a local, autonomous highlight-clipping tool running entirely on the owner's workstation (AMD Ryzen 5 7000-series HS, 16 GB RAM, NVIDIA RTX 3050 Laptop GPU with 6 GB VRAM). The system continuously ingests live video streams, buffers 2-second HLS segments, extracts audio/frames for multi-signal local ML detection, and automatically cuts clips when detection scores cross threshold.

The Product lane (Lane C) is responsible for:
1. The **REST API** (`apps/api/`) on `http://127.0.0.1:4317/api` serving dashboard queries, review mutations, clip trimming, vertical exporting, and system health.
2. The **Dashboard Web UI** (`apps/dashboard/`) allowing the owner to monitor live streams and detections, review highlight clips, trim/export for platforms, and browse stored media files.
3. Defining the **SQLite Schema and Migration Strategy** (`storage/db/clipforge.sqlite`) shared between the Pipeline orchestrator (Agent A) and the API (Agent C).

Key constraints:
- **Zero Cloud / Paid APIs**: Purely local execution on `localhost`.
- **Resource Budget**: Pipeline and ML models must retain primary CPU and GPU capacity. The API and Dashboard must impose near-zero idle overhead and stay under 150 MB resident memory.
- **Contract Enforcement**: Full fidelity with `docs/CONTRACTS.md` v0.1.0 and JSON schemas in `packages/shared/schemas/`.
- **Concurrency**: Fastify API and Orchestrator Node processes will concurrently access the shared SQLite database.

---

## 2. Decision: API Framework — Fastify

We select **Fastify** (v4.x/v5.x) over Express, Koa, or NestJS for `apps/api/`.

### Rationale:
1. **High Throughput & Minimal Resource Footprint**: Fastify is benchmarked at 2–4× the throughput of Express with significantly lower memory and event loop latency. On a machine balancing simultaneous video decoding, ML inference, and disk I/O, minimizing web server overhead is paramount.
2. **Schema-Driven Validation and Serialization**: Fastify natively integrates `ajv` for input validation and `fast-json-stringify` for response serialization. This enables direct reuse of shared JSON schemas from `packages/shared/schemas/` (generated from `docs/CONTRACTS.md`), guaranteeing that request payloads and responses strictly adhere to contracts with compile-time and run-time validation.
3. **First-Class TypeScript Support**: Strong type inference for request params, query strings, headers, and body payloads without manual type-casting.
4. **Structured JSON Logging**: Fastify includes built-in `pino` structured logging. This directly matches the format specified in `CONTRACTS.md §8` (`ts`, `level`, `component: "api"`, `session_id`, `correlation_id`, `msg`).
5. **Robust Local Plugin Ecosystem**:
   - `@fastify/cors`: Restricts access strictly to local origins.
   - `@fastify/static`: High-performance static streaming of `.mp4` video files from `storage/clips/` with HTTP Range request support (essential for HTML5 video seeking), as well as serving the compiled dashboard single-page application in production.
   - `@fastify/sensible`: Standardized error responses matching CONTRACTS §7 `{ error: { code, message, correlation_id } }`.

---

## 3. Decision: Dashboard Framework — React with Vite

We select **React 18+ with Vite** over Next.js, Remix, Svelte, or Vue for `apps/dashboard/`.

### Rationale:
1. **Single-Page Application (SPA) on Localhost**: clipforge runs exclusively on the owner's machine. Server-side rendering (SSR) frameworks (Next.js/Remix) introduce unnecessary node server daemons, build complexity, and higher memory consumption. A client-side SPA compiled to static files (`apps/dashboard/dist`) served directly by the Fastify API (or via Vite dev server during development) is optimal.
2. **Rapid HMR & Low Build Overhead**: Vite (powered by esbuild and Rollup) offers sub-second cold starts and instantaneous Hot Module Replacement, using virtually no CPU in the background while idle.
3. **Ecosystem & UI Ergonomics**:
   - Tailwind CSS for clean, responsive UI styling without heavy CSS runtime libraries.
   - `lucide-react` for lightweight, consistent interface icons.
   - Native HTML5 `<video>` element with custom slider controls for millisecond-level scrub and trim preview.
   - Lightweight polling hook (2s interval per CONTRACTS / C-02) for real-time live detection streaming without WebSocket or SSE overhead in Phase 1.
4. **Unified Deployment**: `make build` compiles `apps/dashboard` into static HTML/JS/CSS assets. `apps/api` serves these static assets at the root route `/`, satisfying Phase 4 production requirements in a single executable process.

---

## 4. SQLite Schema and Migration Strategy

The database resides at `storage/db/clipforge.sqlite` (git-ignored per `AGENTS.md §4`).

### 4.1 Database Engine & Pragma Configuration
We use `better-sqlite3` in Node.js for synchronous, high-speed SQLite operations with minimal overhead. On connection initialization, the following PRAGMAs must be executed:

```sql
PRAGMA journal_mode = WAL;        -- Enables concurrent readers and a writer without blocking
PRAGMA foreign_keys = ON;         -- Enforces relational integrity across tables
PRAGMA busy_timeout = 5000;       -- Waits up to 5s if locked during concurrent writes
PRAGMA synchronous = NORMAL;      -- High durability while minimizing disk flush latency
```

### 4.2 SQLite DDL Schema (`migrations/001_initial_schema.sql`)

```sql
-- Migration 001: Initial schema for clipforge
-- Covers sessions, detections, clip_jobs, and clips per CONTRACTS.md §4-§6

-- 1. Ingested Stream Sessions
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,                       -- e.g. "sess_20261120_01"
    source_url TEXT NOT NULL,                  -- stream URL from config allowlist
    source_label TEXT NOT NULL,                -- e.g. "my-channel"
    source_domain TEXT NOT NULL,                -- e.g. "twitch.tv", "youtube.com", "local"
    channel_slug TEXT NOT NULL,                 -- e.g. "my-channel"
    status TEXT NOT NULL CHECK(status IN ('active', 'ended', 'error')),
    started_at TEXT NOT NULL,                  -- ISO 8601 UTC
    ended_at TEXT,                             -- ISO 8601 UTC (nullable)
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);

-- 2. Scored Detection Events (CONTRACTS.md §4)
CREATE TABLE IF NOT EXISTS detections (
    id TEXT PRIMARY KEY,                       -- e.g. "det_01H..."
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_label TEXT NOT NULL,                -- e.g. "my-channel"
    source_domain TEXT NOT NULL,                -- e.g. "twitch.tv"
    t_stream REAL NOT NULL,                    -- monotonic seconds from stream start
    t_wall TEXT NOT NULL,                      -- ISO 8601 UTC
    fused_score REAL NOT NULL,                 -- float [0.0, 1.0]
    signals TEXT NOT NULL,                     -- JSON stringified signal breakdown
    status TEXT NOT NULL CHECK(status IN ('scored', 'clipped', 'dismissed', 'error')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_detections_session_score ON detections(session_id, fused_score DESC);
CREATE INDEX IF NOT EXISTS idx_detections_status ON detections(status);
CREATE INDEX IF NOT EXISTS idx_detections_t_stream ON detections(session_id, t_stream ASC);

-- 3. Clip Cutting Jobs (CONTRACTS.md §5)
CREATE TABLE IF NOT EXISTS clip_jobs (
    id TEXT PRIMARY KEY,                       -- e.g. "clip_01H..."
    detection_id TEXT NOT NULL REFERENCES detections(id),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_t REAL NOT NULL,                     -- stream seconds start (t - pre_seconds)
    end_t REAL NOT NULL,                       -- stream seconds end (t + post_seconds)
    status TEXT NOT NULL CHECK(status IN ('queued', 'cutting', 'encoded', 'failed', 'reviewed')),
    output_path TEXT NOT NULL,                 -- relative path e.g. "storage/clips/twitch.tv/..."
    error TEXT,                                -- error message if failed
    created_at TEXT NOT NULL,                  -- ISO 8601 UTC
    updated_at TEXT NOT NULL                   -- ISO 8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_clip_jobs_status ON clip_jobs(status);
CREATE INDEX IF NOT EXISTS idx_clip_jobs_eviction ON clip_jobs(session_id, status, start_t, end_t);

-- 4. Clips & Review Metadata (CONTRACTS.md §6 sidecar parity)
CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,                       -- matches clip_jobs.id ("clip_01H...")
    job_id TEXT NOT NULL REFERENCES clip_jobs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    detection_id TEXT NOT NULL REFERENCES detections(id),
    source_domain TEXT NOT NULL,                -- e.g. "twitch.tv"
    channel_slug TEXT NOT NULL,                 -- e.g. "my-channel"
    t_start_stream REAL NOT NULL,
    t_end_stream REAL NOT NULL,
    duration_s REAL NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    codec TEXT NOT NULL,                       -- e.g. "h264"
    vertical INTEGER NOT NULL DEFAULT 0,       -- 0 = horizontal (16:9), 1 = vertical (9:16)
    output_path TEXT NOT NULL,                 -- relative path to mp4
    sidecar_path TEXT NOT NULL,                -- relative path to json
    fused_score REAL NOT NULL,
    top_signals TEXT NOT NULL,                 -- JSON array: ["audio", "chat"]
    review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_status IN ('unreviewed', 'approved', 'rejected', 'favorited')),
    title TEXT,                                -- review title set by user
    tags TEXT NOT NULL DEFAULT '[]',           -- JSON array of user tags
    notes TEXT,                                -- review notes set by user
    created_at TEXT NOT NULL,                  -- ISO 8601 UTC
    updated_at TEXT NOT NULL                   -- ISO 8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_clips_review_status ON clips(review_status);
CREATE INDEX IF NOT EXISTS idx_clips_source ON clips(source_domain, channel_slug);
CREATE INDEX IF NOT EXISTS idx_clips_created_at ON clips(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_score ON clips(fused_score DESC);
```

### 4.3 Buffer Eviction Protection Query (A-03 / CONTRACTS §5)
The buffer segmenter must never evict segments currently needed by pending or active clip jobs. Agent A's eviction query uses:

```sql
SELECT 1 FROM clip_jobs
WHERE status IN ('queued', 'cutting')
  AND session_id = :session_id
  AND NOT (end_t <= :segment_start_t OR start_t >= :segment_end_t)
LIMIT 1;
```
If this query returns a row, the candidate buffer segment is protected and cannot be deleted.

### 4.4 Migration Runner Strategy
- Migrations are stored as plain `.sql` files in `packages/shared/migrations/` or `apps/orchestrator/migrations/`.
- A dedicated lightweight migration runner executes on application startup before orchestrator or API initialization.
- Applied migrations are recorded in a internal table:
  ```sql
  CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  ```
- Each migration runs inside a transaction (`BEGIN TRANSACTION` ... `COMMIT`). If any statement fails, the database automatically rolls back.
- Idempotent and thread-safe for both empty databases and subsequent additive schema updates.

---

## 5. Dashboard Screen Wireframes

The dashboard consists of three primary views accessible via the top navigation bar.

### 5.1 Screen 1: Sessions and Live Detections (`/` or `/live`)
Real-time operational dashboard monitoring stream ingestion, live detection scores, and active clipping jobs.

```
+---------------------------------------------------------------------------------------------------------+
| [clipforge]   [Live Detections (●)]   [Clips (14)]   [Storage Browser]            ● API: OK  ● GPU: 24% |
+---------------------------------------------------------------------------------------------------------+
| ACTIVE SESSION: twitch.tv/streamer_name   | Status: INGESTING   | Uptime: 01:42:15   | Buffer: 8.2 GB   |
+---------------------------------------------------------------------------------------------------------+
|                                                                                                         |
| LIVE HYPE TIMELINE (Last 5 Minutes)                                                    Threshold: 0.72   |
| 1.0 |                                                                                                   |
| 0.8 |                    /\                     * [0.84 Clip Created]                                   |
| 0.6 |   /\              /  \     /\            / \                                                      |
| 0.4 | _/  \____________/    \___/  \__________/   \_________________________________                    |
| 0.0 +------------------------------------------------------------------------------                     |
|     12:10:00          12:11:00          12:12:00          12:13:00          12:14:00 (Live)             |
|                                                                                                         |
+---------------------------------------------------------------------------------------------------------+
| LIVE DETECTIONS FEED (Auto-refresh 2s)                                 Filter: [ Min Score: 0.50 v ]    |
+---------------------------------------------------------------------------------------------------------+
| [12:14:22 UTC | t=6142.5s]  SCORE: 0.84  [CLIPPED]                                                      |
|   Signals: [Audio: 0.88 (+7.2 LUFS)] [Chat: 0.79 (54 msg/w)] [Keywords: 0.0] [OCR: 0.0] [Frame: 0.65] |
|   Action: [View Clip -> clip_01H89Z]                                                                    |
+---------------------------------------------------------------------------------------------------------+
| [12:13:05 UTC | t=6065.0s]  SCORE: 0.74  [SCORED]                                                      |
|   Signals: [Audio: 0.65] [Chat: 0.82 (61 msg/w)] [Keywords: "clutch", "gg"] [Frame: 0.40]              |
|   Actions: [Dismiss]  [Force Clip Now]                                                                  |
+---------------------------------------------------------------------------------------------------------+
| [12:11:40 UTC | t=5980.5s]  SCORE: 0.58  [DISMISSED]                                                   |
|   Signals: [Audio: 0.71] [Chat: 0.30] [Keywords: 0.0] [Frame: 0.20]                                    |
|   Status: Below threshold / User dismissed                                                             |
+---------------------------------------------------------------------------------------------------------+
```

### 5.2 Screen 2: Clip Grid (`/clips`)
Gallery view allowing sorting, filtering, and rapid triage of generated highlight clips.

```
+---------------------------------------------------------------------------------------------------------+
| [clipforge]   [Live Detections]   [Clips (14)]   [Storage Browser]                ● API: OK  ● GPU: 18% |
+---------------------------------------------------------------------------------------------------------+
| FILTERS:                                                                                                |
| Status: [All (14)]  [Unreviewed (8)]  [Approved (4)]  [Rejected (2)]                                    |
| Source: [All Sources v]   Sort: [Highest Score v]   Date: [Last 7 Days v]                               |
+---------------------------------------------------------------------------------------------------------+
|                                                                                                         |
| +-----------------------------+  +-----------------------------+  +-----------------------------+       |
| | [ THUMBNAIL PREVIEW ]       |  | [ THUMBNAIL PREVIEW ]       |  | [ THUMBNAIL PREVIEW ]       |       |
| | 1080p | 18.0s | Hype: 0.88  |  | 1080p | 20.0s | Hype: 0.84  |  | 1080p | 16.5s | Hype: 0.76  |       |
| +-----------------------------+  +-----------------------------+  +-----------------------------+       |
| | "Insane 1v4 Clutch"         |  | "Chat explosion on boss win"|  | "Unexpected headshot"       |       |
| | twitch.tv/streamer_name     |  | twitch.tv/streamer_name     |  | youtube.com/tourney_feed    |       |
| | 2026-11-20 10:15:19 UTC     |  | 2026-11-20 09:44:02 UTC     |  | 2026-11-19 22:12:10 UTC     |       |
| | Top: [audio] [chat]         |  | Top: [chat] [speech]        |  | Top: [audio] [frame]        |       |
| | Status: [UNREVIEWED]        |  | Status: [APPROVED] ★        |  | Status: [REJECTED]          |       |
| | Actions: [✓] [✗] [Detail >] |  | Actions: [Export] [Detail >]|  | Actions: [Restore]          |       |
| +-----------------------------+  +-----------------------------+  +-----------------------------+       |
|                                                                                                         |
+---------------------------------------------------------------------------------------------------------+
```

### 5.3 Screen 3: Clip Detail, Review, Trim, and Export (`/clips/:id`)
Comprehensive editing view providing video playback, signal inspection, review labeling, waveform trimming, and vertical 9:16 export.

```
+---------------------------------------------------------------------------------------------------------+
| [clipforge]   < Back to Clips     | Clip: clip_01H89Z7XW1 (twitch.tv/streamer_name)       Status: [OK]  |
+---------------------------------------------------------------------------------------------------------+
| LEFT COLUMN: VIDEO PLAYER & SIGNALS          | RIGHT COLUMN: METADATA, REVIEW & ACTIONS                 |
|                                              |                                                         |
| +------------------------------------------+ | METADATA & STORAGE                                      |
| |                                          | | Source: twitch.tv/streamer_name                         |
| |                                          | | Stream Time: 1224.5s - 1242.5s (18.0s duration)        |
| |            VIDEO PLAYER                  | | Resolution: 1920x1080 (16:9, h264)                      |
| |           (HTML5 + Canvas)               | | File: storage/clips/twitch.tv/.../clip_01H89Z.mp4       |
| |                                          | | Actions: [Open in File Explorer]  [Copy File Path]       |
| +------------------------------------------+ |---------------------------------------------------------|
| [ > Play ] [ 00:08.4 / 00:18.0 ] [ 1.0x v ]  | REVIEW FORM (PATCH /clips/:id/review)                   |
|                                              | Review Status: [ Approved    v ]                        |
| SIGNAL BREAKDOWN AT TRIGGER:                 | Title: [ Insane 1v4 Clutch Round                      ] |
| - Fused Hype Score: 0.88                     | Tags:  [ clutch x ] [ ace x ] [ valo x ] [ + Tag     ] |
| - Audio Energy:     0.81 (delta +6.1 LUFS)   | Notes: [ Great reaction at 00:12, cut slightly earlier] |
| - Chat Velocity:    0.92 (58 messages/win)   |                                     [ Save Review ]     |
| - Speech Keywords:  0.00                     |---------------------------------------------------------|
| - On-Screen Text:   0.00                     | TRIM CLIP (POST /clips/:id/trim)                        |
| - Frame Classifier: 0.44 ("action")          | Start Offset: [-2.0 s]   End Offset: [+1.5 s]           |
|                                              | Trimmed Duration: 21.5s (re-cutting from buffer)        |
|                                              |                                     [ Execute Trim ]    |
|                                              |---------------------------------------------------------|
|                                              | EXPORT WORKBENCH (POST /clips/:id/export)               |
|                                              | [x] Vertical Crop (9:16 Center-Weighted)                |
|                                              | [x] Burn Captions (from Whisper transcript)             |
|                                              | Encoder: [ NVIDIA NVENC (h264_nvenc) v ]                |
|                                              |                                     [ Export Clip ]     |
+---------------------------------------------------------------------------------------------------------+
```

---

## 6. Implementation and Migration Plan

1. **Phase 0 (S0-3)**: Record ADR-003, publish DDL and wireframes.
2. **Phase 1 (A-03)**: Agent A implements SQLite database initialization, WAL pragma setup, migration runner, and typed repository layer in TypeScript.
3. **Phase 1 (C-01)**: Agent C implements the Fastify API skeleton (`apps/api/`) connecting to the repository layer, exposing read endpoints (`/sessions`, `/detections`, `/clips`, `/clips/:id`, `/health`).
4. **Phase 1 (C-02 to C-06)**: Agent C builds the React + Vite dashboard implementing the wireframed screens, review actions, trim, vertical export, and storage browser.

---

## 7. Consequences and Trade-offs

### Positive:
- **Zero API/Cloud Cost**: Fully local development and execution without external API dependencies.
- **Resource Harmony**: Fastify and React+Vite use negligible CPU/memory, safeguarding hardware resources for Whisper, OCR, MobileNet, and ffmpeg transcoding.
- **Strict Contract Compliance**: Schema-driven validation guarantees exact compatibility with `docs/CONTRACTS.md`.
- **Concurrency Safety**: SQLite WAL mode + busy timeout ensures non-blocking concurrent reads and writes between the Orchestrator and the Fastify API.

### Negative / Mitigations:
- **Polling vs Push**: Live detections are polled every 2s in Phase 1 instead of WebSockets/SSE. *Mitigation:* Polling localhost SQLite via Fastify consumes <0.1% CPU; SSE can be added in backlog post-v1.0.0.
- **Single Host Storage**: Media files reside on local filesystem. *Mitigation:* Storage paths are organized cleanly by source domain, channel slug, and date for simple manual archival and upload.
