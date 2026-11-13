#!/usr/bin/env node
/**
 * MCP server for WorkBuddy (stdio transport, JSON-RPC 2.0, newline-delimited).
 *
 * This is the second client of the same memoryd service as the DSH plugin. It
 * exposes `memory_search` / `memory_save` / `memory_forget` / `memory_projects`
 * and resolves the project from an explicit argument, the conversation text
 * (server-side alias table), or what earlier hooks recorded for this session.
 *
 * Protocol notes:
 *   - stdout carries JSON-RPC only; diagnostics go to stderr;
 *   - a bad request never kills the process: it answers with a JSON-RPC error;
 *   - a memory-service outage turns into a tool result with `isError: true`.
 *
 * Run it through `~/.workbuddy/mcp.json` (see `install.mjs`), not by hand.
 *
 * @module dsh-server-memory/workbuddy/mcp-server
 */

import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoryClient, MemoryError, describeMemoryError } from '../plugin/lib/client.js'
import { clampInt } from '../plugin/lib/config.js'
import { planDigest } from '../plugin/lib/digest.js'
import { formatLocalDateTime, toSingleLine } from '../plugin/lib/prompt.js'
import { loadWorkbuddyConfig } from './lib/config.mjs'
import { resolveProject } from './lib/project.mjs'
import { loadState, remember, saveState } from './lib/state.mjs'
import { collectDigestForProject } from './lib/transcripts.mjs'

const SERVER_INFO = { name: 'dsh-memory', version: '0.3.0' }
const PROTOCOL_FALLBACK = '2024-11-05'
const MAX_TEXT_CHARS = 4000
const MAX_NOTES = 50

/** Tool schemas advertised through `tools/list`. */
export const TOOLS = [
  {
    name: 'memory_search',
    description:
      '检索本机记忆服务里的项目长期记忆正文。用户提到某个项目（名称或别名）时用 project 指定；省略时按对话内容自动识别。返回最相关的 1–8 条。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词：项目术语、模块名、功能名或短语。' },
        project: {
          type: 'string',
          description: '项目 id（如 cheyidao）。省略时按对话关键词与当前会话识别。',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 8。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_save',
    description:
      '把用户明确要求记住的内容写入项目长期记忆。只在用户说“记住/记一下/别忘了”时使用；不要主动记录对话。写入前先确定 project：用户点名了项目就用它，否则省略让服务端从内容识别。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '单条记忆，不超过 4000 字符；与 notes 二选一。' },
        notes: {
          type: 'array',
          description: '批量记忆（最多 50 条）。',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'text 的检索标签。' },
        project: {
          type: 'string',
          description: '项目 id。省略时按内容关键词识别；无法识别则写入 defaultProject。',
        },
        consolidationId: {
          type: 'string',
          description: 'memory_consolidate 返回的批次 id；提供时写入整理结果并推进水位线。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_consolidate',
    description:
      '整理项目的记忆流水（手动为主）。到期时读取本机 WorkBuddy 转录，返回一份待总结的流水与提交方式；未到期时说明原因。用户说“整理记忆/总结一下最近的记忆”或系统提示记忆聚合到期时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: '要整理的项目 id；省略时按当前会话/最近项目识别。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_forget',
    description: '按 id 删除一条记忆。id 来自 memory_search 的结果；仅在用户要求删除时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: '要删除的记忆 id。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_projects',
    description: '列出记忆服务里的项目、名称、别名与条数。用户说的项目名和 id 对应不上时先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/** Normalise `text`/`notes`/`tags` into the server's batch shape. */
export function normalizeNotes(args) {
  const notes = []
  if (Array.isArray(args?.notes)) {
    for (const note of args.notes) {
      if (note === null || typeof note !== 'object') continue
      const text = typeof note.text === 'string' ? note.text.trim() : ''
      if (text === '') continue
      notes.push({
        text,
        tags: Array.isArray(note.tags) ? note.tags.filter((tag) => typeof tag === 'string') : [],
      })
    }
  }
  if (typeof args?.text === 'string' && args.text.trim() !== '') {
    notes.push({
      text: args.text.trim(),
      tags: Array.isArray(args?.tags) ? args.tags.filter((tag) => typeof tag === 'string') : [],
    })
  }
  return notes
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], isError }
}

/**
 * Build a server instance. Exported for tests; `main()` wires it to stdio.
 *
 * @param {object} options
 * @param {any} options.settings
 * @param {import('../plugin/lib/client.js').MemoryClient} options.client
 * @param {string} options.stateFile
 * @param {string} [options.cwd]
 * @param {() => number} [options.now]
 */
export function createMcpServer(options) {
  const { settings, client, stateFile, cwd = process.cwd(), now = () => Date.now() } = options
  /** @type {{version: number, sessions: Record<string, any>, cwds: Record<string, any>}} */
  let state = { version: 1, sessions: {}, cwds: {} }
  /** Consolidation batches awaiting `memory_save` (in-memory, 6h TTL). */
  const pending = new Map()
  const PENDING_TTL_MS = 6 * 60 * 60 * 1000
  const ready = loadState(stateFile).then((loaded) => {
    state = loaded
    return loaded
  })

  async function persist() {
    try {
      await saveState(stateFile, state)
    } catch (error) {
      if (process.env.DSH_MEMORY_DEBUG) {
        console.error(`[dsh-memory mcp] state write failed: ${describeMemoryError(error)}`)
      }
    }
  }

  async function contextProject(args, text) {
    const resolved = await resolveProject({
      client,
      explicit: typeof args?.project === 'string' ? args.project : undefined,
      text,
      state,
      cwd,
      defaultProject: settings.defaultProject,
      now: now(),
    })
    remember(state, { cwd, project: resolved.project })
    void persist()
    return resolved
  }

  async function callSearch(args) {
    const query = typeof args?.query === 'string' ? args.query.trim() : ''
    if (query === '') throw new MemoryError('query 不能为空', { code: 'invalid-query' })
    const limit = clampInt(args?.limit, settings.searchResults, 1, 20)
    const resolved = await contextProject(args, query)
    const payload = await client.search(resolved.project, query, limit)
    const items = Array.isArray(payload?.items) ? payload.items : []
    if (items.length === 0) {
      return textResult(`项目 ${resolved.project}（识别方式：${resolved.source}）没有匹配「${query}」的记忆。`)
    }
    const lines = [`项目 ${resolved.project}（识别方式：${resolved.source}）· ${items.length} 条`]
    let used = lines[0].length + 1
    let shown = 0
    for (const item of items) {
      const line = `[${item.id}] (${item.kind}) ${formatLocalDateTime(item.created_at)} ${toSingleLine(
        item.text,
        240,
      )}`
      if (used + line.length + 1 > settings.searchMaxChars) break
      lines.push(line)
      used += line.length + 1
      shown += 1
    }
    if (shown < items.length) lines.push(`（已截断，仅显示 ${shown}/${items.length} 条）`)
    return textResult(lines.join('\n'))
  }

  async function callSave(args) {
    const notes = normalizeNotes(args)
    const consolidationId =
      typeof args?.consolidationId === 'string' ? args.consolidationId.trim() : ''

    if (consolidationId === '' && notes.length === 0) {
      throw new MemoryError('需要提供 text 或 notes', { code: 'invalid-save' })
    }
    if (notes.length > MAX_NOTES) {
      throw new MemoryError(`一次最多写入 ${MAX_NOTES} 条`, { code: 'too-many-notes' })
    }
    for (const note of notes) {
      if (note.text.length > MAX_TEXT_CHARS) {
        throw new MemoryError(`单条记忆超过 ${MAX_TEXT_CHARS} 字符`, { code: 'text-too-long' })
      }
    }

    let resolved
    let batch
    if (consolidationId !== '') {
      batch = pending.get(consolidationId)
      if (batch === undefined) {
        throw new MemoryError('整理批次不存在或已过期，请重新调用 memory_consolidate', {
          code: 'unknown-consolidation',
        })
      }
      if (batch.expiresAt < now()) {
        pending.delete(consolidationId)
        throw new MemoryError('整理批次已过期（超过 6 小时），请重新调用 memory_consolidate', {
          code: 'unknown-consolidation',
        })
      }
      resolved = { project: batch.project, source: 'consolidation' }
    } else {
      const joined = notes.map((note) => note.text).join('\n')
      resolved = await contextProject(args, joined)
    }

    let ids = []
    if (notes.length > 0) {
      const result = await client.saveNotes(resolved.project, notes, {
        source: consolidationId === '' ? 'manual' : 'consolidate',
        kind: consolidationId === '' ? 'manual' : 'note',
      })
      ids = Array.isArray(result?.ids) ? result.ids : []
    }

    if (consolidationId !== '') {
      pending.delete(consolidationId)
      try {
        await client.setWatermark(resolved.project, {
          lastConsolidated: batch.consumedUntil,
          status: ids.length > 0 ? 'ok' : 'empty',
        })
      } catch (error) {
        return textResult(
          `已写入 ${ids.length} 条记忆，但水位线推进失败（${describeMemoryError(error)}）；下次会重复处理同一段流水。`,
          true,
        )
      }
      remember(state, { cwd, project: resolved.project })
      void persist()
      if (ids.length === 0) {
        return textResult(`本窗口没有值得保留的记忆（NO_NOTES），水位线已推进到 ${formatLocalDateTime(batch.consumedUntil)}。`)
      }
      return textResult(
        `已写入 ${ids.length} 条记忆（${ids.map((id) => `[${id}]`).join(' ')}），水位线推进到 ${formatLocalDateTime(
          batch.consumedUntil,
        )}。`,
      )
    }

    return textResult(
      ids.length === 1
        ? `已写入项目 ${resolved.project}（识别方式：${resolved.source}）：[${ids[0]}] ${toSingleLine(
            notes[0].text,
            80,
          )}`
        : `已写入项目 ${resolved.project}（识别方式：${resolved.source}）${ids.length} 条：${ids
            .map((id) => `[${id}]`)
            .join(' ')}`,
    )
  }

  async function callConsolidate(args) {
    if (settings.consolidationEnabled === false) {
      return textResult('记忆聚合已在配置中关闭（consolidationEnabled=false）。')
    }
    const resolved = await contextProject(args, '')
    const project = resolved.project
    const claim = await client.claim(project, settings.claimIntervalHours)
    if (claim?.claimed !== true) {
      const next =
        typeof claim?.next_at === 'string' && claim.next_at !== ''
          ? `，下次可整理时间 ${formatLocalDateTime(claim.next_at)}`
          : ''
      return textResult(`无需聚合：项目 ${project} 刚整理过（${claim?.reason ?? 'too_soon'}）${next}。`)
    }

    const nowMs = now()
    const sinceMs =
      typeof claim.since === 'string' && claim.since !== '' ? Date.parse(claim.since) : null
    if (sinceMs !== null && !Number.isFinite(sinceMs)) {
      throw new MemoryError(`服务端返回了无法解析的水位线：${claim.since}`, {
        code: 'invalid-watermark',
      })
    }

    const collected = await collectDigestForProject({
      project,
      state,
      projectsRoot: settings.projectsRoot,
      sinceMs,
      untilMs: nowMs,
      maxBytes: settings.transcriptMaxBytes,
      maxCharsPerEntry: settings.transcriptMaxCharsPerEntry,
    })
    for (const warning of collected.warnings) {
      if (process.env.DSH_MEMORY_DEBUG) console.error(`[dsh-memory mcp] ${warning}`)
    }

    if (collected.entries.length === 0) {
      const consumed = new Date(nowMs).toISOString()
      await client.setWatermark(project, { lastConsolidated: consumed, status: 'empty' })
      return textResult(
        `无需聚合：钩子记录的本项目会话里没有新流水，水位线已推进到 ${formatLocalDateTime(consumed)}。（旧会话需先被钩子记录过。）`,
      )
    }

    const plan = planDigest({
      project,
      entries: collected.entries,
      sinceMs,
      nowMs,
      digestMaxChars: settings.digestMaxChars,
      digestMaxEntries: settings.digestMaxEntries,
      maxBacklogDays: settings.maxBacklogDays,
    })
    const consumedUntil = new Date(plan.consumedUntilMs).toISOString()
    const batchId = randomUUID()
    pending.set(batchId, { project, consumedUntil, expiresAt: nowMs + PENDING_TTL_MS })

    return textResult(
      [
        plan.brief,
        '',
        '---',
        `提交方式：memory_save({ notes: [{ text: "[决策] …" }], consolidationId: "${batchId}" })`,
        `本窗口没有值得保留的内容：memory_save({ notes: [], consolidationId: "${batchId}" })`,
      ].join('\n'),
    )
  }

  async function callForget(args) {
    const id = Number(args?.id)
    if (!Number.isInteger(id) || id <= 0) throw new MemoryError('id 必须是正整数', { code: 'invalid-id' })
    await client.forget(id)
    return textResult(`已删除记忆 [${id}]。`)
  }

  async function callProjects() {
    const payload = await client.listProjects()
    const projects = Array.isArray(payload?.projects) ? payload.projects : []
    if (projects.length === 0) return textResult('记忆服务里还没有任何项目。')
    const lines = [`共 ${projects.length} 个项目：`]
    for (const project of projects) {
      const label = project.label && project.label !== project.id ? `（${project.label}）` : ''
      const aliases = Array.isArray(project.aliases) && project.aliases.length > 0
        ? ` 别名：${project.aliases.join(' / ')}`
        : ''
      lines.push(`- ${project.id}${label}${aliases} · ${project.items ?? 0} 条`)
    }
    return textResult(lines.join('\n'))
  }

  const TOOL_HANDLERS = {
    memory_search: callSearch,
    memory_save: callSave,
    memory_forget: callForget,
    memory_projects: callProjects,
    memory_consolidate: callConsolidate,
  }

  async function handleToolsCall(params) {
    const name = typeof params?.name === 'string' ? params.name : ''
    const handler = TOOL_HANDLERS[name]
    if (handler === undefined) {
      throw new MemoryError(`未知工具：${name}`, { code: 'unknown-tool' })
    }
    const args = params?.arguments !== null && typeof params?.arguments === 'object'
      ? params.arguments
      : {}
    try {
      return await handler(args)
    } catch (error) {
      if (error instanceof MemoryError) return textResult(error.message, true)
      return textResult(`记忆操作失败：${describeMemoryError(error)}`, true)
    }
  }

  /** Handle one JSON-RPC message. Returns the response object, or undefined for notifications. */
  async function handle(message) {
    if (message === null || typeof message !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
    }
    const { id, method, params } = message
    const isNotification = id === undefined || id === null

    try {
      if (method === 'initialize') {
        const requested =
          typeof params?.protocolVersion === 'string' && params.protocolVersion !== ''
            ? params.protocolVersion
            : PROTOCOL_FALLBACK
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        }
      }
      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
      }
      if (method === 'tools/call') {
        const result = await handleToolsCall(params)
        return { jsonrpc: '2.0', id, result }
      }
      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} }
      }
      if (isNotification) return undefined
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      }
    } catch (error) {
      if (isNotification) return undefined
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: describeMemoryError(error) },
      }
    }
  }

  return {
    handle,
    ready,
    get state() {
      return state
    },
    cwd,
  }
}

function writeMessage(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function main() {
  const settings = await loadWorkbuddyConfig()
  if (process.env.DSH_MEMORY_DEBUG) {
    for (const problem of settings.problems) console.error(`[dsh-memory mcp] ${problem}`)
  }
  const client = new MemoryClient(settings)
  const server = createMcpServer({ settings, client, stateFile: settings.stateFile })
  await server.ready

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
  reader.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    void server
      .handle(message)
      .then((response) => {
        if (response !== undefined) writeMessage(response)
      })
      .catch((error) => {
        writeMessage({
          jsonrpc: '2.0',
          id: message?.id ?? null,
          error: { code: -32603, message: describeMemoryError(error) },
        })
      })
  })
  reader.on('close', () => {
    process.exitCode = 0
  })
}

const invokedDirectly =
  process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[dsh-memory mcp] fatal: ${describeMemoryError(error)}`)
    process.exitCode = 1
  })
}
