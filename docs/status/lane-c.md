# Lane C status

## Current
Ticket: C-05 Export
State: READY
Branch: lane/c
PR: #25
Blocked by: none
Notes: Implemented POST /clips/:id/export endpoint (9:16 vertical crop with NVENC acceleration or CPU fallback, optional captions off by default, preserves original clip), metadata sidecar generation with atomic write, and Dashboard UI export workbench integration. All 22 API tests, 16 Dashboard tests, and monorepo suite pass.

## Done
- S0-3 Product and data spike — DONE (PR #1)
- C-01 API skeleton (read-only) — DONE (PR #4)
- C-02 Dashboard shell — DONE (PR #7)
- C-03 Review actions — DONE (PR #10)
- C-06 Storage browser — DONE (PR #12)
- C-04 Trim — DONE (PR #23)
