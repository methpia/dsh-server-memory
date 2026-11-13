# dsh-server-memory · 自托管项目记忆

[English](README.md) · [设计文档](DESIGN.md) · [Design (EN, 关键节)](DESIGN.en.md) · [安全](SECURITY.md)

给 DeepSeek Harness（DSH）用的轻量长期记忆：

- **日常零 LLM 开销**：每轮只注入不超过 900 字符的紧凑索引，模型需要细节时才检索正文；
- **每天一次聚合**：按项目、按水位线增量，把上一阶段的工作流水压成 5–15 条记忆行，由 agent 自己的模型完成，服务端不调 LLM；
- **自托管在内网**：Python 3.9 标准库单文件服务，SQLite + FTS5，零 pip 依赖，一台 Mac mini 跑得动；
- **一个项目一个命名空间**：不做实体消解、知识图谱、代码索引，也不把原始会话写进库里。

完整设计与约束见 [DESIGN.md](DESIGN.md)（440 行，含事故约束、成本模型与验收标准）。

## 架构

```
┌─ Windows / 任意 DSH 宿主 ─────────────────────────────┐
│  dsh-server-memory 插件（ESM，零 npm 依赖）                   │
│   ├─ systemPrompt.section：注入 ≤900 字符记忆索引      │
│   ├─ 后台缓存：每 5 分钟拉一次 /api/context           │
│   ├─ tools：memory_search / save / forget /           │
│   │         consolidate                               │
│   └─ 读本地会话转录 → 生成聚合摘要任务                 │
└───────────────────┬───────────────────────────────────┘
                    │ HTTP + Bearer token
┌───────────────────▼───────────────────────────────────┐
│  memoryd.py（Python 3.9 标准库，单文件）               │
│   ├─ SQLite（WAL）+ FTS5（中文 bigram 索引）            │
│   └─ REST：context / search / notes / items /          │
│            projects / watermark / claim                │
└───────────────────────────────────────────────────────┘
```

关键取舍：

| 决策 | 原因 |
|---|---|
| 服务端不调用任何模型 | 一旦服务端持有 API key 并计费，就退回 Hindsight 的老路（DESIGN.md 8.3） |
| 索引只放“一行一条”，正文按需取 | 每轮注入全量记忆正是要解决的问题（DESIGN.md 7.2） |
| 中文按 bigram 建索引 | stdlib sqlite3 加载不了自定义 tokenizer，而 `unicode61` 会把整段汉字当一个 token（DESIGN.md 4.1） |
| 单条文本 ≤4000 字符、单批 ≤50 条、请求体 ≤1MB | 2026-11-13 单日 ¥9.91 的事故来自一篇 358 万字符转录（DESIGN.md 2.1） |
| 水位线只前进，claim 原子互斥 | 同一项目一天内重复进入不会重复聚合，失败也不会当天反复重试（DESIGN.md 8.1） |

## 目录结构

```
memory-plugin/
├── server/                     # Mac mini 上跑的 Python 服务
│   ├── memoryd.py              # 单文件服务：建表 / 检索 / 水位线 / 鉴权
│   ├── config.example.json
│   ├── launchd/                # 常驻与每日备份的 launchd 单元
│   ├── scripts/backup.sh       # sqlite3 .backup，保留 14 份
│   └── tests/test_memoryd.py   # 38 个 unittest（含中文检索、限额、claim）
├── plugin/                     # 装进 DSH 的 npm 包 `dsh-server-memory`
│   ├── index.js                # 注入 section + 注册工具
│   ├── lib/                    # 配置 / 客户端 / 缓存 / 项目识别 / 转录 / 摘要 / 工具
│   ├── locale/ icon.svg        # 插件市场展示元数据
│   ├── cordis.patch.yml        # bundle patch（一行 insert）
│   ├── tests/                  # 88 个 node:test
│   └── README.md               # 插件配置与工具说明
├── scripts/smoke.mjs           # 对运行中的服务做 14 项验收（DESIGN.md 12.1）
├── docs/STRUCTURE.md           # 模块职责、数据流、扩展点
├── .github/workflows/ci.yml    # Python 3.9/3.12 + Node 24 + 端到端冒烟
├── DESIGN.md                   # 设计稿（验收标准在第 12 节）
├── CHANGELOG.md
└── LICENSE (MIT)
```

## 快速开始

### 1. 服务端（Mac mini / Linux / Windows 均可）

```bash
git clone https://github.com/methpia/dsh-server-memory.git dsh-memory && cd dsh-memory/server
python3 memoryd.py --init-config          # 生成 ~/.config/dsh-memory/config.json 与随机 token
python3 memoryd.py --check                # 确认数据库与 schema 可用
python3 memoryd.py                        # 前台启动，默认 127.0.0.1:8788
curl -s http://127.0.0.1:8788/health
```

`--init-config` 打印的 token 交给插件：写到任意路径（建议 `chmod 600`），或用环境变量 `DSH_MEMORY_TOKEN`。

常驻与备份（macOS）：

```bash
cp launchd/com.local.memoryd.plist ~/Library/LaunchAgents/          # 先替换里面的 /Users/<你>
cp launchd/com.local.memoryd.backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.local.memoryd.plist
launchctl load ~/Library/LaunchAgents/com.local.memoryd.backup.plist
```

远程访问（Tailscale）：保持服务只监听 `127.0.0.1`，用反代暴露给 tailnet，不要直接 `0.0.0.0`：

```bash
tailscale serve --bg http://127.0.0.1:8788
# 之后插件 serverUrl 用 https://<machine>.<tailnet>.ts.net
```

### 2. 插件（DSH 宿主）

写 token 文件（默认位置）：

```bash
mkdir -p ~/.config/dsh-memory
printf '%s' '<token>' > ~/.config/dsh-memory/token && chmod 600 ~/.config/dsh-memory/token
```

三选一安装：

1. **插件市场**：搜索 `dsh-server-memory` 安装（包名 `dsh-server-memory`）；
2. **本地目录**：在 DSH 里用 `plugin_manager` 的 `install_bundle`，`target` 传本仓库 `plugin/` 的绝对路径；
3. **手动**：把 `plugin/cordis.patch.yml` 的 insert 行合并进 profile 的 `cordis.patch.yml`（不推荐，profile 文件归用户所有）。

最小配置（bundle patch；要覆盖时在 profile 的 `cordis.patch.yml` 里按 id `dsh-server-memory` 写 override）：

```yaml
- insert:
    - id: dsh-server-memory
      name: dsh-server-memory
      config:
        serverUrl: http://127.0.0.1:8788
        tokenFile: ~/.config/dsh-memory/token
        defaultProject: default
        projectMap: {}
```

装好后：系统提示出现 `## 项目记忆（<项目>）`，工具列表里出现 `memory_search` / `memory_save` / `memory_forget` / `memory_consolidate`。

### 3. 验收

```bash
# 服务端 38 项（Python 3.9+ 均可）
python3 -m unittest discover -s server/tests -v

# 插件 88 项（Node 22.15+ / 24）
cd plugin && node --test --experimental-test-isolation=none "tests/*.test.js"

# 对运行中的服务做 14 项端到端检查
node scripts/smoke.mjs --url http://127.0.0.1:8788 --token-file ~/.config/dsh-memory/token
```

本仓库交付时的实测结果、以及未覆盖的验证项，见下方「验证状态」。

## 插件配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:8788` | memoryd 地址；可带路径前缀 |
| `token` / `tokenFile` | 空文件 `~/.config/dsh-memory/token` | token 来源，二选一；也支持 `DSH_MEMORY_TOKEN` |
| `defaultProject` | `default` | 目录无法映射时的项目名 |
| `projectMap` | `{}` | 目录前缀 → 项目名，最长前缀优先（解决“每次新目录”问题） |
| `indexMaxItems` | `6` | 注入索引最多几条 |
| `indexMaxChars` | `900` | 注入索引硬上限 |
| `searchResults` / `searchMaxChars` | `8` / `4000` | 检索返回条数与字符上限 |
| `digestMaxChars` / `digestMaxEntries` | `8000` / `120` | 单次聚合的输入预算 |
| `maxBacklogDays` | `7` | 首次聚合最多回看几天（避免补不完） |
| `claimIntervalHours` | `24` | 两次聚合的最小间隔 |
| `consolidationEnabled` | `true` | 关闭后工具只提示“已关闭”，不发请求 |
| `sessionsRoot` | `~/.dsh/sessions` | 会话转录根目录 |
| `transcriptMaxBytes` / `transcriptMaxCharsPerEntry` | 8MB / 1200 | 单文件跳过阈值 / 单条截断长度 |
| `contextPollMs` | `300000` | 后台索引刷新间隔 |

配置在激活时做防御式归一化：非法值回退默认并写一条 warning，不会因为写错一个字段就装不上。
项目识别优先级：`projectMap` 最长前缀 → 最近的 git 仓库名 → 工作目录名 → `defaultProject`。服务端按需自动建 project 行。

## 工具

| 工具 | 语义 | 何时调用 |
|---|---|---|
| `memory_search` | 检索本项目记忆正文，返回 1–8 条 | 索引不够、需要历史决策细节时 |
| `memory_save` | 写入记忆；`text` 单条 manual，`notes[]` 批量，带 `consolidationId` 则推进水位线 | **仅用户说“记住”时**；或提交聚合结果 |
| `memory_forget` | 按 id 删除 | 用户要求删除时 |
| `memory_consolidate` | 检查聚合是否到期；到期返回待总结流水 `consolidationId` | 系统提示提示“记忆聚合已到期”或用户要求整理时 |

聚合闭环：`memory_consolidate` →（agent 自己的模型总结）→ `memory_save({ notes, consolidationId })` → 插件写库并推进水位线。中途放弃则水位线不动，`last_run_at` 已更新，当天不重复触发。

实现说明：插件没有“会话开始”钩子（只用 `tools` 与 `systemPrompt` 两个服务），到期提示写在索引末尾，由 agent 在合适时机发起；真正的幂等由服务端 `claim` 保证。手动保存走一次 `/api/notes`（`kind=manual`），批量 20 条也只发一个请求。

## HTTP API

除 `/health` 外全部要求 `Authorization: Bearer <token>`；错误统一 `{"error":{"code","message"}}`；时间一律 ISO 8601 UTC（`Z`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok,version,schema,projects,items,time}`，无需鉴权 |
| GET | `/api/context?project=&limit=&max_chars=` | 索引数据：items + total + watermark + consolidation.due |
| GET | `/api/search?project=&q=&limit=` | FTS5 检索，失败降级 LIKE；按 bm25+新近度+kind 排序 |
| POST | `/api/notes` | 批量摘要（≤50 条，单条 ≤4000 字符） |
| POST | `/api/items` | 单条手工记忆（kind=manual） |
| DELETE | `/api/items/{id}` | 删除一条 |
| GET/POST | `/api/watermark` | 读 / 推进水位线（只前进） |
| POST | `/api/watermark/claim` | 原子占位 `{min_interval_hours}`；`claimed=false` 时 agent 什么都不做 |
| GET | `/api/projects` | 项目列表与条数 |

## 验证状态

交付时实测：

- 服务端 38/38 unittest（含中文 `日结`/`结算` 召回、413 限额、claim 幂等、水位线不回退、错误响应关闭连接）。
- 插件 88/88 node:test（含逐帧 zstd 解析、转录过滤、摘要预算、prompt 注入防串段、缓存失败保留旧数据）。
- `scripts/smoke.mjs` 对真实进程 14/14（健康检查、鉴权失败、写入、上下文预算、中文检索、claim、删除）。
- 真实 DSH 转录解析：11 个会话 / 182 条流水 / 990ms，超出预算时正确降级为“只送最早的 N 条”，7 天窗口外的流水被标记跳过。
- 插件装进 desktop profile 后：系统提示出现 `## 项目记忆（dsh）`，4 个工具注册成功，检索走真实服务返回正文。

未覆盖：聚合的“模型产出”环节没有在验收环境里跑完整闭环（`consolidate → 模型总结 → save` 的后半段由单测与 HTTP 检验覆盖），真实记忆质量需要跑两周再看；插件市场页面的渲染效果未验证。

## 发布

**GitHub**：把 `package.json` 的 `repository` / `homepage` / `bugs` 里的 `your-name` 换成实际地址，然后：

```bash
git init && git add . && git commit -m "feat: initial dsh-memory"
git remote add origin git@github.com:<you>/dsh-memory.git && git push -u origin main
```

**npm / dsh 插件市场**：插件是 `plugin/` 下的独立包，`files` 已裁剪到运行时文件（19 项、约 25KB）：

```bash
cd plugin
npm test            # 88 项 node:test
npm pack --dry-run  # 确认打包内容只含 index.js/lib/locale/icon/patch
npm publish --access public
```

市场审阅需要 `package.json` 的 `dsh.bundle.patch`、`locale/{en,zh}.json` 的 `meta.title/description`、`icon.svg`（三者已就位，图标按 256/64/32px 实渲染检查过）。发布前确认 `version` 递增并更新 [CHANGELOG.md](CHANGELOG.md)。

## 安全

- 服务端默认只监听 `127.0.0.1`；远程一律走 `tailscale serve`，不要暴露公网。
- token 只从配置文件 / token 文件 / 环境变量读取，不写进日志、不写进仓库；`hmac.compare_digest` 常量时间比较。
- 请求体 ≤1MB、单条文本 ≤4000 字符、单批 ≤50 条，超限在服务端返回 413（不依赖客户端自律）；超限请求体会先排空再响应，避免客户端看到连接重置。
- `journal` 类型默认拒绝写入：库里只留摘要，原始流水只在聚合时从本地转录临时读取。
- 记忆正文按“数据”处理：注入系统提示前压成单行，不能伪造新的 prompt 段落。

## 已知限制

- 首次聚合按“最早优先”推进，积压多时会分几天补完（这是水位线不跳过的代价，`maxBacklogDays` 控制回看上限）。
- 中文召回依赖 bigram 精确匹配，同义词不会自动扩展；索引注入 + 模型判断是否检索是主要补偿手段。
- 不支持实体消解、矛盾检测、跨项目融合：一个项目一个命名空间。
- 与 `@local/user-memory` 并存时会同时注入两段记忆索引；迁移完成后建议只留一个。
- 插件读取 DSH 会话格式 `session.v4.jsonl.zstd`；格式不认识就跳过并记日志，不影响其他功能。

## License

MIT，见 [LICENSE](LICENSE)。
