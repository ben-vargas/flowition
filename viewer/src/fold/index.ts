/**
 * The shared fold — **imported**, never ported (DESIGN §4.5, §6.4).
 *
 * `src/viewer/fold.js` is the one normative implementation. The server delta-folds with
 * it; this module is the SPA's only door onto the same module object. Two fold copies,
 * one per side, is the classic arrangement and they drift; the
 * whole point of this file is that there is nothing here to drift — `shared.test.ts`
 * asserts `foldIndex.fold === sharedModule.fold` by reference and that no second
 * implementation exists anywhere in the tree.
 *
 * What this file *does* add is the client-only glue the server never needs:
 *
 *   • `seedFoldState(detail)` — rehydrate a fold state from a `RunDetail` so SSE batches
 *     can be folded onto the snapshot instead of re-reading a 10 MB events file (§9.3
 *     "fetch snapshot → seed fold state + offsets → open SSE with cursor").
 *   • `fanoutsFromStructure` — the one part of the fold's private state that a
 *     materialized snapshot does not carry back losslessly. See the note on it.
 *
 * What it no longer adds is a *second* type surface. `src/viewer/fold.d.ts` is §6.2's
 * "generated `.d.ts` alongside the JS by hand", so the shared module arrives here already
 * typed: the values below are plain re-exports rather than `as unknown as` casts over
 * `any`, and `../api/types.ts` re-exports the same declarations through this door instead
 * of maintaining a lookalike copy of the contract. One declaration, two consumers — which
 * is the whole of §6.2's requirement, and the only arrangement in which the runtime
 * identity test in `shared.test.ts` can also detect TYPE drift.
 */

export {
  ARCHIVED_AGENT_BLANKS,
  CAP_VERSIONS,
  FIRST_VIEWER_EVENT_VERSION,
  TOOL_IDS_VERSION,
  createFoldState,
  deriveCaps,
  fold,
  materializeFold,
  runIsDead,
  runIsLive,
  semverGte,
  terminalOrStale,
} from '../../../src/viewer/fold.js'

import { ARCHIVED_AGENT_BLANKS, createFoldState, fold } from '../../../src/viewer/fold.js'

import type {
  AgentView,
  AttemptScope,
  Caps,
  FoldState,
  MailView,
  PathSeg,
  RunDetail,
  StructNode,
} from '../../../src/viewer/fold.js'

/**
 * §6.2's canonical declarations, forwarded from the one module that owns them. Every SPA
 * consumer reads them from `../api/types.ts`, which re-exports this list — `shared.test.ts`
 * keeps this file the only door onto `src/viewer/fold.js`, for types exactly as for values.
 */
export type {
  AgentState,
  AgentView,
  AttemptScope,
  AttemptSpan,
  Cap,
  Caps,
  FoldRecord,
  FoldState,
  LogView,
  MailView,
  MaterializedFold,
  PathSeg,
  PhaseView,
  QuestionView,
  RunDetail,
  RunState,
  RunSummary,
  StepState,
  StepView,
  StructNode,
} from '../../../src/viewer/fold.js'

// ---- seeding a client fold from a server snapshot -------------------------------------

/**
 * Rebuild the `fanout` events that produced a structure tree.
 *
 * `fold.js` keeps raw fanout events in private state and rebuilds `structure` from them on
 * every call — so a fold state seeded from a materialized snapshot with an empty fanout
 * list would report `structure: null` the instant the first SSE batch landed, silently
 * deleting the Structure DAG on a live run. The events are recoverable because §6.2 makes
 * a container's `path` its OWN full path: the last segment carries `ordinal`, `count` and
 * (for pipelines) `stages`, which is exactly the payload `buildStructure` consumes. The
 * round trip is pinned by a test rather than assumed.
 */
export function fanoutsFromStructure(structure: StructNode | null | undefined): unknown[] {
  const out: unknown[] = []
  const walk = (node: StructNode) => {
    if (node.kind === 'parallel' || node.kind === 'pipeline') {
      const seg = node.path[node.path.length - 1] as Extract<PathSeg, { count: number }> | undefined
      const items = node.children.filter((c) => c.kind === 'item').length
      out.push({
        type: 'fanout',
        kind: node.kind,
        path: node.path.map((s) => ({ ...s })),
        count: seg && Number.isInteger(seg.count) ? seg.count : items,
        ...(seg && Number.isInteger(seg.stages as number) ? { stages: seg.stages } : {}),
      })
    }
    for (const child of node.children ?? []) walk(child)
  }
  if (structure) walk(structure)
  return out
}

const clone = <T,>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)) as T)

/**
 * The `AgentView` fields `applyJournalJoin` owns — §6.4 J's whole output, and therefore
 * everything a `sys/reset` on the journal stream has to be able to take back. Exported so
 * `journalJoin.ts`'s `JournalFacts` and this list cannot drift apart unnoticed (a test
 * pins the two against each other). The blanks themselves live with the shared fold
 * (`ARCHIVED_AGENT_BLANKS`), because the archive rule depends on them: an attempt-scope
 * archive keeps exactly these fields blank on BOTH folds, which is what makes a scope
 * closed client-side identical to one closed by a server re-fold (pinned by test too).
 */
export const JOURNAL_DERIVED_FIELDS = Object.freeze([
  'attempts', 'usage', 'attemptUsage', 'durationMs', 'resultPreview',
  'resultBytes', 'resultTruncated', 'sessionId', 'liveTokens', 'cumTokens',
] as const)

/**
 * The `MailView` fields the journal — and ONLY the journal — can supply.
 *
 * Provenance here is decidable from the engine rather than guessed: no mail event this
 * engine emits carries `origin` or `callsite` (src/engine.js:692, :724, :1132, :1268 —
 * every emit site), so a snapshot that has them got them from `joinJournal`
 * (src/viewer/snapshot.js:116–117, :144–145). `approximate` is likewise written only by
 * §6.4 J's two-hop fallback (snapshot.js:146). `delivery` is NOT in this list: it is an
 * event field (`fold.js:321`, engine.js:692) whose vocabulary — `live|queued|replayed|
 * dropped` (src/agent-proc.js:92, :162; src/engine.js:1157) — overlaps the join's, so
 * blanking it would delete an events-stream fact on a journal reset, which §9.4 forbids.
 * `'skipped'` is the one value only the join can write (snapshot.js:120), and
 * `JOURNAL_ONLY_DELIVERY` below is how that single case is handed to the journal layer.
 */
export const JOURNAL_DERIVED_MAIL_FIELDS = Object.freeze([
  'origin', 'callsite', 'approximate',
] as const)

/** Delivery verdicts no mail EVENT can produce — see the note above. */
export const JOURNAL_ONLY_DELIVERY = Object.freeze(['skipped'] as const)

/**
 * What `foldAgent` writes for a `steered` event's origin when the event does not carry one
 * — which is EVERY steered event this engine emits (`emitSteered`, src/engine.js:653–660,
 * for both the control socket at :691 and the workflow handle at :1131/:1267).
 * `fold.js:235` is `ev.origin === 'workflow' ? 'workflow' : 'operator'`.
 */
export const EVENT_STEER_ORIGIN = 'operator' as const

/**
 * Is this run older than the engine that emits viewer events (E1..E12)?
 *
 * Every entry in `CAP_VERSIONS` is `FIRST_VIEWER_EVENT_VERSION`, so one `'unsupported'`
 * means the whole cohort is missing — including E7 (`answer` events carry their value,
 * src/engine.js:701) and E8 (`mailId` on mail events). `'pending'` is the critique-M2
 * state (a new run with no run event yet) and is NOT legacy.
 */
export function isLegacyEngine(caps: Caps | null | undefined): boolean {
  return Object.values(caps ?? {}).some((c) => c === 'unsupported')
}

/**
 * The correlation key for a mail record's journal facts.
 *
 * E8 mail carries an id; pre-E8 mail is correlated by §6.4 J's own two-hop tuple, so the
 * same `(at, dir, agent, message)` identity is what carries its facts across a reseed.
 */
export function mailSignature(mail: {
  at?: number | null
  dir?: string
  agent?: number | null
  message?: string
  mailId?: string | null
}): string {
  if (mail.mailId != null) return `id:${mail.mailId}`
  return `sig:${mail.at ?? 0}|${mail.dir ?? ''}|${mail.agent ?? ''}|${mail.message ?? ''}`
}

/**
 * Take the journal's contribution back out of one seeded `MailView`.
 *
 * The counterpart of `journalMailBaseFromDetail`: what this removes, that captures, and
 * `applyJournalJoin` puts back on every compose — so the value has exactly one home and a
 * `sys/reset` on the journal stream can empty it. What stays is what a mail EVENT can
 * carry: `at`/`dir`/`agent`/`message`/`mailId`, and `delivery` unless it holds the one
 * verdict only the join writes.
 */
function stripMail(mail: MailView): MailView {
  const out = mail as MailView & { approximate?: boolean }
  out.origin = null
  out.callsite = null
  delete out.approximate
  if (out.delivery != null && (JOURNAL_ONLY_DELIVERY as readonly string[]).includes(out.delivery)) {
    out.delivery = null
  }
  return out
}

/**
 * Take the journal's contribution back out of one seeded agent's steering history.
 *
 * `snapshot.js:123–129` rewrites `steer.origin` from the journal's mail record for the
 * steer's `mailId`, so on a post-join snapshot that field is a journal projection — the
 * `steered` event itself never carries an origin. Reset it to what the EVENT says
 * (`EVENT_STEER_ORIGIN`) and let `applyJournalJoin` put the journal's answer back on every
 * compose, so the value has one home and a journal `sys/reset` empties it.
 *
 * A steer with no `mailId` was never journaled, so nothing here can speak for it and its
 * origin stays exactly as the fold produced it.
 */
function stripSteers(agent: AgentView): AgentView {
  agent.steers = (agent.steers ?? []).map((steer) => (
    steer.mailId != null ? { ...steer, origin: EVENT_STEER_ORIGIN } : { ...steer }
  ))
  return agent
}

/**
 * Reconstruct the merged `run` event the fold keeps.
 *
 * Two properties matter and both are tested. (1) `deriveCaps` reports `'pending'` — the
 * critique-M2 state that renders loading copy rather than older-engine copy — only when
 * `run` is null, so a snapshot whose caps are `'pending'` must seed a null run, never an
 * object with `engine: null` (which would read as a genuinely old run). (2) `foldRun`
 * clears a latched terminal state when a `resumed` event arrives, and it decides that from
 * `state.run.state`; the last attempt span IS that state, by construction of §6.4 step 1.
 */
function seedRunEvent(detail: RunDetail): Record<string, unknown> | null {
  const pending = Object.values(detail.caps ?? {}).every((c) => c === 'pending')
  if (pending) return null
  const spans = detail.attemptSpans ?? []
  const last = spans.length ? spans[spans.length - 1] : undefined
  return {
    type: 'run',
    ...(last ? { state: last.state } : {}),
    name: detail.name,
    workflowFile: detail.workflowFile,
    engine: detail.engine,
    concurrency: detail.concurrency,
    phases: detail.declaredPhases,
    budgetTotal: detail.budgetTotal,
    defaults: detail.defaults,
    startedAt: detail.startedAt,
    endedAt: detail.endedAt,
    error: null,
  }
}

/**
 * Seed a fold accumulator from `GET /api/runs/:id`, so the SSE stream can be opened at
 * `detail.offsets` and folded forward (§9.3).
 *
 * The snapshot is the *materialized* projection, so two fields have to be un-projected:
 * `phaseIndex` (rewritten to the heuristic value when `phaseAssociation` is unsupported —
 * restoring it as `_approxPhaseIndex` makes re-materializing idempotent instead of
 * blanking it) and the fanout list (see `fanoutsFromStructure`). `displayState` and
 * `abandoned` need no care: they are recomputed from run state on every materialize.
 */
export function seedFoldState(detail: RunDetail): FoldState {
  const state = createFoldState({ createdAt: detail.createdAt ?? null })
  state.run = seedRunEvent(detail)
  state.lastOffset = detail.offsets?.events ?? 0
  state.attemptSpans = (detail.attemptSpans ?? []).map((s) => ({ ...s }))
  state.resumeCount = detail.resumeCount
    ?? state.attemptSpans.filter((s) => s.state === 'resumed').length
  const lastSpan = state.attemptSpans[state.attemptSpans.length - 1]
  state._attemptOpen = lastSpan ? lastSpan.state === 'started' || lastSpan.state === 'resumed' : false
  state.saturation = (detail.saturation ?? []).map((s) => ({ ...s }))
  state.unknownEvents = detail.unknownEvents ?? 0
  state.unknownEventTypes = { ...(detail.unknownEventTypes ?? {}) }

  const legacy = isLegacyEngine(detail.caps)

  const scopes: AttemptScope[] = (detail.attemptScopes ?? []).length
    ? (detail.attemptScopes as AttemptScope[]).map((s) => ({
      phases: clone(s.phases ?? []),
      logs: clone(s.logs ?? []),
      mail: clone(s.mail ?? []).map(stripMail),
      // Archived per-attempt agents are event-derived facts frozen at the attempt
      // boundary — the §6.4 J join never wrote to them, so unlike the live agents below
      // there is nothing to strip, and unlike the current scope there is nothing the SSE
      // stream will ever fold onto them. Absence is meaningful (pre-archival snapshot)
      // and is preserved rather than backfilled.
      ...(s.agents ? { agents: clone(s.agents) } : {}),
      // Same absence-is-meaningful rule for the scope's opening-event engine: carried
      // verbatim (null included — "this attempt's engine wrote no version"), never invented.
      ...(s.engine !== undefined ? { engine: s.engine } : {}),
    }))
    : [{
      phases: clone(detail.phases ?? []),
      logs: clone(detail.logs ?? []),
      mail: clone(detail.mail ?? []).map(stripMail),
    }]
  state.attemptScopes = scopes
  state._scope = scopes.length - 1
  const current = scopes[scopes.length - 1]
  const lastPhase = current && current.phases.length ? current.phases[current.phases.length - 1] : undefined
  state._lastPhaseIndex = lastPhase ? lastPhase.phaseIndex : null

  const byIndex: Record<number, unknown> = Object.create(null)
  for (const agent of detail.agents ?? []) {
    const seeded = {
      ...stripSteers(clone(agent)),
      _firstOffset: 0,
      _approxPhaseIndex: agent.phaseIndex ?? null,
    } as Record<string, unknown>
    // **The two projections are kept apart, and the snapshot belongs to the journal one.**
    //
    // Every field in JOURNAL_DERIVED_FIELDS is what `applyJournalJoin` writes, and the
    // snapshot the server sent is post-join — so its value for each of them is the
    // journal's answer, not the event stream's, even where an E5/E6 event could also have
    // produced it. `journalBaseFromDetail` captures exactly these from exactly this
    // snapshot, so stripping them here loses nothing: the join puts them straight back.
    //
    // What it buys is that a `sys/reset` on the journal stream can drop the journal's
    // whole contribution by clearing base + delta. Leaving a copy inside the fold gave the
    // value two homes and the reset cleared one: an emptied rotated journal kept showing
    // the old session id, usage, duration and preview forever. Fields an event writes
    // AFTER seeding stay event-derived and survive a journal reset, which is the line the
    // separation is drawn on.
    //
    // KEYLESS agents are stripped too, and that is a fix rather than an oversight: the
    // server's join falls back to `key → index` for exactly them (snapshot.js:76, :94,
    // :98), so a legacy agent with no `key` on its events DOES carry journal facts, and
    // `journalBaseFromDetail` captures those by index so the reset can take them back.
    //
    // `steers[].origin` is the same rule reached through `stripSteers` above rather than
    // through this list, because it is a field on an ARRAY member, not on the agent.
    for (const field of JOURNAL_DERIVED_FIELDS) {
      seeded[field] = (ARCHIVED_AGENT_BLANKS as Record<string, unknown>)[field]
    }
    byIndex[agent.index] = seeded
  }
  state._agentByIndex = byIndex

  // Steps are event-derived only — no journal join writes to them — so the whole
  // snapshot copy is safe to keep inside the fold, unlike agents' journal facts.
  const byKey: Record<string, unknown> = Object.create(null)
  for (const step of detail.steps ?? []) byKey[step.key] = clone(step)
  state._stepByKey = byKey

  // A pre-E7 run answers ONLY in the journal (src/engine.js:699 appends the record; the
  // `answer` EVENT at :701 belongs to the same engine cohort as every Cap), so for a
  // legacy snapshot `answered`/`answer` are a journal projection like any other and go to
  // the base. On an E7+ run the answer event carries its own value, the events stream owns
  // it, and a journal reset must NOT take it away — §9.4's "exactly one stream's buffers".
  const byQid: Record<string, unknown> = Object.create(null)
  for (const q of detail.questions ?? []) {
    const seeded = clone(q) as unknown as Record<string, unknown>
    if (legacy) { seeded.answered = false; seeded.answer = null }
    byQid[q.qid] = seeded
  }
  state._questionById = byQid

  state._fanouts = fanoutsFromStructure(detail.structure)

  // Expose the derived collections immediately: a caller may materialize before the first
  // batch lands (an empty stream is the common case for a settled run).
  return fold(state, [])
}

// ---- record classification -------------------------------------------------------------

/** The fold owns these; anything else on the events stream is counted, never applied. */
export const EVENT_TYPES = Object.freeze([
  'run', 'phase', 'agent', 'step', 'question', 'answer', 'mail', 'log', 'fanout',
])
