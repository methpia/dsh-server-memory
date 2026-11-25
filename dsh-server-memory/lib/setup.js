/**
 * Deployment and configuration guidance.
 *
 * The plugin is useless without a `memoryd` service, and an install that ships
 * no config cannot know whether its owner has one. This module owns the single
 * answer to "the service is not there yet": the `memory_setup` tool, the
 * settings page's help block, and the tool-error hint all render from here, so
 * the commands cannot drift apart.
 *
 * The text is guidance for a human or a model, never an instruction to the
 * host: nothing here runs a command.
 *
 * @module dsh-memory/setup
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Canonical documentation entry point for a fresh install. */
export const DOCS_URL = 'https://github.com/methpia/dsh-server-memory#quick-start'

const REPO_URL = 'https://github.com/methpia/dsh-server-memory'
const BUNDLED_SERVER = new URL('../server/memoryd.py', import.meta.url)

/**
 * Absolute path of the `memoryd.py` shipped inside this package, or `null` when
 * the package was installed without it (older versions and npm tarballs).
 * @returns {string | null}
 */
export function bundledServerPath() {
  try {
    const file = fileURLToPath(BUNDLED_SERVER)
    return existsSync(file) ? file : null
  } catch {
    return null
  }
}

/** One short line describing what the connection state means. */
function statusLine({ reachable, tokenRejected, hasToken }) {
  if (reachable === false) return '不可达：服务没在运行，或地址/防火墙不对'
  if (reachable === null) return '未检测'
  if (tokenRejected === true) return '服务可达，但 token 缺失或被拒绝'
  if (hasToken !== true) return '服务可达，但还没配置 token'
  return '已连接'
}

/**
 * Render the full "deploy it yourself" guide.
 *
 * @param {object} input
 * @param {string} input.serverUrl Configured base URL, echoed so the reader can
 *   see which host the steps must land on.
 * @param {boolean} [input.hasToken] Whether a token source is configured.
 * @param {boolean|null} [input.reachable] `null` when not probed yet.
 * @param {boolean} [input.tokenRejected] Service answered 401.
 * @param {string|null} [input.bundledPath] Override for tests.
 * @returns {string}
 */
export function deploymentText(input) {
  const { serverUrl, hasToken = false, reachable = null, tokenRejected = false } = input
  const bundled = Object.hasOwn(input, 'bundledPath') ? input.bundledPath : bundledServerPath()

  const memoryd = bundled === null ? 'memoryd.py' : `"${bundled}"`
  const acquire =
    bundled === null
      ? [
          '1. 拿到服务端（单文件，Python 3.9+ 标准库，无第三方依赖）',
          `   git clone ${REPO_URL}`,
          '   cd dsh-server-memory/server',
        ]
      : ['1. 服务端已经随插件安装，不用另外下载', `   ${bundled}`]

  return [
    `[dsh-server-memory] 记忆服务：${serverUrl} —— ${statusLine({ reachable, tokenRejected, hasToken })}`,
    '',
    ...acquire,
    '',
    '2. 初始化配置并打印 token（只做一次；已有 config 会拒绝覆盖）',
    `   python3 ${bundled === null ? 'memoryd.py' : memoryd} --init-config --config ~/.config/dsh-memory/config.json`,
    '',
    '3. 启动服务（前台，默认 127.0.0.1:8788）',
    `   python3 ${bundled === null ? 'memoryd.py' : memoryd} --config ~/.config/dsh-memory/config.json`,
    bundled === null
      ? '   常驻运行：macOS 用 server/launchd，Linux 用 server/systemd，容器用 server/docker。'
      : `   常驻运行：launchd / systemd / docker 单元在仓库的 server/ 目录下（${REPO_URL}）。`,
    '',
    '4. 把第 2 步打印的 token 交给插件',
    '   mkdir -p ~/.config/dsh-memory',
    "   printf '%s' 'mem_xxx' > ~/.config/dsh-memory/token && chmod 600 ~/.config/dsh-memory/token",
    '   Windows PowerShell：Set-Content -NoNewline -Encoding utf8 "$env:USERPROFILE\\.config\\dsh-memory\\token" "mem_xxx"',
    '',
    '5. 让插件指向它',
    '   - 服务就在本机：留空即用 http://127.0.0.1:8788',
    '   - 服务在别的机器：export DSH_MEMORY_SERVER_URL=http://<host>:8788（或在本页填服务地址）',
    '   - 服务端不在本机时，把 config.json 的 "host" 改成 "0.0.0.0"，只在可信网络（内网 / Tailscale）放行 8788',
    '',
    '6. 验证：设置 → 项目记忆 → 测试连接，或让 agent 调一次 memory_search',
    '',
    '安全：token 不要贴进公开仓库或聊天记录；8788 不要直接暴露公网，需要公网就放在 Caddy/nginx 的 HTTPS 后面（见 docs/PUBLIC-DEPLOYMENT.md）。',
    `完整文档：${DOCS_URL}`,
  ].join('\n')
}

/**
 * The sentence appended to a failing tool result so the reader learns the next
 * step instead of only "connection refused".
 * @param {unknown} error
 * @returns {string}
 */
export function setupHintFor(error) {
  const code = /** @type {{code?: string, status?: number}} */ (error)?.code ?? ''
  const status = /** @type {{status?: number}} */ (error)?.status ?? 0
  if (code === 'unreachable' || code === 'no-token' || code === 'unauthorized' || status === 401) {
    return '（服务可能尚未部署或未配置：调用 memory_setup 查看部署与配置步骤）'
  }
  return ''
}
