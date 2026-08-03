/**
 * The live composition — parity #118's actual subject: "the live composition (stream latch
 * × fold × status poll, including reconnect, resume, and deadman paths) is tested
 * behaviorally against a mock event source, not just via pure predicates".
 *
 * Parity #97–#104 are covered between this file and `api/sse.test.ts`; the rows that need
 * a poll to exist at all (#98, #99, #101) are here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api/client.js'
import type { RunDetail, RunState } from '../api/types.js'
import { deriveCaps, fold, materializeFold } from '../fold/index.js'
import { manualFrames } from '../lib/frames.js'
import { MockEventSource, MockEventSourceCtor } from '../lib/mockEventSource.js'
import { createRunStore, summarizeAgents } from './runStore.js'

const ENGINE = '0.2.0'

const offsetsFor = (events: Record<string, unknown>[]) =>
  events.reduce((n, rec) => n + JSON.stringify(rec).length + 1, 0)

/** A `RunDetail` shaped like `src/viewer/snapshot.js`'s, built from an event list. */
function detailFrom(events: Record<string, unknown>[], state: RunState = 'running'): RunDetail {
  let o = 0
  const raw = fold(null, events.map((rec) => ({ o: (o += JSON.stringify(rec).length + 1), rec })))
  const caps = deriveCaps(raw.run)
  const p = materializeFold(raw, state, caps)
  const run = (p.run ?? {}) as Record<string, unknown>
  return {
    runId: 'r1',
    name: (run.name as string) ?? null,
    workflowFile: '/tmp/wf.mjs',
    state,
    liveDetail: null,
    createdAt: 1,
    startedAt: (run.startedAt as number) ?? null,
    endedAt: (run.endedAt as number) ?? null,
    agentCounts: summarizeAgents(p.agents),
    adapters: [...new Set(p.agents.map((a) => a.adapter))],
    spend: null,
    budgetTotal: null,
    openQuestions: p.openQuestions,
    resumeCount: p.resumeCount,
    hasRunLog: false,
    defaults: null,
    hasArgs: false,
    engine: (run.engine as string) ?? null,
    concurrency: null,
    declaredPhases: null,
    phases: p.phases,
    agents: p.agents,
    questions: p.questions,
    mail: p.mail,
    mailTotal: p.mail.length,
    logs: p.logs,
    logTotal: p.logs.length,
    structure: p.structure,
    saturation: p.saturation,
    offsets: { events: p.lastOffset, journal: 0 },
    caps: p.caps,
    attemptSpans: p.attemptSpans,
    attemptScopes: p.attemptScopes.map((s) => ({
      phases: s.phases, mail: s.mail, mailTotal: s.mail.length, logs: s.logs, logTotal: s.logs.length,
    })),
    unknownEvents: p.unknownEvents,
  }
}

const SEED_EVENTS = [
  { t: 1, type: 'run', state: 'started', engine: ENGINE, name: 'demo' },
  { t: 2, type: 'agent', index: 0, key: 'k0', adapter: 'mock', state: 'running' },
]

/**
 * The store's clock is the manual scheduler's, so a `flush()` is a frame AND the 16.67 ms
 * that P5's commit floor measures. Without that pairing a test could flush a thousand
 * frames inside one simulated instant and never learn what the commit RATE is.
 */
function setup(options: {
  details?: RunDetail[]
  agents?: number[]
  frameMs?: number
  onAgentRecords?: (index: number, records: { o: number; rec: Record<string, unknown> }[]) => void
  onAgentReset?: (index: number) => void
} = {}) {
  const queue = options.details ?? [detailFrom(SEED_EVENTS)]
  const calls: number[] = []
  const frames = manualFrames(options.frameMs ? { frameMs: options.frameMs } : {})
  const api = {
    runDetail: async () => {
      calls.push(calls.length)
      return queue[Math.min(calls.length - 1, queue.length - 1)]!
    },
  }
  const handle = createRunStore({
    runId: 'r1',
    api,
    agents: options.agents ?? [],
    frames: frames.schedule,
    now: frames.now,
    EventSourceImpl: MockEventSourceCtor,
    ...(options.onAgentRecords ? { onAgentRecords: options.onAgentRecords } : {}),
    ...(options.onAgentReset ? { onAgentReset: options.onAgentReset } : {}),
  })
  return { handle, frames, api, calls }
}

const nextOffset = (base: number, rec: Record<string, unknown>) => base + JSON.stringify(rec).length + 1

beforeEach(() => {
  MockEventSource.reset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('snapshot-then-tail (§9.3)', () => {
  it('seeds the fold from the snapshot and opens the stream at its offsets', async () => {
    const { handle, frames } = setup()
    await handle.start()

    const snap = handle.store.getSnapshot()
    expect(snap.loading).toBe(false)
    expect(snap.detail!.agents).toHaveLength(1)
    expect(snap.connection).toBe('polling')   // the stream has not opened yet

    const url = new URL(MockEventSource.last.url, 'http://x')
    expect(url.searchParams.get('cursor')).toBe(`v1;e=${offsetsFor(SEED_EVENTS)};j=0`)
    expect(url.searchParams.get('streams')).toBe('events,journal')

    MockEventSource.last.open()
    frames.flush()   // the connection chip is a commit like any other (P5's floor)
    expect(handle.store.getSnapshot().connection).toBe('live')
    handle.stop()
  })

  it('folds streamed events onto the seed without refetching', async () => {
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    let o = offsetsFor(SEED_EVENTS)
    const done = { t: 3, type: 'agent', index: 0, state: 'done', durationMs: 12 }
    o = nextOffset(o, done)
    MockEventSource.last.batch([{ s: 'e', o, r: done }], `v1;e=${o};j=0`)

    // Nothing has committed yet — the batch is waiting for a frame (parity #104).
    expect(handle.store.getSnapshot().detail!.agents[0]!.state).toBe('running')
    frames.flush()
    const agent = handle.store.getSnapshot().detail!.agents[0]!
    expect(agent.state).toBe('done')
    expect(agent.durationMs).toBe(12)
    expect(handle.store.getSnapshot().detail!.offsets.events).toBe(o)
    handle.stop()
  })

  it('joins streamed journal records onto the snapshot’s join', async () => {
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.batch([
      { s: 'j', o: 90, r: { type: 'result', key: 'k0', index: 0, usage: { input: 4, output: 5, cost: 0.5 }, durationMs: 60, result: 'ok' } },
      { s: 'j', o: 140, r: { type: 'session', key: 'k0', sessionId: 'sess' } },
    ], 'v1;e=0;j=140')
    frames.flush()
    const agent = handle.store.getSnapshot().detail!.agents[0]!
    expect(agent.attempts).toBe(1)
    expect(agent.usage).toEqual({ input: 4, output: 5, cost: 0.5 })
    expect(agent.sessionId).toBe('sess')
    expect(handle.store.getSnapshot().detail!.spend).toEqual({ input: 4, output: 5, cost: 0.5 })
    handle.stop()
  })
})

describe('P5 — live tail: ≤ 60 commits/s, zero dropped frames', () => {
  it('coalesces 5,000 records in one simulated second into ≤ 60 commits', async () => {
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    const before = handle.store.getSnapshot().commits

    let o = offsetsFor(SEED_EVENTS)
    let emitted = 0
    // 60 frames of a 5,000 records/s stream, delivered as several batches per frame — the
    // shape a real burst arrives in.
    for (let frame = 0; frame < 60; frame++) {
      for (let batch = 0; batch < 4; batch++) {
        const records = []
        for (let i = 0; i < 21 && emitted < 5000; i++) {
          const rec = { t: emitted, type: 'log', message: `line ${emitted}` }
          o = nextOffset(o, rec)
          records.push({ s: 'e', o, r: rec })
          emitted++
        }
        if (records.length) MockEventSource.last.batch(records, `v1;e=${o};j=0`)
      }
      frames.flush()
    }
    handle.flush()

    const snap = handle.store.getSnapshot()
    expect(emitted).toBe(5000)
    // Every record was folded: coalescing accumulates, it never samples.
    expect(snap.detail!.logTotal).toBe(5000)
    expect(snap.detail!.logs).toHaveLength(200)   // §5.4.3's bounded tail
    console.log(`P5 live tail: 5,000 records; ${snap.commits - before} store commits; zero dropped`)
    expect(snap.commits - before).toBeLessThanOrEqual(60)
    expect(snap.detail!.offsets.events).toBe(o)
    handle.stop()
  })

  it('many batches inside one frame produce exactly one commit', async () => {
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    const before = handle.store.getSnapshot().commits
    let o = offsetsFor(SEED_EVENTS)
    for (let i = 0; i < 50; i++) {
      const rec = { t: i, type: 'log', message: `x${i}` }
      o = nextOffset(o, rec)
      MockEventSource.last.batch([{ s: 'e', o, r: rec }], `v1;e=${o}`)
    }
    expect(frames.pending).toBe(1)
    frames.flush()
    expect(handle.store.getSnapshot().commits - before).toBe(1)
    handle.stop()
  })

  /**
   * The measurable version of the budget. The earlier form of this test flushed exactly 60
   * frames against a frozen clock and asserted "≤ 60 commits", which is the same statement
   * twice: it could not fail however fast the display drove frames. This one runs a REAL
   * simulated second on a 120 Hz and a 144 Hz display, adds the unscheduled status/reset
   * traffic that also publishes, and asserts a rate.
   */
  for (const hz of [120, 144]) {
    it(`5,000 records + a signal per frame at ${hz} Hz: all retained, ≤ 60 commits/s`, async () => {
      const { handle, frames } = setup({ frameMs: 1000 / hz })
      await handle.start()
      MockEventSource.last.open()
      const before = handle.store.getSnapshot().commits

      let o = offsetsFor(SEED_EVENTS)
      let emitted = 0
      const perFrame = Math.ceil(5000 / hz)
      for (let frame = 0; frame < hz; frame++) {
        const records = []
        for (let i = 0; i < perFrame && emitted < 5000; i++) {
          const rec = { t: emitted, type: 'log', message: `line ${emitted}` }
          o = nextOffset(o, rec)
          records.push({ s: 'e', o, r: rec })
          emitted++
        }
        if (records.length) MockEventSource.last.batch(records, `v1;e=${o};j=0`)
        // Every one of these takes the `touchNow` door, which used to publish unbounded.
        MockEventSource.last.sys({ type: 'state', state: 'running' })
        MockEventSource.last.sys({ type: 'note', message: 'skipped an oversize record' })
        frames.flush()
      }
      handle.flush()

      const snap = handle.store.getSnapshot()
      expect(frames.now()).toBeCloseTo(1000, 6)
      expect(emitted).toBe(5000)
      // Zero dropped frames: every record folded, however few commits carried them.
      expect(snap.detail!.logTotal).toBe(5000)
      expect(snap.detail!.offsets.events).toBe(o)
      expect(snap.notes).toBe(hz)
      // …and the budget, measured over the second it is stated for.
      expect(snap.commits - before).toBeLessThanOrEqual(60)
      handle.stop()
    })
  }

  /**
   * P5 bounds what SUBSCRIBERS see, and `commits` is only a proxy for that — one that a
   * publication taking a different door does not increment. The status poll used to be
   * exactly that door: `store.update()` on both its success and its failure path notified
   * every subscriber without arming, counting or rate-limiting anything, so a poll landing
   * inside a saturated stream made the second's 61st notification while the counter still
   * read 60. This test therefore counts `subscribe` callbacks, and pins them EQUAL to the
   * counter so no future publication can slip past it either.
   */
  for (const hz of [120, 144]) {
    it(`${hz} Hz + two polls in the second: ≤ 60 real subscriber notifications`, async () => {
      const detail = detailFrom(SEED_EVENTS)
      const frames = manualFrames({ frameMs: 1000 / hz })
      let polls = 0
      const handle = createRunStore({
        runId: 'r1',
        // One poll succeeds and one fails: BOTH used to publish outside the coalescer.
        api: {
          runDetail: async () => {
            // Call 1 is the snapshot; the polls are 2 and 3, and the last one fails so the
            // error path is what the final assertion reads.
            if (++polls >= 3) throw new ApiError(503, 'unavailable', 'busy')
            return detail
          },
        },
        pollMs: 400,
        frames: frames.schedule,
        now: frames.now,
        EventSourceImpl: MockEventSourceCtor,
      })
      await handle.start()
      MockEventSource.last.open()

      let notifications = 0
      const unsubscribe = handle.store.subscribe(() => { notifications++ })
      const before = handle.store.getSnapshot().commits

      let o = offsetsFor(SEED_EVENTS)
      let emitted = 0
      const perFrame = Math.ceil(5000 / hz)
      for (let frame = 0; frame < hz; frame++) {
        const records = []
        for (let i = 0; i < perFrame && emitted < 5000; i++) {
          const rec = { t: emitted, type: 'log', message: `line ${emitted}` }
          o = nextOffset(o, rec)
          records.push({ s: 'e', o, r: rec })
          emitted++
        }
        if (records.length) MockEventSource.last.batch(records, `v1;e=${o};j=0`)
        MockEventSource.last.sys({ type: 'state', state: 'running' })
        frames.flush()
        // The poll runs on its own (faked) clock, so it lands mid-second exactly as it
        // would in the browser: inside the burst, not between two of them.
        await vi.advanceTimersByTimeAsync(1000 / hz)
      }
      handle.flush()
      unsubscribe()

      const snap = handle.store.getSnapshot()
      expect(polls).toBeGreaterThanOrEqual(3)      // both poll paths were exercised
      expect(snap.error?.status).toBe(503)         // …including the failure one
      expect(frames.now()).toBeCloseTo(1000, 6)
      expect(snap.detail!.logTotal).toBe(5000)     // zero dropped frames, still
      expect(notifications).toBeLessThanOrEqual(60)
      // Every notification came through the counted, rate-limited door.
      expect(notifications).toBe(snap.commits - before)
      handle.stop()
    })
  }
})

/**
 * §6.2's run metadata is the RUN EVENT's (src/engine.js:1281–1294); the snapshot carries
 * whatever was knowable before it landed. A cockpit opened between `createdAt` and the
 * `started` emit has only `fallbackName(workflowFile)` (snapshot.js:297) — and, because the
 * poll never reseeds a live run, that placeholder used to be permanent.
 */
describe('canonical run metadata (§6.2)', () => {
  it('a run event landing after the snapshot replaces the fallback name', async () => {
    const pre = detailFrom([])                 // opened before the `started` emit: no run event
    expect(Object.values(pre.caps).every((c) => c === 'pending')).toBe(true)
    pre.name = 'wf'                            // fallbackName('/tmp/wf.mjs')
    const { handle, frames } = setup({ details: [pre] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()
    expect(handle.store.getSnapshot().detail!.name).toBe('wf')

    const started = {
      t: 5, type: 'run', state: 'started', engine: ENGINE, name: 'custom',
      workflowFile: '/abs/custom.mjs', file: 'custom.mjs',
    }
    MockEventSource.last.batch([{ s: 'e', o: nextOffset(0, started), r: started }], 'v1;e=99')
    frames.flush()

    const detail = handle.store.getSnapshot().detail!
    expect(detail.name).toBe('custom')
    expect(detail.startedAt).toBe(5)
    expect(detail.engine).toBe(ENGINE)
    // The event's own absolute path (engine.js:1287) is the same value journal meta would
    // carry, and it outranks both the snapshot's answer and the basename at :1285.
    expect(detail.workflowFile).toBe('/abs/custom.mjs')
    handle.stop()
  })

  it('a snapshot with no meta either takes both from the run event', async () => {
    const pre = detailFrom([])
    pre.name = null
    pre.workflowFile = null as unknown as string
    const { handle, frames } = setup({ details: [pre] })
    await handle.start()
    MockEventSource.last.open()

    const started = { t: 5, type: 'run', state: 'started', engine: ENGINE, name: 'custom', file: 'custom.mjs' }
    MockEventSource.last.batch([{ s: 'e', o: nextOffset(0, started), r: started }], 'v1;e=99')
    frames.flush()

    const detail = handle.store.getSnapshot().detail!
    expect(detail.name).toBe('custom')
    // No `workflowFile` on this (pre-E3) event, so the basename is the best answer there is.
    expect(detail.workflowFile).toBe('custom.mjs')
    handle.stop()
  })

  it('a run event that omits a field falls back to the snapshot rather than blanking it', async () => {
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    // A terse terminal run event: §6.4 step 1's "later terse events don't erase them".
    const done = { t: 9, type: 'run', state: 'completed' }
    MockEventSource.last.batch([{ s: 'e', o: nextOffset(offsetsFor(SEED_EVENTS), done), r: done }], 'v1;e=99')
    frames.flush()

    const detail = handle.store.getSnapshot().detail!
    expect(detail.name).toBe('demo')
    expect(detail.workflowFile).toBe('/tmp/wf.mjs')
    expect(detail.engine).toBe(ENGINE)
    handle.stop()
  })
})

/**
 * §5.4.3: `logs` and `mail` are BOUNDED TAILS — "the most recent 200 of each plus
 * `logTotal`/`mailTotal` counts". The seeded fold therefore holds a tail, not a history,
 * and `projected.mail.length` is not the total. An earlier revision published the array
 * length, so a run with 5,000 prior logs read `logTotal: 200` the moment this store took
 * over, and every earlier attempt scope lost its counts the same way.
 */
describe('bounded-history totals (§5.4.3)', () => {
  const RESUMED_EVENTS = [
    { t: 1, type: 'run', state: 'started', engine: ENGINE, name: 'demo' },
    { t: 2, type: 'log', message: 'attempt one' },
    { t: 3, type: 'mail', dir: 'out', agent: 0, message: 'hello one' },
    { t: 4, type: 'run', state: 'failed' },
    { t: 5, type: 'run', state: 'resumed' },
    { t: 6, type: 'log', message: 'attempt two' },
    { t: 7, type: 'mail', dir: 'out', agent: 0, message: 'hello two' },
  ]

  /** A snapshot of a long run: a 200-record tail per scope, real counts alongside. */
  function truncated(): RunDetail {
    const detail = detailFrom(RESUMED_EVENTS, 'running')
    expect(detail.attemptScopes).toHaveLength(2)
    detail.attemptScopes![0]!.mailTotal = 1200
    detail.attemptScopes![0]!.logTotal = 3000
    detail.attemptScopes![1]!.mailTotal = 900
    detail.attemptScopes![1]!.logTotal = 5000
    detail.mailTotal = 900
    detail.logTotal = 5000
    return detail
  }

  it('keeps the snapshot’s totals and grows them by exactly what streams in', async () => {
    const { handle, frames } = setup({ details: [truncated()] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()

    // Before a single streamed record: the counts survived the handover unchanged.
    let snap = handle.store.getSnapshot()
    expect(snap.detail!.logTotal).toBe(5000)
    expect(snap.detail!.mailTotal).toBe(900)
    expect(snap.detail!.attemptScopes![0]!.logTotal).toBe(3000)
    expect(snap.detail!.attemptScopes![0]!.mailTotal).toBe(1200)

    let o = offsetsFor(RESUMED_EVENTS)
    const streamed = [
      { t: 8, type: 'log', message: 'three' },
      { t: 9, type: 'log', message: 'four' },
      { t: 10, type: 'mail', dir: 'out', agent: 0, message: 'hello three' },
    ]
    MockEventSource.last.batch(streamed.map((rec) => ({ s: 'e', o: (o = nextOffset(o, rec)), r: rec })), `v1;e=${o}`)
    frames.flush()

    snap = handle.store.getSnapshot()
    expect(snap.detail!.logTotal).toBe(5002)
    expect(snap.detail!.mailTotal).toBe(901)
    // The current scope's counts and the top-level ones are the same numbers (§6.4 1a).
    expect(snap.detail!.attemptScopes![1]!.logTotal).toBe(5002)
    expect(snap.detail!.attemptScopes![1]!.mailTotal).toBe(901)
    // …and a historical scope is not disturbed by the current one growing.
    expect(snap.detail!.attemptScopes![0]!.logTotal).toBe(3000)
    expect(snap.detail!.attemptScopes![0]!.mailTotal).toBe(1200)
    handle.stop()
  })

  it('a scope opened after the handover counts its own records, with no base', async () => {
    const { handle, frames } = setup({ details: [truncated()] })
    await handle.start()
    MockEventSource.last.open()

    let o = offsetsFor(RESUMED_EVENTS)
    const streamed = [
      { t: 8, type: 'run', state: 'failed' },
      { t: 9, type: 'run', state: 'resumed' },
      { t: 10, type: 'log', message: 'third attempt' },
    ]
    MockEventSource.last.batch(streamed.map((rec) => ({ s: 'e', o: (o = nextOffset(o, rec)), r: rec })), `v1;e=${o}`)
    frames.flush()

    const snap = handle.store.getSnapshot()
    expect(snap.detail!.attemptScopes).toHaveLength(3)
    expect(snap.detail!.logTotal).toBe(1)              // the new scope, not 5001
    expect(snap.detail!.attemptScopes![1]!.logTotal).toBe(5000)   // the old one, intact
    handle.stop()
  })

  it('the tail stays bounded at 200 while the totals keep climbing', async () => {
    const { handle } = setup({ details: [truncated()] })
    await handle.start()
    MockEventSource.last.open()
    let o = offsetsFor(RESUMED_EVENTS)
    for (let i = 0; i < 300; i++) {
      const rec = { t: 100 + i, type: 'log', message: `line ${i}` }
      o = nextOffset(o, rec)
      MockEventSource.last.batch([{ s: 'e', o, r: rec }], `v1;e=${o}`)
    }
    handle.flush()
    const snap = handle.store.getSnapshot()
    expect(snap.detail!.logs).toHaveLength(200)
    expect(snap.detail!.logTotal).toBe(5300)
    handle.stop()
  })

  it('an events reset drops the seeded base with the fold it described', async () => {
    const { handle, frames } = setup({ details: [truncated()] })
    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'reset', stream: 'e' })

    let o = 0
    const replay = RESUMED_EVENTS.map((rec) => ({ s: 'e', o: (o += JSON.stringify(rec).length + 1), r: rec }))
    MockEventSource.last.batch(replay, `v1;e=${o}`)
    frames.flush()

    const snap = handle.store.getSnapshot()
    // The replay IS the whole file now, so the arrays are the history: 1 log per scope.
    expect(snap.detail!.logTotal).toBe(1)
    expect(snap.detail!.attemptScopes![0]!.logTotal).toBe(1)
    handle.stop()
  })
})

describe('the latch (parity #98–#102)', () => {
  it('a terminal POLL verdict mid-replay does not sever the stream (#101)', async () => {
    const seed = detailFrom(SEED_EVENTS)
    // The poll answers `completed` while events are still replaying — the result landed
    // before the transcript did.
    const { handle, frames } = setup({ details: [seed, { ...seed, state: 'completed' }] })
    await handle.start()
    MockEventSource.last.open()

    await vi.advanceTimersByTimeAsync(10_000)
    frames.flush()
    expect(handle.store.getSnapshot().runState).toBe('completed')
    // Not severed, not closed, still one connection.
    expect(handle.store.getSnapshot().connection).toBe('live')
    expect(MockEventSource.last.closedByClient).toBe(false)

    // …and the replay still lands and still folds.
    let o = offsetsFor(SEED_EVENTS)
    const rec = { t: 3, type: 'agent', index: 1, key: 'k1', adapter: 'mock', state: 'done' }
    o = nextOffset(o, rec)
    MockEventSource.last.batch([{ s: 'e', o, r: rec }], `v1;e=${o}`)
    frames.flush()
    expect(handle.store.getSnapshot().detail!.agents).toHaveLength(2)
    handle.stop()
  })

  it('sys/end quiet-closes the stream but the 10 s status poll continues (#98, #100)', async () => {
    const terminal = detailFrom([...SEED_EVENTS, { t: 3, type: 'run', state: 'completed' }], 'completed')
    const { handle, calls, frames } = setup({ details: [terminal] })
    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'end' })
    // The fold IS terminal (the seed carried the completed run event), so the end latches
    // on arrival; only the resulting snapshot waits for a frame.
    expect(MockEventSource.last.closedByClient).toBe(true)
    frames.flush()
    expect(handle.store.getSnapshot().connection).toBe('ended')

    await vi.advanceTimersByTimeAsync(35_000)
    expect(calls.length).toBeGreaterThanOrEqual(4)   // 1 snapshot + 3 polls
    // A terminal run that stays terminal must not be re-opened on every poll.
    expect(MockEventSource.instances).toHaveLength(1)
    handle.stop()
  })

  /**
   * §9.3's rule 1 in full. The earlier implementation latched on ANY `sys/end`, so the
   * "latch off the folded terminal state" half of the sentence was untested and untrue:
   * the poll could not sever a replay, but a server's `end` could.
   */
  it('a sys/end while the fold is NON-terminal does not sever the replay (#101)', async () => {
    const seed = detailFrom(SEED_EVENTS)
    // The poll ALSO says the run is over — both dangerous inputs at once.
    const { handle, frames } = setup({ details: [seed, { ...seed, state: 'completed' }] })
    await handle.start()
    MockEventSource.last.open()
    const es = MockEventSource.last

    await vi.advanceTimersByTimeAsync(10_000)
    frames.flush()
    expect(handle.store.getSnapshot().runState).toBe('completed')

    // The server says the stream is complete, but our fold has no terminal run event yet.
    MockEventSource.last.sys({ type: 'end' })
    frames.flush()
    expect(es.closedByClient).toBe(false)
    expect(handle.store.getSnapshot().connection).toBe('live')
    expect(handle.stream!.endPending).toBe(true)

    // …and the replay that was still in flight lands, folds and renders.
    let o = offsetsFor(SEED_EVENTS)
    const late = { t: 3, type: 'agent', index: 1, key: 'k1', adapter: 'mock', state: 'done' }
    o = nextOffset(o, late)
    MockEventSource.last.batch([{ s: 'e', o, r: late }], `v1;e=${o}`)
    frames.flush()
    expect(handle.store.getSnapshot().detail!.agents).toHaveLength(2)
    expect(handle.store.getSnapshot().connection).toBe('live')

    // The terminal run event folds — and THAT is what quiet-closes the stream.
    const finish = { t: 4, type: 'run', state: 'completed' }
    o = nextOffset(o, finish)
    MockEventSource.last.batch([{ s: 'e', o, r: finish }], `v1;e=${o}`)
    frames.flush()
    expect(es.closedByClient).toBe(true)
    expect(handle.store.getSnapshot().connection).toBe('ended')
    expect(handle.store.getSnapshot().detail!.agents).toHaveLength(2)
    handle.stop()
  })

  it('the held end latches on the frame that folds the terminal event, in one batch', async () => {
    // The same rule when the terminal event rides in the very batch after the end: the
    // gate folds what is already in hand before answering, so this closes on that frame
    // rather than waiting for another one.
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    const es = MockEventSource.last

    let o = offsetsFor(SEED_EVENTS)
    const finish = { t: 9, type: 'run', state: 'failed', error: 'boom' }
    o = nextOffset(o, finish)
    MockEventSource.last.batch([{ s: 'e', o, r: finish }], `v1;e=${o}`)
    // The end arrives before the frame that folds the batch — the gate must not be fooled.
    MockEventSource.last.sys({ type: 'end' })
    expect(es.closedByClient).toBe(true)
    frames.flush()
    expect(handle.store.getSnapshot().connection).toBe('ended')
    expect(handle.store.getSnapshot().detail!.endedAt).toBe(9)
    handle.stop()
  })

  it('never invents staleness from silence (#102)', async () => {
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    frames.flush()
    expect(handle.store.getSnapshot().connection).toBe('live')
    expect(handle.store.getSnapshot().runState).toBe('running')
    handle.stop()
  })

  it('a sys/state frame is a display verdict, not a close signal', async () => {
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'state', state: 'failed', detail: 'exit 1' })
    frames.flush()
    const snap = handle.store.getSnapshot()
    expect(snap.runState).toBe('failed')
    expect(snap.detail!.liveDetail).toBe('exit 1')
    expect(snap.connection).toBe('live')
    // …and a dead run's still-running agents render orphaned, never a spinner (#58).
    expect(snap.detail!.agents[0]!.displayState).toBe('orphaned')
    handle.stop()
  })

  it('sys/gone surfaces the deleted run', async () => {
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'gone' })
    frames.flush()
    expect(handle.store.getSnapshot().connection).toBe('gone')
    handle.stop()
  })
})

describe('resumed-run re-arm (parity #99, #118)', () => {
  it('a poll that finds the run alive again re-seeds and re-opens the stream', async () => {
    const terminal = detailFrom([...SEED_EVENTS, { t: 3, type: 'run', state: 'failed' }], 'failed')
    const resumedEvents = [...SEED_EVENTS,
      { t: 3, type: 'run', state: 'failed' },
      { t: 4, type: 'run', state: 'resumed' },
      { t: 5, type: 'agent', index: 1, key: 'k1', adapter: 'mock', state: 'running' },
    ]
    const resumed = detailFrom(resumedEvents, 'running')
    const { handle, frames } = setup({ details: [terminal, terminal, resumed] })

    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'end' })
    frames.flush()
    expect(handle.store.getSnapshot().connection).toBe('ended')

    // Poll 1: still dead. No reopen.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(MockEventSource.instances).toHaveLength(1)

    // Poll 2: resumed. The page re-arms with no reload.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(MockEventSource.instances).toHaveLength(2)
    const url = new URL(MockEventSource.last.url, 'http://x')
    expect(url.searchParams.get('cursor')).toBe(`v1;e=${resumed.offsets.events};j=0`)

    MockEventSource.last.open()
    frames.flush()
    const snap = handle.store.getSnapshot()
    expect(snap.connection).toBe('live')
    expect(snap.runState).toBe('running')
    expect(snap.detail!.agents).toHaveLength(2)
    expect(snap.detail!.resumeCount).toBe(1)
    // The latch cleared: a resumed run is live again, not a corpse with an endedAt.
    expect(snap.detail!.endedAt).toBeNull()
    handle.stop()
  })

  /**
   * **M2.** `refresh()` — the resume button's optimistic follow-up — and the scheduled 10 s
   * poll are two requests for the same resource, and the network does not answer in the
   * order it was asked. Neither single-flighting nor a request generation existed, so the
   * older answer simply wrote last: a `completed` response landing after a `running` one
   * had already re-seeded and re-opened the stream put `runState` back to `completed`,
   * which re-renders every live agent as `orphaned` (§6.4 step 8) on a run that is
   * demonstrably alive with a stream folding underneath it.
   *
   * The fake API deliberately IGNORES the abort signal, because that is the point of the
   * finding: `abort()` cannot un-resolve a response already on its way back, so aborting
   * the superseded request is housekeeping and the epoch is what actually holds the line.
   * The second half below is the case abort cannot reach even in principle — a superseded
   * request that FAILS, whose rejection is a plain 503 rather than an `AbortError`.
   */
  it('an out-of-order poll response cannot revert a resumed run (M2)', async () => {
    const terminal = detailFrom([...SEED_EVENTS, { t: 3, type: 'run', state: 'completed' }], 'completed')
    const resumed = detailFrom([...SEED_EVENTS,
      { t: 3, type: 'run', state: 'completed' },
      { t: 4, type: 'run', state: 'resumed' },
      { t: 5, type: 'agent', index: 1, key: 'k1', adapter: 'mock', state: 'running' },
    ], 'running')

    const pending: { resolve(detail: RunDetail): void; reject(err: unknown): void }[] = []
    const frames = manualFrames()
    const handle = createRunStore({
      runId: 'r1',
      api: (() => {
        let call = 0
        return {
          runDetail: (_runId: string) => {
            // Call 1 is the initial snapshot and answers immediately; every later request
            // is parked so the test decides the completion order.
            if (++call === 1) return Promise.resolve(terminal)
            return new Promise<RunDetail>((resolve, reject) => { pending.push({ resolve, reject }) })
          },
        }
      })(),
      frames: frames.schedule,
      now: frames.now,
      EventSourceImpl: MockEventSourceCtor,
    })

    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'end' })
    frames.flush()
    expect(handle.store.getSnapshot().connection).toBe('ended')

    // Two polls in flight at once: the operator hit Resume while the 10 s poll was out.
    const older = handle.refresh()
    const newer = handle.refresh()
    expect(pending).toHaveLength(2)

    // The NEWER one answers first: the run is alive again, so the page re-seeds and the
    // stream re-opens (parity #99).
    pending[1]!.resolve(resumed)
    await newer
    frames.flush()
    expect(MockEventSource.instances).toHaveLength(2)
    expect(handle.store.getSnapshot().runState).toBe('running')

    // …and the older answer, describing a moment that is over, lands afterwards.
    pending[0]!.resolve(terminal)
    await older
    frames.flush()

    const snap = handle.store.getSnapshot()
    expect(snap.runState).toBe('running')
    expect(snap.detail!.state).toBe('running')
    expect(snap.detail!.resumeCount).toBe(1)
    expect(snap.detail!.agents).toHaveLength(2)
    // The living agent is not a corpse: `orphaned` is what a terminal run state would make
    // of it (§6.4 step 8), and that is the visible face of this bug.
    expect(snap.detail!.agents[1]!.displayState).toBe('running')
    expect(snap.detail!.endedAt).toBeNull()
    // The stale answer did not re-open a third stream either.
    expect(MockEventSource.instances).toHaveLength(2)

    // **The half no abort can cover.** A superseded request that fails rejects with its own
    // transport error, not an `AbortError`, so "was I aborted?" cannot classify it — and a
    // 503 from a request two answers out of date must not paint a banner over a cockpit
    // that a newer, successful response has already refreshed.
    const stale = handle.refresh()
    const fresh = handle.refresh()
    pending[3]!.resolve(resumed)
    await fresh
    pending[2]!.reject(new ApiError(503, 'unavailable', 'busy'))
    await stale
    frames.flush()
    expect(handle.store.getSnapshot().error).toBeNull()
    expect(handle.store.getSnapshot().runState).toBe('running')
    handle.stop()
  })

  it('re-arms on growth past the cursor even when the state still reads terminal', async () => {
    // A replay of a completed run (§7.3) can be observed by bytes before it is observed by
    // state; #118 must not depend on catching the live window.
    const terminal = detailFrom([...SEED_EVENTS, { t: 3, type: 'run', state: 'completed' }], 'completed')
    const grown = detailFrom([...SEED_EVENTS,
      { t: 3, type: 'run', state: 'completed' },
      { t: 4, type: 'agent', index: 1, key: 'k1', adapter: 'mock', state: 'done' },
    ], 'completed')
    const { handle } = setup({ details: [terminal, grown] })
    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'end' })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(MockEventSource.instances).toHaveLength(2)
    handle.stop()
  })
})

describe('per-stream resets (§9.4)', () => {
  it('sys/reset on the events stream drops the fold and rebuilds it from the replay', async () => {
    const { handle, frames } = setup()
    await handle.start()
    MockEventSource.last.open()
    expect(handle.store.getSnapshot().detail!.agents).toHaveLength(1)

    MockEventSource.last.sys({ type: 'reset', stream: 'e' })
    frames.flush()
    expect(handle.store.getSnapshot().detail!.agents).toHaveLength(0)

    let o = 0
    const replay = SEED_EVENTS.map((rec) => ({ s: 'e', o: (o += JSON.stringify(rec).length + 1), r: rec }))
    MockEventSource.last.batch(replay, `v1;e=${o}`)
    frames.flush()
    expect(handle.store.getSnapshot().detail!.agents).toHaveLength(1)
    handle.stop()
  })

  /**
   * A journal reset means the file the join describes is gone (§5.6.4). EVERY journal
   * projection has to go with it — the per-agent facts, the aggregate spend, the delta —
   * or the pane reports a rotated-away file's numbers forever, and a replacement journal
   * replayed from 0 gets ADDED to them. An earlier revision cleared only the base map and
   * the delta, leaving `spend` seeded from the snapshot and `usage`/`durationMs`/
   * `resultPreview`/`liveTokens` sitting inside the fold.
   */
  const withJournalFacts = (): RunDetail => {
    const detail = detailFrom(SEED_EVENTS)
    detail.spend = { input: 100, output: 200, cost: 1.5 }
    Object.assign(detail.agents[0]!, {
      attempts: 3,
      usage: { input: 100, output: 200, cost: 1.5 },
      attemptUsage: { input: 10, output: 20, cost: 0.5 },
      durationMs: 9000,
      resultPreview: 'stale preview',
      resultBytes: 4096,
      resultTruncated: true,
      sessionId: 'stale-session',
      liveTokens: { input: 7, output: 8 },
    })
    return detail
  }

  it('the snapshot’s journal facts survive seeding intact (the strip is not a loss)', async () => {
    const { handle, frames } = setup({ details: [withJournalFacts()] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()
    const agent = handle.store.getSnapshot().detail!.agents[0]!
    expect(agent.sessionId).toBe('stale-session')
    expect(agent.attempts).toBe(3)
    expect(agent.usage).toEqual({ input: 100, output: 200, cost: 1.5 })
    expect(agent.durationMs).toBe(9000)
    expect(agent.resultPreview).toBe('stale preview')
    expect(agent.liveTokens).toEqual({ input: 7, output: 8 })
    expect(handle.store.getSnapshot().detail!.spend).toEqual({ input: 100, output: 200, cost: 1.5 })
    handle.stop()
  })

  it('an EMPTY replacement journal reports nothing, not the rotated file’s numbers', async () => {
    const { handle, frames } = setup({ details: [withJournalFacts()] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()

    MockEventSource.last.sys({ type: 'reset', stream: 'j' })
    frames.flush()
    const snap = handle.store.getSnapshot()
    const agent = snap.detail!.agents[0]!

    // Every journal-derived field, cleared.
    expect(agent.sessionId).toBeNull()
    expect(agent.attempts).toBe(0)
    expect(agent.usage).toBeNull()
    expect(agent.attemptUsage).toBeNull()
    expect(agent.durationMs).toBeNull()
    expect(agent.resultPreview).toBeNull()
    expect(agent.resultBytes).toBeNull()
    expect(agent.resultTruncated).toBe(false)
    expect(agent.liveTokens).toBeNull()
    expect(snap.detail!.spend).toBeNull()

    // …and the event fold is untouched: the two streams reset independently (§9.4).
    expect(snap.detail!.agents).toHaveLength(1)
    expect(agent.state).toBe('running')
    expect(agent.adapter).toBe('mock')
    expect(snap.detail!.name).toBe('demo')
    handle.stop()
  })

  it('a replayed replacement journal counts exactly once — never added to the old file', async () => {
    const { handle, frames } = setup({ details: [withJournalFacts()] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()

    MockEventSource.last.sys({ type: 'reset', stream: 'j' })
    // §5.6.2 rule 3: the replacement is delivered from 0 immediately after the reset.
    MockEventSource.last.batch([
      { s: 'j', o: 90, r: { type: 'result', key: 'k0', index: 0, usage: { input: 4, output: 5, cost: 0.5 }, durationMs: 60, result: 'fresh' } },
      { s: 'j', o: 140, r: { type: 'session', key: 'k0', sessionId: 'fresh-session' } },
      { s: 'j', o: 190, r: { type: 'usage-cum', key: 'k0', cum: { input: 1, output: 2 } } },
    ], 'v1;e=0;j=190')
    frames.flush()

    const snap = handle.store.getSnapshot()
    const agent = snap.detail!.agents[0]!
    expect(agent.attempts).toBe(1)                                      // not 3 + 1
    expect(agent.usage).toEqual({ input: 4, output: 5, cost: 0.5 })     // not 104/205/2.0
    expect(agent.durationMs).toBe(60)
    expect(agent.sessionId).toBe('fresh-session')
    expect(agent.resultPreview).toBe('"fresh"')
    expect(agent.liveTokens).toEqual({ input: 1, output: 2 })
    expect(snap.detail!.spend).toEqual({ input: 4, output: 5, cost: 0.5 })
    handle.stop()
  })

  /**
   * The agent facts were only ever half of it. §6.4 J also supplies pre-E7 question
   * answers, mail origin/callsite, the two-hop `approximate` flag and the `skipped`
   * delivery verdict — every one of them a projection of the file the reset says is gone.
   * An earlier revision seeded them straight into the fold, where a journal reset could not
   * reach them, so an emptied replacement journal kept reporting a question as answered and
   * a mail as operator-sent forever.
   */
  const legacyDetail = (): RunDetail => {
    const detail = detailFrom([
      { t: 1, type: 'run', state: 'started' },          // no `engine` → pre-E1..E12
      { t: 2, type: 'agent', index: 0, adapter: 'mock', state: 'done' },   // …and no `key`
      { t: 3, type: 'question', qid: 'q1', question: 'go?' },
      { t: 4, type: 'mail', dir: 'in', agent: 0, message: 'hi' },
    ])
    expect(detail.caps.progress).toBe('unsupported')
    expect(detail.agents[0]!.key).toBeNull()
    // What `joinJournal` writes onto that projection (snapshot.js:76, :103–106, :144–146).
    Object.assign(detail.agents[0]!, { attempts: 2, durationMs: 500, sessionId: 'legacy-sess' })
    Object.assign(detail.questions[0]!, { answered: true, answer: 'yes', abandoned: false })
    for (const mail of [detail.mail[0]!, detail.attemptScopes![0]!.mail[0]!]) {
      Object.assign(mail, { origin: 'operator', callsite: 'cli', approximate: true })
    }
    detail.openQuestions = 0
    return detail
  }

  it('the legacy join survives seeding: answers, mail origin and a keyless agent', async () => {
    const { handle, frames } = setup({ details: [legacyDetail()] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()
    const detail = handle.store.getSnapshot().detail!
    expect(detail.questions[0]!.answered).toBe(true)
    expect(detail.questions[0]!.answer).toBe('yes')
    expect(detail.mail[0]!.origin).toBe('operator')
    expect(detail.mail[0]!.callsite).toBe('cli')
    expect((detail.mail[0] as { approximate?: boolean }).approximate).toBe(true)
    expect(detail.agents[0]!.sessionId).toBe('legacy-sess')
    expect(detail.agents[0]!.attempts).toBe(2)
    expect(detail.agents[0]!.durationMs).toBe(500)
    expect(detail.openQuestions).toBe(0)
    handle.stop()
  })

  it('an EMPTY replacement journal takes the answers, the mail origin and the keyless facts with it', async () => {
    const { handle, frames } = setup({ details: [legacyDetail()] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()

    MockEventSource.last.sys({ type: 'reset', stream: 'j' })
    frames.flush()
    const detail = handle.store.getSnapshot().detail!

    expect(detail.questions[0]!.answered).toBe(false)
    expect(detail.questions[0]!.answer).toBeNull()
    expect(detail.mail[0]!.origin).toBeNull()
    expect(detail.mail[0]!.callsite).toBeNull()
    expect((detail.mail[0] as { approximate?: boolean }).approximate).toBeUndefined()
    expect(detail.agents[0]!.sessionId).toBeNull()
    expect(detail.agents[0]!.attempts).toBe(0)
    expect(detail.agents[0]!.durationMs).toBeNull()

    // …and the events stream is untouched: the mail record, the question and the agent are
    // all still there, because only ONE stream reset (§9.4).
    expect(detail.mail).toHaveLength(1)
    expect(detail.mail[0]!.message).toBe('hi')
    expect(detail.questions[0]!.question).toBe('go?')
    expect(detail.agents[0]!.adapter).toBe('mock')
    // The question is open again — the run is live, so it is pending, not abandoned.
    expect(detail.openQuestions).toBe(1)
    handle.stop()
  })

  it('a replayed replacement journal rebuilds answers and mail from it alone', async () => {
    const { handle, frames } = setup({ details: [legacyDetail()] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()

    MockEventSource.last.sys({ type: 'reset', stream: 'j' })
    // §5.6.2 rule 3: the replacement is delivered from 0 right after the reset frame.
    MockEventSource.last.batch([
      { s: 'j', o: 40, r: { type: 'result', key: 'k-legacy', index: 0, status: 'ok', durationMs: 11 } },
      { s: 'j', o: 90, r: { type: 'answer', qid: 'q1', value: 'no' } },
      { s: 'j', o: 150, r: { t: 4, type: 'mail', key: 'k-legacy', text: 'hi', origin: 'workflow', callsite: 'wf.js:9' } },
    ], 'v1;e=0;j=150')
    frames.flush()

    const detail = handle.store.getSnapshot().detail!
    expect(detail.questions[0]!.answered).toBe(true)
    expect(detail.questions[0]!.answer).toBe('no')          // the new file's answer, not 'yes'
    expect(detail.mail[0]!.origin).toBe('workflow')          // not 'operator'
    expect(detail.mail[0]!.callsite).toBe('wf.js:9')
    expect((detail.mail[0] as { approximate?: boolean }).approximate).toBe(true)
    // The key→index hop from the replayed `result` record is what reaches a keyless agent.
    expect(detail.agents[0]!.durationMs).toBe(11)
    expect(detail.agents[0]!.attempts).toBe(1)               // not 2 + 1
    handle.stop()
  })

  it('an events reset does not disturb the journal projection, and vice versa', async () => {
    const { handle, frames } = setup({ details: [withJournalFacts()] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()

    MockEventSource.last.sys({ type: 'reset', stream: 'e' })
    frames.flush()
    // The fold is empty, so there is no agent to hang the facts on — but the spend, which
    // is run-scoped and journal-derived, is untouched.
    expect(handle.store.getSnapshot().detail!.agents).toHaveLength(0)
    expect(handle.store.getSnapshot().detail!.spend).toEqual({ input: 100, output: 200, cost: 1.5 })

    let o = 0
    const replay = SEED_EVENTS.map((rec) => ({ s: 'e', o: (o += JSON.stringify(rec).length + 1), r: rec }))
    MockEventSource.last.batch(replay, `v1;e=${o}`)
    frames.flush()
    expect(handle.store.getSnapshot().detail!.agents[0]!.sessionId).toBe('stale-session')
    handle.stop()
  })

  /**
   * **Steering provenance, with the producer's real shapes.**
   *
   * `emitSteered` (src/engine.js:653–660) emits state/delivery/mailId/phase/phaseIndex and
   * NO origin, for the control socket (:691) and the workflow handle (:1131, :1267) alike,
   * so `fold.js:235` reads `'operator'` for every steer that ever crosses the events
   * stream. `'workflow'` is a journal fact — `snapshot.js:123–129` joins it by `mailId` —
   * and therefore has to behave like every other one: reachable live from the stream,
   * re-applied after an events reset, and taken back by a journal reset.
   */
  const STEER_EVENTS = [
    { t: 1, type: 'run', state: 'started', engine: ENGINE, name: 'demo' },
    { t: 2, type: 'agent', index: 0, key: 'k0', adapter: 'mock', state: 'running' },
    { t: 3, type: 'agent', index: 0, state: 'steered', delivery: 'queued', mailId: 'm1' },
  ]

  it('a live workflow steer reads as workflow, and each reset moves only its own half', async () => {
    const detail = detailFrom(STEER_EVENTS)
    expect(detail.agents[0]!.steers[0]!.origin).toBe('operator')   // what the fold can know
    detail.agents[0]!.steers[0]!.origin = 'workflow'               // what the server joined
    const { handle, frames } = setup({ details: [detail] })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()
    const steers = () => handle.store.getSnapshot().detail!.agents[0]!.steers
    expect(steers()[0]!.origin).toBe('workflow')

    // A live `spawn()`/`sendTo()` steer: the event says nothing, the journal record does.
    let o = offsetsFor(STEER_EVENTS)
    const steered = { t: 5, type: 'agent', index: 0, state: 'steered', delivery: 'live', mailId: 'm2' }
    o = nextOffset(o, steered)
    MockEventSource.last.batch([{ s: 'e', o, r: steered }], `v1;e=${o};j=0`)
    frames.flush()
    expect(steers()[1]!.origin).toBe('operator')
    MockEventSource.last.batch([
      { s: 'j', o: 120, r: { type: 'mail', id: 'm2', key: 'k0', text: 'go left', origin: 'workflow' } },
    ], `v1;e=${o};j=120`)
    frames.flush()
    expect(steers().map((s) => s.origin)).toEqual(['workflow', 'workflow'])

    // An events reset re-folds every steer as `operator` — and the journal layer, which
    // this reset does not touch (§9.4), puts both verdicts straight back.
    MockEventSource.last.sys({ type: 'reset', stream: 'e' })
    let p = 0
    const replay = [...STEER_EVENTS, steered].map((rec) => ({ s: 'e', o: (p += JSON.stringify(rec).length + 1), r: rec }))
    MockEventSource.last.batch(replay, `v1;e=${p};j=120`)
    frames.flush()
    expect(steers().map((s) => s.origin)).toEqual(['workflow', 'workflow'])

    // A journal reset is the other half: the file both verdicts came from is gone, so the
    // event's own answer stands rather than a stale seeded one.
    MockEventSource.last.sys({ type: 'reset', stream: 'j' })
    frames.flush()
    expect(steers().map((s) => s.origin)).toEqual(['operator', 'operator'])
    expect(steers()).toHaveLength(2)   // …and the steers themselves are events, so they stay
    handle.stop()
  })

  it('sys/reset on an agent stream is forwarded to that pane and nothing else', async () => {
    const resets: number[] = []
    const { handle, frames } = setup({ agents: [3], onAgentReset: (i) => resets.push(i) })
    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.sys({ type: 'reset', stream: 'a3' })
    frames.flush()
    expect(resets).toEqual([3])
    expect(handle.store.getSnapshot().detail!.agents).toHaveLength(1)
    handle.stop()
  })

  /**
   * **B2.** `onAgentRecords` is a publication — a real `transcriptStore` appends and
   * notifies its own subscribers synchronously — so it belongs inside the frame with
   * everything else P5 counts (§9.3's "one door for every publication").
   *
   * It escaped through the end gate. `sys/end` asks the store for the FOLDED terminal
   * verdict (rule 1), which has to advance the fold over records that are in hand but not
   * yet on screen; the function that did that also flushed the pending transcript batch, so
   * an `end` arriving between frames delivered those records on the spot — ahead of the
   * commit meant to carry them, and outside the ≤60/s budget, on exactly the mixed batch a
   * run ends with. The gate needs the fold. It does not need the panes.
   */
  it('a sys/end folds without publishing: no transcript delivery outside the frame, ≤ 60 commits/s (B2)', async () => {
    const delivered: { index: number; count: number }[] = []
    const { handle, frames } = setup({
      agents: [3],
      onAgentRecords: (index, records) => delivered.push({ index, count: records.length }),
    })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()

    const notified: number[] = []
    const off = handle.store.subscribe(() => notified.push(handle.store.getSnapshot().commits))
    const before = handle.store.getSnapshot().commits
    const clockAt = frames.now()

    let o = offsetsFor(SEED_EVENTS)
    let ao = 0
    // A full simulated second of mixed traffic, with the server re-asserting the end on
    // every frame while our fold is still non-terminal (the held-end path, #101).
    for (let frame = 0; frame < 60; frame++) {
      const log = { t: frame, type: 'log', message: `line ${frame}` }
      o = nextOffset(o, log)
      MockEventSource.last.batch([
        { s: 'e', o, r: log },
        { s: 'a3', o: (ao += 10), r: { type: 'text', text: `t${frame}` } },
      ], `v1;e=${o};a3=${ao}`)
      MockEventSource.last.sys({ type: 'end' })
      // The gate ran and answered "not terminal" — and touched no pane doing it.
      expect(delivered).toHaveLength(frame)
      frames.flush()
      expect(delivered).toHaveLength(frame + 1)
    }

    // The terminal event rides in with transcript records, and the end that follows it
    // latches on arrival: the fold is advanced, the panes still wait for the frame.
    const finish = { t: 99, type: 'run', state: 'completed' }
    o = nextOffset(o, finish)
    MockEventSource.last.batch([
      { s: 'e', o, r: finish },
      { s: 'a3', o: (ao += 10), r: { type: 'text', text: 'last' } },
    ], `v1;e=${o};a3=${ao}`)
    MockEventSource.last.sys({ type: 'end' })
    expect(MockEventSource.last.closedByClient).toBe(true)
    expect(delivered).toHaveLength(60)
    frames.flush()
    expect(delivered).toHaveLength(61)

    const snap = handle.store.getSnapshot()
    expect(snap.connection).toBe('ended')
    expect(snap.detail!.logTotal).toBe(60)      // zero dropped frames on the events side
    expect(snap.detail!.endedAt).toBe(99)
    // Every transcript record arrived exactly once, one call per frame.
    expect(delivered.reduce((n, d) => n + d.count, 0)).toBe(61)
    // …and the budget, over the second it is stated for. `commits` and the real subscriber
    // count are pinned equal so no publication can slip past the counter.
    expect(frames.now() - clockAt).toBeCloseTo(61 * (1000 / 60), 6)
    expect(snap.commits - before).toBeLessThanOrEqual(61)
    expect(notified).toHaveLength(snap.commits - before)
    off()
    handle.stop()
  })

  it('transcript records are forwarded coalesced, in one call per frame', async () => {
    const delivered: { index: number; count: number }[] = []
    const { handle, frames } = setup({
      agents: [3],
      onAgentRecords: (index, records) => delivered.push({ index, count: records.length }),
    })
    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'a3', o: 10, r: { type: 'text' } }], 'v1;a3=10')
    MockEventSource.last.batch([{ s: 'a3', o: 20, r: { type: 'text' } }], 'v1;a3=20')
    expect(delivered).toEqual([])
    frames.flush()
    expect(delivered).toEqual([{ index: 3, count: 2 }])
    handle.stop()
  })
})

describe('failure paths', () => {
  it('a failed snapshot surfaces the error and the poll is the retry (§5.5)', async () => {
    const detail = detailFrom(SEED_EVENTS)
    let attempt = 0
    const frames = manualFrames()
    const handle = createRunStore({
      runId: 'r1',
      api: {
        runDetail: async () => {
          if (attempt++ === 0) throw new ApiError(0, 'unreachable', 'nope')
          return detail
        },
      },
      frames: frames.schedule,
      EventSourceImpl: MockEventSourceCtor,
    })
    await handle.start()
    expect(handle.store.getSnapshot().error?.unreachable).toBe(true)
    expect(MockEventSource.instances).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(handle.store.getSnapshot().error).toBeNull()
    expect(MockEventSource.instances).toHaveLength(1)
    expect(handle.store.getSnapshot().detail!.agents).toHaveLength(1)
    handle.stop()
  })

  it('a failed poll keeps the last good cockpit on screen behind the banner', async () => {
    const detail = detailFrom(SEED_EVENTS)
    let attempt = 0
    const frames = manualFrames()
    const handle = createRunStore({
      runId: 'r1',
      api: {
        runDetail: async () => {
          if (attempt++ === 0) return detail
          throw new ApiError(503, 'unavailable', 'busy')
        },
      },
      frames: frames.schedule,
      EventSourceImpl: MockEventSourceCtor,
    })
    await handle.start()
    MockEventSource.last.open()
    await vi.advanceTimersByTimeAsync(10_000)
    const snap = handle.store.getSnapshot()
    expect(snap.error?.status).toBe(503)
    expect(snap.detail!.agents).toHaveLength(1)
    handle.stop()
  })

  it('stop() closes the stream, cancels the poll and drops pending frames', async () => {
    const { handle, frames, calls } = setup()
    await handle.start()
    MockEventSource.last.open()
    MockEventSource.last.batch([{ s: 'e', o: 999, r: { t: 9, type: 'log', message: 'x' } }], 'v1;e=999')
    const before = calls.length
    handle.stop()
    expect(MockEventSource.last.closedByClient).toBe(true)
    frames.flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.length).toBe(before)
  })

  /**
   * **Nothing publishes after `stop()` — and "nothing" includes the teardown's own echo.**
   *
   * `sse.close()` emits a status change (sse.ts:381–384), which reaches `onStatus` and
   * re-armed the coalescer AFTER `stop()` had cancelled it. One frame later the store
   * folded the pending batch, handed the transcript records to `onAgentRecords` and
   * notified every subscriber of a page that had already been navigated away from. The
   * assertion the old test was missing is not "the poll stopped" but "no subscriber, no
   * pane and no fold moved".
   */
  it('stop() drops pending records and notifies nobody, including its own close', async () => {
    const delivered: number[] = []
    const { handle, frames } = setup({
      agents: [3],
      onAgentRecords: (_index, records) => delivered.push(records.length),
    })
    await handle.start()
    MockEventSource.last.open()
    frames.flush()
    const published = handle.store.getSnapshot()
    expect(published.detail!.logs).toHaveLength(0)

    const notified: number[] = []
    const off = handle.store.subscribe(() => notified.push(handle.store.getSnapshot().commits))

    let o = offsetsFor(SEED_EVENTS)
    const log = { t: 9, type: 'log', message: 'after the teardown' }
    o = nextOffset(o, log)
    MockEventSource.last.batch([
      { s: 'e', o, r: log },
      { s: 'a3', o: 40, r: { type: 'text', text: 'hi' } },
      { s: 'j', o: 60, r: { type: 'result', key: 'k0', index: 0, usage: { input: 9, output: 9, cost: 9 }, result: 'x' } },
    ], `v1;e=${o};j=60`)

    handle.stop()
    frames.flush()
    handle.flush()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(notified).toEqual([])
    expect(delivered).toEqual([])
    // Reference-identical: `commit()` never ran, so no fold change and no journal join
    // reached the published snapshot either.
    expect(handle.store.getSnapshot()).toBe(published)
    expect(handle.store.getSnapshot().detail!.logs).toHaveLength(0)
    expect(handle.store.getSnapshot().detail!.agents[0]!.attempts).toBe(0)
    off()
  })
})
