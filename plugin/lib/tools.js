/**
 * The four model-facing memory tools (DESIGN.md 7.3).
 *
 * Rules encoded here, and nowhere else:
 *   - `memory_save` writes only when the user asked for it, except for the
 *     consolidation hand-off, which carries the batch id that advances the
 *     watermark;
 *   - `memory_consolidate` claims the window atomically and returns a bounded
 *     digest, never writes on its own;
 *   - every failure is a thrown `MemoryError`, so the harness records a real
 *     tool failure instead of a fake success;
 *   - no tool ever blocks the conversation on a slow or absent service.
 *
 * @module dsh-memory/tools
 */

import { randomUUID } from 'node:crypto'
import { MemoryError, describeMemoryError } from './client.js'
import { clampInt } from './config.js'
import { planDigest } from './digest.js'
import { formatLocalDateTime, toSingleLine } from './prompt.js'
import { collectDigestInput } from './transcripts.js'

const MAX_TEXT_CHARS = 4000
const MAX_NOTES_PER_SAVE = 50
const PENDING_TTL_MS = 6 * 60 * 60 * 1000

/** Every tool returns one plain-text result. */
function stringOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
  }
}

/** Validate and normalise the `notes` argument of `memory_save`. */
export function normalizeNotes(args) {
  const raw = []
  if (Array.isArray(args?.notes)) {
    for (const note of args.notes) {
      if (note === null || typeof note !== 'object') continue
      const text = typeof note.text === 'string' ? note.text.trim() : ''
      if (text === '') continue
      raw.push({
        text,
        tags: Array.isArray(note.tags) ? note.tags.filter((tag) => typeof tag === 'string') : [],
      })
    }
  }
  if (typeof args?.text === 'string' && args.text.trim() !== '') {
    raw.push({
      text: args.text.trim(),
      tags: Array.isArray(args?.tags) ? args.tags.filter((tag) => typeof tag === 'string') : [],
    })
  }
  return raw
}

/**
 * @param {object} options
 * @param {import('./config.js').MemorySettings} options.settings
 * @param {import('./client.js').MemoryClient} options.client
 * @param {import('./cache.js').ContextCache} options.cache
 * @param {(scope: unknown) => string} options.resolveProject
 * @param {(message: string) => void} [options.onWarning]
 * @param {(input: object) => Promise<{entries: any[], sessions: number, warnings: string[]}>} [options.collectDigest]
 * @returns {any[]} tool definitions for `ctx.tools.register`
 */
export function createTools(options) {
  const { settings, client, cache, resolveProject } = options
  const onWarning = options.onWarning ?? (() => {})
  const collectDigest = options.collectDigest ?? defaultCollectDigest
  /** @type {Map<string, {project: string, consumedUntil: string, expiresAt: number}>} */
  const pending = new Map()

  function projectOf(exec) {
    return resolveProject(exec?.agent)
  }

  async function defaultCollectDigest(input) {
    const result = await collectDigestInput({
      sessionsRoot: settings.sessionsRoot,
      project: input.project,
      sinceMs: input.sinceMs,
      untilMs: input.untilMs,
      maxBytes: settings.transcriptMaxBytes,
      maxCharsPerEntry: settings.transcriptMaxCharsPerEntry,
      projectMap: settings.projectMap,
      defaultProject: settings.defaultProject,
    })
    for (const warning of result.warnings) onWarning(warning)
    return result
  }

  const search = {
    name: 'memory_search',
    description:
      '检索本项目长期记忆的正文。系统提示里只有最多 6 条紧凑索引；需要细节、历史决策或确认是否已记录时调用，返回最相关的 1–8 条。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索词：模块名、功能名、人名或短语。中文按词召回，无需自行分词。',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 8。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: stringOutput(),
    async execute(args, exec) {
      const project = projectOf(exec)
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new MemoryError('query 不能为空', { code: 'invalid-query' })
      const limit = clampInt(args?.limit, settings.searchResults, 1, 20)
      const payload = await client.search(project, query, limit)
      const items = Array.isArray(payload?.items) ? payload.items : []
      if (items.length === 0) return `项目 ${project} 没有匹配「${query}」的记忆。`

      const lines = [`项目 ${project} · ${items.length} 条`]
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
      return lines.join('\n')
    },
  }

  const save = {
    name: 'memory_save',
    description:
      '把用户明确要求记住的内容写入本项目长期记忆。只在用户说“记住”“记一下”“别忘了”时使用，不要主动记录对话内容。' +
      '聚合流程产出的摘要也通过本工具提交，并带上 memory_consolidate 返回的 consolidationId。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '单条手工记忆（kind=manual），不超过 4000 字符；与 notes 二选一。',
        },
        notes: {
          type: 'array',
          description:
            '批量摘要（最多 50 条），与 text 二选一；带 consolidationId 时可传空数组表示本窗口没有值得保留的内容。',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '一条记忆行，例如“[决策] 结算改为按日结”。' },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: '检索标签，例如 ["结算","偏好"]。',
              },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'text 的检索标签，例如 ["结算","偏好"]。',
        },
        consolidationId: {
          type: 'string',
          description: 'memory_consolidate 返回的批次 id；提供时写入 kind=note，并在成功后推进水位线。',
        },
      },
      additionalProperties: false,
    },
    output: stringOutput(),
    async execute(args, exec) {
      const project = projectOf(exec)
      const notes = normalizeNotes(args)
      const consolidationId =
        typeof args?.consolidationId === 'string' ? args.consolidationId.trim() : ''

      for (const note of notes) {
        if (note.text.length > MAX_TEXT_CHARS) {
          throw new MemoryError(
            `单条记忆 ${note.text.length} 字符，超过上限 ${MAX_TEXT_CHARS}`,
            { code: 'text-too-long' },
          )
        }
      }
      if (notes.length > MAX_NOTES_PER_SAVE) {
        throw new MemoryError(`一次最多写入 ${MAX_NOTES_PER_SAVE} 条`, { code: 'too-many-notes' })
      }

      if (consolidationId !== '') {
        return commitConsolidation({ project, notes, consolidationId })
      }

      if (notes.length === 0) {
        throw new MemoryError('需要提供 text 或 notes', { code: 'invalid-save' })
      }

      // One atomic request per save; the server accepts kind=manual through the
      // batch endpoint, so a 20-note save is one write, not twenty.
      const result = await client.saveNotes(project, notes, { source: 'manual', kind: 'manual' })
      const ids = Array.isArray(result?.ids) ? result.ids : []
      cache.invalidate(project)
      if (ids.length === 1) {
        return `已记住 [${ids[0]}]：${toSingleLine(notes[0].text, 80)}`
      }
      return `已记住 ${ids.length} 条：${ids.map((id) => `[${id}]`).join(' ')}`
    },
  }

  async function commitConsolidation({ project, notes, consolidationId }) {
    const batch = pending.get(consolidationId)
    if (batch === undefined) {
      throw new MemoryError(
        '整理批次不存在或已过期，请重新调用 memory_consolidate 生成',
        { code: 'unknown-consolidation' },
      )
    }
    if (batch.expiresAt < Date.now()) {
      pending.delete(consolidationId)
      throw new MemoryError(
        '整理批次已过期（超过 6 小时），请重新调用 memory_consolidate',
        { code: 'unknown-consolidation' },
      )
    }
    if (batch.project !== project) {
      throw new MemoryError(
        `整理批次属于项目 ${batch.project}，当前项目是 ${project}`,
        { code: 'project-mismatch' },
      )
    }

    let ids = []
    if (notes.length > 0) {
      const result = await client.saveNotes(project, notes, {
        source: 'consolidate',
        kind: 'note',
      })
      ids = Array.isArray(result?.ids) ? result.ids : []
    }

    let watermarkError = ''
    try {
      await client.setWatermark(project, {
        lastConsolidated: batch.consumedUntil,
        status: notes.length > 0 ? 'ok' : 'empty',
      })
    } catch (error) {
      watermarkError = describeMemoryError(error)
    }
    pending.delete(consolidationId)
    cache.invalidate(project)

    if (watermarkError !== '') {
      return `已写入 ${ids.length} 条记忆，但水位线推进失败（${watermarkError}）；下次会重复处理同一段流水。`
    }
    if (ids.length === 0) {
      return `本窗口没有值得保留的记忆（NO_NOTES），水位线已推进到 ${formatLocalDateTime(
        batch.consumedUntil,
      )}。`
    }
    return `已写入 ${ids.length} 条记忆（${ids.map((id) => `[${id}]`).join(' ')}），水位线推进到 ${formatLocalDateTime(
      batch.consumedUntil,
    )}。`
  }

  const forget = {
    name: 'memory_forget',
    description: '按 id 删除一条记忆。id 来自 memory_search 的结果；仅在用户要求删除时调用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: '要删除的记忆 id。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: stringOutput(),
    async execute(args, exec) {
      const project = projectOf(exec)
      const id = Number(args?.id)
      if (!Number.isInteger(id) || id <= 0) {
        throw new MemoryError('id 必须是正整数', { code: 'invalid-id' })
      }
      await client.forget(id)
      cache.invalidate(project)
      return `已删除记忆 [${id}]。`
    },
  }

  const consolidate = {
    name: 'memory_consolidate',
    description:
      '检查本项目的记忆聚合是否到期。到期时返回一段待总结的工作流水和提交方式；未到期时说明原因。' +
      '系统提示提示“记忆聚合已到期”或用户要求整理记忆时调用，无参数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: stringOutput(),
    async execute(_args, exec) {
      const project = projectOf(exec)
      if (!settings.consolidationEnabled) {
        return '记忆聚合已在插件配置中关闭（consolidationEnabled=false）。'
      }

      const claim = await client.claim(project, settings.claimIntervalHours)
      if (claim?.claimed !== true) {
        const next =
          typeof claim?.next_at === 'string' && claim.next_at !== ''
            ? `，下次可整理时间 ${formatLocalDateTime(claim.next_at)}`
            : ''
        return `无需聚合：本项目刚整理过（${claim?.reason ?? 'too_soon'}）${next}。`
      }

      const nowMs = Date.now()
      const sinceMs = typeof claim.since === 'string' && claim.since !== '' ? Date.parse(claim.since) : null
      if (sinceMs !== null && !Number.isFinite(sinceMs)) {
        throw new MemoryError(`服务端返回了无法解析的水位线：${claim.since}`, {
          code: 'invalid-watermark',
        })
      }

      const collected = await collectDigest({
        project,
        sinceMs,
        untilMs: nowMs,
      })

      if (collected.entries.length === 0) {
        const consumed = new Date(nowMs).toISOString()
        await client.setWatermark(project, { lastConsolidated: consumed, status: 'empty' })
        cache.invalidate(project)
        return `无需聚合：${sinceMs === null ? '转录里没有' : '转录里没有水位线之后'}属于本项目的新流水，水位线已推进到 ${formatLocalDateTime(
          consumed,
        )}。`
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
      pending.set(batchId, {
        project,
        consumedUntil,
        expiresAt: nowMs + PENDING_TTL_MS,
      })

      return [
        plan.brief,
        '',
        '---',
        `提交方式：memory_save({ notes: [{ text: "[决策] …" }], consolidationId: "${batchId}" })`,
        `本窗口没有值得保留的内容：memory_save({ notes: [], consolidationId: "${batchId}" })`,
      ].join('\n')
    },
  }

  return [search, save, forget, consolidate]
}
