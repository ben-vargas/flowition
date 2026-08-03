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

  const keepaliveMs = 20
  const handler = createStreamHandler({
    watch: false,
    pollMs: 1000,
    stateMs: 1000,
    keepaliveMs,
    deriveState: async () => ({ state: 'running' }),
  })
  const ctx = {
    activity: {
      sseClients: 0,
      noteRunState() {},
    },
  }
  const server = http.createServer((req, res) => {
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

  const pings = []
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
      pings.push(performance.now())
      source = source.slice(at + 8)
    }
  })
  const waitForPing = async (predicate) => {
    const deadline = Date.now() + 3000
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for SSE keepalive; saw ${pings.length}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  try {
    await waitForPing(() => pings.length > 0)
    const searchStarted = performance.now()
    const out = await searchRun(dir, 'not-present-anywhere')
    const searchEnded = performance.now()
    await waitForPing(() => pings.some((at) => at > searchEnded))
    assert.equal(out.matches.length, 0)
    assert.ok(pings.some((at) => at >= searchStarted && at <= searchEnded),
      `no SSE keepalive arrived during the ${Math.round(searchEnded - searchStarted)}ms search`)

    const surrounding = [
      pings.filter((at) => at < searchStarted).at(-1),
      ...pings.filter((at) => at >= searchStarted && at <= searchEnded),
      pings.find((at) => at > searchEnded),
    ].filter((at) => at != null)
    const gaps = surrounding.slice(1).map((at, index) => at - surrounding[index])
    assert.ok(gaps.every((gap) => gap <= keepaliveMs * 3),
      `SSE keepalive gap exceeded ${keepaliveMs * 3}ms: ${gaps.map((gap) => gap.toFixed(1)).join(', ')}`)
  } finally {
    request.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})
