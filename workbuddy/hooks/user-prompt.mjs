#!/usr/bin/env node
/**
 * WorkBuddy `UserPromptSubmit` hook.
 *
 * Resolves the project from the user's words using the server's alias table
 * ("车易到" -> cheyidao). The first time a conversation resolves to a project,
 * that project's compact index is injected; later turns stay quiet instead of
 * paying for the index every time. If nothing resolves on the first prompt, the
 * project directory is shown once so the model can pick or ask.
 *
 * Failure policy: print nothing, exit 0.
 *
 * @module dsh-server-memory/workbuddy/user-prompt
 */

import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoryClient } from '../../plugin/lib/client.js'
import { loadWorkbuddyConfig } from '../lib/config.mjs'
import { buildNoProjectHint, buildProjectInjection, hookOutput } from '../lib/hooks.mjs'
import { resolveFromText } from '../lib/project.mjs'
import { loadState, remember, saveState } from '../lib/state.mjs'
import { debugLog, emitHookOutput, readStdinJson } from '../lib/stdio.mjs'

/**
 * Build this hook's output.
 * @param {any} payload WorkBuddy hook payload (`prompt`, `session_id`, `cwd`).
 * @param {{env?: NodeJS.ProcessEnv, client?: any, settings?: any, now?: () => number}} [options]
 * @returns {Promise<object|undefined>} hook response, or undefined to stay silent.
 */
export async function runUserPrompt(payload, options = {}) {
  const prompt =
    typeof payload?.prompt === 'string'
      ? payload.prompt
      : typeof payload?.user_prompt === 'string'
        ? payload.user_prompt
        : ''
  if (prompt.trim() === '') return undefined

  const env = options.env ?? process.env
  const settings = options.settings ?? (await loadWorkbuddyConfig(env))
  const client = options.client ?? new MemoryClient(settings)
  const sessionId = payload?.session_id ?? payload?.sessionId
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : undefined
  const transcriptPath =
    typeof payload?.transcript_path === 'string' ? payload.transcript_path : undefined

  const state = await loadState(settings.stateFile)
  const session = sessionId ? state.sessions[sessionId] : undefined
  const match = await resolveFromText(client, prompt)

  if (match !== undefined) {
    remember(state, { sessionId, cwd, transcriptPath, project: match.project })
    if (session?.injected === match.project) {
      await saveState(settings.stateFile, state).catch((error) => debugLog(String(error)))
      return undefined
    }

    let context
    try {
      context = await client.getContext(match.project, {
        limit: settings.indexMaxItems,
        maxChars: settings.indexMaxChars,
      })
    } catch (error) {
      // Do not mark the project as injected: retry on the next prompt.
      debugLog(`index fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      await saveState(settings.stateFile, state).catch(() => {})
      return undefined
    }

    const snapshot = {
      project: match.project,
      items: Array.isArray(context?.items) ? context.items : [],
      total: Number.isFinite(context?.total) ? context.total : undefined,
      watermark: context?.watermark ?? {},
      consolidation: context?.consolidation ?? {},
      fetchedAt: (options.now ?? Date.now)(),
    }
    let text = buildProjectInjection({
      project: match.project,
      label: match.label,
      matched: match.matched,
      snapshot,
      settings,
    })

    // Daily auxiliary: mention the due consolidation window once per session.
    // Manual consolidation stays the primary path (`memory_consolidate`).
    let hintedConsolidation = session?.hintedConsolidation === true
    if (
      !hintedConsolidation &&
      settings.dailyConsolidationHint !== false &&
      settings.consolidationEnabled !== false &&
      snapshot.consolidation?.due === true
    ) {
      text += `\n记忆聚合已到期：说“整理记忆”或调用 memory_consolidate（project: ${match.project}）即可把本项目近期流水整理成记忆。`
      hintedConsolidation = true
    }

    remember(state, {
      sessionId,
      cwd,
      transcriptPath,
      injected: match.project,
      hinted: true,
      hintedConsolidation,
    })
    await saveState(settings.stateFile, state).catch((error) => debugLog(String(error)))
    return hookOutput('UserPromptSubmit', text)
  }

  // No project in this prompt. If the session already has one, stay quiet; the
  // first unmatched prompt shows the directory once.
  if (session?.project !== undefined || session?.hinted === true) {
    await saveState(settings.stateFile, state).catch((error) => debugLog(String(error)))
    return undefined
  }

  let projects = []
  try {
    const payloadProjects = await client.listProjects()
    projects = Array.isArray(payloadProjects?.projects) ? payloadProjects.projects : []
  } catch (error) {
    debugLog(`project list unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const hint = buildNoProjectHint(projects)
  if (hint === '') return undefined
  remember(state, { sessionId, cwd, transcriptPath, hinted: true })
  await saveState(settings.stateFile, state).catch((error) => debugLog(String(error)))
  return hookOutput('UserPromptSubmit', hint)
}

async function main() {
  const payload = await readStdinJson()
  emitHookOutput(await runUserPrompt(payload))
}

const invokedDirectly =
  process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main()
    .catch((error) => debugLog(`user-prompt hook failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      process.exitCode = 0
    })
}
