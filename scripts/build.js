import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

if (!fs.existsSync(path.join(__dirname, '..', 'node_modules'))) {
  console.log('node_modules not found. Running npm install...');
  run('npm install');
}

console.log('[BUILD] Compiling TypeScript across workspaces...');
run('npx tsc -p packages/shared/tsconfig.json');
run('npx tsc -p apps/orchestrator/tsconfig.json');
run('npx tsc -p apps/api/tsconfig.json');
console.log('[BUILD] Build completed.');
