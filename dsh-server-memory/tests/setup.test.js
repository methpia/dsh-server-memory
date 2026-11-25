import assert from 'node:assert/strict'
import test from 'node:test'

import { bundledServerPath, deploymentText, setupHintFor } from '../lib/setup.js'

test('the package ships memoryd.py next to lib/', () => {
  const path = bundledServerPath()
  assert.ok(path !== null, 'server/memoryd.py is missing from the package')
  assert.ok(path.endsWith('memoryd.py'))
})

test('deployment text uses the bundled server when it exists', () => {
  const text = deploymentText({ serverUrl: 'http://127.0.0.1:8788', bundledPath: '/pkg/server/memoryd.py' })
  assert.match(text, /\/pkg\/server\/memoryd\.py/)
  assert.doesNotMatch(text, /git clone/)
})

test('deployment text falls back to clone instructions without a bundled server', () => {
  const text = deploymentText({ serverUrl: 'http://127.0.0.1:8788', bundledPath: null })
  assert.match(text, /git clone/)
  assert.match(text, /memoryd\.py --init-config/)
})

test('deployment text states the connection problem it was given', () => {
  const unreachable = deploymentText({ serverUrl: 'http://x:8788', reachable: false })
  assert.match(unreachable, /不可达/)
  const rejected = deploymentText({ serverUrl: 'http://x:8788', reachable: true, tokenRejected: true })
  assert.match(rejected, /token 缺失或被拒绝/)
  const ok = deploymentText({ serverUrl: 'http://x:8788', reachable: true, hasToken: true })
  assert.match(ok, /已连接/)
})

test('the setup hint only fires for connection problems', () => {
  assert.match(setupHintFor({ code: 'unreachable' }), /memory_setup/)
  assert.match(setupHintFor({ code: 'no-token' }), /memory_setup/)
  assert.match(setupHintFor({ status: 401 }), /memory_setup/)
  assert.equal(setupHintFor({ code: 'invalid-query' }), '')
  assert.equal(setupHintFor(new Error('boom')), '')
})

test('the bundled memoryd.py has not drifted from the repository copy', async (t) => {
  const repoCopy = new URL('../../server/memoryd.py', import.meta.url)
  const { existsSync } = await import('node:fs')
  if (!existsSync(repoCopy)) {
    t.skip('installed package: the repository copy is not present')
    return
  }
  const { readFile: read } = await import('node:fs/promises')
  const [bundled, original] = await Promise.all([
    read(new URL('../server/memoryd.py', import.meta.url)),
    read(repoCopy),
  ])
  assert.deepEqual(
    bundled,
    original,
    'dsh-server-memory/server/memoryd.py differs from server/memoryd.py — copy the repository file over',
  )
})
