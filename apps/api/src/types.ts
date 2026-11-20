/**
 * API types complying with CONTRACTS.md §4, §5, §6, §7
 */

export interface ApiError {
  error: {
    code: string;
    message: string;
    correlation_id: string;
  };
}

export interface Session {
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

export interface SignalDetail {
  value: number | null;
  detail?: Record<string, unknown>;
  label?: string;
}

export interface SignalsMap {
  audio?: SignalDetail;
  speech_keywords?: SignalDetail;
  hud_text?: SignalDetail;
  frame_classifier?: SignalDetail;
  chat?: SignalDetail;
  [key: string]: SignalDetail | undefined;
}

export interface Detection {
  id: string;
  session_id: string;
  source_label: string;
  source_domain: string;
  t_stream: number;
  t_wall: string;
  fused_score: number;
  signals: SignalsMap;
  status: 'scored' | 'clipped' | 'dismissed' | 'error';
  created_at?: string;
}

export interface ClipJob {
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

export interface ClipSidecar {
  schema: 'clipforge.clip.v1';
  clip_id: string;
  source: {
    url_host: string;
    channel: string;
    session_id: string;
    t_start_stream: number;
    t_end_stream: number;
  };
  detection: {
    id: string;
    fused_score: number;
    top_signals: string[];
  };
  media: {
    file: string;
    duration_s: number;
    width: number;
    height: number;
    codec: string;
    vertical: boolean;
  };
  review: {
    status: 'unreviewed' | 'approved' | 'rejected' | 'favorited';
    title: string | null;
    tags: string[];
    notes: string | null;
  };
  created_at: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  detector: {
    reachable: boolean;
    url: string;
  };
  buffer_free_gb: number;
  gpu: {
    available: boolean;
    name?: string;
  };
}
