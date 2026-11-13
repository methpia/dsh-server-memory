#!/usr/bin/env node
/**
 * WorkBuddy `SessionStart` hook.
 *
 * Injects the project directory (ids, labels, aliases, counts) and states the
 * rule that makes keyword resolution work: the dated working directory is not
 * the project. If the cwd path itself names a project, that project is recorded
 * for the session too.
 *
 * Failure policy: any error prints nothing and exits 0, so a memory outage can
 * never block a WorkBuddy conversation.
 *
 * @module dsh-server-memory/workbuddy/session-start
 */

import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoryClient } from '../../plugin/lib/client.js'
import { loadWorkbuddyConfig } from '../lib/config.mjs'
import { buildSessionStartContext, hookOutput } from '../lib/hooks.mjs'
import { resolveFromText } from '../lib/project.mjs'
import { loadState, remember, saveState } from '../lib/state.mjs'
import { debugLog, emitHookOutput, readStdinJson } from '../lib/stdio.mjs'

/**
 * Build this hook's output.
 * @param {any} payload WorkBuddy hook payload (`session_id`, `cwd`, …).
 * @param {{env?: NodeJS.ProcessEnv, client?: any, settings?: any}} [options]
 * @returns {Promise<object|undefined>} hook response, or undefined to stay silent.
 */
export async function runSessionStart(payload, options = {}) {
  const env = options.env ?? process.env
  const settings = options.settings ?? (await loadWorkbuddyConfig(env))
  const client = options.client ?? new MemoryClient(settings)
  const cwd = typeof payload?.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd()
  const sessionId = payload?.session_id ?? payload?.sessionId
  const transcriptPath =
    typeof payload?.transcript_path === 'string' ? payload.transcript_path : undefined

  const state = await loadState(settings.stateFile)

  let projects = []
  let available = true
  try {
    const payloadProjects = await client.listProjects()
    projects = Array.isArray(payloadProjects?.projects) ? payloadProjects.projects : []
  } catch (error) {
    available = false
    debugLog(`project list unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  let cwdProject
  if (available) {
    const match = await resolveFromText(client, cwd)
    if (match !== undefined) cwdProject = match.project
    remember(state, { sessionId, cwd, transcriptPath, project: cwdProject })
    await saveState(settings.stateFile, state).catch((error) => debugLog(String(error)))
  }

  return hookOutput(
    'SessionStart',
    buildSessionStartContext({ projects, cwd, cwdProject, available }),
  )
}

async function main() {
  const payload = await readStdinJson()
  emitHookOutput(await runSessionStart(payload))
}

const invokedDirectly =
  process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main()
    .catch((error) => debugLog(`session-start hook failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      process.exitCode = 0
    })
}
