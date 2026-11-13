# Contributing

欢迎 PR。改动请尽量小、单一目的，并带上测试。

## 环境

- Node **>= 22.15**（插件运行在 DSH 宿主里）
- Python **>= 3.9**（服务端只用标准库，不要引入第三方依赖——这是刻意设计，见 DESIGN.md §2）

## 跑测试

```bash
# 服务端（38 个用例）
python -m unittest discover -s server/tests -v

# 插件（10 个文件）
cd plugin && node --test --experimental-test-isolation=none "tests/*.test.js"
```

> **注意**：`node --test tests/`（不带 `--experimental-test-isolation=none`）会让 Node 为每个文件起子进程，
> 在受限沙箱（如某些 agent 宿主）里会报 `spawn EPERM`。逐文件 `node tests/foo.test.js` 也可以。

## 端到端

```bash
python server/memoryd.py --config /tmp/mem-config.json &   # 先在 /tmp 写一份带 token 的配置
node scripts/smoke.mjs --url http://127.0.0.1:8788 --token-file <token 文件>
# 期望 14/14 checks passed
```

## 约定

- 服务端保持**零第三方依赖**；确需新依赖请在 PR 里说明为什么标准库做不到。
- 任何写入路径都要有长度上限（现在单条 4000 字符）。**不允许**把整段会话转录直接入库——见 DESIGN.md §2.1 的事故记录。
- 提交信息用祈使句，首行 ≤ 72 字符；正文说明"为什么"而不是"改了什么"。
- 提交前跑一遍 `git status`，确认 `.runtime/`、`*.db`、`token` 不在待提交列表里。
