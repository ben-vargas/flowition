/**
 * §11.3: "`sse.ts` latch composition against MockEventSource with fake timers
 * (reconnect-resume, reconnect-reset, terminal-fold latch, resumed-run re-arm — parity
 * #118)". Parity #100–#104 live here; #97–#99 and the fold-vs-poll half of #101 are in
 * `state/runStore.test.ts`, which is where the poll exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildStreamUrl, createSseClient, type StreamFrame, type SysRecord } from './sse.js'
import { MockEventSource, MockEventSourceCtor } from '../lib/mockEventSource.js'

const rec = (n: number) => ({ t: n, type: 'agent', index: 0, state: 'progress' })

interface Harness {
  batches: StreamFrame[][]
  resets: string[]
  sys: SysRecord[]
  statuses: string[]
}

function harness(overrides: Partial<Parameters<typeof createSseClient>[0]> = {}) {
  const seen: Harness = { batches: [], resets: [], sys: [], statuses: [] }
  const client = createSseClient({
    runId: 'run-1',
    cursor: { e: 100, j: 50 },
    token: 'tok',
    EventSourceImpl: MockEventSourceCtor,
    onBatch: (frames) => seen.batches.push(frames),
    onReset: (stream) => seen.resets.push(stream),
    onSys: (record) => seen.sys.push(record),
    onStatus: (status) => seen.statuses.push(status),
    ...overrides,
  })
  return { client, seen }
}

beforeEach(() => {
  MockEventSource.reset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('subscription url (§5.6.1)', () => {
  it('carries streams, agents, the composite cursor and the EventSource-only token', () => {
    const url = buildStreamUrl({
      runId: 'a b/c',
      streams: ['events', 'journal'],
      agents: [3, 7],
      cursor: { e: 182930, j: 44100, a3: 88211, a7: 'tail' },
      token: 'secret',
    })
    const parsed = new URL(url, 'http://x')
    expect(parsed.pathname).toBe('/api/runs/a%20b%2Fc/stream')
    expect(parsed.searchParams.get('streams')).toBe('events,journal')
    expect(parsed.searchParams.get('agents')).toBe('3,7')
    expect(parsed.searchParams.get('cursor')).toBe('v1;e=182930;j=44100;a3=88211;a7=tail')
    expect(parsed.searchParams.get('token')).toBe('secret')
  })

  it('omits an unencodable cursor rather than sending one the server must reject', () => {
    // §5.6.2 treats a malformed cursor as absent + a `reset` frame. Omitting it reaches the
    // same subscription defaults without spending a reset.
    const url = buildStreamUrl({
      runId: 'r', streams: ['events'], agents: [],
      cursor: { e: Number.NaN, j: -1 } as never,
    })
    expect(new URL(url, 'http://x').searchParams.has('cursor')).toBe(false)
  })
})

describe('delivery and the composite cursor', () => {
  it('delivers batches and advances the cursor from the frame id, not from the records', () => {
    const { client, seen } = harness()
    client.open()
    MockEventSource.last.open()
    // The id is authoritative: it advances past journal records the server CONSUMED but
    // filtered out (§5.6.5), which the delivered offsets alone cannot see.
    MockEventSource.last.batch([{ s: 'e', o: 140, r: rec(1) }], 'v1;e=140;j=900')
    expect(seen.batches).toEqual([[{ s: 'e', o: 140, r: rec(1) }]])
    expect(client.cursor).toEqual({ e: 140, j: 900 })
    expect(client.status).toBe('live')
  })

  it('counts malformed payloads instead of throwing (§6.5)', () => {
    const { client, seen } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.raw('batch', '{not json')
    MockEventSource.last.batch([null as unknown as StreamFrame], 'v1;e=140')
    expect(seen.batches).toEqual([])
    expect(client.stats.parseErrors).toBe(2)
  })

  it('drops mid-connection records at-or-behind the cursor — P8 says zero duplicates', () => {
    const { client, seen } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 140, r: rec(1) }], 'v1;e=140')
    MockEventSource.last.batch([
      { s: 'e', o: 140, r: rec(1) },
      { s: 'e', o: 180, r: rec(2) },
    ], 'v1;e=180')
    expect(seen.batches[1]).toEqual([{ s: 'e', o: 180, r: rec(2) }])
    expect(client.stats.stale).toBe(1)
  })
})

describe('reconnect-resume (parity #103)', () => {
  it('a transient drop is the browser’s: no second connection, no reset, no duplicates', () => {
    const { client, seen } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 140, r: rec(1) }], 'v1;e=140;j=50')

    MockEventSource.last.drop()
    expect(client.status).toBe('reconnecting')
    // The browser retries with Last-Event-ID; the client must not open its own.
    vi.advanceTimersByTime(120_000)
    expect(MockEventSource.instances).toHaveLength(1)

    MockEventSource.last.reconnect()
    MockEventSource.last.batch([{ s: 'e', o: 200, r: rec(2) }], 'v1;e=200;j=50')

    expect(seen.resets).toEqual([])
    expect(seen.batches.flat().map((f) => f.o)).toEqual([140, 200])
    expect(MockEventSource.connections.map((c) => c.native)).toEqual([false, true])
    expect(client.status).toBe('live')
  })
})

describe('reconnect-reset (parity #19, #103, §5.6.2 rule 3)', () => {
  it('a sys/reset drops exactly one stream and arrives before that stream’s replay', () => {
    const { client, seen } = harness({ agents: [3], cursor: { e: 100, j: 50, a3: 900 } })
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 140, r: rec(1) }], 'v1;e=140')

    MockEventSource.last.drop()
    MockEventSource.last.reconnect()
    MockEventSource.last.sys({ type: 'reset', stream: 'a3' }, 'v1;e=140;j=50;a3=0')
    MockEventSource.last.batch([
      { s: 'a3', o: 30, r: { type: 'text' } },
      { s: 'e', o: 180, r: rec(2) },
    ], 'v1;e=180;j=50;a3=30')

    expect(seen.resets).toEqual(['a3'])
    // The other streams were untouched and kept delivering forward.
    expect(seen.batches.flat().filter((f) => f.s === 'e').map((f) => f.o)).toEqual([140, 180])
    expect(client.cursor.a3).toBe(30)
    expect(client.stats.inferredResets).toBe(0)
  })

  it('an explicit reset suppresses the fail-safe: one reset, not two', () => {
    const { seen, client } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 140, r: rec(1) }], 'v1;e=140')
    MockEventSource.last.drop()
    MockEventSource.last.reconnect()
    MockEventSource.last.sys({ type: 'reset', stream: 'e' })
    MockEventSource.last.batch([{ s: 'e', o: 20, r: rec(9) }], 'v1;e=20')
    expect(seen.resets).toEqual(['e'])
    expect(client.stats.inferredResets).toBe(0)
  })

  it('FAIL-SAFE: a replay from behind with no marker resets that stream, and only it', () => {
    const { client, seen } = harness({ agents: [3], cursor: { e: 100, j: 50, a3: 900 } })
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([
      { s: 'e', o: 140, r: rec(1) },
      { s: 'j', o: 60, r: { type: 'result' } },
      { s: 'a3', o: 950, r: { type: 'text' } },
    ], 'v1;e=140;j=60;a3=950')

    // A server that restarted and forgot: the events stream replays from zero with no
    // reset frame. Ambiguity resolves to reset (§5.6.2's H17 rule) — for `e` alone.
    MockEventSource.last.drop()
    MockEventSource.last.reconnect()
    MockEventSource.last.batch([
      { s: 'e', o: 20, r: rec(1) },
      { s: 'j', o: 90, r: { type: 'result' } },
    ], 'v1;e=20;j=90')

    expect(seen.resets).toEqual(['e'])
    expect(client.stats.inferredResets).toBe(1)
    // `j` kept going forward and was NOT reset — per stream, never vector-wide (Sol-9).
    expect(seen.batches[1]!.map((f) => f.s)).toEqual(['e', 'j'])
    expect(client.cursor.j).toBe(90)
  })

  it('does not fire the fail-safe for a stream opened at `tail`', () => {
    // `tail` is not an offset, so "at-or-behind" is not a question that can be asked.
    const { client, seen } = harness({ agents: [5] })
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'a5', o: 10, r: { type: 'text' } }], 'v1;a5=10')
    expect(seen.resets).toEqual([])
    expect(client.cursor.a5).toBe(10)
  })
})

describe('the latch (parity #100–#102)', () => {
  it('sys/end closes the stream and schedules no reconnect (quiet close, #100)', () => {
    const { client, seen } = harness()
    client.open()
    MockEventSource.last.open()
    const es = MockEventSource.last
    MockEventSource.last.sys({ type: 'end' }, 'v1;e=140;j=50')

    expect(client.status).toBe('ended')
    expect(es.closedByClient).toBe(true)
    expect(seen.sys.map((s) => s.type)).toEqual(['end'])
    vi.advanceTimersByTime(600_000)
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('sys/gone latches too, and the run’s disappearance is reported once', () => {
    const { client, seen } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'gone' })
    expect(client.status).toBe('gone')
    expect(seen.sys.map((s) => s.type)).toEqual(['gone'])
    vi.advanceTimersByTime(600_000)
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('silence is never staleness: ten quiet minutes change nothing (#102)', () => {
    const { client, seen } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 140, r: rec(1) }], 'v1;e=140')
    vi.advanceTimersByTime(10 * 60_000)
    expect(client.status).toBe('live')
    expect(seen.sys).toEqual([])
    expect(seen.statuses).toEqual(['connecting', 'live'])
  })

  it('an end the fold verdict declines is HELD, and the replay stays open', () => {
    // §9.3: "latch off the folded terminal state". The gate is the store's folded verdict;
    // while it says no, the connection is not touched — a premature or mistaken `end`
    // cannot sever a replay that is still arriving (parity #101).
    let terminal = false
    const { client, seen } = harness({ endGate: () => terminal })
    client.open()
    MockEventSource.last.open()
    const es = MockEventSource.last

    MockEventSource.last.sys({ type: 'end' }, 'v1;e=140;j=50')
    expect(client.status).toBe('live')
    expect(client.endPending).toBe(true)
    expect(es.closedByClient).toBe(false)
    expect(client.stats.deferredEnds).toBe(1)
    // The stream keeps delivering while the end waits — which is the whole point.
    MockEventSource.last.batch([{ s: 'e', o: 200, r: rec(2) }], 'v1;e=200;j=50')
    expect(seen.batches).toHaveLength(1)
    expect(client.status).toBe('live')

    // Re-asked after every fold, and still refused.
    client.settleEnd()
    expect(client.status).toBe('live')

    // The terminal event folds: NOW the quiet close happens, and only now.
    terminal = true
    client.settleEnd()
    expect(client.status).toBe('ended')
    expect(client.endPending).toBe(false)
    expect(es.closedByClient).toBe(true)
    vi.advanceTimersByTime(600_000)
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('settleEnd() is inert when no end is pending — a terminal fold does not close a live stream', () => {
    const { client } = harness({ endGate: () => true })
    client.open()
    MockEventSource.last.open()
    client.settleEnd()
    client.settleEnd()
    expect(client.status).toBe('live')
    expect(MockEventSource.last.closedByClient).toBe(false)
  })

  it('sys/gone latches regardless of the fold verdict — there is nothing left to wait for', () => {
    const { client } = harness({ endGate: () => false })
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'gone' })
    expect(client.status).toBe('gone')
    expect(client.endPending).toBe(false)
  })

  it('a held end does not survive a reopen — the re-armed stream starts clean', () => {
    const { client } = harness({ endGate: () => false })
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'end' })
    expect(client.endPending).toBe(true)
    client.reopen()
    expect(client.endPending).toBe(false)
    expect(client.status).toBe('connecting')
  })

  it('a sys/state frame is the only liveness verdict the client accepts (#102)', () => {
    const { seen, client } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'state', state: 'failed', detail: 'exited 1' })
    expect(seen.sys).toEqual([{ type: 'state', state: 'failed', detail: 'exited 1' }])
    // …and it does NOT close the stream: only sys/end does that.
    expect(client.status).toBe('live')
  })
})

describe('resumed-run re-arm (parity #99, #118)', () => {
  it('reopen() builds a FRESH url from the current cursor, carrying no stale header', () => {
    const { client, seen } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 900, r: rec(1) }], 'v1;e=900;j=700')
    MockEventSource.last.sys({ type: 'end' })
    expect(client.status).toBe('ended')

    // The poll noticed the run is alive again.
    client.reopen()
    expect(MockEventSource.instances).toHaveLength(2)
    expect(MockEventSource.connections.every((c) => !c.native)).toBe(true)
    const url = new URL(MockEventSource.last.url, 'http://x')
    // Resumes exactly where the closed stream stopped — no replay, no gap.
    expect(url.searchParams.get('cursor')).toBe('v1;e=900;j=700')

    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 1000, r: rec(2) }], 'v1;e=1000;j=700')
    expect(client.status).toBe('live')
    expect(seen.resets).toEqual([])
    expect(seen.batches.flat().map((f) => f.o)).toEqual([900, 1000])
  })

  it('changing the agent set is a reopen, and a dropped transcript loses its cursor', () => {
    const { client } = harness({ agents: [3] })
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'a3', o: 500, r: { type: 'text' } }], 'v1;e=100;j=50;a3=500')

    client.reopen({ agents: [7] })
    const url = new URL(MockEventSource.last.url, 'http://x')
    expect(url.searchParams.get('agents')).toBe('7')
    // a3 is gone — re-adding it later must open at `tail`, not replay a discarded window.
    expect(url.searchParams.get('cursor')).toBe('v1;e=100;j=50;a7=tail')
    expect(client.cursor.a3).toBeUndefined()
  })
})

describe('fatal errors are the client’s to retry', () => {
  it('backs off exponentially when the browser gives up, and stops once latched', () => {
    const { client } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.fail()
    expect(client.status).toBe('reconnecting')
    expect(MockEventSource.instances).toHaveLength(1)

    vi.advanceTimersByTime(999)
    expect(MockEventSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(MockEventSource.instances).toHaveLength(2)

    MockEventSource.last.fail()
    vi.advanceTimersByTime(1999)
    expect(MockEventSource.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(MockEventSource.instances).toHaveLength(3)

    // A successful open resets the backoff.
    MockEventSource.last.open()
    MockEventSource.last.fail()
    vi.advanceTimersByTime(1000)
    expect(MockEventSource.instances).toHaveLength(4)

    client.close()
    vi.advanceTimersByTime(600_000)
    expect(MockEventSource.instances).toHaveLength(4)
    expect(client.status).toBe('closed')
  })

  it('a retry re-arms replay detection, so a restarted server is caught', () => {
    const { client, seen } = harness()
    client.open()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 400, r: rec(1) }], 'v1;e=400;j=50')
    MockEventSource.last.fail()
    vi.advanceTimersByTime(1000)
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 40, r: rec(1) }], 'v1;e=40')
    expect(seen.resets).toEqual(['e'])
  })
})
