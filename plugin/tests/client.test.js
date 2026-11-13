import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryClient, MemoryError, describeMemoryError } from '../lib/client.js'
import { normalizeConfig } from '../lib/config.js'

function settings(overrides = {}) {
  return normalizeConfig({ serverUrl: 'http://memory.test:8788', token: 'secret', ...overrides })
}

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  impl.calls = calls
  return impl
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }
}

test('requests carry the bearer token and the expected query', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(200, { project: 'dsh', items: [], watermark: {}, consolidation: {} }),
  )
  const client = new MemoryClient(settings(), { fetchImpl })
  await client.getContext('dsh', { limit: 6, maxChars: 1500 })

  assert.equal(fetchImpl.calls.length, 1)
  const [call] = fetchImpl.calls
  assert.equal(call.url, 'http://memory.test:8788/api/context?project=dsh&limit=6&max_chars=1500')
  assert.equal(call.init.method, 'GET')
  assert.equal(call.init.headers.authorization, 'Bearer secret')
})

test('health is requested without a token', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { ok: true, version: 1 }))
  const client = new MemoryClient(settings({ token: '' }), { fetchImpl })
  const health = await client.health()
  assert.equal(health.ok, true)
  assert.equal(fetchImpl.calls[0].init.headers.authorization, undefined)
})

test('a missing token fails before any network call', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, {}))
  const client = new MemoryClient(settings({ token: '' }), {
    fetchImpl,
    tokenProvider: async () => '',
  })
  await assert.rejects(
    () => client.getContext('dsh'),
    (error) => error instanceof MemoryError && error.code === 'no-token',
  )
  assert.equal(fetchImpl.calls.length, 0)
})

test('server errors keep their code and message', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(413, { error: { code: 'text-too-long', message: 'text is 4001 characters' } }),
  )
  const client = new MemoryClient(settings(), { fetchImpl })
  await assert.rejects(
    () => client.saveItem('dsh', 'x'),
    (error) =>
      error instanceof MemoryError &&
      error.code === 'text-too-long' &&
      error.status === 413 &&
      error.message.includes('4001'),
  )
})

test('a 401 without a JSON body still yields a usable error', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 401, text: async () => '' }))
  const client = new MemoryClient(settings(), { fetchImpl })
  await assert.rejects(
    () => client.search('dsh', '日结'),
    (error) => error instanceof MemoryError && error.code === 'http-401',
  )
})

test('network failures are reported as unreachable', async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error('ECONNREFUSED')
  })
  const client = new MemoryClient(settings(), { fetchImpl })
  await assert.rejects(
    () => client.getContext('dsh'),
    (error) =>
      error instanceof MemoryError && error.code === 'unreachable' && error.message.includes('ECONNREFUSED'),
  )
})

test('non-JSON responses are reported instead of parsed silently', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, text: async () => '<html>' }))
  const client = new MemoryClient(settings(), { fetchImpl })
  await assert.rejects(
    () => client.getContext('dsh'),
    (error) => error instanceof MemoryError && error.code === 'bad-response',
  )
})

test('saveNotes sends a UTF-8 JSON body', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { stored: 1, ids: [7] }))
  const client = new MemoryClient(settings(), { fetchImpl })
  const result = await client.saveNotes('dsh', [{ text: '[决策] 按日结', tags: ['结算'] }], {
    source: 'consolidate',
    kind: 'note',
  })
  assert.deepEqual(result.ids, [7])
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.project, 'dsh')
  assert.equal(body.notes[0].text, '[决策] 按日结')
  assert.equal(body.source, 'consolidate')
  assert.equal(body.kind, 'note')
})

test('claim and watermark use the documented endpoints', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith('/api/watermark/claim')) return jsonResponse(200, { claimed: true, since: null })
    return jsonResponse(200, { ok: true })
  })
  const client = new MemoryClient(settings(), { fetchImpl })
  await client.claim('dsh')
  await client.setWatermark('dsh', { lastConsolidated: '2026-11-12T09:00:00Z', status: 'ok' })
  assert.ok(fetchImpl.calls[0].url.endsWith('/api/watermark/claim'))
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    project: 'dsh',
    min_interval_hours: 24,
  })
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), {
    project: 'dsh',
    last_consolidated: '2026-11-12T09:00:00Z',
    status: 'ok',
    error: '',
  })
})

test('describeMemoryError never leaks the token', () => {
  const error = new MemoryError('记忆服务不可达', { code: 'unreachable' })
  assert.equal(describeMemoryError(error), '记忆服务不可达（unreachable）')
  assert.ok(!describeMemoryError(error).includes('secret'))
})
