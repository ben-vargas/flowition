// §2.4.1's model — parity #47–#51 as arithmetic, before #119 proves the same rules
// survive a real render.

import { describe, expect, it } from 'vitest'
import {
  doneCount, phaseCounts, phaseGroups, phaseOpen, pendingLabel, rollupState, toggleKey,
} from './phases.js'
import { COLUMNS, nextSort, outputTokens, sortAgents, sortValue } from './agents.js'
import { deriveHonesty } from './honesty.js'
import { AGENTS, DEAD_STRUCTURED_RUN, LEGACY_RUN, LIVE_RUN, NOW } from './fixtures.js'
import type { AgentView, RunDetail } from '../../api/types.js'

/** The screen's verdict, which every §6.4-step-8 rule below reads (`honesty.ts`). */
const honestyOf = (detail: RunDetail) => deriveHonesty(detail, { now: NOW })
const group = (index: number) => phaseGroups(LIVE_RUN).find((g) => g.phaseIndex === index)!

describe('grouping (#47, #51)', () => {
  it('puts declared phases first, in declaration order', () => {
    expect(phaseGroups(LIVE_RUN).map((g) => g.title)).toEqual(['Survey', 'Review', 'Report'])
  })

  it('marks a declared-but-unreached phase pending, and "not run" once terminal (#48)', () => {
    const report = group(2)
    expect(report.pending).toBe(true)
    expect(report.agents).toHaveLength(0)
    expect(pendingLabel(honestyOf(LIVE_RUN))).toBe('pending')
    expect(pendingLabel(honestyOf({ ...LIVE_RUN, state: 'completed' }))).toBe('not run')
    expect(pendingLabel(honestyOf({ ...LIVE_RUN, state: 'stale' }))).toBe('not run')
    // The quiescent tier is "not run" too — the phase will never be entered (round 6).
    expect(pendingLabel(honestyOf({ ...LIVE_RUN, state: 'corrupt-result' }))).toBe('not run')
  })

  it('appends observed phases that were never declared, in phaseIndex order', () => {
    const detail: RunDetail = {
      ...LIVE_RUN,
      declaredPhases: [{ title: 'Survey' }],
      phases: [
        { phaseIndex: 2, title: 'Late', agentIndices: [], reached: true, approximate: false },
        { phaseIndex: 1, title: 'Review', agentIndices: [], reached: true, approximate: false },
        { phaseIndex: 0, title: 'Survey', agentIndices: [], reached: true, approximate: false },
      ],
    }
    expect(phaseGroups(detail).map((g) => g.title)).toEqual(['Survey', 'Review', 'Late'])
  })

  it('never drops an agent with no phase — it gets its own trailing section (#51)', () => {
    const detail: RunDetail = {
      ...LIVE_RUN,
      agents: [...LIVE_RUN.agents, { ...AGENTS[0]!, index: 42, phaseIndex: null }],
    }
    const groups = phaseGroups(detail)
    const trailing = groups[groups.length - 1]!
    expect(trailing.phaseIndex).toBeNull()
    expect(trailing.title).toBe('no phase')
    expect(trailing.agents.map((a) => a.index)).toEqual([42])
  })

  it('gives an agent whose phaseIndex no phase event named a group rather than a hole', () => {
    const detail: RunDetail = {
      ...LIVE_RUN,
      declaredPhases: null,
      phases: [],
      agents: [{ ...AGENTS[0]!, phaseIndex: 7 }],
    }
    expect(phaseGroups(detail).map((g) => g.title)).toEqual(['phase 7'])
  })
})

describe('roll-up (#49)', () => {
  const at = (state: AgentView['state']): AgentView => ({ ...AGENTS[0]!, state })

  it('is failed > running > queued > cached > done', () => {
    expect(rollupState([at('done'), at('running'), at('failed')])!.state).toBe('failed')
    expect(rollupState([at('done'), at('running')])!.state).toBe('running')
    expect(rollupState([at('done'), at('queued')])!.state).toBe('queued')
    expect(rollupState([at('done'), at('cached')])!.state).toBe('cached')
    expect(rollupState([at('done')])!.state).toBe('done')
    expect(rollupState([])).toBeNull()
  })

  it('treats cancelled as terminal non-success, not as merely running', () => {
    expect(rollupState([at('running'), at('cancelled')])!.state).toBe('cancelled')
  })

  // Round 3 left the rollup reading raw state on purpose, and a dead run's Audit phase
  // therefore rolled up to `running` and spun (review round 4, B1).
  describe('on a run that has stopped (§6.4 step 8, parity #58)', () => {
    it('keeps the state the phase CONTAINS and marks it orphaned', () => {
      const live = rollupState([at('done'), at('running')], false)!
      expect(live).toEqual({ state: 'running', orphaned: false })
      const dead = rollupState([at('done'), at('running')], true)!
      // Not rewritten to `orphaned`: the phase still holds a running agent, and a reader
      // who cannot see that cannot tell a phase of one from a phase of five.
      expect(dead).toEqual({ state: 'running', orphaned: true })
      expect(rollupState([at('done'), at('queued')], true)).toEqual({ state: 'queued', orphaned: true })
    })

    it('leaves a terminal roll-up alone — nothing about it claims liveness', () => {
      expect(rollupState([at('failed'), at('running')], true))
        .toEqual({ state: 'failed', orphaned: false })
      expect(rollupState([at('done')], true)).toEqual({ state: 'done', orphaned: false })
    })

    it('takes the server\'s per-agent post-pass as authority even on a live run', () => {
      const stranded: AgentView = { ...at('running'), displayState: 'orphaned' }
      expect(rollupState([stranded], false)).toEqual({ state: 'running', orphaned: true })
      // …but ONE stranded agent does not silence a phase that still has a live one.
      expect(rollupState([stranded, at('running')], false))
        .toEqual({ state: 'running', orphaned: false })
    })

    it('counts stranded agents as orphaned in words too', () => {
      const dead = phaseGroups(DEAD_STRUCTURED_RUN)
      const review = dead.find((g) => g.title === 'Review')!
      expect(review.rollup).toEqual({ state: 'failed', orphaned: false })
      expect(phaseCounts(review)).toContain('4 orphaned')
      expect(phaseCounts(review)).not.toContain('running')
      expect(phaseCounts(review)).not.toContain('queued')
    })
  })

  it('counts a cached agent as done — it produced its result', () => {
    expect(doneCount(group(0).agents)).toBe(3)
    expect(phaseCounts(group(0))).toBe('2 done · 1 cached · 3/3')
  })

  it('omits absent categories from the count line rather than zeroing them', () => {
    expect(phaseCounts(group(0))).not.toContain('0 ')
  })
})

describe('collapse (#50)', () => {
  const survey = group(0)   // all done/cached
  const review = group(1)   // mixed, contains agent 5
  const report = group(2)   // pending

  it('auto-collapses a phase whose agents are all done or cached', () => {
    expect(phaseOpen(survey, { toggled: undefined, selectedAgent: null })).toBe(false)
  })

  it('defaults open when it contains the selected agent', () => {
    expect(phaseOpen(review, { toggled: undefined, selectedAgent: 5 })).toBe(true)
    // …and that beats the auto-collapse rule for a finished phase too.
    expect(phaseOpen(survey, { toggled: undefined, selectedAgent: 0 })).toBe(true)
  })

  it('keeps a pending phase closed', () => {
    expect(phaseOpen(report, { toggled: undefined, selectedAgent: null })).toBe(false)
  })

  it('lets an explicit toggle override BOTH automatic rules', () => {
    expect(phaseOpen(survey, { toggled: true, selectedAgent: null })).toBe(true)
    expect(phaseOpen(review, { toggled: false, selectedAgent: 5 })).toBe(false)
  })

  it('keys the override by (runId, phaseIndex), no-phase included', () => {
    expect(toggleKey('r_1', 0)).toBe('r_1::0')
    expect(toggleKey('r_1', null)).toBe('r_1::none')
    expect(toggleKey('r_2', 0)).not.toBe(toggleKey('r_1', 0))
  })
})

describe('the agents table\'s sort (#53)', () => {
  // Every sort now reads the screen's §6.4 step 8 verdict, because two columns are
  // readings rather than record fields (`agents.ts` — round 8, B2).
  const LIVE = honestyOf(LIVE_RUN)

  it('sorts by cost descending on the first click, and flips on the second', () => {
    expect(nextSort({ key: 'index', dir: 'asc' }, 'cost')).toEqual({ key: 'cost', dir: 'desc' })
    expect(nextSort({ key: 'cost', dir: 'desc' }, 'cost')).toEqual({ key: 'cost', dir: 'asc' })
  })

  it('puts agents with NO value last in both directions — absent is not zero', () => {
    const rows = sortAgents(LIVE_RUN.agents, 'cost', 'asc', LIVE)
    // agents 8 and 9 are queued and reported no usage at all.
    expect(rows.slice(-3).map((a) => a.index).sort()).toEqual([4, 8, 9])
    const desc = sortAgents(LIVE_RUN.agents, 'cost', 'desc', LIVE)
    expect(desc.slice(-3).map((a) => a.index).sort()).toEqual([4, 8, 9])
    expect(desc[0]!.index).toBe(5)
  })

  it('breaks ties on index so the order is stable across re-renders', () => {
    const rows = sortAgents(LIVE_RUN.agents, 'attempts', 'desc', LIVE)
    const ones = rows.filter((a) => a.attempts === 1).map((a) => a.index)
    expect(ones).toEqual([...ones].sort((a, b) => a - b))
  })

  // The lifetime arithmetic itself is `tokens.test.ts`; this pins the ONE property the
  // sort depends on — that it is the same figure the cells show.
  it('sorts on the lifetime figure, not on the live counter', () => {
    const honesty = honestyOf(LIVE_RUN)
    expect(outputTokens(LIVE_RUN.agents[5]!, honesty)).toEqual({ value: 118_600, live: true })
    expect(outputTokens(LIVE_RUN.agents[0]!, honesty)).toEqual({ value: 38_100, live: false })
    expect(sortValue(LIVE_RUN.agents[5]!, 'output', LIVE)).toBe(118_600)
    expect(sortAgents(LIVE_RUN.agents, 'output', 'desc', LIVE)[0]!.index).toBe(5)
  })

  it('reports every column as sortable, and counts as never-absent', () => {
    for (const column of COLUMNS) {
      expect(() => sortAgents(LIVE_RUN.agents, column.key, 'asc', LIVE)).not.toThrow()
    }
    expect(sortValue(LEGACY_RUN.agents[1]!, 'attempts', honestyOf(LEGACY_RUN))).toBe(1)
    expect(sortValue(LEGACY_RUN.agents[1]!, 'cost', honestyOf(LEGACY_RUN))).toBeNull()
  })
})

describe('degraded phase association (§6.4 step 8)', () => {
  it('carries the approximate flag up to the group', () => {
    const detail: RunDetail = {
      ...LEGACY_RUN,
      agents: LEGACY_RUN.agents.map((a) => ({ ...a, phaseIndex: 0, phaseApproximate: true })),
      phases: [],
      declaredPhases: null,
    }
    expect(phaseGroups(detail)[0]!.approximate).toBe(true)
  })
})
