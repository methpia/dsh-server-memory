# WorkBuddy 接入指南

同一套记忆服务（`memoryd` + 一个项目一个命名空间）在 WorkBuddy 里的用法。
DSH 侧见 [USER-GUIDE.md](USER-GUIDE.md)；这里只讲 WorkBuddy 特有的部分。

## 1. 为什么不能靠工作目录

WorkBuddy（`@genie/agent-cli` 引擎）**每次对话都会新建一个带时间戳的工作目录**，例如：

```
~/.workbuddy/projects/d-项目成果-2026-06-30-20-54-55/23820c0d-….jsonl
```

转录里记录的 `cwd` 是：

```
D:\项目成果\2026-06-30-20-54-55
```

目录名每次都变，按 basename 推断项目只会得到一串时间戳；按路径前缀映射也只能到「项目成果」这个大类，分不出
车易到、租房助手、项目罗盘、AI 编辑助手。**所以项目必须由对话内容来指定。**

## 2. 解决方式：项目别名表 + 关键词解析

服务端 `projects` 表新增 `aliases`（schema v2，旧库自动迁移），一个项目可以有多个名字：

```
cheyidao   label=车易到   aliases=车易到,cheyidao,汽修管理
dsh        label=DSH      aliases=dsh,harness,记忆插件
```

解析顺序（MCP 工具与钩子都遵守）：

1. 模型显式传入的 `project`；
2. **对话文本**里的项目名/别名（`GET /api/resolve?q=`，长别名优先）；
3. 本会话之前识别出的项目（钩子写入 `workbuddy-state.json`）；
4. 当前目录历史上对应的项目（12 小时窗口）；
5. 最近一次识别出的项目（12 小时窗口）；
6. `defaultProject`。

所以「帮我看看**车易到**的结算模块」会命中 `cheyidao`，即使本轮目录是 `D:\项目成果\2026-11-13-21-00-00`。
下一句「继续」没有再点名，也会沿用本会话已识别的 `cheyidao`。

## 3. 组件

```
workbuddy/
├── mcp-server.mjs          stdio MCP server（JSON-RPC，换行分隔）
│   ├─ memory_search        支持 project / 文本识别 / limit
│   ├─ memory_save          text 或 notes[]；带 consolidationId 时提交聚合结果
│   ├─ memory_consolidate   手动整理：读转录、返回摘要任务
│   ├─ memory_forget        按 id 删除
│   └─ memory_projects      列出项目、别名、条数
├── hooks/
│   ├── session-start.mjs   SessionStart：注入项目目录 + “目录不是项目”的规则
│   └── user-prompt.mjs     UserPromptSubmit：识别项目，首次命中时注入索引；到期时提示一次
├── lib/transcripts.mjs     WorkBuddy JSONL 转录 → 摘要原料
├── lib/                    配置、状态文件、解析、钩子文案
└── install.mjs             写 ~/.workbuddy/mcp.json 与 settings.json（默认 dry-run）
```

行为要点：

- **只在首次命中时注入索引**，同一会话同一项目后续对话保持安静，不重复花 token；换项目会再注入一次。
- **没识别到项目**时，第一次提示会给出项目目录让模型自己选，之后不再重复。
- **服务不可用**时钩子不输出、退出码 0，工具返回错误信息，不会卡住 WorkBuddy。
- 注入的是**紧凑索引**（≤900 字符、≤6 条），正文用 `memory_search` 取。

## 4. 会话记忆聚合（手动为主，每日为辅）

WorkBuddy 的转录是每个会话一个 JSONL（`~/.workbuddy/projects/<cwd>/<session>.jsonl`），
里面 `type:"message"` 的 `user` / `assistant` 消息可以像 DSH 一样被提炼。钩子会把
`transcript_path` 记进状态文件，聚合时按项目读取。

**手动（主路径）**

1. 用户说「整理一下记忆 / 总结一下最近的记忆」；
2. 模型调用 `memory_consolidate`（可带 `project`，省略则按会话/最近项目识别）；
3. 工具向服务端 `claim` 当天窗口，读取本项目会话转录，返回带 `consolidationId` 的摘要任务；
4. 模型按「决策 / 偏好 / 风险 / 经验」四类总结，调用
   `memory_save({ notes: [...], consolidationId })`；
5. 工具写入 `kind=note`，并把水位线推进到**实际消费到的最后一条流水**。

**每日（辅助）**

- `UserPromptSubmit` 钩子识别到项目后，如果 `/api/context` 显示聚合到期，会在注入文本末尾加一行：
  「记忆聚合已到期：说“整理记忆”或调用 memory_consolidate…」，每个会话只提示一次；
- 是否提示由配置 `dailyConsolidationHint`（默认 `true`）控制；
- 真正的占位由服务端 `claim` 保证一天一次，两个客户端（DSH / WorkBuddy）共享同一个窗口。

聚合只消费**安装钩子之后**被记录过的会话；更早的 WorkBuddy 会话没有 `transcript_path`，需要手动
`memory_save` 或等以后导入。`projectsRoot`（默认 `~/.workbuddy/projects`）可改。

## 5. 部署步骤

### 5.1 升级服务端

WorkBuddy 的别名解析需要 **schema v2**。把仓库里新的 `server/memoryd.py` 部署到 Mac mini（或你的服务器）并重启；
打开旧库时会自动迁移（`ALTER TABLE projects ADD COLUMN aliases`，不动已有记忆）。升级前先备份一次：

```bash
server/scripts/backup.sh          # 或直接在 Mac mini 上跑
python3 memoryd.py --check        # schema: 2
curl -s http://127.0.0.1:8788/health
```

### 5.2 设置项目名与别名

在能访问服务的机器上：

```bash
node scripts/projects.mjs set cheyidao --label 车易到 --aliases 车易到,cheyidao,汽修管理
node scripts/projects.mjs set zufang  --label 租房助手 --aliases 租房助手,zufang
node scripts/projects.mjs list
node scripts/projects.mjs resolve "车易到的结算模块"     # -> project: cheyidao
```

`--url` / `--token-file` 或环境变量 `MEMORY_URL` / `MEMORY_TOKEN_FILE` 指定连接。
用这个脚本而不是手写 curl，可以避开 PowerShell 把中文 JSON 弄坏、或 `echo` 多出 BOM 导致 401 的老问题。

### 5.3 安装到 WorkBuddy

```bash
# 先看会改什么（默认 dry-run，不写文件）
node workbuddy/install.mjs \
  --url http://192.168.5.5:8788 \
  --token-file ~/.config/dsh-memory/token

# 确认后写入（会先备份 mcp.json / settings.json）
node workbuddy/install.mjs --apply \
  --url http://192.168.5.5:8788 \
  --token-file ~/.config/dsh-memory/token
```

写入内容：

- `~/.workbuddy/mcp.json` → `mcpServers["dsh-memory"]`，命令为 `node <仓库>/workbuddy/mcp-server.mjs`；
- `~/.workbuddy/settings.json` → `SessionStart` 与 `UserPromptSubmit` 各追加一条 command 钩子（Claude Code 协议）。

**重启 WorkBuddy** 才会重新读取这两个文件。

### 5.4 从 Hindsight 切过来

Hindsight 的 MCP server 与三个钩子仍在 `~/.workbuddy` 里，切到本系统时：

```bash
node workbuddy/install.mjs --apply --remove-hindsight
```

它只删 `mcpServers.hindsight` 和命令里含 `hindsight` 的钩子，不动 `~/.hindsight` 里的文件与技能，随时可回滚。
两套记忆同时启用会重复注入、重复计费，不要并存。

### 5.5 验证

1. WorkBuddy 里新开对话，先问「你知道哪些项目记忆？」——应看到项目目录（SessionStart 注入）。
2. 说「帮我看看**车易到**的结算模块」——首句后应注入 `## 项目记忆（cheyidao｜车易到，由“车易到”识别）`。
3. 让它调用 `memory_search`（或直接问「还记得车易到的结算怎么定的吗」）——应返回 `[决策] 结算模块改为按日结…`。
4. 说「记住：车易到对账页先看当日汇总」——`memory_save` 应写入 `cheyidao`，返回里带识别方式。
5. 说「整理一下车易到的记忆」——`memory_consolidate` 应返回摘要任务；按提示提交后水位线推进，
   再查 `/api/watermark` 可以看到 `last_consolidated` 前进。
6. 说「继续」——钩子不再重复注入（设计如此）。

排查：设 `DSH_MEMORY_DEBUG=1` 后钩子会把原因打到 stderr；`~/.config/dsh-memory/workbuddy-state.json` 可看会话识别结果与 `transcriptPath`。

## 6. 限制

- **只有安装钩子之后的会话会被自动聚合**：更早的 WorkBuddy 会话没有记录 `transcript_path`，需要手动
  `memory_save` 补记。
- **MCP 层拿不到 session id**：工具靠「cwd 历史 → 最近项目 → 文本」兜底。钩子写入的会话映射是主路径；模型被
  提示在不确定时先调 `memory_projects`。
- **别名要够独特**：2–6 个高辨识度词即可；像「结算」「对账」这类通用词不要当别名，否则会把其他项目的话题
  吸过去。
- 服务端仍是一个共享 token；WorkBuddy 的 `mcp.json` 里只放配置路径，token 留在 `~/.config/dsh-memory/token`。
