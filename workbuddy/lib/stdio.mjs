/**
 * Tiny stdio helpers shared by the WorkBuddy hooks.
 *
 * WorkBuddy passes one JSON payload on stdin and reads one JSON object from
 * stdout. Anything else on stdout would corrupt the hook response, so all
 * diagnostics go to stderr and only through `debugLog`.
 *
 * @module dsh-server-memory/workbuddy/stdio
 */

/** Read all of stdin and parse it as JSON; returns {} when it is empty/invalid. */
export async function readStdinJson(stream = process.stdin) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const raw = Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trim()
  if (raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Print the hook response, if any. Never prints an empty line. */
export function emitHookOutput(value, stream = process.stdout) {
  if (value === undefined || value === null) return
  stream.write(`${JSON.stringify(value)}\n`)
}

/** stderr-only diagnostics, off unless `DSH_MEMORY_DEBUG` is set. */
export function debugLog(message) {
  if (process.env.DSH_MEMORY_DEBUG) console.error(`[dsh-memory workbuddy] ${message}`)
}
