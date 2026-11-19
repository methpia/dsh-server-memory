/**
 * Configuration for the `dsh-server-memory` plugin.
 *
 * Every field is optional: the plugin must stay usable with an empty `config`,
 * and a bad value must degrade to the documented default instead of throwing
 * during activation. `normalizeConfig` therefore never validates by rejecting;
 * it clamps, expands paths, and reports problems for the caller to log.
 *
 * @module dsh-memory/config
 */

import { homedir } from 'node:os'
import { join, normalize as normalizePath } from 'node:path'

/** @typedef {'ok'|'empty'|'failed'} ConsolidationStatus */

/**
 * @typedef {object} MemorySettings
 * @property {string} serverUrl Base URL of the memoryd service.
 * @property {string} token Inline bearer token (empty when a token file is used).
 * @property {string} tokenFile File holding the bearer token; empty for none.
 * @property {string} defaultProject Project used when the directory cannot be mapped.
 * @property {Record<string, string>} projectMap Directory prefix -> project id.
 * @property {number} requestTimeoutMs Per-request timeout.
 * @property {number} contextPollMs Background index refresh interval.
 * @property {number} indexMaxItems Maximum memory rows injected into the prompt.
 * @property {number} indexMaxChars Maximum characters injected into the prompt.
 * @property {number} searchResults Default number of search hits.
 * @property {number} searchMaxChars Maximum characters returned by a search.
 * @property {number} digestMaxChars Character budget for one consolidation digest.
 * @property {number} digestMaxEntries Row cap for one consolidation digest.
 * @property {number} maxBacklogDays Never walk further back than this on a first run.
 * @property {boolean} consolidationEnabled Whether the once-a-day flow is offered.
 * @property {number} claimIntervalHours Minimum hours between consolidation runs.
 * @property {number} sessionsRoot Root of the DSH session transcripts.
 * @property {number} transcriptMaxBytes Skip transcript files larger than this.
 * @property {number} transcriptMaxCharsPerEntry Per-entry clamp inside a digest.
 * @property {string[]} problems Human-readable configuration problems.
 */

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8788'
const DEFAULT_SESSIONS_ROOT = '~/.dsh/sessions'

/** @type {Readonly<Record<string, unknown>>} */
export const DEFAULTS = Object.freeze({
  serverUrl: DEFAULT_SERVER_URL,
  token: '',
  tokenFile: '',
  defaultProject: 'default',
  projectMap: {},
  requestTimeoutMs: 8000,
  contextPollMs: 300_000,
  indexMaxItems: 6,
  indexMaxChars: 900,
  searchResults: 8,
  searchMaxChars: 4000,
  digestMaxChars: 8000,
  digestMaxEntries: 120,
  maxBacklogDays: 7,
  consolidationEnabled: true,
  claimIntervalHours: 24,
  sessionsRoot: DEFAULT_SESSIONS_ROOT,
  transcriptMaxBytes: 8 * 1024 * 1024,
  transcriptMaxCharsPerEntry: 1200,
})

/** Expand a leading `~` and normalise separators for the current platform. */
export function expandHome(value, home = homedir()) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return normalizePath(join(home, text.slice(2)))
  }
  return normalizePath(text)
}

/** Clamp an integer into [min, max]; non-numeric input yields `fallback`. */
export function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Clamp a float into [min, max]. */
export function clampNumber(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Turn arbitrary user input into a project id the server accepts.
 * The server allows `[\w.:-]{1,64}`, so everything else becomes a dash.
 */
export function sanitizeProjectName(value, fallback = 'default') {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return fallback
  const cleaned = text
    .replace(/[^\p{L}\p{N}_.:-]+/gu, '-')
    .replace(/^[-.:]+|[-.:]+$/g, '')
    .slice(0, 64)
  return cleaned === '' ? fallback : cleaned
}

/** Strip trailing slashes so URL joins stay predictable. */
function normalizeServerUrl(value, problems) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return DEFAULT_SERVER_URL
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    problems.push(`serverUrl is not a valid URL (${text}); falling back to ${DEFAULT_SERVER_URL}`)
    return DEFAULT_SERVER_URL
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    problems.push(`serverUrl must be http or https (${text}); falling back to ${DEFAULT_SERVER_URL}`)
    return DEFAULT_SERVER_URL
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/** Normalise the `projectMap` object: expanded absolute paths, safe project ids. */
function normalizeProjectMap(value, problems) {
  const result = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (value !== undefined) problems.push('projectMap must be an object of directory -> project')
    return result
  }
  for (const [key, project] of Object.entries(value)) {
    const directory = expandHome(key)
    if (directory === '') {
      problems.push(`projectMap has an empty directory key; skipped`)
      continue
    }
    if (typeof project !== 'string' || project.trim() === '') {
      problems.push(`projectMap["${key}"] must be a non-empty project id; skipped`)
      continue
    }
    result[directory] = sanitizeProjectName(project)
  }
  return result
}

/**
 * Normalise the plugin row config.
 *
 * @param {unknown} raw Config object from `cordis.patch.yml`.
 * @param {{home?: string}} [options] Test seam for `~` expansion.
 * @returns {MemorySettings}
 */
export function normalizeConfig(raw, options = {}) {
  const home = options.home ?? homedir()
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const problems = []

  const settings = {
    serverUrl: normalizeServerUrl(source.serverUrl, problems),
    token: typeof source.token === 'string' ? source.token.trim() : '',
    tokenFile: expandHome(source.tokenFile, home),
    defaultProject: sanitizeProjectName(source.defaultProject ?? DEFAULTS.defaultProject),
    projectMap: normalizeProjectMap(source.projectMap, problems),
    requestTimeoutMs: clampInt(source.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 500, 120_000),
    contextPollMs: clampInt(source.contextPollMs, DEFAULTS.contextPollMs, 60_000, 3_600_000),
    indexMaxItems: clampInt(source.indexMaxItems, DEFAULTS.indexMaxItems, 1, 20),
    indexMaxChars: clampInt(source.indexMaxChars, DEFAULTS.indexMaxChars, 200, 4000),
    searchResults: clampInt(source.searchResults, DEFAULTS.searchResults, 1, 20),
    searchMaxChars: clampInt(source.searchMaxChars, DEFAULTS.searchMaxChars, 500, 20_000),
    digestMaxChars: clampInt(source.digestMaxChars, DEFAULTS.digestMaxChars, 2000, 40_000),
    digestMaxEntries: clampInt(source.digestMaxEntries, DEFAULTS.digestMaxEntries, 5, 500),
    maxBacklogDays: clampInt(source.maxBacklogDays, DEFAULTS.maxBacklogDays, 1, 365),
    consolidationEnabled:
      typeof source.consolidationEnabled === 'boolean'
        ? source.consolidationEnabled
        : DEFAULTS.consolidationEnabled,
    claimIntervalHours: clampNumber(
      source.claimIntervalHours,
      DEFAULTS.claimIntervalHours,
      0.25,
      24 * 30,
    ),
    sessionsRoot: expandHome(source.sessionsRoot ?? DEFAULTS.sessionsRoot, home),
    transcriptMaxBytes: clampInt(
      source.transcriptMaxBytes,
      DEFAULTS.transcriptMaxBytes,
      1024,
      64 * 1024 * 1024,
    ),
    transcriptMaxCharsPerEntry: clampInt(
      source.transcriptMaxCharsPerEntry,
      DEFAULTS.transcriptMaxCharsPerEntry,
      200,
      4000,
    ),
    problems,
  }

  if (settings.token === '' && settings.tokenFile === '') {
    const envToken = typeof process.env.DSH_MEMORY_TOKEN === 'string' ? process.env.DSH_MEMORY_TOKEN.trim() : ''
    if (envToken === '') {
      problems.push(
        'no token configured: set `token`, `tokenFile`, or DSH_MEMORY_TOKEN; memory tools will fail until then',
      )
    }
  }
  return settings
}
