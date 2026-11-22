import type { HealthResponse, Session, Detection, ClipSidecar, StorageTreeResponse } from './types.js';

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

export async function trimClip(
  id: string,
  startOffsetS: number,
  endOffsetS: number
): Promise<ClipSidecar> {
  const res = await fetch(`${API_BASE}/clips/${encodeURIComponent(id)}/trim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      start_offset_s: startOffsetS,
      end_offset_s: endOffsetS
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Failed to trim clip ${id}: ${res.statusText}`);
  }
  return res.json();
}

export async function exportClip(
  id: string,
  options: { vertical?: boolean; burnCaptions?: boolean } = {}
): Promise<ClipSidecar> {
  const res = await fetch(`${API_BASE}/clips/${encodeURIComponent(id)}/export`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      vertical: options.vertical,
      burn_captions: options.burnCaptions
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Failed to export clip ${id}: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchStorageTree(subpath: string = ''): Promise<StorageTreeResponse> {
  const query = subpath ? `?subpath=${encodeURIComponent(subpath)}` : '';
  const res = await fetch(`${API_BASE}/storage/tree${query}`);
  if (!res.ok) throw new Error(`Failed to fetch storage tree: ${res.statusText}`);
  return res.json();
}

export async function revealStoragePath(relPath: string): Promise<{ success: boolean; command: string; target: string }> {
  const res = await fetch(`${API_BASE}/storage/reveal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: relPath })
  });
  if (!res.ok) throw new Error(`Failed to reveal path ${relPath}: ${res.statusText}`);
  return res.json();
}
