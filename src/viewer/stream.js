// Multiplexed per-run SSE (DESIGN §5.5–§5.6).
//
// Files are authoritative. fs.watch only schedules an earlier drain; a mandatory poll
// performs the same work forever, so a missed/coalesced watch event cannot lose data.
import fs from 'node:fs'
import path from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { runDir } from '../util.js'
import { deriveRunState } from '../run-state.js'
import { HttpError, SECURITY_HEADERS } from './http.js'
import { ByteTail, MAX_READ_BYTES, readChunk } from './tail.js'
import { encodeCursor, selectCursor } from './cursor.js'

export const MAX_BATCH_RECORDS = 256
export const MAX_BATCH_BYTES = 64 * 1024
export const MAX_JOURNAL_RECORD_BYTES = 64 * 1024
export const DEFAULT_POLL_MS = 1000
export const DEFAULT_STATE_MS = 2000
export const DEFAULT_KEEPALIVE_MS = 15_000
export const DEFAULT_QUIET_CLOSE_MS = 2000
const TERMINAL = new Set(['completed', 'failed', 'interrupted'])
const JOURNAL_TYPES = new Set(['usage-cum', 'result', 'session', 'answer', 'mail', 'mail-done'])
const CANONICAL_INDEX = /^(0|[1-9][0-9]*)$/

const byteLength = (value) => Buffer.byteLength(value, 'utf8')
const sleepImmediate = () => immediate()

function parseList(raw) {
  return raw === null || raw === '' ? [] : raw.split(',').filter(Boolean)
}

export function parseSubscription(url) {
  const requested = url.searchParams.get('streams')
  const streamNames = requested === null ? ['events', 'journal'] : parseList(requested)
  if (streamNames.some((name) => name !== 'events' && name !== 'journal')) {
    throw new HttpError(400, 'bad_request', 'streams must be a comma list containing only events and journal')
  }
  const streams = [...new Set(streamNames)]
  const agentValues = parseList(url.searchParams.get('agents'))
  if (agentValues.length > 8) throw new HttpError(400, 'bad_request', 'at most 8 agent transcripts may be streamed')
  if (agentValues.some((value) => !CANONICAL_INDEX.test(value) || !Number.isSafeInteger(Number(value)))) {
    throw new HttpError(400, 'bad_request', 'agents must be a comma list of canonical non-negative integers')
  }
  const agents = [...new Set(agentValues.map(Number))]
  if (agents.length !== agentValues.length) throw new HttpError(400, 'bad_request', 'agents must not contain duplicates')
  if (streams.length === 0 && agents.length === 0) {
    throw new HttpError(400, 'bad_request', 'the stream subscription is empty')
  }
  return { streams, agents }
}

function resultPreview(record) {
  const resultSource = JSON.stringify(record.result)
  const resultBytes = resultSource === undefined ? 0 : byteLength(resultSource)
  return {
    ...(record.t !== undefined ? { t: record.t } : {}),
    type: 'result',
    key: record.key,
    index: record.index,
    status: record.status,
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.adapter !== undefined ? { adapter: record.adapter } : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    resultTruncated: true,
    resultBytes,
  }
}

function statIdentity(stat) {
  return { size: stat.size, dev: stat.dev, ino: stat.ino }
}

function isWithin(parent, child) {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}

// One watch/poll hub per streamed run (§5.5), shared by every SSE connection viewing
// that run. Tail state and backpressure remain per connection; only wakeups are shared.
const runHubs = new Map()

class RunWatchHub {
  constructor(connection) {
    this.key = connection.runPath
    this.runPath = connection.runPath
    this.fs = connection.fs
    this.fsp = connection.fsp
    this.pollMs = connection.pollMs
    this.stateMs = connection.stateMs
    this.agentsWatchPollMs = connection.agentsWatchPollMs
    this.watchEnabled = connection.watchEnabled
    this.connections = new Set()
    this.timers = new Set()
    this.watchers = new Map()
    this.watchErrors = new Set()
    this.starting = null
    this.stopped = false
  }

  async add(connection) {
    this.connections.add(connection)
    if (!this.starting) this.starting = this.start()
    await this.starting
    let released = false
    return () => {
      if (released) return
      released = true
      this.connections.delete(connection)
      if (!this.connections.size) this.stop()
    }
  }

  async start() {
    this.addTimer(setInterval(() => {
      for (const connection of this.connections) {
        connection.enqueue(() => connection.drain([...connection.specs.keys()]))
      }
    }, this.pollMs))
    this.addTimer(setInterval(() => {
      for (const connection of this.connections) connection.enqueue(() => connection.stateTick())
    }, this.stateMs))
    if (!this.watchEnabled) return

    let realRun
    try { realRun = await this.fsp.realpath(this.runPath) } catch (error) {
      this.reportWatchError('run', error)
      return
    }
    if (this.stopped || !this.connections.size) return
    this.addWatcher(realRun, 'run', (_event, filename) => {
      const name = Buffer.isBuffer(filename) ? filename.toString() : filename
      for (const connection of this.connections) connection.watchEvent('run', name)
    })

    const agentsPath = path.join(this.runPath, 'agents')
    const tryAgents = async () => {
      if (!this.connections.size || this.watchers.has('agents')) return true
      try {
        const realAgents = await this.fsp.realpath(agentsPath)
        if (this.stopped || !this.connections.size) return true
        if (!isWithin(realRun, realAgents)) return true
        this.addWatcher(realAgents, 'agents', (_event, filename) => {
          const name = Buffer.isBuffer(filename) ? filename.toString() : filename
          for (const connection of this.connections) connection.watchEvent('agents', name)
        })
        return true
      } catch (error) {
        if (error?.code === 'ENOENT') return false
        this.reportWatchError('agents', error)
        return true
      }
    }
    if (!(await tryAgents())) {
      const timer = setInterval(() => {
        void tryAgents().then((done) => {
          if (done) {
            clearInterval(timer)
            this.timers.delete(timer)
          }
        })
      }, this.agentsWatchPollMs)
      this.addTimer(timer)
    }
  }

  addTimer(timer) {
    timer.unref?.()
    this.timers.add(timer)
  }

  addWatcher(target, kind, callback) {
    if (this.stopped || !this.connections.size) return
    let watcher
    try {
      watcher = this.fs.watch(target, { persistent: false }, callback)
    } catch (error) {
      this.reportWatchError(kind, error)
      return
    }
    if (this.stopped || !this.connections.size) {
      try { watcher.close() } catch { /* already closed */ }
      return
    }
    this.watchers.set(kind, watcher)
    watcher.on('error', (error) => {
      if (this.watchers.get(kind) === watcher) this.watchers.delete(kind)
      try { watcher.close() } catch { /* already closed */ }
      this.reportWatchError(kind, error)
    })
  }

  reportWatchError(kind, error) {
    if (this.watchErrors.has(kind)) return
    this.watchErrors.add(kind)
    let handled = false
    for (const connection of this.connections) {
      if (connection.onWatchError) handled = true
      connection.reportWatchError(kind, error)
    }
    if (!handled) console.error(`flowition viewer: ${kind} watcher disabled; polling continues: ${error?.message ?? error}`)
  }

  stop() {
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    for (const watcher of this.watchers.values()) {
      try { watcher.close() } catch { /* already closed */ }
    }
    this.watchers.clear()
    if (runHubs.get(this.key) === this) runHubs.delete(this.key)
  }
}

async function acquireRunHub(connection) {
  let hub = runHubs.get(connection.runPath)
  if (!hub) {
    hub = new RunWatchHub(connection)
    runHubs.set(connection.runPath, hub)
  }
  return hub.add(connection)
}

/**
 * Build a handler compatible with routes.dispatch's handler injection seam.
 * Timing and filesystem seams are intentionally injectable for deterministic root tests.
 */
export function createStreamHandler(options = {}) {
  return async function streamHandler(ctx, req, res, url, context) {
    const subscription = parseSubscription(url)
    const selected = selectCursor({
      lastEventId: Array.isArray(req.headers['last-event-id'])
        ? req.headers['last-event-id'][0]
        : req.headers['last-event-id'],
      queryCursor: url.searchParams.get('cursor') ?? undefined,
    })
    const connection = new StreamConnection({
      ctx,
      req,
      res,
      url,
      runId: context.route.runId,
      subscription,
      selected,
      ...options,
    })
    connection.bindTeardown() // before start() performs its first await (§5.6.3)
    try {
      await connection.start()
    } catch (error) {
      connection.teardown()
      throw error
    }
  }
}

export const stream = createStreamHandler()

export class StreamConnection {
  constructor({
    ctx,
    req,
    res,
    runId,
    subscription,
    selected,
    fsImpl = fs,
    deriveState = deriveRunState,
    pollMs = DEFAULT_POLL_MS,
    stateMs = DEFAULT_STATE_MS,
    keepaliveMs = DEFAULT_KEEPALIVE_MS,
    quietCloseMs = DEFAULT_QUIET_CLOSE_MS,
    agentsWatchPollMs = 250,
    watch = true,
    now = () => Date.now(),
    onWatchError,
  }) {
    this.ctx = ctx
    this.req = req
    this.res = res
    this.runId = runId
    this.runPath = runDir(runId)
    this.subscription = subscription
    this.selected = selected
    this.fs = fsImpl
    this.fsp = fsImpl.promises
    this.deriveState = deriveState
    this.pollMs = pollMs
    this.stateMs = stateMs
    this.keepaliveMs = keepaliveMs
    this.quietCloseMs = quietCloseMs
    this.agentsWatchPollMs = agentsWatchPollMs
    this.watchEnabled = watch
    this.now = now
    this.onWatchError = onWatchError
    this.specs = new Map()
    this.cursor = {}
    this.batch = []
    this.batchBytes = 8 // byte length of {"f":[]}
    this.closed = false
    this.bound = false
    this.counted = false
    this.headersSent = false
    this.paused = false
    this.work = Promise.resolve()
    this.timers = new Set()
    this.reportedWatchErrors = new Set()
    this.releaseRunHub = null
    this.continuationPending = false
    this.liveScheduling = false
    this.lastActivityAt = this.now()
    this.lastStateJson = null
    this.terminalState = false
    this.terminalFold = false
    this.terminalEventProbe = null
  }

  bindTeardown() {
    if (this.bound) return
    this.bound = true
    this.ctx.activity.sseClients++
    this.counted = true
    const close = () => this.teardown()
    this.req.once('close', close)
    this.req.once('aborted', close)
    this.req.once('error', close)
    this.res.once('close', close)
    this.res.once('error', close)
  }

  async start() {
    let runStat
    try {
      runStat = await this.fsp.stat(this.runPath)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new HttpError(404, 'not_found', `run ${this.runId} does not exist`, { runId: this.runId })
      throw error
    }
    if (!runStat.isDirectory()) throw new HttpError(404, 'not_found', `run ${this.runId} does not exist`, { runId: this.runId })
    if (this.closed) return

    const resets = await this.initializeSpecs()
    if (this.closed) return
    this.writeHeaders()
    if (this.req.method === 'HEAD') {
      this.res.end()
      this.teardown()
      return
    }

    for (const stream of resets) await this.sendSys({ type: 'reset', stream })
    const initialMore = await this.drain([...this.specs.keys()])
    await this.stateTick()
    if (this.closed) return
    // No callback can race reset-before-replay ordering above. An append in this small
    // setup window is still found by the correctness-floor poll installed here.
    this.liveScheduling = true
    this.startTimers()
    const release = await acquireRunHub(this)
    if (this.closed) release()
    else this.releaseRunHub = release
    if (initialMore) this.scheduleContinuation()
  }

  async initializeSpecs() {
    const reset = new Set()
    const add = async (id, file) => {
      let stat = null
      try { stat = await this.fsp.stat(file) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const defaultValue = id.startsWith('a') ? 'tail' : 0
      const requested = Object.prototype.hasOwnProperty.call(this.selected.cursor, id)
        ? this.selected.cursor[id]
        : defaultValue
      const size = stat?.size ?? 0
      let offset = requested === 'tail' ? size : requested
      if (offset > size) {
        offset = 0
        reset.add(id)
      }
      const tail = new ByteTail({ offset })
      if (stat) tail.observe(statIdentity(stat))
      this.cursor[id] = offset
      this.specs.set(id, { id, file, tail, existed: !!stat })
      if (this.selected.reset) reset.add(id)
    }

    if (this.subscription.streams.includes('events')) await add('e', path.join(this.runPath, 'events.jsonl'))
    if (this.subscription.streams.includes('journal')) await add('j', path.join(this.runPath, 'journal.jsonl'))
    for (const index of this.subscription.agents) await add(`a${index}`, path.join(this.runPath, 'agents', `${index}.jsonl`))
    return reset
  }

  writeHeaders() {
    if (this.headersSent || this.closed) return
    this.headersSent = true
    this.res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    this.res.flushHeaders?.()
  }

  startTimers() {
    this.addTimer(setInterval(() => this.enqueue(async () => {
      await this.flushBatch()
      await this.writeRaw(': ping\n\n')
    }), this.keepaliveMs))
  }

  addTimer(timer) {
    timer.unref?.()
    this.timers.add(timer)
  }

  enqueue(task) {
    if (this.closed) return this.work
    this.work = this.work.then(async () => {
      if (!this.closed) await task()
    }).catch((error) => this.fail(error))
    return this.work
  }

  watchEvent(kind, name) {
    if (kind === 'run') {
      if (name === 'events.jsonl') this.enqueue(() => this.drain(['e']))
      else if (name === 'journal.jsonl') this.enqueue(() => this.drain(['j']))
      else this.enqueue(() => this.drain([...this.specs.keys()]))
      return
    }
    const match = /^([0-9]+)\.jsonl$/.exec(name ?? '')
    const id = match ? `a${Number(match[1])}` : null
    this.enqueue(() => this.drain(id && this.specs.has(id) ? [id] : [...this.specs.keys()].filter((key) => key.startsWith('a'))))
  }

  reportWatchError(kind, error) {
    if (this.reportedWatchErrors.has(kind)) return
    this.reportedWatchErrors.add(kind)
    this.onWatchError?.(error, kind)
  }

  async runExists() {
    try {
      return (await this.fsp.stat(this.runPath)).isDirectory()
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  async drain(ids) {
    if (this.closed) return false
    if (!(await this.runExists())) {
      await this.sendSys({ type: 'gone' })
      this.finish()
      return false
    }
    let more = false
    for (const id of ids) {
      const spec = this.specs.get(id)
      if (spec && await this.drainOne(spec)) more = true
      if (this.closed) return false
    }
    await this.flushBatch()
    if (more && this.liveScheduling) this.scheduleContinuation()
    return more
  }

  scheduleContinuation() {
    if (this.continuationPending || this.closed) return
    this.continuationPending = true
    void sleepImmediate().then(() => {
      this.continuationPending = false
      this.enqueue(() => this.drain([...this.specs.keys()]))
    })
  }

  async drainOne(spec) {
    let handle
    let stat
    try {
      handle = await this.fsp.open(spec.file, 'r')
      stat = await handle.stat()
    } catch (error) {
      try { await handle?.close() } catch { /* no handle */ }
      if (error?.code !== 'ENOENT') throw error
      if (!(await this.runExists())) {
        await this.sendSys({ type: 'gone' })
        this.finish()
        return false
      }
      if (spec.existed) {
        spec.existed = false
        spec.tail.reset(0)
        this.cursor[spec.id] = 0
        this.lastActivityAt = this.now()
        await this.sendSys({ type: 'reset', stream: spec.id })
      }
      return false
    }

    try {
      const observed = spec.tail.observe(statIdentity(stat))
      if (observed.reset || !spec.existed) {
        if (spec.existed || observed.reset) {
          this.cursor[spec.id] = 0
          this.lastActivityAt = this.now()
          await this.sendSys({ type: 'reset', stream: spec.id })
        }
        spec.existed = true
      }
      if (stat.size === spec.tail.readOffset) return false

      const at = spec.tail.readOffset
      const read = await readChunk(handle, at, Math.min(MAX_READ_BYTES, stat.size - at))
      if (read.bytes.length) this.lastActivityAt = this.now()
      const parsed = spec.tail.push(read.bytes, at)
      for (const event of parsed.events) {
        if (event.skipped) {
          this.cursor[spec.id] = event.offset
          await this.sendSys({ type: 'note', stream: spec.id, message: 'oversize JSONL record skipped' })
        } else {
          await this.consumeLine(spec, event)
        }
      }
      return read.nextOffset < stat.size
    } finally {
      await handle.close()
    }
  }

  async consumeLine(spec, line) {
    const raw = line.bytes.toString('utf8')
    if (!raw.trim()) {
      this.cursor[spec.id] = line.offset
      return
    }
    let record
    try { record = JSON.parse(raw) } catch {
      this.cursor[spec.id] = line.offset
      await this.sendSys({ type: 'note', stream: spec.id, message: 'invalid JSONL record skipped' })
      return
    }

    if (spec.id === 'j') {
      if (!JOURNAL_TYPES.has(record?.type)) {
        this.cursor.j = line.offset
        return
      }
      const entry = { s: spec.id, o: line.offset, r: record }
      const framedBytes = byteLength(JSON.stringify(entry)) + 8
      const oversize = line.bytes.length > MAX_JOURNAL_RECORD_BYTES || framedBytes > MAX_BATCH_BYTES
      if (oversize && record.type !== 'result') {
        this.cursor.j = line.offset
        await this.sendSys({ type: 'note', stream: 'j', message: `oversize ${String(record.type)} journal record skipped` })
        return
      }
      if (oversize) record = resultPreview(record)
    }
    if (spec.id === 'e' && record?.type === 'run') this.terminalFold = TERMINAL.has(record.state)
    await this.queueRecord({ s: spec.id, o: line.offset, r: record }, spec.id, line.offset)
  }

  async queueRecord(entry, stream, offset) {
    const serialized = JSON.stringify(entry)
    const entryBytes = byteLength(serialized)
    const standaloneBytes = entryBytes + 8
    const added = entryBytes + (this.batch.length ? 1 : 0)
    if (this.batch.length && (this.batch.length >= MAX_BATCH_RECORDS || this.batchBytes + added > MAX_BATCH_BYTES)) {
      await this.flushBatch()
    }
    this.batch.push(serialized)
    this.batchBytes += entryBytes + (this.batch.length > 1 ? 1 : 0)
    this.cursor[stream] = offset
    if (standaloneBytes > MAX_BATCH_BYTES || this.batch.length >= MAX_BATCH_RECORDS) await this.flushBatch()
  }

  async flushBatch() {
    if (!this.batch.length || this.closed) return
    const data = `{"f":[${this.batch.join(',')}]}`
    this.batch = []
    this.batchBytes = 8
    await this.writeEvent('batch', data)
  }

  async sendSys(record) {
    if (this.closed) return
    await this.flushBatch()
    await this.writeEvent('sys', JSON.stringify({ s: 'sys', r: record }))
  }

  async writeEvent(event, data) {
    const frame = `id: ${encodeCursor(this.cursor)}\nevent: ${event}\ndata: ${data}\n\n`
    await this.writeRaw(frame)
  }

  async writeRaw(frame) {
    if (this.closed) return false
    let writable
    try { writable = this.res.write(frame) } catch {
      this.teardown()
      return false
    }
    if (writable) return true
    this.paused = true
    await new Promise((resolve) => {
      const done = () => {
        this.res.removeListener('drain', drained)
        this.res.removeListener('close', closed)
        this.res.removeListener('error', closed)
        this.req.removeListener('close', closed)
        this.req.removeListener('aborted', closed)
        this.req.removeListener('error', closed)
        this.paused = false
        resolve()
      }
      const drained = () => done()
      const closed = () => done()
      this.res.once('drain', drained)
      this.res.once('close', closed)
      this.res.once('error', closed)
      this.req.once('close', closed)
      this.req.once('aborted', closed)
      this.req.once('error', closed)
    })
    return !this.closed
  }

  async stateTick() {
    if (this.closed) return
    if (!(await this.runExists())) {
      await this.sendSys({ type: 'gone' })
      this.finish()
      return
    }
    const state = await this.deriveState(this.runPath)
    const stateRecord = {
      type: 'state',
      state: state.state,
      ...(state.live !== undefined && state.live !== null ? { live: !!state.live } : {}),
      ...(state.detail !== undefined && state.detail !== null ? { detail: String(state.detail).slice(0, 4096) } : {}),
    }
    const serialized = JSON.stringify(stateRecord)
    if (serialized !== this.lastStateJson) {
      this.lastStateJson = serialized
      this.ctx.activity.noteRunState(this.runId, state.state)
      await this.sendSys(stateRecord)
    }
    this.terminalState = TERMINAL.has(state.state)
    if (this.terminalState && !this.terminalFold) this.terminalFold = await this.hasTerminalEvent()
    if (this.terminalState && this.terminalFold && this.now() - this.lastActivityAt >= this.quietCloseMs) {
      await this.sendSys({ type: 'end' })
      this.finish()
    }
  }

  /** Bounded last-1-MiB probe for snapshot-at-EOF terminal connections. */
  async hasTerminalEvent() {
    const file = path.join(this.runPath, 'events.jsonl')
    let handle
    try {
      const current = await this.fsp.stat(file)
      const identity = { size: current.size, mtimeMs: current.mtimeMs }
      if (
        this.terminalEventProbe &&
        this.terminalEventProbe.size === identity.size &&
        this.terminalEventProbe.mtimeMs === identity.mtimeMs
      ) {
        return this.terminalEventProbe.value
      }
      handle = await this.fsp.open(file, 'r')
      const stat = await handle.stat()
      const start = Math.max(0, stat.size - MAX_READ_BYTES)
      const length = stat.size - start
      let value = false
      if (length) {
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buffer, 0, length, start)
        const source = buffer.subarray(0, bytesRead).toString('utf8')
        const lines = source.split('\n')
        if (start > 0) lines.shift() // first line may begin before the bounded window
        for (let index = lines.length - 1; index >= 0; index--) {
          if (!lines[index].trim()) continue
          try {
            const record = JSON.parse(lines[index])
            if (record?.type === 'run') {
              value = TERMINAL.has(record.state)
              break
            }
          } catch { /* lossy observer */ }
        }
      }
      this.terminalEventProbe = { size: stat.size, mtimeMs: stat.mtimeMs, value }
      return value
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    } finally {
      await handle?.close()
    }
  }

  finish() {
    if (this.res.writableEnded) return this.teardown()
    try { this.res.end() } catch { /* socket already gone */ }
    this.teardown()
  }

  fail(error) {
    if (this.closed) return
    if (this.headersSent) {
      try { this.res.destroy(error) } catch { /* already gone */ }
      this.teardown()
      return
    }
    this.teardown()
    throw error
  }

  teardown() {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    this.releaseRunHub?.()
    this.releaseRunHub = null
    if (this.counted) {
      this.counted = false
      this.ctx.activity.sseClients--
    }
  }
}
