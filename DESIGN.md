# 自建轻量记忆系统 · 设计稿

> 给实现 agent 的说明：本文是完整设计，不含未定项。所有"必须"都是经过验证的约束，
> 所有"可选"才允许调用方决定。实现完成后按第 12 节验收。

## 1. 目标与非目标

### 目标

1. **零 LLM 的日常开销**：日常会话只做「读记忆」和「记流水」，不调用任何大模型。
2. **每天一次聚合**：按项目、按水位线增量，把上一阶段的工作流水压成摘要行，由 agent 侧模型完成。
3. **自托管在内网**：服务跑在 Mac mini（192.168.1.10），经 Tailscale 供外网设备访问。
4. **可定制**：数据结构、召回排序、聚合规则都是我们自己的代码。
5. **可控成本**：聚合单次约 8k input / 1k output，折合每天几分钱。

### 非目标（明确不做）

- 不做代码仓语义索引、不做 git 历史挖掘（Hindsight 那套的代码智能，我们不需要）。
- 不做实体消解、知识图谱、矛盾检测。
- 不做实时写入记忆（agent 不经用户同意不写长期记忆）。
- 不追求跨项目记忆融合：一个项目一个独立命名空间。

## 2. 已验证的环境约束（不要假设，按这个写）

| 约束 | 实测值 | 影响 |
|---|---|---|
| Mac mini | arm64 / macOS 15.8.1 / 16GB | — |
| Docker Hub | **不可达**（`registry-1.docker.io` 超时） | 不能拉新基础镜像，服务不要用新容器 |
| ghcr.io | 可达 | 仅在必要时用已有镜像 |
| Mac 上的 Node | **没有** | 服务端不能用 Node |
| Mac 上的 Python | **3.9.6**（`/usr/bin/python3`） | 只能用标准库 + py3.9 语法 |
| SQLite FTS5 | **可用**（sqlite 3.43.2） | 全文检索零依赖 |
| 端口 8888 | 被 Hindsight 占用 | 新服务用 **8788** |
| Tailscale | `100.119.203.50` / `mac-mini.example-tailnet.ts.net` | 远程访问走 serve |
| DSH 运行环境 | Windows（`D:\dsh`），Node 24 | 插件侧可以随便用现代 JS |

**结论：服务端用 Python 3.9 标准库（`http.server` + `sqlite3` + `json`），单文件、零 pip 依赖。**
不要引入 FastAPI/uvicorn/torch——装不上，也没有必要。

## 2.1 事故约束（来自 2026-11-13 的实测事故）

旧系统在 11-13 单日产生 **¥9.91** 的记忆费用（正常对话 ¥0.46），根因是一篇
**3,577,983 字符**的会话转录被当作一条文档 retain，切块后抽出 **2381 个 unit**，
按 `retain_batch_tokens≈10000` 拆成数百次 LLM 调用。

因此本设计必须遵守：

1. **单条文档上限 200KB**，超过必须拒绝或切片，绝不允许整段会话直接入库；
2. **会话流水永不入记忆库**（本设计的 journal 只临时读、不落库）；
3. 聚合输入有独立的 8000 字符预算，与转录长度无关；
4. 任何"把对话写回服务端"的能力，默认关闭，且需要显式开关。

实现时请把第 1 条写成服务端硬校验（`/api/notes` 与 `/api/items` 都对 text 长度做上限），
不要只依赖客户端自律。

## 3. 架构

```
┌─ Windows（DSH 宿主）─────────────────────┐
│  dsh-server-memory 插件（JS，零依赖）            │
│   ├─ systemPrompt.section：注入记忆索引    │
│   ├─ tools：search / save / forget /     │
│   │        consolidate                    │
│   └─ 读本地会话转录 → 生成聚合摘要         │
└───────────────┬───────────────────────────┘
                │ HTTP（LAN 或 Tailscale，Bearer token）
┌───────────────▼───────────────────────────┐
│  Mac mini · memoryd.py（Python 3.9 stdlib）│
│   ├─ SQLite（WAL）+ FTS5（中文 bigram）    │
│   └─ REST：notes / search / context /     │
│            watermark                      │
└────────────────────────────────────────────┘
```

要点：

- **服务端永远不调用 LLM**。它只存文本、建索引、返回检索结果。
- **摘要由 agent 侧模型生成**，通过插件工具交回服务端。
- 插件不维护本地数据库（避免 DSH 与 WorkBuddy 双份数据），但**可以**读本地转录文件。

## 4. 数据模型

```sql
PRAGMA journal_mode=WAL;

-- 项目命名空间。project 由调用方给出，服务端不推断。
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,            -- 例如 "demo-project" / "dsh"
  label       TEXT NOT NULL DEFAULT '',    -- 人类可读名
  created_at  TEXT NOT NULL,               -- ISO8601 UTC
  last_seen_at TEXT NOT NULL
);

-- 记忆条目。kind 决定注入权重与展示方式。
CREATE TABLE items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('note','journal','manual')),
  -- note：日聚合产出的摘要行；journal：原始流水（可选，默认不存）；
  -- manual：用户显式要求记录的内容
  text        TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '',    -- 逗号分隔，小写
  source      TEXT NOT NULL DEFAULT '',    -- "consolidate" / "manual" / "session:<id>"
  created_at  TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT ''     -- 预处理后的检索文本（见 4.1）
);

CREATE INDEX idx_items_project_kind ON items(project, kind, created_at DESC);

-- 中文友好的全文索引：对 search_text 建 FTS5
CREATE VIRTUAL TABLE items_fts USING fts5(
  search_text,
  content='items',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- 触发器保持 FTS 同步
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
END;
CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
  INSERT INTO items_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;

-- 每项目的水位线：上次聚合到哪里
CREATE TABLE watermark (
  project           TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_consolidated TEXT NOT NULL,   -- ISO8601，聚合覆盖到的时间点
  last_run_at       TEXT NOT NULL,   -- 上次真正跑聚合的时间（含失败）
  last_status       TEXT NOT NULL DEFAULT 'ok',  -- ok / empty / failed
  last_error        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);  -- schema_version 等
```

### 4.1 search_text 的生成规则（中文检索的关键）

`unicode61` 会把连续汉字当成一个巨大 token，中文检索会失效。解决办法是**入库前把中文切成二元组**：

```python
CJK = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')

def build_search_text(text: str) -> str:
    # 1. 拉丁词/数字原样保留（小写）
    # 2. 连续 CJK 片段切成重叠二元组： "缓存设计" -> "缓存 存设 设计"
    # 3. 单字 CJK 保留单字
    # 4. 全部用空格连接
```

检索时对 query 做**同样的**转换，再用 FTS5 的 `MATCH` 查询。
不要写自定义 tokenizer 扩展——py3.9 标准库拿不到。

## 5. 检索与排序

```sql
SELECT i.id, i.text, i.kind, i.created_at, bm25(items_fts) AS rank
FROM items_fts JOIN items i ON i.id = items_fts.rowid
WHERE items_fts MATCH ? AND i.project = ?
ORDER BY rank LIMIT ?
```

最终打分（在 Python 里合并，不要塞进 SQL）：

```
score = w_bm25 * (1 / (1 + bm25))          # bm25 越小越好，归一化
      + w_recency * exp(-age_days / 30)    # 30 天半衰
      + w_kind * kind_weight               # note=1.0, manual=1.2, journal=0.4
```

默认 `w_bm25=1.0, w_recency=0.35, w_kind=0.25`。这些常数写进配置，不要硬编码在逻辑里。

**检索失败要降级**：FTS 语法错误 / 无结果时，回退到 `LIKE '%q%'` 扫描（本项目数据量小，几千条以内可接受）。

## 6. 服务端接口

统一前缀 `/api`。鉴权：`Authorization: Bearer <token>`，token 来自服务端配置文件。
**除 `/health` 外所有端点都必须校验 token**（Hindsight 那套没鉴权的教训不要重演）。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/health` | — | `{"ok":true,"version":1,"projects":N,"items":N}` |
| GET | `/api/context?project=&limit=&max_chars=` | — | `{"items":[{id,kind,text,created_at}],"watermark":{...}}` |
| GET | `/api/search?project=&q=&limit=` | — | 同上结构 |
| POST | `/api/notes` | `{"project":"demo-project","notes":[{"text":"...","tags":["结算"]}]}` | `{"stored":N,"ids":[...]}` |
| POST | `/api/items` | 单条 manual 写入 `{"project","text","tags"}` | `{"id":N}` |
| DELETE | `/api/items/{id}` | — | `{"deleted":true}` |
| GET | `/api/watermark?project=` | — | `{"last_consolidated":...,"last_status":...}` |
| POST | `/api/watermark` | `{"project","last_consolidated","status","error?"}` | `{"ok":true}` |
| GET | `/api/projects` | — | `{"projects":[{id,label,items,last_note_at}]}` |

约定：

- 所有时间 ISO8601 UTC 带 `Z`；服务端不做时区换算。
- `project` 由客户端给，服务端**按需自动建 project 行**（不要 404）。
- 响应体一律 UTF-8 JSON；错误统一 `{"error":{"code":"...","message":"..."}}`。
- 单条 `text` 上限 4000 字符，`/api/notes` 单次最多 50 条，超出返回 413。
- `/api/context` 的 `max_chars` 默认 1500，用于直接拼进系统提示。

## 7. DSH 插件（客户端）

### 7.1 形态

沿用 `user-memory` 的形态（零依赖、单插件目录、可被 `plugin_manager` 装进 profile）：

```
dsh-memory/
  package.json          # name: @local/dsh-memory, 无 dependencies
  cordis.patch.yml      # insert 一行插件
  index.js              # 宿主逻辑：注入 + 工具 + 可选 HTTP 页
  client.js             # 可选：设置页（V1 可以不做）
  config.example.json
```

核心 API 用法（照抄 user-memory 的模式，这是验证过的）：

```js
export const name = 'dsh-server-memory'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  ctx.tools.register({ name, description, parameters, handler })
  ctx.systemPrompt.section({ name: 'dsh-memory:index', order: 1200, text: () => '...' })
}
```

`systemPrompt.section` 的 `text` 可以是**函数**，每轮调用。注入内容必须**异步预取并缓存**——
不要在 `text()` 里同步发 HTTP，那会阻塞每轮对话。做法：后台定时任务每 5 分钟拉一次
`/api/context`，缓存进内存；`text()` 只读缓存。启动时若缓存为空，返回空字符串，不要等网络。

### 7.2 注入策略（省 token 的核心）

系统提示里放**紧凑索引**，不放正文：

```
## 项目记忆（demo-project）
最近更新：2026-11-13 09:20
- [决策] 结算模块改为按日结，不再月结
- [风险] 跨月订单佣金计算会出现一天空档
- [偏好] 对账页面优先展示当日汇总
（共 7 条，用 memory_search 取详情）
```

硬限制：`indexMaxChars` 默认 **900**，`indexMaxItems` 默认 **6**，超了截断。置顶项（`manual`）优先。
**不要**把这套做成"每轮注入全量记忆"——那是我们现在要解决的问题。

### 7.3 工具

| 工具 | 语义 | 何时调用 |
|---|---|---|
| `memory_search` | 按 query 检索本项目记忆，返回 1–8 条正文 | agent 觉得索引不够时 |
| `memory_save` | 用户明确要求记住时写入（kind=manual） | **仅用户主动要求** |
| `memory_forget` | 按 id 删除 | 用户要求 |
| `memory_consolidate` | 无参数；读转录、返回待总结的 digest 和指令 | 系统提示要求时（见 8） |

`memory_save` 的 description 必须写明：**不要主动记录，只有用户说"记住"才写**。

### 7.4 项目识别

`project` 取值优先级：

1. 插件配置里的 `projectMap`（路径前缀 → 项目名，最长前缀匹配）；
2. 当前工作目录的 git 仓库名；
3. 当前工作目录 basename；
4. 兜底 `default`。

配置示例（解决 WorkBuddy 每次新目录的问题）：

```json
{
  "projectMap": {
    "D:\\projects": "workbuddy-tasks",
    "D:\\dev": "dsh"
  }
}
```

## 8. 聚合协议（这是整套设计的核心）

### 8.1 触发条件

在**每个会话的第一个用户消息到达时**检查一次（不是每轮）：

```
watermark = GET /api/watermark?project=P
if now - watermark.last_consolidated < 24h  -> 跳过
if 本地转录里 since watermark 没有新内容      -> 直接 POST watermark 推进，跳过
否则 -> 进入聚合流程
```

判定必须**幂等**：同一项目一天内重复进入不应该重复聚合；用 `last_run_at` 做互斥，
或者服务端提供一个原子的 "claim" 语义（更稳，见下）。

服务端建议提供：

```
POST /api/watermark/claim  {"project": P, "min_interval_hours": 24}
-> {"claimed": true, "since": "2026-11-12T09:00:00Z"}   // 原子地把 last_run_at 置为 now
-> {"claimed": false, "reason": "too_soon", "next_at": "..."}
```

**claimed=false 时 agent 什么都不做。**

### 8.2 聚合执行

`memory_consolidate` 工具被 agent 调用时：

1. 调 `claim`；拿不到就返回"无需聚合"。
2. 读本地转录（DSH：`~/.dsh/sessions/**`；WorkBuddy：`~/.workbuddy/projects/**`），
   取 `since` 之后、属于本项目工作目录的记录。
3. 抽取 `user` 消息 + `assistant` 的**最终答复**（跳过工具调用参数、thinking、代码块全文，
   代码块超过 20 行只留首尾各 3 行）。
4. 按 token 预算（**默认 8000 字符**）从新到旧装箱；超出部分留给下次（`since` 只推进到实际
   被消费的最后一条时间戳——**不要推进到 now**）。
5. 返回给 agent：

```
【记忆整理任务】
下面是 11-12 09:00 至 11-13 09:20 的工作流水节选。请提炼成 5–15 条记忆行。

规则：
- 每条一行，不超过 60 字，中文，陈述句；
- 只记四类：决策(为什么这么定) / 偏好(用户口味与约束) / 风险(埋着的坑) / 经验(踩过什么)
- 不要复述过程，不要写"用户要求…"这种空话，不要记录临时文件名和行号
- 同一件事不要拆成多条
- 若无值得长期保留的内容，输出 "NO_NOTES"

流水：
<...>
```

6. agent 产出后调用 `memory_save_batch`（内部走 `POST /api/notes`），
   然后插件 `POST /api/watermark` 推进 `last_consolidated` 到第 4 步消费到的最后时间戳。

**失败处理**：任何一步失败都不能阻塞当天工作。工具返回错误即可，`last_run_at` 已由 claim 更新，
不会在这一天反复重试；下次窗口自然重来。

### 8.3 为什么让 agent 做而不是服务端做

- 服务端调 LLM 就要存 API key、要处理重试、要计费——把职责漂移回 Hindsight 的老路。
- agent 侧本来就有模型、有上下文、有项目的语感。
- 成本只发生一次，且可被用户看见（就在当前会话里）。

### 8.4 用户主动要求时的即时写入

绕过聚合，直接 `memory_save`（kind=manual）。这条路径**不消耗额外 LLM**，
就是用户的模型在正常对话里顺手写一条。

## 9. WorkBuddy 适配（二期，不要一期就做）

WorkBuddy 是 `@genie/agent-cli` 引擎，插件机制不同：它读 `~/.workbuddy/settings.json` 的 hooks
和 `~/.workbuddy/mcp.json`。适配方式：把我们自己的服务包装成 **MCP server**（stdio），
在 `mcp.json` 里注册一个 `dsh-server-memory` 服务，提供 `memory_search` / `memory_save`。
hooks 只在 `SessionStart` 注入一次索引即可。

一期先把 DSH 跑通，二期再做 MCP 包装——MCP 那层是纯转发，改造成本低。

## 10. 成本模型

| 项 | 现状（Hindsight） | 本设计 |
|---|---|---|
| 会话写回抽取 | 每会话一次，~1.6M in / 320k out 每两天 | **0**（只记流水，无 LLM） |
| 会话首轮注入 | reflect 循环，~2M in / 2 天 | **0**（纯检索） |
| 自动 consolidation | ~2.5M in / 2 天 | **0** |
| 页面刷新 | 15 张 / 小时 | **无此概念** |
| 日聚合 | — | 每天 1 次，~8k in / 1k out |
| **合计** | **约 ¥7/天** | **约 ¥0.05/天** |

要在验收里实测，不要只写估算（见 12.3）。

## 11. 安全与运维

- 服务端只监听 `0.0.0.0:8788`，但**防火墙只放行 Tailscale 网段 + 局域网**；
  或沿用现有做法：绑 `127.0.0.1:8788` + `tailscale serve` 代理。
- 必须校验 Bearer token；token 放 `~/.config/dsh-memory/config.json`（600 权限）。
- 启动方式：`launchd` plist（`~/Library/LaunchAgents/com.local.memoryd.plist`），
  `KeepAlive=true`，日志到 `~/Library/Logs/dsh-memory.log`。
- 备份：每天 03:00 用 `sqlite3 .backup` 到 `~/dsh-memory-backups/`，保留 14 份。
- 数据目录：`~/dsh-memory/data/memory.db`，**放在内置 SSD**，不要放外置盘。
- 隐私：**journal 默认不落库**（只在聚合时从本地转录临时读取），库里只有摘要行。

## 12. 验收标准

### 12.1 功能

1. `python3 memoryd.py` 能在 Mac mini 上以 3.9.6 启动，`/health` 返回 200。
2. `POST /api/notes` 写入 3 条中文摘要，`/api/context` 能按项目取回，字符数不超过 `max_chars`。
3. 中文检索可用：写入「结算模块改为按日结」，用 `q=日结` 能召回；用 `q=结算` 也能召回。
4. 未带 token 的请求返回 401。
5. 插件装进 DSH 后，系统提示里出现 `## 项目记忆` 段落，且不超过 900 字符。
6. `memory_search` 能取回正文；`memory_save` 写入后下一轮索引可见。
7. 聚合流程：手动把水位线改成 25 小时前，重启会话，agent 主动发起整理，
   产出 5–15 条摘要行并写入，水位线推进到转录消费位置。

### 12.2 失败路径

1. 服务端不可达：插件启动不报错，索引为空，工具调用返回明确错误，**不影响正常对话**。
2. 聚合中途 agent 放弃：水位线不推进，下次重来；`last_run_at` 已更新，当天不重复触发。
3. 转录格式不认识：跳过该文件并记日志，不抛异常。

### 12.3 成本

实现后跑一天，记录：`memoryd` 的 LLM 调用次数必须为 **0**；当天只有 1 次聚合调用。

## 13. 任务拆分（按顺序做，每步可独立验收）

1. **服务端骨架**：`memoryd.py` + SQLite 建表 + `/health` + token 校验。验收 12.1-1/4。
2. **写入与读取**：`/api/notes`、`/api/items`、`/api/context`、`/api/projects`。验收 12.1-2。
3. **中文检索**：bigram 预处理 + FTS5 + 排序 + LIKE 降级。验收 12.1-3。
4. **水位线**：`/api/watermark` + `/claim` 原子语义。
5. **插件骨架**：注入 section（走缓存）+ `memory_search` / `memory_save`。验收 12.1-5/6。
6. **转录读取**：DSH 会话文件解析 + 项目过滤 + 装箱。只做读，不接聚合。
7. **聚合闭环**：`memory_consolidate` + `memory_save_batch` + 水位线推进。验收 12.1-7、12.2。
8. **部署**：launchd + 备份脚本 + Tailscale serve（或沿用现有规则）。验收 11。
9. **可选二期**：MCP 包装给 WorkBuddy。

## 14. 风险与退出策略

| 风险 | 应对 |
|---|---|
| 中文 FTS 召回不理想 | 二期加本地 embedding 不在计划内；先用「索引注入 + agent 自己判断要不要 search」，容量小，够用 |
| 转录格式变化 | 解析层独立成 `transcripts.js`，格式不认识就跳过并记日志，不影响其他功能 |
| 聚合质量差（摘要太空） | 提示词里给 2 条 few-shot 正例；先人工看两周再调 |
| 迁移期数据断层 | Hindsight 保持只读不写，直到新系统跑满两周；旧库不删 |
| 服务端单点 | 数据是 SQLite 单文件，每天备份；崩了不影响 agent 工作（只是没有记忆） |

**退出策略**：新系统跑满两周认为不可用 → 把 DSH 配置改回 Hindsight（`apiUrl` 一行），
`memoryd` 停掉即可，不产生迁移成本。

## 15. 参考实现

`D:\dsh\plugins\user-memory\` 是本机已有的、验证可用的 DSH 插件：
- `index.js` 展示了 `inject` / `tools.register` / `systemPrompt.section` / `connection.fetch.register` 的用法；
- `store.js` 展示了原子写入、revision 乐观锁、索引裁剪；
- 新插件可以直接照抄这些模式，但**不要把数据存本地 JSON**——数据在服务端。
