/**
 * Consolidation digest: turn raw transcript entries into a bounded, well-
 * specified task for the agent's own model (DESIGN.md 8.2).
 *
 * This module is pure. It knows nothing about HTTP, DSH or the filesystem: it
 * receives entries, applies the character/entry budget, and renders the brief.
 * That makes the expensive part of the design (what the model reads) reviewable
 * and testable in isolation.
 *
 * @module dsh-memory/digest
 */

const DAY_MS = 86_400_000
const MIN_ENTRY_BUDGET = 400

/** `MM-DD HH:MM` in host-local time. */
export function formatStamp(ms) {
  const moment = new Date(ms)
  if (Number.isNaN(moment.getTime())) return '--'
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(
    moment.getMinutes(),
  )}`
}

/** `YYYY-MM-DD HH:MM` in host-local time, for the brief header. */
export function formatDateTime(ms) {
  const moment = new Date(ms)
  if (Number.isNaN(moment.getTime())) return '未知时间'
  const pad = (value) => String(value).padStart(2, '0')
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(
    moment.getHours(),
  )}:${pad(moment.getMinutes())}`
}

/**
 * One digest line. Newlines are flattened so every entry costs exactly one line.
 * @param {{at: number, role: string, text: string}} entry
 */
export function renderEntryLine(entry) {
  const who = entry.role === 'user' ? '用户' : '助手'
  const text = String(entry.text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `[${formatStamp(entry.at)}] ${who}：${text}`
}

/**
 * Pick the oldest entries that fit the budget.
 *
 * Oldest-first is deliberate: the watermark may only move to the last row that
 * was actually consumed, so a busy day must leave the *newest* rows for the next
 * run rather than dropping the backlog permanently (DESIGN.md 8.2-4).
 *
 * @param {Array<{at: number, role: string, text: string}>} entries
 * @param {{sinceMs: number|null, nowMs: number, maxChars: number, maxEntries: number,
 *          maxBacklogDays: number}} options
 */
export function selectEntries(entries, options) {
  const { sinceMs, nowMs, maxChars, maxEntries, maxBacklogDays } = options
  const hardFloor = nowMs - maxBacklogDays * DAY_MS
  const effectiveSince =
    sinceMs === null || !Number.isFinite(sinceMs) ? hardFloor : Math.max(sinceMs, hardFloor)

  const inWindow = []
  let dropped = 0
  for (const entry of entries) {
    if (!Number.isFinite(entry?.at)) continue
    if (entry.at <= effectiveSince) {
      dropped += 1
      continue
    }
    if (entry.at > nowMs) continue
    inWindow.push(entry)
  }

  const selected = []
  let used = 0
  let truncated = false
  for (const entry of inWindow) {
    if (selected.length >= maxEntries) {
      truncated = true
      break
    }
    const cost = renderEntryLine(entry).length + 1
    if (used + cost > maxChars) {
      truncated = true
      break
    }
    selected.push(entry)
    used += cost
  }

  const consumedUntilMs = selected.length > 0 ? selected[selected.length - 1].at : nowMs
  return {
    selected,
    effectiveSince,
    consumedUntilMs,
    dropped,
    truncated,
    remaining: inWindow.length - selected.length,
    usedChars: used,
  }
}

/**
 * The fixed instruction block. Kept stable so prompt caching and human review
 * stay cheap; only the window labels and project name vary.
 */
export function buildInstructions({ project, fromMs, toMs }) {
  return [
    `【记忆整理任务】项目 ${project}`,
    `下面是 ${formatDateTime(fromMs)} 至 ${formatDateTime(toMs)} 的工作流水节选，请提炼成 5–15 条长期记忆。`,
    '',
    '规则：',
    '- 每条一行，以 [决策] [偏好] [风险] [经验] 之一开头，不超过 60 字，陈述句；',
    '- [决策] 写清为什么这样定，[偏好] 写用户口味与约束，[风险] 写埋着的坑，[经验] 写踩过什么；',
    '- 不复述过程，不写“用户要求…”这类空话，不记录临时文件名、行号和命令输出；',
    '- 同一件事不要拆成多条；没有值得长期保留的内容就只输出 NO_NOTES。',
    '',
    '正例：',
    '- [决策] 结算模块改为按日结，因为月结在跨月订单上会留下一天空档',
    '- [偏好] 对账页面优先展示当日汇总，用户每天先看当天数据',
    '',
    '反例（不要这样写）：',
    '- [经验] 用户要求我看一下结算模块的代码',
  ].join('\n')
}

/**
 * Build the complete digest and the watermark to advance to.
 *
 * @param {object} input
 * @param {string} input.project
 * @param {Array<{at: number, role: string, text: string}>} input.entries
 * @param {number|null} input.sinceMs
 * @param {number} input.nowMs
 * @param {number} input.digestMaxChars
 * @param {number} input.digestMaxEntries
 * @param {number} input.maxBacklogDays
 */
export function planDigest(input) {
  const instructions = buildInstructions({
    project: input.project,
    fromMs:
      input.sinceMs !== null && Number.isFinite(input.sinceMs)
        ? input.sinceMs
        : input.nowMs - input.maxBacklogDays * DAY_MS,
    toMs: input.nowMs,
  })
  const footerReserve = 200
  const entryBudget = Math.max(
    MIN_ENTRY_BUDGET,
    input.digestMaxChars - instructions.length - footerReserve,
  )

  const selection = selectEntries(input.entries, {
    sinceMs: input.sinceMs,
    nowMs: input.nowMs,
    maxChars: entryBudget,
    maxEntries: input.digestMaxEntries,
    maxBacklogDays: input.maxBacklogDays,
  })

  const notes = []
  if (selection.dropped > 0) {
    notes.push(
      `（更早的 ${selection.dropped} 条流水已超出 ${input.maxBacklogDays} 天窗口，本次跳过。）`,
    )
  }
  if (selection.truncated) {
    notes.push(
      `（本次只送上最早的 ${selection.selected.length} 条，其余 ${selection.remaining} 条留到下次整理。）`,
    )
  }

  const body = selection.selected.map(renderEntryLine)
  const brief = [
    instructions,
    '',
    '流水：',
    ...(body.length > 0 ? body : ['（本窗口没有新的工作流水）']),
    ...notes,
  ].join('\n')

  return {
    brief,
    instructions,
    selected: selection.selected,
    consumedUntilMs: selection.consumedUntilMs,
    truncated: selection.truncated,
    remaining: selection.remaining,
    dropped: selection.dropped,
    entryCount: selection.selected.length,
  }
}
