import React, { useState } from 'react';
import type { ClipSidecar } from '../types.js';

export interface ClipDetailProps {
  clip: ClipSidecar;
  onBack: () => void;
  onSaveReview?: (reviewData: { status: string; title: string; tags: string[]; notes: string }) => void;
  onTrim?: (offsets: { startOffset: number; endOffset: number }) => void;
  onExport?: (options: { vertical: boolean; burnCaptions: boolean }) => void;
}

export const ClipDetail: React.FC<ClipDetailProps> = ({
  clip,
  onBack,
  onSaveReview,
  onTrim,
  onExport
}) => {
  const [reviewStatus, setReviewStatus] = useState(clip.review.status);
  const [title, setTitle] = useState(clip.review.title || '');
  const [tags, setTags] = useState(clip.review.tags.join(', '));
  const [notes, setNotes] = useState(clip.review.notes || '');

  const [startOffset, setStartOffset] = useState(-2.0);
  const [endOffset, setEndOffset] = useState(1.5);

  const [vertical, setVertical] = useState(clip.media.vertical || false);
  const [burnCaptions, setBurnCaptions] = useState(false);

  const trimmedDuration = Math.max(1, clip.media.duration_s + (-startOffset) + endOffset);

  const handleSaveReview = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSaveReview) {
      onSaveReview({
        status: reviewStatus,
        title,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        notes
      });
    }
  };

  return (
    <div className="clip-detail-view" data-testid="clip-detail-view">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
        <button className="btn btn-secondary" onClick={onBack} data-testid="back-to-clips-btn">
          ← Back to Clips
        </button>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }} data-testid="detail-clip-title">
            {title || `${clip.source.channel} Highlight (${clip.clip_id})`}
          </h2>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            ID: {clip.clip_id} | Created: {new Date(clip.created_at).toLocaleString()}
          </span>
        </div>
      </div>

      <div className="clip-detail-layout">
        {/* Left Column: Video Player & Signals */}
        <div>
          <div className="detail-card">
            <h3 className="card-title">Video Preview</h3>
            <div className="video-container" data-testid="video-player-container">
              <video
                src={clip.media.file}
                controls
                data-testid="clip-video-element"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              >
                Your browser does not support HTML5 video preview for {clip.media.file}.
              </video>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              <span>Duration: <strong>{clip.media.duration_s.toFixed(1)}s</strong></span>
              <span>Codec: <strong>{clip.media.codec}</strong></span>
              <span>Resolution: <strong>{clip.media.width}x{clip.media.height}</strong></span>
            </div>
          </div>

          <div className="detail-card">
            <h3 className="card-title">Detection Signals at Trigger</h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="overview-label">Fused Hype Score</span>
              <span className="badge badge-hype" style={{ fontSize: '0.9rem' }} data-testid="detail-hype-score">
                {clip.detection.fused_score.toFixed(2)}
              </span>
            </div>

            <div className="signals-chips" style={{ marginTop: '0.5rem' }}>
              <span className="chip">Top Signals: <strong>{clip.detection.top_signals.join(', ')}</strong></span>
              <span className="chip">Trigger Detection ID: <strong>{clip.detection.id}</strong></span>
            </div>
          </div>
        </div>

        {/* Right Column: Metadata, Review Form, Trim & Export */}
        <div>
          {/* Metadata & Storage Card */}
          <div className="detail-card">
            <h3 className="card-title">Storage & Source Info</h3>
            <div className="overview-item">
              <span className="overview-label">Source Host & Channel</span>
              <span className="overview-value">{clip.source.url_host}/{clip.source.channel}</span>
            </div>
            <div className="overview-item" style={{ marginTop: '0.5rem' }}>
              <span className="overview-label">Stream Time Interval</span>
              <span className="overview-value">
                t={clip.source.t_start_stream.toFixed(1)}s → t={clip.source.t_end_stream.toFixed(1)}s
              </span>
            </div>
            <div className="overview-item" style={{ marginTop: '0.5rem' }}>
              <span className="overview-label">File Path on Disk</span>
              <span className="overview-value" style={{ fontSize: '0.8rem', wordBreak: 'break-all' }} data-testid="detail-file-path">
                {clip.media.file}
              </span>
            </div>
          </div>

          {/* Review Form Card */}
          <div className="detail-card">
            <h3 className="card-title">Clip Review (PATCH /clips/:id/review)</h3>
            <form onSubmit={handleSaveReview} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="form-group">
                <label className="form-label">Review Status</label>
                <select
                  className="select-input"
                  value={reviewStatus}
                  onChange={(e) => setReviewStatus(e.target.value as any)}
                  data-testid="review-status-select"
                >
                  <option value="unreviewed">Unreviewed</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                  <option value="favorited">Favorited</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Title</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Enter highlight title..."
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  data-testid="review-title-input"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Tags (comma-separated)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="clutch, headshot, ace..."
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  data-testid="review-tags-input"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea
                  className="form-textarea"
                  rows={2}
                  placeholder="Reviewer notes..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  data-testid="review-notes-input"
                />
              </div>

              <button type="submit" className="btn btn-primary" data-testid="save-review-btn">
                Save Review
              </button>
            </form>
          </div>

          {/* Trim Workbench Card */}
          <div className="detail-card">
            <h3 className="card-title">Trim Clip (POST /clips/:id/trim)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="form-group">
                <label className="form-label">Start Offset (s)</label>
                <input
                  type="number"
                  step="0.5"
                  className="form-input"
                  value={startOffset}
                  onChange={(e) => setStartOffset(parseFloat(e.target.value) || 0)}
                  data-testid="trim-start-input"
                />
              </div>
              <div className="form-group">
                <label className="form-label">End Offset (s)</label>
                <input
                  type="number"
                  step="0.5"
                  className="form-input"
                  value={endOffset}
                  onChange={(e) => setEndOffset(parseFloat(e.target.value) || 0)}
                  data-testid="trim-end-input"
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
              <span className="overview-label">Trimmed Duration</span>
              <span className="overview-value">{trimmedDuration.toFixed(1)}s</span>
            </div>

            <button
              className="btn btn-secondary"
              onClick={() => onTrim && onTrim({ startOffset, endOffset })}
              data-testid="trim-submit-btn"
            >
              Recut Clip from Buffer
            </button>
          </div>

          {/* Export Workbench Card */}
          <div className="detail-card">
            <h3 className="card-title">Export (POST /clips/:id/export)</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={vertical}
                  onChange={(e) => setVertical(e.target.checked)}
                  data-testid="export-vertical-checkbox"
                />
                <span>Vertical Crop (9:16 Center-Weighted)</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={burnCaptions}
                  onChange={(e) => setBurnCaptions(e.target.checked)}
                  data-testid="export-captions-checkbox"
                />
                <span>Burn Captions (Whisper Subtitles)</span>
              </label>
            </div>

            <button
              className="btn btn-primary"
              style={{ marginTop: '0.75rem' }}
              onClick={() => onExport && onExport({ vertical, burnCaptions })}
              data-testid="export-submit-btn"
            >
              Export Clip to Disk
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
