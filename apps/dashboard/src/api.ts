import type { HealthResponse, Session, Detection, ClipSidecar } from './types.js';

const API_BASE = '/api';

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.statusText}`);
  return res.json();
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch(`${API_BASE}/sessions`);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.statusText}`);
  return res.json();
}

export async function fetchDetections(options: { sessionId?: string; minScore?: number } = {}): Promise<Detection[]> {
  const params = new URLSearchParams();
  if (options.sessionId) params.append('session_id', options.sessionId);
  if (typeof options.minScore === 'number' && !Number.isNaN(options.minScore)) {
    params.append('min_score', String(options.minScore));
  }

  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/detections${query}`);
  if (!res.ok) throw new Error(`Failed to fetch detections: ${res.statusText}`);
  return res.json();
}

export async function dismissDetection(id: string): Promise<Detection> {
  const res = await fetch(`${API_BASE}/detections/${encodeURIComponent(id)}/dismiss`, {
    method: 'POST'
  });
  if (!res.ok) throw new Error(`Failed to dismiss detection ${id}: ${res.statusText}`);
  return res.json();
}

export async function fetchClips(options: { status?: string; source?: string } = {}): Promise<ClipSidecar[]> {
  const params = new URLSearchParams();
  if (options.status) params.append('status', options.status);
  if (options.source) params.append('source', options.source);

  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/clips${query}`);
  if (!res.ok) throw new Error(`Failed to fetch clips: ${res.statusText}`);
  return res.json();
}

export async function fetchClipById(id: string): Promise<ClipSidecar> {
  const res = await fetch(`${API_BASE}/clips/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch clip ${id}: ${res.statusText}`);
  return res.json();
}

export async function updateClipReview(
  id: string,
  review: {
    status?: string;
    title?: string | null;
    tags?: string[];
    notes?: string | null;
  }
): Promise<ClipSidecar> {
  const res = await fetch(`${API_BASE}/clips/${encodeURIComponent(id)}/review`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(review)
  });
  if (!res.ok) throw new Error(`Failed to update review for clip ${id}: ${res.statusText}`);
  return res.json();
}
