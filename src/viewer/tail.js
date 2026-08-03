// Pure byte-domain JSONL tailing primitives (DESIGN §5.6.6).
//
// This module deliberately imports nothing. Filesystem ownership belongs to callers:
// pass a FileHandle-like object to readChunk(), and feed the bytes it returns into
// ByteTail. Keeping offsets and torn lines as Buffers until a newline arrives is what
// makes a UTF-8 code point split across reads safe.

export const MAX_READ_BYTES = 1024 * 1024
export const MAX_LINE_BYTES = 1024 * 1024

const empty = () => Buffer.alloc(0)

function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  return value
}

/**
 * Read one bounded chunk from a FileHandle-like object.
 *
 * `handle.read(buffer, 0, length, position)` may be sync or async and may return either
 * Node's `{bytesRead, buffer}` shape or a byte count (useful for pure fake handles).
 */
export async function readChunk(handle, offset, max = MAX_READ_BYTES) {
  nonNegativeSafeInteger(offset, 'offset')
  if (!handle || typeof handle.read !== 'function') throw new TypeError('handle.read must be a function')
  if (!Number.isSafeInteger(max) || max <= 0) throw new TypeError('max must be a positive safe integer')
  const length = Math.min(max, MAX_READ_BYTES)
  const buffer = Buffer.allocUnsafe(length)
  const result = await handle.read(buffer, 0, length, offset)
  const bytesRead = typeof result === 'number' ? result : result?.bytesRead
  if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
    throw new Error(`invalid read result: bytesRead=${bytesRead}`)
  }
  return {
    bytes: buffer.subarray(0, bytesRead),
    nextOffset: offset + bytesRead,
    eof: bytesRead < length,
  }
}

/**
 * Stateful, bounded line splitter over an append-only byte stream.
 *
 * `readOffset` is where the next physical read starts. `offset` is the post-newline
 * cursor safe to publish to a reconnecting client. They intentionally differ while a
 * torn line is pending.
 */
export class ByteTail {
  constructor({ offset = 0, maxLineBytes = MAX_LINE_BYTES } = {}) {
    nonNegativeSafeInteger(offset, 'offset')
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new TypeError('maxLineBytes must be a positive safe integer')
    }
    this.maxLineBytes = maxLineBytes
    this.readOffset = offset
    this.offset = offset
    this.pending = empty()
    this.discarding = false
    this.skippedLines = 0
    this.identity = null
  }

  /**
   * Observe the current file identity/size. A shrink below bytes already read, or an
   * active-file identity change, resets the subscription to byte zero.
   */
  observe({ size, dev, ino } = {}) {
    nonNegativeSafeInteger(size, 'size')
    const identity = dev === undefined || ino === undefined ? null : `${dev}:${ino}`
    const rotated = (this.identity !== null && identity !== null && this.identity !== identity)
      || size < this.readOffset
    if (rotated) this.reset(0)
    this.identity = identity
    return { reset: rotated, offset: this.readOffset }
  }

  reset(offset = 0) {
    nonNegativeSafeInteger(offset, 'offset')
    this.readOffset = offset
    this.offset = offset
    this.pending = empty()
    this.discarding = false
    this.identity = null
  }

  /**
   * Consume bytes read at the current physical offset.
   *
   * Returns file-ordered events. A complete line event has `{bytes, offset}`; an
   * oversize line has `{skipped: true, offset}`. Keeping both kinds in one sequence is
   * essential: a published cursor must never move backwards when a skipped line and a
   * later complete line end in the same read.
   */
  push(bytes, at = this.readOffset) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Buffer or Uint8Array')
    nonNegativeSafeInteger(at, 'at')
    if (at !== this.readOffset) throw new Error(`non-contiguous tail input: expected ${this.readOffset}, got ${at}`)
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const events = []
    let start = 0

    for (;;) {
      const newline = chunk.indexOf(0x0a, start)
      if (newline === -1) break
      const part = chunk.subarray(start, newline)
      const postOffset = at + newline + 1

      if (this.discarding || this.pending.length + part.length > this.maxLineBytes) {
        this.skippedLines++
        events.push({ skipped: true, offset: postOffset })
      } else {
        const line = this.pending.length
          ? Buffer.concat([this.pending, part], this.pending.length + part.length)
          : Buffer.from(part)
        events.push({ bytes: line, offset: postOffset })
      }

      this.pending = empty()
      this.discarding = false
      this.offset = postOffset
      start = newline + 1
    }

    const rest = chunk.subarray(start)
    if (rest.length) {
      if (this.discarding || this.pending.length + rest.length > this.maxLineBytes) {
        this.pending = empty()
        this.discarding = true
      } else {
        this.pending = this.pending.length
          ? Buffer.concat([this.pending, rest], this.pending.length + rest.length)
          : Buffer.from(rest)
      }
    }
    this.readOffset = at + chunk.length
    return { events, readOffset: this.readOffset, offset: this.offset }
  }

  /** A copy of the raw torn tail, for the non-follow CLI's legacy final parse only. */
  pendingBytes() {
    return this.discarding ? empty() : Buffer.from(this.pending)
  }
}

/**
 * Drain the bytes currently readable from a FileHandle-like object.
 * Awaiting callbacks makes backpressure propagate all the way to the next filesystem
 * read; the explicit microtask between full chunks prevents one hot file monopolizing
 * the event loop.
 */
export async function drainTail(handle, tail, { onLine, onSkip, maxReadBytes = MAX_READ_BYTES } = {}) {
  if (!(tail instanceof ByteTail)) throw new TypeError('tail must be a ByteTail')
  let chunks = 0
  let bytes = 0
  for (;;) {
    const at = tail.readOffset
    const read = await readChunk(handle, at, maxReadBytes)
    chunks++
    bytes += read.bytes.length
    const parsed = tail.push(read.bytes, at)
    for (const event of parsed.events) {
      if (event.skipped) await onSkip?.(event.offset)
      else await onLine?.(event)
    }
    if (read.eof || read.bytes.length === 0) return { chunks, bytes, eof: true }
    // A macrotask yield (not merely a microtask) lets timers and sibling I/O run before
    // the next MiB of a 500 MB append.
    await new Promise((resolve) => setImmediate(resolve))
  }
}
