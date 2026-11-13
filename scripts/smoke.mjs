#!/usr/bin/env node
/**
 * Acceptance smoke test for a running memoryd instance.
 *
 * It exercises the checks in DESIGN.md 12.1 (1-4): health, authenticated write,
 * project-scoped context, Chinese retrieval, and the auth failure path. Each run
 * uses a fresh project id (so the claim assertions always start from "never
 * consolidated"), removes the rows it wrote, and leaves only an empty project
 * row behind.
 *
 * Usage:
 *   MEMORY_URL=http://127.0.0.1:8788 MEMORY_TOKEN=... node scripts/smoke.mjs
 *   node scripts/smoke.mjs --url http://127.0.0.1:8788 --token-file ~/.config/dsh-memory/token
 *
 * Exit code 0 means every assertion passed.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROJECT = `smoke-${Date.now().toString(36)}`
const results = []

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const baseUrl = (argument('url') ?? process.env.MEMORY_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '')

async function resolveToken() {
  if (process.env.MEMORY_TOKEN) return process.env.MEMORY_TOKEN.trim()
  const tokenFile = argument('token-file')
  if (tokenFile) {
    return (await readFile(tokenFile.replace(/^~(?=$|[\\/])/, homedir()), 'utf8')).trim()
  }
  try {
    return (await readFile(join(homedir(), '.config', 'dsh-memory', 'token'), 'utf8')).trim()
  } catch {
    return ''
  }
}

async function request(method, path, { body, token, raw = false } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8'
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload
  try {
    payload = text === '' ? undefined : JSON.parse(text)
  } catch {
    payload = { raw: text }
  }
  return { status: response.status, payload, raw }
}

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  const mark = condition ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${condition || detail === '' ? '' : `  — ${detail}`}`)
}

async function main() {
  const token = await resolveToken()
  if (token === '') {
    console.error('no token: set MEMORY_TOKEN or pass --token-file')
    process.exitCode = 2
    return
  }

  const health = await request('GET', '/health')
  check('GET /health returns 200 without a token', health.status === 200 && health.payload?.ok === true)
  check(
    'health reports a schema version',
    health.payload?.version === 1 && health.payload?.schema >= 1,
    JSON.stringify(health.payload),
  )

  const anonymous = await request('GET', `/api/context?project=${PROJECT}`)
  check('missing token returns 401', anonymous.status === 401, `got ${anonymous.status}`)

  const wrongToken = await request('GET', `/api/context?project=${PROJECT}`, { token: 'wrong-token' })
  check('wrong token returns 401', wrongToken.status === 401, `got ${wrongToken.status}`)

  const notes = [
    { text: '结算模块改为按日结，不再月结', tags: ['结算', '决策'] },
    { text: '对账页面优先展示当日汇总', tags: ['偏好'] },
    { text: '跨月订单佣金计算会出现一天空档', tags: ['风险'] },
  ]
  const write = await request('POST', '/api/notes', {
    token,
    body: { project: PROJECT, notes, source: 'smoke' },
  })
  check(
    'POST /api/notes stores every note',
    write.status === 200 && write.payload?.stored === notes.length,
    JSON.stringify(write.payload),
  )
  const ids = Array.isArray(write.payload?.ids) ? write.payload.ids : []

  const context = await request('GET', `/api/context?project=${PROJECT}&limit=6&max_chars=900`, {
    token,
  })
  check('GET /api/context returns the project rows', context.status === 200 && context.payload?.items?.length >= 3)
  const used = (context.payload?.items ?? []).reduce((sum, item) => sum + item.text.length + 1, 0)
  check('short text truncates to the max_chars budget', used <= 900, `${used} chars`)

  for (const query of ['日结', '结算']) {
    const search = await request(
      'GET',
      `/api/search?project=${PROJECT}&q=${encodeURIComponent(query)}&limit=5`,
      { token },
    )
    const hit = (search.payload?.items ?? []).some((item) => item.text.includes('结算模块改为按日结'))
    check(`Chinese search "${query}" finds the note`, search.status === 200 && hit)
  }

  const manual = await request('POST', '/api/items', {
    token,
    body: { project: PROJECT, text: '冒烟测试手工写入的一条记忆', tags: ['smoke'] },
  })
  check('POST /api/items writes a manual row', manual.status === 200 && Number.isInteger(manual.payload?.id))
  if (Number.isInteger(manual.payload?.id)) ids.push(manual.payload.id)

  const claim = await request('POST', '/api/watermark/claim', { token, body: { project: PROJECT } })
  check('first claim wins', claim.payload?.claimed === true, JSON.stringify(claim.payload))
  const second = await request('POST', '/api/watermark/claim', { token, body: { project: PROJECT } })
  check('second claim is rejected as too_soon', second.payload?.claimed === false && second.payload?.reason === 'too_soon')

  const projects = await request('GET', '/api/projects', { token })
  check(
    'GET /api/projects lists the smoke project',
    (projects.payload?.projects ?? []).some((entry) => entry.id === PROJECT),
  )

  for (const id of ids) {
    await request('DELETE', `/api/items/${id}`, { token })
  }
  const afterDelete = await request('GET', `/api/context?project=${PROJECT}&limit=10`, { token })
  check('DELETE /api/items/{id} removes the row', afterDelete.payload?.total === 0, JSON.stringify(afterDelete.payload?.total))

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exitCode = failed.length > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(`smoke test crashed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
})
