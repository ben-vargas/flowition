import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createStreamHandler } from '../src/viewer/stream.js'
import {
  parseSearchLimit,
  SEARCH_MAX_BYTES,
  SEARCH_MAX_LIMIT,
  SearchConflictError,
  searchRun,
} from '../src/viewer/search.js'

const rec = (value) => JSON.stringify(value) + '\n'

test('search limit accepts its documented maximum and rejects larger/non-canonical values', async () => {
  assert.equal(parseSearchLimit(String(SEARCH_MAX_LIMIT)), 200)
  assert.throws(() => parseSearchLimit('201'), /between 1 and 200/)
  assert.throws(() => parseSearchLimit('03'), /canonical/)
  await assert.rejects(searchRun('/does/not/matter', 'ok', { limit: SEARCH_MAX_LIMIT + 1 }), /between 1 and 200/)
})

test('search scans JSONL cooperatively, reports byte offsets, snippets, kinds, and newest file first', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-search-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const agents = path.join(dir, 'agents')
  fs.mkdirSync(agents)
  const events = path.join(dir, 'events.jsonl')
  const first = rec({ t: 1, type: 'log', message: 'old needle in events' })
  fs.writeFileSync(events, first + rec({ t: 2, type: 'log', message: 'other' }))
  const transcript = path.join(agents, '7.jsonl')
  fs.writeFileSync(transcript, rec({ t: 3, kind: 'text', text: `${'x'.repeat(100)} newest NEEDLE transcript ${'y'.repeat(100)}` }))
  const later = new Date(Date.now() + 1000)
  fs.utimesSync(transcript, later, later)

  const out = await searchRun(dir, 'needle', { limit: 10 })
  assert.equal(out.truncated, false)
  assert.equal(out.matches.length, 2)
  assert.equal(out.matches[0].agent, 7)
  assert.equal(out.matches[0].kind, 'text')
  assert.ok(out.matches[0].snippet.toLowerCase().includes('needle'))
  assert.ok(out.matches[0].snippet.length <= 160)
  assert.equal(out.matches[1].agent, null)
  assert.equal(out.matches[1].o, Buffer.byteLength(first))
  assert.equal(out.matches[1].kind, 'log')
})

test('deadline returns partial results with truncated:true', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-deadline-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'events.jsonl')
  const line = rec({ type: 'log', message: 'deadline needle ' + 'x'.repeat(32 * 1024) })
  fs.writeFileSync(file, line.repeat(96))
  const times = [0, 0, 3000]
  const out = await searchRun(dir, 'needle', {
    deadlineMs: 2000,
    now: () => times.length ? times.shift() : 3000,
  })
  assert.equal(out.truncated, true)
  assert.ok(out.matches.length > 0)
})

test('one search per connection returns a 409 conflict for the concurrent request', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-conflict-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'events.jsonl')
  const line = rec({ type: 'log', message: 'haystack ' + 'x'.repeat(64 * 1024) })
  fs.writeFileSync(file, line.repeat(128))
  const connection = {}
  const first = searchRun(dir, 'absent', { connection })
  await assert.rejects(
    searchRun(dir, 'absent', { connection }),
    (err) => err instanceof SearchConflictError && err.status === 409 && err.code === 'conflict',
  )
  await first
})

test('a real SSE keepalive stays on schedule during a bounded 64 MiB search', { timeout: 10_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-64m-'))
  const priorHome = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = home
  t.after(() => {
    if (priorHome === undefined) delete process.env.FLOWITION_HOME
    else process.env.FLOWITION_HOME = priorHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  const runId = 'flo_search_keepalive'
  const dir = path.join(home, 'runs', runId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'events.jsonl')
  const fd = fs.openSync(file, 'w')
  try {
    const line = Buffer.from(rec({ type: 'log', message: 'x'.repeat(1024 * 1024 - 128) }))
    let written = 0
    while (written + line.length <= SEARCH_MAX_BYTES) {
      fs.writeSync(fd, line)
      written += line.length
    }
  } finally {
    fs.closeSync(fd)
  }

  // What this proves is DESIGN §5.4.7's contract — "the event loop breathes every ≤1 MiB"
  // of a search — witnessed by a real SSE keepalive. It used to be measured as wall-clock
  // gaps (≤ 3 × a 20 ms keepalive) between pings received in this same process, which
  // a shared CI runner breaks by itself: one preemption or GC pause of the test process
  // reads as a starved keepalive (seen: a single 99 ms gap, every other gap ≤ 46 ms).
  // It is now checked as ORDER, which the scheduler cannot perturb:
  //   - the keepalive interval is 1 ms (the smallest Node timer), and every deadline check
  //     the search makes costs ≥ 1.1 ms of CPU (the injected clock below). So between any
  //     two chunks there is ≥ 1 ms of loop time, a keepalive is DUE at every timers phase
  //     that separates them, and the only thing deciding whether one is written is
  //     whether the search returned to the event loop. Preemption only makes it more due.
  //   - the injected clock is also the search's per-chunk deadline check, so it marks the
  //     chunk boundaries; keepalive writes are marked at the server's res.write. Both
  //     happen on this one thread, so the interleaving is exact, not timed.
  //   - the frozen clock never trips the 2 s deadline, so the whole 64 MiB is scanned on
  //     any machine (deadline truncation has its own test).
  const keepaliveMs = 1
  const handler = createStreamHandler({
    watch: false,
    // Out of the way for the whole test: a poll drain or state probe in flight holds the
    // connection's work queue, and keepalives queue behind it.
    pollMs: 60_000,
    stateMs: 60_000,
    keepaliveMs,
    deriveState: async () => ({ state: 'running' }),
  })
  const ctx = {
    activity: {
      sseClients: 0,
      noteRunState() {},
    },
  }
  const timeline = []
  let written = 0
  const server = http.createServer((req, res) => {
    const write = res.write
    res.write = function (chunk, ...rest) {
      if (chunk === ': ping\n\n') {
        written++
        timeline.push('ping')
      }
      return write.call(this, chunk, ...rest)
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    Promise.resolve(handler(ctx, req, res, url, { route: { runId } })).catch((error) => {
      if (res.headersSent) res.destroy(error)
      else {
        res.statusCode = error.status ?? 500
        res.end(error.message)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  let received = 0
  let source = ''
  const request = http.get({
    host: '127.0.0.1',
    port: server.address().port,
    path: `/api/runs/${runId}/stream?streams=events&cursor=${encodeURIComponent(`v1;e=${fs.statSync(file).size}`)}`,
  })
  const response = await new Promise((resolve, reject) => {
    request.once('error', reject)
    request.once('response', resolve)
  })
  response.setEncoding('utf8')
  response.on('data', (chunk) => {
    source += chunk
    for (;;) {
      const at = source.indexOf(': ping\n\n')
      if (at === -1) break
      received++
      source = source.slice(at + 8)
    }
  })
  const waitForPings = async (count) => {
    const deadline = Date.now() + 5000
    while (received < count) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for SSE keepalive ${count}; received ${received}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const clock = () => {
    timeline.push('check')
    const until = performance.now() + 1.1
    while (performance.now() < until) { /* ≥ 1 ms of loop time per chunk */ }
    return 0
  }

  try {
    await waitForPings(1)
    const from = timeline.length
    const out = await searchRun(dir, 'not-present-anywhere', { now: clock })
    const during = timeline.slice(from)
    // the real keepalives written during the search reached the real client
    await waitForPings(written)
    assert.deepEqual(out, { matches: [], truncated: false })

    const checks = during.filter((entry) => entry === 'check').length
    const mib = Math.ceil(fs.statSync(file).size / (1024 * 1024))
    assert.ok(checks >= mib, `${checks} deadline checks across ${mib} MiB — the scan is not chunked at ≤ 1 MiB`)

    // Checks between consecutive keepalive writes. Steady state is exactly 1 (one chunk
    // per loop turn); the only 2 is at startup, where the deadline is computed and the
    // first file is admitted back to back before the first read. A search that holds
    // the loop across chunks shows up here as a run of many.
    let run = 0
    let longest = 0
    for (const entry of during) {
      if (entry === 'ping') run = 0
      else longest = Math.max(longest, ++run)
    }
    assert.ok(longest <= 2,
      `the search made ${longest} deadline checks without yielding to a due keepalive (${during.filter((entry) => entry === 'ping').length} keepalives across ${checks} checks)`)
  } finally {
    request.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})
