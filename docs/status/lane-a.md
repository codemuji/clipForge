# Lane A status

## Current
Ticket: A-05 Rolling buffer and eviction
State: READY
Branch: lane/a
PR: #15
Blocked by: none
Notes: Implemented BufferManager with sliding retention window (bufferMinutes + marginSeconds), index parsing, SQLite clip job protection query integration (prevents unlinking queued/cutting segments), and disk usage metrics. Tested with 40/40 passing unit and integration tests.

## Done
- A-01 Repo scaffold, Makefile, lint — MERGED (#2)
- S0-4 Contracts and fixtures — MERGED (#3)
- S0-1 Ingest and buffer spike — MERGED (#3)
- A-02 Config loader and validation — MERGED (#5)
- A-03 SQLite store and migrations — MERGED (#8)
- A-04 Ingest with reconnect — MERGED (#14)
