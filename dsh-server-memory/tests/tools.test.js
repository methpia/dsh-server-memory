import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryError } from '../lib/client.js'
import { normalizeConfig } from '../lib/config.js'
import { createTools, normalizeNotes } from '../lib/tools.js'

const AGENT = { agent: { id: 'session-1' } }

function stubClient(overrides = {}) {
  const calls = []
  const wrap = (name, fallback) => async (...args) => {
    calls.push({ name, args })
    const implementation = overrides[name] ?? fallback
    return implementation(...args)
  }
  return {
    calls,
    search: wrap('search', () => ({ items: [] })),
    saveItem: wrap('saveItem', (_project, text) => ({ id: 11, text })),
    saveNotes: wrap('saveNotes', (_project, notes) => ({
      stored: notes.length,
      ids: notes.map((_note, index) => index + 20),
    })),
    forget: wrap('forget', () => ({ deleted: true })),
    claim: wrap('claim', () => ({ claimed: false, reason: 'too_soon', next_at: null })),
    setWatermark: wrap('setWatermark', () => ({ ok: true })),
    health: wrap('health', () => ({ ok: true, projects: 1, items: 2 })),
    listProjects: wrap('listProjects', () => ({ projects: [] })),
  }
}

const cache = { invalidate() {}, touch() {}, snapshot: () => undefined }

/** @param {{client?: any, collectDigest?: any, settings?: any}} [options] */
function build(options = {}) {
  const client = options.client ?? stubClient()
  const tools = createTools({
    settings: options.settings ?? normalizeConfig({ token: 'test-token' }),
    client,
    cache,
    resolveProject: () => 'dsh',
    onWarning: () => {},
    collectDigest:
      options.collectDigest ??
      (async () => ({ entries: [], sessions: 0, warnings: [] })),
  })
  return { tools, byName: new Map(tools.map((tool) => [tool.name, tool])), client }
}

test('normalizeNotes accepts text, notes and tags', () => {
  assert.deepEqual(normalizeNotes({ text: ' 一条 ', tags: ['偏好'] }), [
    { text: '一条', tags: ['偏好'] },
  ])
  assert.deepEqual(normalizeNotes({ notes: [{ text: 'a' }, { text: '  ' }, { nope: 1 }] }), [
    { text: 'a', tags: [] },
  ])
  assert.deepEqual(normalizeNotes({}), [])
})

test('every tool is registered with a schema and one result renderer', () => {
  const { tools } = build()
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['memory_search', 'memory_save', 'memory_projects', 'memory_forget', 'memory_consolidate', 'memory_setup'],
  )
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'string')
    assert.equal(tool.output.render({}, 'x')[0].text, 'x')
  }
})

test('memory_search renders compact hits', async () => {
  const client = stubClient({
    search: () => ({
      items: [
        {
          id: 3,
          kind: 'note',
          text: '[决策] 结算模块改为按日结，不再月结',
          created_at: '2026-11-13T01:20:00Z',
        },
      ],
    }),
  })
  const { byName } = build({ client })
  const result = await byName.get('memory_search').execute({ query: '日结' }, AGENT)
  assert.ok(result.includes('项目 dsh · 1 条'))
  assert.ok(result.includes('[3] (note)'))
  assert.ok(result.includes('结算模块改为按日结'))
})

test('memory_search explains an empty result set', async () => {
  const { byName } = build()
  const result = await byName.get('memory_search').execute({ query: '不存在' }, AGENT)
  assert.equal(result, '项目 dsh 没有匹配「不存在」的记忆。')
})

test('memory_search rejects an empty query without calling the server', async () => {
  const { byName, client } = build()
  await assert.rejects(
    () => byName.get('memory_search').execute({ query: '   ' }, AGENT),
    (error) => error instanceof MemoryError && error.code === 'invalid-query',
  )
  assert.equal(client.calls.length, 0)
})

test('memory_save writes a manual memory in one atomic request', async () => {
  const { byName, client } = build()
  const result = await byName.get('memory_save').execute({ text: '对账页面先看当日汇总' }, AGENT)
  assert.ok(result.includes('已记住 [20]'))
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].name, 'saveNotes')
  assert.deepEqual(client.calls[0].args[1], [{ text: '对账页面先看当日汇总', tags: [] }])
  assert.equal(client.calls[0].args[2].kind, 'manual')
  assert.equal(client.calls[0].args[2].source, 'manual')
})

test('memory_save reports every id for a batch', async () => {
  const { byName } = build()
  const result = await byName.get('memory_save').execute(
    { notes: [{ text: '第一条' }, { text: '第二条' }] },
    AGENT,
  )
  assert.equal(result, '已记住 2 条：[20] [21]')
})

test('memory_save refuses empty input', async () => {
  const { byName } = build()
  await assert.rejects(
    () => byName.get('memory_save').execute({}, AGENT),
    (error) => error instanceof MemoryError && error.code === 'invalid-save',
  )
})

test('memory_consolidate reports when the window is not due', async () => {
  const { byName } = build()
  const result = await byName.get('memory_consolidate').execute({}, AGENT)
  assert.ok(result.includes('无需聚合'))
  assert.ok(result.includes('too_soon'))
})

test('memory_consolidate advances the watermark when there is no new flow', async () => {
  const client = stubClient({ claim: () => ({ claimed: true, since: null }) })
  const { byName } = build({ client })
  const result = await byName.get('memory_consolidate').execute({}, AGENT)
  assert.ok(result.includes('无需聚合'))
  const watermarkCall = client.calls.find((call) => call.name === 'setWatermark')
  assert.ok(watermarkCall)
  assert.equal(watermarkCall.args[1].status, 'empty')
})

test('the consolidation hand-off writes notes and advances the watermark', async () => {
  const client = stubClient({ claim: () => ({ claimed: true, since: '2026-11-12T09:00:00Z' }) })
  const now = Date.now()
  const entries = [
    { at: now - 120_000, role: 'user', text: '把结算改成按日结' },
    { at: now - 60_000, role: 'assistant', text: '已改成按日结，并加了对账页的当日汇总。' },
  ]
  const { byName } = build({ client, collectDigest: async () => ({ entries, sessions: 1, warnings: [] }) })

  const digest = await byName.get('memory_consolidate').execute({}, AGENT)
  assert.ok(digest.includes('【记忆整理任务】项目 dsh'))
  assert.ok(digest.includes('提交方式'))
  const match = digest.match(/consolidationId: "([^"]+)"/)
  assert.ok(match, digest)
  const consolidationId = match[1]

  const saved = await byName.get('memory_save').execute(
    {
      notes: [{ text: '[决策] 结算改为按日结', tags: ['结算'] }],
      consolidationId,
    },
    AGENT,
  )
  assert.ok(saved.includes('已写入 1 条记忆'), saved)
  assert.ok(saved.includes('水位线推进到'))

  const notesCall = client.calls.find((call) => call.name === 'saveNotes')
  assert.deepEqual(notesCall.args[1], [{ text: '[决策] 结算改为按日结', tags: ['结算'] }])
  assert.equal(notesCall.args[2].source, 'consolidate')
  assert.equal(notesCall.args[2].kind, 'note')

  const watermarkCall = client.calls.find((call) => call.name === 'setWatermark')
  assert.equal(watermarkCall.args[1].status, 'ok')
  assert.equal(watermarkCall.args[1].lastConsolidated, new Date(entries[1].at).toISOString())
})

test('a NO_NOTES submission advances the watermark without writing rows', async () => {
  const client = stubClient({ claim: () => ({ claimed: true, since: null }) })
  const entries = [{ at: Date.now() - 1000, role: 'user', text: '随便聊聊' }]
  const { byName } = build({ client, collectDigest: async () => ({ entries, sessions: 1, warnings: [] }) })

  const digest = await byName.get('memory_consolidate').execute({}, AGENT)
  const consolidationId = digest.match(/consolidationId: "([^"]+)"/)[1]
  const saved = await byName.get('memory_save').execute({ notes: [], consolidationId }, AGENT)

  assert.ok(saved.includes('NO_NOTES'), saved)
  assert.equal(client.calls.filter((call) => call.name === 'saveNotes').length, 0)
  const watermarkCall = client.calls.find((call) => call.name === 'setWatermark')
  assert.equal(watermarkCall.args[1].status, 'empty')
})

test('a batch id can only be committed once', async () => {
  const client = stubClient({ claim: () => ({ claimed: true, since: null }) })
  const entries = [{ at: Date.now() - 1000, role: 'user', text: '一条流水' }]
  const { byName } = build({ client, collectDigest: async () => ({ entries, sessions: 1, warnings: [] }) })
  const digest = await byName.get('memory_consolidate').execute({}, AGENT)
  const consolidationId = digest.match(/consolidationId: "([^"]+)"/)[1]

  await byName.get('memory_save').execute({ notes: [{ text: '一条记忆' }], consolidationId }, AGENT)
  await assert.rejects(
    () => byName.get('memory_save').execute({ notes: [{ text: '重复提交' }], consolidationId }, AGENT),
    (error) => error instanceof MemoryError && error.code === 'unknown-consolidation',
  )
})

test('memory_forget validates the id and deletes', async () => {
  const { byName, client } = build()
  await assert.rejects(
    () => byName.get('memory_forget').execute({ id: 0 }, AGENT),
    (error) => error instanceof MemoryError && error.code === 'invalid-id',
  )
  const result = await byName.get('memory_forget').execute({ id: 42 }, AGENT)
  assert.equal(result, '已删除记忆 [42]。')
  assert.deepEqual(client.calls[0].args, [42])
})

test('consolidation can be switched off entirely', async () => {
  const { byName, client } = build({
    settings: normalizeConfig({ token: 'test-token', consolidationEnabled: false }),
  })
  const result = await byName.get('memory_consolidate').execute({}, AGENT)
  assert.ok(result.includes('关闭'))
  assert.equal(client.calls.length, 0)
})

test('oversized memories are rejected before the request', async () => {
  const { byName, client } = build()
  await assert.rejects(
    () =>
      byName.get('memory_save').execute(
        { notes: [{ text: '啊'.repeat(4001) }], consolidationId: 'x' },
        AGENT,
      ),
    (error) => error instanceof MemoryError && error.code === 'text-too-long',
  )
  assert.equal(client.calls.length, 0)
})

test('an explicit project id is used as-is', async () => {
  const client = stubClient({ search: () => ({ items: [] }) })
  client.listProjects = async () => ({ projects: [{ id: 'cheyidao' }] })
  client.resolve = async () => ({ project: 'should-not-be-used' })
  const { byName } = build({ client })
  await byName.get('memory_search').execute({ query: 'x', project: 'cheyidao' }, AGENT)
  const call = client.calls.find((entry) => entry.name === 'search')
  assert.equal(call.args[0], 'cheyidao')
})

test('an alias is resolved to its project id', async () => {
  const client = stubClient({ search: () => ({ items: [] }) })
  client.listProjects = async () => ({ projects: [{ id: 'dsh' }] })
  client.resolve = async (text) => ({ project: text === '车易到' ? 'cheyidao' : null })
  const { byName } = build({ client })
  await byName.get('memory_search').execute({ query: '工程铁律', project: '车易到' }, AGENT)
  const call = client.calls.find((entry) => entry.name === 'search')
  assert.equal(call.args[0], 'cheyidao')
})

test('an unknown project is a tool error, not a silent fallback', async () => {
  const client = stubClient({ search: () => ({ items: [] }) })
  client.listProjects = async () => ({ projects: [] })
  client.resolve = async () => ({ project: null })
  const { byName } = build({ client })
  await assert.rejects(
    () => byName.get('memory_search').execute({ query: 'x', project: '不存在' }, AGENT),
    (error) => error instanceof MemoryError && /找不到项目或别名/.test(error.message),
  )
  assert.equal(client.calls.some((entry) => entry.name === 'search'), false)
})

test('memory_projects lists projects with labels, aliases and counts', async () => {
  const client = stubClient()
  client.listProjects = async () => ({
    projects: [{ id: 'cheyidao', label: '车易到', aliases: ['车易到', 'cheyidao'], items: 4 }],
  })
  const { byName } = build({ client })
  const text = await byName.get('memory_projects').execute({ action: 'list' }, AGENT)
  assert.match(text, /cheyidao/)
  assert.match(text, /车易到/)
  assert.match(text, /4 条/)
})

test('memory_projects creates a library with a label and aliases', async () => {
  const client = stubClient()
  client.upsertProject = async (project, options) => ({
    project: { id: project, label: options.label, aliases: options.aliases },
  })
  const { byName } = build({ client })
  const rendered = await byName.get('memory_projects').execute(
    { action: 'create', project: 'newlib', label: '新库', aliases: ['新库', 'newlib'] },
    AGENT,
  )
  assert.match(rendered, /已创建项目 newlib/)
  assert.match(rendered, /新库/)
})

test('memory_projects rejects a create without a project id', async () => {
  const { byName } = build()
  await assert.rejects(
    () => byName.get('memory_projects').execute({ action: 'create', label: '无 id' }, AGENT),
    /需要 project/,
  )
})

test('memory_projects resolves a phrase to a project', async () => {
  const client = stubClient()
  client.resolve = async () => ({ project: 'cheyidao', label: '车易到', matched: '车易到' })
  const { byName } = build({ client })
  const rendered = await byName.get('memory_projects').execute(
    { action: 'resolve', query: '车易到 结算' },
    AGENT,
  )
  assert.match(rendered, /cheyidao/)
  assert.match(rendered, /车易到/)
})


test('memory_setup explains deployment and mirrors the connection state', async () => {
  const { byName } = build()
  const text = await byName.get('memory_setup').execute({}, AGENT)
  assert.match(text, /memoryd/)
  assert.match(text, /--init-config/)
  assert.match(text, /已连接|未连接|不可达/)
  assert.match(text, /DSH_MEMORY_SERVER_URL/)
})

test('memory_setup reports an unreachable service instead of throwing', async () => {
  const { byName } = build({
    client: stubClient({
      health: () => {
        throw new MemoryError('记忆服务不可达', { code: 'unreachable' })
      },
    }),
  })
  const text = await byName.get('memory_setup').execute({}, AGENT)
  assert.match(text, /不可达/)
})

test('connection failures tell the caller to run memory_setup', async () => {
  const { byName } = build({
    client: stubClient({
      search: () => {
        throw new MemoryError('记忆服务不可达（http://127.0.0.1:8788）：fetch failed', {
          code: 'unreachable',
        })
      },
    }),
  })
  await assert.rejects(
    () => byName.get('memory_search').execute({ query: 'x' }, AGENT),
    (error) => {
      assert.match(error.message, /memory_setup/)
      assert.equal(error.code, 'unreachable')
      return true
    },
  )
})

test('request failures that are not about the connection stay untouched', async () => {
  const { byName } = build({
    client: stubClient({
      search: () => {
        throw new MemoryError('query 不能为空', { code: 'invalid-query' })
      },
    }),
  })
  await assert.rejects(
    () => byName.get('memory_search').execute({ query: 'x' }, AGENT),
    (error) => {
      assert.doesNotMatch(error.message, /memory_setup/)
      return true
    },
  )
})
