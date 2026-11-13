/**
 * Small shared state for the WorkBuddy adapter.
 *
 * Hooks and the MCP server are different processes, so the project a
 * conversation has been talking about lives in one JSON file:
 *
 *   {
 *     "version": 1,
 *     "sessions": { "<session_id>": { "project": "cheyidao", "injected": "cheyidao",
 *                                     "hinted": true, "cwd": "…", "at": 1731… } },
 *     "cwds": { "<cwd>": { "project": "cheyidao", "at": 1731… } },
 *     "recent": { "project": "cheyidao", "at": 1731… }
 *   }
 *
 * Writes are best-effort and atomic; a lost update only costs one extra
 * `memory_projects`/index injection, never correctness of stored memory.
 *
 * @module dsh-server-memory/workbuddy/state
 */

import { readJsonFile, writeJsonFile } from './config.mjs'

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 500

/** @returns {Promise<{version: number, sessions: Record<string, any>, cwds: Record<string, any>, recent?: {project: string, at: number}}>} */
export async function loadState(path) {
  const stored = await readJsonFile(path)
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return { version: 1, sessions: {}, cwds: {} }
  }
  return {
    version: 1,
    sessions: stored.sessions ?? {},
    cwds: stored.cwds ?? {},
    recent: stored.recent,
  }
}

/** Drop entries older than a week and keep the state file bounded. */
export function pruneState(state, now = Date.now()) {
  const sessions = {}
  const cwds = {}
  for (const [key, value] of Object.entries(state.sessions ?? {})) {
    if (value && Number.isFinite(value.at) && now - value.at < MAX_AGE_MS) sessions[key] = value
  }
  for (const [key, value] of Object.entries(state.cwds ?? {})) {
    if (value && Number.isFinite(value.at) && now - value.at < MAX_AGE_MS) cwds[key] = value
  }
  const trim = (entries) =>
    Object.fromEntries(
      Object.entries(entries)
        .sort((left, right) => (right[1]?.at ?? 0) - (left[1]?.at ?? 0))
        .slice(0, MAX_ENTRIES),
    )
  return {
    version: 1,
    sessions: trim(sessions),
    cwds: trim(cwds),
    recent: state.recent,
  }
}

/**
 * Record what a conversation is about. Called by hooks (which know the session
 * id and transcript path) and by the MCP server (which only knows the working
 * directory).
 *
 * @param {any} state
 * @param {{sessionId?: string, cwd?: string, project?: string, transcriptPath?: string,
 *          injected?: string, hinted?: boolean, hintedConsolidation?: boolean}} input
 */
export function remember(state, input, now = Date.now()) {
  const { sessionId, cwd, project, transcriptPath, injected, hinted, hintedConsolidation } = input
  if (project) {
    state.recent = { project, at: now }
    if (cwd) state.cwds[cwd] = { project, at: now }
  }
  if (sessionId) {
    const entry = state.sessions[sessionId] ?? {}
    state.sessions[sessionId] = {
      ...entry,
      cwd: cwd ?? entry.cwd,
      project: project ?? entry.project,
      transcriptPath: transcriptPath ?? entry.transcriptPath,
      injected: injected === undefined ? entry.injected : injected,
      hinted: hinted === undefined ? entry.hinted : hinted,
      hintedConsolidation:
        hintedConsolidation === undefined ? entry.hintedConsolidation : hintedConsolidation,
      at: now,
    }
  }
  return state
}

/** Project previously recorded for this cwd, if it is still fresh. */
export function projectForCwd(state, cwd, now = Date.now(), maxAgeMs = 12 * 60 * 60 * 1000) {
  if (!cwd) return undefined
  const entry = state.cwds[cwd]
  if (entry && Number.isFinite(entry.at) && now - entry.at < maxAgeMs) return entry.project
  return undefined
}

/** The last project any WorkBuddy conversation resolved, if still fresh. */
export function recentProject(state, now = Date.now(), maxAgeMs = 12 * 60 * 60 * 1000) {
  const entry = state.recent
  if (entry && Number.isFinite(entry.at) && now - entry.at < maxAgeMs) return entry.project
  return undefined
}

export async function saveState(path, state) {
  await writeJsonFile(path, pruneState(state))
}
