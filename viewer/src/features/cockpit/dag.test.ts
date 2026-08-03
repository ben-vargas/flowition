// The Structure tab's model (§2.4, Q6) and the log lane's history merge (§5.4.6).

import { describe, expect, it } from 'vitest'
import { cellAgents, cellEmpty, emptyReason, structureModel } from './dag.js'
import { deriveHonesty } from './honesty.js'
import { filterLogs, logKey, logsFromPage, mergeLogPages } from './LogLane.js'
import { CORRUPT_RUN, LEGACY_RUN, LIVE_RUN, NESTED_RUN, NOW, T0 } from './fixtures.js'
import type { AgentView, LogView, RunDetail } from '../../api/types.js'

// The structure model now takes the screen's §6.4 step 8 verdict, because an empty cell's
// reason is a sentence about the present (round 7, B2).
const verdict = (detail: RunDetail) => deriveHonesty(detail, { now: NOW })
const LIVE = verdict(LIVE_RUN)
const NESTED = verdict(NESTED_RUN)

const model = () => structureModel(LIVE_RUN.structure, LIVE_RUN.agents, LIVE)

describe('containers come from the fold\'s E2 tree, not from re-derived agent paths', () => {
  it('reads the fan and the grid off the tree the fanout events scaffolded', () => {
    const m = model()
    expect(m.containers.map((c) => c.label)).toEqual(['parallel(3)', 'pipeline(5 × 2)'])
    expect(m.containers[0]!.items).toHaveLength(3)
    expect(m.containers[1]!.items).toHaveLength(5)
    expect(m.containers[1]!.items[0]!.cells).toHaveLength(2)
  })

  it('counts materialised slots against the width the ENGINE declared', () => {
    // 7 of 10: five stage-0 agents, two stage-1 agents queued so far.
    expect(model().containers[1]!.slots).toEqual({ filled: 7, total: 10 })
  })

  it('claims every agent exactly once, and leaves nothing loose here', () => {
    const m = model()
    const claimed = m.containers.flatMap((c) => c.agents.map((a) => a.index))
    expect([...claimed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(m.loose).toHaveLength(0)
  })

  it('badges a container with the phase its agents agree on, and only then', () => {
    const m = model()
    expect(m.containers[0]!.phase?.index).toBe(0)
    const mixed = structureModel(LIVE_RUN.structure, LIVE_RUN.agents.map((a, i) => (
      i === 0 ? { ...a, phaseIndex: 9 } : a
    )), LIVE)
    expect(mixed.containers[0]!.phase).toBeNull()
  })

  it('surfaces an agent that belongs to no container rather than dropping it', () => {
    const orphan: AgentView = { ...LIVE_RUN.agents[0]!, index: 99, path: null }
    const m = structureModel(LIVE_RUN.structure, [...LIVE_RUN.agents, orphan], LIVE)
    expect(m.loose.map((a) => a.index)).toEqual([99])
  })

  it('rolls up cost and duration from the JOINED agents, not from node.rollup', () => {
    // `materializeFold` computes `rollup.costUsd` before the journal join restores each
    // agent's `usage`, so on the client every container's own figure is 0. Summing the
    // resolved agents is right on both sides.
    const m = model()
    expect(m.containers[0]!.cost).toBeCloseTo(0.712 + 0.418 + 0.121, 6)
    expect(m.containers[0]!.durationMs).toBe(134_000 + 118_000)
  })

  it('keeps a nested container INSIDE the cell that owns it', () => {
    const m = structureModel(NESTED_RUN.structure, NESTED_RUN.agents, NESTED)
    // One top-level container, not two unrelated siblings.
    expect(m.containers.map((c) => c.label)).toEqual(['pipeline(2 × 2)'])
    const owner = m.containers[0]!.items[0]!.cells[0]!
    expect(owner.children.map((c) => c.label)).toEqual(['parallel(2)'])
    expect(owner.children[0]!.depth).toBe(1)
    // The owning cell has NO direct agents — which is exactly the case that used to print
    // "not created" over a nested fan-out that demonstrably ran.
    expect(owner.agents).toHaveLength(0)
    expect(cellEmpty(owner)).toBe(false)
    expect(owner.reason).toBeNull()
    expect(cellAgents(owner).map((a) => a.index)).toEqual([0, 1])
  })

  it('rolls the nested agents up into the parent, and claims each exactly once', () => {
    const m = structureModel(NESTED_RUN.structure, NESTED_RUN.agents, NESTED)
    const pipeline = m.containers[0]!
    expect(pipeline.agents.map((a) => a.index).sort()).toEqual([0, 1, 2])
    expect(pipeline.cost).toBeCloseTo(0.11, 6)
    // 2 of 4 slots: item 0's stage 0 (via the nested fan) and item 1's stage 0.
    expect(pipeline.slots).toEqual({ filled: 2, total: 4 })
    expect(m.loose).toHaveLength(0)
  })

  it('treats a nested fan-out as evidence that its stage RAN, for the next stage\'s reason', () => {
    const m = structureModel(NESTED_RUN.structure, NESTED_RUN.agents, NESTED)
    const stage1 = m.containers[0]!.items[0]!.cells[1]!
    // Stage 0 ran (inside the nested parallel) and one of its agents is still running, so
    // stage 1 is "not created — stage 0 still running", not a bare "not created".
    expect(stage1.reason).toBe('not created — stage 0 still running')
  })

  it('reports a container whose agents priced nothing as null, never as $0', () => {
    const priceless = LIVE_RUN.agents.map((a) => ({ ...a, usage: null }))
    const m = structureModel(LIVE_RUN.structure, priceless, LIVE)
    expect(m.containers[0]!.cost).toBeNull()
  })

  it('is empty — not broken — on a run with no fanout events at all', () => {
    const m = structureModel(LEGACY_RUN.structure, LEGACY_RUN.agents, verdict(LEGACY_RUN))
    expect(m.containers).toHaveLength(0)
    expect(m.loose).toHaveLength(2)
  })
})

describe('an empty cell states WHY, never a dash', () => {
  const stages = { titleOf: (s: number) => `stage ${s}` }
  const at = (state: AgentView['state']): AgentView => ({ ...LIVE_RUN.agents[0]!, state })
  const DEAD = verdict(CORRUPT_RUN)

  it('distinguishes a permanent outcome from a pending one', () => {
    expect(emptyReason(1, [at('failed')], stages, LIVE)).toBe('skipped — stage 0 failed')
    expect(emptyReason(1, [at('cancelled')], stages, LIVE)).toBe('skipped — stage 0 was cancelled')
    expect(emptyReason(1, [at('running')], stages, LIVE)).toBe('not created — stage 0 still running')
    expect(emptyReason(1, [at('queued')], stages, LIVE)).toBe('not created — stage 0 still running')
  })

  /**
   * Round 7's B2, at the unit. "Still running" is a promise the cell will fill in, and a
   * dead run cannot keep it — the agent is stranded, not working. The settled outcomes are
   * unaffected: `failed` reads the same whoever is asking.
   */
  it('will not say "still running" once the engine is gone', () => {
    expect(emptyReason(1, [at('running')], stages, DEAD)).toBe('not created — stage 0 was orphaned')
    expect(emptyReason(1, [at('queued')], stages, DEAD)).toBe('not created — stage 0 was orphaned')
    expect(emptyReason(1, [at('failed')], stages, DEAD)).toBe('skipped — stage 0 failed')
    expect(emptyReason(1, [at('done')], stages, DEAD)).toBe('not created')
  })

  it('keeps "still running" where ONE predecessor is genuinely moving', () => {
    expect(emptyReason(1, [at('running'), at('done')], stages, LIVE))
      .toBe('not created — stage 0 still running')
    // The server's own post-pass is honoured on a live run too: an agent it already marked
    // orphaned is not evidence that anything is moving.
    const stranded: AgentView = { ...at('running'), displayState: 'orphaned' }
    expect(emptyReason(1, [stranded], stages, LIVE)).toBe('not created — stage 0 was orphaned')
  })

  it('says only "not created" where nothing upstream explains it', () => {
    expect(emptyReason(0, null, stages, LIVE)).toBe('not created')
    expect(emptyReason(1, [], stages, LIVE)).toBe('not created')
    expect(emptyReason(1, [at('done')], stages, LIVE)).toBe('not created')
    expect(emptyReason(null, null, stages, LIVE)).toBe('not created')
  })

  it('produces those reasons for the real fixture: stage 1 waits on a running stage 0', () => {
    const m = model()
    const item2 = m.containers[1]!.items.find((i) => i.i === 2)!
    expect(item2.cells[1]!.agents).toHaveLength(0)
    expect(item2.cells[1]!.reason).toBe('not created — stage 0 still running')
    const item1 = m.containers[1]!.items.find((i) => i.i === 1)!
    expect(item1.cells[1]!.reason).toBe('skipped — stage 0 failed')
  })

  /**
   * The same fixture on a quiescent run. `CORRUPT_RUN` carries `LIVE_RUN`'s containers and
   * agents verbatim and deliberately arrives with NO `displayState` post-pass applied — so
   * these cells are exactly the two the reviewer read as "still running" on a run whose
   * engine `deriveRunState` had already found gone (src/run-state.js:141–152).
   */
  it('re-words the SAME cells on a quiescent run', () => {
    const m = structureModel(CORRUPT_RUN.structure, CORRUPT_RUN.agents, DEAD)
    const reasons = m.containers[1]!.items.flatMap((i) => i.cells.map((c) => c.reason))
    expect(reasons).not.toContain('not created — stage 0 still running')
    expect(reasons).toContain('not created — stage 0 was orphaned')
    // The failed predecessor still reads as the settled fact it is.
    expect(reasons).toContain('skipped — stage 0 failed')
  })

  it('re-words them on a stale run too, whatever the tier of death', () => {
    const stale = { ...LIVE_RUN, state: 'stale' as const, endedAt: null }
    const m = structureModel(stale.structure, stale.agents, verdict(stale))
    const reasons = m.containers[1]!.items.flatMap((i) => i.cells.map((c) => c.reason))
    expect(reasons).not.toContain('not created — stage 0 still running')
    expect(reasons).toContain('not created — stage 0 was orphaned')
  })
})

describe('the log lane\'s backwards paging (§5.4.6)', () => {
  const log = (over: Partial<LogView>): LogView => ({
    at: T0, message: 'm', source: 'workflow', level: 'info', agentIndex: null, ...over,
  })

  it('reads only `log` records out of a raw events page', () => {
    const page = {
      items: [
        { o: 10, rec: { type: 'log', t: T0, message: 'hello', source: 'engine', level: 'warn', agent: 3 } },
        { o: 20, rec: { type: 'agent', t: T0, state: 'running' } },
        { o: 30, rec: { type: 'log', t: T0 + 1, message: 'two' } },
      ],
      start: 0, end: 30, size: 30, eof: false,
    }
    const out = logsFromPage(page)
    expect(out).toHaveLength(2)
    expect(out[0]!.log).toEqual({
      at: T0, message: 'hello', source: 'engine', level: 'warn', agentIndex: 3,
    })
    // §6.4 step 6's defaults: a pre-E12 record is a workflow info line, not a dropped one.
    expect(out[1]!.log.source).toBe('workflow')
    expect(out[1]!.log.level).toBe('info')
  })

  it('never re-adds a record the snapshot tail already shows', () => {
    const tail = [log({ at: T0 + 5, message: 'tail line' })]
    const merged = mergeLogPages([], [
      { o: 1, log: log({ at: T0, message: 'older' }) },
      { o: 2, log: log({ at: T0 + 5, message: 'tail line' }) },
    ], tail)
    expect(merged.map((m) => m.log.message)).toEqual(['older'])
  })

  it('dedupes a re-read window by offset and keeps the list in byte order', () => {
    const first = mergeLogPages([], [
      { o: 20, log: log({ message: 'b' }) },
      { o: 10, log: log({ message: 'a' }) },
    ], [])
    expect(first.map((m) => m.o)).toEqual([10, 20])
    const again = mergeLogPages(first, [{ o: 10, log: log({ message: 'a' }) }], [])
    expect(again).toHaveLength(2)
  })

  it('has an identity that includes every field a duplicate could differ in', () => {
    expect(logKey(log({ message: 'x' }))).not.toBe(logKey(log({ message: 'y' })))
    expect(logKey(log({ agentIndex: 1 }))).not.toBe(logKey(log({ agentIndex: 2 })))
    expect(logKey(log({ level: 'warn' }))).not.toBe(logKey(log({ level: 'info' })))
  })

  it('filters by source and by level', () => {
    const logs = [
      log({ source: 'engine', level: 'error' }),
      log({ source: 'workflow', level: 'info' }),
      log({ source: 'workflow', level: 'warn' }),
    ]
    expect(filterLogs(logs, { source: 'engine', warnOnly: false })).toHaveLength(1)
    expect(filterLogs(logs, { source: 'all', warnOnly: true })).toHaveLength(2)
    expect(filterLogs(logs, { source: 'workflow', warnOnly: true })).toHaveLength(1)
  })
})
