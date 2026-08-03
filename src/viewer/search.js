// Bounded, cooperative in-run substring search.
import fs from 'node:fs'
import path from 'node:path'

export const SEARCH_CHUNK_BYTES = 1024 * 1024
export const SEARCH_MAX_BYTES = 64 * 1024 * 1024
export const SEARCH_DEADLINE_MS = 2000
export const SEARCH_DEFAULT_LIMIT = 100
export const SEARCH_MAX_LIMIT = 200
export const SEARCH_SNIPPET_CHARS = 160
const SEARCH_MAX_LINE_BYTES = 1024 * 1024
const CANONICAL_INT = /^(0|[1-9][0-9]*)$/

const activeObjects = new WeakSet()
const activePrimitives = new Set()

export class SearchConflictError extends Error {
  constructor() {
    super('another search is already in flight on this connection')
    this.name = 'SearchConflictError'
    this.status = 409
    this.code = 'conflict'
  }
}

export function parseSearchLimit(value) {
  if (value == null || value === '') return SEARCH_DEFAULT_LIMIT
  const text = String(value)
  if (!CANONICAL_INT.test(text)) {
    throw new RangeError('limit must be a canonical non-negative integer')
  }
  const limit = Number(text)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${SEARCH_MAX_LIMIT}`)
  }
  return limit
}

function acquire(connection) {
  if (connection == null) return () => {}
  const objects = (typeof connection === 'object' && connection !== null) || typeof connection === 'function'
  const set = objects ? activeObjects : activePrimitives
  if (set.has(connection)) throw new SearchConflictError()
  set.add(connection)
  return () => set.delete(connection)
}

function filesForRun(dir) {
  const files = []
  const add = (file, agent) => {
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) files.push({ file, agent, stat })
    } catch { /* a transcript may vanish with the run */ }
  }
  add(path.join(dir, 'events.jsonl'), null)
  const agentsDir = path.join(dir, 'agents')
  let names = []
  try { names = fs.readdirSync(agentsDir) } catch { /* no agents yet */ }
  for (const name of names) {
    const m = name.match(/^(0|[1-9][0-9]*)\.jsonl$/)
    if (m) add(path.join(agentsDir, name), Number(m[1]))
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.stat.size - a.stat.size || a.file.localeCompare(b.file))
  return files
}

function flattenStrings(value, into, depth = 0) {
  if (depth > 12 || into.length >= SEARCH_MAX_LINE_BYTES) return
  if (typeof value === 'string') {
    into.push(value)
    return
  }
  if (value == null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, into, depth + 1)
  } else {
    for (const item of Object.values(value)) flattenStrings(item, into, depth + 1)
  }
}

function searchableLine(line) {
  try {
    const rec = JSON.parse(line)
    const strings = []
    flattenStrings(rec, strings)
    return { text: strings.join(' · '), kind: String(rec.kind ?? rec.type ?? 'unknown') }
  } catch {
    return { text: line, kind: 'raw' }
  }
}

export function centeredSnippet(text, matchAt, queryLength, max = SEARCH_SNIPPET_CHARS) {
  if (text.length <= max) return text
  const desired = matchAt + Math.floor(queryLength / 2) - Math.floor(max / 2)
  const start = Math.max(0, Math.min(text.length - max, desired))
  return text.slice(start, start + max)
}

async function scanFile(entry, query, remainingBytes, matches, limit, deadline, now) {
  const readBytes = Math.min(entry.stat.size, remainingBytes)
  if (readBytes <= 0) return { bytes: 0, stopped: false }
  let pending = Buffer.alloc(0)
  let pendingStart = 0
  let dropping = false
  let absolute = 0
  const stream = fs.createReadStream(entry.file, {
    start: 0,
    end: readBytes - 1,
    highWaterMark: SEARCH_CHUNK_BYTES,
  })
  try {
    for await (const chunk of stream) {
      const chunkStart = absolute
      absolute += chunk.length

      let bytes = chunk
      let bytesStart = chunkStart
      if (dropping) {
        const nl = bytes.indexOf(0x0a)
        if (nl === -1) {
          await new Promise((resolve) => setImmediate(resolve))
          if (now() >= deadline) return { bytes: absolute, stopped: true }
          continue
        }
        dropping = false
        bytesStart += nl + 1
        bytes = bytes.subarray(nl + 1)
        pendingStart = bytesStart
      }

      if (pending.length) bytes = Buffer.concat([pending, bytes])
      else pendingStart = bytesStart
      let at = 0
      for (;;) {
        const nl = bytes.indexOf(0x0a, at)
        if (nl === -1) break
        const line = bytes.subarray(at, nl)
        const o = pendingStart + nl + 1
        if (line.length > 0 && line.length <= SEARCH_MAX_LINE_BYTES) {
          const { text, kind } = searchableLine(line.toString('utf8').replace(/\r$/, ''))
          const matchAt = text.toLocaleLowerCase().indexOf(query)
          if (matchAt !== -1) {
            matches.push({
              agent: entry.agent,
              o,
              kind,
              snippet: centeredSnippet(text, matchAt, query.length),
            })
            if (matches.length >= limit) return { bytes: absolute, stopped: true }
          }
        }
        at = nl + 1
      }
      pending = bytes.subarray(at)
      pendingStart += at
      if (pending.length > SEARCH_MAX_LINE_BYTES) {
        pending = Buffer.alloc(0)
        dropping = true
      } else {
        // Do not retain a slice backed by the whole 1 MiB stream chunk.
        pending = Buffer.from(pending)
      }

      // Explicitly yield even when the file stream already has buffered data.
      await new Promise((resolve) => setImmediate(resolve))
      if (now() >= deadline) return { bytes: absolute, stopped: true }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  } finally {
    stream.destroy()
  }
  return { bytes: absolute, stopped: false }
}

/**
 * Search events + transcripts, newest file first. `connection` should be the request
 * socket; it enforces §5.4.7's one-in-flight rule without serializing other clients.
 */
export async function searchRun(dir, q, {
  limit = SEARCH_DEFAULT_LIMIT,
  connection = null,
  maxBytes = SEARCH_MAX_BYTES,
  deadlineMs = SEARCH_DEADLINE_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof q !== 'string' || q.length < 2 || q.length > 256) throw new RangeError('q must contain 2 to 256 characters')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${SEARCH_MAX_LIMIT}`)
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SEARCH_MAX_BYTES) {
    throw new RangeError(`maxBytes must be between 1 and ${SEARCH_MAX_BYTES}`)
  }
  const release = acquire(connection)
  try {
    const files = filesForRun(dir)
    const query = q.toLocaleLowerCase()
    const matches = []
    const deadline = now() + deadlineMs
    let scanned = 0
    let truncated = false
    for (let i = 0; i < files.length; i++) {
      if (now() >= deadline || scanned >= maxBytes) {
        truncated = true
        break
      }
      const remaining = maxBytes - scanned
      const out = await scanFile(files[i], query, remaining, matches, limit, deadline, now)
      scanned += out.bytes
      if (out.stopped) {
        truncated = true
        break
      }
      if (files[i].stat.size > out.bytes) {
        truncated = true
        break
      }
    }
    if (matches.length >= limit) truncated = true
    if (!truncated && files.reduce((n, f) => n + f.stat.size, 0) > scanned) truncated = true
    return { matches, truncated }
  } finally {
    release()
  }
}
