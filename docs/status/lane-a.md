# Lane A status

## Current
Ticket: A-06 Sampler
State: READY
Branch: lane/a
PR: #17
Blocked by: none
Notes: Implemented StreamSampler, MediaExtractor (JPEG + 16kHz mono WAV extraction under real-time budget), DetectorClient with single retry and null-signal fallback, and strict monotonicity enforcement. All 44 tests pass.

## Done
- A-01 Repo scaffold, Makefile, lint — MERGED (#2)
- S0-4 Contracts and fixtures — MERGED (#3)
- S0-1 Ingest and buffer spike — MERGED (#3)
- A-02 Config loader and validation — MERGED (#5)
- A-03 SQLite store and migrations — MERGED (#8)
- A-04 Ingest with reconnect — MERGED (#14)
- A-05 Rolling buffer and eviction — MERGED (#15)
