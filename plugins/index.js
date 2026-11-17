/**
 * `dsh-server-memory` — host plugin.
 *
 * Owns the connection to a self-hosted memoryd service and contributes:
 *   - `systemPrompt.section`: a compact, budgeted memory index grown from a
 *     background cache (never a network call inside prompt assembly);
 *   - four tools: memory_search / memory_save / memory_forget /
 *     memory_consolidate;
 *   - the once-a-day consolidation hand-off, where the agent's own model turns
 *     raw transcript flow into a handful of durable memory lines.
 *
 * The plugin keeps no local database: the service is the single source of
 * truth, so DSH and any other client see the same memory (DESIGN.md 3).
 *
 * @module dsh-memory
 */

import { ContextCache } from './lib/cache.js'
import { createAdminRoute } from './lib/admin.js'
import { MemoryClient } from './lib/client.js'
import { normalizeConfig } from './lib/config.js'
import { hostDirectory, projectFromDirectory } from './lib/project.js'
import { renderIndex } from './lib/prompt.js'
import { createSessionDirectoryResolver } from './lib/session.js'
import { createTools } from './lib/tools.js'

export const name = 'dsh-server-memory'
export const inject = ['tools', 'systemPrompt']

/** Placed just after the built-in memory section (1200). */
const SECTION_ORDER = 1210

/**
 * Apply the plugin.
 * @param {any} ctx Cordis plugin context.
 * @param {unknown} [config] Row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const logger = ctx.logger('dsh-memory')
  for (const problem of settings.problems) logger.warn(problem)

  const client = new MemoryClient(settings)
  const cache = new ContextCache({
    client,
    settings,
    onError: (message) => logger.warn(`记忆服务不可用：${message}`),
  })

  const directoryOf = createSessionDirectoryResolver({
    getSessions: () => {
      try {
        return ctx.get('sessions')
      } catch {
        return undefined
      }
    },
  })

  /**
   * Resolve the project for the current scope, falling back to the host's
   * working directory and then to the configured default.
   * @param {unknown} scope
   */
  const resolveProject = (scope) => {
    const directory = directoryOf(scope) || hostDirectory()
    return projectFromDirectory(directory, {
      projectMap: settings.projectMap,
      defaultProject: settings.defaultProject,
    })
  }

  // Warm the cache for the project the first prompt will most likely render.
  const warmProject = resolveProject(undefined)
  cache.touch(warmProject)
  void cache.refresh(warmProject)

  ctx.effect(() => cache.start(), 'dsh-memory: context cache')

  for (const tool of createTools({
    settings,
    client,
    cache,
    resolveProject,
    onWarning: (message) => logger.warn(message),
  })) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-memory: ${tool.name}`)
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'dsh-memory:index',
        order: SECTION_ORDER,
        text: (assembly) => {
          try {
            const project = resolveProject(assembly?.scope)
            cache.touch(project)
            const snapshot = cache.snapshot(project)
            return renderIndex({ project, snapshot, settings })
          } catch (error) {
            logger.warn(
              `构建记忆索引失败：${error instanceof Error ? error.message : String(error)}`,
            )
            return ''
          }
        },
      }),
    'dsh-memory: system prompt index',
  )

  logger.info(
    `已连接 ${settings.serverUrl}（项目 ${warmProject}，索引 ≤${settings.indexMaxChars} 字符，` +
      `聚合${settings.consolidationEnabled ? `每 ${settings.claimIntervalHours} 小时` : '已关闭'}）`,
  )

  // Settings page backend: the browser reads/writes through this authenticated
  // route, so the token never leaves the host.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.fetch.register(
      createAdminRoute({ ctx, client, settings, config }),
    )
  })
}
