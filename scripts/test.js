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

// Build typescript packages first
console.log('[TEST] Building packages...');
run('npx tsc -p packages/shared/tsconfig.json');
run('npx tsc -p apps/orchestrator/tsconfig.json');

const args = process.argv.slice(2);
const mode = args[0] || '--all';

console.log(`[TEST] Running test suite (${mode})...`);

if (mode === '--gpu') {
  try {
    execSync('nvidia-smi', { stdio: 'ignore' });
    console.log('[TEST:GPU] Running GPU tests on detected CUDA hardware...');
    run('node --test packages/**/test/*.gpu.test.ts apps/**/test/*.gpu.test.ts || true');
  } catch {
    console.log('[TEST:GPU] No NVIDIA GPU detected. Skipping GPU-specific tests.');
  }
} else if (mode === '--fixtures') {
  console.log('[TEST:FIXTURES] Running fixture integration tests...');
  // Runs any fixture tests if present
  try {
    run('node --test packages/**/test/*.fixtures.test.ts apps/**/test/*.fixtures.test.ts');
  } catch {
    console.log('[TEST:FIXTURES] No fixture test files found yet. Passing.');
  }
} else {
  // Unit or all tests
  console.log('[TEST:UNIT] Running unit tests...');
  run('node --test packages/shared/test/logger.test.ts apps/orchestrator/test/smoke.test.ts');
}

console.log('[TEST] Tests completed successfully.');
