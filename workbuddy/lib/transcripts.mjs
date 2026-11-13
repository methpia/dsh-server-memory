/**
 * WorkBuddy transcript reader and digest collector.
 *
 * WorkBuddy keeps plain JSONL per conversation:
 *
 *   ~/.workbuddy/projects/<cwd-encoded>/<session-id>.jsonl
 *   {"type":"message","role":"user","content":[{"type":"input_text","text":"…"}],
 *    "timestamp":…,"sessionId":"…","cwd":"…","providerData":{"startsNewUserRequest":true}}
 *
 * Compared with DSH transcripts there is no turn/step record, but
 * `providerData.startsNewUserRequest` marks a new user request, so the final
 * assistant reply of a turn is simply the last assistant message before the
 * next user request.
 *
 * @module dsh-server-memory/workbuddy/transcripts
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_DEFAULT_BYTES = 32 * 1024 * 1024
const MAX_DEFAULT_CHARS_PER_ENTRY = 1200
const REMINDER_RE = /<(system-reminder|hook_prompt|task-notification|user_info|identity_context)\b[\s\S]*?<\/\1>/g

/** Default WorkBuddy data directory. */
export function workbuddyHome() {
  return join(homedir(), '.workbuddy')
}

/** Collapse fenced code blocks longer than `maxLines` to head/tail. */
export function truncateCodeBlocks(text, maxLines = 20, keep = 3) {
  return text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (match, language, body) => {
    const lines = body.replace(/\n$/, '').split('\n')
    if (lines.length <= maxLines) return match
    const head = lines.slice(0, keep)
    const tail = lines.slice(-keep)
    return ['```' + language, ...head, `…（省略 ${lines.length - keep * 2} 行）…`, ...tail, '```'].join('\n')
  })
}

export function clampText(text, max) {
  if (text.length <= max) return text
  return max <= 1 ? '…' : `${text.slice(0, max - 1)}…`
}

/** Remove WorkBuddy's injected system-reminder blocks from a user message. */
export function stripSystemReminders(text) {
  return String(text ?? '')
    .replace(REMINDER_RE, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** Join the text blocks of one message. */
export function textOfMessage(event) {
  const parts = []
  for (const block of event?.content ?? []) {
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') {
      if (block.text.trim() !== '') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** Read one transcript (bounded), returning parsed events. */
export async function readTranscript(file, options = {}) {
  const statImpl = options.statImpl ?? stat
  const readFileImpl = options.readFileImpl ?? readFile
  const maxBytes = options.maxBytes ?? MAX_DEFAULT_BYTES
  const info = await statImpl(file)
  if (info.size > maxBytes) {
    throw new Error(`转录文件过大（${info.size} 字节，上限 ${maxBytes}）`)
  }
  const raw = await readFileImpl(file)
  const events = []
  let badLines = 0
  for (const line of raw.toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      badLines += 1
    }
  }
  return { events, badLines, bytes: info.size }
}

/** Session metadata from the transcript itself. */
export function transcriptMeta(events, file) {
  let sessionId = ''
  let cwd = ''
  let title = ''
  for (const event of events) {
    if (sessionId === '' && typeof event?.sessionId === 'string') sessionId = event.sessionId
    if (cwd === '' && typeof event?.cwd === 'string') cwd = event.cwd
    if (title === '' && event?.type === 'ai-title' && typeof event.aiTitle === 'string') title = event.aiTitle
    if (event?.type === 'session-meta') {
      const entries = event?.meta?.['codebuddy.ai/sessionTitle']
      if (title === '' && Array.isArray(entries)) {
        const found = entries.find((entry) => typeof entry?.aiTitle === 'string')
        if (found) title = found.aiTitle
      }
    }
  }
  return {
    sessionId,
    cwd,
    title,
    file,
  }
}

/**
 * Turn a WorkBuddy transcript into digest entries.
 * User messages keep their text with reminders removed; each turn contributes
 * only its final assistant message.
 *
 * @param {any[]} events
 * @param {{sinceMs?: number, untilMs?: number, maxCharsPerEntry?: number}} [options]
 * @returns {Array<{at: number, role: 'user'|'assistant', text: string}>}
 */
export function extractEntries(events, options = {}) {
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : -Infinity
  const untilMs = Number.isFinite(options.untilMs) ? options.untilMs : Infinity
  const maxChars = options.maxCharsPerEntry ?? MAX_DEFAULT_CHARS_PER_ENTRY
  const entries = []
  let pendingAssistant
  let currentTurnSeen = false

  const flush = () => {
    if (pendingAssistant !== undefined) {
      entries.push(pendingAssistant)
      pendingAssistant = undefined
    }
  }
  const accept = (at) => at > sinceMs && at <= untilMs

  for (const event of events) {
    if (event?.type !== 'message') continue
    const at = Number(event.timestamp)
    if (!Number.isFinite(at)) continue
    const role = event.role
    const raw = textOfMessage(event)

    if (role === 'user') {
      const text = stripSystemReminders(raw)
      const startsNew = event?.providerData?.startsNewUserRequest === true
      if (startsNew) {
        flush()
        currentTurnSeen = true
      }
      if (text === '') continue
      if (!accept(at)) continue
      entries.push({
        at,
        role: 'user',
        text: clampText(truncateCodeBlocks(text), maxChars),
      })
      continue
    }

    if (role === 'assistant') {
      if (raw.trim() === '') continue
      // Keep the latest assistant message of the current turn; the next user
      // request flushes it as the turn's final reply.
      if (accept(at)) {
        pendingAssistant = {
          at,
          role: 'assistant',
          text: clampText(truncateCodeBlocks(raw.trim()), maxChars),
        }
      }
    }
  }
  flush()
  entries.sort((left, right) => left.at - right.at)
  return entries
}

/** List transcript files under a WorkBuddy projects root. */
export async function listTranscriptFiles(projectsRoot, fsImpl = {}) {
  const readdirImpl = fsImpl.readdirImpl ?? readdir
  const statImpl = fsImpl.statImpl ?? stat
  const files = []
  let projectDirs = []
  try {
    projectDirs = await readdirImpl(projectsRoot, { withFileTypes: true })
  } catch {
    return files
  }
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const directory = join(projectsRoot, projectDir.name)
    let entries = []
    try {
      entries = await readdirImpl(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const file = join(directory, entry.name)
      try {
        const info = await statImpl(file)
        files.push({ file, sessionId: entry.name.replace(/\.jsonl$/, ''), mtimeMs: info.mtimeMs ?? 0, size: info.size ?? 0 })
      } catch {
        // File removed between readdir and stat.
      }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

/** Find the transcript for a session id, falling back to a directory scan. */
export async function findTranscript(projectsRoot, sessionId, fsImpl = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const files = await listTranscriptFiles(projectsRoot, fsImpl)
  return files.find((entry) => entry.sessionId === sessionId)?.file
}

/**
 * Collect digest entries for one project from the sessions the hooks recorded.
 *
 * @param {object} input
 * @param {string} input.project
 * @param {any} input.state Adapter state (`sessions[sessionId].project`).
 * @param {string} [input.projectsRoot]
 * @param {number|null} [input.sinceMs]
 * @param {number} [input.untilMs]
 * @param {number} [input.maxBytes]
 * @param {number} [input.maxCharsPerEntry]
 */
export async function collectDigestForProject(input) {
  const projectsRoot = input.projectsRoot ?? join(workbuddyHome(), 'projects')
  const sinceMs = Number.isFinite(input.sinceMs) ? input.sinceMs : null
  const untilMs = Number.isFinite(input.untilMs) ? input.untilMs : Date.now()
  const entries = []
  const warnings = []
  let sessions = 0
  const seen = new Set()

  for (const [sessionId, session] of Object.entries(input.state?.sessions ?? {})) {
    if (session?.project !== input.project) continue
    let file = typeof session.transcriptPath === 'string' ? session.transcriptPath : undefined
    if (file === undefined) file = await findTranscript(projectsRoot, sessionId)
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    try {
      const decoded = await readTranscript(file, { maxBytes: input.maxBytes })
      if (decoded.badLines > 0) warnings.push(`${file}: ${decoded.badLines} 行无法解析，已跳过`)
      const found = extractEntries(decoded.events, {
        sinceMs,
        untilMs,
        maxCharsPerEntry: input.maxCharsPerEntry,
      })
      if (found.length === 0) continue
      sessions += 1
      entries.push(...found)
    } catch (error) {
      warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  entries.sort((left, right) => left.at - right.at)
  return { entries, sessions, warnings }
}
