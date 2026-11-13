# Design (key sections, English)

This is an abridged English translation of the sections that carry the design decisions. The full document —
including the data model DDL, retrieval formulas, plugin internals and the task breakdown — is in
[DESIGN.md](DESIGN.md) (Chinese).

Translated here: **goals**, **constraints**, **the incident that shaped them**, **architecture**, **the HTTP API**,
**the consolidation protocol**, and the **cost model**.

---

## 1. Goals and non-goals

### Goals

1. **Zero LLM on the daily path.** Normal sessions only read memory and journal; no model calls.
2. **One consolidation per day**, incremental per project, done by the agent's own model.
3. **Self-hosted on the LAN** — the service runs on your own machine.
4. **Customisable** — schema, ranking and consolidation rules are ours.
5. **Bounded cost** — roughly 8k input / 1k output tokens per day.

### Non-goals

- Code-repository intelligence (git history mining, code search).
- Entity resolution, knowledge graphs, contradiction tracking.
- Real-time memory writes without the user asking.
- Cross-project memory fusion: one namespace per project.

## 2. Verified environment constraints

These are measurements, not assumptions. Recheck them before changing the stack.

| Constraint | Observed | Consequence |
|---|---|---|
| Apple Silicon macOS | arm64, 15.8, 16 GB | — |
| Docker Hub | **unreachable** (`registry-1.docker.io` times out) | cannot pull new base images |
| ghcr.io | reachable | only source of images, if any |
| Node on the host | **absent** | server cannot be Node |
| Python on the host | **3.9.6** (`/usr/bin/python3`) | stdlib only, 3.9 syntax |
| SQLite FTS5 | available (3.43.2) | full-text search with no dependency |
| Port 8888 | taken | the service uses **8788** |
| Tailscale | available, MagicDNS on | remote access via `tailscale serve` |

**Conclusion:** the server is a single file of Python 3.9 stdlib (`http.server` + `sqlite3` + `json`). Do not add
FastAPI, uvicorn or torch — they cannot be installed, and they are not needed.

## 2.1 The incident that produced these rules

On 2026-11-13 the previous backend (an LLM-on-every-write design) cost **¥9.91 in one day** versus **¥0.46** for the
actual work conversation. Root cause: a **3,577,983-character** session transcript was submitted as a single document.
Chunked extraction split it into **2381 memory units** and several hundred LLM calls, at roughly 10k tokens per batch.

Rules that follow, and that this design must keep:

1. **200 KB hard cap per document.** Longer input is rejected or split — a whole session never enters the store.
2. **Session transcripts never enter the memory database.** They are read transiently at consolidation time.
3. Consolidation input has its **own** budget (8000 chars), independent of transcript length.
4. Any capability that writes conversations back to the server is **off by default** and needs an explicit switch.

Enforce rule 1 **server-side** (`/api/notes`, `/api/items`), not only in the client.

## 3. Architecture

```
┌─ DSH host ──────────────────────────────────┐
│  dsh-server-memory plugin (ESM, no deps)    │
│   ├─ systemPrompt.section: ≤900-char index  │
│   ├─ background cache: poll /api/context    │
│   ├─ tools: search / save / forget /        │
│   │         consolidate                     │
│   └─ reads local transcripts → digest       │
└──────────────────┬──────────────────────────┘
                   │ HTTP + bearer token
┌──────────────────▼──────────────────────────┐
│  memoryd (Python 3.9 stdlib, single file)   │
│   ├─ SQLite (WAL) + FTS5 (Han bigrams)      │
│   └─ REST: context / search / notes /       │
│            items / projects / watermark     │
└─────────────────────────────────────────────┘
```

Two properties matter more than the boxes:

- **The server never calls an LLM.** It stores text, indexes it, answers queries.
- **The plugin holds no database.** Every client pointing at the same service sees the same memory.

## 6. HTTP API

Prefix `/api`. Authentication: `Authorization: Bearer <token>` on **every** endpoint except `/health`.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | — | `{"ok":true,"version":1,"schema":1,"projects":N,"items":N}` |
| GET | `/api/context?project=&limit=&max_chars=` | — | `{"items":[…],"watermark":{…}}` |
| GET | `/api/search?project=&q=&limit=` | — | same shape |
| POST | `/api/notes` | `{"project":"p","notes":[{"text":"…","tags":["…"]}]}` | `{"stored":N,"ids":[…]}` |
| POST | `/api/items` | `{"project":"p","text":"…","tags":[…]}` | `{"id":N}` |
| DELETE | `/api/items/{id}` | — | `{"deleted":true}` |
| GET | `/api/watermark?project=` | — | `{"last_consolidated":…,"last_status":…}` |
| POST | `/api/watermark` | `{"project","last_consolidated","status"}` | `{"ok":true}` |
| POST | `/api/watermark/claim` | `{"project","min_interval_hours":24}` | `{"claimed":true,"since":…}` or `{"claimed":false,"reason":"too_soon"}` |
| GET | `/api/projects` | — | `{"projects":[{id,label,items,last_note_at}]}` |

Conventions:

- Timestamps are ISO-8601 UTC with `Z`; the server does no timezone conversion.
- `project` is supplied by the client; the server creates the row on demand (never 404).
- Errors: `{"error":{"code":"…","message":"…"}}`.
- `text` ≤ 4000 chars, ≤ 50 notes per `/api/notes`, otherwise 413.

## 8. Consolidation protocol

This is the heart of the design: it replaces "LLM on every write" with "LLM once a day, by the agent".

### 8.1 Trigger

Evaluated on the **first user message of a session only**:

```
claim = POST /api/watermark/claim {project, min_interval_hours: 24}
if not claim.claimed        -> do nothing
if no local transcript since claim.since -> advance watermark, do nothing
else                        -> consolidate
```

`claim` is an atomic server-side update of `last_run_at`, so two windows or two machines cannot consolidate the same
project at once. `claimed:false` means the agent does nothing at all.

### 8.2 Execution

1. Read local transcripts (DSH: `~/.dsh/sessions/**`; WorkBuddy: `~/.workbuddy/projects/**`) newer than `since`.
2. Keep user messages and final assistant replies; drop tool arguments, thinking and code blocks longer than ~20 lines.
3. Pack newest-first into an **8000-character** budget. Whatever does not fit stays for next time — the watermark
   advances only to the timestamp of the **last consumed entry**, never to `now`.
4. Hand the digest to the agent with instructions to produce 5–15 lines, one per memory, each prefixed
   `[决策]` (decision) / `[偏好]` (preference) / `[风险]` (risk) / `[经验]` (lesson), ≤60 characters, no process narration.
5. The agent calls `memory_save({notes, consolidationId})`; the plugin writes the notes and advances the watermark.

**Failure handling:** any step may fail; nothing blocks the day's work. `last_run_at` was already advanced by `claim`,
so the project retries tomorrow rather than in a loop.

### 8.3 Why the agent and not the server

- A server-side LLM means storing an API key, implementing retries, and paying per write — the old design, again.
- The agent already has the model, the context, and the project's vocabulary.
- The cost happens once, and the user can see it in their own session.

### 8.4 Explicit writes

`memory_save` (kind=`manual`) bypasses consolidation entirely: it is the user asking the agent to remember something,
which costs no extra call.

## 10. Cost model

| Item | Previous backend | This design |
|---|---|---|
| Session write-back extraction | per session, ~1.6M in / 320k out per 2 days | **0** (no write-back) |
| Session-start injection | reflect loop, ~2M in / 2 days | **0** (plain retrieval) |
| Automatic consolidation | ~2.5M in / 2 days | **0** (disabled) |
| Page refresh | 15 pages / hour | **no such concept** |
| Daily consolidation | — | 1 call, ~8k in / 1k out |
| **Total** | **~¥7/day** | **~¥0.05/day** |

Measure it, do not trust the estimate: `GET /metrics` on the server, or count calls in the provider dashboard.
The acceptance criterion is that `memoryd` makes **zero** LLM calls, and the day has exactly one consolidation.

---

Everything else — DDL, ranking weights, plugin internals, acceptance checklist, task breakdown — is in
[DESIGN.md](DESIGN.md).
