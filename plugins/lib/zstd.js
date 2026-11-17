/**
 * Minimal zstd frame reader.
 *
 * DSH appends every session event as its own zstd frame to
 * `session.v4.jsonl.zstd`. `zlib.zstdDecompressSync` decodes exactly one frame,
 * so the frames are walked manually and joined. No dependency is needed and no
 * partial/corrupt frame can throw into the host: decoding stops and reports
 * `truncated` instead.
 *
 * @module dsh-memory/zstd
 */

import * as zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f
const DEFAULT_MAX_FRAMES = 200_000

/** Whether this Node build exposes zstd (Node >= 22.15 / 24). */
export function isZstdSupported() {
  return typeof zlib.zstdDecompressSync === 'function'
}

/**
 * Length of the zstd frame starting at `start`, or -1 when it is malformed or
 * incomplete.
 */
function frameLength(buffer, start) {
  let offset = start + 4
  if (offset >= buffer.length) return -1
  const descriptor = buffer[offset]
  offset += 1
  const frameContentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3

  if (!singleSegment) offset += 1 // Window_Descriptor
  offset += [0, 1, 2, 4][dictionaryFlag] // Dictionary_ID
  offset += [singleSegment ? 1 : 0, 2, 4, 8][frameContentSizeFlag] // Frame_Content_Size
  if (offset > buffer.length) return -1

  for (;;) {
    if (offset + 3 > buffer.length) return -1
    const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
    offset += 3
    const isLast = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >>> 3
    if (blockType === 3) return -1 // reserved
    offset += blockType === 1 ? 1 : blockSize // RLE blocks store a single byte
    if (offset > buffer.length) return -1
    if (isLast) break
  }
  if (hasChecksum) offset += 4
  return offset <= buffer.length ? offset : -1
}

/**
 * Decode every concatenated zstd frame in `buffer`.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{maxFrames?: number}} [options]
 * @returns {{text: string, frames: number, truncated: boolean}}
 */
export function decompressZstdFrames(buffer, options = {}) {
  if (!isZstdSupported()) {
    throw new Error('此 Node 版本不支持 zstd 解压（需要 Node 22.15+ / 24+）')
  }
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES
  const parts = []
  let offset = 0
  let frames = 0
  let truncated = false

  while (offset + 4 <= source.length) {
    const magic = source.readUInt32LE(offset)

    if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
      if (offset + 8 > source.length) {
        truncated = true
        break
      }
      const size = source.readUInt32LE(offset + 4)
      offset += 8 + size
      if (offset > source.length) {
        truncated = true
        break
      }
      continue
    }

    if (magic !== ZSTD_MAGIC) {
      truncated = true
      break
    }

    const end = frameLength(source, offset)
    if (end < 0) {
      truncated = true
      break
    }
    try {
      parts.push(zlib.zstdDecompressSync(source.subarray(offset, end)).toString('utf8'))
    } catch {
      truncated = true
      break
    }
    offset = end
    frames += 1
    if (frames >= maxFrames) {
      truncated = offset < source.length
      break
    }
  }

  if (offset < source.length) truncated = true
  return { text: parts.join(''), frames, truncated }
}
