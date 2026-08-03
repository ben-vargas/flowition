/**
 * §6.4 J, client side: the journal join maintained from the SSE journal feed.
 *
 * The properties that matter are the ones the server's join also has to get right, and
 * which a naive "last record wins" client would get wrong: `attempts` counts RECORDS,
 * `usage` is a LIFETIME sum (Sol-13) while `attemptUsage` is the last attempt's own, and
 * the base the server already computed has to compose with the delta rather than be
 * overwritten by it.
 */

import { describe, expect, it } from 'vitest'

import {
  deriveCaps,
  fold,
  JOURNAL_DERIVED_FIELDS,
  mailSignature,
  materializeFold,
  type MaterializedFold,
} from './index.js'
import {
  applyJournalJoin,
  byteLength,
  createJournalBase,
  createJournalDelta,
  ingestJournalRecord,
  journalBaseFromDetail,
  type JournalBase,
  type JournalFacts,
} from './journalJoin.js'
import type { RunDetail, RunState } from '../api/types.js'

const ENGINE = '0.2.0'

const project = (events: Record<string, unknown>[], state: RunState = 'running'): MaterializedFold => {
  let o = 0
  const recs = events.map((rec) => ({ o: (o += JSON.stringify(rec).length + 1), rec }))
  const raw = fold(null, recs)
  return materializeFold(raw, state, deriveCaps(raw.run))
}

const ingest = (records: Record<string, unknown>[]) => {
  const delta = createJournalDelta()
  for (const rec of records) ingestJournalRecord(delta, rec)
  return delta
}

/** A `JournalBase` carrying one key's facts — the shape `journalBaseFromDetail` builds. */
const keyedBase = (key: string, facts: JournalFacts): JournalBase => {
  const base = createJournalBase()
  base.byKey.set(key, facts)
  return base
}

const EVENTS = [
  { t: 1, type: 'run', state: 'started', engine: ENGINE },
  { t: 2, type: 'agent', index: 0, key: 'k0', adapter: 'mock', state: 'running' },
  { t: 3, type: 'agent', index: 1, key: 'k1', adapter: 'mock', state: 'running' },
]

describe('journal delta', () => {
  it('attempts counts result RECORDS and usage is the lifetime sum (Sol-13)', () => {
    const projected = project(EVENTS)
    const delta = ingest([
      { type: 'result', key: 'k0', index: 0, status: 'error', usage: { input: 10, output: 1, cost: 0.01 }, durationMs: 100, result: 'first' },
      { type: 'result', key: 'k0', index: 0, status: 'ok', usage: { input: 20, output: 2, cost: 0.02 }, durationMs: 200, result: 'second' },
    ])
    applyJournalJoin(projected, createJournalBase(), delta)
    const agent = projected.agents[0]!
    expect(agent.attempts).toBe(2)
    expect(agent.usage).toEqual({ input: 30, output: 3, cost: 0.03 })
    expect(agent.attemptUsage).toEqual({ input: 20, output: 2, cost: 0.02 })
    expect(agent.durationMs).toBe(200)
    expect(agent.resultPreview).toBe('"second"')
  })

  it('composes with the base the server already joined, never replacing it', () => {
    const projected = project(EVENTS)
    const base = keyedBase('k0', {
      attempts: 2,
      usage: { input: 30, output: 3, cost: 0.03 },
      attemptUsage: { input: 20, output: 2, cost: 0.02 },
      durationMs: 200,
      resultPreview: '"second"',
      resultBytes: 8,
      resultTruncated: false,
      sessionId: 'sess-1',
      liveTokens: { input: 5, output: 6 },
    })
    base.spend = { input: 30, output: 3, cost: 0.03 }
    const delta = ingest([
      { type: 'result', key: 'k0', index: 0, usage: { input: 1, output: 1, cost: 0.01 }, durationMs: 5, result: 'third' },
    ])
    const { spend } = applyJournalJoin(projected, base, delta)
    const agent = projected.agents[0]!
    expect(agent.attempts).toBe(3)
    expect(agent.usage).toEqual({ input: 31, output: 4, cost: 0.04 })
    expect(agent.attemptUsage).toEqual({ input: 1, output: 1, cost: 0.01 })
    expect(agent.durationMs).toBe(5)
    // Untouched by the delta → the server's values survive.
    expect(agent.sessionId).toBe('sess-1')
    expect(agent.liveTokens).toEqual({ input: 5, output: 6 })
    expect(spend).toEqual({ input: 31, output: 4, cost: 0.04 })
  })

  it('a {0,0} usage-cum is a reset marker and wins over the base', () => {
    const projected = project(EVENTS)
    const base = keyedBase('k0', {
      attempts: 0, usage: null, attemptUsage: null, durationMs: null, resultPreview: null,
      resultBytes: null, resultTruncated: false, sessionId: null,
      liveTokens: { input: 900, output: 900 },
    })
    applyJournalJoin(projected, base, ingest([{ type: 'usage-cum', key: 'k0', cum: { input: 0, output: 0 } }]))
    expect(projected.agents[0]!.liveTokens).toEqual({ input: 0, output: 0 })
  })

  it('an oversize result forwarded without its value keeps the flag and the size (M8)', () => {
    const projected = project(EVENTS)
    applyJournalJoin(projected, createJournalBase(), ingest([
      { type: 'result', key: 'k0', index: 0, status: 'ok', resultTruncated: true, resultBytes: 20_000_000 },
    ]))
    const agent = projected.agents[0]!
    expect(agent.resultTruncated).toBe(true)
    expect(agent.resultBytes).toBe(20_000_000)
    // No value came over the wire, so no preview is invented from one.
    expect(agent.resultPreview).toBeNull()
  })

  it('a result larger than 64 KiB is flagged truncated and its preview capped at 200 bytes', () => {
    const projected = project(EVENTS)
    applyJournalJoin(projected, createJournalBase(), ingest([
      { type: 'result', key: 'k0', index: 0, result: 'x'.repeat(70_000) },
    ]))
    const agent = projected.agents[0]!
    expect(agent.resultTruncated).toBe(true)
    expect(agent.resultBytes).toBe(70_002)
    expect(byteLength(agent.resultPreview!)).toBe(200)
  })

  /**
   * A retry writes a second `result` for the same key, and a result record carries no
   * inline value when the attempt failed or when §5.6.5 stripped an oversize one. Pairing
   * the newest attempt's status, duration and size with the PREVIOUS attempt's output is
   * wrong in the one way the operator cannot detect from the pane.
   */
  it('a later attempt without a value never inherits the previous attempt’s output', () => {
    const projected = project(EVENTS)
    const delta = ingest([
      { type: 'result', key: 'k0', index: 0, status: 'ok', usage: { input: 10, output: 1, cost: 0.01 }, durationMs: 100, result: 'first' },
      // The retry failed: a result record, no result value.
      { type: 'result', key: 'k0', index: 0, status: 'error', usage: { input: 2, output: 0, cost: 0.002 }, durationMs: 9 },
    ])
    applyJournalJoin(projected, createJournalBase(), delta)
    const agent = projected.agents[0]!
    expect(agent.attempts).toBe(2)
    expect(agent.durationMs).toBe(9)
    expect(agent.resultPreview).toBeNull()
    expect(agent.resultBytes).toBeNull()
    expect(agent.resultTruncated).toBe(false)
  })

  it('an oversize retry takes the new size and drops the old preview', () => {
    const projected = project(EVENTS)
    applyJournalJoin(projected, createJournalBase(), ingest([
      { type: 'result', key: 'k0', index: 0, result: 'small' },
      { type: 'result', key: 'k0', index: 0, resultTruncated: true, resultBytes: 20_000_000 },
    ]))
    const agent = projected.agents[0]!
    expect(agent.resultBytes).toBe(20_000_000)
    expect(agent.resultTruncated).toBe(true)
    expect(agent.resultPreview).toBeNull()
  })

  it('a streamed valueless result supersedes the BASE’s preview and size', () => {
    const projected = project(EVENTS)
    const base = keyedBase('k0', {
      attempts: 1,
      usage: { input: 30, output: 3, cost: 0.03 },
      attemptUsage: { input: 30, output: 3, cost: 0.03 },
      durationMs: 200,
      resultPreview: '"the first attempt"',
      resultBytes: 19,
      resultTruncated: false,
      sessionId: null,
      liveTokens: null,
    })
    applyJournalJoin(projected, base, ingest([
      { type: 'result', key: 'k0', index: 0, status: 'error', durationMs: 4 },
    ]))
    const agent = projected.agents[0]!
    expect(agent.attempts).toBe(2)
    expect(agent.durationMs).toBe(4)
    // Not the base's: that output belongs to the attempt before this one.
    expect(agent.resultPreview).toBeNull()
    expect(agent.resultBytes).toBeNull()
  })

  it('sessions and unknown record types degrade rather than throw (§6.5)', () => {
    const projected = project(EVENTS)
    const delta = ingest([
      { type: 'session', key: 'k1', sessionId: 'abc' },
      { type: 'telemetry', whatever: true },
      null as unknown as Record<string, unknown>,
    ])
    applyJournalJoin(projected, createJournalBase(), delta)
    expect(projected.agents[1]!.sessionId).toBe('abc')
    expect(delta.unknown).toBe(1)
    expect(delta.records).toBe(2)
  })

  it('journal answers un-block a question the events stream never answered (pre-E7)', () => {
    const projected = project([
      ...EVENTS,
      { t: 4, type: 'question', qid: 'q1', question: 'go?' },
    ])
    expect(projected.openQuestions).toBe(1)
    const { openQuestions } = applyJournalJoin(projected, createJournalBase(), ingest([
      { type: 'answer', qid: 'q1', value: 'yes' },
    ]))
    expect(projected.questions[0]!.answered).toBe(true)
    expect(projected.questions[0]!.answer).toBe('yes')
    expect(openQuestions).toBe(0)
  })

  it('openQuestions stays 0 on a dead run even when the fold has pending asks (M6)', () => {
    const projected = project([...EVENTS, { t: 4, type: 'question', qid: 'q1', question: 'go?' }], 'interrupted')
    const { openQuestions } = applyJournalJoin(projected, createJournalBase(), createJournalDelta(), { dead: true })
    expect(openQuestions).toBe(0)
    expect(projected.questions[0]!.abandoned).toBe(true)
  })
})

describe('the mail join (§6.4 J)', () => {
  it('E8 ids correlate exactly, and mail-done supplies the delivery verdict', () => {
    const projected = project([
      ...EVENTS,
      { t: 4, type: 'mail', dir: 'in', agent: 0, message: 'hello', mailId: 'm1' },
    ])
    applyJournalJoin(projected, createJournalBase(), ingest([
      { type: 'mail', id: 'm1', key: 'k0', text: 'hello', origin: 'workflow', callsite: 'wf.js:3' },
      { type: 'mail-done', id: 'm1', dropped: true },
    ]))
    const mail = projected.attemptScopes[0]!.mail[0]!
    expect(mail.origin).toBe('workflow')
    expect(mail.callsite).toBe('wf.js:3')
    expect(mail.delivery).toBe('dropped')
  })

  it('the legacy two-hop fallback matches by (index, text, ≤5s) and flags it approximate (N4)', () => {
    const projected = project([
      ...EVENTS,
      { t: 1000, type: 'mail', dir: 'in', agent: 1, message: 'ping' },
    ])
    applyJournalJoin(projected, createJournalBase(), ingest([
      // No `id`: the key→index hop comes from the result record below.
      { type: 'result', key: 'k1', index: 1, status: 'ok' },
      { t: 1200, type: 'mail', key: 'k1', text: 'ping', origin: 'operator', callsite: 'cli' },
    ]))
    const mail = projected.attemptScopes[0]!.mail[0]! as { origin: string; callsite: string; approximate?: boolean }
    expect(mail.origin).toBe('operator')
    expect(mail.callsite).toBe('cli')
    expect(mail.approximate).toBe(true)
  })

  /**
   * **M3.** The two-hop's key→index used to come from `delta.indexByKey`, which ONLY
   * `result` records populate — so a legacy mail record streamed while its agent is still
   * running had no index to hop through and stayed bare until the agent finished. On a
   * live run that is the whole time the operator is watching. The projected agent has
   * carried `key` AND `index` since its first `agent` event, so the relation was already
   * in hand; this fixture is the delta the old code could not join: mail, and no result.
   */
  it('a legacy mail record joins while the agent is still running — no result record needed (M3)', () => {
    const projected = project([
      ...EVENTS,
      { t: 1000, type: 'mail', dir: 'in', agent: 1, message: 'ping' },
    ])
    // k1 is `running` in EVENTS and has written no result: `delta.indexByKey` is empty.
    const delta = ingest([
      { t: 1200, type: 'mail', key: 'k1', text: 'ping', origin: 'workflow', callsite: 'wf.js:9' },
    ])
    expect(delta.indexByKey.size).toBe(0)
    applyJournalJoin(projected, createJournalBase(), delta)

    const mail = projected.attemptScopes[0]!.mail[0]! as
      { origin: string | null; callsite: string | null; approximate?: boolean }
    expect(mail.origin).toBe('workflow')
    expect(mail.callsite).toBe('wf.js:9')
    expect(mail.approximate).toBe(true)
  })

  it('a journal mail record whose key never acquired an index stays run-scoped', () => {
    const projected = project([
      ...EVENTS,
      { t: 1000, type: 'mail', dir: 'in', agent: 1, message: 'ping' },
    ])
    applyJournalJoin(projected, createJournalBase(), ingest([
      { t: 1200, type: 'mail', key: 'ghost', text: 'ping', origin: 'operator' },
    ]))
    expect(projected.attemptScopes[0]!.mail[0]!.origin).toBeNull()
  })

  it('a match more than 5 s away is not a match', () => {
    const projected = project([
      ...EVENTS,
      { t: 1000, type: 'mail', dir: 'in', agent: 1, message: 'ping' },
    ])
    applyJournalJoin(projected, createJournalBase(), ingest([
      { type: 'result', key: 'k1', index: 1, status: 'ok' },
      { t: 20_000, type: 'mail', key: 'k1', text: 'ping', origin: 'operator' },
    ]))
    expect(projected.attemptScopes[0]!.mail[0]!.origin).toBeNull()
  })
})

/**
 * Steering provenance is the mail join reached through the agent instead of through the
 * mail list, and it is journal-derived for the same reason: the `steered` EVENT carries no
 * origin (src/engine.js:653–660), so `'workflow'` can only come from the journal's mail
 * record for the steer's `mailId`.
 */
describe('the steer join (E8, snapshot.js:123–129)', () => {
  const STEERED = [
    ...EVENTS,
    // The producer's shape: no `origin` field exists on this event.
    { t: 4, type: 'agent', index: 0, state: 'steered', delivery: 'queued', mailId: 'm1' },
  ]

  it('a live workflow steer reads as workflow once its journal record arrives', () => {
    const projected = project(STEERED)
    expect(projected.agents[0]!.steers[0]!.origin).toBe('operator')   // the fold's default
    applyJournalJoin(projected, createJournalBase(), ingest([
      { type: 'mail', id: 'm1', key: 'k0', text: 'go left', origin: 'workflow', callsite: 'wf.js:9' },
    ]))
    expect(projected.agents[0]!.steers[0]!.origin).toBe('workflow')
  })

  it('an operator steer stays operator, and an unjournaled one has nothing to join to', () => {
    const projected = project([
      ...STEERED,
      { t: 5, type: 'agent', index: 0, state: 'steered', delivery: 'dropped', mailId: null },
    ])
    applyJournalJoin(projected, createJournalBase(), ingest([
      { type: 'mail', id: 'm1', key: 'k0', text: 'stop', origin: 'operator' },
    ]))
    expect(projected.agents[0]!.steers.map((s) => s.origin)).toEqual(['operator', 'operator'])
  })

  it('the delta outranks the base, and an emptied journal takes the base back', () => {
    const base = createJournalBase()
    base.steerOrigin.set('m1', 'workflow')

    const kept = project(STEERED)
    applyJournalJoin(kept, base, createJournalDelta())
    expect(kept.agents[0]!.steers[0]!.origin).toBe('workflow')

    // A record streamed since the snapshot is the newer answer.
    const restated = project(STEERED)
    applyJournalJoin(restated, base, ingest([{ type: 'mail', id: 'm1', key: 'k0', text: 'x', origin: 'operator' }]))
    expect(restated.agents[0]!.steers[0]!.origin).toBe('operator')

    // §5.6.4: the file is gone, so both maps are empty and the event's own answer stands.
    const afterReset = project(STEERED)
    applyJournalJoin(afterReset, createJournalBase(), createJournalDelta())
    expect(afterReset.agents[0]!.steers[0]!.origin).toBe('operator')
  })

  it('mutating a materialized steer cannot reach back into the accumulator', () => {
    let o = 0
    const raw = fold(null, STEERED.map((rec) => ({ o: (o += JSON.stringify(rec).length + 1), rec })))
    const first = materializeFold(raw, 'running', deriveCaps(raw.run))
    applyJournalJoin(first, createJournalBase(), ingest([
      { type: 'mail', id: 'm1', key: 'k0', text: 'go', origin: 'workflow' },
    ]))
    expect(first.agents[0]!.steers[0]!.origin).toBe('workflow')
    // The next compose starts from the fold again — the join is re-applied, not remembered.
    const second = materializeFold(raw, 'running', deriveCaps(raw.run))
    expect(second.agents[0]!.steers[0]!.origin).toBe('operator')
  })
})

describe('journalBaseFromDetail', () => {
  it('captures keyed agents by key and KEYLESS ones by index (snapshot.js:76)', () => {
    const detail = {
      agents: [
        { index: 0, key: 'k0', attempts: 2, usage: { input: 1, output: 2, cost: 3 }, attemptUsage: null, durationMs: 7, resultPreview: 'p', resultBytes: 1, resultTruncated: false, sessionId: 's', liveTokens: null },
        { index: 1, key: null, attempts: 1, sessionId: 'legacy-session', durationMs: 42 },
      ],
    } as unknown as RunDetail
    const base = journalBaseFromDetail(detail)
    expect([...base.byKey.keys()]).toEqual(['k0'])
    expect(base.byKey.get('k0')!.attempts).toBe(2)
    expect(base.byKey.get('k0')!.usage).toEqual({ input: 1, output: 2, cost: 3 })
    // The server joins these by index; nothing else in the client can speak for them.
    expect([...base.byIndex.keys()]).toEqual([1])
    expect(base.byIndex.get(1)!.sessionId).toBe('legacy-session')
    expect(base.byIndex.get(1)!.durationMs).toBe(42)
  })

  it('captures pre-E7 answers and mail enrichment, and only those parts of them', () => {
    const detail = {
      caps: { mailIds: 'unsupported', progress: 'unsupported' },
      agents: [],
      questions: [
        { qid: 'q1', question: 'go?', askedAt: 1, answered: true, answer: 'yes', replayed: false, abandoned: false },
        { qid: 'q2', question: 'stop?', askedAt: 2, answered: false, answer: null, replayed: false, abandoned: false },
      ],
      mail: [
        { at: 10, dir: 'in', agent: 0, message: 'hi', origin: 'workflow', callsite: 'wf.js:3', delivery: 'live', mailId: null, approximate: true },
        { at: 11, dir: 'in', agent: 0, message: 'bare', origin: null, callsite: null, delivery: 'queued', mailId: null },
      ],
      spend: { input: 1, output: 2, cost: 3 },
    } as unknown as RunDetail
    const base = journalBaseFromDetail(detail)
    expect([...base.answers.entries()]).toEqual([['q1', 'yes']])
    expect(base.spend).toEqual({ input: 1, output: 2, cost: 3 })
    const facts = base.mail.get(mailSignature({ at: 10, dir: 'in', agent: 0, message: 'hi' }))!
    expect(facts).toEqual({ origin: 'workflow', callsite: 'wf.js:3', delivery: null, approximate: true })
    // `delivery: 'live'` is the EVENT's own vocabulary (agent-proc.js:92) — not captured,
    // because the fold keeps it and a journal reset must not take an events fact away.
    expect(base.mail.has(mailSignature({ at: 11, dir: 'in', agent: 0, message: 'bare' }))).toBe(false)
  })

  it('an E7+ run keeps its answers on the events side of the line', () => {
    const detail = {
      caps: { mailIds: 'supported', progress: 'supported' },
      agents: [],
      questions: [{ qid: 'q1', question: 'go?', askedAt: 1, answered: true, answer: 'yes', replayed: false, abandoned: false }],
    } as unknown as RunDetail
    // src/engine.js:701 emits the answer EVENT with its value for this engine cohort, so
    // the fold owns it and §9.4's one-stream reset must leave it alone.
    expect(journalBaseFromDetail(detail).answers.size).toBe(0)
  })
})

/**
 * The two halves of the separation have to name the SAME fields. `seedFoldState` strips
 * `JOURNAL_DERIVED_FIELDS` from the fold on the promise that `JournalFacts` puts every one
 * of them back; a field added to one list and not the other is either a value with two
 * homes again (which a journal reset cannot clear) or a value with none (which seeding
 * silently deletes).
 */
describe('the event/journal projection boundary', () => {
  it('JOURNAL_DERIVED_FIELDS is exactly the set JournalFacts carries', () => {
    const detail = {
      agents: [{
        index: 0, key: 'k0', attempts: 1, usage: null, attemptUsage: null, durationMs: null,
        resultPreview: null, resultBytes: null, resultTruncated: false, sessionId: null, liveTokens: null,
      }],
    } as unknown as RunDetail
    const facts = journalBaseFromDetail(detail).byKey.get('k0')!
    expect([...JOURNAL_DERIVED_FIELDS].sort()).toEqual(Object.keys(facts).sort())
  })
})
