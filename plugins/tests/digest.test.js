import assert from 'node:assert/strict'
import test from 'node:test'

import { buildInstructions, formatStamp, planDigest, selectEntries } from '../lib/digest.js'

const MINUTE = 60_000
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 13, 9, 20) // 2026-11-13T09:20:00Z

function entry(minutesAgo, role, text) {
  return { at: NOW - minutesAgo * MINUTE, role, text }
}

test('entries are selected oldest-first so the watermark never skips a backlog', () => {
  const entries = [
    entry(300, 'user', '最早的一条'),
    entry(200, 'user', '中间的一条'),
    entry(100, 'user', '最新的一条'),
  ]
  const selection = selectEntries(entries, {
    sinceMs: null,
    nowMs: NOW,
    maxChars: 60,
    maxEntries: 10,
    maxBacklogDays: 7,
  })
  assert.deepEqual(selection.selected.map((item) => item.text), ['最早的一条', '中间的一条'])
  assert.equal(selection.consumedUntilMs, entries[1].at)
  assert.equal(selection.truncated, true)
  assert.equal(selection.remaining, 1)
})

test('the entry count cap also truncates', () => {
  const entries = Array.from({ length: 5 }, (_, index) => entry(50 - index, 'user', `第 ${index} 条`))
  const selection = selectEntries(entries, {
    sinceMs: null,
    nowMs: NOW,
    maxChars: 100_000,
    maxEntries: 3,
    maxBacklogDays: 7,
  })
  assert.equal(selection.selected.length, 3)
  assert.equal(selection.truncated, true)
  assert.equal(selection.remaining, 2)
})

test('maxBacklogDays clamps how far a first run may reach back', () => {
  const entries = [entry(60 * 24 * 10, 'user', '十天前'), entry(60, 'user', '一小时前')]
  const selection = selectEntries(entries, {
    sinceMs: null,
    nowMs: NOW,
    maxChars: 100_000,
    maxEntries: 10,
    maxBacklogDays: 7,
  })
  assert.equal(selection.dropped, 1)
  assert.deepEqual(selection.selected.map((item) => item.text), ['一小时前'])
})

test('an explicit since watermark is respected and never rewound', () => {
  const entries = [entry(300, 'user', '水位线之前'), entry(60, 'user', '水位线之后')]
  const selection = selectEntries(entries, {
    sinceMs: NOW - 120 * MINUTE,
    nowMs: NOW,
    maxChars: 100_000,
    maxEntries: 10,
    maxBacklogDays: 7,
  })
  assert.deepEqual(selection.selected.map((item) => item.text), ['水位线之后'])
})

test('with nothing selected the watermark advances to now', () => {
  const selection = selectEntries([], {
    sinceMs: null,
    nowMs: NOW,
    maxChars: 1000,
    maxEntries: 10,
    maxBacklogDays: 7,
  })
  assert.equal(selection.selected.length, 0)
  assert.equal(selection.consumedUntilMs, NOW)
  assert.equal(selection.truncated, false)
})

test('the digest stays inside its character budget and states the rules once', () => {
  const entries = Array.from({ length: 300 }, (_, index) =>
    entry(200 - index, index % 2 === 0 ? 'user' : 'assistant', `第 ${index} 条流水内容`),
  )
  const plan = planDigest({
    project: 'dsh',
    entries,
    sinceMs: null,
    nowMs: NOW,
    digestMaxChars: 3000,
    digestMaxEntries: 200,
    maxBacklogDays: 7,
  })
  assert.ok(plan.brief.length <= 3000 + 400, `brief was ${plan.brief.length}`)
  assert.ok(plan.brief.startsWith('【记忆整理任务】项目 dsh'))
  assert.ok(plan.brief.includes('正例：'))
  assert.ok(plan.brief.includes('[决策] 结算模块改为按日结'))
  assert.ok(plan.brief.includes('流水：'))
  assert.ok(plan.brief.includes('留到下次整理'))
  assert.ok(plan.entryCount > 0)
  assert.ok(plan.entryCount < entries.length)
  assert.equal(plan.consumedUntilMs, plan.selected[plan.selected.length - 1].at)
})

test('an empty window still renders a usable brief', () => {
  const plan = planDigest({
    project: 'dsh',
    entries: [],
    sinceMs: null,
    nowMs: NOW,
    digestMaxChars: 8000,
    digestMaxEntries: 120,
    maxBacklogDays: 7,
  })
  assert.equal(plan.entryCount, 0)
  assert.ok(plan.brief.includes('（本窗口没有新的工作流水）'))
  assert.equal(plan.consumedUntilMs, NOW)
})

test('the instruction block names the project and window', () => {
  const instructions = buildInstructions({
    project: 'demo-project',
    fromMs: NOW - DAY,
    toMs: NOW,
  })
  assert.ok(instructions.includes('项目 demo-project'))
  assert.ok(instructions.includes('5–15 条'))
  assert.ok(instructions.includes('NO_NOTES'))
})

test('formatStamp is stable for a fixed instant', () => {
  const stamp = formatStamp(Date.UTC(2026, 10, 13, 1, 5))
  assert.match(stamp, /^\d{2}-\d{2} \d{2}:\d{2}$/)
})
