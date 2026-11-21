import React, { useState, useEffect, useCallback } from 'react';
import type { ViewMode, Session, Detection, ClipSidecar, HealthResponse } from './types.js';
import { fetchHealth, fetchSessions, fetchDetections, fetchClips, dismissDetection, updateClipReview } from './api.js';
import { Header } from './components/Header.js';
import { LiveDetectionsList } from './components/LiveDetectionsList.js';
import { ClipGrid } from './components/ClipGrid.js';
import { ClipDetail } from './components/ClipDetail.js';

export const App: React.FC = () => {
  const [activeView, setActiveView] = useState<ViewMode>('live');
  const [activeClipId, setActiveClipId] = useState<string | null>(null);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [detections, setDetections] = useState<Detection[]>([]);
  const [clips, setClips] = useState<ClipSidecar[]>([]);

  const [minScore, setMinScore] = useState<number>(0);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [isPolling, setIsPolling] = useState<boolean>(true);

  // Initial load
  useEffect(() => {
    fetchHealth().then(setHealth).catch(() => {});
    fetchSessions()
      .then((sess) => {
        setSessions(sess);
        if (sess.length > 0 && !activeSessionId) {
          setActiveSessionId(sess[0].id);
        }
      })
      .catch(() => {});
    fetchClips().then(setClips).catch(() => {});
  }, []);

  // Poll live detections & health every 2 seconds per CONTRACTS & C-02 acceptance
  const pollLiveData = useCallback(async () => {
    try {
      const [h, dets] = await Promise.all([
        fetchHealth(),
        fetchDetections({ sessionId: activeSessionId || undefined, minScore })
      ]);
      setHealth(h);
      setDetections(dets);
    } catch {
      // Degraded or offline
    }
  }, [activeSessionId, minScore]);

  useEffect(() => {
    if (!isPolling) return;
    pollLiveData();

    const interval = setInterval(() => {
      pollLiveData();
    }, 2000);

    return () => clearInterval(interval);
  }, [isPolling, pollLiveData]);

  const handleSelectClip = (clipId: string) => {
    setActiveClipId(clipId);
    setActiveView('clip-detail');
  };

  const handleDismissDetection = async (id: string) => {
    try {
      const updated = await dismissDetection(id);
      setDetections((prev) =>
        prev.map((d) => (d.id === id ? { ...d, status: updated.status } : d))
      );
    } catch {
      // Handle error
    }
  };

  const handleSaveReview = async (reviewData: {
    status: string;
    title: string;
    tags: string[];
    notes: string;
  }) => {
    if (!activeClipId) return;
    try {
      const updated = await updateClipReview(activeClipId, reviewData);
      setClips((prev) =>
        prev.map((c) => (c.clip_id === updated.clip_id ? updated : c))
      );
    } catch {
      // Handle error
    }
  };

  const activeClip = clips.find((c) => c.clip_id === activeClipId) || clips[0];

  return (
    <div className="app-container" data-testid="app-container">
      <Header
        activeView={activeView}
        onSelectView={(v) => {
          setActiveView(v);
          if (v === 'clips') fetchClips().then(setClips).catch(() => {});
        }}
        health={health}
        clipCount={clips.length}
      />

      <main className="main-content">
        {activeView === 'live' && (
          <LiveDetectionsList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={setActiveSessionId}
            detections={detections}
            minScore={minScore}
            onChangeMinScore={setMinScore}
            isPolling={isPolling}
            onSelectClip={handleSelectClip}
            onDismiss={handleDismissDetection}
          />
        )}

        {activeView === 'clips' && (
          <ClipGrid
            clips={clips}
            statusFilter={statusFilter}
            onChangeStatusFilter={setStatusFilter}
            sourceFilter={sourceFilter}
            onChangeSourceFilter={setSourceFilter}
            onSelectClip={handleSelectClip}
          />
        )}

        {activeView === 'clip-detail' && activeClip && (
          <ClipDetail
            clip={activeClip}
            onBack={() => setActiveView('clips')}
            onSaveReview={handleSaveReview}
            onTrim={(offsets) => {
              alert(`Recutting clip with start: ${offsets.startOffset}s, end: ${offsets.endOffset}s`);
            }}
            onExport={(opts) => {
              alert(`Exporting clip (vertical: ${opts.vertical}, captions: ${opts.burnCaptions})`);
            }}
          />
        )}
      </main>
    </div>
  );
};
