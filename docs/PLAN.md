# PLAN.md — clipforge execution plan

**This file is a read-only spec.** It lists what to build, in what order, and how to know it's done. It does not track status.

- Status for each lane lives in `docs/status/lane-a.md`, `lane-b.md`, `lane-c.md`. Integrator status lives in `docs/status/integrator.md`.
- Gate records are written only by the Integrator, in section 7 of this file.
- Read `AGENTS.md` first. Interfaces are in `docs/CONTRACTS.md`.

---

## 0. Team and roles

Four agent sessions run in parallel. Each has one writable area.

| Agent | Role | Writes to | Branch |
|---|---|---|---|
| **Agent A — Pipeline** | ingest, buffer, sampler, scorer, cutter, store, orchestrator; owns blocker tickets | `apps/orchestrator/`, `packages/shared/`, `docs/status/lane-a.md` | `lane/a` |
| **Agent B — Detection** | Python detector and all signal models | `workers/detector/`, `fixtures/labels/`, `docs/status/lane-b.md` | `lane/b` |
| **Agent C — Product** | REST API, dashboard, review, trim, export, storage browser | `apps/api/`, `apps/dashboard/`, `docs/status/lane-c.md` | `lane/c` |
| **Integrator** | CI/CD, merges to `main`, gate sign-off, release | `.github/`, `docs/PLAN.md` (gate section only), `docs/status/integrator.md`, merges on `main` | `main` |

Rules that keep the agents from colliding:

1. Lane agents push only to their own branch. Only the Integrator merges to `main`.
2. Lane agents edit only their lane's directories and their own status file. Changes to `packages/shared/` or `docs/CONTRACTS.md` need a PR labelled `contract-change`, approved by the Integrator.
3. Blocker tickets (`A-01`, `S0-4`) belong to Agent A alone. B and C wait for them to merge to `main`.
4. Nobody edits `docs/PLAN.md` except the Integrator, and only in the gate section.

---

## 1. How work flows

```
lane agent:   claim ticket ──► code on lane/x ──► tests ──► push ──► open PR ──► status: READY
                                                                          │
integrator:                              review path + contracts ◄────────┘
                                         rebase on main, run CI
                                         squash-merge to main ──► status: MERGED
                                         update gate record (if a gate is complete)
```

- Merge per ticket, not per phase. Small merges keep conflicts small. Phase gates are sign-off points, not merge points.
- Lane agents run `git fetch && git merge origin/main` at the start of every ticket, so they build on the latest contracts and shared code.
- A PR that fails CI goes back to the lane with a comment. The lane fixes it on the same branch.

### Ticket format (in this file)

```
### <ID> <title>
Lane: A | B | C | Integrator
Depends on: <IDs or none>
Goal: one sentence
Acceptance:
- [ ] ...
Tests:
- ...
```

Status is never written here. A lane agent records its claim and result in its status file.

### Status file format (`docs/status/lane-x.md`)

```
# Lane A status

## Current
Ticket: A-05 Rolling buffer segmenter
State: IN PROGRESS | READY | BLOCKED
Branch: lane/a
PR: #<number or none>
Blocked by: <ticket or none>
Notes: <one line>

## Done
- A-01 Repo scaffold — MERGED (PR #2, commit abc1234)
- A-02 Config loader — MERGED (PR #5, commit def5678)
```

Lane agents update only their own file. Each claim or state change is a commit on the lane branch.

---

## 2. Phase 0 — Bootstrap and analysis

Goal: repository, CI, and scaffolding in place. The biggest technical unknowns are measured before product code.

### I-00 Repository bootstrap and branch protection
Lane: Integrator
Depends on: none
Goal: create the GitHub repository, push the planning files, protect `main`, and create the lane branches.
Acceptance:
- [ ] Repo created with `main` as default branch; planning files committed.
- [ ] Branch protection on `main`: PRs required, one approval (the Integrator), required checks `ci / lint`, `ci / unit`, `ci / integration`, squash merge only, linear history.
- [ ] Branches `lane/a`, `lane/b`, `lane/c` created from `main`.
- [ ] Labels: `contract-change`, `blocker`, `needs-gpu`, `bug`, `S1`, `S2`, `S3`.
- [ ] `docs/status/` contains `lane-a.md`, `lane-b.md`, `lane-c.md`, `integrator.md` using the template in section 1.
- [ ] `.github/workflows/ci.yml` committed (see CI-01).
Tests:
- A docs-only test PR runs CI and merges cleanly.

### CI-01 CI pipeline
Lane: Integrator
Depends on: I-00, A-01
Goal: GitHub Actions workflow running lint, typecheck, unit, and fixture integration tests on every PR and on every push to `lane/*`.
Acceptance:
- [ ] Jobs `lint`, `unit`, `integration`. Each calls a `make` target so local and CI behaviour match.
- [ ] Runs on `ubuntu-latest` with ffmpeg, Node 20, and Python 3.11.
- [ ] Tests marked `needs-gpu` are skipped on hosted runners.
- [ ] No network required at test time. Fixtures are in-repo or fetched by a script with a cache.
- [ ] Caches for node_modules, pip, and ffmpeg assets. Target run time under 10 minutes.
Tests:
- A deliberate lint error on a throwaway branch blocks the PR.

### A-01 Repo scaffold, Makefile, lint (blocker)
Lane: A
Depends on: I-00
Goal: monorepo layout from AGENTS.md §3 with working `make` targets.
Acceptance:
- [ ] `make setup`, `make lint`, `make test` run on a clean clone.
- [ ] `make setup` checks for ffmpeg, Node 20+, Python 3.11, and `nvidia-smi`, and reports anything missing.
- [ ] `.gitignore` covers `storage/`, `.env`, model weights, and large media.
Tests:
- Smoke test: scaffold builds and runs.

### S0-1 Ingest and buffer spike
Lane: A
Depends on: none (runs in parallel with A-01)
Goal: measure ingest behaviour and buffer disk use on this machine.
Acceptance:
- [ ] 30-minute test ingest with reconnect count and segment-gap count recorded.
- [ ] 10-minute buffer confirmed under 3 GB.
- [ ] Source-to-disk latency recorded.
- [ ] ADR-001 written.

### S0-2 Detector model spike
Lane: B
Depends on: none
Goal: pick a detector stack that fits 6 GB VRAM and the CPU budget.
Acceptance:
- [ ] whisper.cpp `base.en` and `small.en` real-time factor on the Ryzen 5 7000 HS.
- [ ] PaddleOCR vs Tesseract on a HUD crop: accuracy on 50 frames and time per call.
- [ ] MobileNetV3-small on RTX 3050 via ONNX Runtime CUDA: time and VRAM.
- [ ] ADR-002 written with a CPU fallback plan.

### S0-3 Product and data spike
Lane: C
Depends on: none
Goal: fix the API and dashboard stack and the SQLite schema.
Acceptance:
- [ ] Fastify for the API and React + Vite for the dashboard, recorded in ADR-003.
- [ ] SQLite schema for `sessions`, `detections`, `clip_jobs`, `clips`, and a migration approach.
- [ ] Three dashboard screens as Markdown wireframes.

### S0-4 Contracts and fixtures (blocker)
Lane: A (B and C review)
Depends on: A-01
Goal: freeze contracts at v0.1.0 and define fixtures.
Acceptance:
- [ ] B and C review `CONTRACTS.md` and record comments in their status files. Changes need a `contract-change` PR.
- [ ] Three fixture clips of 60 seconds each: one quiet, one with a loud burst, one with a text-overlay event. Owner's own footage or public domain only.
- [ ] `fixtures/README.md` lists each file, expected detections, and licence.
- [ ] `packages/shared/schemas/*.json` generated from `CONTRACTS.md`.

### Gate G0 — Analysis complete
- [x] ADR-001, ADR-002, ADR-003 merged.
- [x] Contracts frozen at v0.1.0.
- [x] CI-01 green on `main`.
- [x] Fixtures merged or fetched by script.

---

## 3. Phase 1 — Execution

Lanes run in parallel. Within a lane, follow the dependencies.

### Lane A — Pipeline

**A-02 Config loader and validation.** Depends on A-01.
- Acceptance: invalid config fails at startup with field-level messages; unlisted sources are refused and logged.
- Tests: valid config, missing field, unlisted source, out-of-range threshold.

**A-03 SQLite store and migrations.** Depends on A-01, S0-3.
- Acceptance: idempotent migrations; repository for all four tables; eviction query respects clip-job protection.
- Tests: migrations on empty and existing DB; eviction protection.

**A-04 Ingest with reconnect.** Depends on A-02, S0-1.
- Acceptance: a 30-second network drop reconnects within the backoff schedule; state transitions are logged and stored.
- Tests: integration against a local HLS server with a forced disconnect.

**A-05 Rolling buffer and eviction.** Depends on A-04, A-03.
- Acceptance: buffer stays within configured minutes plus margin; protected segments are never removed.
- Tests: accelerated 3-minute run asserting size and protection.

**A-06 Sampler.** Depends on A-05.
- Acceptance: keeps real-time pace on fixtures; one retry on detector failure, then null signals.
- Tests: timing and `t_stream` monotonicity; sampler against a stub detector.

**A-07 Chat signal adapter.** Depends on A-02.
- Acceptance: aggregate counts only; no text or usernames stored or logged; platform adapter off by default.
- Tests: count aggregation from a fixture log; disabled adapter returns null.

**A-08 Scorer.** Depends on A-06, A-07, B-01.
- Acceptance: weight renormalization on nulls; debounce; cooldown; all-null emits nothing.
- Tests: fusion cases; debounce and cooldown timelines.

**A-09 Cutter and sidecar.** Depends on A-05, A-08, A-03.
- Acceptance: cut window `[t − pre, t + post]` clamped to the buffer; status moves queued → cutting → encoded or failed; path layout per AGENTS §4; sidecar matches `clipforge.clip.v1`; write-then-rename.
- Tests: fixture integration asserting duration and sidecar; path builder strips `www.`.

**A-10 Orchestrator and lifecycle.** Depends on A-04 to A-09.
- Acceptance: `make dev` runs end to end on fixtures; Ctrl+C finishes any cutting job before exit.
- Tests: full fixture run produces at least one clip for the loud-burst fixture.

### Lane B — Detection

**B-01 Detector service scaffold.** Depends on A-01.
- Acceptance: FastAPI on `127.0.0.1:8731`; request and response per CONTRACTS §2–§3; nulls not omitted; window files deleted unless `DEBUG_KEEP_WINDOWS=1`.
- Tests: schema validation; fixture round-trip.

**B-02 Audio signal.** Depends on B-01.
- Acceptance: loud fixture window scores above 0.7, quiet below 0.3; baseline resets per session.
- Tests: synthetic signal unit tests; fixture score ranges.

**B-03 Speech keywords.** Depends on B-01, S0-2.
- Acceptance: keywords from `config/keywords.yaml`, empty by default; transcription within the ADR-002 budget.
- Tests: matcher (case, punctuation, partial words); fixture with a known keyword. Marked `needs-gpu` if CUDA is used.

**B-04 HUD text detection.** Depends on B-01, S0-2.
- Acceptance: crop regions and patterns per game profile in config; OCR at most once per 2 seconds.
- Tests: fixture frame with a known overlay returns a match.

**B-05 Frame classifier.** Depends on B-01, S0-2.
- Acceptance: under 30 ms at 224×224 on RTX 3050; logged CPU fallback; under 1 GB VRAM.
- Tests: preprocessing and label map; labelled fixture frames. Marked `needs-gpu`.

**B-06 Labelling tool and evaluation.** Depends on B-05.
- Acceptance: labels stored as CSV of frame hashes; `make eval:detector` prints precision, recall, and a threshold sweep.
- Tests: metrics on a toy set.

### Lane C — Product

**C-01 API skeleton (read-only).** Depends on A-03, S0-3.
- Acceptance: read endpoints per CONTRACTS §7; `/health` reports detector and disk.
- Tests: integration against a seeded DB.

**C-02 Dashboard shell.** Depends on C-01.
- Acceptance: sessions and live detections (polling every 2 seconds); clip grid with status and source filters.
- Tests: component tests.

**C-03 Review actions.** Depends on C-02.
- Acceptance: PATCH writes only `review.*`; dismissed detections create no clip job.
- Tests: PATCH round-trip; dismiss prevents a cut.

**C-04 Trim.** Depends on C-03, A-09.
- Acceptance: each trim writes a new file; the original is never overwritten; UI shows both.
- Tests: trim from mp4 and from buffer; duration assertions.

**C-05 Export.** Depends on C-04.
- Acceptance: 9:16 export uses NVENC if present, CPU otherwise; captions optional and off by default.
- Tests: fixture export is 9:16.

**C-06 Storage browser.** Depends on C-01.
- Acceptance: tree reflects disk state; reveal-in-explorer works on Windows and Linux.
- Tests: tree builder on a temp directory.

### Gate G1 — Execution complete
- [ ] All Phase 1 tickets merged.
- [ ] CI green on `main`.
- [ ] Contracts still v0.1.x, or a version bump recorded in CONTRACTS.md.

---

## 4. Phase 2 — Debugging

Process:
1. Every bug is logged in `docs/ISSUES.md` as `ISS-###` with lane, repro steps, and severity (S1 crash or data loss, S2 wrong output, S3 cosmetic).
2. The owning lane writes a failing test first, then the fix. The PR cites the ISS ID.
3. Cross-lane bugs belong to the lane where the fault is traced.
4. The Integrator checks every fix PR for a regression test before merging.
5. No open S1 issues may remain at G2.

Tickets:

**D-01 Detection calibration.** Lane B, reading A's logs. Run the three fixtures, log every false positive and negative, and tune weights and thresholds in config only. Record in `docs/adr/ADR-004-calibration.md`.

**D-02 Clip boundary check.** Lane A. Every clip starts and ends within 0.5 seconds of the expected stream time.

**D-03 Product state consistency.** Lane C. DB, sidecar, and disk tree agree after dismiss, trim, and export.

### Gate G2 — Debugging complete
- [ ] No open S1 issues.
- [ ] No open S2 issues without a documented workaround.
- [ ] ADR-004 merged.

---

## 5. Phase 3 — Testing

**CI-02 Nightly GPU regression.** Integrator. Register the laptop as a self-hosted GitHub Actions runner with label `gpu`. A nightly workflow runs `needs-gpu` tests and the fixture pipeline on the RTX 3050. Results attach to the workflow run.

**T-01 Full fixture integration.** Lane A. `make test:fixtures` runs the pipeline on all three fixtures and checks clip counts within tolerance.

**T-02 Soak test (4 hours).** Lanes A and B. Continuous run on a recorded stream. Track RSS, CPU, VRAM, buffer size, and clip count. Results in `docs/soak/`.
- RSS under 8 GB; VRAM under 4.5 GB; no unbounded growth outside `clips/`; detection p95 under 3 seconds.

**T-03 Failure injection.** Lane A. Network drop, disk full, GPU unavailable, detector down, corrupted segment. Each recovers or fails with a clear log line.

**T-04 Dashboard end-to-end.** Lane C. Playwright tests for review, trim, export, and the storage browser. Runs in CI on `ubuntu-latest`.

**T-05 Performance budget.** Lane B. Confirm the AGENTS §6 budgets on target hardware. Results in `docs/perf/`.

### Gate G3 — Testing complete
- [ ] T-01 to T-05 passing.
- [ ] CI-02 green on the last three nightly runs.
- [ ] Soak results with no S1 findings.

---

## 6. Phase 4 — Production hardening and release

**P-01 Startup checks.** Lane A. Preflight for ffmpeg, GPU, detector, and disk. Refuses to start with clear messages.

**P-02 Logging and retention.** Lane A. JSON log rotation; buffer eviction verified in production mode.

**P-03 Windows and WSL startup.** Lane A. WSL2 start script and Windows Task Scheduler template.

**P-04 Dashboard production build.** Lane C. Served by the API on localhost; bundle budget enforced in CI.

**P-05 Runbook and README.** Lane C, with A and B inputs. Setup, daily use, troubleshooting, clip locations, manual upload steps, and the permission and ToS reminder.

**REL-01 Release workflow.** Integrator. `.github/workflows/release.yml` runs on tags `v*`: full CI, builds dashboard and orchestrator, packages artifacts, and creates a GitHub Release with a changelog from merged PR titles.

**REL-02 Tag v1.0.0.** Integrator. Only after G4.

### Gate G4 — Production ready
- [ ] P-01 to P-05 merged.
- [ ] Runbook dry-run by a fresh agent session with no prior context.
- [ ] `v1.0.0` tagged and released.

---

## 7. Gate records

The Integrator fills these in when each gate passes. Lane agents do not edit this section.

| Gate | Status | Date | Evidence |
|---|---|---|---|
| G0 Analysis | PASSED | 2026-11-21 | ADR-001 (PR #3), ADR-002 (PR #6), ADR-003 (PR #1) merged; contracts v0.1.0 & schemas/fixtures merged (PR #3); CI green |
| G1 Execution | pending | | |
| G2 Debugging | pending | | |
| G3 Testing | pending | | |
| G4 Production | pending | | |

---

## 8. Launch prompts

Open four terminals. Start the Integrator first, because it creates the repository and branches the others depend on.

### Integrator (start first)

```
You are the Integrator for clipforge. Read AGENTS.md, docs/PLAN.md, and
docs/CONTRACTS.md in full. Your work is I-00 first, then CI-01. After that,
your loop is: find PRs marked READY in docs/status/lane-*.md, review them
against AGENTS.md §5 and §12, confirm CI is green, squash-merge to main, and
update docs/status/integrator.md. You are the only agent that merges to main
and the only agent that edits the gate section of docs/PLAN.md. Never write
product code in lane directories. If a PR touches another lane's directory
without a ticket, reject it with a comment. When all tickets for a phase are
merged, run the gate checklist, record the result in section 7, and report.
```

### Agent A — Pipeline (start after I-00)

```
You are Agent A (Pipeline) for clipforge. Read AGENTS.md, docs/CONTRACTS.md,
and docs/PLAN.md in full. Work only in apps/orchestrator/, packages/shared/,
and docs/status/lane-a.md. You own the blocker tickets A-01 and S0-4; do them
first, and run S0-1 alongside. Then take the next ticket whose dependencies
are merged to main. For each ticket: git fetch && git merge origin/main; work
on lane/a; run make lint and make test; push; open a PR titled "<ID> <title>";
set your status file to READY with the PR number; then wait for the
Integrator. If the Integrator comments, fix on lane/a and push again. If you
are blocked, set BLOCKED in your status file and move to the next unblocked
ticket in your lane.
```

### Agent B — Detection (can start now; S0-2 needs no scaffold)

```
You are Agent B (Detection) for clipforge. Read AGENTS.md, docs/CONTRACTS.md,
and docs/PLAN.md in full. Work only in workers/detector/, fixtures/labels/,
and docs/status/lane-b.md. Start with S0-2, which does not depend on A-01.
Then take the next ticket whose dependencies are merged to main. For each
ticket: git fetch && git merge origin/main; work on lane/b; run make lint and
make test; push; open a PR; set your status file to READY with the PR number;
wait for the Integrator. You may not change CONTRACTS.md directly. If the
contract blocks you, write the proposed change in your status file, and open a
contract-change PR once Agent A approves it.
```

### Agent C — Product (can start now; S0-3 needs no scaffold)

```
You are Agent C (Product) for clipforge. Read AGENTS.md, docs/CONTRACTS.md,
and docs/PLAN.md in full. Work only in apps/api/, apps/dashboard/, and
docs/status/lane-c.md. Start with S0-3. Then take the next ticket whose
dependencies are merged to main. For each ticket: git fetch && git merge
origin/main; work on lane/c; run make lint and make test; push; open a PR;
set your status file to READY with the PR number; wait for the Integrator. Do
not edit apps/orchestrator/ or workers/. If you need something from them,
write a request in your status file under "Cross-lane requests".
```

---

## 9. Backlog (not in v1.0.0)

- Server-sent events for the detection feed.
- Multiple streams in parallel.
- Highlight-reel stitching across sessions.
- Caption style presets.

Add ideas here. Do not implement them without a ticket.
