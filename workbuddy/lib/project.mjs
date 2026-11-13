/**
 * Project resolution for WorkBuddy.
 *
 * WorkBuddy creates a fresh dated working directory for every conversation
 * (`D:\项目成果\2026-06-30-20-54-55`), so the directory can never be the project
 * identity. Resolution is therefore, in order:
 *
 *   1. an explicit `project` argument from the model;
 *   2. the conversation text ("车易到…") resolved by the server's alias table;
 *   3. the session/cwd memory written by earlier hooks in this conversation;
 *   4. the last project any WorkBuddy conversation resolved (12h window);
 *   5. `defaultProject`.
 *
 * Every step degrades quietly: if the service is down, tools still answer, the
 * hook injects nothing, and the conversation continues.
 *
 * @module dsh-server-memory/workbuddy/project
 */

import { projectForCwd, recentProject } from './state.mjs'

/**
 * Ask the server which project a piece of text names.
 * @returns {Promise<{project: string, label?: string, matched?: string, candidates?: any[]} | undefined>}
 */
export async function resolveFromText(client, text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    const result = await client.resolve(text)
    if (result !== null && typeof result === 'object' && typeof result.project === 'string') {
      return {
        project: result.project,
        label: result.label ?? undefined,
        matched: result.matched ?? undefined,
        candidates: Array.isArray(result.candidates) ? result.candidates : [],
      }
    }
  } catch {
    // Service down or an older server without /api/resolve: fall through.
  }
  return undefined
}

/**
 * @param {object} input
 * @param {import('../../lib/client.js').MemoryClient} input.client
 * @param {string} [input.explicit]
 * @param {string} [input.text] Conversation text to match against aliases.
 * @param {any} input.state Adapter state (see state.mjs).
 * @param {string} [input.cwd]
 * @param {string} [input.sessionId]
 * @param {string} input.defaultProject
 * @param {number} [input.now]
 * @returns {Promise<{project: string, source: string, label?: string, matched?: string, candidates?: any[]}>}
 */
export async function resolveProject(input) {
  const {
    client,
    explicit,
    text,
    state,
    cwd,
    sessionId,
    defaultProject,
    now = Date.now(),
  } = input

  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return { project: explicit.trim(), source: 'explicit' }
  }

  const fromText = await resolveFromText(client, text)
  if (fromText !== undefined) {
    return { ...fromText, source: 'text' }
  }

  const session = sessionId ? state?.sessions?.[sessionId] : undefined
  if (session && typeof session.project === 'string' && session.project !== '') {
    return { project: session.project, source: 'session' }
  }

  const fromCwd = projectForCwd(state, cwd, now)
  if (fromCwd !== undefined) return { project: fromCwd, source: 'cwd' }

  const recent = recentProject(state, now)
  if (recent !== undefined) return { project: recent, source: 'recent' }

  return { project: defaultProject, source: 'default' }
}
