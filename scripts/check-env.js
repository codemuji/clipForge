import { execSync } from 'node:child_process';

function checkTool(name, cmd, parseFn, minRequirement) {
  try {
    const stdout = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
    const info = parseFn ? parseFn(stdout) : stdout.trim();
    console.log(`[PASS] ${name}: ${info}`);
    return { ok: true, name, info };
  } catch {
    if (minRequirement) {
      console.error(`[FAIL] ${name}: Missing or failed requirement: ${minRequirement}`);
      return { ok: false, name, required: true };
    } else {
      console.warn(`[WARN] ${name}: Not found (optional / hardware fallback active)`);
      return { ok: false, name, required: false };
    }
  }
}

console.log('--- clipforge environment checks ---');

// 1. Node.js >= 20
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
const nodeOk = nodeMajor >= 20;
if (nodeOk) {
  console.log(`[PASS] Node.js: v${nodeVersion} (>= 20)`);
} else {
  console.error(`[FAIL] Node.js: v${nodeVersion} is below required Node 20+`);
}

// 2. Python 3.11+
const pythonCmd = process.platform === 'win32' ? 'python --version' : 'python3 --version || python --version';
const pythonResult = checkTool(
  'Python',
  pythonCmd,
  (out) => {
    const match = out.match(/Python\s+([0-9]+)\.([0-9]+)\.([0-9]+)/i);
    if (!match) return out.trim();
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    if (major < 3 || (major === 3 && minor < 11)) {
      throw new Error(`Python version ${match[1]}.${match[2]} < 3.11`);
    }
    return `v${match[1]}.${match[2]}.${match[3]} (>= 3.11)`;
  },
  'Python 3.11+'
);

// 3. FFmpeg
const ffmpegResult = checkTool(
  'FFmpeg',
  'ffmpeg -version',
  (out) => {
    const firstLine = out.split('\n')[0].trim();
    return firstLine;
  },
  'ffmpeg installed and in PATH'
);

// 4. nvidia-smi (optional for non-GPU / CI environments)
checkTool(
  'nvidia-smi',
  'nvidia-smi',
  (out) => {
    const lines = out.split('\n');
    const gpuLine = lines.find((l) => l.includes('NVIDIA') || l.includes('RTX') || l.includes('GeForce'));
    return gpuLine ? gpuLine.trim() : 'Detected';
  },
  false // not strictly fatal for CI/CPU-only
);

console.log('------------------------------------');

if (!nodeOk || !pythonResult.ok || !ffmpegResult.ok) {
  console.error('Environment check failed: missing required pipeline dependencies.');
  process.exit(1);
} else {
  console.log('Environment preflight passed.');
  process.exit(0);
}
