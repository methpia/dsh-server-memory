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
