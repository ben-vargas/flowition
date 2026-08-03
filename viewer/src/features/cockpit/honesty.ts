/**
 * ONE run-honesty derivation for the whole cockpit (DESIGN §6.4 step 8, §2.4, parity
 * #46/#58, §5.4.2's liveness tiers).
 *
 * ## Why this module exists
 *
 * Five review rounds each fixed a different widget that claimed something the run could not
 * support: a spinning phase rollup on a dead run, a container header still turning, a
 * lineage segment growing toward `now`, a "live from usage-cum" dot beside an orphaned
 * agent's tokens, an elapsed clock counting a runtime that ended at page-open time. They
 * are not five defects. They are ONE rule, violated in five places because each widget
 * derived the rule for itself out of raw agent state, `detail.state`, or `Date.now()`:
 *
 *   **The UI must never claim liveness, motion, or knowledge that the authoritative run
 *   state does not support.**
 *
 * So the derivation lives here, once, and every cockpit widget consumes it. The rules a
 * component is forbidden to re-derive are exactly the ones this module exports:
 *
 *   • is the RUN live (`live`/`dead`/`quiescent`) — never `state === 'stale'`, never
 *     `terminalOrStale`, never a guess from timestamps;
 *   • is an AGENT stranded (`orphaned`), genuinely producing output (`moving`), or still
 *     genuinely WAITING for a slot (`waiting`) — the three tenses a chart may draw;
 *   • what state does an agent's row actually SHOW (`effectiveState`) — the one string the
 *     glyph, the chip, the accessible name and the sort comparator all read;
 *   • how long did an agent run (`duration`) — see "The agent clock" below;
 *   • is a QUESTION still answerable (`abandoned`, `openQuestions`);
 *   • is there a runtime to show at all (`clock`) — the one place a duration may be built.
 *
 * `cockpit-honesty.test.ts` enforces the boundary as a source grep: no other file under
 * `features/cockpit/` may import `runIsLive`/`runIsDead`/`terminalOrStale`, and none may
 * read a wall clock. That is what stops the sixth site from being written.
 *
 * ## The clock, and the fabrication it replaced
 *
 * `endedAt` is written from a terminal `run` event and from nothing else (§6.2,
 * src/viewer/summaries.js). A run that is not live and wrote none has **no end time and
 * therefore no duration** — neither `run.lock`'s mtime (it dates the ACQUISITION) nor the
 * moment the operator opened the page may stand in for one. `elapsed(startedAt, null, now)`
 * did exactly that: it froze at `now - startedAt`, so a corrupt-result run's header read
 * "elapsed 14m2s" — a number that changes with when you opened the tab, printed in bold
 * beside a lineage strip that correctly says the time of death was never recorded.
 *
 * `clock` therefore has four shapes and only two of them carry a number.
 *
 * ## The agent clock, and the number that belongs to a different attempt
 *
 * `agent.durationMs` is a JOURNAL-DERIVED field (§6.4 J, `fold/index.ts`'s
 * `JOURNAL_DERIVED_FIELDS`): the join restores it from the LAST SETTLED `result` record for
 * the agent's key. §6.4 step 3 clears it on a transition into `running`, and the join then
 * puts it straight back — which is exactly right for a lifetime figure and exactly wrong for
 * "how long has this execution been going". A resumed agent that is running right now, or
 * one an engine abandoned mid-flight, therefore carries a number that dates a DIFFERENT
 * attempt.
 *
 * Round 7 fixed that in the Gantt alone, so one orphan could read "end unrecorded" beside
 * its bar and "1m1s" in the Agents table, the Structure chip and the container roll-up — the
 * same fabrication the bar had just stopped making, three widgets over. `duration` is the
 * one reading all four consume, and it separates the four cases the raw field cannot:
 *
 *   `recorded`    a terminal fact bounds this execution — `endedAt`, or E5's `durationMs`
 *                 on a failed/cancelled agent, or a cache hit's replayed lifetime.
 *   `live`        the agent is MOVING, so the figure is an honest "so far" and advances.
 *   `prior`       the current execution has no recorded end and the `durationMs` on file
 *                 belongs to an earlier attempt. It is NOT a reading of this execution, so
 *                 no surface prints it as one — `durationValue` returns `null` and the
 *                 absence explains itself (`durationAbsence`).
 *   `unrecorded`  the same, with nothing retained: started, never ended.
 *   `absent`      no execution to measure at all — a queued agent that never started.
 */

import { createContext, useContext, useMemo } from 'react'
import type { AgentState, AgentView, QuestionView, RunDetail, RunState } from '../../api/types.js'
import { runIsDead, runIsLive, terminalOrStale } from '../../fold/index.js'

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The two states §6.4 step 8 turns into `orphaned` once the run itself is over. */
export const ACTIVE_STATES: readonly AgentState[] = ['running', 'queued']

/**
 * Is this a RECORDED active state — the question about the journal, not about the present.
 *
 * The distinction is the whole of round 7's B2. `agent.state === 'running'` is a fact about
 * what the last event said; whether that agent is *still* running is a fact about the RUN,
 * and only `moving`/`orphaned` know it. Writing the comparison inline reads like the second
 * question and answers the first, which is how the Structure tab came to tell an operator
 * that stage 0 was "still running" on a `corrupt-result` run whose engine had been gone for
 * twenty minutes.
 *
 * So the raw comparison has a name, the name says which question it answers, and
 * `boundary.test.ts` refuses the inline form everywhere under `features/cockpit/`. A caller
 * that wants the present tense has to reach for `honesty.moving` — there is no longer a
 * shorter thing to type.
 */
export const isActiveState = (state: AgentState | 'orphaned' | null | undefined): boolean =>
  state != null && (ACTIVE_STATES as readonly string[]).includes(state)

/** The same rule, narrowed to `running` — e.g. "which timestamp is current" (`gantt.ts`). */
export const isRunningState = (state: AgentState | 'orphaned' | null | undefined): boolean =>
  state === 'running'

/** And narrowed to `queued`, for the wait-column chip that describes the record. */
export const isQueuedState = (state: AgentState | 'orphaned' | null | undefined): boolean =>
  state === 'queued'

/**
 * §5.4.2's live tier, as the ONE predicate the cockpit is allowed to ask.
 *
 * It exists so the page can decide whether to subscribe a 1 Hz clock BEFORE it has a `now`
 * to derive the full verdict with, without importing `runIsLive` a second time. Everything
 * else reads `RunHonesty`.
 */
export const isRunLive = (state: RunState | null | undefined): boolean =>
  state != null && runIsLive(state)

/**
 * What the header may say about how long the run ran.
 *
 *   `ticking`     live: the clock advances 1/s from the recorded start (parity #46).
 *   `settled`     a terminal event was written: a real, frozen duration.
 *   `unrecorded`  not live and no `endedAt` — there is no duration, and the screen says so
 *                 and reports the recorded start instead.
 *   `unstarted`   no `startedAt` on disk yet.
 */
export type RunClock =
  | { kind: 'ticking'; startedAt: number; ms: number }
  | { kind: 'settled'; startedAt: number; endedAt: number; ms: number }
  | { kind: 'unrecorded'; startedAt: number; quiescent: boolean }
  | { kind: 'unstarted' }

/**
 * What a widget may say about how long ONE agent ran. See "The agent clock" above.
 *
 * Only `recorded` and `live` carry a figure a surface may print; `prior` carries the
 * retained number so the explanation can name it, never so a cell can render it.
 */
export type AgentDuration =
  | { kind: 'recorded'; ms: number }
  | { kind: 'live'; ms: number }
  | { kind: 'prior'; ms: number }
  | { kind: 'unrecorded' }
  | { kind: 'absent' }

/** The figure to print, or `null` — the ONE gate between the reading and the pixels. */
export const durationValue = (reading: AgentDuration): number | null =>
  reading.kind === 'recorded' || reading.kind === 'live' ? reading.ms : null

export interface RunHonesty {
  /** The run this verdict belongs to — a context from another run is never adopted. */
  runId: string
  /** The authoritative state (§6.2 `deriveRunState`), which may lead `detail.state`. */
  state: RunState | null
  /** §5.4.2's live tier — `{running, starting}` and nothing else. */
  live: boolean
  dead: boolean
  /** Dead but not terminal: `{stale, unknown, corrupt-result}` — the engine simply went. */
  quiescent: boolean
  /**
   * The clock the screen may read. On a dead run this is the page-open instant and is legal
   * ONLY for "how long ago was this recorded" phrasing — never for building a run duration,
   * which is what `clock` is for.
   */
  now: number
  clock: RunClock
  startedAt: number | null
  /** Recorded, or `null` — never substituted (see the module note). */
  endedAt: number | null
  /** §6.4 step 8: is this agent's `running`/`queued` a claim about the present? */
  orphaned: (agent: AgentView) => boolean
  /** May a widget mark this agent's numbers as still moving? */
  moving: (agent: AgentView) => boolean
  /**
   * Is this agent's QUEUE WAIT still open — the only case in which a surface may run it to
   * `now` (round 12, B1).
   *
   * `moving` cannot answer this: it is narrowed to `running`, so a still-queued agent is not
   * moving and the Gantt had no verdict to ask. It asked the RUN instead — `live ? now : end`
   * — and on a dead run `end` is the chart's own extent, which is the maximum over every
   * agent's timestamps. A queued agent stranded when the engine died was therefore drawn a
   * proportional wait ending at another agent's event: an interval nothing on disk records
   * for this agent, implying a moment its wait was over. The rule is the same one `moving`
   * carries, in the other tense — the present is a claim, and only the run may make it.
   */
  waiting: (agent: AgentView) => boolean
  /**
   * The state the row actually RENDERS, after §6.4 step 8 (`agentEffectiveState`).
   *
   * Every consumer of "what state is this agent in, on screen" reads this: the glyph, the
   * chip, the accessible name and — the round-8 blocker — the `state` column's sort
   * comparator, which was still reading the raw `displayState ?? state` and so ordered a
   * quiescent run's rows by `running`/`queued` under cells that all said `orphaned`.
   */
  effectiveState: (agent: AgentView) => AgentState | 'orphaned'
  /** How long this agent ran, and whether that is sayable at all (see the module note). */
  duration: (agent: AgentView) => AgentDuration
  /** Asked, unanswered, and the run is over — the engine rejects pending asks on abort. */
  abandoned: (question: QuestionView) => boolean
  orphanedCount: number
  openQuestions: QuestionView[]
  /** Parity #48: a phase never entered reads "pending" live and "not run" after. */
  pendingLabel: string
}

export interface HonestyOptions {
  now: number
  /**
   * The run store's own verdict when it has one. `runStore` polls `deriveRunState`
   * separately from the snapshot (§6.4), so it can know the engine has gone a poll before
   * `detail.state` does; the cockpit passes it in rather than letting each widget read the
   * older of the two.
   */
  state?: RunState | null
}

/**
 * §6.4 step 8's post-pass is the AUTHORITY: the server writes `displayState: 'orphaned'`,
 * and a client that disagreed with it would be second-guessing the only reader of the
 * `run.lock`. The run-level fallback exists because parity #58 is a claim about the whole
 * screen: one agent whose post-pass is missing (an old snapshot, a state the server's
 * `materializeFold` did not treat as dead) must not be enough to put a spinner back.
 */
export const orphanedAgent = (agent: AgentView, dead: boolean): boolean =>
  agent.displayState === 'orphaned'
  || (dead && isActiveState(agent.state))

/**
 * The state the screen shows for this agent: §6.4 step 8's verdict where it applies, and
 * otherwise the server's own `displayState` (which may carry a value from a newer engine
 * this client does not know — parity #56 keeps those neutral rather than dropping them).
 */
export const agentEffectiveState = (
  agent: AgentView, orphaned: boolean,
): AgentState | 'orphaned' => (orphaned ? 'orphaned' : agent.displayState ?? agent.state)

/**
 * How long this agent ran (see "The agent clock" in the module note).
 *
 * `moving` and `orphaned` arrive as the RUN's verdict about this agent — never re-derived
 * here from `agent.state`, which is what the last event said rather than what is true now.
 */
export function agentDuration(
  agent: AgentView,
  { moving, orphaned, now }: { moving: boolean; orphaned: boolean; now: number },
): AgentDuration {
  const retained = finite(agent.durationMs) ? agent.durationMs : null
  const startedAt = finite(agent.startedAt) ? agent.startedAt : null
  const endedAt = finite(agent.endedAt) ? agent.endedAt : null
  // A cache hit never executed in this run: its `queued`/`running`/`done` timestamps are
  // the same instant, so `endedAt - startedAt` is `0ms` — a fabrication of exactly the kind
  // parity #53 forbids. What it legitimately carries is the ORIGINAL's recorded lifetime.
  if (agent.state === 'cached' || agent.cached === true) {
    return retained != null ? { kind: 'recorded', ms: retained } : { kind: 'absent' }
  }
  // A terminal event bounds the execution. That is a recorded fact and it outlives the run
  // — a dead run's settled agents keep their real durations (round 7's B1 control).
  if (endedAt != null && startedAt != null) {
    return { kind: 'recorded', ms: retained ?? Math.max(0, endedAt - startedAt) }
  }
  // Never began, so there is no execution for a number to describe. Anything on file is a
  // previous attempt's by construction.
  if (startedAt == null) {
    return retained != null ? { kind: 'prior', ms: retained } : { kind: 'absent' }
  }
  // Genuinely producing output: the figure is "so far", and it advances because `now` does
  // (`useTick` only runs the clock while the run is live).
  if (moving) return { kind: 'live', ms: Math.max(0, now - startedAt) }
  // The current execution is still `running`/`queued` on the record, or step 8 stranded it.
  // Either way NO end was ever written for it, and the journal join's `durationMs` dates
  // the last SETTLED attempt — a different execution, which no cell may print as this one.
  if (orphaned || isActiveState(agent.state)) {
    return retained != null ? { kind: 'prior', ms: retained } : { kind: 'unrecorded' }
  }
  // Settled without a terminal timestamp: E5 puts `durationMs` on failed/cancelled agents
  // the engine gave no `endedAt`, and that IS this execution's own recorded figure.
  return retained != null ? { kind: 'recorded', ms: retained } : { kind: 'unrecorded' }
}

/** Why a duration cell is blank — the `title` an absent cell carries, never a rendered value. */
export function durationAbsence(reading: AgentDuration): string {
  switch (reading.kind) {
    case 'prior':
      return 'this attempt recorded no end; the duration on file belongs to an earlier attempt'
    case 'unrecorded':
      return 'this agent started and no end was ever recorded'
    default:
      return 'this agent never started, so there is no duration to record'
  }
}

export function runClock(
  { startedAt, endedAt, live, quiescent, now }: {
    startedAt: number | null
    endedAt: number | null
    live: boolean
    quiescent: boolean
    now: number
  },
): RunClock {
  if (startedAt == null) return { kind: 'unstarted' }
  if (endedAt != null) {
    return { kind: 'settled', startedAt, endedAt, ms: Math.max(0, endedAt - startedAt) }
  }
  // A live run's runtime IS `now - startedAt`; that is the one duration the page-open clock
  // legitimately participates in, and it advances while the operator watches.
  if (live) return { kind: 'ticking', startedAt, ms: Math.max(0, now - startedAt) }
  return { kind: 'unrecorded', startedAt, quiescent }
}

/** Derive the whole verdict. Pure: same snapshot + same `now` → same object shape. */
export function deriveHonesty(detail: RunDetail, options: HonestyOptions): RunHonesty {
  const state = options.state ?? detail.state ?? null
  const live = state != null && runIsLive(state)
  const dead = state == null || runIsDead(state)
  // `stale` is in `terminalOrStale` but is NOT terminal — it is the archetype of the
  // quiescent tier, so it is subtracted back out here rather than folded in.
  const terminal = state != null && terminalOrStale(state) && state !== 'stale'
  const quiescent = dead && !terminal
  const startedAt = finite(detail.startedAt) ? detail.startedAt : null
  const endedAt = finite(detail.endedAt) ? detail.endedAt : null
  const agents = detail.agents ?? []
  const questions = detail.questions ?? []

  const orphaned = (agent: AgentView): boolean => orphanedAgent(agent, dead)
  const moving = (agent: AgentView): boolean =>
    live && isRunningState(agent.state) && !orphaned(agent)
  const waiting = (agent: AgentView): boolean =>
    live && isQueuedState(agent.state) && !orphaned(agent)
  const abandoned = (question: QuestionView): boolean =>
    question.abandoned || (dead && !question.answered)

  return {
    runId: detail.runId,
    state,
    live,
    dead,
    quiescent,
    now: options.now,
    clock: runClock({ startedAt, endedAt, live, quiescent, now: options.now }),
    startedAt,
    endedAt,
    orphaned,
    moving,
    waiting,
    effectiveState: (agent: AgentView) => agentEffectiveState(agent, orphaned(agent)),
    duration: (agent: AgentView) => agentDuration(agent, {
      moving: moving(agent), orphaned: orphaned(agent), now: options.now,
    }),
    abandoned,
    orphanedCount: agents.filter(orphaned).length,
    openQuestions: questions.filter((q) => !q.answered && !abandoned(q)),
    pendingLabel: dead ? 'not run' : 'pending',
  }
}

/**
 * The cockpit provides ONE verdict for the whole screen (`Cockpit.tsx`), derived from the
 * run store's authoritative state rather than from any single widget's props.
 */
export const RunHonestyContext = createContext<RunHonesty | null>(null)

/**
 * Consume the screen's verdict, falling back to deriving it from the detail in hand.
 *
 * The fallback is not a loophole — it is the same function, on the same rules, and it is
 * what keeps a component honest when it is mounted outside the cockpit (the header is
 * rendered standalone by tests and by §2.2's rail). The `runId` guard is what stops one
 * run's verdict being read against another's snapshot while the rail swaps runs.
 */
export function useRunHonesty(detail: RunDetail, now: number): RunHonesty {
  const provided = useContext(RunHonestyContext)
  const local = useMemo(() => deriveHonesty(detail, { now }), [detail, now])
  return provided != null && provided.runId === detail.runId ? provided : local
}
