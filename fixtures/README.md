# Fixtures

This directory contains deterministic test fixtures for local testing and CI.
Per AGENTS.md §5 and §10:
- Deterministic tests run against fixture files in `fixtures/`, never against live streams.
- CI must not require network access.
- No copyrighted third-party footage. Files must be under 20 MB or fetched via cache/download script.

## Fixture Clips
1. `quiet_session.mp4`: Baseline quiet gameplay/speech with low audio energy and no hype triggers.
2. `loud_burst.mp4`: Segment containing an audio volume burst / hype moment crossing threshold.
3. `hud_overlay.mp4`: Segment displaying text HUD overlays (e.g. victory/kill/goal announcements).
