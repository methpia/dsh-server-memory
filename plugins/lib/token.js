/**
 * Bearer-token resolution for the memory service.
 *
 * Precedence: explicit `token` config, then `tokenFile`, then
 * `DSH_MEMORY_TOKEN`. The file is read lazily (the plugin must not touch the
 * disk during activation) and a successful read is cached briefly so every tool
 * call does not hit the filesystem.
 *
 * @module dsh-memory/token
 */

import { readFile } from 'node:fs/promises'

const CACHE_TTL_MS = 60_000

/**
 * @param {import('./config.js').MemorySettings} settings
 * @param {{readFileImpl?: (path: string) => Promise<string>, env?: NodeJS.ProcessEnv, now?: () => number}} [options]
 * @returns {() => Promise<string>}
 */
export function createTokenProvider(settings, options = {}) {
  const readFileImpl = options.readFileImpl ?? readFile
  const env = options.env ?? process.env
  const now = options.now ?? (() => Date.now())
  let cached = { value: '', at: 0 }

  return async function resolveToken() {
    if (settings.token !== '') return settings.token

    if (settings.tokenFile !== '') {
      const fresh = now() - cached.at < CACHE_TTL_MS
      if (fresh && cached.value !== '') return cached.value
      try {
        const raw = await readFileImpl(settings.tokenFile, 'utf8')
        const value = raw.trim()
        cached = { value, at: now() }
        if (value !== '') return value
      } catch {
        // A missing token file is a configuration state, not a crash: fall through
        // so the caller receives one explicit "no token" error instead of a stack.
      }
    }

    const fromEnv = typeof env.DSH_MEMORY_TOKEN === 'string' ? env.DSH_MEMORY_TOKEN.trim() : ''
    return fromEnv
  }
}
