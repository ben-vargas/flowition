// The log lane's backwards paging (§2.4, §5.4.6), against a REAL `events.jsonl` read by the
// REAL server-side page reader.
//
// This file exists because the previous coverage could not have caught the bug review round
// 1 found. `dag.test.ts` merges hand-written pages whose records are already complete, so
// the one thing that decides whether a record survives — where the byte window falls
// relative to that record's newline — was never exercised. Every log line straddling a
// 256 KiB boundary was dropped by both the window that opened inside it and the window that
// ended inside it, and nothing anywhere said so.
//
// So: a real file on disk, written with real `log` records, read through
// `src/viewer/pages.js`'s `readJsonlPage` (the exact function `GET …/events/page` serves
// from), driven by the exact walk `LogLane` runs. The reader is loaded through a runtime
// dynamic import so this test file is not a build-graph edge from the SPA into the server.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  HISTORY_CHUNK_BYTES, type OffsetLog, type ScopedLog, assignScopes, logKey, mergeLogPages,
  readOlderLogs,
} from './LogLane.js'
import type { JsonlPage } from '../../api/types.js'

type PageReader = (
  file: string,
  opts: { from: number; maxBytes: number },
) => JsonlPage

let readJsonlPage: PageReader
let dir: string

beforeAll(async () => {
  const url = new URL('../../../../src/viewer/pages.js', import.meta.url).href
  const mod = await import(/* @vite-ignore */ url) as { readJsonlPage: PageReader }
  readJsonlPage = mod.readJsonlPage
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-logpage-'))
})
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/**
 * Write an events file whose `log` records are padded so that records land ON and ACROSS
 * every 256 KiB boundary. `pad` is what makes a record straddle a boundary rather than
 * happening to start after one.
 */
function writeEvents(name: string, count: number, padBytes: number): string {
  const file = path.join(dir, name)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    out.push(JSON.stringify({
      type: 'log', t: 1_764_000_000_000 + i * 1000, message: `line ${i} ${'x'.repeat(padBytes)}`,
      source: i % 3 === 0 ? 'engine' : 'workflow', level: 'info',
    }))
  }
  fs.writeFileSync(file, `${out.join('\n')}\n`)
  return file
}

/** The server route, exactly: a bounded byte window of complete lines. */
const serve = (file: string) => async (opts: { from: number; maxBytes: number }) =>
  readJsonlPage(file, opts)

/** Page all the way back to byte 0 the way the lane's "Earlier lines" button does. */
async function pageToStart(file: string, options?: { chunkBytes?: number }) {
  const size = fs.statSync(file).size
  let cursor = size
  let history: OffsetLog[] = []
  let requests = 0
  const fetchPage = serve(file)
  for (let guard = 0; guard < 400 && cursor > 0; guard++) {
    const older = await readOlderLogs((opts) => { requests++; return fetchPage(opts) }, cursor, options)
    expect(older.cursor).toBeLessThan(cursor)
    history = mergeLogPages(history, older.logs, [])
    cursor = older.cursor
  }
  expect(cursor).toBe(0)
  return { history, requests }
}

describe('backwards paging never loses a record that straddles a page boundary', () => {
  it('returns EVERY record of a file many pages long', async () => {
    // ~1.6 MiB over ~6.4 windows, with a record length that is not a divisor of the window
    // — so records land across boundaries rather than beside them.
    const count = 1_600
    const file = writeEvents('spanning.jsonl', count, 1_003)
    const { history } = await pageToStart(file)
    expect(history).toHaveLength(count)
    // Contiguous and in order: no gap anywhere, which is exactly what a lost boundary
    // record looks like from the operator's chair.
    const messages = history.map((h) => h.log.message.split(' ').slice(0, 2).join(' '))
    expect(messages).toEqual(Array.from({ length: count }, (_, i) => `line ${i}`))
  })

  it('loses nothing at ANY alignment — swept across a whole record width', async () => {
    // The bug only bites when a record happens to straddle the boundary, so one padding
    // length proves nothing. Sweeping the alignment guarantees the boundary falls inside a
    // record in some of these runs.
    for (const pad of [0, 37, 511, 1_024, 4_096]) {
      const file = writeEvents(`sweep-${pad}.jsonl`, 60, pad)
      // A window far smaller than the file, so there are many boundaries to fall foul of.
      const { history } = await pageToStart(file, { chunkBytes: 700 })
      expect(history.map((h) => h.log.message.split(' ')[1])).toEqual(
        Array.from({ length: 60 }, (_, i) => String(i)),
      )
    }
  })

  it('de-duplicates the overlap it deliberately re-reads', async () => {
    const file = writeEvents('overlap.jsonl', 120, 300)
    const { history } = await pageToStart(file, { chunkBytes: 900 })
    expect(new Set(history.map((h) => h.o)).size).toBe(history.length)
    expect(new Set(history.map((h) => logKey(h.log))).size).toBe(history.length)
  })

  it('makes progress — and reports the loss — on a line no window can bracket', async () => {
    // A single line past the reader's own 1 MiB `MAX_JSONL_LINE_BYTES`: the server skips it
    // as corrupt whatever we ask for. The walk must still terminate, and say what it
    // abandoned rather than jumping the bytes in silence.
    const file = path.join(dir, 'monster.jsonl')
    const monster = JSON.stringify({ type: 'log', t: 1, message: 'M'.repeat(9 * 1024 * 1024) })
    fs.writeFileSync(file, `${JSON.stringify({ type: 'log', t: 0, message: 'first' })}\n${monster}\n`)
    const size = fs.statSync(file).size
    const older = await readOlderLogs(serve(file), size, { chunkBytes: 4_096 })
    expect(older.cursor).toBeLessThan(size)
    expect(older.skippedBytes).toBeGreaterThan(0)
  })

  it('uses the 256 KiB window by default', () => {
    expect(HISTORY_CHUNK_BYTES).toBe(256 * 1024)
  })
})

/**
 * §6.4 step 1a, in the byte domain (review round 2, B3).
 *
 * A resumed run's events file holds every attempt's `log` records interleaved by BYTE, not by
 * time, and `RunDetail` carries only a bounded 200-record tail per scope. So selecting an
 * earlier attempt has to be able to walk back through the file and keep that attempt's
 * records — which is what `assignScopes` makes possible: the boundary is the offset of the
 * `run` record that opened the scope, and the walk descends from a known scope at the end.
 */
describe('attempt-scoped paging (§6.4 step 1a)', () => {
  const RUN_T = 1_764_000_000_000

  /** Two attempts, `perAttempt` log records each, and a resume boundary between them. */
  function writeTwoAttempts(name: string, perAttempt: number): string {
    const file = path.join(dir, name)
    const out: string[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      out.push(JSON.stringify({
        type: 'run', t: RUN_T + attempt * 1_000_000,
        state: attempt === 0 ? 'started' : 'resumed', runId: 'r_scoped',
      }))
      for (let i = 0; i < perAttempt; i++) {
        out.push(JSON.stringify({
          type: 'log', t: RUN_T + attempt * 1_000_000 + i,
          message: `a${attempt} line ${i} ${'y'.repeat(200)}`, source: 'workflow', level: 'info',
        }))
      }
      if (attempt === 0) {
        // The first attempt was INTERRUPTED, not completed — the ordinary resume case.
        out.push(JSON.stringify({ type: 'run', t: RUN_T + 999_999, state: 'interrupted' }))
      }
    }
    fs.writeFileSync(file, `${out.join('\n')}\n`)
    return file
  }

  /** The lane's own walk: page back from the file end, keeping one scope's records. */
  async function pageAttempt(file: string, scope: number, chunkBytes: number) {
    const size = fs.statSync(file).size
    let cursor = size
    let scopeAtCursor = 1              // the file end is inside the CURRENT attempt
    let history: ScopedLog[] = []
    const fetchPage = serve(file)
    for (let guard = 0; guard < 400 && cursor > 0 && scopeAtCursor >= scope; guard++) {
      const older = await readOlderLogs(fetchPage, cursor, { chunkBytes, scopeAtEnd: scopeAtCursor })
      history = mergeLogPages(history, older.logs.filter((l) => l.scope === scope), [])
      cursor = older.cursor
      scopeAtCursor = older.scopeAtCursor
    }
    return { history, cursor, scopeAtCursor }
  }

  it('reaches EVERY record of an earlier attempt, well past its 200-record tail', async () => {
    const perAttempt = 260
    const file = writeTwoAttempts('scoped.jsonl', perAttempt)
    const { history, scopeAtCursor } = await pageAttempt(file, 0, 4_096)
    // All 260 — the tail RunDetail carries is 200, so 60 of these were unreachable in round 1.
    expect(history).toHaveLength(perAttempt)
    expect(history.map((h) => h.log.message.split(' ')[2]))
      .toEqual(Array.from({ length: perAttempt }, (_, i) => String(i)))
    // …and NOT ONE record of the attempt that replaced it.
    expect(history.every((h) => h.log.message.startsWith('a0 '))).toBe(true)
    // The walk knows it is done: it has crossed attempt 0's opening `run` record.
    expect(scopeAtCursor).toBeLessThan(0)
  })

  it('keeps the current attempt free of the earlier one, from the same bytes', async () => {
    const file = writeTwoAttempts('scoped-current.jsonl', 260)
    const { history } = await pageAttempt(file, 1, 4_096)
    expect(history).toHaveLength(260)
    expect(history.every((h) => h.log.message.startsWith('a1 '))).toBe(true)
  })

  it('assigns the opening `run` record to the scope it OPENS, not the one before', () => {
    const page = {
      start: 0,
      end: 3,
      eof: true,
      items: [
        { o: 0, rec: { type: 'log', t: 1, message: 'before' } },
        { o: 1, rec: { type: 'run', t: 2, state: 'resumed' } },
        { o: 2, rec: { type: 'log', t: 3, message: 'after' } },
      ],
    } as unknown as JsonlPage
    const { logs, scopeAtStart } = assignScopes(page, 1)
    expect(logs.map((l) => [l.log.message, l.scope])).toEqual([['before', 0], ['after', 1]])
    expect(scopeAtStart).toBe(0)
  })
})
