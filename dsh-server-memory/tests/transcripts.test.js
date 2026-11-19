import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import * as zlib from 'node:zlib'

import {
  collectDigestInput,
  extractEntries,
  readSessionFile,
  sessionMeta,
  textOfContent,
  truncateCodeBlocks,
} from '../lib/transcripts.js'

const SESSION_HEADER = {
  type: 'session',
  version: 4,
  id: 'session-1',
  cwd: '/work/dev',
  createdAt: 1000,
  delegationDepth: 0,
}

function userMessage(time, text, kind = 'user') {
  return { type: 'user/message', time, data: { source: { kind }, content: [{ type: 'text', text }] } }
}

function assistantMessage(time, turn, content) {
  return { type: 'assistant/message', time, data: { turn, message: { content } } }
}

test('textOfContent keeps only text blocks', () => {
  const text = textOfContent([
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: '第一段' },
    { type: 'tool-call', name: 'pwsh', arguments: '{}' },
    { type: 'text', text: '第二段' },
  ])
  assert.equal(text, '第一段\n第二段')
  assert.equal(textOfContent(undefined), '')
})

test('sessionMeta reads the header and tolerates missing fields', () => {
  assert.deepEqual(sessionMeta([{ type: 'other' }, SESSION_HEADER]), {
    id: 'session-1',
    cwd: '/work/dev',
    createdAt: 1000,
    delegationDepth: 0,
    version: 4,
  })
  assert.equal(sessionMeta([{ type: 'user/message' }]), undefined)
})

test('extractEntries keeps human messages and the final assistant reply', () => {
  const events = [
    SESSION_HEADER,
    userMessage(1000, '把结算模块改成按日结'),
    userMessage(1001, 'runtime snapshot', 'runtime-context'),
    userMessage(1002, 'approval changed', 'user-approval'),
    userMessage(1003, 'skill catalog', 'skill-catalog'),
    assistantMessage(1100, 1, [{ type: 'reasoning', text: 'thinking' }]),
    assistantMessage(1200, 1, [{ type: 'text', text: '好的，已经改成按日结。' }]),
    assistantMessage(1300, 1, [{ type: 'tool-call', name: 'edit' }]),
    userMessage(2000, '再补一个对账页面'),
    assistantMessage(2100, 2, [{ type: 'text', text: '对账页面已加上当日汇总。' }]),
  ]
  const entries = extractEntries(events)
  assert.equal(entries.length, 4)
  assert.deepEqual(
    entries.map((entry) => [entry.role, entry.at]),
    [
      ['user', 1000],
      ['assistant', 1200],
      ['user', 2000],
      ['assistant', 2100],
    ],
  )
  assert.equal(entries[1].text, '好的，已经改成按日结。')
})

test('extractEntries honours the time window (exclusive since)', () => {
  const events = [
    SESSION_HEADER,
    userMessage(1000, '旧消息'),
    userMessage(2000, '新消息'),
    assistantMessage(2100, 1, [{ type: 'text', text: '答复' }]),
  ]
  const entries = extractEntries(events, { sinceMs: 1000, untilMs: 2050 })
  assert.deepEqual(entries.map((entry) => entry.text), ['新消息'])
})

test('long code blocks are shortened to head and tail', () => {
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`)
  const text = `前文\n\`\`\`python\n${lines.join('\n')}\n\`\`\`\n后文`
  const shortened = truncateCodeBlocks(text)
  assert.ok(shortened.includes('line 0'))
  assert.ok(shortened.includes('line 2'))
  assert.ok(shortened.includes('line 29'))
  assert.ok(shortened.includes('省略 24 行'))
  assert.ok(!shortened.includes('line 15'))
  assert.ok(shortened.includes('前文') && shortened.includes('后文'))
})

test('entries are clamped and marked when cut', () => {
  const longText = '啊'.repeat(5000)
  const entries = extractEntries([SESSION_HEADER, userMessage(1000, longText)])
  assert.equal(entries.length, 1)
  assert.ok(entries[0].text.length <= 1200)
  assert.ok(entries[0].text.endsWith('…'))
})

test('readSessionFile parses zstd frames and counts bad lines', { skip: !zlib.zstdDecompressSync }, async () => {
  const body = [
    JSON.stringify(SESSION_HEADER),
    JSON.stringify(userMessage(1000, '你好')),
    'not-json',
    '',
  ].join('\n')
  const buffer = zlib.zstdCompressSync(Buffer.from(body, 'utf8'))
  const decoded = await readSessionFile('/fake/session.v4.jsonl.zstd', {
    statImpl: async () => ({ size: buffer.length, mtimeMs: 0 }),
    readFileImpl: async () => buffer,
    maxBytes: 1024 * 1024,
  })
  assert.equal(decoded.events.length, 2)
  assert.equal(decoded.badLines, 1)
  assert.equal(decoded.truncated, false)
})

test('readSessionFile rejects oversized transcripts', async () => {
  await assert.rejects(
    readSessionFile('/fake/big.jsonl.zstd', {
      statImpl: async () => ({ size: 20_000_000, mtimeMs: 0 }),
      readFileImpl: async () => Buffer.alloc(0),
      maxBytes: 1024,
    }),
    /转录文件过大/,
  )
})

/** Build an in-memory filesystem the transcript walker can traverse. */
function fakeFs(files) {
  const children = new Map()
  const remember = (directory, name, isDirectory) => {
    const key = directory.replace(/\\/g, '/')
    if (!children.has(key)) children.set(key, new Map())
    children.get(key).set(name, isDirectory)
  }
  for (const path of files.keys()) {
    const normalized = path.replace(/\\/g, '/')
    const segments = normalized.split('/').filter((segment) => segment !== '')
    let prefix = ''
    segments.forEach((segment, index) => {
      const isDirectory = index < segments.length - 1
      remember(prefix === '' ? '/' : prefix, segment, isDirectory)
      prefix = `${prefix}/${segment}`
    })
  }
  const lookup = (path) => {
    const normalized = path.replace(/\\/g, '/')
    const entry = files.get(normalized)
    if (entry === undefined) throw new Error('ENOENT')
    return entry
  }
  return {
    readdirImpl: async (directory) => {
      const entries = children.get(directory.replace(/\\/g, '/')) ?? new Map()
      return [...entries.entries()].map(([name, isDirectory]) => ({
        name,
        isDirectory: () => isDirectory,
        isFile: () => !isDirectory,
      }))
    },
    statImpl: async (path) => {
      const entry = lookup(path)
      return { size: entry.buffer.length, mtimeMs: entry.mtimeMs }
    },
    readFileImpl: async (path) => lookup(path).buffer,
  }
}

function sessionBuffer(header, events) {
  const body = `${[header, ...events].map((event) => JSON.stringify(event)).join('\n')}\n`
  return zlib.zstdCompressSync(Buffer.from(body, 'utf8'))
}

const treeBuilder = (() => {
  const root = '/sessions'
  const files = new Map()
  const register = (path, mtimeMs, buffer) => {
    files.set(path.replace(/\\/g, '/'), { mtimeMs, buffer })
  }
  register(
    join(root, '--D-dev--', 'session-1', 'session.v4.jsonl.zstd'),
    9000,
    sessionBuffer(SESSION_HEADER, [userMessage(5000, '主会话的一条流水')]),
  )
  register(
    join(root, '--D-dev--', 'session-2', 'session.v4.jsonl.zstd'),
    9000,
    sessionBuffer({ ...SESSION_HEADER, id: 'session-2', delegationDepth: 1 }, [
      userMessage(6000, '子代理的流水，不应入库'),
    ]),
  )
  register(
    join(root, '--E-other--', 'session-3', 'session.v4.jsonl.zstd'),
    9000,
    sessionBuffer({ ...SESSION_HEADER, id: 'session-3', cwd: '/work/other' }, [
      userMessage(7000, '别的项目的流水'),
    ]),
  )
  return { root, files }
})()

test('collectDigestInput filters by project, depth and mtime', async () => {
  const fs = fakeFs(treeBuilder.files)
  const collected = await collectDigestInput({
    sessionsRoot: treeBuilder.root,
    project: 'dev',
    sinceMs: null,
    untilMs: 10_000,
    projectMap: {},
    defaultProject: 'default',
    fs,
  })
  assert.deepEqual(collected.entries.map((entry) => entry.text), ['主会话的一条流水'])
  assert.equal(collected.sessions, 1)
  assert.deepEqual(collected.warnings, [])

  const skippedByMtime = await collectDigestInput({
    sessionsRoot: treeBuilder.root,
    project: 'dev',
    sinceMs: 9500,
    untilMs: 20_000,
    fs,
  })
  assert.equal(skippedByMtime.entries.length, 0)
})

test('collectDigestInput reports unreadable sessions instead of throwing', async () => {
  const fs = fakeFs(treeBuilder.files)
  const collected = await collectDigestInput({
    sessionsRoot: treeBuilder.root,
    project: 'dev',
    sinceMs: null,
    untilMs: 10_000,
    maxBytes: 10,
    fs,
  })
  assert.equal(collected.entries.length, 0)
  assert.ok(collected.warnings.some((warning) => warning.includes('转录文件过大')))
})

test('collectDigestInput tolerates a missing sessions root', async () => {
  const collected = await collectDigestInput({
    sessionsRoot: '/definitely/missing',
    project: 'dev',
    sinceMs: null,
    untilMs: 10_000,
    fs: { readdirImpl: async () => Promise.reject(new Error('ENOENT')) },
  })
  assert.deepEqual(collected, { entries: [], sessions: 0, files: 0, warnings: [] })
})
