import React from 'react';
import type { Detection, Session } from '../types.js';

export interface LiveDetectionsListProps {
  sessions: Session[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  detections: Detection[];
  minScore: number;
  onChangeMinScore: (score: number) => void;
  isPolling?: boolean;
  onSelectClip?: (clipId: string) => void;
}

export const LiveDetectionsList: React.FC<LiveDetectionsListProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  detections,
  minScore,
  onChangeMinScore,
  isPolling = true,
  onSelectClip
}) => {
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

  const filteredDetections = detections.filter((d) => d.fused_score >= minScore);

  return (
    <div className="live-detections-view" data-testid="live-detections-view">
      {/* Active Session Banner */}
      <div className="overview-card" data-testid="session-banner">
        <div className="overview-item">
          <span className="overview-label">Active Session</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.2rem' }}>
            <select
              className="select-input"
              value={activeSession?.id || ''}
              onChange={(e) => onSelectSession(e.target.value)}
              data-testid="session-selector"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.source_label} ({s.source_domain}) — {s.status}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="overview-item">
          <span className="overview-label">Stream Source</span>
          <span className="overview-value">{activeSession?.source_url || 'https://twitch.tv/my-channel'}</span>
        </div>

        <div className="overview-item">
          <span className="overview-label">Stream Status</span>
          <span className="overview-value" style={{ color: activeSession?.status === 'active' ? 'var(--success)' : 'var(--text-secondary)' }}>
            ● {activeSession?.status?.toUpperCase() || 'INGESTING'}
          </span>
        </div>

        <div className="overview-item">
          <span className="overview-label">Detection Feed</span>
          <span className="overview-value">
            {isPolling ? '● POLLING (2s)' : 'PAUSED'}
          </span>
        </div>
      </div>

      {/* Filter and Control Bar */}
      <div className="filter-bar">
        <div className="filter-group">
          <span className="overview-label" style={{ marginRight: '0.5rem' }}>Min Score:</span>
          <button
            className={`filter-btn ${minScore === 0 ? 'active' : ''}`}
            onClick={() => onChangeMinScore(0)}
            data-testid="filter-score-all"
          >
            All Scores
          </button>
          <button
            className={`filter-btn ${minScore === 0.5 ? 'active' : ''}`}
            onClick={() => onChangeMinScore(0.5)}
            data-testid="filter-score-05"
          >
            ≥ 0.50
          </button>
          <button
            className={`filter-btn ${minScore === 0.72 ? 'active' : ''}`}
            onClick={() => onChangeMinScore(0.72)}
            data-testid="filter-score-threshold"
          >
            ≥ 0.72 (Trigger Threshold)
          </button>
          <button
            className={`filter-btn ${minScore === 0.85 ? 'active' : ''}`}
            onClick={() => onChangeMinScore(0.85)}
            data-testid="filter-score-085"
          >
            ≥ 0.85 (High Hype)
          </button>
        </div>

        <div className="filter-group">
          <span className="badge badge-hype" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
            Trigger Threshold: 0.72
          </span>
          <span className="badge badge-scored" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}>
            Count: {filteredDetections.length}
          </span>
        </div>
      </div>

      {/* Detections List */}
      <div className="detections-list" data-testid="detections-container">
        {filteredDetections.length === 0 ? (
          <div className="empty-state" data-testid="empty-detections-message">
            No detections recorded above score {minScore.toFixed(2)}. Polling stream windows every 2 seconds...
          </div>
        ) : (
          filteredDetections.map((detection) => {
            const isAboveThreshold = detection.fused_score >= 0.72;
            const signals = detection.signals || {};

            return (
              <div
                key={detection.id}
                className="detection-card"
                data-testid={`detection-card-${detection.id}`}
              >
                <div className="detection-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span
                      className={`badge ${isAboveThreshold ? 'badge-hype' : 'badge-scored'}`}
                      data-testid={`detection-score-${detection.id}`}
                    >
                      {detection.fused_score.toFixed(2)} HYPE
                    </span>
                    <span className="detection-timestamp">
                      t={detection.t_stream.toFixed(1)}s ({detection.t_wall || 'Live Window'})
                    </span>
                    <span className={`badge badge-${detection.status}`}>
                      {detection.status}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {detection.status === 'clipped' && onSelectClip && (
                      <button
                        className="btn btn-primary"
                        style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem' }}
                        onClick={() => onSelectClip(detection.id.replace('det_', 'clip_'))}
                        data-testid={`view-clip-btn-${detection.id}`}
                      >
                        View Clip →
                      </button>
                    )}
                  </div>
                </div>

                <div className="signals-chips">
                  {signals.audio && (
                    <div className="chip" data-testid="chip-audio">
                      Audio: <strong>{(signals.audio.value ?? 0).toFixed(2)}</strong>
                      {signals.audio.detail && (signals.audio.detail as any).lufs !== undefined && (
                        <span> ({(signals.audio.detail as any).lufs} LUFS)</span>
                      )}
                    </div>
                  )}

                  {signals.chat && (
                    <div className="chip" data-testid="chip-chat">
                      Chat: <strong>{(signals.chat.value ?? 0).toFixed(2)}</strong>
                      {signals.chat.detail && (signals.chat.detail as any).messages_in_window !== undefined && (
                        <span> ({(signals.chat.detail as any).messages_in_window} msg/win)</span>
                      )}
                    </div>
                  )}

                  {signals.speech_keywords && (
                    <div className="chip" data-testid="chip-speech">
                      Speech: <strong>{(signals.speech_keywords.value ?? 0).toFixed(2)}</strong>
                    </div>
                  )}

                  {signals.hud_text && (
                    <div className="chip" data-testid="chip-ocr">
                      OCR: <strong>{(signals.hud_text.value ?? 0).toFixed(2)}</strong>
                    </div>
                  )}

                  {signals.frame_classifier && (
                    <div className="chip" data-testid="chip-frame">
                      Frame: <strong>{(signals.frame_classifier.value ?? 0).toFixed(2)}</strong>
                      {signals.frame_classifier.label && (
                        <span> [{signals.frame_classifier.label}]</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
