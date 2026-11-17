/**
 * Project identity resolution.
 *
 * Memory is namespaced per project (DESIGN.md 4). The rules, in order:
 *   1. the longest matching prefix in `projectMap`;
 *   2. the enclosing git repository's directory name;
 *   3. the working directory's own name;
 *   4. `defaultProject`.
 *
 * Everything is pure and injectable so the rules stay testable without a real
 * filesystem or a real DSH session.
 *
 * @module dsh-memory/project
 */

import { existsSync } from 'node:fs'
import { basename, dirname, join, normalize, parse, resolve } from 'node:path'
import { sanitizeProjectName } from './config.js'

const WINDOWS = process.platform === 'win32'
const MAX_GIT_WALK = 12

/** Normalise a path for comparison (separators, trailing slash, case on Windows). */
export function canonicalPath(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  let text = normalize(trimmed).replace(/\\/g, '/')
  if (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  return WINDOWS ? text.toLowerCase() : text
}

/** True when `directory` is `prefix` itself or lives underneath it. */
export function isInside(directory, prefix) {
  const child = canonicalPath(directory)
  const parent = canonicalPath(prefix)
  if (child === '' || parent === '') return false
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

/**
 * Find the longest `projectMap` prefix containing `directory`.
 * @param {Record<string, string>} projectMap
 * @param {string} directory
 * @returns {{project: string, prefix: string} | undefined}
 */
export function matchProjectMap(projectMap, directory) {
  let best
  for (const [prefix, project] of Object.entries(projectMap ?? {})) {
    if (!isInside(directory, prefix)) continue
    const prefixLength = canonicalPath(prefix).length
    if (best === undefined || prefixLength > canonicalPath(best.prefix).length) {
      best = { project, prefix }
    }
  }
  return best
}

/**
 * Walk up until a `.git` entry is found.
 * @param {string} directory
 * @param {{exists?: (path: string) => boolean}} [options]
 * @returns {string | undefined}
 */
export function findGitRoot(directory, options = {}) {
  const exists = options.exists ?? existsSync
  let current = resolve(directory)
  for (let depth = 0; depth < MAX_GIT_WALK; depth += 1) {
    try {
      if (exists(join(current, '.git'))) return current
    } catch {
      return undefined
    }
    const parent = dirname(current)
    if (parent === current || parent === '') return undefined
    if (parse(current).root === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * Resolve the project id for a working directory.
 * @param {string} directory
 * @param {{projectMap?: Record<string, string>, defaultProject?: string, exists?: (path: string) => boolean}} [options]
 * @returns {string}
 */
export function projectFromDirectory(directory, options = {}) {
  const defaultProject = sanitizeProjectName(options.defaultProject ?? 'default')
  const mapping = matchProjectMap(options.projectMap ?? {}, directory)
  if (mapping !== undefined) return sanitizeProjectName(mapping.project, defaultProject)
  if (typeof directory === 'string' && directory.trim() !== '') {
    const gitRoot = findGitRoot(directory, { exists: options.exists })
    if (gitRoot !== undefined) {
      const name = basename(gitRoot)
      if (name !== '' && name !== '.' && name !== '/') return sanitizeProjectName(name, defaultProject)
    }
    const name = basename(resolve(directory))
    if (name !== '' && name !== '.' && name !== '/') return sanitizeProjectName(name, defaultProject)
  }
  return defaultProject
}

/** The host process working directory, or '' when unavailable. */
export function hostDirectory() {
  try {
    return typeof process.cwd === 'function' ? process.cwd() : ''
  } catch {
    return ''
  }
}
