// @vitest-environment jsdom
//
// FOLD → COCKPIT: what the screen says about an agent that is executing for the SECOND time
// (round 11, B1).
//
// Every other cockpit test starts from a hand-written `AgentView`, and that is exactly how
// this class of defect survived eleven rounds: `RESUMED_RUNNING` hand-builds a resumed agent
// with REFRESHED timestamps, so it asserts the honest reading of a record the fold could not
// actually produce. The real fold retained the finished attempt's `startedAt`, `waitMs`,
// `stallMs`, `lastOutputAt` and `lastTool` across the re-entry, and four surfaces published
// them as the present tense: an execution bar and an "end unrecorded" edge under a lane whose
// state chip said `queued`, a wait column that printed and sorted by an attempt that had
// already ended, a progress notch, and a Q2 quiet warning fired by output produced before the
// current execution began.
//
// So these cases start from EVENTS. They fold the byte stream the engine actually writes
// (src/engine.js:959, :969, :983, :1061) through the shared `src/viewer/fold.js` and assert on
// the models the cockpit renders from it. A regression in §6.4 step 3 fails here even if every
// fixture in the directory is updated to hide it.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fold, materializeFold } from '../../fold/index.js'
import { Cockpit } from './Cockpit.js'
import { IconSprite } from '../../ui/Icon.js'
import { ganttModel } from './gantt.js'
import { deriveHonesty, durationValue } from './honesty.js'
import { sortValue } from './agents.js'
import { LIVE_RUN, T0, fixedApi } from './fixtures.js'
import type { RunDetail, RunState } from '../../api/types.js'
import { resetRouteForTests } from '../../app/router.js'

const NOW = T0 + 3_600_000

/** The engine's own byte order — the fold's ordering contract is offsets, never `t` (G10). */
const records = (events: Record<string, unknown>[]) => {
  let o = 0
  return events.map((rec) => ({ o: (o += JSON.stringify(rec).length + 1), rec }))
}

/**
 * A `RunDetail` whose AGENTS came out of the fold rather than out of a fixture.
 *
 * The run envelope is `LIVE_RUN`'s, because none of these cases is about the header; what is
 * under test is the row, the lane and the readings taken from them, and those come from
 * `materializeFold` — the same function `snapshot.js` serves and the same one the SPA folds
 * SSE batches with.
 */
const foldDetail = (events: Record<string, unknown>[], state: RunState = 'running'): RunDetail => {
  const raw = fold(null, records(events))
  const m = materializeFold(raw, state)
  // `FoldState.run` is the merged run EVENT, which the fold types as an open record — the
  // two timestamps §6.2 promises are read out of it here rather than asserted globally.
  const run = m.run as { startedAt?: number | null; endedAt?: number | null } | null
  return {
    ...LIVE_RUN,
    runId: 'r_reentry1',
    name: 're-entry',
    state,
    createdAt: T0,
    startedAt: run?.startedAt ?? T0,
    endedAt: run?.endedAt ?? null,
    declaredPhases: null,
    structure: null,
    saturation: m.saturation,
    phases: m.phases,
    agents: m.agents,
    questions: m.questions,
    mail: m.mail, mailTotal: m.mail.length,
    logs: m.logs, logTotal: m.logs.length,
    attemptSpans: m.attemptSpans,
    attemptScopes: m.attemptScopes.map((s) => ({
      phases: s.phases, logs: s.logs, logTotal: s.logs.length, mail: s.mail, mailTotal: s.mail.length,
      ...(s.agents ? { agents: s.agents } : {}),
    })),
    resumeCount: m.resumeCount,
    caps: m.caps,
    agentCounts: {
      total: m.agents.length,
      done: m.agents.filter((a) => a.state === 'done').length,
      failed: m.agents.filter((a) => a.state === 'failed').length,
      running: m.agents.filter((a) => a.state === 'running').length,
      cached: m.agents.filter((a) => a.cached).length,
    },
  }
}

/** Attempt 1, in full: queued, ran, produced output through a tool, and finished. */
const ATTEMPT_ONE: Record<string, unknown>[] = [
  { t: T0, type: 'run', state: 'started', engine: '0.2.0', concurrency: 2 },
  { t: T0, type: 'agent', index: 0, key: 'k0', label: 'retried', adapter: 'claude', state: 'queued' },
  { t: T0 + 1_000, type: 'agent', index: 0, state: 'running', waitMs: 1_000, stallMs: 1_800_000 },
  { t: T0 + 2_000, type: 'agent', index: 0, state: 'progress', tool: 'Bash', lastOutputAt: T0 + 2_000 },
  { t: T0 + 3_000, type: 'agent', index: 0, state: 'done', durationMs: 2_000, resultPreview: 'ok' },
  { t: T0 + 3_100, type: 'run', state: 'completed' },
  { t: T0 + 3_500_000, type: 'run', state: 'resumed' },
]

const lane0 = (detail: RunDetail) => ganttModel(detail, { now: NOW }).lanes.find((l) => l.index === 0)!

describe('a settled agent re-queued by a resume (§6.4 step 3, round 11 B1)', () => {
  const detail = foldDetail([
    ...ATTEMPT_ONE,
    { t: T0 + 3_599_000, type: 'agent', index: 0, key: 'k0', adapter: 'claude', state: 'queued' },
  ])
  const agent = detail.agents[0]!
  const honesty = deriveHonesty(detail, { now: NOW })

  it('folds to a queued agent that carries none of the finished attempt’s clock', () => {
    expect(agent.state).toBe('queued')
    expect(agent.queuedAt).toBe(T0 + 3_599_000)
    expect(agent.startedAt).toBeNull()
    expect(agent.waitMs).toBeNull()
    expect(agent.stallMs).toBeNull()
    expect(agent.lastOutputAt).toBeNull()
    expect(agent.lastTool).toBeNull()
  })

  it('draws a queue hatch and NO execution bar, notch or truncation edge', () => {
    const lane = lane0(detail)
    expect(lane.waitLeft).not.toBeNull()
    expect(lane.execLeft).toBeNull()
    expect(lane.execWidth).toBeNull()
    expect(lane.notch).toBeNull()
    expect(lane.truncated).toBe(false)
    expect(lane.tick).toBeNull()
    expect(lane.waitMs).toBeNull()
    expect(lane.durationMs).toBeNull()
    expect(lane.quiet).toBeNull()
  })

  it('has no wait, duration or last tool for the Agents table to print or sort by', () => {
    expect(sortValue(agent, 'wait', honesty)).toBeNull()
    expect(sortValue(agent, 'lastTool', honesty)).toBeNull()
    expect(durationValue(honesty.duration(agent))).toBeNull()
  })
})

describe('a settled agent resumed straight into running, before its first output', () => {
  const detail = foldDetail([
    ...ATTEMPT_ONE,
    { t: T0 + 3_599_000, type: 'agent', index: 0, key: 'k0', adapter: 'claude', state: 'running' },
  ])
  const agent = detail.agents[0]!
  const honesty = deriveHonesty(detail, { now: NOW })

  it('starts the execution at the new running event, with no inherited queue entry', () => {
    expect(agent.startedAt).toBe(T0 + 3_599_000)
    expect(agent.queuedAt).toBeNull()
    // The old queue entry is 3,598,000ms before this start. Deriving a wait from it is the
    // arithmetic the reset exists to prevent.
    expect(agent.waitMs).toBeNull()
  })

  it('raises NO quiet warning and NO progress notch from the previous attempt’s output', () => {
    const lane = lane0(detail)
    // Attempt 1's last output is 59m58s old against a 30m default threshold, so the ladder
    // would fire on the first frame if `lastOutputAt` had survived the re-entry.
    expect(lane.quiet).toBeNull()
    expect(lane.notch).toBeNull()
    expect(lane.open).toBe(true)
    expect(lane.execLeft).not.toBeNull()
  })

  it('reports the live execution’s own elapsed time, not the finished attempt’s 2s', () => {
    const reading = honesty.duration(agent)
    expect(reading.kind).toBe('live')
    expect(durationValue(reading)).toBe(NOW - (T0 + 3_599_000))
  })
})

describe('a settled agent replayed from cache on resume', () => {
  const detail = foldDetail([
    ...ATTEMPT_ONE,
    { t: T0 + 3_599_000, type: 'agent', index: 0, key: 'k0', adapter: 'claude', state: 'cached' },
  ])
  const agent = detail.agents[0]!

  it('marks the replay at the cached event, never at the previous attempt’s start', () => {
    const lane = lane0(detail)
    const model = ganttModel(detail, { now: NOW })
    expect(lane.cached).toBe(true)
    expect(lane.tick).toBeCloseTo(((T0 + 3_599_000 - model.start) / model.spanMs) * 100, 6)
    // Where the old chain landed: attempt 1's `startedAt`, one second into a one-hour window.
    expect(lane.tick).toBeGreaterThan(50)
    expect(lane.execLeft).toBeNull()
    expect(lane.waitLeft).toBeNull()
    expect(lane.notch).toBeNull()
    expect(agent.startedAt).toBeNull()
  })
})

describe('the Agents table renders the absence rather than the previous attempt', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    window.location.hash = '#/'
    resetRouteForTests()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('leaves the wait cell blank-with-a-reason for a re-queued agent', async () => {
    const detail = foldDetail([
      ...ATTEMPT_ONE,
      { t: T0 + 3_599_000, type: 'agent', index: 0, key: 'k0', adapter: 'claude', state: 'queued' },
    ])
    render(
      <>
        <IconSprite />
        <Cockpit runId={detail.runId} storeApi={fixedApi(detail)} />
      </>,
    )
    await screen.findByRole('tablist')
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const row = document.querySelector<HTMLElement>('.at-row:not(.head)')!
    const wait = row.querySelector<HTMLElement>('.c-wait')!
    expect(wait.textContent!.trim()).toBe('')
    expect(wait.querySelector('.absent')!.getAttribute('title'))
      .toBe('no queue event was recorded for this attempt')
  })
})

/**
 * FOLD → COCKPIT for the attempt SELECTOR (§6.4 step 1a, amended: attempt-scoped Timeline).
 *
 * The dishonest surface this closes: the lineage strip said "showing attempt 1" while the
 * Timeline still drew attempt 2 — every replayed lane a `replay` tick at the replay instant
 * — because the Gantt was never handed the selection. The fold now archives each closing
 * scope's agents at the resume boundary (before the round-11 clear), and these cases walk
 * the whole path: events → shared fold → snapshot shape → cockpit → the lane on screen.
 */
describe('the Timeline on an earlier attempt (§6.4 step 1a, amended)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    window.location.hash = '#/'
    resetRouteForTests()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const REPLAYED = [
    ...ATTEMPT_ONE,
    { t: T0 + 3_599_000, type: 'agent', index: 0, key: 'k0', adapter: 'claude', state: 'cached' },
  ]

  it('renders attempt 1’s real execution bar — no replay badge — and returns honestly', async () => {
    const detail = foldDetail(REPLAYED)
    render(
      <>
        <IconSprite />
        <Cockpit runId={detail.runId} storeApi={fixedApi(detail)} />
      </>,
    )
    await screen.findByRole('tablist')

    // The CURRENT attempt is unchanged from today: the lane is a replay tick.
    expect(document.querySelector('.badge.replay')).not.toBeNull()
    expect(document.querySelector('.lane-track .exec:not(.c)')).toBeNull()

    // Select attempt 1 through the lineage strip.
    fireEvent.click(screen.getAllByRole('radio')[0]!)
    expect(screen.getByText(/showing attempt 1/)).toBeTruthy()

    // The Timeline now shows attempt 1 as it stood when the attempt ended: a real bar on
    // the attempt's own window, no replay badge — the agent EXECUTED in that attempt.
    expect(screen.getByText(/attempt 1 — agents as they stood when this attempt ended/)).toBeTruthy()
    expect(document.querySelector('.badge.replay')).toBeNull()
    const exec = document.querySelector<HTMLElement>('.lane-track .exec')!
    expect(exec).not.toBeNull()
    // …and a closed attempt has no "now", whatever the run is doing at the moment.
    expect(document.querySelector('.now-line')).toBeNull()

    // Back to current restores the live view exactly.
    fireEvent.click(screen.getByRole('button', { name: 'back to current' }))
    expect(document.querySelector('.badge.replay')).not.toBeNull()
  })

  it('clamps the axis to the attempt’s own window, not the whole lineage', async () => {
    const detail = foldDetail(REPLAYED)
    render(
      <>
        <IconSprite />
        <Cockpit runId={detail.runId} storeApi={fixedApi(detail)} />
      </>,
    )
    await screen.findByRole('tablist')
    fireEvent.click(screen.getAllByRole('radio')[0]!)
    // Attempt 1 ran T0 → T0+3_100 (its terminal event), so on the attempt's own axis the
    // bar starts at the window's left edge (`left` ≈ 0) and spans ~96.8% of the 3_100 ms
    // window (queued at T0, done at T0+3_000). The width is what catches a missing clamp:
    // against the whole ~3.6e6 ms lineage span the same bar would be a <0.1% sliver.
    const bar = document.querySelector<HTMLElement>('.lane-track .bar')!
    expect(parseFloat(bar.style.left)).toBeCloseTo((0 / 3_100) * 100, 1)
    expect(parseFloat(bar.style.width)).toBeCloseTo((3_000 / 3_100) * 100, 1)
  })

  it('a multi-resume lane with no events in the shown attempt leaks no other attempt’s metadata', async () => {
    // Codex round 2: the fold archives every globally known agent into a closing scope,
    // including agents the attempt never touched — so after several resumes, an agent
    // cached or completed in attempt 1 could show a `replay` badge or attempt 1's runtime
    // beside "no events in this attempt" while attempt 2 was selected. Three attempts:
    // attempt 1 has a cross-run cache hit AND a real execution, attempt 2 opens and dies
    // with NO agent events, attempt 3 is current. Selecting attempt 2 must render both
    // lanes as the explicit badge and NOTHING carried over.
    const detail = foldDetail([
      { t: T0, type: 'run', state: 'started', engine: '0.2.0', concurrency: 2 },
      { t: T0 + 500, type: 'agent', index: 0, key: 'k0', label: 'seeded', adapter: 'claude', state: 'cached', seededFrom: 'r_prev' },
      { t: T0 + 1_000, type: 'agent', index: 1, key: 'k1', label: 'worker', adapter: 'claude', state: 'queued' },
      { t: T0 + 2_000, type: 'agent', index: 1, state: 'running', waitMs: 1_000 },
      { t: T0 + 4_000, type: 'agent', index: 1, state: 'done', durationMs: 2_000 },
      { t: T0 + 4_100, type: 'run', state: 'completed' },
      { t: T0 + 10_000, type: 'run', state: 'resumed' },
      { t: T0 + 10_500, type: 'run', state: 'interrupted' },
      { t: T0 + 20_000, type: 'run', state: 'resumed' },
    ])
    render(
      <>
        <IconSprite />
        <Cockpit runId={detail.runId} storeApi={fixedApi(detail)} />
      </>,
    )
    await screen.findByRole('tablist')
    fireEvent.click(screen.getAllByRole('radio')[1]!)
    expect(screen.getByText(/showing attempt 2/)).toBeTruthy()
    expect(screen.getByText(/attempt 2 — agents as they stood when this attempt ended/)).toBeTruthy()

    const tl = document.querySelector<HTMLElement>('.tl')!
    // Both lanes are on the roster, and both say the one thing the attempt supports.
    expect(tl.querySelectorAll('.lane')).toHaveLength(2)
    expect(screen.getAllByText('no events in this attempt')).toHaveLength(2)
    // The leaks: no replay badge for attempt 1's cache hit, no duration figure for
    // attempt 1's execution, no wait chip, no geometry, no error badges.
    expect(tl.querySelector('.badge.replay')).toBeNull()
    expect(tl.querySelector('.dur')).toBeNull()
    expect(tl.querySelector('.chip.q')).toBeNull()
    expect(tl.querySelector('.lane-track .bar')).toBeNull()
    expect(tl.querySelector('.badge.err')).toBeNull()
  })

  it('degrades honestly when the snapshot archived no agents for the attempt', async () => {
    const detail = foldDetail(REPLAYED)
    // The pre-archival wire: the scope exists, its `agents` key does not.
    delete (detail.attemptScopes![0] as Record<string, unknown>)['agents']
    render(
      <>
        <IconSprite />
        <Cockpit runId={detail.runId} storeApi={fixedApi(detail)} />
      </>,
    )
    await screen.findByRole('tablist')
    fireEvent.click(screen.getAllByRole('radio')[0]!)
    // An explicit absence — never attempt 2's replay tick under attempt 1's label.
    expect(screen.getByText(/recorded no per-attempt agent timing for attempt 1/)).toBeTruthy()
    expect(document.querySelector('.lane-track')).toBeNull()
    expect(document.querySelector('.badge.replay')).toBeNull()
  })
})
