/**
 * The multiplexed SSE client (DESIGN §9.4), with the reconnect latch of §9.3.
 *
 * One EventSource per run page carries every stream that page reads — `events`, the
 * filtered `journal` feed, and up to eight agent transcripts (§5.6.1). This module owns
 * exactly three hard things and nothing else:
 *
 *  1. **The composite cursor.** Every frame's `id` is the cursor AFTER that batch
 *     (§5.6.3), so the browser's own `Last-Event-ID` resumes exactly. `reopen()` builds a
 *     FRESH URL from the tracked cursor and therefore carries no header — which is what
 *     makes §5.6.2's precedence rule ("`Last-Event-ID` always wins over `?cursor=`") safe
 *     to rely on rather than a hazard.
 *
 *  2. **Per-stream reset, never vector-wide** (Sol-9, parity #103). A `sys/reset` drops
 *     exactly one stream's buffers. And the FAIL-SAFE: if a stream's first record after a
 *     (re)connect is at-or-behind the offset already seen, with no reset marker, that
 *     stream is replaying from the start — so its buffers are dropped too, and only its.
 *     Ambiguity resolves to reset, which duplicates nothing (the fail-safe rule).
 *
 *  3. **The latch.** The stream closes on the server's `sys/end` (§5.6.4's quiet close,
 *     parity #100) or `sys/gone`, and on NOTHING ELSE. There is deliberately no timer in
 *     this file that decides a quiet run is dead — parity #102 — and no input from the
 *     status poll, which is what structurally guarantees parity #101: a terminal poll
 *     verdict landing mid-replay cannot sever a replay, because it cannot reach here.
 *     Re-arming after a resume is the store's job (parity #98/#99/#118).
 *
 *     And `end` alone does not latch: §9.3 says "latch off the **folded** terminal state",
 *     so an `end` is held as PENDING until `endGate()` — the store's folded-run verdict —
 *     agrees. `settleEnd()` re-asks it after every fold. A premature `end` (a server that
 *     decided the run was over while bytes we have not folded are still in flight) leaves
 *     the connection open, which is the fail-safe direction: the worst case is that the
 *     server closes it and the browser resumes from `Last-Event-ID`, replaying exactly the
 *     gap. §5.6.4 makes an honest `end` conditional on the SERVER's fold being terminal,
 *     so a client that has consumed the same bytes always reaches the same verdict.
 *
 * Reconnection: a transient drop is the browser's job and it does it with the header. A
 * connection the browser has given up on (`readyState === CLOSED`, e.g. a 5xx or a
 * dropped listener) is retried here with capped exponential backoff, because otherwise a
 * viewer that was restarted never reconnects at all.
 */

import { encodeCursor, parseCursor } from '../../../src/viewer/cursor.js'
import type { RunState } from './types.js'

// ---- wire shapes ------------------------------------------------------------------------

/** `'e'` | `'j'` | `'a<n>'` — §5.6.2's cursor component keys, reused as stream ids. */
export type StreamId = string

export interface StreamFrame {
  s: StreamId
  o: number
  r: Record<string, unknown>
}

export type SysRecord =
  | { type: 'state'; state: RunState; live?: boolean; detail?: string }
  | { type: 'reset'; stream: StreamId }
  | { type: 'gone' }
  | { type: 'end' }
  | { type: 'note'; stream?: StreamId; message: string }
  | { type: string; [k: string]: unknown }

export type CursorMap = Record<string, number | 'tail'>

/**
 * `connecting` → `live` on the first open. `reconnecting` covers both the browser's own
 * retry and ours. `ended`/`gone` are LATCHED: the client will not reopen itself.
 */
export type SseStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'gone' | 'closed'

// ---- the EventSource seam ---------------------------------------------------------------

export interface SseLike {
  readyState: number
  close(): void
  addEventListener(type: string, listener: (event: never) => void): void
  removeEventListener?(type: string, listener: (event: never) => void): void
  onopen?: ((event: unknown) => void) | null
  onerror?: ((event: unknown) => void) | null
  onmessage?: ((event: unknown) => void) | null
}

export type SseCtor = new (url: string, init?: { withCredentials?: boolean }) => SseLike

export const CONNECTING = 0
export const OPEN = 1
export const CLOSED = 2

export interface SseTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SseClientOptions {
  runId: string
  streams?: ('events' | 'journal')[]
  agents?: number[]
  /** Snapshot offsets (§9.3). Agents default to `tail` when omitted (§5.6.1). */
  cursor?: CursorMap
  /**
   * §7.1.2 permits `?token=` for EventSource ALONE, because it cannot set headers. Every
   * `fetch` in `client.ts` uses `Authorization` instead; do not widen this.
   */
  token?: string | null
  basePath?: string
  onBatch?: (frames: StreamFrame[], cursor: CursorMap) => void
  /** One stream's buffers must be dropped, and only that one's. */
  onReset?: (stream: StreamId) => void
  onSys?: (record: SysRecord) => void
  onStatus?: (status: SseStatus) => void
  /**
   * "May a `sys/end` latch now?" — §9.3's rule 1, made a parameter rather than a
   * convention. The store answers from its FOLDED run state, having first folded every
   * record already in hand; `false` holds the end pending and keeps the replay open.
   * Omitted → an `end` latches immediately (the pure-transport default).
   */
  endGate?: () => boolean
  EventSourceImpl?: SseCtor | null
  timers?: SseTimers
  retryBaseMs?: number
  retryMaxMs?: number
}

export interface SseStats {
  batches: number
  records: number
  /** Records at-or-behind a stream's cursor mid-connection — dropped, never rendered twice. */
  stale: number
  resets: number
  /** Fail-safe resets this client inferred from a backwards offset (parity #103). */
  inferredResets: number
  connects: number
  retries: number
  parseErrors: number
  /** `sys/end` frames the fold verdict declined to latch on (§9.3 rule 1). */
  deferredEnds: number
}

export interface SseClient {
  open(): void
  close(): void
  /**
   * Close and reconnect from a fresh URL built on the CURRENT cursor. The agent set is
   * per-connection on a stateless server (§5.6.1), so changing it is a reopen; it is also
   * how the store re-arms a quiet-closed stream after a resume (parity #99/#118).
   */
  reopen(next?: { agents?: number[]; streams?: ('events' | 'journal')[] }): void
  /**
   * Re-ask `endGate` for a `sys/end` that arrived while the fold was still non-terminal.
   * The store calls it after every fold; it is a no-op when no end is pending.
   */
  settleEnd(): void
  readonly status: SseStatus
  /** A `sys/end` has been received and is waiting on `endGate` (§9.3 rule 1). */
  readonly endPending: boolean
  readonly cursor: CursorMap
  readonly agents: number[]
  readonly url: string
  readonly stats: SseStats
}

const DEFAULT_TIMERS: SseTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function streamIdForAgent(index: number): StreamId {
  return `a${index}`
}

/** Build the §5.6.1 subscription URL. Exported for the store's tests and for debugging. */
export function buildStreamUrl(options: {
  runId: string
  streams: ('events' | 'journal')[]
  agents: number[]
  cursor: CursorMap
  token?: string | null
  basePath?: string
}): string {
  const params = new URLSearchParams()
  params.set('streams', options.streams.join(','))
  if (options.agents.length) params.set('agents', options.agents.join(','))
  const cursor = encodeCursorSafely(options.cursor)
  if (cursor) params.set('cursor', cursor)
  if (options.token) params.set('token', options.token)
  const base = options.basePath ?? ''
  return `${base}/api/runs/${encodeURIComponent(options.runId)}/stream?${params.toString()}`
}

/**
 * A cursor we cannot encode is a cursor we must not send: §5.6.2 treats a malformed one as
 * absent and restarts the subscription with a `reset` frame, which is the correct
 * fail-safe but is strictly worse than simply omitting it and taking the defaults.
 */
function encodeCursorSafely(cursor: CursorMap): string | null {
  const clean: CursorMap = {}
  for (const [key, value] of Object.entries(cursor)) {
    if (value === 'tail') { if (key.startsWith('a')) clean[key] = 'tail'; continue }
    if (Number.isSafeInteger(value) && value >= 0) clean[key] = value
  }
  if (!Object.keys(clean).length) return null
  try { return encodeCursor(clean) as string } catch { return null }
}

export function createSseClient(options: SseClientOptions): SseClient {
  const timers = options.timers ?? DEFAULT_TIMERS
  const retryBaseMs = options.retryBaseMs ?? 1000
  const retryMaxMs = options.retryMaxMs ?? 30_000
  const Impl = options.EventSourceImpl
    ?? (globalThis as { EventSource?: SseCtor }).EventSource
    ?? null

  let streams: ('events' | 'journal')[] = options.streams ?? ['events', 'journal']
  let agents = [...(options.agents ?? [])]
  const cursor: CursorMap = { ...(options.cursor ?? {}) }
  for (const index of agents) if (!(streamIdForAgent(index) in cursor)) cursor[streamIdForAgent(index)] = 'tail'

  let source: SseLike | null = null
  let status: SseStatus = 'idle'
  let url = ''
  let retryHandle: unknown = null
  let retryDelay = retryBaseMs
  let latched = false
  let endPending = false

  // Per-connection state. Replay detection is a property of a CONNECTION, not of the
  // client: every (re)connect re-arms it, which is exactly the window in which a server
  // that restarted from zero has to be caught.
  let firstSeen = new Set<StreamId>()
  let resetThisConnection = new Set<StreamId>()

  const stats: SseStats = {
    batches: 0, records: 0, stale: 0, resets: 0,
    inferredResets: 0, connects: 0, retries: 0, parseErrors: 0, deferredEnds: 0,
  }

  const setStatus = (next: SseStatus) => {
    if (status === next) return
    status = next
    options.onStatus?.(next)
  }

  const dropStream = (stream: StreamId, inferred: boolean) => {
    stats.resets++
    if (inferred) stats.inferredResets++
    cursor[stream] = 0
    resetThisConnection.add(stream)
    options.onReset?.(stream)
  }

  /** Merge the frame `id`. It is authoritative: it advances past records the server
   *  consumed but filtered out (§5.6.5), which record offsets alone cannot see. */
  const mergeEventId = (id: unknown) => {
    if (typeof id !== 'string' || !id) return
    const parsed = parseCursor(id) as Record<string, number | 'tail'> | null
    if (!parsed) return
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'tail') continue
      const current = cursor[key]
      cursor[key] = typeof current === 'number' ? Math.max(current, value) : value
    }
  }

  const onBatchEvent = (event: { data?: string; lastEventId?: string }) => {
    let payload: { f?: unknown[] }
    try { payload = JSON.parse(String(event.data ?? '')) as { f?: unknown[] } } catch {
      stats.parseErrors++
      return
    }
    const incoming = Array.isArray(payload?.f) ? payload.f : []
    const delivered: StreamFrame[] = []

    for (const raw of incoming) {
      const frame = raw as StreamFrame | null
      if (!frame || typeof frame !== 'object' || typeof frame.s !== 'string') { stats.parseErrors++; continue }
      const stream = frame.s
      const offset = Number(frame.o)
      const seen = cursor[stream]

      if (!firstSeen.has(stream)) {
        firstSeen.add(stream)
        // §9.4: at-or-behind on the first record of a connection, with no reset marker,
        // means this stream is replaying in full. Drop ITS buffers; leave the others.
        if (
          !resetThisConnection.has(stream)
          && typeof seen === 'number'
          && Number.isFinite(offset)
          && offset <= seen
        ) dropStream(stream, true)
      } else if (typeof seen === 'number' && Number.isFinite(offset) && offset <= seen) {
        // Mid-connection non-advancing offsets can only be duplicates. P8 says zero.
        stats.stale++
        continue
      }

      if (Number.isFinite(offset)) cursor[stream] = offset
      delivered.push(frame)
    }

    mergeEventId(event.lastEventId)
    stats.batches++
    stats.records += delivered.length
    if (delivered.length) options.onBatch?.(delivered, { ...cursor })
  }

  const onSysEvent = (event: { data?: string; lastEventId?: string }) => {
    let payload: { r?: SysRecord }
    try { payload = JSON.parse(String(event.data ?? '')) as { r?: SysRecord } } catch {
      stats.parseErrors++
      return
    }
    const record = payload?.r
    mergeEventId(event.lastEventId)
    if (!record || typeof record !== 'object') return

    if (record.type === 'reset' && typeof (record as { stream?: string }).stream === 'string') {
      const stream = (record as { stream: string }).stream
      // Mark it seen so the fail-safe above does not fire a SECOND reset on the replayed
      // records that follow (§5.6.2 rule 3 guarantees they follow, never precede).
      firstSeen.add(stream)
      dropStream(stream, false)
    }
    options.onSys?.(record)
    if (record.type === 'end') {
      endPending = true
      tryEnd()
      if (endPending) stats.deferredEnds++   // counted once per frame, not per re-ask
    }
    // `gone` is unconditional: the run directory is not there any more, so no further
    // record can ever arrive and there is nothing for a fold verdict to wait for.
    if (record.type === 'gone') { endPending = false; latched = true; teardown('gone') }
  }

  /** §9.3 rule 1: the FOLDED verdict decides, and it may not have arrived yet. */
  const tryEnd = () => {
    if (!endPending || latched) return
    if (options.endGate && !options.endGate()) return
    endPending = false
    latched = true
    teardown('ended')
  }

  const onOpen = () => {
    stats.connects++
    retryDelay = retryBaseMs
    firstSeen = new Set()
    resetThisConnection = new Set()
    setStatus('live')
  }

  const onError = () => {
    if (latched || status === 'closed') return
    // A new connection is coming (ours or the browser's): re-arm replay detection.
    firstSeen = new Set()
    resetThisConnection = new Set()
    setStatus('reconnecting')
    if (source && source.readyState !== CLOSED) return   // the browser is retrying with the header
    scheduleRetry()
  }

  const scheduleRetry = () => {
    if (retryHandle != null || latched || status === 'closed') return
    const delay = retryDelay
    retryDelay = Math.min(retryMaxMs, retryDelay * 2)
    stats.retries++
    retryHandle = timers.setTimeout(() => {
      retryHandle = null
      if (latched || status === 'closed') return
      connect()
    }, delay)
  }

  const detach = () => {
    if (retryHandle != null) { timers.clearTimeout(retryHandle); retryHandle = null }
    if (!source) return
    try { source.close() } catch { /* already closed */ }
    source = null
  }

  const teardown = (next: SseStatus) => {
    detach()
    setStatus(next)
  }

  const connect = () => {
    detach()
    if (!Impl) { setStatus('closed'); return }
    url = buildStreamUrl({
      runId: options.runId,
      streams,
      agents,
      cursor,
      token: options.token ?? null,
      basePath: options.basePath ?? '',
    })
    firstSeen = new Set()
    resetThisConnection = new Set()
    setStatus(status === 'reconnecting' ? 'reconnecting' : 'connecting')
    const es = new Impl(url, { withCredentials: false })
    source = es
    es.addEventListener('open', onOpen as (event: never) => void)
    es.addEventListener('error', onError as (event: never) => void)
    es.addEventListener('batch', onBatchEvent as (event: never) => void)
    es.addEventListener('sys', onSysEvent as (event: never) => void)
  }

  return {
    open() {
      if (status === 'live' || status === 'connecting') return
      latched = false
      endPending = false
      connect()
    },
    close() {
      latched = true
      endPending = false
      teardown('closed')
    },
    reopen(next) {
      if (next?.streams) streams = next.streams
      if (next?.agents) {
        agents = [...next.agents]
        for (const index of agents) {
          if (!(streamIdForAgent(index) in cursor)) cursor[streamIdForAgent(index)] = 'tail'
        }
        // A transcript no longer subscribed keeps no cursor: re-adding it later must open
        // at `tail`, not replay a window the pane already discarded.
        for (const key of Object.keys(cursor)) {
          if (key.startsWith('a') && !agents.includes(Number(key.slice(1)))) delete cursor[key]
        }
      }
      latched = false
      endPending = false
      connect()
    },
    settleEnd() { tryEnd() },
    get status() { return status },
    get endPending() { return endPending },
    get cursor() { return { ...cursor } },
    get agents() { return [...agents] },
    get url() { return url },
    get stats() { return { ...stats } },
  }
}
