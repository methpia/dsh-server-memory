/**
 * Best-effort lookup of the directory a DSH session runs in.
 *
 * Project identity depends on the working directory (DESIGN.md 7.4), and the
 * only stable thing a plugin receives is an Agent (`{ id }`) or an assembly
 * scope. DSH has moved Session fields around between releases, so this probes a
 * few known shapes and returns '' instead of guessing.
 *
 * @module dsh-memory/session
 */

const DIRECT_KEYS = ['cwd', 'directory', 'workdir']
const NESTED_KEYS = ['header', 'meta', 'options', 'info', 'session']

/**
 * Read a working directory out of an object that may be a Session.
 * @param {unknown} value
 * @returns {string}
 */
export function readSessionDirectory(value) {
  if (value === null || typeof value !== 'object') return ''
  const record = /** @type {Record<string, any>} */ (value)

  for (const key of DIRECT_KEYS) {
    if (typeof record[key] === 'string' && record[key] !== '') return record[key]
  }
  for (const holder of NESTED_KEYS) {
    const nested = record[holder]
    if (nested === null || typeof nested !== 'object') continue
    for (const key of DIRECT_KEYS) {
      if (typeof nested[key] === 'string' && nested[key] !== '') return nested[key]
    }
  }
  return ''
}

/**
 * @param {{getSessions?: () => any}} options
 * @returns {(scope: unknown) => string}
 */
export function createSessionDirectoryResolver(options = {}) {
  const getSessions = options.getSessions ?? (() => undefined)

  return function resolveDirectory(scope) {
    const direct = readSessionDirectory(scope)
    if (direct !== '') return direct

    const id = scope !== null && typeof scope === 'object' ? scope.id : undefined
    if (typeof id !== 'string' || id === '') return ''
    try {
      const sessions = getSessions()
      if (sessions === undefined || sessions === null) return ''
      const session = typeof sessions.get === 'function' ? sessions.get(id) : undefined
      return readSessionDirectory(session)
    } catch {
      return ''
    }
  }
}
