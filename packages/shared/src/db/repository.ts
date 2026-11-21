import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrations.js';
import { isSegmentProtected, getEvictableSegments, BufferSegment } from './eviction.js';
import type {
  DetectionEvent,
  ClipJob,
  ClipSidecar
} from '../contracts.js';

export interface DbSession {
  id: string;
  source_url: string;
  source_label: string;
  source_domain: string;
  channel_slug: string;
  status: 'active' | 'ended' | 'error';
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbDetection {
  id: string;
  session_id: string;
  source_label: string;
  source_domain: string;
  t_stream: number;
  t_wall: string;
  fused_score: number;
  signals: string; // JSON string
  status: 'scored' | 'clipped' | 'dismissed' | 'error';
  created_at: string;
}

export interface DbClipJob {
  id: string;
  detection_id: string;
  session_id: string;
  start_t: number;
  end_t: number;
  status: 'queued' | 'cutting' | 'encoded' | 'failed' | 'reviewed';
  output_path: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbClip {
  id: string;
  job_id: string;
  session_id: string;
  detection_id: string;
  source_domain: string;
  channel_slug: string;
  t_start_stream: number;
  t_end_stream: number;
  duration_s: number;
  width: number;
  height: number;
  codec: string;
  vertical: number;
  output_path: string;
  sidecar_path: string;
  fused_score: number;
  top_signals: string; // JSON string
  review_status: 'unreviewed' | 'approved' | 'rejected' | 'favorited';
  title: string | null;
  tags: string; // JSON string
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function createDatabase(dbPath: string = ':memory:'): { db: DatabaseSync; repo: DatabaseRepository } {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  try {
    db.exec('PRAGMA foreign_keys = ON;');
    if (dbPath !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('PRAGMA synchronous = NORMAL;');
    }
  } catch {
    // Some pragma configurations may not apply in all in-memory environments
  }

  runMigrations(db);
  const repo = new DatabaseRepository(db);
  return { db, repo };
}

export class DatabaseRepository {
  constructor(private db: DatabaseSync) {}

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  // --- SESSIONS ---
  public createSession(session: Omit<DbSession, 'created_at' | 'updated_at'>): DbSession {
    const now = new Date().toISOString();
    const fullSession: DbSession = {
      ...session,
      created_at: now,
      updated_at: now
    };

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, source_url, source_label, source_domain, channel_slug, status, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      fullSession.id,
      fullSession.source_url,
      fullSession.source_label,
      fullSession.source_domain,
      fullSession.channel_slug,
      fullSession.status,
      fullSession.started_at,
      fullSession.ended_at,
      fullSession.created_at,
      fullSession.updated_at
    );
    return fullSession;
  }

  public getSession(id: string): DbSession | undefined {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt.get(id) as DbSession | undefined;
  }

  public listSessions(): DbSession[] {
    const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC');
    return stmt.all() as DbSession[];
  }

  public updateSessionStatus(id: string, status: 'active' | 'ended' | 'error', endedAt?: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET status = ?, ended_at = COALESCE(?, ended_at), updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, endedAt || null, now, id);
  }

  // --- DETECTIONS ---
  public createDetection(detection: Omit<DbDetection, 'created_at'>): DbDetection {
    const now = new Date().toISOString();
    const full: DbDetection = { ...detection, created_at: now };
    const stmt = this.db.prepare(`
      INSERT INTO detections (id, session_id, source_label, source_domain, t_stream, t_wall, fused_score, signals, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      full.id,
      full.session_id,
      full.source_label,
      full.source_domain,
      full.t_stream,
      full.t_wall,
      full.fused_score,
      full.signals,
      full.status,
      full.created_at
    );
    return full;
  }

  public getDetection(id: string): DbDetection | undefined {
    const stmt = this.db.prepare('SELECT * FROM detections WHERE id = ?');
    return stmt.get(id) as DbDetection | undefined;
  }

  public listDetections(options: { sessionId?: string; minScore?: number; status?: string } = {}): DbDetection[] {
    let sql = 'SELECT * FROM detections WHERE 1=1';
    const params: unknown[] = [];

    if (options.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }
    if (options.minScore !== undefined) {
      sql += ' AND fused_score >= ?';
      params.push(options.minScore);
    }
    if (options.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    sql += ' ORDER BY t_stream ASC';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DbDetection[];
  }

  public updateDetectionStatus(id: string, status: 'scored' | 'clipped' | 'dismissed' | 'error'): void {
    const stmt = this.db.prepare('UPDATE detections SET status = ? WHERE id = ?');
    stmt.run(status, id);
  }

  // --- CLIP JOBS ---
  public createClipJob(job: DbClipJob): DbClipJob {
    const stmt = this.db.prepare(`
      INSERT INTO clip_jobs (id, detection_id, session_id, start_t, end_t, status, output_path, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      job.id,
      job.detection_id,
      job.session_id,
      job.start_t,
      job.end_t,
      job.status,
      job.output_path,
      job.error,
      job.created_at,
      job.updated_at
    );
    return job;
  }

  public getClipJob(id: string): DbClipJob | undefined {
    const stmt = this.db.prepare('SELECT * FROM clip_jobs WHERE id = ?');
    return stmt.get(id) as DbClipJob | undefined;
  }

  public listClipJobs(options: { sessionId?: string; status?: string } = {}): DbClipJob[] {
    let sql = 'SELECT * FROM clip_jobs WHERE 1=1';
    const params: unknown[] = [];

    if (options.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }
    if (options.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    sql += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DbClipJob[];
  }

  public updateClipJobStatus(
    id: string,
    status: 'queued' | 'cutting' | 'encoded' | 'failed' | 'reviewed',
    error?: string | null
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE clip_jobs
      SET status = ?, error = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(status, error ?? null, now, id);
  }

  // --- CLIPS ---
  public createClip(clip: DbClip): DbClip {
    const stmt = this.db.prepare(`
      INSERT INTO clips (
        id, job_id, session_id, detection_id, source_domain, channel_slug,
        t_start_stream, t_end_stream, duration_s, width, height, codec, vertical,
        output_path, sidecar_path, fused_score, top_signals, review_status,
        title, tags, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      clip.id,
      clip.job_id,
      clip.session_id,
      clip.detection_id,
      clip.source_domain,
      clip.channel_slug,
      clip.t_start_stream,
      clip.t_end_stream,
      clip.duration_s,
      clip.width,
      clip.height,
      clip.codec,
      clip.vertical,
      clip.output_path,
      clip.sidecar_path,
      clip.fused_score,
      clip.top_signals,
      clip.review_status,
      clip.title,
      clip.tags,
      clip.notes,
      clip.created_at,
      clip.updated_at
    );
    return clip;
  }

  public getClip(id: string): DbClip | undefined {
    const stmt = this.db.prepare('SELECT * FROM clips WHERE id = ?');
    return stmt.get(id) as DbClip | undefined;
  }

  public listClips(options: { status?: string; sourceDomain?: string; channelSlug?: string } = {}): DbClip[] {
    let sql = 'SELECT * FROM clips WHERE 1=1';
    const params: unknown[] = [];

    if (options.status) {
      sql += ' AND review_status = ?';
      params.push(options.status);
    }
    if (options.sourceDomain) {
      sql += ' AND source_domain = ?';
      params.push(options.sourceDomain);
    }
    if (options.channelSlug) {
      sql += ' AND channel_slug = ?';
      params.push(options.channelSlug);
    }
    sql += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DbClip[];
  }

  public updateClipReview(
    id: string,
    review: {
      status?: 'unreviewed' | 'approved' | 'rejected' | 'favorited';
      title?: string | null;
      tags?: string[];
      notes?: string | null;
    }
  ): void {
    const existing = this.getClip(id);
    if (!existing) {
      throw new Error(`Clip not found: ${id}`);
    }

    const now = new Date().toISOString();
    const updatedStatus = review.status ?? existing.review_status;
    const updatedTitle = review.title !== undefined ? review.title : existing.title;
    const updatedTags = review.tags !== undefined ? JSON.stringify(review.tags) : existing.tags;
    const updatedNotes = review.notes !== undefined ? review.notes : existing.notes;

    const stmt = this.db.prepare(`
      UPDATE clips
      SET review_status = ?, title = ?, tags = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(updatedStatus, updatedTitle, updatedTags, updatedNotes, now, id);
  }

  // --- EVICTION PROTECTION ---
  public isSegmentProtected(sessionId: string, startT: number, endT: number): boolean {
    return isSegmentProtected(this.db, sessionId, startT, endT);
  }

  public getEvictableSegments(sessionId: string, segments: BufferSegment[]): BufferSegment[] {
    return getEvictableSegments(this.db, sessionId, segments);
  }
}
