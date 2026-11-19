import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  canonicalPath,
  findGitRoot,
  isInside,
  matchProjectMap,
  projectFromDirectory,
} from '../lib/project.js'

const root = resolve(process.cwd())

test('isInside matches a directory and its descendants only', () => {
  assert.equal(isInside('D:\\dev', 'D:\\dev'), true)
  assert.equal(isInside('D:\\dev\\work', 'D:\\dev'), true)
  assert.equal(isInside('D:\\dev-work', 'D:\\dev'), false)
  assert.equal(isInside('/srv/app/src', '/srv/app'), true)
  assert.equal(isInside('', '/srv/app'), false)
  assert.equal(isInside('/srv/app', ''), false)
})

test('canonicalPath normalises separators and drops a trailing slash', () => {
  assert.equal(canonicalPath('D:\\dev\\'), canonicalPath('D:/dev'))
  assert.equal(canonicalPath('/srv/app/'), '/srv/app')
  assert.equal(canonicalPath(''), '')
})

test('matchProjectMap prefers the longest matching prefix', () => {
  const projectMap = {
    'D:\\dev': 'dsh',
    'D:\\dev\\work': 'dsh-work',
    'C:\\other': 'other',
  }
  assert.equal(matchProjectMap(projectMap, 'D:\\dev\\work\\dsh-memory').project, 'dsh-work')
  assert.equal(matchProjectMap(projectMap, 'D:\\dev\\plugins').project, 'dsh')
  assert.equal(matchProjectMap(projectMap, 'E:\\elsewhere'), undefined)
})

test('projectMap wins over the git repository name', () => {
  const project = projectFromDirectory(join(root, 'work', 'memory-plugin'), {
    projectMap: { [join(root, 'work')]: 'workbuddy-tasks' },
    defaultProject: 'default',
    exists: () => true,
  })
  assert.equal(project, 'workbuddy-tasks')
})

test('the git root name is used when no mapping applies', () => {
  const repository = join(root, 'fixtures', 'demo-project-app')
  const exists = (path) => path === join(repository, '.git')
  assert.equal(findGitRoot(join(repository, 'src', 'billing'), { exists }), repository)
  assert.equal(
    projectFromDirectory(join(repository, 'src', 'billing'), { exists, projectMap: {} }),
    'demo-project-app',
  )
})

test('findGitRoot gives up at the filesystem root', () => {
  assert.equal(findGitRoot(join(root, 'deep', 'path'), { exists: () => false }), undefined)
})

test('the directory basename is the last resort before the default', () => {
  assert.equal(
    projectFromDirectory(join(root, 'workbuddy-tasks'), { exists: () => false, projectMap: {} }),
    'workbuddy-tasks',
  )
  assert.equal(projectFromDirectory('', { defaultProject: 'fallback' }), 'fallback')
})

test('directory names that are not valid project ids are sanitised', () => {
  assert.equal(
    projectFromDirectory(join(root, 'my project (2026)'), { exists: () => false, projectMap: {} }),
    'my-project-2026',
  )
})
