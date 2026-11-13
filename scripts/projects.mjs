#!/usr/bin/env node
/**
 * Small CLI for project labels and aliases (the "name a project in chat" table).
 *
 *   node scripts/projects.mjs list
 *   node scripts/projects.mjs set cheyidao --label 车易到 --aliases 车易到,cheyidao,汽修管理
 *   node scripts/projects.mjs resolve 车易到的结算模块
 *
 * Connection: `--url` / `--token-file`, or MEMORY_URL / MEMORY_TOKEN_FILE.
 * Defaults: http://127.0.0.1:8788 and ~/.config/dsh-memory/token.
 *
 * Using this script instead of hand-written curl avoids the Windows trap where
 * PowerShell mangles UTF-8 JSON (or adds a BOM) and the aliases silently do not
 * match.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { MemoryClient } from '../plugin/lib/client.js'
import { normalizeConfig } from '../plugin/lib/config.js'

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[token.slice(2)] = next
      index += 1
    } else {
      flags[token.slice(2)] = true
    }
  }
  return { positional, flags }
}

async function tokenFromFile(path) {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return ''
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0] ?? 'list'
  const tokenFile =
    typeof flags['token-file'] === 'string'
      ? flags['token-file']
      : process.env.MEMORY_TOKEN_FILE ?? join(homedir(), '.config', 'dsh-memory', 'token')
  const settings = normalizeConfig({
    serverUrl: typeof flags.url === 'string' ? flags.url : process.env.MEMORY_URL ?? 'http://127.0.0.1:8788',
    token: process.env.MEMORY_TOKEN ?? (await tokenFromFile(tokenFile)),
    tokenFile,
  })
  const client = new MemoryClient(settings)

  if (command === 'list') {
    const payload = await client.listProjects()
    for (const project of payload.projects ?? []) {
      const aliases = Array.isArray(project.aliases) && project.aliases.length > 0
        ? `  aliases: ${project.aliases.join(', ')}`
        : ''
      console.log(`${project.id}\t${project.label ?? ''}\t${project.items ?? 0} 条${aliases}`)
    }
    return
  }

  if (command === 'set') {
    const project = positional[1]
    if (typeof project !== 'string' || project === '') {
      throw new Error('usage: node scripts/projects.mjs set <project> [--label <label>] [--aliases a,b,c]')
    }
    const aliases = typeof flags.aliases === 'string' ? flags.aliases.split(',') : undefined
    const result = await client.upsertProject(project, {
      label: typeof flags.label === 'string' ? flags.label : undefined,
      aliases,
    })
    console.log(JSON.stringify(result.project, null, 2))
    return
  }

  if (command === 'resolve') {
    const text = positional.slice(1).join(' ')
    if (text === '') throw new Error('usage: node scripts/projects.mjs resolve <text>')
    console.log(JSON.stringify(await client.resolve(text), null, 2))
    return
  }

  throw new Error(`unknown command: ${command} (expected list | set | resolve)`)
}

main().catch((error) => {
  console.error(`projects: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
