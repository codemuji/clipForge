export interface SourceConfig {
  url: string;
  label: string;
  enabled: boolean;
}

export interface BufferConfig {
  minutes: number;
  segment_seconds: number;
}

export interface SamplingConfig {
  interval_seconds: number;
  audio_window_seconds: number;
}

export interface ScoringWeights {
  audio: number;
  chat: number;
  speech_keywords: number;
  hud_text: number;
  frame_classifier: number;
}

export interface ScoringConfig {
  threshold: number;
  cooldown_seconds: number;
  debounce_windows: number;
  weights: ScoringWeights;
}

export interface ClipConfig {
  pre_seconds: number;
  post_seconds: number;
  encode: 'copy' | 'h264_nvenc' | 'h264_cpu';
  vertical: boolean;
}

export interface DetectorConfig {
  url: string;
  timeout_ms: number;
}

export interface StorageConfig {
  root: string;
  retention_days: number;
}

export interface ClipforgeConfig {
  sources: SourceConfig[];
  buffer: BufferConfig;
  sampling: SamplingConfig;
  scoring: ScoringConfig;
  clip: ClipConfig;
  detector: DetectorConfig;
  storage: StorageConfig;
}

export interface SamplerChatCounts {
  messages_in_window: number;
  unique_chatters: number;
}

export interface SamplerRequest {
  session_id: string;
  window_id: string;
  t_stream: number;
  t_wall: string;
  frame_path: string;
  audio_path: string;
  audio_sample_rate: number;
  chat: SamplerChatCounts;
}

export interface SignalAudio {
  value: number | null;
  detail?: {
    lufs?: number;
    lufs_delta?: number;
  };
}

export interface SignalSpeechKeywords {
  value: number | null;
  detail?: {
    matched?: string[];
  };
}

export interface SignalHudText {
  value: number | null;
  detail?: {
    matched?: string[];
  };
}

export interface SignalFrameClassifier {
  value: number | null;
  label?: string | null;
}

export interface SignalChat {
  value: number | null;
  detail?: {
    messages?: number;
    velocity?: number;
  };
}

export interface DetectorSignals {
  audio: SignalAudio;
  speech_keywords: SignalSpeechKeywords;
  hud_text: SignalHudText;
  frame_classifier: SignalFrameClassifier;
}

export interface ModelVersions {
  whisper?: string;
  ocr?: string;
  frame?: string;
}

export interface DetectorResponse {
  window_id: string;
  t_stream: number;
  signals: DetectorSignals;
  latency_ms: number;
  model_versions: ModelVersions;
}

export interface DetectionEventSignals extends DetectorSignals {
  chat?: SignalChat;
}

export type DetectionStatus = 'scored' | 'clipped' | 'dismissed' | 'error';

export interface DetectionEvent {
  id: string;
  session_id: string;
  source_label: string;
  source_domain: string;
  t_stream: number;
  t_wall: string;
  fused_score: number;
  signals: DetectionEventSignals;
  status: DetectionStatus;
}

export type ClipJobStatus = 'queued' | 'cutting' | 'encoded' | 'failed' | 'reviewed';

export interface ClipJob {
  id: string;
  detection_id: string;
  start_t: number;
  end_t: number;
  status: ClipJobStatus;
  output_path: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClipSidecarSource {
  url_host: string;
  channel: string;
  session_id: string;
  t_start_stream: number;
  t_end_stream: number;
}

export interface ClipSidecarDetection {
  id: string;
  fused_score: number;
  top_signals: string[];
}

export interface ClipSidecarMedia {
  file: string;
  duration_s: number;
  width: number;
  height: number;
  codec: string;
  vertical: boolean;
}

export interface ClipSidecarReview {
  status: 'unreviewed' | 'approved' | 'rejected';
  title: string | null;
  tags: string[];
  notes: string | null;
}

export interface ClipSidecar {
  schema: 'clipforge.clip.v1';
  clip_id: string;
  source: ClipSidecarSource;
  detection: ClipSidecarDetection;
  media: ClipSidecarMedia;
  review: ClipSidecarReview;
  created_at: string;
}
