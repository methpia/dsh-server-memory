/**
 * Configuration for the WorkBuddy adapter.
 *
 * WorkBuddy runs its MCP server and hooks as separate short-lived processes, so
 * everything is read from the environment or one small JSON file:
 *
 *   ~/.config/dsh-memory/workbuddy.json
 *   {
 *     "serverUrl": "http://192.168.5.5:8788",
 *     "tokenFile": "~/.config/dsh-memory/token",
 *     "defaultProject": "default",
 *     "requestTimeoutMs": 4000
 *   }
 *
 * `DSH_MEMORY_CONFIG`, `DSH_MEMORY_URL`, `DSH_MEMORY_TOKEN` and
 * `DSH_MEMORY_TOKEN_FILE` override the file. The token itself is never passed on
 * a command line: MCP and hook commands are visible in `~/.workbuddy`.
 *
 * @module dsh-server-memory/workbuddy/config
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expandHome, normalizeConfig } from '../../plugin/lib/config.js'

export const CONFIG_DIR = join(homedir(), '.config', 'dsh-memory')
export const DEFAULT_CONFIG_PATH = join(CONFIG_DIR, 'workbuddy.json')
export const DEFAULT_STATE_PATH = join(CONFIG_DIR, 'workbuddy-state.json')

/** Read a JSON file, tolerating a UTF-8 BOM and a missing file. */
export async function readJsonFile(path) {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<import('../../plugin/lib/config.js').MemorySettings & {stateFile: string, configPath: string}>}
 */
export async function loadWorkbuddyConfig(env = process.env) {
  const configPath = expandHome(env.DSH_MEMORY_CONFIG || DEFAULT_CONFIG_PATH)
  const stored = (await readJsonFile(configPath)) ?? {}
  const settings = normalizeConfig(
    {
      serverUrl: env.DSH_MEMORY_URL ?? stored.serverUrl,
      token: env.DSH_MEMORY_TOKEN ?? stored.token,
      tokenFile: env.DSH_MEMORY_TOKEN_FILE ?? stored.tokenFile ?? '~/.config/dsh-memory/token',
      defaultProject: stored.defaultProject,
      requestTimeoutMs: env.DSH_MEMORY_TIMEOUT_MS ?? stored.requestTimeoutMs ?? 4000,
      indexMaxItems: stored.indexMaxItems,
      indexMaxChars: stored.indexMaxChars,
    },
    { home: homedir() },
  )
  return {
    ...settings,
    configPath,
    stateFile: expandHome(stored.stateFile || DEFAULT_STATE_PATH),
    projectsRoot: expandHome(stored.projectsRoot || '~/.workbuddy/projects'),
    dailyConsolidationHint:
      typeof stored.dailyConsolidationHint === 'boolean' ? stored.dailyConsolidationHint : true,
  }
}

/** Write JSON with a trailing newline, creating the directory when needed. */
export async function writeJsonFile(path, value) {
  const { mkdir, writeFile, rename } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
