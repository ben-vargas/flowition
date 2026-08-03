// Bounded byte-domain JSONL windows for transcripts and events.
import fs from 'node:fs'

export const DEFAULT_PAGE_BYTES = 2 * 1024 * 1024
export const MAX_PAGE_BYTES = 8 * 1024 * 1024
export const MAX_JSONL_LINE_BYTES = 1024 * 1024

const CANONICAL_INT = /^(0|[1-9][0-9]*)$/

export function parsePageOffset(value, { defaultValue = 'tail' } = {}) {
  if (value == null || value === '') return defaultValue
  if (value === 'tail') return 'tail'
  const text = String(value)
  if (!CANONICAL_INT.test(text)) throw new RangeError('from must be "tail" or a canonical non-negative integer')
  const n = Number(text)
  if (!Number.isSafeInteger(n)) throw new RangeError('from is outside the safe integer range')
  return n
}

export function parsePageBytes(value, { defaultValue = DEFAULT_PAGE_BYTES } = {}) {
  if (value == null || value === '') return defaultValue
  const text = String(value)
  if (!CANONICAL_INT.test(text)) throw new RangeError('maxBytes must be a canonical non-negative integer')
  const n = Number(text)
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PAGE_BYTES) {
    throw new RangeError(`maxBytes must be between 1 and ${MAX_PAGE_BYTES}`)
  }
  return n
}

function readExact(fd, buffer, position) {
  let read = 0
  while (read < buffer.length) {
    const n = fs.readSync(fd, buffer, read, buffer.length - read, position + read)
    if (!n) break
    read += n
  }
  return read === buffer.length ? buffer : buffer.subarray(0, read)
}

/**
 * Read at most `maxBytes` of file content (plus one byte to establish whether the
 * requested offset is on a line boundary). Only newline-terminated records are
 * returned; corrupt, torn, and over-1-MiB records are skipped.
 */
export function readJsonlPage(file, { from = 'tail', maxBytes = DEFAULT_PAGE_BYTES } = {}) {
  from = typeof from === 'string' ? parsePageOffset(from) : from
  maxBytes = typeof maxBytes === 'string' ? parsePageBytes(maxBytes) : maxBytes
  if (from !== 'tail' && (!Number.isSafeInteger(from) || from < 0)) throw new RangeError('from must be "tail" or a non-negative integer')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_BYTES) {
    throw new RangeError(`maxBytes must be between 1 and ${MAX_PAGE_BYTES}`)
  }

  const stat = fs.statSync(file)
  if (!stat.isFile()) {
    const err = new Error('JSONL resource is not a regular file')
    err.code = 'ENOENT'
    throw err
  }
  const size = stat.size
  let requested = from === 'tail' ? Math.max(0, size - maxBytes) : Math.min(from, size)
  const readEnd = Math.min(size, requested + maxBytes)
  if (requested === size) return { items: [], start: size, end: size, size, eof: true }

  const fd = fs.openSync(file, 'r')
  try {
    let atBoundary = requested === 0
    if (!atBoundary) {
      const previous = Buffer.allocUnsafe(1)
      atBoundary = fs.readSync(fd, previous, 0, 1, requested - 1) === 1 && previous[0] === 0x0a
    }
    const bytes = readExact(fd, Buffer.allocUnsafe(Math.max(0, readEnd - requested)), requested)
    let first = 0
    if (!atBoundary) {
      const nl = bytes.indexOf(0x0a)
      if (nl === -1) {
        // The entire bounded window was the middle of one oversized line. Advancing
        // `end` lets a caller continue without an infinite empty-page loop.
        return { items: [], start: readEnd, end: readEnd, size, eof: readEnd >= size }
      }
      first = nl + 1
    }

    const lastNl = bytes.lastIndexOf(0x0a)
    const start = requested + first
    if (lastNl < first) {
      return { items: [], start, end: readEnd < size ? readEnd : start, size, eof: readEnd >= size }
    }

    const items = []
    let lineStart = first
    for (;;) {
      const nl = bytes.indexOf(0x0a, lineStart)
      if (nl === -1 || nl > lastNl) break
      const lineBytes = bytes.subarray(lineStart, nl)
      const o = requested + nl + 1
      if (lineBytes.length > 0 && lineBytes.length <= MAX_JSONL_LINE_BYTES) {
        try {
          const rec = JSON.parse(lineBytes.toString('utf8').replace(/\r$/, ''))
          if (rec && typeof rec === 'object') items.push({ o, rec })
        } catch { /* lossy viewer read: an interior corrupt line is skipped */ }
      }
      lineStart = nl + 1
    }
    return {
      items,
      start,
      end: requested + lastNl + 1,
      size,
      eof: readEnd >= size,
    }
  } finally {
    fs.closeSync(fd)
  }
}

export const readTranscriptPage = readJsonlPage
export const readEventsPage = readJsonlPage
