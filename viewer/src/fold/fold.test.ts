/**
 * §11.3: "Fold re-run of the normative cases (same fixtures, imported)."
 *
 * The cases are §11.2's `test/viewer-fold.test.js` list, re-run through the SPA's import
 * path. Running them twice is not redundant: the root suite proves the algorithm, this
 * suite proves the SPA is actually executing THAT algorithm — under a bundler, a
 * different module resolver, and TypeScript's view of the world.
 *
 * It then covers what only the client does: seeding a fold from a `RunDetail` and folding
 * SSE deltas onto it (§9.3).
 */

import { describe, expect, it } from 'vitest'

import {
  createFoldState,
  deriveCaps,
  fanoutsFromStructure,
  fold,
  JOURNAL_DERIVED_FIELDS,
  materializeFold,
  seedFoldState,
  semverGte,
} from './index.js'
import type { FoldRecord } from './index.js'
import {
  applyJournalJoin,
  createJournalBase,
  createJournalDelta,
  journalBaseFromDetail,
} from './journalJoin.js'
import type { Caps, RunDetail, RunState } from '../api/types.js'

const ENGINE = '0.2.0'

/** Byte offsets exactly as the writers produce them: JSON + one newline. */
const records = (events: Record<string, unknown>[], start = 0): FoldRecord[] => {
  let o = start
  return events.map((rec) => ({ o: (o += new TextEncoder().encode(JSON.stringify(rec)).length + 1), rec }))
}

/**
 * A `RunDetail` shaped the way `src/viewer/snapshot.js` shapes one, without touching the
 * filesystem. Only the fold-derived half matters here; the journal-derived half is
 * `journalJoin.test.ts`'s subject.
 */
function detailFrom(events: Record<string, unknown>[], state: RunState = 'running'): RunDetail {
  const raw = fold(null, records(events))
  const caps = deriveCaps(raw.run)
  const p = materializeFold(raw, state, caps)
  const run = (p.run ?? {}) as Record<string, unknown>
  return {
    runId: 'r1',
    name: (run.name as string) ?? null,
    workflowFile: null,
    state,
    liveDetail: null,
    createdAt: 1,
    startedAt: (run.startedAt as number) ?? null,
    endedAt: (run.endedAt as number) ?? null,
    agentCounts: { total: p.agents.length, done: 0, failed: 0, running: 0, cached: 0 },
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
    steps: p.steps,
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

// ---- §6.4 normative cases, re-run -------------------------------------------------------

describe('§6.4 the fold, through the SPA import', () => {
  it('agent transitions clear G11 outcome fields; annotations do not transition', () => {
    const state = fold(null, records([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'failed', error: 'old', code: 'stalled', retryable: true, durationMs: 9, resultPreview: 'bad' },
      { t: 3, type: 'agent', index: 0, state: 'queued' },
      { t: 4, type: 'agent', index: 0, state: 'running', stallMs: 50 },
      { t: 5, type: 'agent', index: 0, state: 'progress', tool: 'grep', outputTokens: 7, lastOutputAt: 4 },
      { t: 6, type: 'agent', index: 0, state: 'steered', origin: 'workflow', delivery: 'queued' },
      { t: 7, type: 'agent', index: 0, state: 'done', durationMs: 3, resultPreview: 'ok' },
    ]))
    const agent = state.agents[0]!
    expect(agent.state).toBe('done')
    expect(agent.error).toBeNull()
    expect(agent.errorCode).toBeNull()
    expect(agent.retryable).toBeNull()
    expect(agent.lastTool).toBe('grep')
    expect(agent.liveTokens).toEqual({ input: 0, output: 7 })
    // Sol-11: never the progress event's own arrival time.
    expect(agent.lastOutputAt).toBe(4)
    // `origin` here exercises fold.js:235's branch, NOT a shape the engine produces: no
    // `steered` emit carries one (src/engine.js:653–660), which is why real provenance is
    // a journal join — see 'steer origin is journal-derived too' below.
    expect(agent.steers).toEqual([{ at: 6, origin: 'workflow', delivery: 'queued' }])
  })

  it('a resumed run clears the terminal latch and scopes phases/logs/mail per attempt (M5)', () => {
    const state = fold(null, records([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'phase', phaseIndex: 0, title: 'first' },
      { t: 3, type: 'log', message: 'old log' },
      { t: 4, type: 'mail', dir: 'out', agent: '0', message: 'old mail' },
      { t: 5, type: 'question', qid: 'q', question: 'old?' },
      { t: 6, type: 'run', state: 'failed', error: 'boom' },
      { t: 7, type: 'run', state: 'resumed' },
      { t: 8, type: 'phase', phaseIndex: 0, title: 'first' },
      { t: 9, type: 'log', message: 'new log' },
      { t: 10, type: 'question', qid: 'q', question: 'old?' },
    ]))
    expect(state.run!.endedAt).toBeNull()
    expect(state.run!.error).toBeNull()
    // The current scope carries the re-executed phase once, not A,B,C,A,B,C.
    expect(state.phases.map((p) => p.title)).toEqual(['first'])
    expect(state.logs.map((l) => l.message)).toEqual(['new log'])
    expect(state.mail).toEqual([])
    expect(state.attemptScopes).toHaveLength(2)
    expect(state.resumeCount).toBe(1)
    // Questions are NOT scoped: a re-ask upserts on its deterministic qid.
    expect(state.questions).toHaveLength(1)
    expect(state.questions[0]!.askedAt).toBe(10)
  })

  it('openQuestions is zeroed and questions abandoned on a terminal run (M6)', () => {
    const raw = fold(null, records([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'question', qid: 'q1', question: 'go?' },
      { t: 3, type: 'run', state: 'interrupted' },
    ]))
    const live = materializeFold(raw, 'running')
    expect(live.openQuestions).toBe(1)
    expect(live.questions[0]!.abandoned).toBe(false)

    const dead = materializeFold(raw, 'interrupted')
    expect(dead.openQuestions).toBe(0)
    expect(dead.questions[0]!.abandoned).toBe(true)
  })

  it('an agent left queued/running inside a dead run displays as orphaned, never a spinner (#58)', () => {
    const raw = fold(null, records([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'agent', index: 0, key: 'a', adapter: 'mock', state: 'running' },
      { t: 3, type: 'run', state: 'failed' },
    ]))
    expect(materializeFold(raw, 'failed').agents[0]!.displayState).toBe('orphaned')
    expect(materializeFold(raw, 'running').agents[0]!.displayState).toBe('running')
  })

  it('caps come from the engine version, never from field presence (M2)', () => {
    const fresh = fold(null, records([{ t: 1, type: 'run', state: 'started', engine: ENGINE }]))
    const caps: Caps = deriveCaps(fresh.run)
    // A zero-agent, brand-new run reports SUPPORTED — no older-engine copy.
    expect(Object.values(caps).every((c) => c === 'supported')).toBe(true)

    const old = fold(null, records([{ t: 1, type: 'run', state: 'started' }]))
    expect(Object.values(deriveCaps(old.run)).every((c) => c === 'unsupported')).toBe(true)

    // No run event yet → pending: loading states, not degradation copy.
    expect(Object.values(deriveCaps(createFoldState().run)).every((c) => c === 'pending')).toBe(true)
    expect(semverGte(ENGINE, '0.1.2')).toBe(true)
    expect(semverGte('0.1.1', '0.1.2')).toBe(false)
  })

  it('a terminal run with no preceding start opens a zero-length stub attempt (N14)', () => {
    const state = fold(createFoldState({ createdAt: 500 }), records([
      { t: 900, type: 'run', state: 'failed', error: 'module load' },
    ]))
    expect(state.attemptSpans).toEqual([
      { state: 'started', t: 500 },
      { state: 'failed', t: 900 },
    ])
  })

  it('unknown event types and unknown agent states degrade, never throw (§6.5)', () => {
    const state = fold(null, records([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'telemetry', payload: 1 },
      { t: 3, type: 'telemetry', payload: 2 },
      { t: 4, type: 'agent', index: 0, key: 'a', adapter: 'mock', state: 'hibernating' },
    ]))
    expect(state.unknownEvents).toBe(2)
    expect(state.unknownEventTypes).toEqual({ telemetry: 2 })
    expect(state.agents[0]!.state).toBe('hibernating')
    // Never coerced to a success state — the renderer shows it neutrally.
    expect(state.agents[0]!.displayState).toBe('hibernating')
  })

  it('incremental folding equals a single batch fold (the SSE reducer invariant)', () => {
    const events = [
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'phase', phaseIndex: 0, title: 'scan' },
      { t: 3, type: 'agent', index: 0, key: 'a', adapter: 'mock', state: 'queued', phaseIndex: 0 },
      { t: 4, type: 'agent', index: 0, state: 'running' },
      { t: 5, type: 'log', message: 'hello' },
      { t: 6, type: 'agent', index: 0, state: 'done', durationMs: 12, usage: { input: 1, output: 2, cost: 0.5 } },
      { t: 7, type: 'run', state: 'completed' },
    ]
    const all = records(events)
    const batched = materializeFold(fold(null, all), 'completed')
    let incremental = createFoldState()
    for (const rec of all) incremental = fold(incremental, [rec])
    expect(materializeFold(incremental, 'completed')).toEqual(batched)
  })
})

// ---- the client-only half: seeding ------------------------------------------------------

describe('seedFoldState — snapshot-then-tail (§9.3)', () => {
  const prefix = [
    { t: 1, type: 'run', state: 'started', engine: ENGINE, name: 'demo', concurrency: 4 },
    { t: 2, type: 'fanout', kind: 'parallel', path: [{ kind: 'parallel', ordinal: 0, count: 2 }], count: 2 },
    { t: 3, type: 'phase', phaseIndex: 0, title: 'scan' },
    { t: 4, type: 'agent', index: 0, key: 'k0', adapter: 'mock', state: 'queued', phaseIndex: 0, path: [{ kind: 'parallel', ordinal: 0, count: 2 }, { kind: 'item', i: 0 }] },
    { t: 5, type: 'agent', index: 1, key: 'k1', adapter: 'mock', state: 'queued', phaseIndex: 0, path: [{ kind: 'parallel', ordinal: 0, count: 2 }, { kind: 'item', i: 1 }] },
    { t: 6, type: 'agent', index: 0, state: 'running' },
  ]
  const suffix = [
    { t: 7, type: 'agent', index: 1, state: 'running' },
    { t: 8, type: 'agent', index: 0, state: 'done', durationMs: 5 },
    { t: 9, type: 'log', message: 'tail log' },
    { t: 10, type: 'agent', index: 1, state: 'failed', error: 'nope' },
    { t: 11, type: 'run', state: 'failed', error: 'nope' },
  ]

  it('seed + delta reproduces a fold of the whole file', () => {
    const detail = detailFrom(prefix)
    const seeded = fold(seedFoldState(detail), records(suffix, detail.offsets.events))
    const direct = fold(null, records([...prefix, ...suffix]))

    const a = materializeFold(seeded, 'failed')
    const b = materializeFold(direct, 'failed')
    expect(a.agents).toEqual(b.agents)
    expect(a.phases).toEqual(b.phases)
    expect(a.logs).toEqual(b.logs)
    expect(a.structure).toEqual(b.structure)
    expect(a.attemptSpans).toEqual(b.attemptSpans)
    expect(a.run!.endedAt).toBe(b.run!.endedAt)
    expect(a.lastOffset).toBe(b.lastOffset)
  })

  it('steps survive the seed and keep folding — a tail transition lands on the seeded entry', () => {
    const detail = detailFrom([
      ...prefix,
      { t: 6.5, type: 'step', key: 's1', name: 'create-branch', state: 'running', phaseIndex: 0 },
    ])
    expect(detail.steps).toHaveLength(1)
    const seeded = fold(seedFoldState(detail), records([
      { t: 7, type: 'step', key: 's1', state: 'done', durationMs: 4, resultPreview: 'ok' },
    ], detail.offsets.events))
    const direct = fold(null, records([
      ...prefix,
      { t: 6.5, type: 'step', key: 's1', name: 'create-branch', state: 'running', phaseIndex: 0 },
      { t: 7, type: 'step', key: 's1', state: 'done', durationMs: 4, resultPreview: 'ok' },
    ]))
    expect(materializeFold(seeded, 'running').steps).toEqual(materializeFold(direct, 'running').steps)
    expect(seeded.steps[0]!.state).toBe('done')
    expect(seeded.steps[0]!.name).toBe('create-branch')
  })

  it('the structure survives the first batch — fanouts round-trip through the tree', () => {
    const detail = detailFrom(prefix)
    expect(detail.structure).not.toBeNull()
    const seeded = seedFoldState(detail)
    // The bug this guards: a seeded fold with an empty fanout list rebuilds
    // `structure: null` on the next fold call, silently deleting the Structure DAG.
    expect(fold(seeded, []).structure).toEqual(detail.structure)
    expect(fanoutsFromStructure(detail.structure)).toHaveLength(1)
  })

  it('a pipeline structure round-trips with its stage width', () => {
    const path = [{ kind: 'pipeline', ordinal: 0, count: 2, stages: 3 }]
    const detail = detailFrom([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'fanout', kind: 'pipeline', path, count: 2, stages: 3 },
    ])
    expect(fold(seedFoldState(detail), []).structure).toEqual(detail.structure)
  })

  it('caps that were pending stay pending — a seeded null run is not an old run (M2)', () => {
    const detail = detailFrom([])
    expect(Object.values(detail.caps).every((c) => c === 'pending')).toBe(true)
    const seeded = seedFoldState(detail)
    expect(seeded.run).toBeNull()
    expect(Object.values(deriveCaps(seeded.run)).every((c) => c === 'pending')).toBe(true)
    // …and it flips to supported the moment the run event lands, with no refetch.
    const live = fold(seeded, records([{ t: 1, type: 'run', state: 'started', engine: ENGINE }]))
    expect(Object.values(deriveCaps(live.run)).every((c) => c === 'supported')).toBe(true)
  })

  it('a resume arriving over a seeded terminal snapshot clears the latch (parity #99)', () => {
    const detail = detailFrom([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'run', state: 'failed', error: 'boom' },
    ], 'failed')
    const seeded = seedFoldState(detail)
    expect(seeded.run!.state).toBe('failed')
    const resumed = fold(seeded, records([{ t: 3, type: 'run', state: 'resumed' }], detail.offsets.events))
    expect(resumed.run!.endedAt).toBeNull()
    expect(resumed.run!.error).toBeNull()
    expect(resumed.resumeCount).toBe(1)
    expect(resumed.attemptSpans.map((s) => s.state)).toEqual(['started', 'failed', 'resumed'])
  })

  it('journal-derived agent fields are left to the join layer, not copied into the fold', () => {
    // §6.4 J's output has exactly one home in the client. A copy inside the fold is a copy
    // a journal `sys/reset` cannot reach, and the pane then shows a rotated-away file's
    // session id, usage and duration for the rest of the run.
    const detail = detailFrom(prefix)
    Object.assign(detail.agents[0]!, {
      attempts: 2,
      usage: { input: 1, output: 2, cost: 0.5 },
      attemptUsage: { input: 1, output: 2, cost: 0.5 },
      durationMs: 700,
      resultPreview: 'from the journal',
      resultBytes: 99,
      resultTruncated: true,
      sessionId: 'sess-1',
      liveTokens: { input: 3, output: 4 },
    })
    const seeded = materializeFold(fold(seedFoldState(detail), []), 'running')
    for (const field of JOURNAL_DERIVED_FIELDS) {
      expect([field, (seeded.agents[0] as unknown as Record<string, unknown>)[field]])
        .toEqual([field, field === 'attempts' ? 0 : field === 'resultTruncated' ? false : null])
    }
    // Event-derived facts on the same agent are untouched by the strip.
    expect(seeded.agents[0]!.state).toBe('running')
    expect(seeded.agents[0]!.adapter).toBe('mock')
    expect(seeded.agents[0]!.key).toBe('k0')
  })

  it('a KEYLESS agent is stripped too, and the by-index base puts it back', () => {
    // Pre-E-era events omit `key`, and the server joins those agents through `key → index`
    // instead (src/viewer/snapshot.js:76, :94, :98) — so they DO carry journal facts, and
    // leaving them in the fold gave the value the second home a journal reset cannot reach.
    const detail = detailFrom([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'agent', index: 0, adapter: 'mock', state: 'done' },
    ])
    expect(detail.agents[0]!.key).toBeNull()
    Object.assign(detail.agents[0]!, { durationMs: 42, sessionId: 'sess-legacy', attempts: 2 })

    const bare = materializeFold(fold(seedFoldState(detail), []), 'completed')
    expect(bare.agents[0]!.durationMs).toBeNull()
    expect(bare.agents[0]!.sessionId).toBeNull()
    expect(bare.agents[0]!.attempts).toBe(0)

    // …and the join restores every one of them, so the strip is a move, not a loss.
    applyJournalJoin(bare, journalBaseFromDetail(detail), createJournalDelta())
    expect(bare.agents[0]!.durationMs).toBe(42)
    expect(bare.agents[0]!.sessionId).toBe('sess-legacy')
    expect(bare.agents[0]!.attempts).toBe(2)
  })

  /**
   * §9.4: a `sys/reset` drops exactly ONE stream's buffers — so every journal projection
   * has to be separable from the fold, and every events projection has to survive the
   * journal going away. These two cases pin the line on the two surfaces the agent-fact
   * strip did not cover: question answers and mail enrichment.
   */
  it('a pre-E7 run’s answers move to the journal layer; an E7+ run’s stay in the fold', () => {
    const legacy = detailFrom([
      { t: 1, type: 'run', state: 'started' },   // no `engine` → the pre-E1..E12 cohort
      { t: 2, type: 'question', qid: 'q1', question: 'go?' },
    ])
    expect(legacy.caps.progress).toBe('unsupported')
    // The server's join is what answered it for this cohort (snapshot.js:103–106).
    Object.assign(legacy.questions[0]!, { answered: true, answer: 'yes' })
    const seededLegacy = materializeFold(fold(seedFoldState(legacy), []), 'completed')
    expect(seededLegacy.questions[0]!.answered).toBe(false)
    expect(seededLegacy.questions[0]!.answer).toBeNull()
    applyJournalJoin(seededLegacy, journalBaseFromDetail(legacy), createJournalDelta())
    expect(seededLegacy.questions[0]!.answered).toBe(true)
    expect(seededLegacy.questions[0]!.answer).toBe('yes')

    // E7 emits the value on the answer EVENT (src/engine.js:701), so the events stream owns
    // it and a journal reset has no business clearing it.
    const modern = detailFrom([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'question', qid: 'q1', question: 'go?' },
      { t: 3, type: 'answer', qid: 'q1', value: 'yes' },
    ])
    expect(modern.questions[0]!.answered).toBe(true)
    const seededModern = materializeFold(fold(seedFoldState(modern), []), 'completed')
    expect(seededModern.questions[0]!.answered).toBe(true)
    expect(seededModern.questions[0]!.answer).toBe('yes')
  })

  it('mail origin/callsite are journal-derived for every engine; delivery is not', () => {
    // No mail emit site carries `origin` or `callsite` (src/engine.js:692, :724, :1132,
    // :1268), so a snapshot that has them got them from the join — for E8 runs too.
    const detail = detailFrom([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'mail', dir: 'in', agent: 0, message: 'hi', mailId: 'm1', delivery: 'live' },
    ])
    Object.assign(detail.attemptScopes![0]!.mail[0]!, { origin: 'workflow', callsite: 'wf.js:3' })
    Object.assign(detail.mail[0]!, { origin: 'workflow', callsite: 'wf.js:3' })

    const seeded = materializeFold(fold(seedFoldState(detail), []), 'completed')
    expect(seeded.mail[0]!.origin).toBeNull()
    expect(seeded.mail[0]!.callsite).toBeNull()
    // `delivery` came off the event (fold.js:321) — the fold keeps it.
    expect(seeded.mail[0]!.delivery).toBe('live')

    applyJournalJoin(seeded, journalBaseFromDetail(detail), createJournalDelta())
    expect(seeded.mail[0]!.origin).toBe('workflow')
    expect(seeded.mail[0]!.callsite).toBe('wf.js:3')
  })

  it('steer origin is journal-derived too — stripped on seed, put back by the join', () => {
    // **The producer's actual shape.** `emitSteered` (src/engine.js:653–660) emits state,
    // delivery, mailId, phase and phaseIndex — and NO origin, for the control socket
    // (:691) and for the workflow handle (:1131, :1267) alike. So the fold reads
    // `'operator'` for every real steer, and a `'workflow'` verdict on a snapshot can only
    // have come from `snapshot.js:123–129`, which looks `mailId` up in the journal.
    const detail = detailFrom([
      { t: 1, type: 'run', state: 'started', engine: ENGINE },
      { t: 2, type: 'agent', index: 0, key: 'k0', adapter: 'mock', state: 'running' },
      { t: 3, type: 'agent', index: 0, state: 'steered', delivery: 'queued', mailId: 'm1' },
      // A dropped send journals nothing (agent-proc.js:107–108), so it carries no id and
      // the journal layer can never speak for it.
      { t: 4, type: 'agent', index: 0, state: 'steered', delivery: 'dropped', mailId: null },
    ])
    expect(detail.agents[0]!.steers.map((s) => s.origin)).toEqual(['operator', 'operator'])
    // What the server's join then wrote on top of the fold:
    detail.agents[0]!.steers[0]!.origin = 'workflow'

    const seeded = materializeFold(fold(seedFoldState(detail), []), 'running')
    // Stripped: the value has one home, so a journal reset can empty it.
    expect(seeded.agents[0]!.steers[0]!.origin).toBe('operator')

    const base = journalBaseFromDetail(detail)
    expect(base.steerOrigin.get('m1')).toBe('workflow')
    applyJournalJoin(seeded, base, createJournalDelta())
    expect(seeded.agents[0]!.steers[0]!.origin).toBe('workflow')
    expect(seeded.agents[0]!.steers[1]!.origin).toBe('operator')

    // …and an emptied journal (§5.6.4) takes it back rather than showing a rotated-away
    // file's provenance forever.
    const afterReset = materializeFold(fold(seedFoldState(detail), []), 'running')
    applyJournalJoin(afterReset, createJournalBase(), createJournalDelta())
    expect(afterReset.agents[0]!.steers[0]!.origin).toBe('operator')
  })

  it('an approximate phase assignment survives the round trip instead of blanking', () => {
    // Old engine: no phaseIndex on agent events, so materialize rewrites `phaseIndex` from
    // the heuristic. Seeding has to restore it as the heuristic value, or the next
    // materialize hands back `undefined`.
    const detail = detailFrom([
      { t: 1, type: 'run', state: 'started' },
      { t: 2, type: 'phase', phaseIndex: 0, title: 'scan' },
      { t: 3, type: 'agent', index: 0, key: 'a', adapter: 'mock', state: 'running' },
    ])
    expect(detail.caps.phaseAssociation).toBe('unsupported')
    expect(detail.agents[0]!.phaseIndex).toBe(0)
    expect(detail.agents[0]!.phaseApproximate).toBe(true)
    const again = materializeFold(fold(seedFoldState(detail), []), 'running')
    expect(again.agents[0]!.phaseIndex).toBe(0)
    expect(again.agents[0]!.phaseApproximate).toBe(true)
  })
})
