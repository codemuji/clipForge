import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

console.log('[EVAL:DETECTOR] Running detector model evaluation sweep...');

const venvPython = process.platform === 'win32'
  ? path.join(repoRoot, 'workers', 'detector', '.venv', 'Scripts', 'python.exe')
  : path.join(repoRoot, 'workers', 'detector', '.venv', 'bin', 'python');

const pythonBin = fs.existsSync(venvPython) ? `"${venvPython}"` : (process.platform === 'win32' ? 'python' : 'python3');

try {
  const evalScript = path.join(repoRoot, 'workers', 'detector', 'src', 'eval.py');
  execSync(`${pythonBin} "${evalScript}"`, {
    stdio: 'inherit',
    cwd: repoRoot,
  });
} catch (err) {
  console.error('[EVAL:DETECTOR] Evaluation failed:', err.message);
  process.exit(1);
}
