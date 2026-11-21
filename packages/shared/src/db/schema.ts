export const INITIAL_SCHEMA_SQL = `
-- 1. Ingested Stream Sessions
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source_url TEXT NOT NULL,
    source_label TEXT NOT NULL,
    source_domain TEXT NOT NULL,
    channel_slug TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'ended', 'error')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);

-- 2. Scored Detection Events (CONTRACTS.md §4)
CREATE TABLE IF NOT EXISTS detections (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_label TEXT NOT NULL,
    source_domain TEXT NOT NULL,
    t_stream REAL NOT NULL,
    t_wall TEXT NOT NULL,
    fused_score REAL NOT NULL,
    signals TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('scored', 'clipped', 'dismissed', 'error')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_detections_session_score ON detections(session_id, fused_score DESC);
CREATE INDEX IF NOT EXISTS idx_detections_status ON detections(status);
CREATE INDEX IF NOT EXISTS idx_detections_t_stream ON detections(session_id, t_stream ASC);

-- 3. Clip Cutting Jobs (CONTRACTS.md §5)
CREATE TABLE IF NOT EXISTS clip_jobs (
    id TEXT PRIMARY KEY,
    detection_id TEXT NOT NULL REFERENCES detections(id),
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    start_t REAL NOT NULL,
    end_t REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'cutting', 'encoded', 'failed', 'reviewed')),
    output_path TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clip_jobs_status ON clip_jobs(status);
CREATE INDEX IF NOT EXISTS idx_clip_jobs_eviction ON clip_jobs(session_id, status, start_t, end_t);

-- 4. Clips & Review Metadata (CONTRACTS.md §6 sidecar parity)
CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES clip_jobs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    detection_id TEXT NOT NULL REFERENCES detections(id),
    source_domain TEXT NOT NULL,
    channel_slug TEXT NOT NULL,
    t_start_stream REAL NOT NULL,
    t_end_stream REAL NOT NULL,
    duration_s REAL NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    codec TEXT NOT NULL,
    vertical INTEGER NOT NULL DEFAULT 0,
    output_path TEXT NOT NULL,
    sidecar_path TEXT NOT NULL,
    fused_score REAL NOT NULL,
    top_signals TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_status IN ('unreviewed', 'approved', 'rejected', 'favorited')),
    title TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clips_review_status ON clips(review_status);
CREATE INDEX IF NOT EXISTS idx_clips_source ON clips(source_domain, channel_slug);
CREATE INDEX IF NOT EXISTS idx_clips_created_at ON clips(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_score ON clips(fused_score DESC);
`;
