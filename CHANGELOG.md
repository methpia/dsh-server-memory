# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-13

First working version, matching the design in `DESIGN.md`.

### Added

- `server/memoryd.py`: single-file Python 3.9 stdlib service with SQLite WAL,
  FTS5 external-content index, Han bigram preprocessing, bm25 + recency + kind
  ranking with LIKE fallback, bearer-token auth, and server-side size limits.
- `/api/context`, `/api/search`, `/api/notes`, `/api/items`, `/api/projects`,
  `/api/watermark` and atomic `/api/watermark/claim`.
- `dsh-server-memory` plugin: budgeted prompt index fed by a background cache, project
  resolution (project map 鈫?git root 鈫?directory 鈫?default), and the four tools
  `memory_search`, `memory_save`, `memory_forget`, `memory_consolidate`.
- Consolidation loop: claim 鈫?local transcript digest 鈫?model summary 鈫?  `memory_save({ notes, consolidationId })` 鈫?forward-only watermark advance.
- Per-frame zstd transcript reader for DSH `session.v4.jsonl.zstd`, with
  project/depth/mtime filtering, final-reply selection, and code-block truncation.
- Deployment assets: config example, launchd units for the service and daily
  backup, `backup.sh` keeping 14 snapshots.
- Tests: 38 server unittests, 88 plugin tests, and `scripts/smoke.mjs` for
  14 end-to-end checks against a running service.
- Documentation: root README, plugin README, server README, `docs/STRUCTURE.md`.

