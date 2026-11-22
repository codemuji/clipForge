import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

console.log('[DEV] Starting clipforge pipeline orchestrator...');

// 1. Ensure packages are built
if (!fs.existsSync(path.join(rootDir, 'apps', 'orchestrator', 'dist'))) {
  console.log('[DEV] Building packages...');
  execSync('node scripts/build.js', { cwd: rootDir, stdio: 'inherit' });
}

// 2. Check if Python detector service is running; if not, spin up local stub on 8731
let detectorServer = null;
try {
  const resp = await fetch('http://127.0.0.1:8731/health', { signal: AbortSignal.timeout(400) });
  if (resp.ok) {
    console.log('[DEV] Connected to active detector service on 127.0.0.1:8731');
  }
} catch {
  console.log('[DEV] No external detector running on 127.0.0.1:8731; starting local detector stub...');
  detectorServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/analyze') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const isLoud = parsed.t_stream >= 3.0 && parsed.t_stream <= 6.0;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            window_id: parsed.window_id,
            t_stream: parsed.t_stream,
            signals: {
              audio: { value: isLoud ? 0.95 : 0.20, detail: { lufs: isLoud ? -10.0 : -28.0 } },
              speech_keywords: { value: null },
              hud_text: { value: null },
              frame_classifier: { value: isLoud ? 0.85 : 0.10, label: isLoud ? 'hype' : 'idle' }
            },
            latency_ms: 10,
            model_versions: { whisper: 'base', ocr: 'paddle', frame: 'mnv3' }
          }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    }
  });

  await new Promise((resolve) => detectorServer.listen(8731, '127.0.0.1', resolve));
}

// 3. Import Orchestrator
const { PipelineOrchestrator } = await import('../apps/orchestrator/dist/src/index.js');

const fixturePath = path.resolve(rootDir, 'fixtures', 'loud_burst.mp4');
const hasFixture = fs.existsSync(fixturePath);

const storageRoot = path.resolve(rootDir, 'storage');
const sessionId = `dev_${Date.now()}`;

console.log(`[DEV] Session ID: ${sessionId}`);
console.log(`[DEV] Storage root: ${storageRoot}`);

const orchestrator = new PipelineOrchestrator({
  sessionId,
  storageRoot,
  configPath: path.join(rootDir, 'config', 'clipforge.yaml'),
  onClipCut: (clip) => {
    console.log(`\n[DEV] ★ Highlight clip cut successfully!`);
    console.log(`[DEV] MP4:      ${clip.mp4Path}`);
    console.log(`[DEV] Sidecar:  ${clip.sidecarPath}`);
    console.log(`[DEV] Duration: ${clip.durationSeconds}s | NVENC: ${clip.usedNvenc}\n`);
  },
  onDetection: (event) => {
    console.log(`[DEV] Detection event: t=${event.t_stream.toFixed(1)}s, score=${event.fused_score.toFixed(2)} (${event.status})`);
  }
});

let isDraining = false;
async function handleShutdown() {
  if (isDraining) return;
  isDraining = true;
  console.log('\n[DEV] Received Ctrl+C / SIGINT. Finishing in-flight clip cutting jobs before exiting...');
  await orchestrator.stop();
  if (detectorServer) {
    detectorServer.close();
  }
  console.log('[DEV] All jobs finished. Clean shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Run against loud-burst fixture if present, or live allow-listed stream
if (hasFixture) {
  console.log(`[DEV] Running end-to-end against fixture: ${path.basename(fixturePath)}`);

  // Slice segments into buffer
  const bufferDir = path.join(storageRoot, 'buffer', sessionId);
  fs.mkdirSync(bufferDir, { recursive: true });

  const seg0 = path.join(bufferDir, 'seg_00000.ts');
  const seg1 = path.join(bufferDir, 'seg_00001.ts');
  const seg2 = path.join(bufferDir, 'seg_00002.ts');
  const seg3 = path.join(bufferDir, 'seg_00003.ts');

  execSync(`ffmpeg -hide_banner -loglevel error -y -ss 0 -t 2 -i "${fixturePath}" -c copy "${seg0}"`);
  execSync(`ffmpeg -hide_banner -loglevel error -y -ss 2 -t 2 -i "${fixturePath}" -c copy "${seg1}"`);
  execSync(`ffmpeg -hide_banner -loglevel error -y -ss 4 -t 2 -i "${fixturePath}" -c copy "${seg2}"`);
  execSync(`ffmpeg -hide_banner -loglevel error -y -ss 6 -t 2 -i "${fixturePath}" -c copy "${seg3}"`);

  await orchestrator.start(fixturePath);
  console.log('[DEV] Pipeline orchestrator started. Processing fixture stream...');

  const result = await orchestrator.processSegmentsSequentially({
    startT: 0.0,
    endT: 8.0,
    stepSeconds: 2.0
  });

  console.log(`[DEV] Fixture processing finished! Produced ${result.clips.length} clip(s) and ${result.detections.length} detection(s).`);
  await orchestrator.stop();
  if (detectorServer) {
    detectorServer.close();
  }
  console.log('[DEV] Dev run completed successfully.');
} else {
  console.log('[DEV] No fixture found. Starting live stream orchestrator...');
  await orchestrator.start();
}
