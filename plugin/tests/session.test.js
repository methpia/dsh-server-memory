import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionDirectoryResolver, readSessionDirectory } from '../lib/session.js'

test('readSessionDirectory accepts the known Session shapes', () => {
  assert.equal(readSessionDirectory({ cwd: 'D:\\dev' }), 'D:\\dev')
  assert.equal(readSessionDirectory({ directory: '/srv/app' }), '/srv/app')
  assert.equal(readSessionDirectory({ header: { cwd: 'D:\\dev\\work' } }), 'D:\\dev\\work')
  assert.equal(readSessionDirectory({ meta: { directory: '/srv/app' } }), '/srv/app')
  assert.equal(readSessionDirectory({ cwd: '' }), '')
  assert.equal(readSessionDirectory(undefined), '')
  assert.equal(readSessionDirectory('D:\\dev'), '')
})

test('the resolver prefers a directory carried by the scope itself', () => {
  const resolve = createSessionDirectoryResolver({
    getSessions: () => ({ get: () => ({ cwd: 'D:\\other' }) }),
  })
  assert.equal(resolve({ id: 'session-1', cwd: 'D:\\dev' }), 'D:\\dev')
})

test('the resolver looks the session up by agent id', () => {
  const seen = []
  const resolve = createSessionDirectoryResolver({
    getSessions: () => ({
      get: (id) => {
        seen.push(id)
        return { header: { cwd: 'D:\\dev' } }
      },
    }),
  })
  assert.equal(resolve({ id: 'session-1' }), 'D:\\dev')
  assert.deepEqual(seen, ['session-1'])
})

test('the resolver degrades to an empty string instead of throwing', () => {
  const throwing = createSessionDirectoryResolver({
    getSessions: () => {
      throw new Error('service unavailable')
    },
  })
  assert.equal(throwing({ id: 'session-1' }), '')
  assert.equal(createSessionDirectoryResolver({ getSessions: () => undefined })({ id: 'x' }), '')
  assert.equal(createSessionDirectoryResolver({})({ id: 'x' }), '')
  assert.equal(createSessionDirectoryResolver({})(undefined), '')
})
