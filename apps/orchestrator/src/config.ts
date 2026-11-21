import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadConfigFile,
  assertSourceAllowed,
  isSourceAllowed,
  ClipforgeConfigType,
  SourceConfigType,
  Logger
} from '@clipforge/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function findRepoRoot(startDir: string = __dirname): string {
  let cur = startDir;
  while (cur !== path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'config', 'clipforge.yaml'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return process.cwd();
}

export function getDefaultConfigPath(): string {
  const root = findRepoRoot();
  return path.join(root, 'config', 'clipforge.yaml');
}

export function loadOrchestratorConfig(customPath?: string): ClipforgeConfigType {
  const resolved = customPath ? path.resolve(customPath) : getDefaultConfigPath();
  return loadConfigFile(resolved);
}

export { assertSourceAllowed, isSourceAllowed };
