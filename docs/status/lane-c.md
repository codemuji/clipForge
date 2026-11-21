# Lane C status

## Current
Ticket: C-03 Review actions
State: READY
Branch: lane/c
PR: #10
Blocked by: none
Notes: Implemented PATCH /clips/:id/review (updates only review.* fields, synced with atomic sidecar JSON write) and POST /detections/:id/dismiss (prevents clip job creation). Wired actions into Dashboard UI with live optimistic updates. All 21 API & dashboard unit/component tests passing, dashboard build passes, monorepo lint passes.

## Done
- S0-3 Product and data spike — DONE (PR #1)
- C-01 API skeleton (read-only) — DONE (PR #4)
- C-02 Dashboard shell — DONE (PR #7)
