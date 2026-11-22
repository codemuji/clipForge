# Lane A status

## Current
Ticket: Phase 1 Complete — Awaiting Gate G1
State: IDLE
Branch: lane/a
PR: none
Blocked by: none
Notes: All Phase 1 tickets (A-01 through A-10) merged to main. Pipeline daemon, rolling buffer, ingest, sampler, chat adapter, scorer, cutter, and lifecycle shutdown fully implemented and verified. Waiting for Gate G1 to pass before starting Phase 2 (D-02 Clip boundary check).

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
- A-10 Orchestrator and lifecycle — MERGED (#24)
