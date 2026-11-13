/**
 * Authenticated host route behind the settings page.
 *
 * The browser never sees the bearer token and never talks to memoryd directly:
 * the route reads the live settings, proxies project reads/writes with the same
 * `MemoryClient` the tools use, and persists configuration through the host's
 * `configEditor` (the supported way for a plugin to change its own row).
 *
 * @module dsh-memory/admin
 */

import { describeMemoryError, MemoryError } from './client.js'
import { normalizeConfig } from './config.js'

export const ADMIN_ROUTE = '/api/dsh-server-memory'

/** Configuration keys the settings page may change. */
export const EDITABLE_KEYS = [
  'serverUrl',
  'token',
  'tokenFile',
  'defaultProject',
  'projectMap',
  'indexMaxItems',
  'indexMaxChars',
  'searchResults',
  'searchMaxChars',
  'digestMaxChars',
  'digestMaxEntries',
  'maxBacklogDays',
  'claimIntervalHours',
  'consolidationEnabled',
  'contextPollMs',
  'requestTimeoutMs',
  'sessionsRoot',
  'transcriptMaxBytes',
  'transcriptMaxCharsPerEntry',
]

/** An error that maps onto an HTTP response. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The settings the page may display (never the raw token). */
export function publicSettings(settings) {
  return {
    serverUrl: settings.serverUrl,
    tokenFile: settings.tokenFile,
    // A token file counts as configured: the page only needs to say whether the
    // service credentials are set up, not where the secret lives.
    hasToken: settings.token !== '' || settings.tokenFile !== '',
    defaultProject: settings.defaultProject,
    projectMap: settings.projectMap,
    indexMaxItems: settings.indexMaxItems,
    indexMaxChars: settings.indexMaxChars,
    searchResults: settings.searchResults,
    searchMaxChars: settings.searchMaxChars,
    digestMaxChars: settings.digestMaxChars,
    digestMaxEntries: settings.digestMaxEntries,
    maxBacklogDays: settings.maxBacklogDays,
    claimIntervalHours: settings.claimIntervalHours,
    consolidationEnabled: settings.consolidationEnabled,
    contextPollMs: settings.contextPollMs,
    requestTimeoutMs: settings.requestTimeoutMs,
    sessionsRoot: settings.sessionsRoot,
    transcriptMaxBytes: settings.transcriptMaxBytes,
    transcriptMaxCharsPerEntry: settings.transcriptMaxCharsPerEntry,
    problems: settings.problems,
  }
}

/** Reject obviously invalid URLs before touching the config editor. */
function validateMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new HttpError(400, 'invalid-patch', 'patch 必须是对象')
  }
  const merged = { ...(base && typeof base === 'object' ? base : {}) }
  for (const key of EDITABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) merged[key] = patch[key]
  }
  if (typeof merged.serverUrl === 'string' && merged.serverUrl.trim() === '') {
    throw new HttpError(400, 'invalid-server-url', '记忆服务地址不能为空')
  }
  const normalized = normalizeConfig(merged)
  if (typeof merged.serverUrl === 'string') {
    try {
      const parsed = new URL(merged.serverUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('protocol')
      }
    } catch {
      throw new HttpError(400, 'invalid-server-url', '记忆服务地址必须是 http(s) URL')
    }
  }
  return normalized
}

/** Persist the editable subset through the host config editor. */
async function persistSettings(ctx, currentConfig, patch) {
  const normalized = validateMerge(currentConfig, patch)
  const editor = ctx.get?.('configEditor')
  const entry = ctx.fiber?.entry
  if (editor === undefined || editor === null || entry === undefined) {
    throw new HttpError(
      503,
      'config-unavailable',
      '当前宿主没有可用的 configEditor，无法从界面保存配置；请编辑 profile 的 cordis.patch.yml。',
    )
  }
  const persisted = {}
  for (const key of EDITABLE_KEYS) {
    if (normalized[key] !== undefined) persisted[key] = normalized[key]
  }
  await editor.edit(entry, () => persisted)
  return normalized
}

/**
 * Build the route object for `connection.fetch.register`.
 *
 * @param {{ctx: any, client: any, settings: any, config?: unknown}} options
 */
export function createAdminRoute(options) {
  const { ctx, client, settings, config } = options

  return {
    path: ADMIN_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'GET') {
          return json(200, {
            ok: true,
            version: 1,
            settings: publicSettings(settings),
          })
        }

        let body
        try {
          body = await request.json()
        } catch {
          throw new HttpError(400, 'invalid-json', '请求体不是合法 JSON')
        }
        if (body === null || typeof body !== 'object') {
          throw new HttpError(400, 'invalid-body', '请求体必须是对象')
        }

        if (body.action === 'health') {
          try {
            const health = await client.health()
            return json(200, { ok: true, health })
          } catch (error) {
            return json(200, { ok: false, error: describeMemoryError(error) })
          }
        }

        if (body.action === 'projects') {
          try {
            const payload = await client.listProjects()
            return json(200, { ok: true, projects: payload.projects ?? [] })
          } catch (error) {
            return json(200, { ok: false, error: describeMemoryError(error) })
          }
        }

        if (body.action === 'save-project') {
          if (typeof body.project !== 'string' || body.project.trim() === '') {
            throw new HttpError(400, 'invalid-project', '项目 id 不能为空')
          }
          try {
            const payload = await client.upsertProject(body.project.trim(), {
              label: typeof body.label === 'string' ? body.label : undefined,
              aliases: Array.isArray(body.aliases) ? body.aliases : undefined,
            })
            return json(200, { ok: true, project: payload.project })
          } catch (error) {
            return json(200, { ok: false, error: describeMemoryError(error) })
          }
        }

        if (body.action === 'save-settings') {
          const normalized = await persistSettings(ctx, config, body.patch)
          return json(200, {
            ok: true,
            saved: true,
            restarting: true,
            settings: publicSettings(normalized),
          })
        }

        throw new HttpError(400, 'unknown-action', `未知操作：${String(body.action)}`)
      } catch (error) {
        if (error instanceof HttpError) {
          return json(error.status, { ok: false, code: error.code, message: error.message })
        }
        if (error instanceof MemoryError) {
          return json(502, { ok: false, code: error.code, message: error.message })
        }
        return json(500, {
          ok: false,
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
