/**
 * Budget **P4** (§10): fold throughput ≥ 50,000 events/s, measured on the pure shared
 * module — "single-pass fold, no per-event allocation of agents map copies".
 *
 * §10's preamble is normative about the harness: "CI multiplies thresholds ×3 for machine
 * variance; the local baseline is an M1/M2." So the assertion is `50_000 / 3` under CI and
 * the full budget locally, and the measured rate is logged either way — a bench whose only
 * output is pass/fail tells you nothing on the day it regresses to 51,000.
 *
 * The corpus is deliberately the *expensive* shape: a wide fan of agents with real state
 * transitions and identity merges, not a stream of one event type. A fold that is fast
 * only on a homogeneous stream is not fast on a real run.
 */

import { describe, expect, it } from 'vitest'

import { fold, materializeFold, type FoldRecord } from './index.js'

const BUDGET_EVENTS_PER_SEC = 50_000
const CI_MULTIPLIER = 3
const AGENTS = 200
const EVENTS = 120_000

function corpus(total: number): FoldRecord[] {
  const recs: FoldRecord[] = []
  let o = 0
  const push = (rec: Record<string, unknown>) => {
    o += JSON.stringify(rec).length + 1
    recs.push({ o, rec })
  }
  push({ t: 0, type: 'run', state: 'started', engine: '0.2.0', concurrency: 8 })
  push({ t: 0, type: 'fanout', kind: 'parallel', path: [{ kind: 'parallel', ordinal: 0, count: AGENTS }], count: AGENTS })
  for (let i = 0; i < AGENTS; i++) {
    push({ t: i, type: 'agent', index: i, key: `k${i}`, adapter: 'mock', state: 'queued', phaseIndex: 0, path: [{ kind: 'parallel', ordinal: 0, count: AGENTS }, { kind: 'item', i }] })
    push({ t: i, type: 'agent', index: i, state: 'running', stallMs: 0 })
  }
  // The bulk: progress annotations and logs, which is what a live run actually emits.
  let t = AGENTS
  while (recs.length < total) {
    const index = recs.length % AGENTS
    push({ t: t++, type: 'agent', index, state: 'progress', tool: 'bash', outputTokens: recs.length, lastOutputAt: t })
    if (recs.length % 7 === 0) push({ t: t++, type: 'log', message: `line ${recs.length}` })
  }
  return recs.slice(0, total)
}

describe('P4 — fold throughput', () => {
  it(`folds ≥ ${BUDGET_EVENTS_PER_SEC.toLocaleString()} events/s`, () => {
    const recs = corpus(EVENTS)
    // Warm the JIT on a slice, so the measurement is of steady state rather than of
    // TurboFan's first pass over a cold function.
    fold(null, recs.slice(0, 2000))

    const started = performance.now()
    const state = fold(null, recs)
    const elapsed = performance.now() - started
    const rate = (recs.length / elapsed) * 1000

    // A fold that skipped the work would also be fast.
    expect(state.agents).toHaveLength(AGENTS)
    expect(state.agents[0]!.lastTool).toBe('bash')

    const budget = process.env.CI ? BUDGET_EVENTS_PER_SEC / CI_MULTIPLIER : BUDGET_EVENTS_PER_SEC
    console.log(
      `P4 fold: ${Math.round(rate).toLocaleString()} events/s `
      + `(${recs.length.toLocaleString()} events in ${elapsed.toFixed(1)} ms; budget ${Math.round(budget).toLocaleString()}/s)`,
    )
    expect(rate).toBeGreaterThanOrEqual(budget)
  })

  it('an incremental delta fold is O(delta), not O(history)', () => {
    // §6.4's whole reason for being incremental: the SSE reducer re-folds one batch onto a
    // state holding the entire run. If that cost scaled with the history, a long run would
    // slow to a crawl exactly when it matters most.
    const history = corpus(60_000)
    const state = fold(null, history)
    let o = state.lastOffset
    const delta: FoldRecord[] = []
    for (let i = 0; i < 500; i++) {
      const rec = { t: i, type: 'agent', index: i % AGENTS, state: 'progress', tool: 'grep', outputTokens: i }
      o += JSON.stringify(rec).length + 1
      delta.push({ o, rec })
    }
    fold(state, delta.slice(0, 50))

    const started = performance.now()
    fold(state, delta)
    const elapsed = performance.now() - started

    // 500 records onto a 60k-record history: generous, but three orders of magnitude away
    // from a re-fold of the history, which is what this is here to catch.
    console.log(`P4 delta: 500 records onto 60k history in ${elapsed.toFixed(2)} ms`)
    expect(elapsed).toBeLessThan(process.env.CI ? 150 : 50)
  })

  it('materializing does not mutate the raw fold (§6.4 step 8)', () => {
    const recs = corpus(5_000)
    const state = fold(null, recs)
    const before = JSON.stringify(state.agents.map((a) => a.state))
    materializeFold(state, 'failed')
    materializeFold(state, 'completed')
    expect(JSON.stringify(state.agents.map((a) => a.state))).toBe(before)
  })
})
