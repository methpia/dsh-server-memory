# Security

`dsh-server-memory` 保存的是你的**全部长期记忆**，并且服务端持有访问凭据。部署前请读完这一页。

## 报告漏洞

请**不要**开公开 issue。走 GitHub 的私有漏洞报告（Security → Report a vulnerability），
或直接发邮件给仓库维护者。收到后 48 小时内会给首次回复。

## 威胁模型

| 资产 | 风险 | 现有缓解 |
|---|---|---|
| 记忆内容（SQLite 文件） | 磁盘泄漏、备份泄漏 | 数据库在 `~/dsh-memory/data/`，随备份脚本一起落到 `~/dsh-memory-backups/` |
| Bearer token | 泄漏后可读写全部记忆 | token 文件 `chmod 600`；服务端对除 `/health` 外全部端点强制校验 |
| 网络入口 | 暴露到公网后被扫到 | 默认只绑 `127.0.0.1`；跨机访问走局域网或 `tailscale serve`（不是 Funnel） |

## 部署时的硬性要求

1. **不要**把服务绑到 `0.0.0.0` 后做端口转发或 UPnP 映射。要跨网访问就用 Tailscale / WireGuard。
2. **不要**把 `token` 内联写进会被提交的文件。用 `tokenFile` 指向 `~/.config/dsh-memory/token`。
3. **不要**把 `.runtime/`、`*.db`、`config.json` 提交进仓库——`.gitignore` 已覆盖，提交前用 `git status` 复查。
4. 备份目录与数据库目录都不要放同步网盘（iCloud/Dropbox），那等于把记忆复制到第三方。

## 设置页的信任边界

插件新增的设置页（Settings → Built-in plugins → Project memory）满足两条约束：

1. **浏览器永远拿不到 bearer token。** 页面只调用宿主内的 `/api/dsh-server-memory` 路由，由宿主持有 token 去访问
   `memoryd`；因此即使页面被同源的其它脚本影响，也读不到凭据。
2. **改配置走宿主的 config editor**，不由插件直接改写 profile 文件；保存后插件重启才生效，避免半生效状态。

项目标签/别名是在服务端存的（`POST /api/projects`），不属于敏感配置；但别名会出现在对话里的项目匹配结果中，
不要用它们承载任何私密信息。
## 轮换 token

```bash
# 服务端
python3 memoryd.py --init-config --force   # 或在 config.json 里手改 token
# 客户端：更新 ~/.config/dsh-memory/token 后重启 agent
```

## 已知限制

- 服务端**不调用任何 LLM**，所以不存在"提示词注入导致的服务端越权执行"面；但记忆内容会被注入 agent 的
  系统提示，属于**信任边界内的数据**，宿主 agent 的隔离能力取决于宿主本身。
- `/api/search` 的查询串会被转成 FTS5 表达式，实现里已做转义；如果你自行修改拼接逻辑，请保持参数化。
