# 结构与扩展点

本文说明每个文件负责什么、数据怎么流、以及要改某件事时应该动哪里。
设计依据见 [DESIGN.md](../DESIGN.md)。

## 1. 分层

```
┌──────────────────────────── plugin/ ────────────────────────────┐
│ index.js          组装：normalizeConfig → client → cache →      │
│                   tools + systemPrompt.section                  │
│                                                                 │
│ lib/config.js     配置默认值、裁剪、路径展开（纯函数）           │
│ lib/token.js      token 解析：token / tokenFile / 环境变量       │
│ lib/client.js     HTTP 客户端与 MemoryError（无重试、无缓存）    │
│ lib/cache.js      /api/context 的内存缓存 + 定时刷新             │
│ lib/prompt.js     索引渲染与硬性字符预算（纯函数）               │
│ lib/project.js    目录 → 项目名（纯函数，可注入 fs）             │
│ lib/session.js    从 Agent/Session 猜测工作目录（尽力而为）      │
│ lib/zstd.js       逐帧 zstd 解码（纯函数）                       │
│ lib/transcripts.js 转录扫描、消息过滤、代码块截断（可注入 fs）    │
│ lib/digest.js     装箱、字符预算、摘要指令渲染（纯函数）         │
│ lib/tools.js      4 个工具：参数校验、聚合批次、水位线推进       │
└─────────────────────────────────────────────────────────────────┘
                               │ HTTP
┌────────────────────────── server/ ─────────────────────────────┐
│ memoryd.py   utils（时间/检索文本）→ Database → Handler → CLI   │
│             单文件，按“工具函数 → 存储 → HTTP → 入口”分节        │
└─────────────────────────────────────────────────────────────────┘
```

配套资产：`server/launchd/`（macOS 常驻）、`server/systemd/`（Linux 常驻）、`server/scripts/backup.sh`（每日备份）、
`scripts/smoke.mjs`（14 项端到端）、`.github/workflows/ci.yml`（Python 3.9/3.12 + Node 22/24 + 端到端）。

原则：

- **纯函数层不碰网络、不读全局状态**：`config/prompt/project/digest/zstd` 都能单测；
- **副作用收敛在三个地方**：`client.js`（网络）、`cache.js`（定时器）、`index.js`（注册与生命周期）；
- **协议细节只写一次**：API 形状在 `client.js`，服务端形状在 `memoryd.py`，两边各自测试。

## 2. 两条数据流

### 2.1 每轮对话：索引注入（零网络等待）

```
DSH 组装系统提示
  └─ dsh-memory:index 的 text(assembly)
       ├─ project = projectMap/目录 → projectFromDirectory()
       ├─ cache.snapshot(project)         ← 只读内存，缺失时后台补拉
       ├─ renderIndex(...)                ← 900 字符 / 6 条 / 单行化
       └─ 返回字符串（失败一律返回 ''，不影响对话）

后台（apply 时启动，每 contextPollMs 一次）
  └─ cache.refresh(project) → GET /api/context → 覆盖缓存
```

失败策略：启动时拿不到就是空索引；之后失败保留旧数据并记录 `error`，不会把已有记忆清空。

### 2.2 每天一次：聚合闭环

```
agent 看到 “记忆聚合已到期” 或用户要求整理
  └─ memory_consolidate
       ├─ POST /api/watermark/claim    ← 原子占位；claimed=false 立即返回
       ├─ collectDigestInput           ← 扫 ~/.dsh/sessions，按项目/深度/时间过滤
       ├─ planDigest                   ← 最早优先装箱，8000 字符上限，产出 brief
       └─ pending.set(batchId, {project, consumedUntil})

agent 用自己的模型总结
  └─ memory_save({ notes, consolidationId })
       ├─ POST /api/notes              ← 只有 notes 非空才写
       ├─ POST /api/watermark          ← 推进到 consumedUntil（不是 now）
       └─ cache.invalidate(project)
```

不变式：

- 水位线 = 实际消费到的最后一条流水时间，**永远不推进到 now**；
- `pending` 只在内存里，插件重启即丢；此时水位线没动，下个窗口重来；
- 写库成功但水位线失败时，工具明确报告“下次会重复处理同一段流水”，不假装成功。

## 3. 要改一件事时动哪里

| 需求 | 修改点 |
|---|---|
| 调整注入内容/格式 | `lib/prompt.js`（预算也在这里）；不要改 `index.js` |
| 调整检索条数、字段 | `lib/tools.js` 的 `memory_search` + `client.search` |
| 换/加一个记忆服务端点 | `lib/client.js` 一个方法 + `server/memoryd.py` 的 `_route` |
| 改项目识别规则 | `lib/project.js`；规则顺序写在文件头注释 |
| 支持新的转录格式 | `lib/transcripts.js` 的 `readSessionFile` / `extractEntries`，未知格式跳过并记 warning |
| 改摘要指令或 few-shot | `lib/digest.js` 的 `buildInstructions` |
| 改检索排序权重 | `server/config.example.json` 的 `ranking`，代码不用动 |
| 加数据库字段/表 | `memoryd.py` 的 `SCHEMA_SQL` + `SCHEMA_VERSION` + 迁移分支 |
| 加插件市场展示信息 | `plugin/locale/*.json`、`plugin/icon.svg`、`package.json` 的 `files` |
| 加新工具 | `lib/tools.js` 的 `createTools` 返回数组里追加；`index.js` 自动注册 |

## 4. 约定

- **命名**：插件内部模块用 `小写.js`；导出函数动词开头（`renderIndex`、`planDigest`、`createTools`）；纯函数不带副作用。
- **错误**：跨网络/协议的失败一律是 `MemoryError`（带 `code`），由工具抛出；不会让 host 崩溃。可恢复的空状态返回普通字符串，不抛异常。
- **超时**：所有 HTTP 请求带 `requestTimeoutMs`；缓存刷新失败只记日志。
- **配置**：`normalizeConfig` 永不抛错，非法值回退默认并写入 `problems[]`，由 `index.js` 统一 warn。
- **测试**：纯函数单测直接测行为；涉及 fs 的函数接收可注入的 `fs` 对象；服务端测试跑真实 HTTP。
- **安全**：token 不进日志；记忆正文单行化后再进 prompt；服务端限额不可由客户端绕过。

## 5. 扩展方向（按设计非目标，谨慎加入）

- 二期 MCP 包装给 WorkBuddy：包一层 stdio MCP server 转发 `memory_search` / `memory_save`（DESIGN.md 9）；
- 本地 embedding 召回：会引入模型依赖，与“零 LLM 日常开销”冲突，需要单独评估；
- 管理页面：`connection.fetch.register` 加一个只读页即可，插件已有缓存与状态可复用。
