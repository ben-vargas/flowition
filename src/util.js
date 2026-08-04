import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
export const shortId = (prefix) => prefix + '_' + crypto.randomBytes(4).toString('hex')

export const home = () => process.env.FLOWITION_HOME || path.join(os.homedir(), '.flowition')
export const runsDir = () => path.join(home(), 'runs')
// Run ids become path components under the flowition home: a crafted id with path
// separators (--run-id ../../victim) would point the engine's destructive prep
// (scratch sweep, result.json unlink) OUTSIDE the home. This is the single
// choke point every id-accepting path goes through — no separators, no leading
// dot. Thrown as a plain Error; user-facing entry points wrap it in
// WorkflowError so the CLI surfaces a clean message instead of a stack.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const runDir = (id) => {
  if (!RUN_ID.test(String(id))) throw new Error(`invalid run id "${id}" — ids are letters, digits, ".", "_" or "-" with no leading dot`)
  return path.join(runsDir(), id)
}
// mode (when given) applies to every directory the recursive mkdir creates —
// the flowition home, runs dir, and run dirs are made 0o700 so prompts, transcripts,
// and results never become readable by other local users (directory perms
// suffice: no traversal means the files inside are unreachable).
export const ensureDir = (d, mode) => fs.mkdirSync(d, { recursive: true, mode })

export const appendJsonl = (file, obj) => fs.appendFileSync(file, JSON.stringify(obj) + '\n')

export function readJsonl(file) {
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of src.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* torn tail line */ }
  }
  return out
}

// Strict JSONL for the resume path. A partial append is always a PREFIX of the
// record, so a torn tail is exactly: the final bytes lack a trailing newline. With
// {repair:true} (call only while holding the run lock — repair mutates the file):
//   - unparseable tail without newline  -> truncated away (crash mid-append)
//   - parseable tail without newline    -> completed by appending the newline
//     (otherwise the next append would concatenate onto it and corrupt both)
// Any newline-terminated record that fails to parse is real corruption and throws;
// treating it as absent history could silently re-run side-effecting agents.
export function readJsonlStrict(file, { repair = false } = {}) {
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch (err) {
    if (err.code === 'ENOENT') return { entries: [], repaired: false }
    throw err
  }
  const entries = []
  let pos = 0
  let repaired = false
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos)
    const hasNewline = nl !== -1
    const end = hasNewline ? nl : src.length
    const line = src.slice(pos, end).trim()
    if (line) {
      let ok = true
      let obj
      try { obj = JSON.parse(line) } catch { ok = false }
      if (ok) {
        entries.push(obj)
        if (!hasNewline && repair) { fs.appendFileSync(file, '\n'); repaired = true }
      } else if (!hasNewline) {
        if (repair) { fs.truncateSync(file, Buffer.byteLength(src.slice(0, pos))); repaired = true }
      } else {
        throw new Error(`corrupt journal: unparseable record in ${file} (byte ${Buffer.byteLength(src.slice(0, pos))})`)
      }
    }
    if (!hasNewline) break
    pos = nl + 1
  }
  return { entries, repaired }
}

// Recursively key-sorted JSON — stable identity for cache keys.
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

// Assert a value is a plain JSON value (no functions, symbols, BigInt, cycles,
// non-finite numbers, or undefined anywhere inside). Returns a normalized deep
// copy safe to canonicalize and persist. `what` names the value in errors.
export function assertJsonValue(v, what = 'value') {
  const seen = new Set()
  function walk(x, path) {
    const at = path ? ` at ${path}` : ''
    if (x === null) return null
    const t = typeof x
    if (t === 'string' || t === 'boolean') return x
    if (t === 'number') {
      if (!Number.isFinite(x)) throw new Error(`${what}${at} is a non-finite number (${x}); not valid JSON`)
      // JSON has no -0: JSON.stringify(-0) === "0", so a fresh -0 would replay
      // as 0 from the journal. Normalize eagerly — fresh and replayed results
      // must be identical.
      return Object.is(x, -0) ? 0 : x
    }
    if (t === 'undefined') throw new Error(`${what}${at} is undefined; not valid JSON`)
    if (t === 'bigint') throw new Error(`${what}${at} is a BigInt; not valid JSON`)
    if (t === 'function') throw new Error(`${what}${at} is a function; not valid JSON`)
    if (t === 'symbol') throw new Error(`${what}${at} is a symbol; not valid JSON`)
    if (seen.has(x)) throw new Error(`${what}${at} contains a circular reference; not valid JSON`)
    seen.add(x)
    let out
    if (Array.isArray(x)) {
      // Walk by index and reject holes: Array#map PRESERVES holes, so a sparse
      // array would slip through as sparse — canonical() would key Array(1)
      // identically to [], while JSON serialization persists it as [null]. A
      // fresh result and its replay must never diverge like that.
      out = new Array(x.length)
      for (let i = 0; i < x.length; i++) {
        if (!Object.hasOwn(x, i)) throw new Error(`${what}${path ? ` at ${path}[${i}]` : ` at [${i}]`} is an array hole; not valid JSON`)
        out[i] = walk(x[i], path ? `${path}[${i}]` : `[${i}]`)
      }
    } else {
      const proto = Object.getPrototypeOf(x)
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`${what}${at} is a non-plain object (${x.constructor?.name ?? 'unknown'}); not valid JSON`)
      }
      out = {}
      for (const k of Object.keys(x)) {
        // defineProperty, not assignment: `out[k] = v` for an own "__proto__"
        // key (e.g. from JSON.parse('{"__proto__":…}')) would invoke the legacy
        // prototype setter and silently DROP the property from the copy.
        Object.defineProperty(out, k, { value: walk(x[k], path ? `${path}.${k}` : k), enumerable: true, writable: true, configurable: true })
      }
    }
    seen.delete(x)
    return out
  }
  return walk(v, '')
}

// Extract a JSON value from model text: tolerate fences and surrounding prose.
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return undefined
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  try { return JSON.parse(s) } catch { /* fall through */ }
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']'
    const a = s.indexOf(open)
    const b = s.lastIndexOf(close)
    if (a !== -1 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)) } catch { /* keep trying */ }
    }
  }
  return undefined
}

export class LineSplitter {
  constructor() { this.buf = '' }
  push(chunk, cb) {
    this.buf += chunk
    let i
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).replace(/\r$/, '')
      this.buf = this.buf.slice(i + 1)
      if (line.length) cb(line)
    }
  }
  flush(cb) {
    const line = this.buf.trim()
    this.buf = ''
    if (line.length) cb(line)
  }
}

export class RingBuffer {
  constructor(max = 16384) { this.max = max; this.buf = '' }
  push(s) {
    this.buf += s
    if (this.buf.length > this.max) this.buf = this.buf.slice(this.buf.length - this.max)
  }
  toString() { return this.buf }
}

export const truncate = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s)

export function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}
