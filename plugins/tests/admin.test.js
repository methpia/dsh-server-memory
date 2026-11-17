import assert from 'node:assert/strict'
import test from 'node:test'

import { createAdminRoute, publicSettings } from '../lib/admin.js'
import { normalizeConfig } from '../lib/config.js'

function settings(overrides = {}) {
  return normalizeConfig({ serverUrl: 'http://memory.test:8788', token: 'secret-token', ...overrides })
}

function fakeClient(overrides = {}) {
  const calls = []
  const wrap = (name, fallback) => async (...args) => {
    calls.push({ name, args })
    return (overrides[name] ?? fallback)(...args)
  }
  return {
    calls,
    health: wrap('health', () => ({ ok: true, items: 9, projects: 1 })),
    listProjects: wrap('listProjects', () => ({
      projects: [{ id: 'cheyidao', label: '车易到', aliases: ['车易到'], items: 12 }],
    })),
    upsertProject: wrap('upsertProject', (project, options) => ({
      project: { id: project, label: options.label ?? project, aliases: options.aliases ?? [] },
    })),
  }
}

function context(editor) {
  return {
    fiber: { entry: { id: 'dsh-server-memory' } },
    get: (name) => (name === 'configEditor' ? editor : undefined),
  }
}

function request(route, body) {
  return route.fetch(
    new Request('http://localhost/api/dsh-server-memory', {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

test('GET exposes the settings the page needs, without the token', async () => {
  const route = createAdminRoute({
    ctx: context({}),
    client: fakeClient(),
    settings: settings(),
    config: {},
  })
  const response = await request(route)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.settings.serverUrl, 'http://memory.test:8788')
  assert.equal(payload.settings.hasToken, true)
  assert.equal(JSON.stringify(payload).includes('secret-token'), false)
})

test('publicSettings never includes the raw token', () => {
  const visible = publicSettings(settings())
  assert.equal(visible.hasToken, true)
  assert.equal('token' in visible, false)
})

test('save-settings persists the normalised config through configEditor', async () => {
  const edits = []
  const editor = {
    edit: async (entry, change) => {
      edits.push({ entry, config: change({}) })
    },
  }
  const route = createAdminRoute({
    ctx: context(editor),
    client: fakeClient(),
    settings: settings(),
    config: { serverUrl: 'http://memory.test:8788', token: 'secret-token' },
  })
  const response = await request(route, {
    action: 'save-settings',
    patch: {
      serverUrl: 'http://192.168.5.5:8788/',
      tokenFile: '~/.config/dsh-memory/token',
      indexMaxItems: 8,
      indexMaxChars: 1200,
      consolidationEnabled: false,
    },
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.saved, true)
  assert.equal(edits.length, 1)
  const persisted = edits[0].config
  assert.equal(persisted.serverUrl, 'http://192.168.5.5:8788')
  assert.equal(persisted.indexMaxItems, 8)
  assert.equal(persisted.indexMaxChars, 1200)
  assert.equal(persisted.consolidationEnabled, false)
  assert.equal(persisted.token, 'secret-token')
})

test('save-settings rejects an invalid URL before editing anything', async () => {
  let edited = false
  const route = createAdminRoute({
    ctx: context({ edit: async () => { edited = true } }),
    client: fakeClient(),
    settings: settings(),
    config: {},
  })
  const response = await request(route, {
    action: 'save-settings',
    patch: { serverUrl: 'ftp://nope' },
  })
  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.code, 'invalid-server-url')
  assert.equal(edited, false)
})

test('save-settings fails clearly when the host has no config editor', async () => {
  const route = createAdminRoute({
    ctx: { fiber: undefined, get: () => undefined },
    client: fakeClient(),
    settings: settings(),
    config: {},
  })
  const response = await request(route, { action: 'save-settings', patch: { serverUrl: 'http://x:1' } })
  assert.equal(response.status, 503)
  const payload = await response.json()
  assert.equal(payload.code, 'config-unavailable')
})

test('health and project actions proxy to the memory service', async () => {
  const client = fakeClient()
  const route = createAdminRoute({ ctx: context({}), client, settings: settings(), config: {} })

  const health = await (await request(route, { action: 'health' })).json()
  assert.equal(health.ok, true)
  assert.equal(health.health.items, 9)

  const projects = await (await request(route, { action: 'projects' })).json()
  assert.equal(projects.ok, true)
  assert.equal(projects.projects[0].id, 'cheyidao')

  const saved = await (await request(route, {
    action: 'save-project',
    project: 'cheyidao',
    label: '车易到',
    aliases: ['车易到', 'cheyidao'],
  })).json()
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.project.aliases, ['车易到', 'cheyidao'])
})

test('a service outage is reported to the page instead of throwing', async () => {
  const route = createAdminRoute({
    ctx: context({}),
    client: fakeClient({
      health: () => {
        throw new Error('ECONNREFUSED')
      },
    }),
    settings: settings(),
    config: {},
  })
  const payload = await (await request(route, { action: 'health' })).json()
  assert.equal(payload.ok, false)
  assert.ok(payload.error.includes('ECONNREFUSED'))
})

test('unknown actions are rejected', async () => {
  const route = createAdminRoute({ ctx: context({}), client: fakeClient(), settings: settings(), config: {} })
  const response = await request(route, { action: 'nope' })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'unknown-action')
})
