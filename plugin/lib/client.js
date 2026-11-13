/**
 * HTTP client for the memoryd service.
 *
 * The client is deliberately thin: no retries, no local database, no caching.
 * Every failure surfaces as a `MemoryError` carrying the server's error code so
 * callers (tools, the prompt index) can degrade without throwing at the host.
 *
 * @module dsh-memory/client
 */

import { createTokenProvider } from './token.js'

/** An actionable memory-service failure. */
export class MemoryError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, cause?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'MemoryError'
    this.code = details.code ?? 'memory-error'
    this.status = details.status ?? 0
  }
}

/**
 * Render an error for a model-facing tool result. Never includes the token.
 * @param {unknown} error
 * @returns {string}
 */
export function describeMemoryError(error) {
  if (error instanceof MemoryError) return `${error.message}（${error.code}）`
  if (error instanceof Error) return error.message
  return String(error)
}

/** Build a timeout signal without requiring the newest `AbortSignal.timeout`. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  if (typeof timer.unref === 'function') timer.unref()
  return controller.signal
}

/** @typedef {import('./config.js').MemorySettings} MemorySettings */

export class MemoryClient {
  /**
   * @param {MemorySettings} settings
   * @param {{fetchImpl?: typeof fetch, tokenProvider?: () => Promise<string>}} [options]
   */
  constructor(settings, options = {}) {
    this.settings = settings
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.tokenProvider = options.tokenProvider ?? createTokenProvider(settings)
    if (typeof this.fetchImpl !== 'function') {
      throw new MemoryError('this runtime has no fetch(); dsh-memory needs Node 20 or newer', {
        code: 'no-fetch',
      })
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{query?: Record<string, string|number|undefined>, body?: unknown, auth?: boolean}} [options]
   * @returns {Promise<any>}
   */
  async request(method, path, options = {}) {
    const { query, body, auth = true } = options
    const url = new URL(`${this.settings.serverUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }

    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8'
    if (auth) {
      const token = await this.tokenProvider()
      if (!token) {
        throw new MemoryError(
          '未配置记忆服务 token：请在插件配置里设置 token 或 tokenFile，或设置 DSH_MEMORY_TOKEN',
          { code: 'no-token' },
        )
      }
      headers.authorization = `Bearer ${token}`
    }

    let response
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutSignal(this.settings.requestTimeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new MemoryError(
        `记忆服务不可达（${this.settings.serverUrl}）：${reason}`,
        { code: 'unreachable', cause: error },
      )
    }

    const text = await response.text()
    let payload
    if (text !== '') {
      try {
        payload = JSON.parse(text)
      } catch (error) {
        throw new MemoryError(
          `记忆服务返回了非 JSON 响应（HTTP ${response.status}）`,
          { code: 'bad-response', status: response.status, cause: error },
        )
      }
    }

    if (!response.ok) {
      const serverError = payload?.error
      const code = typeof serverError?.code === 'string' ? serverError.code : `http-${response.status}`
      const message =
        typeof serverError?.message === 'string'
          ? serverError.message
          : `记忆服务返回 HTTP ${response.status}`
      throw new MemoryError(message, { code, status: response.status })
    }
    return payload ?? {}
  }

  /** @returns {Promise<{ok: boolean, version: number, projects: number, items: number}>} */
  health() {
    return this.request('GET', '/health', { auth: false })
  }

  /**
   * @param {string} project
   * @param {{limit?: number, maxChars?: number}} [options]
   */
  getContext(project, options = {}) {
    return this.request('GET', '/api/context', {
      query: {
        project,
        limit: options.limit ?? this.settings.indexMaxItems,
        max_chars: options.maxChars ?? 1500,
      },
    })
  }

  /**
   * @param {string} project
   * @param {string} query
   * @param {number} [limit]
   */
  search(project, query, limit = this.settings.searchResults) {
    return this.request('GET', '/api/search', { query: { project, q: query, limit } })
  }

  /**
   * @param {string} project
   * @param {Array<{text: string, tags?: string[]}>} notes
   * @param {{source?: string, kind?: string}} [options]
   */
  saveNotes(project, notes, options = {}) {
    return this.request('POST', '/api/notes', {
      body: {
        project,
        notes,
        source: options.source ?? 'consolidate',
        kind: options.kind ?? 'note',
      },
    })
  }

  /**
   * @param {string} project
   * @param {string} text
   * @param {string[]} [tags]
   */
  saveItem(project, text, tags = []) {
    return this.request('POST', '/api/items', {
      body: { project, text, tags, kind: 'manual', source: 'manual' },
    })
  }

  /** @param {number} id */
  forget(id) {
    return this.request('DELETE', `/api/items/${id}`)
  }

  /** @param {string} project */
  getWatermark(project) {
    return this.request('GET', '/api/watermark', { query: { project } })
  }

  /**
   * @param {string} project
   * @param {number} [minIntervalHours]
   */
  claim(project, minIntervalHours = this.settings.claimIntervalHours) {
    return this.request('POST', '/api/watermark/claim', {
      body: { project, min_interval_hours: minIntervalHours },
    })
  }

  /**
   * @param {string} project
   * @param {{lastConsolidated?: string, status?: string, error?: string}} [options]
   */
  setWatermark(project, options = {}) {
    return this.request('POST', '/api/watermark', {
      body: {
        project,
        last_consolidated: options.lastConsolidated ?? '',
        status: options.status ?? 'ok',
        error: options.error ?? '',
      },
    })
  }
}
