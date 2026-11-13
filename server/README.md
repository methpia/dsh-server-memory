# memoryd

The service half of `dsh-server-memory`. One file, Python 3.9 standard library only
(`http.server` + `sqlite3` + `json`). It stores text, indexes it with SQLite
FTS5, and returns retrieval results. **It never calls a language model.**

## Requirements

| Item | Requirement | Why |
|---|---|---|
| Python | 3.9+ (`/usr/bin/python3` on macOS 15 is 3.9.6) | no pip, no venv, no build step |
| SQLite | FTS5 enabled (3.9+ has it) | full-text search without dependencies |
| Disk | a few MB in `~/dsh-memory/data/` | single SQLite file + WAL |
| Network | `127.0.0.1:8788` by default | 8888 is often already taken |

## Start

```bash
python3 memoryd.py --init-config     # ~/.config/dsh-memory/config.json + random token (mode 600)
python3 memoryd.py --check           # open the DB, print project/item counts
python3 memoryd.py                   # serve on 127.0.0.1:8788
```

Environment overrides: `MEMORYD_CONFIG`, `MEMORYD_TOKEN`, `MEMORYD_HOST`,
`MEMORYD_PORT`, `MEMORYD_DB`, `MEMORYD_ALLOW_JOURNAL`.

## Config

```json
{
  "token": "…",
  "host": "127.0.0.1",
  "port": 8788,
  "db_path": "~/dsh-memory/data/memory.db",
  "allow_journal": false,
  "default_context_items": 20,
  "default_context_chars": 1500,
  "min_claim_interval_hours": 24,
  "ranking": {
    "bm25": 1.0,
    "recency": 0.35,
    "kind": 0.25,
    "half_life_days": 30,
    "kind_weights": { "note": 1.0, "manual": 1.2, "journal": 0.4 }
  }
}
```

- `token` is mandatory. The service refuses to start without it.
- `allow_journal` stays `false`: journal rows are raw conversation flow and
  must not be stored (DESIGN.md 2.1).
- `ranking` constants live in config so retrieval can be tuned without code
  changes (DESIGN.md 5).

## Run as a service (macOS)

```bash
mkdir -p ~/Library/Logs
cp launchd/com.local.memoryd.plist ~/Library/LaunchAgents/
# edit the /Users/you paths inside the plist first
launchctl load ~/Library/LaunchAgents/com.local.memoryd.plist
launchctl list | grep memoryd
tail -f ~/Library/Logs/dsh-memory.log
```

`KeepAlive=true` restarts after a crash. To stop:
`launchctl unload ~/Library/LaunchAgents/com.local.memoryd.plist`.

## Backup

```bash
server/scripts/backup.sh                       # manual run
launchctl load ~/Library/LaunchAgents/com.local.memoryd.backup.plist   # daily 03:00
```

`sqlite3 .backup` writes a consistent snapshot while the service keeps running;
the last 14 copies are kept (DESIGN.md 11).

## Remote access

Keep the service on loopback and put Tailscale in front:

```bash
tailscale serve --bg http://127.0.0.1:8788
curl -s https://<machine>.<tailnet>.ts.net/health
```

Then set the plugin's `serverUrl` to that HTTPS URL. Do not bind `0.0.0.0`
without a firewall: one token is the only thing between the internet and the
memory store.

## Data model

```
projects(id, label, created_at, last_seen_at)
items(id, project, kind, text, tags, source, created_at, search_text)
items_fts(search_text)              -- external-content FTS5, synced by triggers
watermark(project, last_consolidated, last_run_at, last_status, last_error)
meta(k, v)                          -- schema_version
```

`items.search_text` is not the raw text: Han runs are split into overlapping
bigrams (`结算模块` → `结算 算模 模块`) because `unicode61` would otherwise index
the whole run as one token. Queries go through the same transform, so a search
for `日结` or `结算` both hit a row containing `结算模块改为按日结`.

`last_consolidated = ''` means "never consolidated". Watermarks only move
forward; a late writer cannot rewind one.

## API

Every endpoint except `GET /health` requires
`Authorization: Bearer <token>`. Errors are
`{"error": {"code": "...", "message": "..."}}`; timestamps are ISO 8601 UTC with
`Z`; responses are UTF-8 JSON with `no-store`.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | no auth; `{ok, version, schema, projects, items, time}` |
| GET | `/api/context` | `project`, `limit`, `max_chars`; returns items + total + watermark + consolidation |
| GET | `/api/search` | `project`, `q`, `limit`; FTS5 first, LIKE fallback |
| POST | `/api/notes` | `{project, notes:[{text,tags}], source, kind}`; ≤50 notes, ≤4000 chars each |
| POST | `/api/items` | `{project, text, tags}`; kind defaults to `manual` |
| DELETE | `/api/items/{id}` | `{deleted:true}` |
| GET | `/api/watermark` | `{last_consolidated, last_run_at, last_status, last_error}` |
| POST | `/api/watermark` | `{project, last_consolidated, status, error}`; forward-only |
| POST | `/api/watermark/claim` | `{project, min_interval_hours}`; atomic once-a-day reservation |
| GET | `/api/projects` | `{projects:[{id,label,items,last_note_at}]}` |

Limits (server-side, not client-dependent): text ≤4000 chars, ≤50 notes per
request, request body ≤1MB, `project` matching `^[\w.:-]{1,64}$`.

## Tests

```bash
python3 -m unittest discover -s tests -v     # 38 tests, no network beyond loopback
```

They boot the real server on an ephemeral port with a temp database and assert
health, auth failures, Chinese retrieval, budget truncation, 413 limits, claim
idempotency, watermark monotonicity and project summaries.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no token configured` at startup | run `--init-config` or set `MEMORYD_TOKEN` |
| `401 unauthorized` from a client | token mismatch; the token file must be BOM-free UTF-8 |
| `journal-disabled` on write | expected: only summaries are stored |
| Chinese search returns nothing, Latin works | the row was written before bigram indexing (rebuild: `INSERT INTO items_fts(items_fts) VALUES('rebuild')`) |
| Port already in use | 8888 is Hindsight; this service defaults to 8788 on purpose |
| `database schema version ... does not match` | restore a matching backup; migrations are versioned in `meta` |
