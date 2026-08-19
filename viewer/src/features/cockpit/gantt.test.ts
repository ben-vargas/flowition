// The Gantt's geometry, in the node environment (§11.1's pure half).
//
// Every assertion here is a claim about a NUMBER the chart draws. That is the point of
// making the model pure: a Gantt that renders is not a Gantt that is correct, and the
// failure mode a reviewer cannot see by eye is a bar that is off by a percent.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STALL_MS, execEnd, execExtent, ganttModel, queueExtent, quietTag, rulerTicks,
  stepZoom, tickLabel, trackWidth,
} from './gantt.js'
import {
  agentDuration, deriveHonesty, durationValue, isQueuedState, isRunningState,
} from './honesty.js'
import type { ExecHonesty, QueueHonesty } from './gantt.js'

/**
 * The screen's verdict, for the extent cases below (round 8).
 *
 * `execExtent` no longer takes a `{ live, now }` bag it could reason about on its own: it
 * takes the honesty slice, so a caller cannot ask about a bar's edge without having asked
 * about the agent first. `duration` here is the REAL `agentDuration`, not a stub — these
 * cases exercise the cockpit's own rule rather than a restatement of it.
 */
const verdict = (live: boolean, now: number, orphaned = false): ExecHonesty & QueueHonesty => {
  // `deriveHonesty`'s own rule, restated at the size of one agent: the RUN is live AND the
  // record says `running` AND step 8 did not strand it. `waiting` is the same rule in the
  // queue's tense (round 12).
  const moving = (a: AgentView) => live && isRunningState(a.state) && !orphaned
  return {
    moving,
    waiting: (a: AgentView) => live && isQueuedState(a.state) && !orphaned,
    duration: (a) => agentDuration(a, { moving: moving(a), orphaned, now }),
  }
}
import {
  AGENTS, CORRUPT_RUN, LEGACY_RUN, LIVE_QUEUE_RUN, LIVE_RUN, NOW, ORPHAN_QUEUE_RUN,
  QUEUE_AT, QUEUE_CHART_END, RESUMED_RUNNING, SPAN_MS, STALE_RUN, T0,
} from './fixtures.js'
import type { AgentView, RunDetail } from '../../api/types.js'

const lane = (model: ReturnType<typeof ganttModel>, index: number) =>
  model.lanes.find((l) => l.index === index)!

describe('the time window', () => {
  it('spans the run start to now while the run is live', () => {
    const model = ganttModel(LIVE_RUN, { now: NOW })
    expect(model.start).toBe(T0)
    expect(model.end).toBe(NOW)
    expect(model.spanMs).toBe(SPAN_MS)
    expect(model.live).toBe(true)
    expect(model.nowPct).toBe(100)
  })

  it('has NO now-line on a dead run — a run whose engine went away has no "now"', () => {
    const model = ganttModel(STALE_RUN, { now: NOW })
    expect(model.live).toBe(false)
    expect(model.nowPct).toBeNull()
  })

  it('never divides by zero on a run that has only just started', () => {
    const fresh: RunDetail = { ...LIVE_RUN, startedAt: NOW, endedAt: null, agents: [] }
    const model = ganttModel(fresh, { now: NOW })
    expect(model.spanMs).toBeGreaterThan(0)
    expect(Number.isFinite(model.nowPct!)).toBe(true)
  })
})

describe('bar geometry (§2.4)', () => {
  const model = ganttModel(LIVE_RUN, { now: NOW })

  it('draws queue wait and execution as two segments, to scale', () => {
    // agent 6 waited 3m08s (188s) then ran 2m26s (146s) inside an 842s window.
    const six = lane(model, 6)
    expect(six.waitLeft).toBeCloseTo((134_000 / SPAN_MS) * 100, 6)
    expect(six.waitWidth).toBeCloseTo((188_000 / SPAN_MS) * 100, 6)
    expect(six.execWidth).toBeCloseTo((146_000 / SPAN_MS) * 100, 6)
    expect(six.waitMs).toBe(188_000)
    expect(six.durationMs).toBe(146_000)
  })

  it('gives a failed agent a REAL width from E5 rather than vanishing it', () => {
    const four = lane(model, 4)
    expect(four.durationMs).toBe(2_000)
    expect(four.execWidth).toBeGreaterThan(0)
    expect(four.errorCode).toBe('spawn_failed')
  })

  it('leaves a queued agent open-ended: hatch to now, no execution segment', () => {
    const eight = lane(model, 8)
    expect(eight.execLeft).toBeNull()
    expect(eight.execWidth).toBeNull()
    expect(eight.waitWidth).toBeCloseTo(((NOW - (T0 + 322_000)) / SPAN_MS) * 100, 6)
  })

  it('marks a cached agent rather than giving it a duration — it took no slot', () => {
    const two = lane(model, 2)
    expect(two.cached).toBe(true)
    expect(two.tick).not.toBeNull()
    expect(two.execWidth).toBeNull()
  })

  it('places the E6 notch at lastOutputAt, inside the execution segment', () => {
    const five = lane(model, 5)
    expect(five.notch).toBeCloseTo((464_000 / SPAN_MS) * 100, 6)
    expect(five.notch!).toBeGreaterThan(five.execLeft!)
    expect(five.notch!).toBeLessThan(five.execLeft! + five.execWidth!)
  })
})

describe('a dead run\'s bars stop where the engine did', () => {
  const model = ganttModel(STALE_RUN, { now: NOW })

  it('does not extend an unfinished agent to now', () => {
    const three = lane(model, 3)
    // The agent has no endedAt: the last fact is its last provider output.
    const end = model.start + ((three.execLeft! + three.execWidth!) / 100) * model.spanMs
    expect(Math.round(end)).toBe(T0 - 3_876_000)
    expect(three.truncated).toBe(true)
    expect(three.orphaned).toBe(true)
  })

  it('never fabricates a quiet tag on a dead run', () => {
    for (const l of model.lanes) expect(l.quiet).toBeNull()
  })

  /**
   * Round 7's B1. The bar's right edge is a TRUNCATION BOUNDARY — "this is the last thing
   * the engine wrote" — and `end - start` over it is the width of the evidence, not a
   * runtime. Printing it told the operator the agent ran for 2m04s when the truth is that
   * nobody knows how long it ran, and in the no-output case (the committed
   * `cockpit-stale-*` captures) it printed `0ms` for an agent that had been working for
   * minutes. §2.4/parity #53: absent fields are omitted, never rendered as `0`.
   */
  it('reports NO duration for a bar whose end was never recorded', () => {
    const three = lane(model, 3)
    expect(three.truncated).toBe(true)
    expect(three.durationMs).toBeNull()
    // And the boundary is still drawn — the bar keeps its extent, it just carries no figure.
    expect(three.execWidth!).toBeGreaterThan(0)
  })

  it('reports no duration for an orphan that never produced output either (the 0ms case)', () => {
    const silent = {
      ...STALE_RUN,
      agents: STALE_RUN.agents.map((a) => (a.index === 3 ? { ...a, lastOutputAt: null } : a)),
    }
    const three = lane(ganttModel(silent, { now: NOW }), 3)
    expect(three.truncated).toBe(true)
    // This is the exact value the reviewer read off the capture. It must not exist.
    expect(three.durationMs).not.toBe(0)
    expect(three.durationMs).toBeNull()
  })

  it('will not date an orphan\'s death with a PREVIOUS attempt\'s durationMs', () => {
    const resumed = {
      ...STALE_RUN,
      agents: STALE_RUN.agents.map((a) => (a.index === 3 ? { ...a, durationMs: 61_000 } : a)),
    }
    const three = lane(ganttModel(resumed, { now: NOW }), 3)
    expect(three.truncated).toBe(true)
    expect(three.durationMs).not.toBe(61_000)
    expect(three.durationMs).toBeNull()
  })

  it('still prints the settled agents\' real durations on the same dead run', () => {
    // The rule is about UNRECORDED ends, not about dead runs — a `done` agent's figure is a
    // recorded fact and survives its run's death.
    for (const index of [0, 1, 2]) {
      expect(lane(model, index).durationMs).not.toBeNull()
      expect(lane(model, index).truncated).toBe(false)
    }
  })
})

describe('the same rule on a QUIESCENT run (corrupt-result), where nothing is pre-applied', () => {
  // `CORRUPT_RUN` arrives with no `displayState` post-pass, so every honesty verdict on this
  // screen is the client's own — which is what makes it the fixture that catches a widget
  // deriving liveness for itself.
  const model = ganttModel(CORRUPT_RUN, { now: NOW })

  it('truncates the unfinished lanes and gives them no duration', () => {
    const truncated = model.lanes.filter((l) => l.truncated)
    expect(truncated.length).toBeGreaterThan(0)
    for (const l of truncated) {
      expect(l.durationMs).toBeNull()
      expect(l.open).toBe(false)
      expect(l.quiet).toBeNull()
    }
  })

  it('draws no now-line and leaves the settled lanes alone', () => {
    expect(model.nowPct).toBeNull()
    const settled = model.lanes.filter((l) => !l.truncated && !l.cached && l.execWidth != null)
    expect(settled.length).toBeGreaterThan(0)
  })
})

describe('execExtent separates the drawn boundary from a confirmed end', () => {
  const base = AGENTS[0]!

  it('labels each of the four ways a bar can end', () => {
    expect(execExtent({ ...base, endedAt: 5 }, verdict(true, 9), 9).kind).toBe('settled')
    expect(execExtent(
      { ...base, startedAt: 10, endedAt: null, durationMs: 7 }, verdict(true, 99), 99,
    ).kind).toBe('settled')
    expect(execExtent(
      { ...base, state: 'running', startedAt: 10, endedAt: null, durationMs: null },
      verdict(true, 42), 42,
    )).toEqual({ end: 42, kind: 'open' })
    expect(execExtent(
      { ...base, state: 'running', startedAt: 10, endedAt: null, durationMs: null, lastOutputAt: 30 },
      verdict(false, 42), 42,
    )).toEqual({ end: 30, kind: 'truncated' })
    // No output at all: the boundary IS the start, and that is precisely why it is not a
    // duration.
    expect(execExtent(
      { ...base, state: 'running', startedAt: 10, endedAt: null, durationMs: null, lastOutputAt: null },
      verdict(false, 42), 42,
    )).toEqual({ end: 10, kind: 'truncated' })
    expect(execExtent({ ...base, startedAt: null }, verdict(true, 1), 1).kind).toBe('unstarted')
  })

  /**
   * Round 8. The bar's EXTENT is this module's; the FIGURE beside it is not — it is
   * `honesty.duration`, verbatim, so the Timeline cannot print a runtime the Agents table
   * and the Structure chips are refusing to print for the same agent. This is the
   * structural assertion: every lane of every fixture carries exactly the screen's reading.
   */
  it('takes its printed figure from honesty, never from the raw field', () => {
    for (const detail of [LIVE_RUN, STALE_RUN, CORRUPT_RUN, LEGACY_RUN, RESUMED_RUNNING]) {
      const honesty = deriveHonesty(detail, { now: NOW })
      const model = ganttModel(detail, { now: NOW, honesty })
      for (const l of model.lanes) {
        const agent = detail.agents.find((a) => a.index === l.index)!
        expect({ run: detail.runId, i: l.index, d: l.duration })
          .toEqual({ run: detail.runId, i: l.index, d: honesty.duration(agent) })
        expect(l.durationMs).toBe(durationValue(honesty.duration(agent)))
      }
    }
  })

  /**
   * And the matching hole in the GEOMETRY: an ORPHANED agent carrying a previous attempt's
   * `durationMs` used to take the settled branch — `!running` is false for `queued` — and
   * be drawn a bar of that attempt's width, dated from a start the attempt never had.
   */
  it('refuses a previous attempt\'s durationMs as a bar edge, for queued orphans too', () => {
    const stranded = { ...base, state: 'queued' as const, startedAt: 10, endedAt: null, durationMs: 7 }
    expect(execExtent(stranded, verdict(false, 42), 42).kind).toBe('truncated')
    expect(execExtent({ ...stranded, state: 'done' }, verdict(false, 42), 42))
      .toEqual({ end: 17, kind: 'settled' })
    // The post-pass alone is enough, whatever the record says.
    expect(execExtent(
      { ...base, state: 'done', startedAt: 10, endedAt: null, durationMs: 7 },
      verdict(false, 42, true), 42,
    ).kind).toBe('truncated')
  })
})

/**
 * ROUND 12, B1 — THE QUEUE ENDPOINT THAT CAME FROM ANOTHER AGENT'S CLOCK.
 *
 * The hatch was closed at `startedAt ?? (live ? now : end)`, and `end` is the CHART's right
 * edge: the maximum over every agent's timestamps. So a queued agent the engine abandoned was
 * drawn a proportional wait ending at whenever some other agent last did something. The
 * geometry is honest-looking and to scale, which is what makes it the worst kind of lie — it
 * can be read off the ruler as "its wait ended here", and nothing on disk says that.
 *
 * The fixture pair is the control: ONE set of agents under two run states. Live, the wait is
 * genuinely open and `now` is this agent's own right edge; dead, there is no edge at all.
 */
describe('the queue wait ends where the RECORD ends, or nowhere (round 12, B1)', () => {
  // The fixture's still-queued agent, re-based on a small clock so the four cases read as
  // arithmetic. `queuedAt` is 100 throughout; only what happened after it differs.
  const queued = { ...AGENTS[8]!, queuedAt: 100 }

  it('labels the four ways a wait can end', () => {
    // A `running` event: the wait's own recorded close.
    expect(queueExtent({ ...queued, startedAt: 500 }, verdict(true, 900), 900))
      .toEqual({ at: 100, end: 500, kind: 'settled' })
    // Left the queue without ever starting — a spawn failure writes `endedAt` and no start,
    // and that terminal fact is still THIS agent's own.
    expect(queueExtent(
      { ...queued, state: 'failed', endedAt: 700, errorCode: 'spawn_failed' },
      verdict(false, 900), 900,
    )).toEqual({ at: 100, end: 700, kind: 'settled' })
    // Genuinely still waiting: `now`, and it advances.
    expect(queueExtent(queued, verdict(true, 900), 900))
      .toEqual({ at: 100, end: 900, kind: 'open' })
    // The blocker: dead, queued, no transition. NO endpoint — not `now`, not the chart's end.
    expect(queueExtent(queued, verdict(false, 900), 900))
      .toEqual({ at: 100, end: null, kind: 'unrecorded' })
    // …and an agent stranded by §6.4 step 8 on a run that is still live is refused too: the
    // verdict is per agent, exactly as it is for the execution bar.
    expect(queueExtent(queued, verdict(true, 900, true), 900).kind).toBe('unrecorded')
    expect(queueExtent({ ...queued, queuedAt: null }, verdict(true, 900), 900).kind).toBe('absent')
    // A transition recorded BEFORE the queue event is not an interval running backwards.
    expect(queueExtent({ ...queued, startedAt: 40 }, verdict(true, 900), 900))
      .toEqual({ at: 100, end: 100, kind: 'settled' })
  })

  it('gives a dead queued agent a mark at queuedAt and NO interval', () => {
    const model = ganttModel(ORPHAN_QUEUE_RUN, { now: NOW })
    const orphan = lane(model, 1)
    expect(orphan.waitKind).toBe('unrecorded')
    expect(orphan.waitLeft).toBeCloseTo(((QUEUE_AT - model.start) / model.spanMs) * 100, 6)
    // The mark is placed; the interval is not drawn at all.
    expect(orphan.waitWidth).toBeNull()
    expect(orphan.execLeft).toBeNull()
    expect(orphan.durationMs).toBeNull()
    expect(orphan.waitMs).toBeNull()
    expect(orphan.orphaned).toBe(true)
  })

  it('refuses the endpoint BECAUSE it belongs to another agent, not merely as a default', () => {
    const model = ganttModel(ORPHAN_QUEUE_RUN, { now: NOW })
    // The chart's right edge is `build`'s recorded end — the number the old code closed the
    // hatch at, and the only reason it existed at all.
    expect(model.end).toBe(QUEUE_CHART_END)
    expect(ORPHAN_QUEUE_RUN.agents[0]!.endedAt).toBe(QUEUE_CHART_END)
    // This is the drawn wait the reviewer read off the chart: 13m50s of it.
    const fabricated = ((QUEUE_CHART_END - QUEUE_AT) / model.spanMs) * 100
    expect(fabricated).toBeGreaterThan(90)
    expect(lane(model, 1).waitWidth).not.toBeCloseTo(fabricated, 6)
    expect(lane(model, 1).waitWidth).toBeNull()
    // And the settled lane beside it is untouched — the rule is about unrecorded ends.
    expect(lane(model, 0).waitKind).toBe('settled')
    expect(lane(model, 0).durationMs).toBe(840_000)
  })

  it('CONTROL — the same queue entry on a LIVE run extends honestly to now', () => {
    const model = ganttModel(LIVE_QUEUE_RUN, { now: NOW })
    const open = lane(model, 1)
    expect(open.waitKind).toBe('open')
    expect(open.waitLeft).toBeCloseTo(((QUEUE_AT - model.start) / model.spanMs) * 100, 6)
    expect(open.waitWidth).toBeCloseTo(((NOW - QUEUE_AT) / model.spanMs) * 100, 6)
    expect(open.waitLeft! + open.waitWidth!).toBeCloseTo(100, 6)
    expect(open.orphaned).toBe(false)
  })

  it('CONTROL — the live wait grows with the clock; the dead one has nothing to grow', () => {
    const early = lane(ganttModel(LIVE_QUEUE_RUN, { now: T0 + 100_000 }), 1)
    const later = lane(ganttModel(LIVE_QUEUE_RUN, { now: T0 + 800_000 }), 1)
    // Both are percentages of their own windows, so compare the ABSOLUTE right edge.
    const edge = (m: ReturnType<typeof ganttModel>) =>
      m.start + ((lane(m, 1).waitLeft! + lane(m, 1).waitWidth!) / 100) * m.spanMs
    expect(Math.round(edge(ganttModel(LIVE_QUEUE_RUN, { now: T0 + 800_000 })))).toBe(T0 + 800_000)
    expect(later.waitWidth!).toBeGreaterThan(0)
    expect(early.waitWidth!).toBeGreaterThan(0)
    // The dead twin never acquires one, however late the operator opens the page.
    for (const now of [NOW, NOW + 86_400_000]) {
      expect(lane(ganttModel(ORPHAN_QUEUE_RUN, { now }), 1).waitWidth).toBeNull()
    }
  })

  it('holds on every dead fixture in the directory, not just the purpose-built one', () => {
    for (const detail of [STALE_RUN, CORRUPT_RUN, ORPHAN_QUEUE_RUN]) {
      const model = ganttModel(detail, { now: NOW })
      const stranded = model.lanes.filter((l) => l.waitKind === 'unrecorded')
      // The fixtures actually contain the case, or the loop proves nothing.
      expect({ run: detail.runId, has: stranded.length > 0 })
        .toEqual({ run: detail.runId, has: true })
      for (const l of stranded) {
        expect({ run: detail.runId, i: l.index, width: l.waitWidth, ms: l.waitMs })
          .toEqual({ run: detail.runId, i: l.index, width: null, ms: null })
      }
    }
    // …and the live run's queued lanes are NOT swept up in it: they are open, to `now`.
    const live = ganttModel(LIVE_RUN, { now: NOW })
    for (const index of [8, 9]) {
      expect(lane(live, index).waitKind).toBe('open')
      expect(lane(live, index).waitWidth!).toBeGreaterThan(0)
    }
  })

  it('reports a wait LENGTH only where something recorded the end', () => {
    const live = ganttModel(LIVE_RUN, { now: NOW })
    // E4's own figure, on a settled wait.
    expect(lane(live, 6).waitMs).toBe(188_000)
    // Open and orphaned waits report none — a figure beside an unclosed edge is the same
    // fabrication one column over.
    expect(lane(live, 8).waitMs).toBeNull()
    expect(lane(ganttModel(ORPHAN_QUEUE_RUN, { now: NOW }), 1).waitMs).toBeNull()
    // A wait closed by a terminal event rather than a start still has a real length.
    const failed: RunDetail = {
      ...ORPHAN_QUEUE_RUN,
      agents: ORPHAN_QUEUE_RUN.agents.map((a) => (a.index === 1
        ? { ...a, state: 'failed' as const, displayState: 'failed' as const,
            endedAt: QUEUE_AT + 4_000, errorCode: 'spawn_failed' }
        : a)),
    }
    const gone = lane(ganttModel(failed, { now: NOW }), 1)
    expect(gone.waitKind).toBe('settled')
    expect(gone.waitMs).toBe(4_000)
    expect(gone.waitWidth!).toBeGreaterThan(0)
  })

  /**
   * The same leak in its second form. A cache hit whose replay the run recorded no timestamp
   * for used to be marked at the window's `start` — which is whichever OTHER agent opened the
   * run, so the lane said "replayed at the top of the run" about a replay nothing dates.
   */
  it('marks a cache hit only where the run dated the replay', () => {
    const dated = lane(ganttModel(LIVE_RUN, { now: NOW }), 2)
    expect(dated.cached).toBe(true)
    expect(dated.tick).toBeCloseTo(0, 6)
    const undated: RunDetail = {
      ...LIVE_RUN,
      agents: LIVE_RUN.agents.map((a) => (a.index === 2
        ? { ...a, queuedAt: null, startedAt: null, endedAt: null }
        : a)),
    }
    const blank = lane(ganttModel(undated, { now: NOW }), 2)
    expect(blank.cached).toBe(true)
    expect(blank.tick).toBeNull()
  })
})

describe('the quiet ladder (Q2)', () => {
  const running = (over: Partial<AgentView>): AgentView => ({
    ...AGENTS[5]!, ...over,
  })

  it('fires at 50% of the EMITTED stallMs and not before', () => {
    const agent = running({ stallMs: 600_000, lastOutputAt: NOW - 299_000 })
    expect(quietTag(agent, { live: true, now: NOW, hasProgressData: true })).toBeNull()
    const later = running({ stallMs: 600_000, lastOutputAt: NOW - 301_000 })
    const tag = quietTag(later, { live: true, now: NOW, hasProgressData: true })!
    expect(tag.sinceMs).toBe(301_000)
    expect(tag.approximate).toBe(false)
  })

  it('falls back to the engine default and SAYS SO when no stallMs was emitted (M10)', () => {
    const agent = running({ stallMs: null, lastOutputAt: NOW - 1_000_000 })
    const tag = quietTag(agent, { live: true, now: NOW, hasProgressData: true })!
    expect(tag.thresholdMs).toBe(DEFAULT_STALL_MS)
    expect(tag.approximate).toBe(true)
  })

  // §2.4, verbatim: "Old runs with no emitted `stallMs`: fall back to `1_800_000` (the engine
  // default, src/agent-proc.js:24) and label the tag 'quiet for Nm (stall threshold
  // unknown)'". Round 1 suppressed the tag on exactly those runs; the document says warn and
  // label, so the old run is the NORMATIVE case, not the exempt one (review round 2, B2).
  it('warns on a pre-E6 run from the START, at the default threshold, and says both', () => {
    const agent = running({ stallMs: null, lastOutputAt: null, startedAt: NOW - 10_000_000 })
    const tag = quietTag(agent, { live: true, now: NOW, hasProgressData: false })!
    expect(tag).not.toBeNull()
    expect(tag.thresholdMs).toBe(DEFAULT_STALL_MS)
    expect(tag.approximate).toBe(true)
    expect(tag.from).toBe('start')
    expect(tag.sinceMs).toBe(10_000_000)
    // The pre-E6 run is not warned about EARLIER than a modern one: below half the default
    // threshold there is still no tag.
    const quiet = running({ stallMs: null, lastOutputAt: null, startedAt: NOW - 890_000 })
    expect(quietTag(quiet, { live: true, now: NOW, hasProgressData: false })).toBeNull()
  })

  it('measures from lastOutputAt whenever the run recorded one', () => {
    const agent = running({ stallMs: 600_000, lastOutputAt: NOW - 400_000, startedAt: NOW - 9_000_000 })
    const tag = quietTag(agent, { live: true, now: NOW, hasProgressData: true })!
    expect(tag.from).toBe('lastOutput')
    expect(tag.sinceMs).toBe(400_000)
  })

  it('tags a pre-E6 LANE through the whole model, not just the helper', () => {
    const legacy: RunDetail = {
      ...LEGACY_RUN,
      agents: LEGACY_RUN.agents.map((a) => (
        a.index === LEGACY_RUN.agents[0]!.index
          ? { ...a, state: 'running' as const, displayState: 'running' as const,
              endedAt: null, durationMs: null, stallMs: null, lastOutputAt: null,
              startedAt: NOW - 4_000_000 }
          : a
      )),
      state: 'running' as const,
      endedAt: null,
    }
    const model = ganttModel(legacy, { now: NOW })
    const tagged = model.lanes.filter((l) => l.quiet)
    expect(tagged).toHaveLength(1)
    expect(tagged[0]!.quiet).toMatchObject({
      approximate: true, from: 'start', thresholdMs: DEFAULT_STALL_MS,
    })
  })

  it('never fires for an agent that is not running', () => {
    const agent = running({ state: 'done', lastOutputAt: NOW - 10_000_000 })
    expect(quietTag(agent, { live: true, now: NOW, hasProgressData: true })).toBeNull()
  })
})

describe('degradation (§6.5)', () => {
  it('drops wait segments, notches and the strip when E4/E6 are unsupported', () => {
    const model = ganttModel(LEGACY_RUN, { now: NOW })
    expect(model.hasQueueData).toBe(false)
    expect(model.hasProgressData).toBe(false)
    for (const l of model.lanes) {
      expect(l.waitLeft).toBeNull()
      expect(l.notch).toBeNull()
      // …and the bar still exists: it starts at the `running` event.
      expect(l.execWidth).not.toBeNull()
    }
  })

  it('a fresh run whose caps are `pending` is NOT treated as an old engine (M2)', () => {
    const pending: RunDetail = {
      ...LIVE_RUN,
      caps: Object.fromEntries(
        Object.keys(LIVE_RUN.caps).map((k) => [k, 'pending']),
      ) as unknown as RunDetail['caps'],
    }
    const model = ganttModel(pending, { now: NOW })
    // `pending` is not `supported`, so no queue segments are drawn — but the UI's
    // older-engine copy is gated on `unsupported`, which this is not.
    expect(model.hasQueueData).toBe(false)
    expect(pending.caps.queueEvents).toBe('pending')
  })
})

describe('execEnd precedence', () => {
  const base = AGENTS[0]!
  it('prefers endedAt, then startedAt+durationMs, then now, then the last output', () => {
    expect(execEnd({ ...base, endedAt: 5, durationMs: 99 }, verdict(true, 9), 9)).toBe(5)
    expect(execEnd(
      { ...base, startedAt: 10, endedAt: null, durationMs: 7 }, verdict(true, 99), 99,
    )).toBe(17)
    expect(execEnd(
      { ...base, state: 'running', startedAt: 10, endedAt: null, durationMs: null },
      verdict(true, 42), 42,
    )).toBe(42)
    expect(execEnd(
      { ...base, state: 'running', startedAt: 10, endedAt: null, durationMs: null, lastOutputAt: 30 },
      verdict(false, 42), 42,
    )).toBe(30)
  })

  it('is null for an agent that never started', () => {
    expect(execEnd({ ...base, startedAt: null }, verdict(true, 1), 1)).toBeNull()
  })

  it('runs a RESUMED, currently-running agent to now, not to its old attempt\'s duration', () => {
    // The journal join restores `durationMs` from the LAST SETTLED result record (§6.4 J),
    // so a live `running` agent legitimately carries the previous attempt's figure. Reading
    // it here truncated the live bar — and the bar SHRANK as the run went on.
    expect(execEnd(
      { ...base, state: 'running', startedAt: 10, endedAt: null, durationMs: 7 },
      verdict(true, 900), 900,
    )).toBe(900)
    // A settled current execution still wins, whatever the state field says.
    expect(execEnd(
      { ...base, state: 'running', startedAt: 10, endedAt: 50, durationMs: 7 },
      verdict(true, 900), 900,
    )).toBe(50)
    // On a DEAD run the same agent is orphaned: it stops at the last recorded fact, and a
    // stale duration from an earlier attempt may not date its death either.
    expect(execEnd(
      { ...base, state: 'running', startedAt: 10, endedAt: null, durationMs: 7, lastOutputAt: 30 },
      verdict(false, 900), 900,
    )).toBe(30)
  })
})

describe('a resumed agent that is running right now (review round 1, B6)', () => {
  it('draws the bar to now and labels it with the CURRENT execution', () => {
    const model = ganttModel(RESUMED_RUNNING, { now: NOW })
    const bar = lane(model, 0)
    // The window is start→now; the execution began 2s in and is still open.
    expect(model.end).toBe(NOW)
    expect(bar.execLeft! + bar.execWidth!).toBeCloseTo(100, 6)
    expect(bar.open).toBe(true)
    // 40s was the PREVIOUS attempt. The figure beside the bar describes the bar.
    expect(bar.durationMs).toBe(NOW - (T0 + 2_000))
    expect(bar.durationMs).not.toBe(40_000)
  })

  it('grows with the clock instead of shrinking against it', () => {
    const early = ganttModel(RESUMED_RUNNING, { now: T0 + 100_000 })
    const later = ganttModel(RESUMED_RUNNING, { now: T0 + 400_000 })
    expect(lane(later, 0).durationMs!).toBeGreaterThan(lane(early, 0).durationMs!)
  })
})

describe('ruler and zoom', () => {
  it('labels offsets, never wall clock', () => {
    expect(tickLabel(0)).toBe('0s')
    expect(tickLabel(120_000)).toBe('2m')
    expect(tickLabel(3_840_000)).toBe('1h04m')
    expect(tickLabel(7_200_000)).toBe('2h')
  })

  it('picks a round step and covers the whole span', () => {
    const ticks = rulerTicks(842_000)
    expect(ticks[0]!.pct).toBe(0)
    expect(ticks.length).toBeGreaterThan(3)
    expect(ticks.length).toBeLessThan(12)
    const step = ticks[1]!.at - ticks[0]!.at
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.at - ticks[i - 1]!.at).toBe(step)
  })

  it('`fit` has no fixed track — the CSS floor and the scroller take over', () => {
    expect(trackWidth('fit', 842_000)).toBeNull()
    expect(trackWidth(1_000, 842_000)).toBe(842)
    // …and a pathological span is bounded rather than allowed to hang paint.
    expect(trackWidth(1, 86_400_000)).toBe(40_000)
    expect(trackWidth(60_000, 60_000)).toBe(350)
  })

  it('`+` zooms in (fewer ms per px) and `-` out, both bounded by the ladder', () => {
    expect(stepZoom('fit', 1)).toBe(5_000)
    expect(stepZoom(1_000, 1)).toBe(500)
    expect(stepZoom(1_000, -1)).toBe(2_500)
    expect(stepZoom(100, 1)).toBe(100)
    expect(stepZoom(60_000, -1)).toBe(60_000)
  })
})

/**
 * The attempt window (§6.4 step 1a, amended: attempt-scoped Timeline). `options.window` is
 * the seam the Cockpit clamps an ARCHIVED attempt's chart with: the axis measures the
 * attempt's own `[start, end)`, and a lane whose every timestamp predates it — an agent the
 * attempt never re-entered, whose clock still dates an earlier execution — gets NO geometry
 * rather than a bar clamped onto the left edge (the same refusal the truncated edge makes).
 */
describe('the attempt window (§6.4 step 1a amended)', () => {
  const W_START = T0
  const W_END = T0 + 100_000
  const base = STALE_RUN.agents[0]!
  const detail: RunDetail = {
    ...STALE_RUN,
    state: 'interrupted',
    startedAt: W_START,
    endedAt: W_END,
    agents: [
      // Executed inside the attempt: a real bar, measured against the attempt's own span.
      {
        ...base, index: 0, state: 'done', displayState: 'done',
        queuedAt: T0 + 10_000, startedAt: T0 + 20_000, endedAt: T0 + 60_000,
        waitMs: 10_000, durationMs: 40_000, lastOutputAt: null,
      },
      // Settled before the attempt began and never re-entered: every timestamp it carries
      // is another attempt's, so this window may draw none of them — nor print the
      // duration, wait or error that clock supports.
      {
        ...base, index: 1, state: 'failed', displayState: 'failed',
        queuedAt: T0 - 50_000, startedAt: T0 - 40_000, endedAt: T0 - 30_000,
        waitMs: 10_000, durationMs: 10_000, lastOutputAt: null,
        errorCode: 'stalled', error: 'boom from another attempt',
      },
      // A cache hit replayed IN the attempt keeps its replay tick…
      {
        ...base, index: 2, state: 'cached', displayState: 'cached', cached: true,
        queuedAt: null, startedAt: null, endedAt: T0 + 30_000,
        waitMs: null, durationMs: null, usage: null, lastOutputAt: null,
      },
      // …one replayed before it does not get a tick clamped to the window's edge.
      {
        ...base, index: 3, state: 'cached', displayState: 'cached', cached: true,
        queuedAt: null, startedAt: null, endedAt: T0 - 20_000,
        waitMs: null, durationMs: null, usage: null, lastOutputAt: null,
      },
    ],
  }
  const model = ganttModel(detail, { now: NOW, window: { start: W_START, end: W_END } })

  it('clamps the axis to the window, not to the agents’ extent', () => {
    expect(model.start).toBe(W_START)
    expect(model.end).toBe(W_END)
    expect(model.spanMs).toBe(100_000)
    // A closed attempt has no "now" whatever the wall clock says.
    expect(model.live).toBe(false)
    expect(model.nowPct).toBeNull()
  })

  it('lays an in-window execution out on the attempt’s own span', () => {
    const inside = lane(model, 0)
    expect(inside.preWindow).toBe(false)
    expect(inside.waitLeft).toBeCloseTo(10, 6)
    expect(inside.waitWidth).toBeCloseTo(10, 6)
    expect(inside.execLeft).toBeCloseTo(20, 6)
    expect(inside.execWidth).toBeCloseTo(40, 6)
    expect(inside.durationMs).toBe(40_000)
  })

  it('refuses geometry for a lane whose clock predates the window', () => {
    const before = lane(model, 1)
    expect(before.preWindow).toBe(true)
    expect(before.waitLeft).toBeNull()
    expect(before.waitWidth).toBeNull()
    expect(before.execLeft).toBeNull()
    expect(before.execWidth).toBeNull()
    expect(before.notch).toBeNull()
    // Not a truncation: the end IS recorded, it just belongs to another attempt's axis.
    expect(before.truncated).toBe(false)
  })

  it('suppresses attempt-specific metadata on a pre-window lane, not just its geometry', () => {
    // The metadata form of the same leak (codex round 2): the duration, wait, quiet tag
    // and error on this record all describe an EARLIER attempt's execution, and printing
    // any of them beside "no events in this attempt" dates this attempt's chart with
    // another's facts exactly as the refused bar would have.
    const before = lane(model, 1)
    expect(before.duration).toEqual({ kind: 'absent' })
    expect(before.durationMs).toBeNull()
    expect(before.waitMs).toBeNull()
    expect(before.quiet).toBeNull()
    expect(before.errorCode).toBeNull()
    expect(before.error).toBeNull()
    expect(before.open).toBe(false)
    // The pre-window replay reads the same: no figure from the carried clock.
    const carried = lane(model, 3)
    expect(carried.duration).toEqual({ kind: 'absent' })
    expect(carried.durationMs).toBeNull()
    // An IN-window lane keeps its own metadata — the suppression is the window's, not
    // the archive's.
    expect(lane(model, 0).duration).toEqual({ kind: 'recorded', ms: 40_000 })
  })

  it('marks an in-window replay and refuses one from before the window', () => {
    const replayed = lane(model, 2)
    expect(replayed.preWindow).toBe(false)
    expect(replayed.tick).toBeCloseTo(30, 6)
    const carried = lane(model, 3)
    expect(carried.preWindow).toBe(true)
    expect(carried.tick).toBeNull()
  })

  it('sets preWindow on no lane when no window is clamped', () => {
    const free = ganttModel(detail, { now: NOW })
    expect(free.lanes.every((l) => !l.preWindow)).toBe(true)
    // The free axis spans the agents' own extent instead.
    expect(free.start).toBeLessThanOrEqual(T0 - 50_000)
  })
})
