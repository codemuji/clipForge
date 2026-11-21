import React from 'react';
import type { ClipSidecar } from '../types.js';

export interface ClipGridProps {
  clips: ClipSidecar[];
  statusFilter: string;
  onChangeStatusFilter: (status: string) => void;
  sourceFilter: string;
  onChangeSourceFilter: (source: string) => void;
  onSelectClip: (clipId: string) => void;
}

export const ClipGrid: React.FC<ClipGridProps> = ({
  clips,
  statusFilter,
  onChangeStatusFilter,
  sourceFilter,
  onChangeSourceFilter,
  onSelectClip
}) => {
  // Extract distinct sources for dropdown
  const distinctSources = Array.from(
    new Set(clips.map((c) => c.source.url_host).filter(Boolean))
  );

  // Client-side filtering
  const filteredClips = clips.filter((clip) => {
    const matchesStatus =
      statusFilter === 'all' ||
      clip.review.status.toLowerCase() === statusFilter.toLowerCase();
    const matchesSource =
      sourceFilter === 'all' ||
      clip.source.url_host.toLowerCase() === sourceFilter.toLowerCase() ||
      clip.source.channel.toLowerCase() === sourceFilter.toLowerCase();
    return matchesStatus && matchesSource;
  });

  return (
    <div className="clip-grid-view" data-testid="clip-grid-view">
      {/* Filters Toolbar */}
      <div className="filter-bar" data-testid="clip-filters-bar">
        <div className="filter-group">
          <span className="overview-label" style={{ marginRight: '0.5rem' }}>Review Status:</span>
          {['all', 'unreviewed', 'approved', 'rejected', 'favorited'].map((status) => (
            <button
              key={status}
              className={`filter-btn ${statusFilter === status ? 'active' : ''}`}
              onClick={() => onChangeStatusFilter(status)}
              data-testid={`filter-status-${status}`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>

        <div className="filter-group">
          <span className="overview-label">Source:</span>
          <select
            className="select-input"
            value={sourceFilter}
            onChange={(e) => onChangeSourceFilter(e.target.value)}
            data-testid="filter-source-select"
          >
            <option value="all">All Sources</option>
            {distinctSources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Grid of Clip Cards */}
      <div className="clip-grid" data-testid="clips-container">
        {filteredClips.length === 0 ? (
          <div className="empty-state" style={{ gridColumn: '1 / -1' }} data-testid="empty-clips-message">
            No clips found matching the selected filters.
          </div>
        ) : (
          filteredClips.map((clip) => {
            const title =
              clip.review.title ||
              `${clip.source.channel} — ${clip.source.t_start_stream.toFixed(0)}s`;

            return (
              <div
                key={clip.clip_id}
                className="clip-card"
                onClick={() => onSelectClip(clip.clip_id)}
                data-testid={`clip-card-${clip.clip_id}`}
              >
                <div className="clip-thumbnail" data-testid={`clip-thumb-${clip.clip_id}`}>
                  <span>▶ {clip.media.codec.toUpperCase()} {clip.media.width}x{clip.media.height}</span>
                  <div className="clip-duration-badge">
                    {clip.media.duration_s.toFixed(1)}s
                  </div>
                </div>

                <div className="clip-info">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <h3 className="clip-title" data-testid={`clip-title-${clip.clip_id}`}>{title}</h3>
                    <span className="badge badge-hype">
                      {clip.detection.fused_score.toFixed(2)}
                    </span>
                  </div>

                  <div className="clip-meta">
                    <span>{clip.source.url_host}/{clip.source.channel}</span>
                    <span>{clip.created_at ? new Date(clip.created_at).toLocaleDateString() : 'Recent'}</span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
                      {clip.detection.top_signals.map((sig) => (
                        <span key={sig} className="chip" style={{ padding: '0.1rem 0.4rem', fontSize: '0.7rem' }}>
                          {sig}
                        </span>
                      ))}
                    </div>

                    <span
                      className={`badge ${
                        clip.review.status === 'approved'
                          ? 'badge-hype'
                          : clip.review.status === 'rejected'
                          ? 'badge-dismissed'
                          : 'badge-scored'
                      }`}
                      data-testid={`clip-status-${clip.clip_id}`}
                    >
                      {clip.review.status}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
