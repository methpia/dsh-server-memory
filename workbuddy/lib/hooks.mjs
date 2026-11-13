/**
 * Text builders for the WorkBuddy hooks.
 *
 * WorkBuddy speaks Claude Code's hook protocol: a command receives a JSON
 * payload on stdin and may print
 * `{"hookSpecificOutput": {"hookEventName": "…", "additionalContext": "…"}}`
 * on stdout; that text is added to the model's context for the turn/session.
 *
 * These builders are pure so the wording and budgets are testable without a
 * WorkBuddy install.
 *
 * @module dsh-server-memory/workbuddy/hooks
 */

import { renderIndex } from '../../plugin/lib/prompt.js'

const MAX_PROJECTS_IN_DIRECTORY = 8
const MAX_ALIASES_SHOWN = 3

/** One compact line per project: `- cheyidao（车易到，别名：汽修管理，12 条）`. */
export function projectDirectoryText(projects) {
  const rows = [...(projects ?? [])]
    .filter((project) => project !== null && typeof project === 'object')
    .sort((left, right) => (right.items ?? 0) - (left.items ?? 0))
    .slice(0, MAX_PROJECTS_IN_DIRECTORY)
    .map((project) => {
      const label = project.label && project.label !== project.id ? project.label : ''
      const aliases = Array.isArray(project.aliases) ? project.aliases.slice(0, MAX_ALIASES_SHOWN) : []
      const parts = []
      if (label !== '') parts.push(label)
      if (aliases.length > 0) parts.push(`别名：${aliases.join(' / ')}`)
      parts.push(`${project.items ?? 0} 条`)
      return `- ${project.id}（${parts.join('，')}）`
    })
  return rows.join('\n')
}

/**
 * SessionStart context: the project directory plus the rule that replaces
 * directory-based project detection.
 */
export function buildSessionStartContext(input) {
  const { projects, cwd, cwdProject, available } = input
  if (available === false) return ''
  const directory = projectDirectoryText(projects)
  if (directory === '') {
    return '## 项目记忆（WorkBuddy）\n已连接记忆服务，但还没有任何项目记录；用户要求记忆时用 memory_save 并指定 project。'
  }
  const lines = [
    '## 项目记忆（WorkBuddy）',
    '已知项目（id / 名称 / 别名 / 条数）：',
    directory,
    '本轮工作目录是 WorkBuddy 按会话新建的临时目录，不能用来判断项目。',
    '规则：用户提到项目名或别名时，用 memory_search 检索对应 project；写入用 memory_save 并带 project；不确定时先调 memory_projects 查看。',
  ]
  if (typeof cwdProject === 'string' && cwdProject !== '') {
    lines.push(`本轮目录路径里出现了项目 ${cwdProject}，默认按该项目处理。`)
  }
  lines.push(`（当前目录：${cwd ?? '未知'}）`)
  return lines.join('\n')
}

/** Shown once per session when the first prompt names no known project. */
export function buildNoProjectHint(projects) {
  const directory = projectDirectoryText(projects)
  if (directory === '') return ''
  return [
    '未从这句话识别到项目。已知项目：',
    directory,
    '若本轮属于其中之一，请在调用记忆工具时传 project，或告诉用户先点名项目。',
  ].join('\n')
}

/**
 * The memory index injected when a conversation is matched to a project.
 * Reuses the DSH plugin's renderer so both clients obey the same budget.
 *
 * Consolidation is a DSH-only flow (the MCP tools do not expose
 * `memory_consolidate`), so its "aggregation due" hint is suppressed here
 * instead of advertising an action WorkBuddy cannot take.
 */
export function buildProjectInjection(input) {
  const { project, label, matched, snapshot, settings } = input
  const titleParts = [project]
  if (label && label !== project) titleParts.push(label)
  const heading = `## 项目记忆（${titleParts.join('｜')}${matched ? `，由“${matched}”识别` : ''}）`
  const index = renderIndex({
    project,
    snapshot,
    settings: { ...settings, consolidationEnabled: false },
  })
  if (index === '') {
    return `${heading}\n（该项目暂无记忆条目；需要时可让用户确认项目名后写入。）`
  }
  // renderIndex already starts with its own "## 项目记忆（…）" heading.
  const body = index.replace(/^## 项目记忆（[^）]*）\n?/, '')
  return `${heading}\n${body}`.trimEnd()
}

/** Wrap text in the hook-protocol envelope WorkBuddy reads. */
export function hookOutput(eventName, additionalContext) {
  if (typeof additionalContext !== 'string' || additionalContext.trim() === '') return undefined
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  }
}
