# dsh-server-memory (plugin)

Project-scoped long-term memory for DeepSeek Harness.

The plugin talks to a self-hosted [`memoryd`](../server/memoryd.py) service 鈥?a single-file Python 3.9 stdlib server 鈥?and contributes:

- a **compact memory index** in the system prompt (hard-capped at 900 characters by default), filled by a background cache so prompt assembly never waits on the network;
- five tools: `memory_search`, `memory_save`, `memory_projects`, `memory_forget`, `memory_consolidate`;
- a **once-a-day consolidation hand-off**: the plugin reads local DSH transcripts and returns a bounded digest, the agent's own model summarises it, and the plugin writes the result back and advances the watermark.

It keeps no local database, so every client that talks to the same service sees the same memory.

## A service is required

The plugin is a client. With no reachable `memoryd` it installs, activates and then does nothing visible, so it says
so: the prompt index carries one line, tool failures end with "call `memory_setup`", and the settings page offers the
steps. This package ships the server too (`server/memoryd.py`, Python 3.9 stdlib, no dependencies):

```bash
python3 server/memoryd.py --init-config --config ~/.config/dsh-memory/config.json   # prints the token
python3 server/memoryd.py --config ~/.config/dsh-memory/config.json                 # serves 127.0.0.1:8788
printf '%s' 'mem_xxx' > ~/.config/dsh-memory/token && chmod 600 ~/.config/dsh-memory/token
```

Ask the agent to run `memory_setup`, or open Settings → Built-in plugins → Project memory → **No memory service yet?**
for the same steps, tailored to the configured URL. Running it on another machine? Set its `host` to `0.0.0.0`, allow
8788 only on a trusted network, and point this plugin at it with `DSH_MEMORY_SERVER_URL`.

## Install

**From the plugin market** 鈥?search for `dsh-server-memory`.

**From a local checkout** 鈥?with the package directory as target:

```text
plugin_manager install_bundle { "target": "<repo>/dsh-server-memory" }
```

**Manually** 鈥?merge the insert row from `cordis.patch.yml` into your profile patch (the profile file belongs to you; prefer one of the paths above).

## Configure

The package installs with **no** `config` block: every field falls back to the documented default, so an install can be pointed at your own service without editing the package.

Environment fallbacks, read when the row leaves the field empty:

```bash
export DSH_MEMORY_SERVER_URL=http://192.168.5.5:8788    # LAN box, VPS or Tailscale host
export DSH_MEMORY_TOKEN_FILE=~/.config/dsh-memory/token
```

Row override in your profile patch, when the value belongs to this profile rather than the machine:

```yaml
- id: dsh-server-memory
  name: dsh-server-memory
  config:
    serverUrl: http://192.168.5.5:8788
    tokenFile: ~/.config/dsh-memory/token
    defaultProject: default
```

Row config wins over the environment fallback. Settings -> Built-in plugins -> **Project memory** writes the same values for you and can test the connection.

The token comes from `token`, `tokenFile`, or `DSH_MEMORY_TOKEN`, in that order. Keep it out of the profile patch when you can.

| Field | Default | Purpose |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:8788` or `DSH_MEMORY_SERVER_URL` | memoryd base URL |
| `token` / `tokenFile` | none / `~/.config/dsh-memory/token` (`DSH_MEMORY_TOKEN_FILE`) | bearer token source |
| `defaultProject` | `default` | fallback project id |
| `projectMap` | `{}` | directory prefix 鈫?project id; longest prefix wins |
| `indexMaxItems` | `6` | rows injected into the prompt |
| `indexMaxChars` | `900` | hard prompt budget |
| `searchResults` / `searchMaxChars` | `8` / `4000` | search shape |
| `digestMaxChars` / `digestMaxEntries` | `8000` / `120` | consolidation input budget |
| `maxBacklogDays` | `7` | how far a first consolidation may reach back |
| `claimIntervalHours` | `24` | minimum hours between runs |
| `consolidationEnabled` | `true` | turn the daily flow off without uninstalling |
| `sessionsRoot` | `~/.dsh/sessions` | DSH transcript root |
| `transcriptMaxBytes` / `transcriptMaxCharsPerEntry` | `8388608` / `1200` | per-file skip / per-entry clamp |
| `contextPollMs` | `300000` | cache refresh interval |

Project resolution order: longest `projectMap` prefix 鈫?enclosing git repository name 鈫?working directory name 鈫?`defaultProject`.

## Tools

| Tool | Use |
|---|---|
| `memory_search` | search this project's memory bodies when the index is not enough |
| `memory_save` | write only when the user asked to remember; also commits consolidation batches |
| `memory_projects` | list, create or rename projects and set their aliases |
| `memory_forget` | delete one memory by id |
| `memory_consolidate` | check the daily window; returns a digest and a `consolidationId` |
| `memory_setup` | print the deploy/configure steps for this machine and the current connection state |

`memory_consolidate` never writes memory itself: it claims the window, returns the digest, and the model must submit results with `memory_save({ notes, consolidationId })`. If the model abandons the task, the watermark does not move and the next window retries; `claim` keeps the same day from retrying repeatedly.

## Failure behaviour

- Service down at startup: activation succeeds, the prompt section is empty, tools fail with an explicit error, conversation continues.
- Service down later: the last good index is kept and marked stale rather than emptied.
- Unknown transcript format or oversized file: skipped with a logged warning; other sessions still consolidate.
- Missing token: tools report `no-token`; the activation warning appears only when `token`, `tokenFile` and `DSH_MEMORY_TOKEN` are all empty.
- Service never reached: the prompt index says so in one line and every tool failure ends with a pointer to `memory_setup`.

## Settings page

Settings → Built-in plugins → **Project memory** adds a page with:

- service URL, token file and default project (saved through the host config editor; the plugin restarts);
- prompt-index row/character budgets, consolidation interval and on/off;
- **Test connection** (live health + counts) and **Load projects**;
- a **new project** row (id, label, aliases) that creates a library immediately — the same call the
  `memory_projects` tool makes;
- inline project label/alias editing — aliases are what let a conversation address a project by name
  (the server stores them, so DSH and WorkBuddy share the same table).

All reads and writes go through the host's authenticated `/api/dsh-server-memory` route; the bearer token never reaches
the browser.

## WorkBuddy

WorkBuddy support lives in the repository's top-level `workbuddy/` folder and is **not** part of this npm package. See
[docs/WORKBUDDY.md](https://github.com/methpia/dsh-server-memory/blob/main/docs/WORKBUDDY.md).

## Requirements

Node 22.15+ / 24 (the transcript reader uses `zlib.zstdDecompressSync`). No npm dependencies.

## Verify

```bash
node --test --experimental-test-isolation=none "tests/*.test.js"   # 125 tests
```

## License

MIT.

