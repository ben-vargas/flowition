/**
 * §2.1 Q4's arithmetic: how many tokens has this agent actually spent?
 *
 * The whole file exists because the obvious answer is wrong. `usage-cum` speaks two
 * dialects (src/journal.js:5–8) — a provider thread's cumulative totals, and a job's own
 * per-attempt running totals whose counter restarts at `{0,0}`
 * (src/agent-proc.js:42,482,520) — and the LAST record of the stream is the lifetime
 * figure in the first dialect and the current attempt's figure in the second. Reading it
 * as though it were always the former undercounts every resumed agent on half the
 * adapters, and it undercounts them most where it matters: on the agents that have been
 * retried, which are the ones burning the budget (review round 4, B3).
 *
 * Every case below is written from the ADVERSARIAL side first: the reset dialect, then
 * the continued one, then the seam between the server's join and the client's delta.
 */

import { describe, expect, it } from 'vitest'
import type { AgentView } from '../../api/types.js'
import { inputTokens, outputTokens, tokenScale, tokenShare } from './agents.js'
import { deriveHonesty } from './honesty.js'
import { AGENTS, CORRUPT_RUN, LIVE_RUN, NOW } from './fixtures.js'
import {
  applyJournalJoin, createJournalBase, createJournalDelta, ingestJournalRecord,
  type JournalBase, type JournalFacts,
} from '../../fold/journalJoin.js'
import { deriveCaps, fold, materializeFold, type MaterializedFold } from '../../fold/index.js'

const at = (over: Partial<AgentView>): AgentView => ({ ...AGENTS[0]!, ...over })

// The `live` mark is a claim about the RUN as much as about the agent, so these figures are
// always read through the screen's honesty verdict (`honesty.ts`) rather than through
// `agent.state` — see the `live` block at the foot of the first describe.
const LIVE = deriveHonesty(LIVE_RUN, { now: NOW })
const QUIESCENT = deriveHonesty(CORRUPT_RUN, { now: NOW })

describe('lifetime-to-date tokens (§6.2 `cumTokens`, Q4)', () => {
  it('THE RESET CASE: a restarted counter adds to what settled, it does not replace it', () => {
    // Two settled attempts charged 90k output; the third attempt's counter went back to
    // zero and has produced 28.6k since. `liveTokens` alone says 28.6k — less than a
    // THIRD of the truth — and `usage` alone says 90k, which is stale by a whole attempt.
    const agent = at({
      state: 'running',
      usage: { input: 300_000, output: 90_000, cost: 3.2 },
      liveTokens: { input: 102_900, output: 28_600 },
      cumTokens: { input: 402_900, output: 118_600 },
    })
    expect(outputTokens(agent, LIVE)).toEqual({ value: 118_600, live: true })
    expect(inputTokens(agent, LIVE)).toEqual({ value: 402_900, live: true })
  })

  it('THE CONTINUED CASE: a thread-cumulative report is never added to the settled sum', () => {
    // The provider thread carried on across the resume, so its cum ALREADY contains the
    // 12k the settled result record charged. 17k is the answer; 29k would be a lie with
    // a plausible face, and is what a naive `usage + cum` produces.
    const agent = at({
      state: 'running',
      usage: { input: 40_000, output: 12_000, cost: 0.5 },
      liveTokens: { input: 55_000, output: 17_000 },
      cumTokens: { input: 55_000, output: 17_000 },
    })
    expect(outputTokens(agent, LIVE).value).toBe(17_000)
    expect(inputTokens(agent, LIVE).value).toBe(55_000)
  })

  it('takes whichever source is ahead — result records can outrun the cum stream', () => {
    // An adapter that reports usage only at attempt end journals a result record and no
    // useful cum at all. `max` keeps the settled figure; a cum-first rule would zero it.
    const agent = at({
      state: 'done',
      usage: { input: 9_000, output: 4_000, cost: 0.1 },
      cumTokens: { input: 0, output: 0 },
    })
    expect(outputTokens(agent, LIVE)).toEqual({ value: 4_000, live: false })
  })

  it('stays ABSENT when neither source reported — blank, never 0 (#53)', () => {
    expect(outputTokens(at({ state: 'queued', usage: null, cumTokens: null }), LIVE))
      .toEqual({ value: null, live: false })
  })

  it('marks live from the RUN\'s liveness and the agent\'s, never from which figure won', () => {
    // The reset agent's lifetime comes from `cumTokens`, and it is still moving.
    expect(outputTokens(LIVE_RUN.agents[5]!, LIVE).live).toBe(true)
    // A settled agent carrying a leftover cum is NOT live.
    expect(outputTokens(at({ state: 'done', liveTokens: { input: 1, output: 2 } }), LIVE).live).toBe(false)
  })

  /**
   * Round 6, B1. `corrupt-result` is §5.4.2's quiescent tier: the engine is gone and only
   * the result file is unreadable, so the SAME agent — same state, same `liveTokens`, same
   * record on disk — is no longer producing anything. The figure survives; the claim that
   * it is still moving does not.
   */
  it('drops the live mark the moment the RUN stops, on an unchanged agent', () => {
    const agent = LIVE_RUN.agents[5]!
    expect(agent.state).toBe('running')          // nothing about the agent changed…
    expect(outputTokens(agent, LIVE).live).toBe(true)
    expect(outputTokens(agent, QUIESCENT).live).toBe(false)
    // …and the number itself is untouched: this is an honesty rule, not a data rule.
    expect(outputTokens(agent, QUIESCENT).value).toBe(118_600)
    expect(inputTokens(agent, QUIESCENT).live).toBe(false)
  })

  /** An agent the SERVER stranded is not moving either, even while the run is alive. */
  it('drops the live mark for an agent the server marked orphaned on a live run', () => {
    const stranded = at({ state: 'running', displayState: 'orphaned', liveTokens: { input: 1, output: 2 } })
    expect(outputTokens(stranded, LIVE).live).toBe(false)
  })

  it('is what the fixture run reports for both dialects at once', () => {
    // agent 5 restarted its counter, agent 7 continued its thread. Both read lifetime.
    expect(outputTokens(LIVE_RUN.agents[5]!, LIVE).value).toBe(118_600)
    expect(outputTokens(LIVE_RUN.agents[7]!, LIVE).value).toBe(71_400)
  })
})

describe('the Q4 token bars', () => {
  const rows = LIVE_RUN.agents
  const scale = tokenScale(rows)

  it('scales to the busiest agent, so the budget eater is a full bar', () => {
    expect(scale).toBe(118_600)
    expect(tokenShare(rows[5]!, scale)).toBe(1)
  })

  it('is proportional to the LIFETIME figure, not to the live counter', () => {
    // 71.4k of 118.6k. Under the old live-counter reading agent 5 measured 28.6k and this
    // bar would have been the LONGER of the two — the chart would have pointed at the
    // wrong agent, which is the only thing a burn chart has to get right.
    expect(tokenShare(rows[7]!, scale)).toBeCloseTo(71_400 / 118_600, 6)
    expect(tokenShare(rows[7]!, scale)!).toBeLessThan(tokenShare(rows[5]!, scale)!)
  })

  it('draws NO bar for an agent that reported nothing (#53)', () => {
    expect(tokenShare(rows[8]!, scale)).toBeNull()
  })

  it('survives a run where nothing reported at all, without dividing by zero', () => {
    const quiet = [at({ usage: null, cumTokens: null })]
    expect(tokenScale(quiet)).toBe(0)
    expect(tokenShare(quiet[0]!, 0)).toBeNull()
    expect(tokenShare(at({ usage: { input: 0, output: 0, cost: 0 } }), 0)).toBe(0)
  })
})

/**
 * The chain itself, at the layer that builds it. The cockpit reads `cumTokens` off the
 * wire, so a cockpit-only test would only prove that the fixture agrees with itself —
 * which is exactly the shape of test that let this defect through the first time.
 */
describe('the client journal join builds the chain (§6.4 J)', () => {
  /** One running agent, projected through the real fold rather than a hand-built object. */
  const project = (): MaterializedFold => {
    const events = [
      { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
      { t: 2, type: 'agent', index: 0, key: 'k0', adapter: 'mock', state: 'running' },
    ]
    let o = 0
    const raw = fold(null, events.map((rec) => ({ o: (o += JSON.stringify(rec).length + 1), rec })))
    return materializeFold(raw, 'running', deriveCaps(raw.run))
  }

  const stream = (records: Record<string, unknown>[]) => {
    const delta = createJournalDelta()
    for (const rec of records) ingestJournalRecord(delta, rec)
    return delta
  }

  /** The server's join, as `journalBaseFromDetail` would have captured it. */
  const seeded = (facts: Partial<JournalFacts>): JournalBase => {
    const base = createJournalBase()
    base.byKey.set('k0', {
      attempts: 0, usage: null, attemptUsage: null, durationMs: null,
      resultPreview: null, resultBytes: null, resultTruncated: false, sessionId: null,
      liveTokens: null, cumTokens: null, ...facts,
    })
    return base
  }

  const joined = (base: JournalBase, records: Record<string, unknown>[]): AgentView => {
    const projected = project()
    applyJournalJoin(projected, base, stream(records))
    return projected.agents[0] as AgentView
  }

  it('banks a per-attempt counter across its {0,0} restart', () => {
    const agent = joined(createJournalBase(), [
      { type: 'usage-cum', key: 'k0', cum: { input: 100, output: 40 } },
      { type: 'usage-cum', key: 'k0', cum: { input: 300, output: 90 } },
      // attempt 2 starts: the adapter zeroes its own totals (src/agent-proc.js:42)
      { type: 'usage-cum', key: 'k0', cum: { input: 0, output: 0 } },
      { type: 'usage-cum', key: 'k0', cum: { input: 50, output: 25 } },
    ])
    // The live counter is the restart. The chain is everything the agent ever burned.
    expect(agent.liveTokens).toEqual({ input: 50, output: 25 })
    expect(agent.cumTokens).toEqual({ input: 350, output: 115 })
    expect(outputTokens(agent, LIVE).value).toBe(115)
  })

  it('counts a continued cumulative report ONCE, not once per record', () => {
    const agent = joined(createJournalBase(), [
      { type: 'usage-cum', key: 'k0', cum: { input: 100, output: 40 } },
      { type: 'usage-cum', key: 'k0', cum: { input: 260, output: 95 } },
    ])
    expect(agent.cumTokens).toEqual({ input: 260, output: 95 })
  })

  it('closes the seam: the delta\'s first record is measured against the SERVER\'s last', () => {
    // The snapshot already chained 260/95 and its last cum record was 260/95. The stream
    // resumes at 300/120 — a 40/25 increment, NOT another 300/120 to bank on top.
    const base = seeded({
      liveTokens: { input: 260, output: 95 }, cumTokens: { input: 260, output: 95 },
    })
    expect(joined(base, [{ type: 'usage-cum', key: 'k0', cum: { input: 300, output: 120 } }]).cumTokens)
      .toEqual({ input: 300, output: 120 })
  })

  it('closes the same seam across a restart the STREAM delivers', () => {
    const base = seeded({
      liveTokens: { input: 260, output: 95 }, cumTokens: { input: 260, output: 95 },
    })
    expect(joined(base, [
      { type: 'usage-cum', key: 'k0', cum: { input: 0, output: 0 } },
      { type: 'usage-cum', key: 'k0', cum: { input: 70, output: 30 } },
    ]).cumTokens).toEqual({ input: 330, output: 125 })
  })

  it('is idempotent — recomposing the same delta does not double the chain', () => {
    const base = seeded({
      liveTokens: { input: 100, output: 40 }, cumTokens: { input: 100, output: 40 },
    })
    const records = [{ type: 'usage-cum', key: 'k0', cum: { input: 180, output: 70 } }]
    const delta = stream(records)
    const once = project()
    applyJournalJoin(once, base, delta)
    const twice = project()
    applyJournalJoin(twice, base, delta)
    expect((twice.agents[0] as AgentView).cumTokens)
      .toEqual((once.agents[0] as AgentView).cumTokens)
    expect((twice.agents[0] as AgentView).cumTokens).toEqual({ input: 180, output: 70 })
  })
})
