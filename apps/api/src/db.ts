import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Session, Detection, ClipJob, ClipSidecar } from './types.js';

export interface DatabaseServiceOptions {
  dbPath?: string;
}

export class DatabaseService {
  private db: DatabaseSync;

  constructor(options: DatabaseServiceOptions = {}) {
    const dbPath = options.dbPath || ':memory:';
    this.db = new DatabaseSync(dbPath);

    // Initialize pragmas for performance and concurrency
    try {
      this.db.exec('PRAGMA foreign_keys = ON;');
      if (dbPath !== ':memory:') {
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA busy_timeout = 5000;');
      }
    } catch {
      // Pragmas may have varying support depending on SQLite memory mode
    }

    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        source_label TEXT NOT NULL,
        source_domain TEXT NOT NULL,
        channel_slug TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'ended', 'error')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

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
    `);
  }

  public getSessions(): Session[] {
    const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC');
    return stmt.all() as unknown as Session[];
  }

  public getSessionById(id: string): Session | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id);
    return (row as unknown as Session) || null;
  }

  public getDetections(options: { sessionId?: string; minScore?: number } = {}): Detection[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }

    if (typeof options.minScore === 'number' && !Number.isNaN(options.minScore)) {
      conditions.push('fused_score >= ?');
      params.push(options.minScore);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT * FROM detections ${whereClause} ORDER BY t_stream DESC`;
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapRowToDetection(r));
  }

  public getDetectionById(id: string): Detection | null {
    const stmt = this.db.prepare('SELECT * FROM detections WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRowToDetection(row);
  }

  public dismissDetection(id: string): Detection | null {
    const detection = this.getDetectionById(id);
    if (!detection) return null;

    this.db.prepare("UPDATE detections SET status = 'dismissed' WHERE id = ?").run(id);
    return this.getDetectionById(id);
  }

  public canCreateClipJob(detectionId: string): boolean {
    const detection = this.getDetectionById(detectionId);
    if (!detection) return false;
    return detection.status !== 'dismissed';
  }

  public createClipJobFromDetection(
    detectionId: string,
    startT: number,
    endT: number,
    outputPath: string
  ): ClipJob {
    const detection = this.getDetectionById(detectionId);
    if (!detection) {
      throw new Error(`Detection not found: ${detectionId}`);
    }

    if (detection.status === 'dismissed') {
      throw new Error(`Cannot create clip job for dismissed detection: ${detectionId}`);
    }

    const jobId = `job_${detectionId}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO clip_jobs (
        id, detection_id, session_id, start_t, end_t, status, output_path, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId,
      detectionId,
      detection.session_id,
      startT,
      endT,
      'queued',
      outputPath,
      null,
      now,
      now
    );

    return {
      id: jobId,
      detection_id: detectionId,
      session_id: detection.session_id,
      start_t: startT,
      end_t: endT,
      status: 'queued',
      output_path: outputPath,
      error: null,
      created_at: now,
      updated_at: now
    };
  }

  public getClips(options: { status?: string; source?: string } = {}): ClipSidecar[] {
    const conditions: string[] = [];
    const params: string[] = [];

    if (options.status) {
      conditions.push('review_status = ?');
      params.push(options.status);
    }

    if (options.source) {
      conditions.push('(source_domain = ? OR channel_slug = ?)');
      params.push(options.source, options.source);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT * FROM clips ${whereClause} ORDER BY created_at DESC`;
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapRowToClipSidecar(r));
  }

  public getClipById(id: string): ClipSidecar | null {
    const stmt = this.db.prepare('SELECT * FROM clips WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRowToClipSidecar(row);
  }

  public updateClipReview(
    id: string,
    review: {
      status?: string;
      title?: string | null;
      tags?: string[];
      notes?: string | null;
    }
  ): ClipSidecar | null {
    const existing = this.getClipById(id);
    if (!existing) return null;

    const newStatus = review.status !== undefined ? review.status : existing.review.status;
    const newTitle = review.title !== undefined ? review.title : existing.review.title;
    const newTags = review.tags !== undefined ? review.tags : existing.review.tags;
    const newNotes = review.notes !== undefined ? review.notes : existing.review.notes;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE clips
      SET review_status = ?,
          title = ?,
          tags = ?,
          notes = ?,
          updated_at = ?
      WHERE id = ?
    `);

    stmt.run(newStatus, newTitle, JSON.stringify(newTags), newNotes, now, id);

    const updated = this.getClipById(id);
    if (updated) {
      // Sync to sidecar JSON file on disk if it exists per CONTRACTS.md §6
      this.syncSidecarFileOnDisk(updated);
    }

    return updated;
  }

  private syncSidecarFileOnDisk(clip: ClipSidecar): void {
    try {
      const sidecarPath = clip.media.file.replace(/\.mp4$/, '.json');
      if (fs.existsSync(sidecarPath)) {
        const raw = fs.readFileSync(sidecarPath, 'utf-8');
        const sidecar = JSON.parse(raw);
        sidecar.review = {
          status: clip.review.status,
          title: clip.review.title,
          tags: clip.review.tags,
          notes: clip.review.notes
        };

        // Write then rename for atomic file update per CONTRACTS §6
        const tmpPath = `${sidecarPath}.tmp.${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(sidecar, null, 2), 'utf-8');
        fs.renameSync(tmpPath, sidecarPath);
      }
    } catch {
      // Best-effort file sync if disk path is not accessible
    }
  }

  public seedSession(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        id, source_url, source_label, source_domain, channel_slug, status, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      session.id,
      session.source_url,
      session.source_label,
      session.source_domain,
      session.channel_slug,
      session.status,
      session.started_at,
      session.ended_at,
      session.created_at || new Date().toISOString(),
      session.updated_at || new Date().toISOString()
    );
  }

  public seedDetection(detection: Detection): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO detections (
        id, session_id, source_label, source_domain, t_stream, t_wall, fused_score, signals, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      detection.id,
      detection.session_id,
      detection.source_label,
      detection.source_domain,
      detection.t_stream,
      detection.t_wall,
      detection.fused_score,
      JSON.stringify(detection.signals),
      detection.status,
      detection.created_at || new Date().toISOString()
    );
  }

  public seedClip(clip: ClipSidecar, jobId?: string): void {
    const jId = jobId || `job_${clip.clip_id}`;
    // Ensure clip_jobs row exists for foreign key
    this.db.prepare(`
      INSERT OR IGNORE INTO clip_jobs (
        id, detection_id, session_id, start_t, end_t, status, output_path, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jId,
      clip.detection.id,
      clip.source.session_id,
      clip.source.t_start_stream,
      clip.source.t_end_stream,
      'encoded',
      clip.media.file,
      null,
      clip.created_at,
      clip.created_at
    );

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO clips (
        id, job_id, session_id, detection_id, source_domain, channel_slug,
        t_start_stream, t_end_stream, duration_s, width, height, codec, vertical,
        output_path, sidecar_path, fused_score, top_signals, review_status,
        title, tags, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      clip.clip_id,
      jId,
      clip.source.session_id,
      clip.detection.id,
      clip.source.url_host,
      clip.source.channel,
      clip.source.t_start_stream,
      clip.source.t_end_stream,
      clip.media.duration_s,
      clip.media.width,
      clip.media.height,
      clip.media.codec,
      clip.media.vertical ? 1 : 0,
      clip.media.file,
      clip.media.file.replace(/\.mp4$/, '.json'),
      clip.detection.fused_score,
      JSON.stringify(clip.detection.top_signals),
      clip.review.status,
      clip.review.title,
      JSON.stringify(clip.review.tags),
      clip.review.notes,
      clip.created_at,
      clip.created_at
    );
  }

  private mapRowToDetection(r: Record<string, unknown>): Detection {
    return {
      id: r.id as string,
      session_id: r.session_id as string,
      source_label: r.source_label as string,
      source_domain: r.source_domain as string,
      t_stream: r.t_stream as number,
      t_wall: r.t_wall as string,
      fused_score: r.fused_score as number,
      signals: typeof r.signals === 'string' ? JSON.parse(r.signals) : (r.signals as Record<string, unknown>),
      status: r.status as Detection['status'],
      created_at: r.created_at as string | undefined
    };
  }

  private mapRowToClipSidecar(r: Record<string, unknown>): ClipSidecar {
    const topSignals = typeof r.top_signals === 'string' ? JSON.parse(r.top_signals) : (r.top_signals || []);
    const tags = typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags || []);

    return {
      schema: 'clipforge.clip.v1',
      clip_id: r.id as string,
      source: {
        url_host: r.source_domain as string,
        channel: r.channel_slug as string,
        session_id: r.session_id as string,
        t_start_stream: r.t_start_stream as number,
        t_end_stream: r.t_end_stream as number
      },
      detection: {
        id: r.detection_id as string,
        fused_score: r.fused_score as number,
        top_signals: topSignals
      },
      media: {
        file: r.output_path as string,
        duration_s: r.duration_s as number,
        width: r.width as number,
        height: r.height as number,
        codec: r.codec as string,
        vertical: Boolean(r.vertical)
      },
      review: {
        status: r.review_status as ClipSidecar['review']['status'],
        title: (r.title as string | null) || null,
        tags: tags,
        notes: (r.notes as string | null) || null
      },
      created_at: r.created_at as string
    };
  }

  public close(): void {
    this.db.close();
  }
}
