#!/usr/bin/env node
/**
 * Wire this package into WorkBuddy (`~/.workbuddy`).
 *
 * WorkBuddy reads MCP servers from `mcp.json` and hooks from `settings.json`
 * (Claude-Code-compatible command hooks). This installer only *adds* our two
 * entries; it never rewrites unrelated keys and never removes another memory
 * system's wiring unless asked to.
 *
 *   node workbuddy/install.mjs                  # dry run: print the exact changes
 *   node workbuddy/install.mjs --apply          # write backups, then update both files
 *   node workbuddy/install.mjs --remove         # remove our entries
 *   node workbuddy/install.mjs --apply --remove-hindsight
 *
 * Options: --url <serverUrl>, --token-file <path>, --config <client config path>,
 *          --workbuddy <home dir> (defaults to ~/.workbuddy).
 *
 * The model-facing tool surface is unchanged by the installer; it only decides
 * where WorkBuddy finds `mcp-server.mjs` and the two hooks.
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const MCP_SERVER = join(HERE, 'mcp-server.mjs')
const SESSION_HOOK = join(HERE, 'hooks', 'session-start.mjs')
const PROMPT_HOOK = join(HERE, 'hooks', 'user-prompt.mjs')
const MCP_NAME = 'dsh-memory'
const MARKER = 'workbuddy/hooks/'

/** Parse `--flag value` pairs and boolean switches. */
export function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[name] = next
      index += 1
    } else {
      args[name] = true
    }
  }
  return args
}

async function readJson(path) {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

/** Merge the MCP server entry into an mcp.json document (pure). */
export function mergeMcpConfig(existing, entry) {
  const document = existing !== null && typeof existing === 'object' ? { ...existing } : {}
  const servers = { ...(document.mcpServers ?? {}) }
  servers[MCP_NAME] = entry
  document.mcpServers = servers
  return document
}

/** Remove our MCP entry (pure). */
export function removeMcpConfig(existing) {
  const document = existing !== null && typeof existing === 'object' ? { ...existing } : {}
  if (document.mcpServers && typeof document.mcpServers === 'object') {
    const servers = { ...document.mcpServers }
    delete servers[MCP_NAME]
    document.mcpServers = servers
  }
  return document
}

/** Append our two command hooks to the Claude-style hook arrays (pure). */
export function mergeHooks(existing, commands, timeouts = {}) {
  const settings = existing !== null && typeof existing === 'object' ? { ...existing } : {}
  const hooks = { ...(settings.hooks ?? {}) }

  const add = (eventName, command, timeout) => {
    const groups = Array.isArray(hooks[eventName]) ? [...hooks[eventName]] : []
    const already = groups.some((group) =>
      Array.isArray(group?.hooks) &&
      group.hooks.some(
        (hook) => typeof hook?.command === 'string' && hook.command.includes(command.marker ?? command.command),
      ),
    )
    if (!already) {
      groups.push({ hooks: [{ type: 'command', command: command.command, timeout }] })
    }
    hooks[eventName] = groups
  }

  add('SessionStart', { command: commands.sessionStart, marker: SESSION_HOOK }, timeouts.sessionStart ?? 20)
  add('UserPromptSubmit', { command: commands.userPrompt, marker: PROMPT_HOOK }, timeouts.userPrompt ?? 20)
  settings.hooks = hooks
  return settings
}

/** Remove every hook command that points at `workbuddy/hooks/` (pure). */
export function removeHooks(existing) {
  const settings = existing !== null && typeof existing === 'object' ? { ...existing } : {}
  if (settings.hooks === null || typeof settings.hooks !== 'object') return settings
  const hooks = {}
  for (const [eventName, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[eventName] = groups
      continue
    }
    const kept = groups
      .map((group) => {
        if (!Array.isArray(group?.hooks)) return group
        return { ...group, hooks: group.hooks.filter((hook) => !String(hook?.command ?? '').includes(MARKER)) }
      })
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0)
    if (kept.length > 0) hooks[eventName] = kept
  }
  settings.hooks = hooks
  return settings
}

/** Remove a specific MCP server and hook commands mentioning it (pure). */
export function removeNamedIntegration(mcp, settings, name) {
  const nextMcp = mcp !== null && typeof mcp === 'object' ? { ...mcp } : {}
  if (nextMcp.mcpServers && typeof nextMcp.mcpServers === 'object') {
    const servers = { ...nextMcp.mcpServers }
    delete servers[name]
    nextMcp.mcpServers = servers
  }
  const nextSettings = settings !== null && typeof settings === 'object' ? { ...settings } : {}
  if (nextSettings.hooks && typeof nextSettings.hooks === 'object') {
    const hooks = {}
    for (const [eventName, groups] of Object.entries(nextSettings.hooks)) {
      if (!Array.isArray(groups)) {
        hooks[eventName] = groups
        continue
      }
      const kept = groups
        .map((group) => {
          if (!Array.isArray(group?.hooks)) return group
          return {
            ...group,
            hooks: group.hooks.filter(
              (hook) => !String(hook?.command ?? '').toLowerCase().includes(String(name).toLowerCase()),
            ),
          }
        })
        .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0)
      if (kept.length > 0) hooks[eventName] = kept
    }
    nextSettings.hooks = hooks
  }
  return { mcp: nextMcp, settings: nextSettings }
}

/** The MCP entry installed into mcp.json. */
export function buildMcpEntry(args) {
  const env = {}
  if (typeof args.config === 'string') env.DSH_MEMORY_CONFIG = resolve(args.config.replace(/^~(?=$|[\\/])/, homedir()))
  if (typeof args.url === 'string') env.DSH_MEMORY_URL = args.url
  if (typeof args['token-file'] === 'string') {
    env.DSH_MEMORY_TOKEN_FILE = resolve(args['token-file'].replace(/^~(?=$|[\\/])/, homedir()))
  }
  return {
    command: 'node',
    args: [MCP_SERVER],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  }
}

function backupPath(path, stamp) {
  return `${path}.dsh-memory-${stamp}.bak`
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const home = typeof args.workbuddy === 'string' ? resolve(args.workbuddy) : join(homedir(), '.workbuddy')
  const mcpPath = join(home, 'mcp.json')
  const settingsPath = join(home, 'settings.json')

  const mcpBefore = (await readJson(mcpPath)) ?? { mcpServers: {} }
  const settingsBefore = (await readJson(settingsPath)) ?? {}

  const apply = args.apply === true
  const remove = args.remove === true
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  let mcpAfter = remove ? removeMcpConfig(mcpBefore) : mergeMcpConfig(mcpBefore, buildMcpEntry(args))
  let settingsAfter = remove
    ? removeHooks(settingsBefore)
    : mergeHooks(settingsBefore, { sessionStart: `node "${SESSION_HOOK}"`, userPrompt: `node "${PROMPT_HOOK}"` })

  if (args['remove-hindsight'] === true) {
    const cleaned = removeNamedIntegration(mcpAfter, settingsAfter, 'hindsight')
    mcpAfter = cleaned.mcp
    settingsAfter = cleaned.settings
  }

  const summary = {
    workbuddy: home,
    mode: remove ? 'remove' : 'install',
    apply,
    mcp: { path: mcpPath, entry: mcpAfter.mcpServers?.[MCP_NAME] ?? null },
    hooks: {
      path: settingsPath,
      SessionStart: settingsAfter.hooks?.SessionStart ?? [],
      UserPromptSubmit: settingsAfter.hooks?.UserPromptSubmit ?? [],
    },
    files: { mcpServer: MCP_SERVER, sessionHook: SESSION_HOOK, promptHook: PROMPT_HOOK },
  }

  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2))
    console.log('\nNo files were written. Re-run with --apply to write backups and update WorkBuddy.')
    return
  }

  const mcpChanged = JSON.stringify(mcpBefore) !== JSON.stringify(mcpAfter)
  const settingsChanged = JSON.stringify(settingsBefore) !== JSON.stringify(settingsAfter)
  if (mcpChanged) {
    await copyFile(mcpPath, backupPath(mcpPath, stamp)).catch(() => {})
    await writeJsonAtomic(mcpPath, mcpAfter)
  }
  if (settingsChanged) {
    await copyFile(settingsPath, backupPath(settingsPath, stamp)).catch(() => {})
    await writeJsonAtomic(settingsPath, settingsAfter)
  }

  console.log(
    JSON.stringify(
      {
        applied: true,
        changed: { mcp: mcpChanged, settings: settingsChanged },
        backups: { mcp: mcpChanged ? backupPath(mcpPath, stamp) : null, settings: settingsChanged ? backupPath(settingsPath, stamp) : null },
        ...summary,
      },
      null,
      2,
    ),
  )
  if (args['remove-hindsight'] === true) {
    console.log('\nHindsight entries were removed from WorkBuddy. Its skill/plugin files were left untouched.')
  }
  console.log('\nRestart WorkBuddy so it reloads mcp.json and settings.json.')
}

main().catch((error) => {
  console.error(`install failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
