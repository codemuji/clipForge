# PLAN.md — clipforge execution plan

Read `AGENTS.md` first. Interfaces are in `docs/CONTRACTS.md`.

## 0. Team and lanes

We run **three agents in parallel**, one per lane. Each agent claims tickets only in its own lane.

| Agent | Lane | Scope |
|---|---|---|
| **Agent A — Pipeline** | ingest, buffer, sampler, scorer, cutter, store, orchestrator | `apps/orchestrator/`, `packages/shared/` (lead) |
| **Agent B — Detection** | Python detector service and all signal models | `workers/detector/`, `fixtures/labels/` |
| **Agent C — Product** | REST API, dashboard, review/trim/export, storage browser | `apps/api/`, `apps/dashboard/` |

**Why three and not four:** the codebase is small enough that a fourth agent would mostly wait on contracts. The real parallel work is pipeline, detection, and product. A fourth agent (QA) would be more useful during Phase 3, where you can spin up a separate test-focused session on the same lanes.

**Shared rule:** `T-00` and `A-01` are blockers for everyone. Nobody starts Phase 1 until Gate G0 is recorded.

## 1. Ticket format

```
### <ID> <title>
Lane: A | B | C | Shared
Status: TODO | IN PROGRESS (agent) | BLOCKED (reason) | DONE
Depends on: <IDs or none>
Goal: one sentence
Acceptance:
- [ ] ...
Tests:
- ...
Result: (filled by agent per AGENTS.md §11)
```

Claim a ticket by editing its status line to `IN PROGRESS (Agent X)` in this file. Commit that change before writing code, so other agents see it.

---

## Phase 0 — Analysis and spikes

Goal: remove the biggest technical unknowns before writing product code. Each spike ends with an ADR in `docs/adr/`.

### S0-1 Ingest and buffer spike
Lane: A
Status: TODO
Depends on: none
Goal: measure how yt-dlp or streamlink ingests a live HLS stream on this machine and whether ffmpeg can segment it into a rolling buffer without drops.
Acceptance:
- [ ] Ingest 30 minutes of a permitted test stream; record reconnect count and segment gap count.
- [ ] Measure disk write rate and confirm the 10-minute buffer stays under 3 GB.
- [ ] Record end-to-end latency: source live edge to segment on disk.
- [ ] ADR-001 written: chosen ingest tool and segment settings.

### S0-2 Detector model spike
Lane: B
Status: TODO
Depends on: none
Goal: pick the detector stack that fits 6 GB VRAM and the CPU budget.
Acceptance:
- [ ] whisper.cpp `base.en` and `small.en` (quantized): real-time factor on the Ryzen 5 7000 HS.
- [ ] PaddleOCR (small) vs Tesseract on a cropped HUD region: accuracy on 50 sample frames and time per call.
- [ ] MobileNetV3-small inference time on RTX 3050 with ONNX Runtime CUDA EP; measure VRAM.
- [ ] ADR-002 written: chosen models, fallbacks, and the CPU-only fallback plan.

### S0-3 Product and data spike
Lane: C
Status: TODO
Depends on: none
Goal: fix the API and dashboard stack and confirm the SQLite schema covers CONTRACTS §4–§5.
Acceptance:
- [ ] Choose Fastify for the API and React + Vite for the dashboard. Record in ADR-003.
- [ ] Draft the SQLite schema (`sessions`, `detections`, `clip_jobs`, `clips`) and migration approach. Attach to ADR-003.
- [ ] List the three dashboard screens with wireframes in Markdown (no pixel design yet).

### S0-4 Contracts and fixtures spike
Lane: Shared (Agent A leads)
Status: TODO
Depends on: none
Goal: freeze contracts v0.1.0 and define the test fixtures.
Acceptance:
- [ ] Review `CONTRACTS.md` with B and C. Any change gets a version bump.
- [ ] Record 3 short fixture clips (60 seconds each) of the owner's own gameplay or a public domain video with a visible HUD: one quiet, one with a loud burst, one with a "text overlay" event.
- [ ] Write `fixtures/README.md` describing each file, its expected detections, and its licence. No copyrighted third-party footage.
- [ ] Ship `packages/shared/schemas/*.json` generated from `CONTRACTS.md`.

### Gate G0 (Analysis complete)
- [ ] ADR-001, ADR-002, ADR-003 accepted and linked here.
- [ ] Contracts frozen at v0.1.0.
- [ ] Fixtures committed (or download script added if over 20 MB).
- [ ] Recorded by Agent A in the gate section below.

Gate record: _pending_

---

## Phase 1 — Execution (ticket by ticket, parallel by lane)

### Blockers (run first, all lanes wait for these)

### A-01 Repo scaffold, Makefile, lint, CI
Lane: A
Status: TODO
Depends on: G0
Goal: monorepo with the layout in AGENTS.md §3, working `make` targets, lint, typecheck, and CI config.
Acceptance:
- [ ] `make setup`, `make lint`, `make test` run on a clean clone (empty tests pass).
- [ ] `make setup` checks for ffmpeg, Node 20+, Python 3.11, and `nvidia-smi`, and reports missing items clearly.
- [ ] `.gitignore` covers `storage/`, `.env`, model weights, and `*.mp4` outside `fixtures/`.
Tests:
- Smoke test: scaffold builds and runs.

### Lane A — Pipeline

### A-02 Config loader and validation
Lane: A
Status: TODO
Depends on: A-01
Goal: load `config/clipforge.yaml`, validate with zod, enforce the sources allow-list.
Acceptance:
- [ ] Invalid config fails at startup with a field-level error message.
- [ ] A source not in `sources` is refused with a logged error.
Tests:
- Unit: valid config, missing field, unlisted source, out-of-range threshold.

### A-03 SQLite store and migrations
Lane: A
Status: TODO
Depends on: A-01, S0-3
Goal: implement the schema from ADR-003 with a migration runner. Export a typed repository layer for C.
Acceptance:
- [ ] Migrations are idempotent.
- [ ] Repository covers sessions, detections, clip_jobs, clips.
- [ ] Eviction query returns buffer segments not protected by pending clip jobs.
Tests:
- Unit: migrations on empty and existing DB.
- Unit: eviction protection rule.

### A-04 Ingest with reconnect
Lane: A
Status: TODO
Depends on: A-02, S0-1
Goal: wrap yt-dlp or streamlink; reconnect with exponential backoff; emit session events.
Acceptance:
- [ ] Killing the network for 30 seconds results in a reconnect within the backoff schedule.
- [ ] Session state transitions are logged and stored.
Tests:
- Integration: ingest against a local HLS server serving fixture segments, with a forced disconnect.

### A-05 Rolling buffer segmenter and eviction
Lane: A
Status: TODO
Depends on: A-04, A-03
Goal: ffmpeg writes 2-second HLS segments into `storage/buffer/<session>/`; eviction runs every 30 seconds and respects the protection rule.
Acceptance:
- [ ] Buffer never exceeds configured minutes plus a 1-minute margin.
- [ ] No segment referenced by a queued or cutting job is ever removed.
Tests:
- Integration: run for 3 simulated minutes at accelerated time; assert buffer size and protected-segment behavior.

### A-06 Sampler
Lane: A
Status: TODO
Depends on: A-05
Goal: every `sampling.interval_seconds`, extract one JPEG frame and a `audio_window_seconds` WAV at 16 kHz, then POST to the detector.
Acceptance:
- [ ] Sampler keeps up with real time on the fixture stream on target hardware.
- [ ] Failed detector calls are retried once, then the window is recorded as `value: null` for all signals.
Tests:
- Unit: window timing and time-base math (`t_stream` monotonic).
- Integration: sampler → stub detector returns canned responses.

### A-07 Chat signal adapter
Lane: A
Status: TODO
Depends on: A-02
Goal: define a `ChatSource` interface that returns aggregate counts per window. Implement a fixture-backed source for tests and one platform adapter behind a feature flag.
Acceptance:
- [ ] No message text or usernames are stored or logged (AGENTS.md §10).
- [ ] Platform adapter disabled by default; enabled only if its auth is configured by the owner.
Tests:
- Unit: count aggregation per window from a fixture chat log.
- Unit: adapter returns `null` when disabled.

### A-08 Scorer
Lane: A
Status: TODO
Depends on: A-06, A-07, B-01
Goal: fuse signals per CONTRACTS §3 rules; apply threshold, debounce, and cooldown; emit detections.
Acceptance:
- [ ] Weights re-normalize when a signal is `null`.
- [ ] Debounce requires `debounce_windows` consecutive windows above threshold.
- [ ] Cooldown suppresses new detections for `cooldown_seconds`.
Tests:
- Unit: fusion with all signals, with one null, with all null (must emit nothing).
- Unit: debounce and cooldown timelines.

### A-09 Cutter and sidecar writer
Lane: A
Status: TODO
Depends on: A-05, A-08, A-03
Goal: turn a detection into a clip job; cut from the buffer with `-c copy` or NVENC; write mp4 then sidecar JSON with write-then-rename.
Acceptance:
- [ ] Cut window is `[t - pre_seconds, t + post_seconds]`, clamped to available buffer.
- [ ] Clip `status` moves queued → cutting → encoded; failures become `failed` with an error.
- [ ] Output path follows the layout in AGENTS.md §4.
- [ ] Sidecar matches `clipforge.clip.v1`.
Tests:
- Integration: fixture stream, injected detection, assert mp4 duration and sidecar fields.
- Unit: path builder with a URL containing `www.`.

### A-10 Orchestrator and lifecycle
Lane: A
Status: TODO
Depends on: A-04 through A-09
Goal: start and stop the full pipeline; handle SIGINT with a graceful flush of pending clips.
Acceptance:
- [ ] `make dev` runs end to end on fixtures.
- [ ] Ctrl+C finishes any `cutting` job before exit.
Tests:
- Integration: full run on fixture, asserting at least one clip for the loud-burst fixture.

### Lane B — Detection

### B-01 Detector service scaffold
Lane: B
Status: TODO
Depends on: A-01
Goal: FastAPI app on `127.0.0.1:8731` with `POST /v1/analyze`, `GET /health`, schema validation, and cleanup of window files.
Acceptance:
- [ ] Request and response match CONTRACTS §2–§3.
- [ ] Missing signals return `value: null`, never omitted.
- [ ] Input files are deleted after response unless `DEBUG_KEEP_WINDOWS=1`.
Tests:
- Unit: schema validation both directions.
- Integration: a request with fixture frame and WAV returns a valid response.

### B-02 Audio signal
Lane: B
Status: TODO
Depends on: B-01
Goal: loudness and short-term delta from the WAV window; normalize to `[0, 1]` using a rolling baseline per session.
Acceptance:
- [ ] Loud fixture window scores above 0.7; quiet window scores below 0.3.
- [ ] Baseline resets on session start.
Tests:
- Unit: loudness and delta computation on synthetic signals.
- Fixture: expected score ranges for the three fixture clips.

### B-03 Speech keywords
Lane: B
Status: TODO
Depends on: B-01, S0-2
Goal: whisper.cpp transcription on the audio window; keyword matching from `config/keywords.yaml`.
Acceptance:
- [ ] Keyword list is configurable and empty by default.
- [ ] Transcription real-time factor meets ADR-002 budget.
Tests:
- Unit: keyword matcher (case, punctuation, partial words).
- Integration: fixture with a known keyword returns a non-zero value.

### B-04 HUD text detection
Lane: B
Status: TODO
Depends on: B-01, S0-2
Goal: OCR on configured crop regions of the frame; match against `config/hud_patterns.yaml`.
Acceptance:
- [ ] Regions and patterns configurable per game profile.
- [ ] Call rate limited to once per 2 seconds.
Tests:
- Integration: fixture frame with a known overlay text returns a match.

### B-05 Frame classifier
Lane: B
Status: TODO
Depends on: B-01, S0-2
Goal: MobileNetV3-small fine-tuned on owner-labeled frames; exported to ONNX; CUDA EP with CPU fallback.
Acceptance:
- [ ] Inference under 30 ms on RTX 3050 at 224×224.
- [ ] Automatic CPU fallback if CUDA is unavailable, logged once at startup.
- [ ] Total VRAM under 1 GB for this model.
Tests:
- Unit: preprocessing and label mapping.
- Integration: fixture frames return expected label on the labeled set.

### B-06 Labeling tool and evaluation script
Lane: B
Status: TODO
Depends on: B-05
Goal: small CLI to label frames from the buffer, and an evaluation script reporting precision and recall on the labeled set.
Acceptance:
- [ ] Labels stored under `fixtures/labels/` as CSV with frame hash, not raw frames.
- [ ] `make eval:detector` prints precision, recall, and threshold sweep.
Tests:
- Unit: metric computation on a known toy set.

### Lane C — Product

### C-01 API skeleton (read-only)
Lane: C
Status: TODO
Depends on: A-03, S0-3
Goal: Fastify app with the read endpoints in CONTRACTS §7: sessions, detections, clips, clip by ID, health.
Acceptance:
- [ ] Responses match contracts; errors use the error shape.
- [ ] `/health` reports detector reachability and free buffer disk.
Tests:
- Integration: against a seeded SQLite DB.

### C-02 Dashboard shell
Lane: C
Status: TODO
Depends on: C-01
Goal: React + Vite app with three views: sessions and live detections, clip grid, clip detail.
Acceptance:
- [ ] Live detections list updates via polling every 2 seconds (SSE is a backlog item).
- [ ] Clip grid filters by status and source.
Tests:
- Component tests for list and grid.

### C-03 Review actions
Lane: C
Status: TODO
Depends on: C-02
Goal: review status, title, tags, notes, and dismiss action on detections.
Acceptance:
- [ ] `PATCH /clips/:id/review` writes only `review.*` fields.
- [ ] Dismissed detections do not create clip jobs (verified with A-08 via a DB flag).
Tests:
- Integration: PATCH round-trip; dismiss prevents cut.

### C-04 Trim
Lane: C
Status: TODO
Depends on: C-03, A-09
Goal: trim a clip by offset from the original buffer if still available, otherwise from the clip mp4.
Acceptance:
- [ ] Trim creates a new file and never overwrites the original.
- [ ] Trim UI shows the original and the new file.
Tests:
- Integration: trim from mp4 and from buffer; assert duration.

### C-05 Export (vertical and captions)
Lane: C
Status: TODO
Depends on: C-04
Goal: vertical 9:16 export with center-weighted crop; optional burned captions from the Whisper transcript if B-03 provides one.
Acceptance:
- [ ] Vertical export uses NVENC when available, CPU otherwise.
- [ ] Captions are optional and off by default.
Tests:
- Integration: export of a fixture produces 9:16 output.

### C-06 Storage browser
Lane: C
Status: TODO
Depends on: C-01
Goal: a tree view of `storage/clips/<domain>/<channel>/<date>/`, with "reveal in file explorer" and copy-path actions. Supports the owner's manual upload workflow.
Acceptance:
- [ ] Tree reflects disk state, not only the DB.
- [ ] Reveal action works on Windows and Linux.
Tests:
- Unit: tree builder on a temp directory.

### Gate G1 (Execution complete)
- [ ] All tickets in Phase 1 are DONE.
- [ ] `make test` and `make lint` pass on main.
- [ ] Contracts still at v0.1.x, or a version bump recorded.

Gate record: _pending_

---

## Phase 2 — Debugging

Process:
1. Every bug is logged in `docs/ISSUES.md` with ID `ISS-###`, lane, repro steps, and severity (S1 crash or data loss, S2 wrong output, S3 cosmetic).
2. The owning lane writes a failing test first, then the fix. The fix PR cites the ISS ID.
3. Cross-lane bugs are owned by the lane where the fault is traced, not where the symptom appears.
4. S1 bugs stop Phase 2 exit until closed.

Triage kickoff tickets:

### D-01 Detection calibration pass
Lane: B (with A reading logs)
Goal: run all three fixtures through the pipeline; log every false positive and false negative; tune weights and thresholds in config only, not code.

### D-02 Clip boundary check
Lane: A
Goal: verify every clip starts and ends on the expected stream time within 0.5 seconds. Fix any drift.

### D-03 Product state consistency
Lane: C
Goal: verify the DB, sidecar JSON, and disk tree agree after dismiss, trim, and export.

### Gate G2 (Debugging complete)
- [ ] No open S1 issues.
- [ ] No open S2 issues without a documented workaround.
- [ ] Calibration results recorded in `docs/adr/ADR-004-calibration.md`.

Gate record: _pending_

---

## Phase 3 — Testing

### T-01 Full integration on fixtures
Lane: A
Goal: `make test:fixtures` runs the whole pipeline on all three fixtures and asserts expected clip counts within tolerance.

### T-02 Soak test
Lane: A + B
Goal: 4 hours on a recorded stream with the pipeline running continuously. Track memory, CPU, VRAM, buffer size, and clip count. Record results in `docs/soak/`.
Acceptance:
- [ ] RSS under 8 GB for the pipeline and under 4.5 GB VRAM throughout.
- [ ] No unbounded disk growth outside `clips/`.
- [ ] Detection p95 latency under 3 seconds.

### T-03 Failure injection
Lane: A
Goal: test network drop, disk full, GPU unavailable, detector down, and corrupted segment. Each must either recover or fail with a clear, logged message.

### T-04 Dashboard end-to-end
Lane: C
Goal: Playwright tests for the review flow, trim, export, and storage browser.

### T-05 Performance budget check
Lane: B
Goal: confirm the detector meets the budgets in AGENTS.md §6 on target hardware. Record in `docs/perf/`.

### Gate G3 (Testing complete)
- [ ] T-01 through T-05 pass.
- [ ] Soak results recorded with no S1 findings.

Gate record: _pending_

---

## Phase 4 — Production hardening

### P-01 Startup checks and config hardening
Lane: A
Goal: `make dev` and a production start command both run preflight checks (ffmpeg, GPU, detector, disk free space) and refuse to run with clear messages.

### P-02 Logging and retention
Lane: A
Goal: JSON log rotation, buffer eviction verified in production mode, and a log retention policy in config.

### P-03 Windows and WSL startup
Lane: A
Goal: a start script for WSL2 and a Windows Task Scheduler entry template. Document both in the runbook.

### P-04 Dashboard production build
Lane: C
Goal: production build served by the API on localhost; bundle size budget set and checked in CI.

### P-05 Runbook and README
Lane: C (with A and B inputs)
Goal: README covers setup, daily use, troubleshooting, where clips live, and how to manually upload. Includes the ToS and permission reminder from AGENTS.md §10.

### P-06 Release
Lane: Shared
Goal: tag `v1.0.0`, changelog, and final contract version recorded.

### Gate G4 (Production ready)
- [ ] All P-tickets DONE.
- [ ] Runbook dry-run completed by someone who did not write it, or by a fresh agent session.
- [ ] `v1.0.0` tagged.

Gate record: _pending_

---

## 2. Running the three agents

Launch one session per lane with this prompt, changing only the lane letter:

```
You are Agent <A|B|C>. Read AGENTS.md, docs/CONTRACTS.md, and docs/PLAN.md in full.
Work only in your lane. Claim the first TODO ticket in your lane whose dependencies
are DONE. Set its status to IN PROGRESS (Agent <X>) and commit before coding.
Follow the definition of done in AGENTS.md §8. When finished, write the Result
block per AGENTS.md §11 and move to the next ticket. If nothing is ready, write
BLOCKED with the dependency and stop. Do not start a new phase until its gate
is recorded in this file.
```

Coordination: agents communicate only through this file, `docs/ISSUES.md`, and `docs/adr/`. No side channels.

## 3. Backlog (not in scope for v1.0.0)

- Server-sent events for the live detection feed (replaces polling).
- Multi-stream support in parallel.
- Automatic highlight-reel stitching across sessions.
- Caption styling presets.

Add new ideas here. Do not implement them without a ticket.
