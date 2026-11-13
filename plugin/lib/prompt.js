/**
 * The prompt contribution.
 *
 * DESIGN.md 7.2: inject a *compact index*, never memory bodies. The budget is
 * enforced here, in one place, so every deployment keeps the same ceiling no
 * matter how much memory exists.
 *
 * @module dsh-memory/prompt
 */

/** @typedef {import('./config.js').MemorySettings} MemorySettings */
/** @typedef {import('./cache.js').ContextSnapshot} ContextSnapshot */

const SECTION_TITLE = '## 项目记忆'
const EVENT_CATEGORIES = '决策 / 偏好 / 风险 / 经验'

/** Zero-pad a number to two digits. */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * Format an ISO timestamp as local `YYYY-MM-DD HH:MM`.
 * @param {string} iso
 * @returns {string}
 */
export function formatLocalDateTime(iso) {
  if (typeof iso !== 'string' || iso === '') return ''
  const moment = new Date(iso)
  if (Number.isNaN(moment.getTime())) return ''
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(
    moment.getHours(),
  )}:${pad(moment.getMinutes())}`
}

/**
 * Collapse one memory row into a single safe prompt line.
 *
 * Memory text is data, not instructions: newlines and control characters are
 * flattened so a stored row can never forge a new prompt section.
 * @param {string} text
 * @param {number} max
 */
export function toSingleLine(text, max = 120) {
  const flat = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1))}…`
}

/** The freshness line for the index header. */
function latestUpdate(items) {
  let newest = 0
  for (const item of items) {
    const time = Date.parse(item?.created_at ?? '')
    if (Number.isFinite(time) && time > newest) newest = time
  }
  return newest === 0 ? '' : formatLocalDateTime(new Date(newest).toISOString())
}

/**
 * Build the `dsh-memory:index` prompt section.
 *
 * Returns `''` when there is nothing to say: a missing cache, an unreachable
 * service, or an empty project must all produce zero prompt noise.
 *
 * @param {{project: string, snapshot?: ContextSnapshot, settings: MemorySettings}} input
 * @returns {string}
 */
export function renderIndex(input) {
  const { project, snapshot, settings } = input
  const items = Array.isArray(snapshot?.items) ? snapshot.items : []
  const due = snapshot?.consolidation?.due === true && settings.consolidationEnabled
  const total = Number.isFinite(snapshot?.total) ? snapshot.total : items.length

  if (items.length === 0 && !due) return ''

  const maxChars = settings.indexMaxChars
  const lines = [`${SECTION_TITLE}（${project}）`]

  const update = latestUpdate(items)
  if (update !== '') lines.push(`最近更新：${update}`)

  const shown = items.slice(0, settings.indexMaxItems)
  const footer =
    total > shown.length
      ? `（共 ${total} 条，仅列最重要的 ${shown.length} 条，细节用 memory_search）`
      : `（共 ${total} 条，细节用 memory_search）`

  const reserve = footer.length + 1
  let used = lines.join('\n').length + 1
  const body = []
  for (const item of shown) {
    const line = `- ${toSingleLine(item.text, 100)}`
    if (used + line.length + 1 + reserve > maxChars) break
    body.push(line)
    used += line.length + 1
  }
  lines.push(...body)

  if (due) {
    const hint = `- 记忆聚合已到期：调用 memory_consolidate 整理上一阶段流水（类别：${EVENT_CATEGORIES}）`
    if (used + hint.length + 1 + reserve <= maxChars) {
      lines.push(hint)
      used += hint.length + 1
    }
  }

  if (used + footer.length + 1 <= maxChars) lines.push(footer)
  const text = lines.join('\n')
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
}
