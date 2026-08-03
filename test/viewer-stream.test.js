import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createStreamHandler, StreamConnection, MAX_BATCH_BYTES } from '../src/viewer/stream.js'
import { MAX_LINE_BYTES } from '../src/viewer/tail.js'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-stream-'))
process.env.FLOWITION_HOME = HOME
const RUNS = path.join(HOME, 'runs')
fs.mkdirSync(RUNS, { recursive: true })
let sequence = 0

const jsonl = (record) => Buffer.from(JSON.stringify(record) + '\n')
const makeRun = () => {
  const runId = `flo_stream_${sequence++}`
  const dir = path.join(RUNS, runId)
  fs.mkdirSync(dir, { recursive: true })
  return { runId, dir, events: path.join(dir, 'events.jsonl'), journal: path.join(dir, 'journal.jsonl') }
}

const activity = () => ({
  sseClients: 0,
  states: [],
  noteRunState(runId, state) { this.states.push({ runId, state }) },
})

async function startServer(handler, state = async () => ({ state: 'running' })) {
  const ctx = { activity: activity() }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const runId = url.pathname.split('/')[3]
    Promise.resolve(handler(ctx, req, res, url, { route: { runId } })).catch((error) => {
      if (res.headersSent) return res.destroy(error)
      res.statusCode = error.status ?? 500
      res.end(JSON.stringify({ error: error.message }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    port: server.address().port,
    ctx,
    close: () => new Promise((resolve) => server.close(resolve)),
    state,
  }
}

function connect(port, target, headers = {}) {
  const frames = []
  let buffer = ''
  let ended = false
  const request = http.get({ host: '127.0.0.1', port, path: target, headers })
  const ready = new Promise((resolve, reject) => {
    request.once('error', reject)
    request.once('response', (response) => {
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        buffer += chunk
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (block.startsWith(':')) {
            frames.push({ comment: block.slice(1).trim() })
            continue
          }
          const frame = {}
          for (const line of block.split('\n')) {
            const colon = line.indexOf(':')
            if (colon === -1) continue
            const key = line.slice(0, colon)
            const value = line.slice(colon + 1).replace(/^ /, '')
            if (key === 'data') frame.data = (frame.data ?? '') + value
            else frame[key] = value
          }
          if (frame.data) frame.json = JSON.parse(frame.data)
          frames.push(frame)
        }
      })
      response.on('end', () => { ended = true })
      resolve(response)
    })
  })
  const waitFor = async (predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = predicate(frames)
      if (value) return value
      if (Date.now() >= deadline) throw new Error(`timed out waiting for SSE frame:\n${JSON.stringify(frames, null, 2)}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  return {
    frames,
    ready,
    waitFor,
    get ended() { return ended },
    close() { request.destroy() },
  }
}

const batches = (frames) => frames.filter((frame) => frame.event === 'batch')
const records = (frames) => batches(frames).flatMap((frame) => frame.json.f)
const systems = (frames) => frames.filter((frame) => frame.event === 'sys').map((frame) => frame.json.r)

test('stream: shipped viewer dispatches the registered SSE handler with production headers', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, jsonl({ type: 'log', message: 'through-pipeline' }))
  const { startViewer } = await import('../src/viewer/index.js')
  const viewer = await startViewer({
    port: 0,
    primary: false,
  })
  const client = connect(viewer.port, `/api/runs/${run.runId}/stream?token=${viewer.token}&streams=events`)
  try {
    const response = await client.ready
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['content-type'], /^text\/event-stream/)
    assert.equal(response.headers['x-accel-buffering'], 'no')
    assert.equal(response.headers['cache-control'], 'no-cache, no-transform')
    await client.waitFor((frames) => records(frames).some((entry) => entry.r.message === 'through-pipeline'))
  } finally {
    client.close()
    await viewer.close()
  }
})

test('stream: replay then poll-tail carries a torn multibyte final line', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, jsonl({ type: 'log', message: 'first' }))
  const handler = createStreamHandler({ watch: false, pollMs: 15, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=events`)
  try {
    await client.ready
    await client.waitFor((frames) => records(frames).some((entry) => entry.r.message === 'first'))
    const record = jsonl({ type: 'log', message: 'café' })
    const split = record.indexOf(Buffer.from('é')) + 1
    fs.appendFileSync(run.events, record.subarray(0, split))
    const before = records(client.frames).length
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(records(client.frames).length, before, 'torn line was emitted')
    fs.appendFileSync(run.events, record.subarray(split))
    const entry = await client.waitFor((frames) => records(frames).find((item) => item.r.message === 'café'))
    assert.equal(entry.o, fs.statSync(run.events).size)
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: fresh Last-Event-ID beats stale query cursor after a long offline gap', async () => {
  const run = makeRun()
  const first = jsonl({ type: 'log', message: 'before-offline' })
  fs.writeFileSync(run.events, first)
  const handler = createStreamHandler({ watch: false, pollMs: 15, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const client = connect(
    server.port,
    `/api/runs/${run.runId}/stream?streams=events&cursor=${encodeURIComponent('v1;e=0')}`,
    { 'last-event-id': `v1;e=${first.length}` },
  )
  try {
    // Simulates the append-only gap accumulated during a 20-minute disconnect.
    fs.appendFileSync(run.events, jsonl({ type: 'log', message: 'after-offline' }))
    await client.ready
    await client.waitFor((frames) => records(frames).some((entry) => entry.r.message === 'after-offline'))
    assert.deepEqual(records(client.frames).map((entry) => entry.r.message), ['after-offline'])
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: malformed Last-Event-ID falls back to query; malformed query resets before replay', async () => {
  const run = makeRun()
  const first = jsonl({ type: 'log', message: 'first' })
  const second = jsonl({ type: 'log', message: 'second' })
  fs.writeFileSync(run.events, Buffer.concat([first, second]))
  const handler = createStreamHandler({ watch: false, pollMs: 1000, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const fallback = connect(
    server.port,
    `/api/runs/${run.runId}/stream?streams=events&cursor=${encodeURIComponent(`v1;e=${first.length}`)}`,
    { 'last-event-id': 'not-a-cursor' },
  )
  const reset = connect(server.port, `/api/runs/${run.runId}/stream?streams=events&cursor=broken`)
  try {
    await Promise.all([fallback.ready, reset.ready])
    await fallback.waitFor((frames) => records(frames).length === 1)
    assert.equal(records(fallback.frames)[0].r.message, 'second')
    await reset.waitFor((frames) => records(frames).length === 2)
    const resetIndex = reset.frames.findIndex((frame) => frame.event === 'sys' && frame.json.r.type === 'reset')
    const replayIndex = reset.frames.findIndex((frame) => frame.event === 'batch')
    assert.ok(resetIndex !== -1 && resetIndex < replayIndex)
  } finally {
    fallback.close()
    reset.close()
    await server.close()
  }
})

test('stream: per-stream reset precedes its replay; batches cap at 256 with post-batch ids', async () => {
  const run = makeRun()
  const lines = Array.from({ length: 300 }, (_, index) => jsonl({ type: 'log', index }))
  const firstJournal = jsonl({ type: 'answer', qid: 'old', value: 'ignored' })
  const secondJournal = jsonl({ type: 'answer', qid: 'new', value: 'yes' })
  fs.writeFileSync(run.events, Buffer.concat(lines))
  fs.writeFileSync(run.journal, Buffer.concat([firstJournal, secondJournal]))
  const handler = createStreamHandler({ watch: false, pollMs: 1000, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const cursor = `v1;e=999999;j=${firstJournal.length};a5=999999`
  const client = connect(server.port, `/api/runs/${run.runId}/stream?cursor=${encodeURIComponent(cursor)}`)
  try {
    await client.ready
    await client.waitFor((frames) => records(frames).filter((entry) => entry.s === 'e').length === 300)
    const resetIndex = client.frames.findIndex((frame) => frame.event === 'sys' && frame.json.r.type === 'reset' && frame.json.r.stream === 'e')
    const firstEventIndex = client.frames.findIndex((frame) => frame.event === 'batch' && frame.json.f.some((entry) => entry.s === 'e'))
    assert.ok(resetIndex !== -1 && resetIndex < firstEventIndex)
    assert.deepEqual(systems(client.frames).filter((record) => record.type === 'reset'), [
      { type: 'reset', stream: 'e' },
    ])
    assert.deepEqual(records(client.frames).filter((entry) => entry.s === 'j').map((entry) => entry.r.qid), ['new'])

    const eventBatches = batches(client.frames).filter((frame) => frame.json.f.some((entry) => entry.s === 'e'))
    assert.equal(eventBatches[0].json.f.filter((entry) => entry.s === 'e').length, 256)
    assert.match(eventBatches[0].id, new RegExp(`e=${lines.slice(0, 256).reduce((n, line) => n + line.length, 0)}(?:;|$)`))
    assert.match(eventBatches.at(-1).id, new RegExp(`e=${fs.statSync(run.events).size}(?:;|$)`))
    assert.ok(eventBatches.every((frame) => Buffer.byteLength(frame.data) <= MAX_BATCH_BYTES))
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: journal result over 64 KiB is stripped; other oversize records are skipped with a note', async () => {
  const run = makeRun()
  // The raw journal record fits under 64 KiB, but its multiplexing envelope does not.
  const result = { type: 'result', key: 'k', index: 4, status: 'completed', usage: { input: 1, output: 2 }, durationMs: 3, result: 'x'.repeat(65_400) }
  const mail = { type: 'mail', key: 'k', id: 'm', text: 'secret'.repeat(12 * 1024) }
  const resultLine = jsonl(result)
  assert.ok(resultLine.length - 1 <= MAX_BATCH_BYTES)
  assert.ok(Buffer.byteLength(JSON.stringify({ f: [{ s: 'j', o: resultLine.length, r: result }] })) > MAX_BATCH_BYTES)
  fs.writeFileSync(run.journal, Buffer.concat([jsonl(result), jsonl(mail)]))
  const handler = createStreamHandler({ watch: false, pollMs: 1000, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=journal`)
  try {
    await client.ready
    const entry = await client.waitFor((frames) => records(frames).find((item) => item.r.type === 'result'))
    assert.equal(entry.r.result, undefined)
    assert.equal(entry.r.resultTruncated, true)
    assert.equal(entry.r.resultBytes, Buffer.byteLength(JSON.stringify(result.result)))
    await client.waitFor((frames) => systems(frames).some((record) => record.type === 'note' && /oversize mail/.test(record.message)))
    assert.ok(client.frames.filter((frame) => frame.data).every((frame) => Buffer.byteLength(frame.data) <= MAX_BATCH_BYTES))
    assert.ok(!JSON.stringify(client.frames).includes(mail.text), 'oversize skipped payload leaked into SSE')
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: journal feed excludes meta secrets and unknown future record types', async () => {
  const run = makeRun()
  const secret = 'do-not-stream-this-api-key'
  fs.writeFileSync(run.journal, Buffer.concat([
    jsonl({ type: 'meta', args: ['--token', secret] }),
    jsonl({ type: 'future-record', payload: secret }),
    jsonl({ type: 'answer', qid: 'safe', value: 'yes' }),
  ]))
  const handler = createStreamHandler({ watch: false, pollMs: 1000, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=journal`)
  try {
    await client.ready
    await client.waitFor((frames) => records(frames).some((entry) => entry.r.type === 'answer'))
    assert.deepEqual(records(client.frames).map((entry) => entry.r.type), ['answer'])
    assert.ok(!JSON.stringify(client.frames).includes(secret))
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: transcript records on both sides of the batch envelope boundary are delivered', async () => {
  const run = makeRun()
  const agents = path.join(run.dir, 'agents')
  const transcript = path.join(agents, '0.jsonl')
  fs.mkdirSync(agents)
  const under = { kind: 'text', tag: 'under', text: 'x'.repeat(65_450) }
  const over = { kind: 'text', tag: 'over', text: 'x'.repeat(65_500) }
  fs.writeFileSync(transcript, Buffer.concat([jsonl(under), jsonl(over)]))
  const handler = createStreamHandler({ watch: false, pollMs: 1000, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const client = connect(
    server.port,
    `/api/runs/${run.runId}/stream?streams=&agents=0&cursor=${encodeURIComponent('v1;a0=0')}`,
  )
  try {
    await client.ready
    await client.waitFor((frames) => records(frames).filter((entry) => entry.s === 'a0').length === 2)
    assert.deepEqual(records(client.frames).map((entry) => entry.r.tag), ['under', 'over'])
    const underFrame = batches(client.frames).find((frame) => frame.json.f.some((entry) => entry.r.tag === 'under'))
    const overFrame = batches(client.frames).find((frame) => frame.json.f.some((entry) => entry.r.tag === 'over'))
    assert.ok(Buffer.byteLength(underFrame.data) <= MAX_BATCH_BYTES)
    assert.ok(Buffer.byteLength(overFrame.data) > MAX_BATCH_BYTES)
    assert.equal(overFrame.json.f.length, 1)
    assert.ok(!systems(client.frames).some((record) => record.type === 'note'))
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: oversize line followed by a record advances the advertised cursor exactly once', async () => {
  const run = makeRun()
  const skipped = Buffer.concat([Buffer.alloc(MAX_LINE_BYTES + 20, 0x78), Buffer.from('\n')])
  const kept = jsonl({ type: 'log', message: 'after-oversize' })
  fs.writeFileSync(run.events, Buffer.concat([skipped, kept]))
  const size = fs.statSync(run.events).size
  const handler = createStreamHandler({ watch: false, pollMs: 20, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const first = connect(server.port, `/api/runs/${run.runId}/stream?streams=events`)
  let advertised
  try {
    await first.ready
    await first.waitFor((frames) => records(frames).some((entry) => entry.r.message === 'after-oversize'))
    const frame = batches(first.frames).find((item) => item.json.f.some((entry) => entry.r.message === 'after-oversize'))
    assert.match(frame.id, new RegExp(`(?:^|;)e=${size}(?:;|$)`))
    advertised = frame.id
    first.close()

    const resumed = connect(
      server.port,
      `/api/runs/${run.runId}/stream?streams=events`,
      { 'last-event-id': advertised },
    )
    try {
      await resumed.ready
      await resumed.waitFor((frames) => systems(frames).some((record) => record.type === 'state'))
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(records(resumed.frames).length, 0)
    } finally {
      resumed.close()
    }
  } finally {
    first.close()
    await server.close()
  }
})

test('stream: active shrink resets before new records, then vanished run emits gone and closes', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, jsonl({ type: 'log', message: 'a'.repeat(500) }))
  const handler = createStreamHandler({ watch: false, pollMs: 15, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const initialSize = fs.statSync(run.events).size
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=events&cursor=${encodeURIComponent(`v1;e=${initialSize}`)}`)
  try {
    await client.ready
    fs.writeFileSync(run.events, jsonl({ type: 'log', message: 'new' }))
    await client.waitFor((frames) => records(frames).some((entry) => entry.r.message === 'new'))
    const resetIndex = client.frames.findIndex((frame) => frame.event === 'sys' && frame.json.r.type === 'reset')
    const newIndex = client.frames.findIndex((frame) => frame.event === 'batch' && frame.json.f.some((entry) => entry.r.message === 'new'))
    assert.ok(resetIndex !== -1 && resetIndex < newIndex)

    fs.rmSync(run.dir, { recursive: true })
    await client.waitFor((frames) => systems(frames).some((record) => record.type === 'gone'))
    await client.waitFor(() => client.ended)
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: terminal fold plus terminal derived state and quiet period emits end', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, jsonl({ type: 'run', runId: run.runId, state: 'completed' }))
  const handler = createStreamHandler({
    watch: false,
    pollMs: 10,
    stateMs: 10,
    keepaliveMs: 1000,
    quietCloseMs: 25,
    deriveState: async () => ({ state: 'completed', result: { status: 'completed' } }),
  })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=events`)
  try {
    await client.ready
    await client.waitFor((frames) => systems(frames).some((record) => record.type === 'state' && record.state === 'completed'))
    await client.waitFor((frames) => systems(frames).some((record) => record.type === 'end'))
    await client.waitFor(() => client.ended)
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: unchanged terminal-event probes reuse the cached negative or positive result', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, jsonl({ type: 'log', message: 'no-terminal-event' }))
  let reads = 0
  const fsp = {
    ...fs.promises,
    async open(file, flags) {
      const handle = await fs.promises.open(file, flags)
      if (file !== run.events) return handle
      return {
        stat: (...args) => handle.stat(...args),
        read: (...args) => {
          reads++
          return handle.read(...args)
        },
        close: (...args) => handle.close(...args),
      }
    },
  }
  const connection = new StreamConnection({
    ctx: { activity: activity() },
    req: new EventEmitter(),
    res: new EventEmitter(),
    runId: run.runId,
    subscription: { streams: ['events'], agents: [] },
    selected: { cursor: { e: 0 }, source: 'query', reset: false },
    fsImpl: { ...fs, promises: fsp },
  })

  assert.equal(await connection.hasTerminalEvent(), false)
  assert.equal(await connection.hasTerminalEvent(), false)
  assert.equal(reads, 1, 'unchanged negative probe reread events.jsonl')

  fs.appendFileSync(run.events, jsonl({ type: 'run', runId: run.runId, state: 'completed' }))
  assert.equal(await connection.hasTerminalEvent(), true)
  assert.equal(await connection.hasTerminalEvent(), true)
  assert.equal(reads, 2, 'changed file was not reprobed exactly once')
})

test('stream: keepalive comments arrive on an otherwise idle connection', async () => {
  const run = makeRun()
  const handler = createStreamHandler({ watch: false, pollMs: 1000, stateMs: 1000, keepaliveMs: 20 })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=events`)
  try {
    await client.ready
    await client.waitFor((frames) => frames.some((frame) => frame.comment === 'ping'))
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: watcher errors downgrade to the poll correctness floor', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, '')
  const made = []
  const fsImpl = {
    ...fs,
    promises: fs.promises,
    watch() {
      const watcher = new EventEmitter()
      watcher.close = () => {}
      made.push(watcher)
      return watcher
    },
  }
  const errors = []
  const handler = createStreamHandler({
    fsImpl,
    pollMs: 15,
    stateMs: 1000,
    keepaliveMs: 1000,
    onWatchError: (error, kind) => errors.push({ error, kind }),
  })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=events`)
  try {
    await client.ready
    await client.waitFor((frames) => systems(frames).some((record) => record.type === 'state'))
    assert.ok(made.length >= 1)
    made[0].emit('error', new Error('watch failed'))
    fs.appendFileSync(run.events, jsonl({ type: 'log', message: 'found-by-poll' }))
    await client.waitFor((frames) => records(frames).some((entry) => entry.r.message === 'found-by-poll'))
    assert.deepEqual(errors.map(({ kind }) => kind), ['run'])
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: connections for one run share one non-recursive watcher set', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, '')
  const watchers = []
  const fsImpl = {
    ...fs,
    promises: fs.promises,
    watch(target, options) {
      const watcher = new EventEmitter()
      watcher.target = target
      watcher.options = options
      watcher.closed = 0
      watcher.close = () => { watcher.closed++ }
      watchers.push(watcher)
      return watcher
    },
  }
  const handler = createStreamHandler({ fsImpl, pollMs: 1000, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const one = connect(server.port, `/api/runs/${run.runId}/stream?streams=events`)
  const two = connect(server.port, `/api/runs/${run.runId}/stream?streams=events`)
  try {
    await Promise.all([one.ready, two.ready])
    await Promise.all([
      one.waitFor((frames) => systems(frames).some((record) => record.type === 'state')),
      two.waitFor((frames) => systems(frames).some((record) => record.type === 'state')),
    ])
    assert.equal(watchers.filter((watcher) => watcher.target === fs.realpathSync(run.dir)).length, 1)
    assert.ok(watchers.every((watcher) => watcher.options.recursive !== true))
  } finally {
    one.close()
    two.close()
    const deadline = Date.now() + 1000
    while (!watchers.some((watcher) => watcher.closed) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(watchers.some((watcher) => watcher.closed === 1))
    await server.close()
  }
})

test('stream: symlinked agents outside the run stay poll-only and still deliver records', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, '')
  const outside = path.join(RUNS, `outside_agents_${sequence++}`)
  fs.mkdirSync(outside)
  const transcript = path.join(outside, '0.jsonl')
  fs.writeFileSync(transcript, '')
  fs.symlinkSync(outside, path.join(run.dir, 'agents'), 'dir')

  const watchers = []
  const fsImpl = {
    ...fs,
    promises: fs.promises,
    watch(target, options) {
      const watcher = new EventEmitter()
      watcher.target = target
      watcher.options = options
      watcher.close = () => {}
      watchers.push(watcher)
      return watcher
    },
  }
  const handler = createStreamHandler({
    fsImpl,
    pollMs: 15,
    stateMs: 1000,
    keepaliveMs: 1000,
  })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=&agents=0`)
  try {
    await client.ready
    await client.waitFor((frames) => systems(frames).some((record) => record.type === 'state'))
    const realOutside = fs.realpathSync(outside)
    assert.equal(watchers.some((watcher) => watcher.target === realOutside), false)
    assert.equal(watchers.filter((watcher) => watcher.target === fs.realpathSync(run.dir)).length, 1)

    fs.appendFileSync(transcript, jsonl({ kind: 'text', text: 'found-by-poll-only' }))
    await client.waitFor((frames) => records(frames).some((entry) => entry.r.text === 'found-by-poll-only'))
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: closing the last connection during agents realpath cannot leak a watcher', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, '')
  const agentsPath = path.join(run.dir, 'agents')
  let agentsRealpathCalls = 0
  let resolveAgentsRealpath
  const delayedAgentsRealpath = new Promise((resolve) => { resolveAgentsRealpath = resolve })
  const fsp = {
    ...fs.promises,
    async realpath(target) {
      if (target !== agentsPath) return fs.promises.realpath(target)
      agentsRealpathCalls++
      if (agentsRealpathCalls === 1) {
        const error = new Error('agents missing')
        error.code = 'ENOENT'
        throw error
      }
      return delayedAgentsRealpath
    },
  }
  const watchers = []
  const fsImpl = {
    ...fs,
    promises: fsp,
    watch(target) {
      const watcher = new EventEmitter()
      watcher.target = target
      watcher.closed = 0
      watcher.close = () => { watcher.closed++ }
      watchers.push(watcher)
      return watcher
    },
  }
  const handler = createStreamHandler({
    fsImpl,
    pollMs: 1000,
    stateMs: 1000,
    keepaliveMs: 1000,
    agentsWatchPollMs: 10,
  })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=events`)
  try {
    await client.ready
    const deadline = Date.now() + 1000
    while (agentsRealpathCalls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(agentsRealpathCalls, 2, 'lazy agents watcher poll never entered realpath')
    client.close()
    while (!watchers.some((watcher) => watcher.closed) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(watchers.some((watcher) => watcher.target === fs.realpathSync(run.dir) && watcher.closed === 1))
    resolveAgentsRealpath(agentsPath)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(watchers.filter((watcher) => watcher.target === agentsPath).length, 0)
  } finally {
    resolveAgentsRealpath(agentsPath)
    client.close()
    await server.close()
  }
})

test('stream: a 500 MB transcript subscribes at tail and reads only appended bytes', async () => {
  const run = makeRun()
  const agents = path.join(run.dir, 'agents')
  const transcript = path.join(agents, '0.jsonl')
  fs.mkdirSync(agents)
  const huge = 500 * 1024 * 1024
  fs.closeSync(fs.openSync(transcript, 'w'))
  fs.truncateSync(transcript, huge) // sparse fixture: size semantics without 500 MB of I/O
  const handler = createStreamHandler({ watch: false, pollMs: 15, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=&agents=0`)
  try {
    await client.ready
    await client.waitFor((frames) => frames.some((frame) => frame.event === 'sys' && frame.json.r.type === 'state'))
    assert.equal(records(client.frames).length, 0)
    fs.appendFileSync(transcript, jsonl({ kind: 'text', text: 'only-new-data' }))
    const entry = await client.waitFor((frames) => records(frames).find((item) => item.r.text === 'only-new-data'))
    assert.ok(entry.o > huge)
    assert.ok(client.frames.every((frame) => !frame.id || frame.id.includes(`a0=${entry.o}`) || frame.id.includes(`a0=${huge}`)))
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: 5,000 sibling runs do not enter a per-run subscription scan', async () => {
  const run = makeRun()
  fs.writeFileSync(run.events, jsonl({ type: 'log', message: 'target' }))
  const prefix = `bulk_${sequence++}_`
  for (let index = 0; index < 5000; index++) fs.mkdirSync(path.join(RUNS, prefix + index))
  const handler = createStreamHandler({ watch: false, pollMs: 1000, stateMs: 1000, keepaliveMs: 1000 })
  const server = await startServer(handler)
  const client = connect(server.port, `/api/runs/${run.runId}/stream?streams=events`)
  try {
    await client.ready
    await client.waitFor((frames) => records(frames).some((entry) => entry.r.message === 'target'))
  } finally {
    client.close()
    await server.close()
  }
})

test('stream: res.write backpressure pauses subsequent file reads until drain', async () => {
  const run = makeRun()
  const first = jsonl({ type: 'log', message: 'first' })
  fs.writeFileSync(run.events, first)
  class SlowResponse extends EventEmitter {
    constructor() {
      super()
      this.writes = []
      this.writableEnded = false
      this.block = true
    }
    writeHead() {}
    flushHeaders() {}
    write(value) {
      this.writes.push(value)
      if (this.block) { this.block = false; return false }
      return true
    }
    end() { this.writableEnded = true; this.emit('close') }
    destroy() { this.writableEnded = true; this.emit('close') }
  }
  const req = new EventEmitter()
  req.method = 'GET'
  req.headers = {}
  const res = new SlowResponse()
  const ctx = { activity: activity() }
  const connection = new StreamConnection({
    ctx,
    req,
    res,
    runId: run.runId,
    subscription: { streams: ['events'], agents: [] },
    selected: { cursor: { e: 0 }, source: 'query', reset: false },
    watch: false,
    pollMs: 1000,
    stateMs: 1000,
    keepaliveMs: 1000,
    deriveState: async () => ({ state: 'running' }),
  })
  connection.bindTeardown()
  const starting = connection.start()
  const deadline = Date.now() + 1000
  while (!res.writes.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(connection.paused, true)
  fs.appendFileSync(run.events, jsonl({ type: 'log', message: 'second' }))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(connection.specs.get('e').tail.readOffset, first.length, 'slow reader allowed another tail read')
  res.emit('drain')
  await starting
  await connection.enqueue(() => connection.drain(['e']))
  assert.equal(connection.specs.get('e').tail.readOffset, fs.statSync(run.events).size)
  connection.teardown()
  assert.equal(ctx.activity.sseClients, 0)
})
