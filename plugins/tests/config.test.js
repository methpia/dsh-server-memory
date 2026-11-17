import assert from 'node:assert/strict'
import { join, normalize as normalizePath } from 'node:path'
import test from 'node:test'

import {
  DEFAULTS,
  clampInt,
  expandHome,
  normalizeConfig,
  sanitizeProjectName,
} from '../lib/config.js'

/** Compare paths the way the plugin does: forward slashes, native casing. */
const comparable = (value) => normalizePath(value).replace(/\\/g, '/')

test('empty config yields documented defaults', () => {
  const settings = normalizeConfig(undefined)
  assert.equal(settings.serverUrl, DEFAULTS.serverUrl)
  assert.equal(settings.defaultProject, 'default')
  assert.equal(settings.indexMaxItems, 6)
  assert.equal(settings.indexMaxChars, 900)
  assert.equal(settings.digestMaxChars, 8000)
  assert.equal(settings.consolidationEnabled, true)
  assert.deepEqual(settings.projectMap, {})
})

test('invalid server URLs fall back and report a problem', () => {
  const settings = normalizeConfig({ serverUrl: 'ftp://example.com' })
  assert.equal(settings.serverUrl, DEFAULTS.serverUrl)
  assert.ok(settings.problems.some((problem) => problem.includes('serverUrl')))
})

test('server URL keeps a base path and drops trailing slashes', () => {
  assert.equal(normalizeConfig({ serverUrl: 'http://10.0.0.2:8788/' }).serverUrl, 'http://10.0.0.2:8788')
  assert.equal(
    normalizeConfig({ serverUrl: 'https://mac-mini.ts.net/memory/' }).serverUrl,
    'https://mac-mini.ts.net/memory',
  )
})

test('numeric settings are clamped into their documented ranges', () => {
  const settings = normalizeConfig({
    indexMaxItems: 500,
    indexMaxChars: 1,
    searchResults: 0,
    digestMaxChars: 999_999,
    claimIntervalHours: 0,
    contextPollMs: 1,
    transcriptMaxCharsPerEntry: 0,
  })
  assert.equal(settings.indexMaxItems, 20)
  assert.equal(settings.indexMaxChars, 200)
  assert.equal(settings.searchResults, 1)
  assert.equal(settings.digestMaxChars, 40_000)
  assert.equal(settings.claimIntervalHours, 0.25)
  assert.equal(settings.contextPollMs, 60_000)
  assert.equal(settings.transcriptMaxCharsPerEntry, 200)
})

test('non-numeric values fall back instead of becoming NaN', () => {
  const settings = normalizeConfig({ indexMaxItems: 'many', requestTimeoutMs: null })
  assert.equal(settings.indexMaxItems, 6)
  assert.equal(settings.requestTimeoutMs, 8000)
})

test('tokenFile expands a leading tilde', () => {
  const settings = normalizeConfig({ tokenFile: '~/secret/token' }, { home: '/home/scott' })
  assert.equal(comparable(settings.tokenFile), comparable(join('/home/scott', 'secret/token')))
})

test('a missing token is reported once', () => {
  const settings = normalizeConfig({})
  assert.equal(settings.problems.filter((problem) => problem.includes('token')).length, 1)
})

test('projectMap keeps valid entries and reports invalid ones', () => {
  const settings = normalizeConfig(
    {
      projectMap: {
        'D:\\dev': 'dsh',
        'D:\\projects': 'workbuddy-tasks',
        '': 'ignored',
        'D:\\bad': '',
      },
    },
    { home: 'C:/Users/Scott' },
  )
  const mapped = new Map(
    Object.entries(settings.projectMap).map(([key, project]) => [comparable(key), project]),
  )
  assert.equal(mapped.size, 2)
  assert.equal(mapped.get('D:/dev'), 'dsh')
  assert.equal(mapped.get('D:/projects'), 'workbuddy-tasks')
  assert.ok(settings.problems.some((problem) => problem.includes('empty directory key')))
  assert.ok(settings.problems.some((problem) => problem.includes('D:\\bad')))
})

test('sanitizeProjectName keeps unicode letters and trims separators', () => {
  assert.equal(sanitizeProjectName('车易到'), '车易到')
  assert.equal(sanitizeProjectName('  work buddy  '), 'work-buddy')
  assert.equal(sanitizeProjectName('..dsh..'), 'dsh')
  assert.equal(sanitizeProjectName('', 'fallback'), 'fallback')
})

test('clampInt truncates and clamps', () => {
  assert.equal(clampInt(3.9, 1, 1, 10), 3)
  assert.equal(clampInt(undefined, 7, 1, 10), 7)
  assert.equal(clampInt('8', 1, 1, 10), 8)
  assert.equal(clampInt(99, 1, 1, 10), 10)
})

test('expandHome leaves absolute paths intact', () => {
  const expanded = expandHome('~/.dsh/sessions', '/home/scott')
  assert.equal(comparable(expanded), comparable(join('/home/scott', '.dsh/sessions')))
  assert.equal(expandHome(''), '')
})
