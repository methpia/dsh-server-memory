/**
 * DSH session transcript reader for the consolidation flow.
 *
 * DESIGN.md 8.2: the plugin reads local transcripts, keeps human messages and
 * the *final* assistant reply of each turn, drops tool calls / reasoning / long
 * code blocks, filters by project, and never writes the transcript anywhere.
 *
 * The format (verified against DSH `session.v4.jsonl.zstd`) is one JSON event
 * per line:
 *
 *   {"type":"session","version":4,"id":"…","cwd":"D:\\dev","delegationDepth":0}
 *   {"type":"user/message","time":<ms>,"data":{"content":[…],"source":{"kind":"user"}}}
 *   {"type":"assistant/message","time":<ms>,"data":{"turn":1,"message":{"content":[…]}}}
 *
 * Unknown events, unknown formats, corrupt files and oversized transcripts are
 * skipped and reported, never thrown (DESIGN.md 12.2-3).
 *
 * @module dsh-memory/transcripts
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { projectFromDirectory } from './project.js'
import { decompressZstdFrames } from './zstd.js'

const SESSION_FILE_RE = /^session(\.[\w-]+)*\.jsonl(\.zstd)?$/i
const MAX_WALK_DEPTH = 3
const DEFAULT_MAX_CHARS_PER_ENTRY = 1200

/** @typedef {{at: number, role: 'user'|'assistant', text: string}} TranscriptEntry */

/** Human-authored message sources. Everything else is harness-generated noise. */
const HUMAN_SOURCES = new Set(['user', 'user-question-answer'])

/** Clamp a string, marking the cut so the model knows text is missing. */
export function clampText(text, max) {
  if (text.length <= max) return text
  if (max <= 1) return '…'
  return `${text.slice(0, max - 1)}…`
}

/**
 * Collapse fenced code blocks longer than `maxLines` to head/tail (DESIGN.md 8.2-3).
 * @param {string} text
 * @param {{maxLines?: number, keep?: number}} [options]
 */
export function truncateCodeBlocks(text, options = {}) {
  const maxLines = options.maxLines ?? 20
  const keep = options.keep ?? 3
  return text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (match, language, body) => {
    const lines = body.replace(/\n$/, '').split('\n')
    if (lines.length <= maxLines) return match
    const head = lines.slice(0, keep)
    const tail = lines.slice(-keep)
    const omitted = lines.length - keep * 2
    return ['```' + language, ...head, `…（省略 ${omitted} 行）…`, ...tail, '```'].join('\n')
  })
}

/** Join the text blocks of one message; ignore reasoning, tool calls and images. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text.trim())
    }
  }
  return parts.join('\n')
}

/** Read the session header event (first `type: "session"` record). */
export function sessionMeta(events) {
  for (const event of events) {
    if (event !== null && typeof event === 'object' && event.type === 'session') {
      return {
        id: typeof event.id === 'string' ? event.id : '',
        cwd: typeof event.cwd === 'string' ? event.cwd : '',
        createdAt: Number.isFinite(event.createdAt) ? event.createdAt : 0,
        delegationDepth: Number.isFinite(event.delegationDepth) ? event.delegationDepth : 0,
        version: Number.isFinite(event.version) ? event.version : 0,
      }
    }
  }
  return undefined
}

/**
 * Extract the digest-ready entries of one session.
 *
 * Human messages are taken as-is. For assistant replies, only the last message
 * of each turn that carries text counts as the answer; intermediate steps are
 * tool-call chatter and are dropped.
 *
 * @param {any[]} events
 * @param {{sinceMs?: number, untilMs?: number, maxCharsPerEntry?: number}} [options]
 * @returns {TranscriptEntry[]}
 */
export function extractEntries(events, options = {}) {
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : -Infinity
  const untilMs = Number.isFinite(options.untilMs) ? options.untilMs : Infinity
  const maxCharsPerEntry = options.maxCharsPerEntry ?? DEFAULT_MAX_CHARS_PER_ENTRY
  /** @type {TranscriptEntry[]} */
  const entries = []
  /** @type {Map<string, TranscriptEntry>} */
  const finalReplyByTurn = new Map()

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const at = Number(event.time)
    if (!Number.isFinite(at)) continue
    if (at <= sinceMs || at > untilMs) continue

    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind
      if (!HUMAN_SOURCES.has(kind)) continue
      const text = textOfContent(event.data?.content)
      if (text === '') continue
      entries.push({ at, role: 'user', text: clampText(truncateCodeBlocks(text), maxCharsPerEntry) })
      continue
    }

    if (event.type === 'assistant/message') {
      const turn = event.data?.turn
      if (turn === undefined || turn === null) continue
      const text = textOfContent(event.data?.message?.content)
      if (text === '') continue
      finalReplyByTurn.set(String(turn), {
        at,
        role: 'assistant',
        text: clampText(truncateCodeBlocks(text), maxCharsPerEntry),
      })
    }
  }

  entries.push(...finalReplyByTurn.values())
  entries.sort((left, right) => left.at - right.at)
  return entries
}

/**
 * Walk `sessionsRoot` for session transcript files (depth-limited, no symlink
 * following beyond the root). Returns the newest file list first.
 */
export async function findSessionFiles(sessionsRoot, fsImpl = {}) {
  const readdirImpl = fsImpl.readdirImpl ?? readdir
  const statImpl = fsImpl.statImpl ?? stat
  /** @type {Array<{file: string, mtimeMs: number, size: number}>} */
  const files = []

  async function walk(directory, depth) {
    if (depth > MAX_WALK_DEPTH) return
    let entries
    try {
      entries = await readdirImpl(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile() || !SESSION_FILE_RE.test(entry.name)) continue
      try {
        const info = await statImpl(path)
        files.push({ file: path, mtimeMs: info.mtimeMs ?? 0, size: info.size ?? 0 })
      } catch {
        // File disappeared between readdir and stat: ignore it.
      }
    }
  }

  await walk(sessionsRoot, 0)
  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return files
}

/**
 * Read and parse one transcript. Throws for oversized or undecodable files so
 * the caller can record a warning and continue with the next session.
 */
export async function readSessionFile(file, options = {}) {
  const statImpl = options.statImpl ?? stat
  const readFileImpl = options.readFileImpl ?? readFile
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const info = await statImpl(file)
  if (info.size > maxBytes) {
    throw new Error(`转录文件过大（${info.size} 字节，上限 ${maxBytes}）`)
  }
  const raw = await readFileImpl(file)
  const isZstd = file.toLowerCase().endsWith('.zstd')
  const decoded = isZstd
    ? decompressZstdFrames(raw)
    : { text: raw.toString('utf8'), frames: 1, truncated: false }

  const events = []
  let badLines = 0
  for (const line of decoded.text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      badLines += 1
    }
  }
  return { events, badLines, truncated: decoded.truncated, bytes: info.size }
}

/**
 * Collect the digest input for one project.
 *
 * @param {object} options
 * @param {string} options.sessionsRoot
 * @param {string} options.project
 * @param {number|null} options.sinceMs
 * @param {number} options.untilMs
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxCharsPerEntry]
 * @param {Record<string, string>} [options.projectMap]
 * @param {string} [options.defaultProject]
 * @param {object} [options.fs]
 * @returns {Promise<{entries: TranscriptEntry[], sessions: number, files: number, warnings: string[]}>}
 */
export async function collectDigestInput(options) {
  const {
    sessionsRoot,
    project,
    sinceMs = null,
    untilMs = Date.now(),
    maxBytes = 8 * 1024 * 1024,
    maxCharsPerEntry = DEFAULT_MAX_CHARS_PER_ENTRY,
    projectMap = {},
    defaultProject = 'default',
    fs = {},
  } = options

  const warnings = []
  const entries = []
  const sessionIds = new Set()
  const files = await findSessionFiles(sessionsRoot, fs)

  for (const file of files) {
    // The file's mtime is at or after its last event, so an older mtime cannot
    // hide anything we need.
    if (sinceMs !== null && Number.isFinite(sinceMs) && file.mtimeMs < sinceMs) continue

    let decoded
    try {
      decoded = await readSessionFile(file.file, {
        statImpl: fs.statImpl,
        readFileImpl: fs.readFileImpl,
        maxBytes,
      })
    } catch (error) {
      warnings.push(`${file.file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (decoded.truncated) warnings.push(`${file.file}: 转录不完整，已读取可解码部分`)
    if (decoded.badLines > 0) warnings.push(`${file.file}: ${decoded.badLines} 行无法解析，已跳过`)

    const meta = sessionMeta(decoded.events)
    if (meta === undefined || meta.cwd === '') {
      warnings.push(`${file.file}: 缺少会话头，已跳过`)
      continue
    }
    if (meta.delegationDepth > 0) continue
    const sessionProject = projectFromDirectory(meta.cwd, { projectMap, defaultProject })
    if (sessionProject !== project) continue

    const found = extractEntries(decoded.events, { sinceMs, untilMs, maxCharsPerEntry })
    if (found.length === 0) continue
    sessionIds.add(meta.id === '' ? file.file : meta.id)
    entries.push(...found)
  }

  entries.sort((left, right) => left.at - right.at)
  return { entries, sessions: sessionIds.size, files: files.length, warnings }
}
