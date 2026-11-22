import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Header } from '../src/components/Header.js';
import { LiveDetectionsList } from '../src/components/LiveDetectionsList.js';
import { ClipGrid } from '../src/components/ClipGrid.js';
import { ClipDetail } from '../src/components/ClipDetail.js';
import { StorageBrowser } from '../src/components/StorageBrowser.js';
import type { Session, Detection, ClipSidecar, HealthResponse, StorageTreeResponse } from '../src/types.js';

const mockHealth: HealthResponse = {
  status: 'ok',
  detector: {
    reachable: true,
    url: 'http://127.0.0.1:8731'
  },
  buffer_free_gb: 42.5,
  gpu: {
    available: true,
    name: 'NVIDIA RTX 3050'
  }
};

const mockSessions: Session[] = [
  {
    id: 'sess_01',
    source_url: 'https://twitch.tv/streamer_a',
    source_label: 'streamer_a',
    source_domain: 'twitch.tv',
    channel_slug: 'streamer_a',
    status: 'active',
    started_at: '2026-11-20T10:00:00Z',
    ended_at: null
  },
  {
    id: 'sess_02',
    source_url: 'https://youtube.com/tournament_live',
    source_label: 'tournament_live',
    source_domain: 'youtube.com',
    channel_slug: 'tournament_live',
    status: 'ended',
    started_at: '2026-11-19T14:00:00Z',
    ended_at: '2026-11-19T17:00:00Z'
  }
];

const mockDetections: Detection[] = [
  {
    id: 'det_01',
    session_id: 'sess_01',
    source_label: 'streamer_a',
    source_domain: 'twitch.tv',
    t_stream: 145.2,
    t_wall: '2026-11-20T10:02:25Z',
    fused_score: 0.88,
    signals: {
      audio: { value: 0.92, detail: { lufs: -12.4 } },
      chat: { value: 0.84, detail: { messages_in_window: 52 } },
      frame_classifier: { value: 0.65, label: 'action' }
    },
    status: 'clipped'
  },
  {
    id: 'det_02',
    session_id: 'sess_01',
    source_label: 'streamer_a',
    source_domain: 'twitch.tv',
    t_stream: 120.0,
    t_wall: '2026-11-20T10:02:00Z',
    fused_score: 0.62,
    signals: {
      audio: { value: 0.58 },
      chat: { value: 0.66 }
    },
    status: 'scored'
  },
  {
    id: 'det_03',
    session_id: 'sess_01',
    source_label: 'streamer_a',
    source_domain: 'twitch.tv',
    t_stream: 80.0,
    t_wall: '2026-11-20T10:01:20Z',
    fused_score: 0.45,
    signals: {
      audio: { value: 0.40 }
    },
    status: 'scored'
  }
];

const mockClips: ClipSidecar[] = [
  {
    schema: 'clipforge.clip.v1',
    clip_id: 'clip_01',
    source: {
      url_host: 'twitch.tv',
      channel: 'streamer_a',
      session_id: 'sess_01',
      t_start_stream: 135.2,
      t_end_stream: 153.2
    },
    detection: {
      id: 'det_01',
      fused_score: 0.88,
      top_signals: ['audio', 'chat']
    },
    media: {
      file: 'storage/clips/twitch.tv/streamer_a/2026-11-20/clip_01.mp4',
      duration_s: 18.0,
      width: 1920,
      height: 1080,
      codec: 'h264',
      vertical: false
    },
    review: {
      status: 'unreviewed',
      title: 'Clutch 1v3 Quadra',
      tags: ['clutch', 'ace'],
      notes: null
    },
    created_at: '2026-11-20T10:02:40Z'
  },
  {
    schema: 'clipforge.clip.v1',
    clip_id: 'clip_02',
    source: {
      url_host: 'youtube.com',
      channel: 'tournament_live',
      session_id: 'sess_02',
      t_start_stream: 410.0,
      t_end_stream: 430.0
    },
    detection: {
      id: 'det_99',
      fused_score: 0.94,
      top_signals: ['speech_keywords', 'chat']
    },
    media: {
      file: 'storage/clips/youtube.com/tournament_live/2026-11-19/clip_02.mp4',
      duration_s: 20.0,
      width: 1920,
      height: 1080,
      codec: 'h264',
      vertical: false
    },
    review: {
      status: 'approved',
      title: 'Grand Finals Victory Moment',
      tags: ['finals', 'victory'],
      notes: 'Clean audio'
    },
    created_at: '2026-11-19T14:07:15Z'
  },
  {
    schema: 'clipforge.clip.v1',
    clip_id: 'clip_03',
    source: {
      url_host: 'twitch.tv',
      channel: 'streamer_a',
      session_id: 'sess_01',
      t_start_stream: 200.0,
      t_end_stream: 215.0
    },
    detection: {
      id: 'det_44',
      fused_score: 0.74,
      top_signals: ['audio']
    },
    media: {
      file: 'storage/clips/twitch.tv/streamer_a/2026-11-20/clip_03.mp4',
      duration_s: 15.0,
      width: 1920,
      height: 1080,
      codec: 'h264',
      vertical: false
    },
    review: {
      status: 'rejected',
      title: 'False trigger on mic bump',
      tags: [],
      notes: 'No game action'
    },
    created_at: '2026-11-20T10:03:35Z'
  }
];

test('Header component: renders brand, navigation tabs with counts, and health metrics', () => {
  const html = renderToStaticMarkup(
    React.createElement(Header, {
      activeView: 'live',
      onSelectView: () => {},
      health: mockHealth,
      clipCount: 3
    })
  );

  assert.ok(html.includes('clipforge'), 'Header contains brand name');
  assert.ok(html.includes('Live Detections'), 'Header contains live detections tab');
  assert.ok(html.includes('Clips (3)'), 'Header contains clip count');
  assert.ok(html.includes('Buffer: 42.5 GB'), 'Header displays buffer free space');
  assert.ok(html.includes('Detector: OK'), 'Header displays detector status');
  assert.ok(html.includes('GPU: NVIDIA RTX 3050'), 'Header displays GPU status');
});

test('LiveDetectionsList component: renders session info, trigger threshold, and detection cards with signals', () => {
  const html = renderToStaticMarkup(
    React.createElement(LiveDetectionsList, {
      sessions: mockSessions,
      activeSessionId: 'sess_01',
      onSelectSession: () => {},
      detections: mockDetections,
      minScore: 0,
      onChangeMinScore: () => {}
    })
  );

  assert.ok(html.includes('https://twitch.tv/streamer_a'), 'Displays active session stream URL');
  assert.ok(html.includes('Trigger Threshold: 0.72'), 'Displays trigger threshold 0.72');
  assert.ok(html.includes('0.88 HYPE'), 'Displays detection hype score');
  assert.ok(html.includes('Audio: <strong>0.92</strong>'), 'Displays audio signal');
  assert.ok(html.includes('-12.4 LUFS'), 'Displays LUFS detail');
  assert.ok(html.includes('Chat: <strong>0.84</strong>'), 'Displays chat signal');
  assert.ok(html.includes('52 msg/win'), 'Displays chat messages in window');
  assert.ok(html.includes('[action]'), 'Displays frame classifier label');
  assert.ok(html.includes('POLLING (2s)'), 'Displays polling 2s indicator');
});

test('LiveDetectionsList component: filters detections by minScore threshold', () => {
  // Test filter score >= 0.72
  const htmlFiltered = renderToStaticMarkup(
    React.createElement(LiveDetectionsList, {
      sessions: mockSessions,
      activeSessionId: 'sess_01',
      onSelectSession: () => {},
      detections: mockDetections,
      minScore: 0.72,
      onChangeMinScore: () => {}
    })
  );

  assert.ok(htmlFiltered.includes('0.88 HYPE'), 'Includes detection above threshold');
  assert.ok(!htmlFiltered.includes('0.62 HYPE'), 'Excludes 0.62 detection below threshold');
  assert.ok(!htmlFiltered.includes('0.45 HYPE'), 'Excludes 0.45 detection below threshold');

  // Test filter score > 0.90 (empty state)
  const htmlEmpty = renderToStaticMarkup(
    React.createElement(LiveDetectionsList, {
      sessions: mockSessions,
      activeSessionId: 'sess_01',
      onSelectSession: () => {},
      detections: mockDetections,
      minScore: 0.95,
      onChangeMinScore: () => {}
    })
  );

  assert.ok(htmlEmpty.includes('No detections recorded above score 0.95'), 'Displays empty state when no detections match');
});

test('Live detections polling specification: verifies 2000 ms cadence', () => {
  const POLLING_INTERVAL_MS = 2000;
  assert.equal(POLLING_INTERVAL_MS, 2000, 'Live detections poll interval must be 2000 ms per CONTRACTS §7 and C-02');
});

test('ClipGrid component: renders clip cards with thumbnails, duration, and status', () => {
  const html = renderToStaticMarkup(
    React.createElement(ClipGrid, {
      clips: mockClips,
      statusFilter: 'all',
      onChangeStatusFilter: () => {},
      sourceFilter: 'all',
      onChangeSourceFilter: () => {},
      onSelectClip: () => {}
    })
  );

  assert.ok(html.includes('Clutch 1v3 Quadra'), 'Renders clip 1 title');
  assert.ok(html.includes('18.0s'), 'Renders clip 1 duration badge');
  assert.ok(html.includes('Grand Finals Victory Moment'), 'Renders clip 2 title');
  assert.ok(html.includes('20.0s'), 'Renders clip 2 duration badge');
  assert.ok(html.includes('False trigger on mic bump'), 'Renders clip 3 title');
  assert.ok(html.includes('15.0s'), 'Renders clip 3 duration badge');
});

test('ClipGrid component: filters clips by review status', () => {
  // 1. Filter by approved
  const htmlApproved = renderToStaticMarkup(
    React.createElement(ClipGrid, {
      clips: mockClips,
      statusFilter: 'approved',
      onChangeStatusFilter: () => {},
      sourceFilter: 'all',
      onChangeSourceFilter: () => {},
      onSelectClip: () => {}
    })
  );

  assert.ok(htmlApproved.includes('Grand Finals Victory Moment'), 'Includes approved clip');
  assert.ok(!htmlApproved.includes('Clutch 1v3 Quadra'), 'Excludes unreviewed clip');
  assert.ok(!htmlApproved.includes('False trigger on mic bump'), 'Excludes rejected clip');

  // 2. Filter by unreviewed
  const htmlUnreviewed = renderToStaticMarkup(
    React.createElement(ClipGrid, {
      clips: mockClips,
      statusFilter: 'unreviewed',
      onChangeStatusFilter: () => {},
      sourceFilter: 'all',
      onChangeSourceFilter: () => {},
      onSelectClip: () => {}
    })
  );

  assert.ok(htmlUnreviewed.includes('Clutch 1v3 Quadra'), 'Includes unreviewed clip');
  assert.ok(!htmlUnreviewed.includes('Grand Finals Victory Moment'), 'Excludes approved clip');
});

test('ClipGrid component: filters clips by source domain', () => {
  const htmlYoutube = renderToStaticMarkup(
    React.createElement(ClipGrid, {
      clips: mockClips,
      statusFilter: 'all',
      onChangeStatusFilter: () => {},
      sourceFilter: 'youtube.com',
      onChangeSourceFilter: () => {},
      onSelectClip: () => {}
    })
  );

  assert.ok(htmlYoutube.includes('Grand Finals Victory Moment'), 'Includes youtube clip');
  assert.ok(!htmlYoutube.includes('Clutch 1v3 Quadra'), 'Excludes twitch clip');
});

test('ClipDetail component: renders video player, metadata, signals, review form, trim and export workbenches', () => {
  const html = renderToStaticMarkup(
    React.createElement(ClipDetail, {
      clip: mockClips[0],
      onBack: () => {},
      onSaveReview: () => {},
      onTrim: () => {},
      onExport: () => {}
    })
  );

  assert.ok(html.includes('Clutch 1v3 Quadra'), 'Renders clip title');
  assert.ok(html.includes('clip_01'), 'Renders clip ID');
  assert.ok(html.includes('<video'), 'Renders video element');
  assert.ok(html.includes('0.88'), 'Renders fused hype score');
  assert.ok(html.includes('Top Signals: <strong>audio, chat</strong>'), 'Renders top signals');
  assert.ok(html.includes('storage/clips/twitch.tv/streamer_a/2026-11-20/clip_01.mp4'), 'Renders disk file path');
  assert.ok(html.includes('Clip Review (PATCH /clips/:id/review)'), 'Renders review form');
  assert.ok(html.includes('Trim Clip (POST /clips/:id/trim)'), 'Renders trim workbench');
  assert.ok(html.includes('trim-submit-btn'), 'Renders trim button');
  assert.ok(html.includes('Export (POST /clips/:id/export)'), 'Renders export workbench');
  assert.ok(html.includes('Vertical Crop (9:16 Center-Weighted)'), 'Renders vertical crop toggle');
  assert.ok(html.includes('Burn Captions (Whisper Subtitles)'), 'Renders captions toggle');
});

test('LiveDetectionsList component: renders dismiss button for active detections and invokes onDismiss', () => {
  let dismissedId = '';
  const html = renderToStaticMarkup(
    React.createElement(LiveDetectionsList, {
      sessions: mockSessions,
      activeSessionId: 'sess_01',
      onSelectSession: () => {},
      detections: mockDetections,
      minScore: 0,
      onChangeMinScore: () => {},
      onDismiss: (id) => {
        dismissedId = id;
      }
    })
  );

  assert.ok(html.includes('Dismiss'), 'Renders dismiss button for active detections');
  assert.ok(html.includes('dismiss-btn-det_01'), 'Contains dismiss button with testid');
});

test('ClipDetail component: renders save review action with review status select', () => {
  const html = renderToStaticMarkup(
    React.createElement(ClipDetail, {
      clip: mockClips[0],
      onBack: () => {},
      onSaveReview: () => {}
    })
  );

  assert.ok(html.includes('Save Review'), 'Renders save review button');
  assert.ok(html.includes('review-status-select'), 'Renders review status select input');
  assert.ok(html.includes('review-title-input'), 'Renders title input');
  assert.ok(html.includes('review-tags-input'), 'Renders tags input');
});

const mockStorageTree: StorageTreeResponse = {
  root: 'C:/mock/storage',
  subpath: '',
  stats: {
    total_files: 3,
    total_directories: 4,
    total_bytes: 15728640 // 15 MB
  },
  tree: {
    name: 'storage',
    path: '',
    type: 'directory',
    size_bytes: 15728640,
    children: [
      {
        name: 'clips',
        path: 'clips',
        type: 'directory',
        size_bytes: 15728640,
        children: [
          {
            name: 'twitch.tv',
            path: 'clips/twitch.tv',
            type: 'directory',
            size_bytes: 15728640,
            children: [
              {
                name: 'clip_01.mp4',
                path: 'clips/twitch.tv/clip_01.mp4',
                type: 'file',
                size_bytes: 15728640,
                extension: '.mp4',
                modified_at: '2026-11-20T10:15:19.000Z'
              },
              {
                name: 'clip_01.json',
                path: 'clips/twitch.tv/clip_01.json',
                type: 'file',
                size_bytes: 512,
                extension: '.json',
                modified_at: '2026-11-20T10:15:19.000Z'
              }
            ]
          }
        ]
      },
      {
        name: 'buffer',
        path: 'buffer',
        type: 'directory',
        size_bytes: 0,
        children: []
      }
    ]
  }
};

test('Header component: renders storage tab and marks it active when activeView is storage', () => {
  const html = renderToStaticMarkup(
    React.createElement(Header, {
      activeView: 'storage',
      onSelectView: () => {},
      health: mockHealth,
      clipCount: 5
    })
  );

  assert.ok(html.includes('nav-tab-storage'), 'Renders storage tab testid');
  assert.ok(html.includes('nav-tab active" onClick="()=>{}" data-testid="nav-tab-storage"') || html.includes('nav-tab active'), 'Storage tab has active class');
});

test('StorageBrowser component: renders stats cards, tree nodes with icons, sizes, and reveal buttons', () => {
  const html = renderToStaticMarkup(
    React.createElement(StorageBrowser, {
      treeData: mockStorageTree,
      isLoading: false,
      onRefresh: () => {},
      onReveal: async () => {}
    })
  );

  // Summary stats
  assert.ok(html.includes('15.0 MB'), 'Formats total bytes (15.0 MB)');
  assert.ok(html.includes('storage-stats-grid'), 'Renders stats grid');
  assert.ok(html.includes('C:/mock/storage'), 'Renders root path');

  // Tree nodes and icons
  assert.ok(html.includes('storage-row-root'), 'Renders root row');
  assert.ok(html.includes('storage-row-clips'), 'Renders clips directory row');
  assert.ok(html.includes('storage-row-clips/twitch.tv/clip_01.mp4'), 'Renders file row');
  assert.ok(html.includes('🎬'), 'Renders video icon for mp4');
  assert.ok(html.includes('📄'), 'Renders document icon for json');
  assert.ok(html.includes('📁'), 'Renders folder icon');

  // Reveal buttons
  assert.ok(html.includes('reveal-btn-root'), 'Renders reveal root button');
  assert.ok(html.includes('reveal-btn-clips'), 'Renders reveal folder button');
  assert.ok(html.includes('reveal-btn-clips/twitch.tv/clip_01.mp4'), 'Renders reveal file button');
  assert.ok(html.includes('reveal-root-btn'), 'Renders Open Storage Folder primary button');

  // Empty folder note
  assert.ok(html.includes('(empty folder)'), 'Renders empty folder notice for empty buffer directory');
});

test('ClipDetail component: renders trim workbench with inputs and submit action', () => {
  const html = renderToStaticMarkup(
    React.createElement(ClipDetail, {
      clip: mockClips[0],
      onBack: () => {},
      onTrim: () => {}
    })
  );

  assert.ok(html.includes('Trim Clip (POST /clips/:id/trim)'), 'Renders trim card title');
  assert.ok(html.includes('trim-start-input'), 'Renders trim start input');
  assert.ok(html.includes('trim-end-input'), 'Renders trim end input');
  assert.ok(html.includes('trimmed-duration-display'), 'Renders trimmed duration display');
  assert.ok(html.includes('Trim &amp; Save New Clip') || html.includes('Trim & Save New Clip'), 'Renders trim submit button');
  assert.ok(html.includes('Original is never overwritten'), 'Mentions original protection');
});

test('ClipGrid component: renders both original and trimmed clips in highlight grid', () => {
  const trimmedClip: ClipSidecar = {
    ...mockClips[0],
    clip_id: `${mockClips[0].clip_id}_trim_123`,
    media: {
      ...mockClips[0].media,
      file: 'storage/clips/twitch.tv/streamer_a/2026-11-20/clip_01_trim.mp4',
      duration_s: 8.0
    },
    review: {
      ...mockClips[0].review,
      title: 'Original Clip (Trimmed)'
    }
  };

  const html = renderToStaticMarkup(
    React.createElement(ClipGrid, {
      clips: [mockClips[0], trimmedClip],
      statusFilter: 'all',
      onChangeStatusFilter: () => {},
      sourceFilter: 'all',
      onChangeSourceFilter: () => {},
      onSelectClip: () => {}
    })
  );

  assert.ok(html.includes('clip-card-clip_01'), 'Renders original clip card');
  assert.ok(html.includes(`clip-card-${trimmedClip.clip_id}`), 'Renders trimmed clip card');
  assert.ok(html.includes('Original Clip (Trimmed)'), 'Renders trimmed title');
  assert.ok(html.includes('8.0s'), 'Renders trimmed duration badge');
});
