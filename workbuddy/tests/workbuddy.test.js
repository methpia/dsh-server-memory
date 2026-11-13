import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../../plugin/lib/config.js'
import { loadWorkbuddyConfig } from '../lib/config.mjs'
import {
  buildNoProjectHint,
  buildProjectInjection,
  buildSessionStartContext,
  hookOutput,
  projectDirectoryText,
} from '../lib/hooks.mjs'
import { resolveProject } from '../lib/project.mjs'
import { loadState, projectForCwd, pruneState, recentProject, remember } from '../lib/state.mjs'
import {
  collectDigestForProject,
  extractEntries,
  stripSystemReminders,
} from '../lib/transcripts.mjs'
import { runUserPrompt } from '../hooks/user-prompt.mjs'
import { createMcpServer, normalizeNotes } from '../mcp-server.mjs'

function settings(overrides = {}) {
  return normalizeConfig({ token: 'test-token', ...overrides })
}

function fakeClient(overrides = {}) {
  const calls = []
  const wrap = (name, fallback) => async (...args) => {
    calls.push({ name, args })
    return (overrides[name] ?? fallback)(...args)
  }
  return {
    calls,
    resolve: wrap('resolve', (text) => ({
      project: text.includes('车易到') ? 'cheyidao' : null,
      label: '车易到',
      matched: '车易到',
      candidates: [],
    })),
    listProjects: wrap('listProjects', () => ({
      projects: [
        { id: 'cheyidao', label: '车易到', aliases: ['车易到', 'cheyidao'], items: 12, last_note_at: '' },
        { id: 'dsh', label: 'dsh', aliases: ['dsh'], items: 9, last_note_at: '' },
      ],
    })),
    search: wrap('search', () => ({
      items: [{ id: 3, kind: 'note', text: '[决策] 结算改为按日结', created_at: '2026-11-13T01:20:00Z' }],
    })),
    saveNotes: wrap('saveNotes', (_project, notes) => ({
      stored: notes.length,
      ids: notes.map((_note, index) => index + 1),
    })),
    forget: wrap('forget', () => ({ deleted: true })),
    claim: wrap('claim', () => ({ claimed: false, reason: 'too_soon' })),
    setWatermark: wrap('setWatermark', () => ({ ok: true })),
    getContext: wrap('getContext', (project) => ({
      project,
      items: [{ id: 1, kind: 'note', text: '[决策] 车易到结算按日结', created_at: '2026-11-13T01:20:00Z' }],
      total: 4,
      watermark: {},
      consolidation: { due: false },
    })),
  }
}

  // A state write can land between our last await and the removal; Node's rm
  // retries on ENOTEMPTY, which is exactly this race (seen on Linux CI).
  const cleanup = (directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

async function tempStateFile() {
  const directory = await mkdtemp(join(tmpdir(), 'dshm-wb-'))
  return { directory, file: join(directory, 'state.json') }
}

test('the WorkBuddy config prefers env, tolerates a BOM, and keeps defaults', async () => {
  const { directory, file } = await tempStateFile()
  try {
    await writeFile(
      file,
      `\uFEFF${JSON.stringify({ serverUrl: 'http://192.168.5.5:8788', tokenFile: '~/secret/token' })}`,
      'utf8',
    )
    const loaded = await loadWorkbuddyConfig({ DSH_MEMORY_CONFIG: file })
    assert.equal(loaded.serverUrl, 'http://192.168.5.5:8788')
    assert.ok(loaded.tokenFile.replace(/\\/g, '/').endsWith('secret/token'))
    assert.equal(loaded.indexMaxItems, 6)
    assert.equal(loaded.indexMaxChars, 900)

    const overridden = await loadWorkbuddyConfig({
      DSH_MEMORY_CONFIG: file,
      DSH_MEMORY_URL: 'http://127.0.0.1:9999',
      DSH_MEMORY_TOKEN_FILE: '/tmp/token',
    })
    assert.equal(overridden.serverUrl, 'http://127.0.0.1:9999')
    assert.equal(overridden.tokenFile.replace(/\\/g, '/'), '/tmp/token')
  } finally {
    await cleanup(directory)
  }
})

test('state records projects per session and per cwd, then expires them', async () => {
  const state = { version: 1, sessions: {}, cwds: {} }
  const now = Date.now()
  remember(state, { sessionId: 's1', cwd: 'D:\\项目成果\\2026-06-30-20-54-55', project: 'cheyidao' }, now)
  assert.equal(state.sessions.s1.project, 'cheyidao')
  assert.equal(projectForCwd(state, 'D:\\项目成果\\2026-06-30-20-54-55', now), 'cheyidao')
  assert.equal(recentProject(state, now), 'cheyidao')

  const later = now + 13 * 60 * 60 * 1000
  assert.equal(projectForCwd(state, 'D:\\项目成果\\2026-06-30-20-54-55', later), undefined)
  assert.equal(recentProject(state, later), undefined)

  const pruned = pruneState(
    {
      version: 1,
      sessions: {
        old: { project: 'x', at: now - 8 * 24 * 60 * 60 * 1000 },
        fresh: { project: 'y', at: now },
      },
      cwds: { old: { project: 'x', at: now - 8 * 24 * 60 * 60 * 1000 } },
      recent: { project: 'y', at: now },
    },
    now,
  )
  assert.deepEqual(Object.keys(pruned.sessions), ['fresh'])
  assert.deepEqual(Object.keys(pruned.cwds), [])
})

test('state files are optional and default to empty', async () => {
  const state = await loadState('/definitely/missing/state.json')
  assert.deepEqual(state, { version: 1, sessions: {}, cwds: {} })
})

test('project resolution order: explicit, text, session, cwd, recent, default', async () => {
  const client = fakeClient()
  const state = { version: 1, sessions: { s1: { project: 'dsh', at: Date.now() } }, cwds: {} }

  assert.deepEqual(
    (await resolveProject({ client, explicit: 'cheyidao', text: '聊聊别的', state, defaultProject: 'default' }))
      .project,
    'cheyidao',
  )
  assert.equal(
    (await resolveProject({ client, text: '车易到那边的结算', state, sessionId: 's1', defaultProject: 'default' }))
      .project,
    'cheyidao',
  )
  assert.deepEqual(
    await resolveProject({ client, text: '继续', state, sessionId: 's1', defaultProject: 'default' }),
    { project: 'dsh', source: 'session' },
  )
  assert.deepEqual(
    await resolveProject({ client, text: '继续', state: { sessions: {}, cwds: {} }, text2: 'x', defaultProject: 'fallback' }),
    { project: 'fallback', source: 'default' },
  )
})

test('project resolution falls back to cwd/recent memory when text matches nothing', async () => {
  const client = fakeClient()
  const now = Date.now()
  const state = {
    version: 1,
    sessions: {},
    cwds: { 'D:\\tmp\\2026-01-01-00-00-00': { project: 'cheyidao', at: now } },
    recent: { project: 'dsh', at: now },
  }
  const fromCwd = await resolveProject({
    client,
    text: '今天天气不错',
    state,
    cwd: 'D:\\tmp\\2026-01-01-00-00-00',
    defaultProject: 'default',
  })
  assert.deepEqual(fromCwd, { project: 'cheyidao', source: 'cwd' })

  const fromRecent = await resolveProject({
    client,
    text: '今天天气不错',
    state: { ...state, cwds: {} },
    cwd: 'D:\\tmp\\other',
    defaultProject: 'default',
  })
  assert.deepEqual(fromRecent, { project: 'dsh', source: 'recent' })
})

test('a resolve outage does not throw', async () => {
  const client = fakeClient({
    resolve: () => {
      throw new Error('ECONNREFUSED')
    },
  })
  const resolved = await resolveProject({
    client,
    text: '车易到',
    state: { sessions: {}, cwds: {} },
    defaultProject: 'default',
  })
  assert.deepEqual(resolved, { project: 'default', source: 'default' })
})

test('the session-start context replaces directory-based project detection', () => {
  const text = buildSessionStartContext({
    projects: [
      { id: 'cheyidao', label: '车易到', aliases: ['cheyidao', '车易到', '汽修'], items: 12 },
      { id: 'dsh', label: 'dsh', aliases: ['dsh'], items: 9 },
    ],
    cwd: 'D:\\项目成果\\2026-06-30-20-54-55',
    available: true,
  })
  assert.ok(text.includes('已知项目'))
  assert.ok(text.includes('cheyidao（车易到，别名：cheyidao / 车易到 / 汽修，12 条）'))
  assert.ok(text.includes('不能用来判断项目'))
  assert.ok(text.includes('memory_search'))
})

test('session-start stays silent when the service is unavailable', () => {
  assert.equal(buildSessionStartContext({ projects: [], cwd: 'x', available: false }), '')
  assert.ok(
    buildSessionStartContext({ projects: [], cwd: 'x', available: true }).includes('还没有任何项目记录'),
  )
  assert.equal(projectDirectoryText([]), '')
})

test('the no-project hint lists known projects', () => {
  const hint = buildNoProjectHint([
    { id: 'cheyidao', label: '车易到', aliases: ['车易到'], items: 3 },
  ])
  assert.ok(hint.includes('未从这句话识别到项目'))
  assert.ok(hint.includes('cheyidao'))
})

test('the project injection reuses the shared index renderer once', () => {
  const text = buildProjectInjection({
    project: 'cheyidao',
    label: '车易到',
    matched: '车易到',
    settings: settings({ indexMaxItems: 6, indexMaxChars: 900 }),
    snapshot: {
      project: 'cheyidao',
      items: [{ id: 1, kind: 'note', text: '[决策] 结算改为按日结', created_at: '2026-11-13T01:20:00Z' }],
      total: 4,
      consolidation: { due: true },
      fetchedAt: Date.now(),
    },
  })
  assert.ok(text.startsWith('## 项目记忆（cheyidao｜车易到，由“车易到”识别）'))
  assert.equal((text.match(/## 项目记忆/g) ?? []).length, 1)
  assert.ok(text.includes('[决策] 结算改为按日结'))
  assert.ok(text.includes('共 4 条'))
  // buildProjectInjection itself must not advertise the DSH-only due hint; the
  // WorkBuddy hook adds its own single line when the window is due.
  assert.ok(!text.includes('memory_consolidate'))
})

test('hookOutput wraps text in the hook protocol envelope', () => {
  assert.deepEqual(hookOutput('UserPromptSubmit', 'hello'), {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hello' },
  })
  assert.equal(hookOutput('UserPromptSubmit', '   '), undefined)
})

test('normalizeNotes accepts text and notes, like the DSH tool', () => {
  assert.deepEqual(normalizeNotes({ text: '一条', tags: ['偏好'] }), [{ text: '一条', tags: ['偏好'] }])
  assert.deepEqual(normalizeNotes({ notes: [{ text: 'a' }, { text: ' ' }] }), [{ text: 'a', tags: [] }])
  assert.deepEqual(normalizeNotes({}), [])
})

test('the MCP server speaks initialize, tools/list and tools/call', async () => {
  const { directory, file } = await tempStateFile()
  try {
    const client = fakeClient()
    const server = createMcpServer({
      settings: settings(),
      client,
      stateFile: file,
      cwd: 'D:\\项目成果\\2026-06-30-20-54-55',
    })
    await server.ready

    const initialize = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'workbuddy' } },
    })
    assert.equal(initialize.result.protocolVersion, '2025-06-18')
    assert.equal(initialize.result.serverInfo.name, 'dsh-memory')

    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      ['memory_search', 'memory_save', 'memory_consolidate', 'memory_forget', 'memory_projects'],
    )

    const search = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: '车易到 结算' } },
    })
    assert.equal(search.result.isError, false)
    assert.ok(search.result.content[0].text.includes('项目 cheyidao'))
    assert.ok(search.result.content[0].text.includes('结算改为按日结'))
    assert.equal(client.calls.find((call) => call.name === 'search').args[0], 'cheyidao')

    const save = await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'memory_save', arguments: { text: '车易到结算按日结', tags: ['决策'] } },
    })
    assert.equal(save.result.isError, false)
    assert.ok(save.result.content[0].text.includes('已写入项目 cheyidao'))

    const projects = await server.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'memory_projects', arguments: {} },
    })
    assert.ok(projects.result.content[0].text.includes('cheyidao（车易到）'))

    const unknown = await server.handle({ jsonrpc: '2.0', id: 6, method: 'nope' })
    assert.equal(unknown.error.code, -32601)

    const toolFailure = await server.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: '' } },
    })
    assert.equal(toolFailure.result.isError, true)
  } finally {
    await cleanup(directory)
  }
})

test('a memory outage becomes a tool error, not a crash', async () => {
  const { directory, file } = await tempStateFile()
  try {
    const server = createMcpServer({
      settings: settings(),
      client: fakeClient({
        search: () => {
          throw new Error('记忆服务不可达')
        },
      }),
      stateFile: file,
    })
    await server.ready
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'x', project: 'cheyidao' } },
    })
    assert.equal(response.result.isError, true)
    assert.ok(response.result.content[0].text.includes('不可达'))
  } finally {
    await cleanup(directory)
  }
})

// ---------------------------------------------------------------------------
// WorkBuddy consolidation
// ---------------------------------------------------------------------------

function transcriptEvents(now) {
  return [
    { type: 'session-meta', sessionId: 's1', timestamp: now, cwd: 'D:\\项目成果\\2026-11-13-21-00-00' },
    {
      type: 'message',
      role: 'user',
      timestamp: now - 60_000,
      sessionId: 's1',
      providerData: { startsNewUserRequest: true },
      content: [
        {
          type: 'input_text',
          text: '<system-reminder data-role="user-context">\nOS Version: win32\n</system-reminder>\n把车易到的结算改成按日结',
        },
      ],
    },
    { type: 'message', role: 'assistant', timestamp: now - 50_000, content: [{ type: 'output_text', text: '我看一下代码。' }] },
    { type: 'message', role: 'assistant', timestamp: now - 40_000, content: [{ type: 'output_text', text: '已改成按日结，并补了对账页的当日汇总。' }] },
    {
      type: 'message',
      role: 'user',
      timestamp: now - 30_000,
      sessionId: 's1',
      providerData: { startsNewUserRequest: true },
      content: [{ type: 'input_text', text: '再补一个导出按钮' }],
    },
    { type: 'message', role: 'assistant', timestamp: now - 20_000, content: [{ type: 'output_text', text: '导出按钮已经加好。' }] },
  ]
}

test('WorkBuddy transcript entries drop reminders and keep one reply per turn', () => {
  const now = Date.now()
  const entries = extractEntries(transcriptEvents(now))
  assert.deepEqual(entries.map((entry) => entry.role), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(entries[0].text, '把车易到的结算改成按日结')
  assert.equal(entries[1].text, '已改成按日结，并补了对账页的当日汇总。')
  assert.equal(entries[3].text, '导出按钮已经加好。')

  assert.equal(
    stripSystemReminders('<system-reminder>\n内部提示\n</system-reminder>\n真正的输入'),
    '真正的输入',
  )
})

test('collectDigestForProject reads the transcript the hook recorded', async () => {
  const { directory, file } = await tempStateFile()
  try {
    const transcript = join(directory, 's1.jsonl')
    const now = Date.now()
    await writeFile(transcript, transcriptEvents(now).map((event) => JSON.stringify(event)).join('\n'), 'utf8')
    const state = {
      version: 1,
      sessions: { s1: { project: 'cheyidao', transcriptPath: transcript, at: now } },
      cwds: {},
    }
    const collected = await collectDigestForProject({
      project: 'cheyidao',
      state,
      projectsRoot: join(directory, 'projects'),
      sinceMs: null,
      untilMs: now + 1000,
    })
    assert.equal(collected.sessions, 1)
    assert.equal(collected.entries.length, 4)
    assert.deepEqual(collected.warnings, [])
  } finally {
    await cleanup(directory)
  }
})

test('memory_consolidate returns a digest and memory_save commits it', async () => {
  const { directory, file } = await tempStateFile()
  try {
    const transcript = join(directory, 's1.jsonl')
    const now = Date.now()
    await writeFile(transcript, transcriptEvents(now).map((event) => JSON.stringify(event)).join('\n'), 'utf8')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sessions: { s1: { project: 'cheyidao', transcriptPath: transcript, at: now } },
        cwds: {},
      }),
      'utf8',
    )
    const client = fakeClient({ claim: () => ({ claimed: true, since: null }) })
    const server = createMcpServer({ settings: settings(), client, stateFile: file })
    await server.ready

    const digest = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory_consolidate', arguments: { project: 'cheyidao' } },
    })
    assert.equal(digest.result.isError, false, digest.result.content[0].text)
    const text = digest.result.content[0].text
    assert.ok(text.includes('【记忆整理任务】项目 cheyidao'))
    assert.ok(text.includes('把车易到的结算改成按日结'))
    const match = text.match(/consolidationId: "([^"]+)"/)
    assert.ok(match, text)

    const saved = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'memory_save',
        arguments: { notes: [{ text: '[决策] 结算按日结' }], consolidationId: match[1] },
      },
    })
    assert.equal(saved.result.isError, false, saved.result.content[0].text)
    assert.ok(saved.result.content[0].text.includes('已写入 1 条记忆'))

    const notesCall = client.calls.find((call) => call.name === 'saveNotes')
    assert.equal(notesCall.args[2].source, 'consolidate')
    assert.equal(notesCall.args[2].kind, 'note')
    const watermarkCall = client.calls.find((call) => call.name === 'setWatermark')
    assert.equal(watermarkCall.args[1].status, 'ok')
    assert.ok(watermarkCall.args[1].lastConsolidated.endsWith('Z'))
  } finally {
    await cleanup(directory)
  }
})

test('memory_consolidate reports a recent window without reading transcripts', async () => {
  const { directory, file } = await tempStateFile()
  try {
    const server = createMcpServer({
      settings: settings(),
      client: fakeClient({ claim: () => ({ claimed: false, reason: 'too_soon', next_at: '2026-11-14T08:03:04Z' }) }),
      stateFile: file,
    })
    await server.ready
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory_consolidate', arguments: { project: 'cheyidao' } },
    })
    assert.ok(response.result.content[0].text.includes('无需聚合'))
    assert.ok(response.result.content[0].text.includes('too_soon'))
  } finally {
    await cleanup(directory)
  }
})

test('the daily consolidation hint is injected once per session', async () => {
  const { directory, file } = await tempStateFile()
  try {
    const client = fakeClient({
      getContext: (project) => ({
        project,
        items: [{ id: 1, kind: 'note', text: '[决策] 车易到结算按日结', created_at: '2026-11-13T01:20:00Z' }],
        total: 4,
        watermark: {},
        consolidation: { due: true },
      }),
    })
    const adapterSettings = { ...settings(), stateFile: file, dailyConsolidationHint: true }
    const payload = {
      session_id: 'wb-session',
      cwd: 'D:\\项目成果\\2026-11-13-21-00-00',
      transscript_path: undefined,
      prompt: '帮我看看车易到的结算模块',
    }
    const first = await runUserPrompt(payload, { settings: adapterSettings, client })
    const text = first?.hookSpecificOutput?.additionalContext ?? ''
    assert.ok(text.includes('## 项目记忆（cheyidao'))
    assert.ok(text.includes('记忆聚合已到期'))
    assert.ok(text.includes('memory_consolidate'))

    const second = await runUserPrompt({ ...payload, prompt: '继续' }, { settings: adapterSettings, client })
    assert.equal(second, undefined)
  } finally {
    await cleanup(directory)
  }
})
