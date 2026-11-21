import React from 'react';
import type { ViewMode, HealthResponse } from '../types.js';

export interface HeaderProps {
  activeView: ViewMode;
  onSelectView: (view: ViewMode) => void;
  health: HealthResponse | null;
  clipCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeView,
  onSelectView,
  health,
  clipCount
}) => {
  const isApiOk = health?.status === 'ok';
  const isDetectorOk = health?.detector.reachable;
  const isGpuOk = health?.gpu.available;

  return (
    <header className="header" data-testid="app-header">
      <div className="brand">
        <span>clipforge</span>
        <span className="brand-badge">LOCAL V1.0</span>
      </div>

      <nav className="nav-tabs" aria-label="Main Navigation">
        <button
          className={`nav-tab ${activeView === 'live' ? 'active' : ''}`}
          onClick={() => onSelectView('live')}
          data-testid="nav-tab-live"
        >
          <span className="dot green"></span>
          Live Detections
        </button>

        <button
          className={`nav-tab ${activeView === 'clips' || activeView === 'clip-detail' ? 'active' : ''}`}
          onClick={() => onSelectView('clips')}
          data-testid="nav-tab-clips"
        >
          Clips ({clipCount})
        </button>

        <button
          className="nav-tab"
          onClick={() => alert('Storage Browser view: see clips on disk in storage/clips/')}
          data-testid="nav-tab-storage"
        >
          Storage Browser
        </button>
      </nav>

      <div className="health-status" data-testid="health-status-bar">
        <div className="health-pill" title="API Service Status">
          <span className={`dot ${isApiOk ? 'green' : 'yellow'}`}></span>
          <span>API: {health?.status || 'connecting'}</span>
        </div>

        <div className="health-pill" title="Detector Service Status">
          <span className={`dot ${isDetectorOk ? 'green' : 'red'}`}></span>
          <span>Detector: {isDetectorOk ? 'OK' : 'OFFLINE'}</span>
        </div>

        <div className="health-pill" title="Buffer Disk Space">
          <span>Buffer: {health?.buffer_free_gb ?? '--'} GB</span>
        </div>

        <div className="health-pill" title="GPU Hardware Status">
          <span className={`dot ${isGpuOk ? 'green' : 'yellow'}`}></span>
          <span>GPU: {isGpuOk ? (health?.gpu.name || 'ACTIVE') : 'CPU'}</span>
        </div>
      </div>
    </header>
  );
};
