# Lane A status

## Current
Ticket: A-06 Sampler
State: IN PROGRESS
Branch: lane/a
PR: none
Blocked by: none
Notes: Implementing rolling buffer sampler (frame extraction, 5s 16kHz WAV mono audio extraction, detector client with retry-then-null fallback, monotonicity enforcement).

## Done
- A-01 Repo scaffold, Makefile, lint — MERGED (#2)
- S0-4 Contracts and fixtures — MERGED (#3)
- S0-1 Ingest and buffer spike — MERGED (#3)
- A-02 Config loader and validation — MERGED (#5)
- A-03 SQLite store and migrations — MERGED (#8)
- A-04 Ingest with reconnect — MERGED (#14)
- A-05 Rolling buffer and eviction — MERGED (#15)
