# User guide

This plugin is **not self-contained**: the prompt index, the tools and the daily consolidation all talk to a small
`memoryd` service that you run yourself. This guide is the "I downloaded the repo, now what?" path.

If you only read one section, read **[Two ways to run it](#two-ways-to-run-it)** and **[Step 5: point the plugin at
your server](#step-5-point-the-plugin-at-your-server)** — those are where people get stuck.

---

## What you need

| Piece | Requirement | Notes |
|---|---|---|
| Server host | Python **3.9+**, no third-party packages | any machine you control: laptop, NAS, Mac mini, small VPS |
| Client host | DeepSeek Harness with bundle support, Node **22.15+** | the machine where you actually chat |
| Network | client → server over HTTP(S) | localhost, LAN, or a tailnet; **not** the public internet |

The server is tiny (one file, SQLite). A Raspberry Pi would do. It does **not** call any LLM, so it needs no API key
and no GPU.

## Two ways to run it

**A. Everything on one machine** — simplest, good for a first try. Server and DSH on the same computer; the server
binds `127.0.0.1`, nothing leaves the host.

**B. Server on one box, clients everywhere** — the intended setup. The server binds your LAN or tailnet address; every
machine that chats holds a copy of the token file and points `serverUrl` at it. Memory is shared across all of them.

Both start the same way; B just adds a bind address and a reachable URL.

---

## Step 1: get the server running

```bash
git clone https://github.com/methpia/dsh-server-memory.git
cd dsh-server-memory/server

python3 memoryd.py --init-config       # writes ~/.config/dsh-memory/config.json with a random token
python3 memoryd.py --check             # opens the DB, prints counts — works before any token exists
python3 memoryd.py                     # foreground; 127.0.0.1:8788 by default
```

`--init-config` prints the token **once** and refuses to overwrite an existing config. Save the token — you will need
it on every client.

Check it from another terminal:

```bash
curl -s http://127.0.0.1:8788/health
# {"ok":true,"service":"memoryd","version":1,"schema":1,"projects":0,"items":0,"time":"..."}
```

`/health` is the only unauthenticated endpoint. Everything else returns `401` without the token — that is intentional.

> **Windows:** the same three commands work in PowerShell. `~` expands, paths use backslashes.

## Step 2: keep it running

Foreground is fine for a first test. For daily use, install it as a service.

**macOS (launchd)**

```bash
# edit the /Users/you paths inside the plist first
cp launchd/com.local.memoryd.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.local.memoryd.plist
tail -f ~/Library/Logs/dsh-memory.log
```

**Linux (systemd user unit)**

```bash
cp systemd/dsh-memory.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh-memory
journalctl --user -u dsh-memory -f
```

**Docker (any OS, including macOS)**

```bash
cd server/docker
cp .env.example .env            # BIND_ADDR: 127.0.0.1, a LAN IP, or 0.0.0.0 with TLS
docker compose up -d --build
docker compose ps               # wait for "healthy"
```

The database stays on the host at `~/dsh-memory/data` (bind mount) and the config at `~/.config/dsh-memory`
(mounted read-only, so the token is never in the image). The base image comes from ghcr, not Docker Hub.
Details, including how to switch an existing launchd install over: [server/README.md](../server/README.md#docker).
**Windows:** no unit file is shipped; use Task Scheduler ("At log on", `python memoryd.py`) or NSSM. Keep the console
open if you are just trying it out.

## Step 3: make it reachable (only for setup B)

By default the server binds `127.0.0.1`, which only accepts local connections. To let other machines talk to it,
either bind a LAN address or put it on a tailnet.

**LAN (same subnet only)**

Edit `~/.config/dsh-memory/config.json`:

```json
{ "host": "192.168.1.10", "port": 8788 }
```

Restart the service. Then confirm from the client machine:

```bash
curl -s http://192.168.1.10:8788/health
```

**Tailnet (works from anywhere, still private)**

Keep the server on `127.0.0.1` and proxy it with Tailscale — this gives you TLS and tailnet ACLs for free:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8788
# clients then use https://<machine>.<tailnet>.ts.net:8443
```

> Never expose this service to the public internet. `/api` has exactly one credential; there is no rate limiting and
> no account system. Use a tailnet or a VPN.

## Step 4: install the plugin

The plugin needs the repo on disk (it is not published to npm). Clone it on the **client** machine, then pick one:

**From DSH (recommended)** — run the plugin manager and point `target` at the `plugin/` directory:

```text
plugin_manager install_bundle { "target": "/absolute/path/to/dsh-server-memory/plugin" }
```

**Manually** — merge the insert row from `plugin/cordis.patch.yml` into your profile's `cordis.patch.yml`. Your profile
patch belongs to you, so prefer the plugin manager when it works.

After installing, restart DSH. The tool list should show `memory_search`, `memory_save`, `memory_forget`,
`memory_consolidate`, and the system prompt should contain a `## 项目记忆 (<project>)` section (empty until the first
consolidation).

## Step 5: point the plugin at your server

The plugin reads its config from the bundle row. Override it by **id** in your profile patch
(`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: dsh-server-memory
  config:
    serverUrl: http://192.168.1.10:8788      # or https://<machine>.<tailnet>.ts.net:8443
    tokenFile: ~/.config/dsh-memory/token
    defaultProject: default
    projectMap:
      /home/me/work: work
```

Then create the token file **on the client** — copy the token printed by `--init-config`:

```bash
mkdir -p ~/.config/dsh-memory
printf '%s' '<the-token>' > ~/.config/dsh-memory/token
chmod 600 ~/.config/dsh-memory/token
```

Windows: put the same content in `%USERPROFILE%\.config\dsh-memory\token`.

**Common mistakes, in order of frequency:**

1. `host` still `127.0.0.1` on the server while the client is another machine → connection refused.
2. Token file has a trailing newline from `echo` → use `printf '%s'` as above.
3. Profile patch uses the wrong `id` → no config is applied and the plugin silently uses `127.0.0.1:8788`.
4. Firewall blocks 8788 on the server host.

`token` / `tokenFile` / `DSH_MEMORY_TOKEN` are checked in that order; a file is safer than inlining it in YAML.

## Step 5b: or configure it from the settings page

Editing YAML is not the only way. The plugin adds a page at **Settings → Built-in plugins → Project memory**:

- service URL, token file, default project;
- prompt-index row/character budgets, consolidation interval and on/off;
- **Test connection** (live health and counts) and **Load projects**;
- inline editing of project labels and aliases (see the next section).

Two behaviours worth knowing:

- **Saving settings** goes through the host's config editor and **restarts the plugin** — the page and tools reload with
  the new values.
- **Project edits apply immediately** (they are written to the server, not to the plugin config).

The bearer token never reaches the browser: the page talks to an authenticated host route (`/api/dsh-server-memory`),
and that route holds the token.

## Addressing a project by name

A project normally comes from the working directory. That fails in agents that create a fresh dated directory for every
conversation (WorkBuddy does exactly this), and it is inconvenient when you just want to say "车易到" and get its
memory.

The server therefore stores a **label** and a list of **aliases** per project (schema v2):

```bash
node scripts/projects.mjs list
node scripts/projects.mjs set cheyidao --label 车易到 --aliases 车易到,cheyidao,汽修管理
node scripts/projects.mjs resolve 车易到的结算模块改了什么
```

Resolution (`GET /api/resolve?q=`) scores the text against labels and aliases: the longest match wins, ties fall back
to the larger project. The same table drives the settings page and the WorkBuddy adapter, so a name you add anywhere is
visible everywhere.

## WorkBuddy (optional)

WorkBuddy speaks a different protocol (stdio MCP + two hooks), so it ships as a separate adapter in `workbuddy/` and is
**not** part of the npm package:

```bash
node workbuddy/install.mjs --url http://192.168.1.10:8788 --token-file ~/.config/dsh-memory/token          # preview
node workbuddy/install.mjs --apply --url http://192.168.1.10:8788 --token-file ~/.config/dsh-memory/token   # write
```

The installer backs up `mcp.json` / `settings.json` first, adds one MCP server and two hooks, and leaves Hindsight
untouched. Full details: [WORKBUDDY.md](WORKBUDDY.md).
## Step 6: verify end to end

In DSH:

```
记住：我用 pnpm，不喜欢 npm。
```

The agent should call `memory_save`. Then in a **new** session ask something like "我用什么包管理器？" — if
`## 项目记忆` shows the line, the round trip works.

From the server side:

```bash
python3 memoryd.py --check
# projects: 1  items: 1
```

## How memory actually behaves

- **Nothing is written while you work.** The plugin only reads; no background LLM cost.
- `memory_save` writes when *you* ask the agent to remember something.
- **Once a day**, on the first message of a session, the plugin claims a consolidation slot, reads your local DSH
  transcripts since the last run, and hands the agent a bounded digest. The agent turns it into 5–15
  `[决策]/[偏好]/[风险]/[经验]` lines, which are saved and the watermark advances.
- A long backlog is processed over several days, never in one huge call. If nothing is worth keeping, the agent
  writes no notes and the watermark still advances.
- **If the server is down**, the plugin degrades: empty index, tools return a clear error, normal work is unaffected.

To force a consolidation right now, ask the agent to "整理一下记忆" — it calls `memory_consolidate`; if the 24-hour
claim window has not passed the server refuses with `too_soon` and tells you when it will allow it.

## Maintenance

```bash
# backup (macOS/Linux)
cp ~/dsh-memory/data/memory.db ~/dsh-memory-backups/memory-$(date +%F).db

# restore
systemctl --user stop dsh-memory   # or launchctl stop
cp ~/dsh-memory-backups/memory-2026-11-13.db ~/dsh-memory/data/memory.db
systemctl --user start dsh-memory

# rotate the token (there is no --force; --init-config refuses to overwrite)
mv ~/.config/dsh-memory/config.json ~/.config/dsh-memory/config.json.bak
python3 memoryd.py --init-config
# ^ writes a fresh config with host 127.0.0.1 — re-apply custom host/port if you changed them
# then update every client's token file and restart the service
```

Upgrade: `git pull`, restart the service, restart DSH. The schema has a single version and migrates on open; take a
backup first anyway.

Uninstall: remove the plugin with the plugin manager (or delete the patch row), and stop/delete the service. The
database is one file — delete it if you want the memory gone.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tools return "记忆服务不可达" | wrong `serverUrl`, server down, or firewall | `curl <serverUrl>/health` from the client host |
| `401 unauthorized` | token file empty, wrong, or has a newline | `printf '%s'` when writing it |
| Prompt section missing entirely | plugin not loaded, or patch row id mismatch | restart DSH; check the tool list |
| `## 项目记忆` present but empty | no notes yet | ask the agent to remember something, or wait for the first consolidation |
| `too_soon` on manual consolidation | 24-hour claim window | wait, or lower `min_claim_interval_hours` in the server config |
| `Address already in use` | another process on 8788 | change `port` in the config |
| Consolidation produced nothing | no transcripts newer than the watermark | check `sessionsRoot` — on Windows it is `%USERPROFILE%\.dsh\sessions` |

## Notes for people evaluating this

- Recall is **keyword only** (FTS5 over CJK bigrams). There are no embeddings: paraphrases can be missed. The compact
  prompt index exists to compensate.
- The summariser prompt is **Chinese**; summaries will be Chinese regardless of your conversation language.
- One project = one namespace, derived from `projectMap` → git repo name → directory name.
- This is not a replacement for a code-intelligence memory backend. It is for "what did we decide, what does the user
  prefer, what bit us last time".
