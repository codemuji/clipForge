# Lane A status

## Current
Ticket: A-10 Orchestrator and lifecycle
State: IN PROGRESS
Branch: lane/a
PR: none
Blocked by: none
Notes: Wiring ingest, buffer manager, sampler, chat adapter, scorer, and clip cutter into end-to-end PipelineOrchestrator daemon with graceful shutdown on SIGINT/Ctrl+C (drain pending clip cuts before exit). Testing full fixture run on loud-burst fixture.

## Done
- A-01 Repo scaffold, Makefile, lint — MERGED (#2)
- S0-4 Contracts and fixtures — MERGED (#3)
- S0-1 Ingest and buffer spike — MERGED (#3)
- A-02 Config loader and validation — MERGED (#5)
- A-03 SQLite store and migrations — MERGED (#8)
- A-04 Ingest with reconnect — MERGED (#14)
- A-05 Rolling buffer and eviction — MERGED (#15)
- A-06 Sampler — MERGED (#17)
- A-07 Chat signal adapter — MERGED (#18)
- A-08 Scorer — MERGED (#20)
- A-09 Cutter and sidecar — MERGED (#22)
