import assert from 'node:assert/strict'
import * as zlib from 'node:zlib'
import test from 'node:test'

import { decompressZstdFrames, isZstdSupported } from '../lib/zstd.js'

const supported = isZstdSupported()

function frames(...chunks) {
  return Buffer.concat(chunks.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8'))))
}

test('concatenated frames are decoded and joined', { skip: !supported }, () => {
  const buffer = frames('第一帧\n', '第二帧\n', 'third\n')
  const result = decompressZstdFrames(buffer)
  assert.equal(result.frames, 3)
  assert.equal(result.truncated, false)
  assert.equal(result.text, '第一帧\n第二帧\nthird\n')
})

test('a truncated tail keeps the decoded prefix', { skip: !supported }, () => {
  const buffer = frames('完整的一行\n', '不完整的一行\n')
  const result = decompressZstdFrames(buffer.subarray(0, buffer.length - 5))
  assert.equal(result.frames, 1)
  assert.equal(result.truncated, true)
  assert.equal(result.text, '完整的一行\n')
})

test('garbage input is reported, not thrown', { skip: !supported }, () => {
  const result = decompressZstdFrames(Buffer.from('not a zstd stream'))
  assert.equal(result.text, '')
  assert.equal(result.frames, 0)
  assert.equal(result.truncated, true)
})

test('an empty buffer decodes to nothing', { skip: !supported }, () => {
  const result = decompressZstdFrames(Buffer.alloc(0))
  assert.deepEqual(result, { text: '', frames: 0, truncated: false })
})

test('skippable frames are tolerated', { skip: !supported }, () => {
  const skippable = Buffer.alloc(12)
  skippable.writeUInt32LE(0x184d2a50, 0)
  skippable.writeUInt32LE(4, 4)
  skippable.write('junk', 8, 'utf8')
  const result = decompressZstdFrames(Buffer.concat([skippable, frames('hello\n')]))
  assert.equal(result.text, 'hello\n')
  assert.equal(result.frames, 1)
})

test('the frame limit stops decoding without throwing', { skip: !supported }, () => {
  const buffer = frames('a', 'b', 'c')
  const result = decompressZstdFrames(buffer, { maxFrames: 2 })
  assert.equal(result.frames, 2)
  assert.equal(result.text, 'ab')
  assert.equal(result.truncated, true)
})
