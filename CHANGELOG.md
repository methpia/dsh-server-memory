# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.2] - 2026-11-27

The daily consolidation hint reaches long conversations.

### Fixed

- `UserPromptSubmit` checked the consolidation window only on the prompt that first injected the
  project index. A conversation that had been open for weeks injected once and then returned early on
  every later prompt, so the hint could never appear — even after the 24-hour window became due. The
  hook now probes `consolidation.due` on later prompts and emits the hint once per session
  (`hintedConsolidation` still caps it at one).

### Changed

- Adapter tests: 21 → 22 (a second prompt on an already-injected session gets the hint, a third does not).

## [0.7.1] - 2026-11-25

Long-lived WorkBuddy sessions can be consolidated.

### Fixed

- **Oversized transcripts are read from the tail** instead of being skipped. WorkBuddy users keep one
  conversation for months, so a single JSONL can reach hundreds of megabytes (the reference session is
  367 MB); the 8 MiB guard used to throw, leaving consolidation with nothing to summarize. The reader now
  takes the last `transcriptMaxBytes` and drops the partial first line.
- WorkBuddy hooks read their configuration from `~/.config/dsh-memory/workbuddy.json`; an install without
  that file silently pointed at `http://127.0.0.1:8788` and every hook failed. Documented in
  `docs/WORKBUDDY.md` with the exact file.

### Added

- **`sessionProjects`** in the WorkBuddy config: pin a long conversation to a project so it no longer has
  to name the project in every prompt. Both hooks consult the pin before resolving text, and the pin is
  recorded in the adapter state so consolidation can attribute the session.
- Adapter tests: 19 → 21 (tail read, pinned session).

## [0.7.0] - 2026-11-25

The plugin can now tell you how to stand up its own server.

### Added

- **Bundled server**: `dsh-server-memory/server/memoryd.py` ships inside the package (byte-identical to
  the repo's `server/memoryd.py`, guarded by a test), so a marketplace install can run the service
  without cloning the repository.
- **`memory_setup` guidance**: one text rendered by the tool, by the settings page's help block and by the
  tool error hint, with the commands for the bundled copy or for a git clone. It is guidance only —
  nothing here runs a command.

### Changed

- `cordis.patch.yml` no longer pins `serverUrl`/`tokenFile` defaults: an install is configured through
  the `DSH_MEMORY_*` environment variables or the settings page, instead of a row value that would pin
  every user of the package to one host.
- Plugin tests: 106 → 125 (setup text, bundled-server presence, config fallbacks).

## [0.6.2] - 2026-11-19

The package directory is now the product name.

### Changed

- **`plugins/` renamed to `dsh-server-memory/`.** For a subdirectory submission the marketplace derives
  the storefront name from the directory leaf (`pluginName()` in the market client falls back to it when
  the entry has no npm mapping), so a generic `plugins/` directory was displayed as "plugins". Imports,
  CI paths, profile links and docs updated; the package name and every tool are unchanged.
- `docs/marketplace-entry.yml` repointed to `.../tree/main/dsh-server-memory` with
  `name: methpia/dsh-server-memory#dsh-server-memory`; the submission becomes a rename of the entry
  file in awesome-dsh-plugin.

## [0.6.1] - 2026-11-19

Declare the DSH version this plugin needs.

### Added

- `engines.dsh` in `plugins/package.json` (`>=0.2.0-rc.2`), so the market can filter by host
  compatibility and `dsh plugin add` refuses an incompatible host instead of failing later. Packages
  without it fall back to their `@deepseek-ai/dsh*` peer dependencies, which this plugin has none of.

## [0.6.0] - 2026-11-17

Projects can now be created from DSH, not only from WorkBuddy.

### Added

- **`memory_projects` tool** (`list` / `create` / `update` / `resolve`): create a memory library, rename it,
  set aliases, or list what exists. A conversation can therefore be told “新建一个记忆库叫 X”; once created,
  `memory_save` and `memory_search` accept the new id or any alias through their `project` argument.
- **Settings page: a new-project row** (id, label, aliases, Create). It calls the same
  `POST /api/projects` upsert as the tool, so both paths converge on one table.

### Changed

- Plugin tests: 101 → 106 (tool create/list/resolve, admin create-through-the-route).
- Docs: user guide explains the two ways to create a project; tool tables list `memory_projects`.

## [0.5.0] - 2026-11-17

Marketplace readiness, and projects addressable by name from DSH too.

### Added

- `memory_search`, `memory_save`, `memory_forget` and `memory_consolidate` accept an optional
  `project` argument — a project id or one of its aliases ("车易到") — so a DSH conversation can reach
  another project, not only the working directory's. Unknown names fail loudly instead of silently
  falling back to the current project.
- `assets/icon-180.png`: a raster icon (the marketplace serves GitHub-hosted bitmaps and cannot use the
  SVG).
- `docs/marketplace-entry.yml`: the `awesome-dsh-plugin` submission, kept in-repo so the entry and the
  package cannot drift.
- Repository topic `dsh-plugin` (a listing prerequisite).

### Changed

- **`plugin/` moved to `plugins/`.** The marketplace manifest probe reads `package.json` at the repo
  root or a `packages/` · `plugins/` · `apps/` subpackage; a singular `plugin/` directory is not
  probed. Imports, tests, CI paths and docs were updated.
- Plugin tests: 98 → 101 (three cases covering id, alias and unknown-project handling).

## [0.4.0] - 2026-11-13

Container deployment.

### Added

- `server/docker/`: a Dockerfile (`ghcr.io/astral-sh/uv:python3.12-bookworm-slim`, because Docker Hub is unreachable on
  some networks) and a compose file. The database is a bind mount, the config directory — which holds the token — is
  mounted read-only, and the container listens on `0.0.0.0` inside while the publish rule decides the interface.
  Includes a `HEALTHCHECK` so `docker compose ps` reports `healthy`.
- Documentation: a Docker section in `server/README.md`, a Docker option in the user guide, and a pointer from the
  public-deployment page.
## [0.3.0] - 2026-11-13

WorkBuddy support, a settings UI, and project aliases: a project can now be
addressed by name instead of by working directory.

### Added

- **Settings page** in Settings → Plugins → Project memory: connection fields
  (service URL, token file, default project), index/consolidation budgets, a
  connection test, a "load projects" button, and inline label/alias editing.
  Configuration is persisted through the host config editor (the plugin restarts
  to apply it); the bearer token never leaves the host.
- `GET /api/dsh-server-memory` / `POST /api/dsh-server-memory` host route behind
  the settings page (health, projects, save-project, save-settings).
- `GET /api/resolve?q=` (server): resolves conversation text to a project using
  labels and aliases; longer aliases win, ties fall back to project size.
- `POST /api/projects` (server): create a project or set its `label` / `aliases`.
- Schema **v2**: `projects.aliases`, migrated in place from v1 on open.
- **WorkBuddy consolidation** (`workbuddy/`): `memory_consolidate` MCP tool
  (manual-first), `memory_save({ consolidationId })` to commit a digest and
  advance the watermark, a WorkBuddy JSONL transcript reader, and a once-a-day
  hint from the `UserPromptSubmit` hook (daily auxiliary).
- WorkBuddy adapter is now its own folder (`workbuddy/`) with its own tests; it is
  no longer part of the npm package. The package stays DSH-only.
- `scripts/projects.mjs`: `list` / `set` (label + aliases) / `resolve`, avoiding
  the PowerShell UTF-8 quoting trap.
- `docs/WORKBUDDY.md`: full setup, verification and limitations.
- Tests: 98 plugin (incl. 9 route tests), 19 WorkBuddy adapter tests (incl.
  transcript extraction and consolidation), 47 server tests (aliases,
  resolution, migration).

### Fixed

- The memory index footer reported the number of *displayed* rows instead of the
  project's real row count: the background cache dropped the server's `total`, so
  a project with 9 memories and `indexMaxItems: 6` rendered `共 6 条`. The cache
  now keeps `total`, the footer shows the real count and marks the index as
  truncated (`仅列最重要的 6 条`), and a response without `total` still falls back
  to the displayed rows.

## [0.2.0] - 2026-11-13

Public-server deployment, plus onboarding docs.

### Added

- `tls_cert` / `tls_key` config keys (and `--tls-cert` / `--tls-key`, `MEMORYD_TLS_CERT` / `MEMORYD_TLS_KEY`)
  so the service can terminate TLS itself on a public host. Both are required together; TLS 1.2 minimum.
- `docs/USER-GUIDE.md` (EN) and `docs/QUICKSTART.zh-CN.md` (ZH): the two-machine setup, token distribution,
  verification, daily behaviour, maintenance and a troubleshooting table.
- `docs/PUBLIC-DEPLOYMENT.md`: VPS deployment with certbot, systemd, firewall, a Caddy/nginx alternative,
  and an explicit list of what public deployment does not give you.
- `X-Content-Type-Options: nosniff` on every response.
- Four config tests covering the TLS pair requirement.

### Changed

- `--check` no longer requires a token: it only opens the database.
- The startup log reports the actual scheme (`http://` or `https://`).

### Fixed

- `port: 0` was clamped to `1`, so the test harness could not ask the OS for an ephemeral port.
  Binding port 1 without privileges fails on Linux (EACCES); Windows silently allowed it.
- Removed author-only publishing notes from the Chinese README.
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

