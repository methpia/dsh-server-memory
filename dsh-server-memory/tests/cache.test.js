import assert from 'node:assert/strict'
import test from 'node:test'

import { ContextCache } from '../lib/cache.js'
import { MemoryError } from '../lib/client.js'
import { normalizeConfig } from '../lib/config.js'

function settings(overrides = {}) {
  return normalizeConfig({ token: 'test-token', contextPollMs: 60_000, ...overrides })
}

function snapshotPayload(project, text) {
  return {
    project,
    items: [
      { id: 1, kind: 'note', text, tags: '', created_at: '2026-11-13T01:00:00Z' },
    ],
    total: 1,
    watermark: { last_consolidated: '', last_run_at: '', last_status: 'ok' },
    consolidation: { due: true },
  }
}

function stubClient(getContext) {
  return { getContext, calls: 0 }
}

test('a successful refresh fills the snapshot', async () => {
  let now = 1_000_000
  const client = stubClient(async (project) => {
    client.calls += 1
    return snapshotPayload(project, '一条记忆')
  })
  const cache = new ContextCache({ client, settings: settings(), clock: () => now })
  cache.touch('dsh')
  const snapshot = await cache.refresh('dsh', { force: true })
  assert.equal(snapshot.items.length, 1)
  assert.equal(snapshot.error, undefined)
  assert.equal(cache.snapshot('dsh').items[0].text, '一条记忆')
  assert.equal(client.calls, 1)
})

test('the server total survives the cache so the index can report it', async () => {
  const client = stubClient(async (project) => ({
    ...snapshotPayload(project, '显示出来的那一条'),
    total: 9,
  }))
  const cache = new ContextCache({ client, settings: settings() })
  cache.touch('dsh')
  const snapshot = await cache.refresh('dsh', { force: true })
  assert.equal(snapshot.items.length, 1)
  assert.equal(snapshot.total, 9)
})

test('a response without a total falls back to the displayed row count', async () => {
  const client = stubClient(async (project) => {
    const payload = snapshotPayload(project, '一条记忆')
    delete payload.total
    return payload
  })
  const cache = new ContextCache({ client, settings: settings() })
  cache.touch('dsh')
  const snapshot = await cache.refresh('dsh', { force: true })
  assert.equal(snapshot.total, 1)
})

test('a failure at startup yields an empty but usable snapshot', async () => {
  const errors = []
  const client = stubClient(async () => {
    throw new MemoryError('记忆服务不可达', { code: 'unreachable' })
  })
  const cache = new ContextCache({
    client,
    settings: settings(),
    onError: (message) => errors.push(message),
  })
  cache.touch('dsh')
  const snapshot = await cache.refresh('dsh', { force: true })
  assert.deepEqual(snapshot.items, [])
  assert.ok(snapshot.error.includes('不可达'))
  assert.equal(errors.length, 1)
  // A failed refresh must not be retried on the next read before the poll interval.
  assert.equal(cache.isStale('dsh'), false)
})

test('a later failure keeps the previously cached rows', async () => {
  let now = 1_000_000
  let fail = false
  const client = stubClient(async (project) => {
    if (fail) throw new MemoryError('服务挂了', { code: 'unreachable' })
    return snapshotPayload(project, '保留下来的记忆')
  })
  const cache = new ContextCache({ client, settings: settings(), clock: () => now })
  cache.touch('dsh')
  await cache.refresh('dsh', { force: true })

  fail = true
  now += 120_000
  const snapshot = await cache.refresh('dsh', { force: true })
  assert.equal(snapshot.items.length, 1)
  assert.equal(snapshot.items[0].text, '保留下来的记忆')
  assert.ok(snapshot.error.includes('服务挂了'))
})

test('invalidate forces a refresh after a write', async () => {
  let now = 1_000_000
  const client = stubClient(async (project) => {
    client.calls += 1
    return snapshotPayload(project, '新写入的记忆')
  })
  const cache = new ContextCache({ client, settings: settings(), clock: () => now })
  cache.touch('dsh')
  await cache.refresh('dsh', { force: true })
  assert.equal(client.calls, 1)

  cache.invalidate('dsh')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(client.calls, 2)
})

test('concurrent refreshes share one request', async () => {
  const client = stubClient(
    (project) =>
      new Promise((resolve) => {
        client.calls += 1
        resolveRequest = () => resolve(snapshotPayload(project, '并发只拉一次'))
      }),
  )
  let resolveRequest
  const cache = new ContextCache({ client, settings: settings() })
  cache.touch('dsh')
  const first = cache.refresh('dsh', { force: true })
  const second = cache.refresh('dsh', { force: true })
  await new Promise((resolve) => setImmediate(resolve))
  resolveRequest()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b)
  assert.equal(client.calls, 1)
})

test('start schedules a sweep that stops cleanly', async () => {
  let now = 1_000_000
  const client = stubClient(async (project) => {
    client.calls += 1
    return snapshotPayload(project, '定时刷新')
  })
  const cache = new ContextCache({ client, settings: settings(), clock: () => now })
  cache.touch('dsh')
  const stop = cache.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(client.calls, 1)
  stop()
  assert.equal(cache.timer, undefined)
})
