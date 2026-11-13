# dsh-server-memory

[![ci](https://github.com/methpia/dsh-server-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/methpia/dsh-server-memory/actions/workflows/ci.yml)

Project-scoped long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH), self-hosted, with a
**zero-LLM daily path**.

[中文文档](README.zh-CN.md) · **[User guide](docs/USER-GUIDE.md)** · **[Public deployment](docs/PUBLIC-DEPLOYMENT.md)** · [Design (EN)](DESIGN.en.md) · [设计文档](DESIGN.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

---

## Why this exists

Agent memory products usually run an LLM on every write: extract facts, merge observations, refresh pages. That is
precise and expensive. A single session write-back of a 3.5 MB transcript turned into **2381 extraction units and
¥9.91 in one day** — roughly 20× the cost of the actual work conversation.

This project takes the opposite trade-off:

| | Typical memory backend | dsh-server-memory |
|---|---|---|
| Cost per session | LLM calls on every write and on every session start | **0** |
| When memory is written | continuously, automatically | **once a day**, by the agent's own model |
| Where memory lives | their cloud | **your** machine (SQLite file) |
| Recall | semantic + rerank + graph | FTS5 keyword search over Chinese bigrams |
| Precision | entity resolution, contradiction tracking | flat summary lines |

Roughly: **¥7/day → ~¥0.05/day**, at the cost of recall precision. If you want maximum precision and do not care about
cost, use a full-blown backend instead — this one is for people who want memory to be cheap, private and predictable.

## Architecture

```
┌─ DSH host (any OS) ─────────────────────────┐
│  dsh-server-memory plugin (ESM, zero npm deps)     │
│   ├─ systemPrompt.section: ≤900-char index  │
│   ├─ background cache: poll /api/context    │
│   ├─ tools: memory_search / save / forget / │
│   │         consolidate                     │
│   └─ reads local transcripts → digest       │
└──────────────────┬──────────────────────────┘
                   │ HTTP + bearer token
┌──────────────────▼──────────────────────────┐
│  memoryd (Python 3.9 stdlib, single file)   │
│   ├─ SQLite (WAL) + FTS5 (Chinese bigrams)  │
│   └─ REST: context / search / notes /       │
│            items / projects / watermark     │
└─────────────────────────────────────────────┘
```

**The server never calls an LLM.** It stores text, indexes it, and answers queries. All summarisation happens once a
day in the agent, driven by a per-project watermark.

## Layout

| Path | What |
|---|---|
| `plugin/` | The DSH plugin (ESM, no dependencies) — prompt index, tools, transcript digest |
| `server/` | `memoryd.py` (Python 3.9 stdlib), launchd/systemd units, backup script, tests |
| `scripts/smoke.mjs` | 14-check end-to-end test against a running service |
| `DESIGN.md` | Full design: data model, API, consolidation protocol, cost model, incidents |

> **This repo is a client + server pair.** The plugin does nothing on its own — it needs a memoryd service you run.
> If you are installing this for the first time, follow the [user guide](docs/USER-GUIDE.md) instead of the condensed
> steps below; it covers the two-machine case, token distribution and the mistakes people actually hit.

## Quick start

### 1. Server

```bash
git clone https://github.com/methpia/dsh-server-memory.git dsh-memory && cd dsh-memory/server
python3 memoryd.py --init-config      # writes ~/.config/dsh-memory/config.json + a random token
python3 memoryd.py --check            # sanity-check the database and schema
python3 memoryd.py                    # foreground; defaults to 127.0.0.1:8788
curl -s http://127.0.0.1:8788/health
```

`--init-config` prints the token once. Store it in a file (`chmod 600`) and hand that path to the plugin, or pass it
via `DSH_MEMORY_TOKEN`.

Keep it running:

```bash
# macOS
cp launchd/com.local.memoryd.plist ~/Library/LaunchAgents/    # edit the /Users/you paths first
launchctl load ~/Library/LaunchAgents/com.local.memoryd.plist

# Linux (systemd user unit)
cp systemd/dsh-memory.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now dsh-memory
```

Remote access, two options:

- **Private (recommended):** keep the service on `127.0.0.1` and put it on your tailnet.
- **Public VPS:** bind `0.0.0.0` **with TLS enabled** (`tls_cert` / `tls_key`), or keep it on loopback behind
  nginx/Caddy. See [public deployment](docs/PUBLIC-DEPLOYMENT.md) — a plain-HTTP public port is not supported.

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8788
# plugin serverUrl becomes https://<machine>.<tailnet>.ts.net:8443
```

### 2. Plugin

```bash
mkdir -p ~/.config/dsh-memory
printf '%s' '<token>' > ~/.config/dsh-memory/token && chmod 600 ~/.config/dsh-memory/token
```

Install in DSH, one of:

1. **Plugin market** — search for `dsh-server-memory`;
2. **Local checkout** — `plugin_manager` → `install_bundle` with `target` set to the absolute path of `plugin/`;
3. **Manual** — merge the insert row from `plugin/cordis.patch.yml` into your profile patch.

Override the endpoint in your profile patch (keyed by id):

```yaml
- id: dsh-server-memory
  config:
    serverUrl: http://127.0.0.1:8788
    tokenFile: ~/.config/dsh-memory/token
    defaultProject: default
    projectMap:
      D:\projects: workbuddy-tasks
```

After a restart you should see `## 项目记忆 (<project>)` in the system prompt and four `memory_*` tools.

### 3. Verify

```bash
python3 -m unittest discover -s server/tests -v        # 38 checks, Python 3.9+
cd plugin && node --test --experimental-test-isolation=none "tests/*.test.js"   # 88 checks, Node 22.15+/24
node scripts/smoke.mjs --url http://127.0.0.1:8788 --token-file ~/.config/dsh-memory/token   # 14 e2e checks
```

## How memory is written

1. **Nothing is written during normal work.** The plugin only reads.
2. `memory_save` writes when *you* ask ("remember this").
3. Once a day, on the first prompt, the plugin claims a consolidation slot (`POST /api/watermark/claim`). If claimed,
   it reads your local transcripts since the watermark, builds a bounded digest (≤8000 chars, ≤120 entries), and the
   **agent's own model** turns it into 5–15 lines tagged `[决策] [偏好] [风险] [经验]`.
4. Those lines go back through `memory_save`, and the watermark advances only to what was actually consumed — a long
   backlog is processed over several days, never all at once.

## HTTP API

All endpoints except `/health` require `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness, schema version, counts |
| GET | `/api/context?project=&max_chars=` | prompt index rows |
| GET | `/api/search?project=&q=` | FTS5 search (Chinese bigrams) |
| POST | `/api/notes` | batch write consolidated notes |
| POST | `/api/items` | single manual memory |
| DELETE | `/api/items/{id}` | delete one memory |
| GET/POST | `/api/watermark` | read / advance the watermark |
| POST | `/api/watermark/claim` | atomic "may I consolidate now?" |
| GET | `/api/projects` | project list with counts |

Text is capped at 4000 characters per item. **Never** submit a whole session transcript — see `DESIGN.md` §2.1.

## Security

The service holds your entire long-term memory and a bearer token. Defaults are conservative: bind `127.0.0.1`,
fails closed on a missing token, `chmod 600` on the token file. For a public host, enable TLS (`tls_cert`/`tls_key`)
or terminate it at a proxy — there is exactly one shared token, so HTTP on a public port means anyone on the path can
read every memory. Read [SECURITY.md](SECURITY.md) before exposing it
beyond your own machine.

## Known limitations

- **Keyword recall only.** No embeddings, so paraphrase-level matching is weak; the compact prompt index compensates.
- **No entity resolution or contradiction tracking.** Duplicates are avoided by the summariser's instructions, not by
  code.
- **Chinese-first.** The bigram index works for CJK and Latin text, but the summariser prompt is written in Chinese.
- **Not a code-intelligence backend.** No git history mining, no page taxonomy.

## License

MIT — see [LICENSE](LICENSE).
