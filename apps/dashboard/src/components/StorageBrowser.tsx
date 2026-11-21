import React, { useState } from 'react';
import type { StorageNode, StorageTreeResponse } from '../types.js';

export interface StorageBrowserProps {
  treeData: StorageTreeResponse | null;
  isLoading?: boolean;
  onRefresh?: () => void;
  onReveal?: (relPath: string) => Promise<{ success: boolean; target: string; command: string } | void>;
}

export const StorageBrowser: React.FC<StorageBrowserProps> = ({
  treeData,
  isLoading = false,
  onRefresh,
  onReveal
}) => {
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({ '': true });
  const [revealNotice, setRevealNotice] = useState<string | null>(null);

  const toggleExpand = (pathKey: string) => {
    setExpandedPaths((prev) => ({
      ...prev,
      [pathKey]: !prev[pathKey]
    }));
  };

  const handleReveal = async (e: React.MouseEvent, relPath: string) => {
    e.stopPropagation();
    if (onReveal) {
      try {
        const res = await onReveal(relPath);
        const targetName = res?.target || relPath || 'storage root';
        setRevealNotice(`Revealed in Explorer: ${targetName}`);
        setTimeout(() => setRevealNotice(null), 3500);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setRevealNotice(`Error: ${msg}`);
        setTimeout(() => setRevealNotice(null), 3500);
      }
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const getFileIcon = (node: StorageNode): string => {
    if (node.type === 'directory') return '📁';
    if (node.extension === '.mp4') return '🎬';
    if (node.extension === '.json') return '📄';
    if (node.extension === '.sqlite') return '💾';
    if (node.extension === '.log') return '📋';
    return '📄';
  };

  const renderNode = (node: StorageNode, depth: number = 0) => {
    const isDir = node.type === 'directory';
    const isExpanded = expandedPaths[node.path] !== false; // default expanded

    return (
      <div key={node.path || 'root'} className="storage-node-wrapper" style={{ marginLeft: `${depth * 1.25}rem` }}>
        <div
          className={`storage-row ${isDir ? 'is-dir' : 'is-file'}`}
          onClick={isDir ? () => toggleExpand(node.path) : undefined}
          data-testid={`storage-row-${node.path || 'root'}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.4rem 0.6rem',
            borderRadius: '4px',
            marginBottom: '0.2rem',
            cursor: isDir ? 'pointer' : 'default',
            backgroundColor: 'rgba(255, 255, 255, 0.03)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
            {isDir ? (
              <span style={{ fontSize: '0.8rem', width: '1rem', userSelect: 'none' }}>
                {isExpanded ? '▼' : '►'}
              </span>
            ) : (
              <span style={{ width: '1rem' }}></span>
            )}
            <span style={{ fontSize: '1.1rem' }}>{getFileIcon(node)}</span>
            <span
              style={{
                fontWeight: isDir ? 600 : 400,
                color: isDir ? '#f1f5f9' : '#cbd5e1',
                fontSize: '0.9rem'
              }}
            >
              {node.name}
            </span>
            {node.type === 'file' && (
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                ({formatBytes(node.size_bytes)})
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {node.modified_at && (
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                {new Date(node.modified_at).toLocaleDateString()}
              </span>
            )}

            <button
              className="btn btn-secondary"
              style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
              onClick={(e) => handleReveal(e, node.path)}
              data-testid={`reveal-btn-${node.path || 'root'}`}
              title="Reveal in OS native file manager"
            >
              Reveal
            </button>
          </div>
        </div>

        {isDir && isExpanded && node.children && node.children.length > 0 && (
          <div className="storage-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}

        {isDir && isExpanded && (!node.children || node.children.length === 0) && (
          <div style={{ marginLeft: `${(depth + 1) * 1.25}rem`, fontSize: '0.8rem', color: '#64748b', padding: '0.2rem 0' }}>
            (empty folder)
          </div>
        )}
      </div>
    );
  };

  const tree = treeData?.tree;
  const stats = treeData?.stats;

  return (
    <div className="storage-browser" data-testid="storage-browser">
      <div className="panel-header" style={{ marginBottom: '1.5rem' }}>
        <div>
          <h2>Storage Browser</h2>
          <p className="section-subtitle">
            Explore clips, rolling buffer, database, and logs on disk. Reveal any folder or clip directly in your OS file manager.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {onRefresh && (
            <button
              className="btn btn-secondary"
              onClick={onRefresh}
              disabled={isLoading}
              data-testid="storage-refresh-btn"
            >
              {isLoading ? 'Scanning...' : 'Refresh Tree'}
            </button>
          )}
          {onReveal && (
            <button
              className="btn btn-primary"
              onClick={(e) => handleReveal(e, '')}
              data-testid="reveal-root-btn"
            >
              Open Storage Folder
            </button>
          )}
        </div>
      </div>

      {revealNotice && (
        <div
          data-testid="reveal-notice"
          style={{
            marginBottom: '1rem',
            padding: '0.6rem 1rem',
            background: 'rgba(34, 197, 94, 0.15)',
            border: '1px solid rgba(34, 197, 94, 0.4)',
            borderRadius: '6px',
            color: '#86efac',
            fontSize: '0.85rem'
          }}
        >
          ✓ {revealNotice}
        </div>
      )}

      {/* Summary Metrics Cards */}
      <div
        className="storage-stats-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem'
        }}
      >
        <div className="card" style={{ padding: '1rem' }}>
          <div style={{ color: '#94a3b8', fontSize: '0.8rem', textTransform: 'uppercase' }}>Total Storage Used</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f8fafc', marginTop: '0.25rem' }}>
            {stats ? formatBytes(stats.total_bytes) : '0 B'}
          </div>
        </div>

        <div className="card" style={{ padding: '1rem' }}>
          <div style={{ color: '#94a3b8', fontSize: '0.8rem', textTransform: 'uppercase' }}>Directories</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#38bdf8', marginTop: '0.25rem' }}>
            {stats?.total_directories ?? 0}
          </div>
        </div>

        <div className="card" style={{ padding: '1rem' }}>
          <div style={{ color: '#94a3b8', fontSize: '0.8rem', textTransform: 'uppercase' }}>Files Stored</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#a855f7', marginTop: '0.25rem' }}>
            {stats?.total_files ?? 0}
          </div>
        </div>

        <div className="card" style={{ padding: '1rem' }}>
          <div style={{ color: '#94a3b8', fontSize: '0.8rem', textTransform: 'uppercase' }}>Root Location</div>
          <div
            style={{
              fontSize: '0.85rem',
              color: '#94a3b8',
              marginTop: '0.5rem',
              wordBreak: 'break-all',
              fontFamily: 'monospace'
            }}
          >
            {treeData?.root || 'storage/'}
          </div>
        </div>
      </div>

      {/* File Tree Card */}
      <div className="card" style={{ padding: '1.25rem' }} data-testid="storage-tree-container">
        <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color: '#e2e8f0' }}>
          Storage Tree
        </h3>

        {isLoading && !tree ? (
          <div style={{ color: '#64748b', padding: '1rem', textAlign: 'center' }}>
            Scanning storage directory...
          </div>
        ) : tree ? (
          <div className="tree-content">
            {renderNode(tree)}
          </div>
        ) : (
          <div style={{ color: '#64748b', padding: '1rem', textAlign: 'center' }}>
            No files or directories found in storage.
          </div>
        )}
      </div>
    </div>
  );
};
