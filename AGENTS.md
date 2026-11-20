# AGENTS.md — clipforge

Read this file first. Every agent reads it before touching code. Then read `docs/PLAN.md` for your tickets and `docs/CONTRACTS.md` for the interfaces you must respect.

## 1. What we are building

clipforge is a local, autonomous highlight-clipping tool. It:

1. Ingests a live stream URL (the owner's own streams or explicitly permitted sources).
2. Keeps a rolling buffer of the last N minutes of video and audio on disk.
3. Scores each short window for "hype" using local signals (audio energy, chat velocity, speech keywords, on-screen text, a small frame classifier).
4. When a score crosses a threshold, cuts a clip from the buffer and writes it to disk with metadata.
5. Serves a local dashboard to review, trim, caption, and export clips.

Everything runs on the owner's machine. No paid APIs. No cloud inference. Posting to social platforms is out of scope; clips are saved to disk for manual upload.

Purpose: a portfolio project and a demo of automated media engineering for client work. Not a monetized clipping service.

## 2. Hardware target

- CPU: AMD Ryzen 5 7000-series (HS). 8 physical cores assumed; design for 6 usable threads for the pipeline.
- GPU: NVIDIA RTX 3050 Laptop, 6 GB VRAM. Use NVENC for encoding and small models only (see §6).
- RAM: 16 GB. Keep the pipeline under 8 GB resident.
- OS: Windows 11 with WSL2 (Ubuntu) is the primary dev target. All paths in code must work on Linux; Windows-specific paths go in config only.

## 3. Architecture (fixed; do not redesign without an ADR)

```
Stream URL
   │
   ▼
[ingest]  yt-dlp / streamlink ──► ffmpeg segmenter (2 s HLS segments)
   │                                  │
   │                                  ▼
   │                          [buffer]  rolling dir, last N min, auto-evicted
   │                                  │
   ▼                                  │
[sampler] every 1–2 s:  frame (JPEG) + 5 s audio WAV + chat counts
   │
   ▼
[detector]  Python worker, localhost HTTP  ──►  score + signals
   │
   ▼
[scorer]    fuse signals, apply threshold + cooldown + debounce
   │
   ▼
[cutter]    ffmpeg cut from buffer [t-pre, t+post] ──► storage/clips/...
   │
   ▼
[store]     SQLite (jobs, detections, clips) + sidecar JSON per clip
   │
   ▼
[dashboard] React UI on localhost (review, trim, caption, export)
```

Components and owners:

| Component | Language | Path | Owner agent |
|---|---|---|---|
| ingest, buffer, sampler, scorer, cutter, store, orchestrator | TypeScript (Node 20+) | `apps/orchestrator/` | Agent A (Pipeline) |
| detector (audio, OCR, frame classifier, Whisper, chat signal adapter) | Python 3.11 | `workers/detector/` | Agent B (Detection) |
| dashboard, REST API, export/edit, clip storage conventions | TypeScript (React + Vite + Express/Fastify) | `apps/dashboard/`, `apps/api/` | Agent C (Product) |
| shared types, contracts, test fixtures, CI | TypeScript + JSON Schema | `packages/shared/`, `fixtures/` | Shared; Agent A leads |

Agents must not edit another agent's directory without a ticket in `docs/PLAN.md` that assigns the change to them. If you need a change in someone else's area, write it in the ticket's "Cross-agent requests" section and continue with a stub.

## 4. Storage layout (fixed)

```
storage/                      (git-ignored)
  buffer/<session-id>/        rolling HLS segments, evicted after BUFFER_MINUTES
  clips/
    <source-domain>/          e.g. twitch.tv, youtube.com, kick.com, or "local"
      <channel-slug>/
        <YYYY-MM-DD>/
          <clip-id>.mp4
          <clip-id>.json      sidecar metadata (see CONTRACTS.md)
  db/clipforge.sqlite
  logs/
```

The `<source-domain>` folder is derived from the stream URL host with `www.` stripped. Clips must be findable by the owner for manual upload.

## 5. Ground rules for every agent

1. **Read before writing.** Check `docs/CONTRACTS.md` and existing code in your directory before creating anything.
2. **Contracts are law.** Any change to a shape in `CONTRACTS.md` requires a ticket and a version bump in that file. Do not silently change types.
3. **One ticket at a time, in your lane.** Claim a ticket by setting `Status: IN PROGRESS` and your agent ID in `docs/PLAN.md`. Do not start a ticket whose dependencies are not `DONE`.
4. **Tests ship with code.** No ticket is `DONE` without its listed tests passing.
5. **No new dependencies without justification.** Each new package goes in the ticket with a one-line reason. Prefer ffmpeg, the standard library, and packages already listed here.
6. **No paid or hosted APIs.** No OpenAI, Anthropic, Google Cloud, AWS, or similar at runtime. Local models only. Platform chat/metadata feeds that are free and documented are allowed behind an adapter.
7. **Deterministic tests.** Tests run against fixture files in `fixtures/`, never against live streams. CI must not require network access.
8. **Logs, not prints.** Use the logger in `packages/shared`. No `console.log` in committed code.
9. **Fail loud, recover quietly.** Errors are logged with a correlation ID (session + detection ID). Transient errors (network drop, stream reconnect) retry with backoff. Logic errors crash the job and surface in the dashboard.
10. **Never delete source segments that a pending clip job still needs.** Eviction checks the job table first.

## 6. Model and resource budget

| Signal | Model / tool | Runs on | Budget |
|---|---|---|---|
| Audio energy | ffmpeg `ebur128`, then librosa RMS | CPU | < 5% of one core |
| Speech keywords | whisper.cpp, `base` or `small` quantized | CPU (or GPU if stable) | real-time factor < 0.5 |
| On-screen text | PaddleOCR (small) or Tesseract on cropped HUD regions | CPU | 1 call per 2 s, crop only |
| Audio events (cheer, explosion) | YAMNet (TFLite) | CPU | optional, phase 2 |
| Frame classifier | MobileNetV3-small fine-tuned on owner-labeled frames | GPU (CUDA) | < 30 ms per frame |
| Encoding | ffmpeg `h264_nvenc` | GPU | cut and re-encode only |

Hard limits: total GPU VRAM use under 4.5 GB; pipeline CPU under 60% sustained; detection latency p95 under 3 s from frame capture to score.

## 7. Commands (agents use these; keep them working)

```
make setup        # installs node + python deps, checks ffmpeg and nvidia-smi
make dev          # runs orchestrator, detector, and dashboard together
make test         # all unit + integration tests
make test:fixtures  # runs pipeline against fixtures/ only
make lint         # eslint, ruff, typecheck
make build        # production build of dashboard and orchestrator
make clean        # clears storage/buffer and tmp (never clips)
```

If a command does not exist yet, the ticket that adds it is the first ticket for that lane.

## 8. Definition of done (per ticket)

- Code merged to the lane's directory.
- Unit tests for new logic; integration test if it crosses a component boundary.
- `make lint` and `make test` pass locally.
- Contract changes reflected in `CONTRACTS.md`.
- Ticket updated with: what changed, how it was verified, open risks.
- Status set to `DONE` in `docs/PLAN.md`.

## 9. Phase protocol

The project moves through five phases. Do not start a phase until the gate for the previous one is passed. The gate is recorded in `docs/PLAN.md`.

1. **Analysis (Phase 0).** Spikes and decisions. Output: ADRs in `docs/adr/`, benchmark numbers, confirmed contracts.
2. **Execution (Phase 1).** Ticket-by-ticket build. Agents work in parallel within their lanes.
3. **Debugging (Phase 2).** Triage the issue log. Every bug gets a repro test before a fix. Fixes are small and cite the bug ID.
4. **Testing (Phase 3).** Integration on fixtures, soak test (4 hours on a recorded stream), performance budget check, failure injection (network drop, disk full, GPU unavailable).
5. **Production hardening (Phase 4).** Config validation, graceful shutdown, log rotation, retention policy, Windows service or WSL startup script, README runbook, release tag.

## 10. Boundaries (what agents must not do)

- Do not add features not in `PLAN.md`. Propose them as a ticket in the "Backlog" section instead.
- Do not download, store, or process streams without the owner's configured permission list (`config/sources.yaml`). Ship the file with an empty allow-list.
- Do not add DRM bypass, auth bypass, or any mechanism to evade platform restrictions.
- Do not store raw chat messages or viewer identities. Keep only aggregate counts per window.
- Do not commit anything under `storage/`, `.env`, model weights, or fixture videos larger than 20 MB (use Git LFS or a download script).
- Do not auto-post to any social platform. Clips stay on disk.

## 11. How to report

At the end of each ticket, the agent appends to `docs/PLAN.md` under the ticket:

```
Result: DONE | BLOCKED | PARTIAL
Changed: <paths>
Verified: <commands run and their output summary>
Risks: <one line each>
Cross-agent requests: <none or list>
```

If BLOCKED, state the blocker and the ticket ID it depends on. Do not guess across lanes.
