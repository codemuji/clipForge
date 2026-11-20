import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('[CLEAN] Cleaning buffer and temporary files (preserving storage/clips)...');

const bufferDir = path.join(__dirname, '..', 'storage', 'buffer');
if (fs.existsSync(bufferDir)) {
  fs.rmSync(bufferDir, { recursive: true, force: true });
  fs.mkdirSync(bufferDir, { recursive: true });
  console.log('[CLEAN] Cleared storage/buffer.');
}

const distDirs = [
  path.join(__dirname, '..', 'packages', 'shared', 'dist'),
  path.join(__dirname, '..', 'apps', 'orchestrator', 'dist'),
  path.join(__dirname, '..', 'apps', 'api', 'dist'),
  path.join(__dirname, '..', 'apps', 'dashboard', 'dist')
];

for (const d of distDirs) {
  if (fs.existsSync(d)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}
console.log('[CLEAN] Cleared build output.');
