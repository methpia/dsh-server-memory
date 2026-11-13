# 快速上手（中文）

插件不自带服务端：记忆存在你自己跑的 `memoryd` 里，插件只是客户端。
完整英文说明见 [USER-GUIDE.md](USER-GUIDE.md)，这里是最短可用路径。

## 前提

| 角色 | 要求 |
|---|---|
| 服务端 | Python **3.9+**，零第三方依赖（树莓派、NAS、Mac mini 都行） |
| 客户端 | DeepSeek Harness（支持 bundle）、Node **22.15+** |
| 网络 | 客户端能访问服务端；**不要**暴露到公网 |

## 一、起服务端

```bash
git clone https://github.com/methpia/dsh-server-memory.git
cd dsh-server-memory/server

python3 memoryd.py --init-config    # 生成 ~/.config/dsh-memory/config.json，并打印一次 token
python3 memoryd.py --check          # 只读检查，不需要 token
python3 memoryd.py                  # 前台启动，默认 127.0.0.1:8788
```

验证：`curl -s http://127.0.0.1:8788/health`

常驻：macOS 用 `launchd/com.local.memoryd.plist`，Linux 用 `systemd/dsh-memory.service`（见 README）。

## 二、让别的机器能连（跨机才需要）

默认只监听 `127.0.0.1`。二选一：

- **局域网**：把 `config.json` 的 `host` 改成局域网 IP（如 `192.168.1.10`），重启服务。
- **Tailscale**：保持 `127.0.0.1`，用 `tailscale serve --bg --https=8443 http://127.0.0.1:8788`，
  客户端用 `https://<机器名>.<tailnet>.ts.net:8443`。

## 三、装插件（客户端机器）

```text
plugin_manager install_bundle { "target": "/绝对路径/dsh-server-memory/plugin" }
```

装完重启 DSH，工具列表里应出现 `memory_search` / `memory_save` / `memory_forget` / `memory_consolidate`。

## 四、配置指向与 token

在你的 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里按 id 覆盖：

```yaml
- id: dsh-server-memory
  config:
    serverUrl: http://192.168.1.10:8788
    tokenFile: ~/.config/dsh-memory/token
    defaultProject: default
    projectMap:
      /home/me/work: work
```

把服务端打印的 token 写到客户端：

```bash
mkdir -p ~/.config/dsh-memory
printf '%s' '<token>' > ~/.config/dsh-memory/token    # 注意用 printf，echo 会多一个换行导致 401
chmod 600 ~/.config/dsh-memory/token
```

Windows 放在 `%USERPROFILE%\.config\dsh-memory\token`。

## 五、验证

在 DSH 里说一句「记住：我用 pnpm」，agent 会调 `memory_save`；
新开一个会话问「我用什么包管理器？」，系统提示的 `## 项目记忆` 里出现这条就通了。

## 六、图形化配置

**设置 → 内置插件 → 项目记忆** 可以直接改：服务地址、token 文件、默认项目、索引与聚合预算；
带"测试连接""加载项目"，并且能在表格里直接编辑项目的标签与别名。

- 保存设置走宿主的 config editor，**插件会重启**才生效；
- 改项目名/别名是直接写服务端，**立即生效**；
- token 不进浏览器，页面通过宿主的 `/api/dsh-server-memory` 路由代理。

## 七、用项目名唤醒记忆

有些 agent（典型是 WorkBuddy）每次对话都新建一个时间戳目录，按目录推断项目就失效了。
服务端给每个项目存 `label` + `aliases`：

```bash
node scripts/projects.mjs list
node scripts/projects.mjs set cheyidao --label 车易到 --aliases 车易到,cheyidao,汽修管理
node scripts/projects.mjs resolve 车易到的结算模块改了什么
```

匹配规则：最长别名优先；长度相同则取记忆条数更多的项目。

## 八、WorkBuddy（可选）

适配器在 `workbuddy/`，不属于 npm 包：

```bash
node workbuddy/install.mjs --url http://192.168.5.5:8788 --token-file ~/.config/dsh-memory/token          # 预览
node workbuddy/install.mjs --apply --url http://192.168.5.5:8788 --token-file ~/.config/dsh-memory/token   # 写入
```

会先备份 `mcp.json` / `settings.json`，只加一个 stdio MCP server 和两个 hook，不动 Hindsight。
详见 [WORKBUDDY.md](WORKBUDDY.md)。
## 日常行为

- **干活时不写记忆**，插件只读，零 LLM 开销。
- 只有你说「记住」时才会写。
- **每天第一次对话**时做一次聚合：读本地 DSH 转录 → agent 提炼成 5–15 条
  `[决策]/[偏好]/[风险]/[经验]` → 写回并推进水位线。
- 积压的流水会分几天消化，不会一次性巨量调用。
- 服务端挂了不影响正常工作：索引为空、工具报错，仅此而已。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具报"记忆服务不可达" | 地址错 / 服务没起 / 防火墙 | 客户端上 `curl <serverUrl>/health` |
| 401 | token 文件为空、写错、或末尾多了换行 | 用 `printf '%s'` 重写 |
| 没有 `## 项目记忆` 段 | 插件没加载，或 patch 里的 id 写错 | 重启 DSH，检查工具列表 |
| 段是空的 | 还没有任何记忆 | 先手动「记住」一条，或等首次聚合 |
| 手动聚合返回 `too_soon` | 24 小时窗口未到 | 等待，或调小服务端 `min_claim_interval_hours` |

## 备份

数据库就是一个文件：`~/dsh-memory/data/memory.db`。停服务 → 复制 → 起服务即可。
轮换 token 没有 `--force`：把 `config.json` 改名备份后用 `--init-config` 重新生成，
并同步更新所有客户端的 token 文件。
## 公网部署（阿里云等 VPS）

三种部署方式，按风险从低到高：单机 → 内网/Tailscale → **公网**。公网必须开 HTTPS，完整步骤见
[PUBLIC-DEPLOYMENT.md](PUBLIC-DEPLOYMENT.md)（英文），要点：

1. 配置里把 `host` 改成 `0.0.0.0`，并填上 `tls_cert` / `tls_key`（**必须成对**，只填一个会拒绝启动）：
   ```json
   {
     "host": "0.0.0.0",
     "port": 8788,
     "tls_cert": "/etc/letsencrypt/live/mem.example.com/fullchain.pem",
     "tls_key":  "/etc/letsencrypt/live/mem.example.com/privkey.pem"
   }
   ```
2. 用 certbot 申请证书（standalone 挑战需要短暂占用 80 端口），并加续期后重启服务的钩子。
3. 防火墙/安全组只放行 443；如果放在 nginx/Caddy 后面，则服务留在 `127.0.0.1:8788`，8788 不得对外开放。
4. 客户端 `serverUrl` 改成 `https://你的域名`，token 文件同步过去。
5. 内地 VPS + 域名走 80/443 需要备案；不想备案就用境外机器或 Tailscale。

**公网部署没有的东西**：没有账号体系（一个 token 等于全部记忆的钥匙）、没有速率限制、数据库明文落盘。
这些都需要靠外层（代理、全盘加密、fail2ban）补。