import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

// Ensure dependencies if node_modules is missing
if (!fs.existsSync(path.join(__dirname, '..', 'node_modules'))) {
  console.log('node_modules not found. Running npm install...');
  run('npm install');
}

console.log('[LINT] Building shared declarations...');
run('npx tsc -p packages/shared/tsconfig.json');

console.log('[LINT] Running typecheck...');
run('npx tsc -p apps/orchestrator/tsconfig.json --noEmit');

console.log('[LINT] All lint and type checks passed.');
