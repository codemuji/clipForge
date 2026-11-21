import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface StorageNode {
  name: string;
  path: string; // relative to storage root using forward slashes
  type: 'file' | 'directory';
  size_bytes: number;
  modified_at?: string;
  extension?: string;
  children?: StorageNode[];
}

export interface StorageTreeStats {
  total_files: number;
  total_directories: number;
  total_bytes: number;
}

export interface StorageTreeResponse {
  root: string;
  subpath: string;
  tree: StorageNode;
  stats: StorageTreeStats;
}

export interface RevealResult {
  success: boolean;
  command: string;
  args: string[];
  target: string;
}

/**
 * Returns command and arguments to reveal a target file or folder in OS file explorer
 */
export function getRevealCommand(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
  isDirectory: boolean = false
): { command: string; args: string[] } {
  const norm = path.normalize(targetPath);
  if (platform === 'win32') {
    if (isDirectory) {
      return { command: 'explorer.exe', args: [norm] };
    }
    return { command: 'explorer.exe', args: [`/select,${norm}`] };
  } else if (platform === 'darwin') {
    if (isDirectory) {
      return { command: 'open', args: [norm] };
    }
    return { command: 'open', args: ['-R', norm] };
  } else {
    // Linux and other POSIX
    if (isDirectory) {
      return { command: 'xdg-open', args: [norm] };
    }
    return { command: 'xdg-open', args: [path.dirname(norm)] };
  }
}

/**
 * Builds a file and folder tree starting from storageRoot / subPath
 */
export function buildStorageTree(
  storageRoot: string,
  subPath: string = '',
  maxDepth: number = 10
): StorageTreeResponse {
  const resolvedRoot = path.resolve(storageRoot);
  const targetPath = path.resolve(resolvedRoot, subPath || '');
  const relFromRoot = path.relative(resolvedRoot, targetPath);

  // Security guard against path traversal
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new Error('Access denied: path traversal outside storage directory');
  }

  const stats: StorageTreeStats = {
    total_files: 0,
    total_directories: 0,
    total_bytes: 0
  };

  if (!fs.existsSync(targetPath)) {
    return {
      root: resolvedRoot.replace(/\\/g, '/'),
      subpath: subPath.replace(/\\/g, '/'),
      tree: {
        name: path.basename(targetPath) || 'storage',
        path: relFromRoot ? relFromRoot.replace(/\\/g, '/') : '',
        type: 'directory',
        size_bytes: 0,
        children: []
      },
      stats
    };
  }

  function traverse(currentAbsPath: string, depth: number): StorageNode {
    const currentRel = path.relative(resolvedRoot, currentAbsPath).replace(/\\/g, '/');
    const name = path.basename(currentAbsPath) || (currentRel === '' ? 'storage' : currentRel);
    const stat = fs.statSync(currentAbsPath);

    if (stat.isFile()) {
      stats.total_files++;
      stats.total_bytes += stat.size;
      return {
        name,
        path: currentRel,
        type: 'file',
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        extension: path.extname(name).toLowerCase()
      };
    }

    // It's a directory
    stats.total_directories++;
    const node: StorageNode = {
      name,
      path: currentRel,
      type: 'directory',
      size_bytes: 0,
      modified_at: stat.mtime.toISOString(),
      children: []
    };

    if (depth >= maxDepth) {
      return node;
    }

    try {
      const entries = fs.readdirSync(currentAbsPath, { withFileTypes: true });

      // Sort directories first (alphabetical), then files (alphabetical)
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      let totalDirSize = 0;
      for (const entry of entries) {
        const entryAbs = path.join(currentAbsPath, entry.name);
        try {
          const childNode = traverse(entryAbs, depth + 1);
          totalDirSize += childNode.size_bytes;
          node.children?.push(childNode);
        } catch {
          // Skip inaccessible entries
        }
      }
      node.size_bytes = totalDirSize;
    } catch {
      // Permission error or unreadable dir
    }

    return node;
  }

  const rootStat = fs.statSync(targetPath);
  const tree = rootStat.isDirectory()
    ? traverse(targetPath, 0)
    : {
        name: path.basename(targetPath),
        path: relFromRoot.replace(/\\/g, '/'),
        type: 'file' as const,
        size_bytes: rootStat.size,
        modified_at: rootStat.mtime.toISOString(),
        extension: path.extname(targetPath).toLowerCase()
      };

  return {
    root: resolvedRoot.replace(/\\/g, '/'),
    subpath: subPath.replace(/\\/g, '/'),
    tree,
    stats
  };
}

/**
 * Reveals a target file or folder in the OS native file explorer
 */
export function revealInExplorer(
  storageRoot: string,
  subPath: string,
  options: {
    platform?: NodeJS.Platform;
    spawnFn?: (command: string, args: string[]) => void;
  } = {}
): RevealResult {
  const resolvedRoot = path.resolve(storageRoot);
  const targetPath = path.resolve(resolvedRoot, subPath || '');
  const relFromRoot = path.relative(resolvedRoot, targetPath);

  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new Error('Access denied: target path is outside storage directory');
  }

  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target path does not exist: ${subPath}`);
  }

  const stat = fs.statSync(targetPath);
  const isDir = stat.isDirectory();
  const platform = options.platform || process.platform;
  const { command, args } = getRevealCommand(targetPath, platform, isDir);

  if (options.spawnFn) {
    options.spawnFn(command, args);
  } else {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (err) {
      console.error(`Failed to launch file manager: ${err}`);
    }
  }

  return {
    success: true,
    command,
    args,
    target: relFromRoot.replace(/\\/g, '/')
  };
}
