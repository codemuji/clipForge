import path from 'node:path';

export interface ClipStoragePaths {
  clipDir: string;
  mp4Path: string;
  sidecarPath: string;
  relativeMp4Path: string;
  relativeSidecarPath: string;
  domain: string;
  channel: string;
  dateStr: string;
}

/**
 * Normalizes source domain by stripping protocol, port, and leading www.
 */
export function normalizeSourceDomain(sourceUrlOrDomain: string): string {
  let domain = sourceUrlOrDomain.trim().toLowerCase();
  try {
    if (domain.includes('://')) {
      const parsed = new URL(domain);
      domain = parsed.hostname;
    } else {
      domain = domain.split('/')[0];
    }
  } catch {
    domain = domain.split('/')[0];
  }

  // Strip leading www. and trailing ports
  domain = domain.replace(/^www\./, '').split(':')[0];
  return domain || 'local';
}

/**
 * Normalizes channel slug for filesystem safety.
 */
export function normalizeChannelSlug(channel: string): string {
  const clean = channel.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return clean || 'default';
}

/**
 * Resolves clip directory, MP4 file path, and sidecar path according to AGENTS.md §4:
 * storage/clips/<source-domain>/<channel-slug>/<YYYY-MM-DD>/<clip-id>.[mp4|json]
 */
export function resolveClipPaths(
  storageRoot: string,
  sourceUrlOrDomain: string,
  channelSlug: string,
  wallDateIso: string,
  clipId: string
): ClipStoragePaths {
  const domain = normalizeSourceDomain(sourceUrlOrDomain);
  const channel = normalizeChannelSlug(channelSlug);
  const dateStr = wallDateIso.substring(0, 10); // YYYY-MM-DD

  const relDir = path.join('clips', domain, channel, dateStr);
  const clipDir = path.resolve(storageRoot, relDir);

  const mp4Filename = `${clipId}.mp4`;
  const sidecarFilename = `${clipId}.json`;

  const mp4Path = path.join(clipDir, mp4Filename);
  const sidecarPath = path.join(clipDir, sidecarFilename);

  const relativeMp4Path = path.join('storage', relDir, mp4Filename).replace(/\\/g, '/');
  const relativeSidecarPath = path.join('storage', relDir, sidecarFilename).replace(/\\/g, '/');

  return {
    clipDir,
    mp4Path,
    sidecarPath,
    relativeMp4Path,
    relativeSidecarPath,
    domain,
    channel,
    dateStr
  };
}
