/**
 * The Gantt's geometry, as a PURE function of the folded snapshot (DESIGN §2.4 Timeline).
 *
 * ## Why every offset is a percentage
 *
 * The approved comps compute bar offsets in pixels against a per-viewport track width
 * (`docs/frontend/comps/lib/page-cockpit.mjs` — `GEOM_1440` / `GEOM_800` / `GEOM_480`),
 * which is how a static drawing has to do it. The product must not: the operator's §3.7
 * ruling is that the ruler, the saturation strip and the lanes scroll on ONE axis and the
 * trace is never rescaled per viewport, and a pixel model makes that a layout race between
 * three components that each measured the container separately.
 *
 * So the model here is dimensionless — every position is a percentage of the run's time
 * span — and the ONE pixel quantity, the track width, is a CSS custom property that all
 * three components share by construction (`cockpit.css`: `.tl-plot` sets the same grid
 * template for `.ruler`, `.sat-wrap` and every `.lane`). Zoom changes that one variable.
 * Nothing re-derives a scale, so nothing can disagree about one, and the whole model is
 * testable without a layout engine.
 *
 * ## What is drawn, and what is refused
 *
 * - Queue wait comes from E4 (`queuedAt`); with `caps.queueEvents === 'unsupported'` there
 *   is no wait segment at all and bars start at `running` (§6.5), which the tab says out
 *   loud rather than drawing a zero-width hatch that reads as "no wait".
 * - A bar on a DEAD run stops at the last thing the engine actually recorded. It is never
 *   extended to `now`: a run whose engine died has no `now`, and stretching the bar would
 *   state a duration nothing on disk supports (the same honesty rule the stale card obeys —
 *   `AttentionStrip.tsx`, comps `approvals.json` ruling on `cockpit-stale-1440`).
 *
 * ## The window is not a fact about any agent (round 12, B1)
 *
 * `start`/`end` are the CHART's extent: the minimum and maximum over every agent's
 * timestamps, plus the run's own. They are the right thing to lay a ruler against and the
 * wrong thing to end one agent's segment at, because the value comes from whichever agent
 * happened to be last — so drawing with it dates THIS agent's interval with SOMEONE ELSE'S
 * event. Round 12 found the two places that still did it: a dead queued agent's hatch ran to
 * `end` ("still waiting when the engine went" — but ending exactly when an unrelated agent
 * finished), and a cache hit with no timestamp of its own was marked at `start`.
 *
 * Both are now endpoint-free: a segment is drawn only between two timestamps recorded for
 * the agent it belongs to, or from one of them to `now` where the RUN's verdict
 * (`honesty.moving` / `honesty.waiting`) says the interval is genuinely still open. Where
 * neither holds there is a mark and a sentence, never a proportional bar.
 */

import type { AgentState, AgentView, Caps, RunDetail } from '../../api/types.js'
import {
  type AgentDuration, type RunHonesty, deriveHonesty, durationValue, isRunningState,
} from './honesty.js'

/** src/agent-proc.js:24 — the engine's default, used only when E4 emitted none (M10). */
export const DEFAULT_STALL_MS = 1_800_000

/** §2.4: the warning fires at 50% of the stall threshold. */
export const QUIET_FRACTION = 0.5

export interface QuietTag {
  sinceMs: number
  thresholdMs: number
  /** No `stallMs` was emitted — the threshold is the engine default, and the tag says so. */
  approximate: boolean
  /**
   * Where the silence is measured FROM. `lastOutput` is E6's `lastOutputAt`; `start` is the
   * agent's own `running` timestamp, which is what a pre-E6 run has and what the engine's own
   * stall detector starts from before the first tick (src/agent-proc.js).
   */
  from: 'lastOutput' | 'start'
}

export interface GanttLane {
  index: number
  key: string | null
  label: string
  adapter: string
  state: AgentState
  displayState: AgentState | 'orphaned'
  orphaned: boolean
  cached: boolean
  /** Percent of the span. `null` where the datum the segment needs is absent. */
  waitLeft: number | null
  /**
   * The wait's DRAWN width, or `null` where nothing on disk closes it — an orphaned queue
   * entry is a mark at `queuedAt` and no interval at all (round 12; see `QueueExtent`).
   */
  waitWidth: number | null
  /** The provenance of that right edge, which the lane's copy is written from. */
  waitKind: QueueKind
  execLeft: number | null
  execWidth: number | null
  /**
   * A cached agent never took a slot: it gets a mark at its position, not a duration — and
   * `null` where the run recorded no timestamp for the replay to be placed at.
   */
  tick: number | null
  /** E6's `lastOutputAt`, as a percent — see the note on `notches` below. */
  notch: number | null
  /**
   * How long the wait LASTED, which only a wait with a recorded end has. An open or orphaned
   * queue entry reports none rather than pairing a figure with an edge nothing recorded.
   */
  waitMs: number | null
  /**
   * The screen's reading of this agent's runtime — `honesty.duration`, unmodified. The
   * Timeline renders it with the same component the Agents table and the Structure chips
   * use, which is what stops the three from wording one agent's runtime three ways.
   */
  duration: AgentDuration
  /**
   * The figure to print, or `null` where the engine recorded no end for THIS execution
   * (§2.4/#53: absent fields are omitted, never rendered as `0`). Always
   * `durationValue(duration)`; a `truncated` lane is always `null`.
   */
  durationMs: number | null
  /** The agent is still running on a live run: the bar is open at the right. */
  open: boolean
  /**
   * The bar's right edge is a TRUNCATION BOUNDARY: this agent never wrote a terminal event
   * and is not moving, so the bar ends at the last recorded fact rather than at "now" — and
   * carries no duration, because none was ever recorded.
   */
  truncated: boolean
  quiet: QuietTag | null
  errorCode: string | null
  error: string | null
  /**
   * Every timestamp this agent carries predates `options.window` — the lane belongs to an
   * archived attempt in which this index never re-entered (its clock still dates an earlier
   * attempt's execution). Drawing that bar inside this window would clamp it to the left
   * edge and date one attempt's geometry with another's events, so the lane has NO geometry
   * and NO attempt-specific metadata either — `duration` reads `absent`, `waitMs`, `quiet`,
   * `errorCode` and `error` are `null` — because a figure or badge carried over from a
   * different attempt is the same leak in metadata form. A badge says why instead (the
   * same refusal the truncated edge makes, in attempt form). Always `false` when no window
   * is set.
   */
  preWindow: boolean
}

export interface RulerTick { at: number; pct: number; label: string }

export interface GanttModel {
  /** Absolute epoch ms. */
  start: number
  end: number
  spanMs: number
  live: boolean
  lanes: GanttLane[]
  ticks: RulerTick[]
  /** Percent position of the now-line; `null` on a run that has stopped. */
  nowPct: number | null
  /** E4 is present: wait segments and the saturation strip are real. */
  hasQueueData: boolean
  /** E6 is present: `lastOutputAt` notches and the quiet ladder are real. */
  hasProgressData: boolean
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * How far the bar is DRAWN, and — separately — whether the engine ever recorded that the
 * execution ended there (round 7, B1).
 *
 * These are two different facts and collapsing them is what produced "0ms orphaned" in the
 * committed `cockpit-stale-*` captures. A SIGKILLed agent that never emitted a progress
 * event has exactly one timestamp on disk: its `running` event. Stopping the bar there is
 * correct — it is the last thing the engine actually wrote, and extending it to `now` would
 * claim a runtime nothing supports. But `end - start` over that same pair is not a duration;
 * it is the width of the evidence, and printing it as `0ms` tells the operator the agent
 * finished instantly when the truth is that its end was never recorded. §2.4/parity #53 is
 * explicit that absent fields are "omitted, never rendered as `0`/`—` fabrications".
 *
 * So `kind` travels with `end`:
 *
 *   `settled`    a recorded terminal fact bounds the execution — `endedAt`, or E5's
 *                `durationMs` on a failed/cancelled agent the engine gave no timestamp.
 *   `open`       the agent is MOVING (`honesty.moving`), so the bar runs to `now` and the
 *                figure beside it is an honest "so far".
 *   `truncated`  no terminal fact at all. The bar stops at the last recorded fact; there is
 *                NO duration, and the lane says so instead of computing one.
 *   `unstarted`  no `running` event — there is nothing to draw.
 *
 * `endedAt` and `durationMs` are also not equally current. §6.4 step 3 clears `durationMs`
 * on a transition into `running`, but the journal join (§6.4 J) puts it straight back from
 * the LAST SETTLED `result` record — that is what makes the Agents table's lifetime figures
 * work. So a resumed agent that is running RIGHT NOW carries its previous attempt's
 * duration, and reading `durationMs` before the live-running case draws the live bar at the
 * old attempt's width — a bar that shrinks as the run continues (review round 1, B6). The
 * same stale figure is why `truncated` reports no duration rather than falling back to it:
 * an orphan's previous attempt dates nothing about the attempt that was cut off.
 *
 * Round 8 pushed that last rule into `honesty.agentDuration` so the other three surfaces
 * obey it too, and closed the matching hole in the GEOMETRY: `!running` let an ORPHANED
 * `queued` agent that carried a previous attempt's `durationMs` take the settled branch and
 * be drawn a bar of that attempt's width. The condition is now the same one `honesty` asks —
 * is this execution still open — rather than a hand-rolled reading of `displayState`.
 */
export type ExecExtent =
  | { end: null; kind: 'unstarted' }
  | { end: number; kind: 'settled' | 'open' | 'truncated' }

/**
 * The slice of the verdict the geometry needs. Taken as an OBJECT rather than as booleans
 * so the function cannot be called without one: round 7 gave it `{ live, now }` and round 8
 * found the hole that left — the E5 fallback still read `agent.durationMs` behind a
 * hand-rolled `!running` test, and `!running` is false for a `queued` orphan, so a stranded
 * agent carrying a previous attempt's duration was drawn a bar of that attempt's width.
 */
export type ExecHonesty = Pick<RunHonesty, 'moving' | 'duration'>

export function execExtent(agent: AgentView, honesty: ExecHonesty, now: number): ExecExtent {
  if (agent.startedAt == null || !finite(agent.startedAt)) return { end: null, kind: 'unstarted' }
  if (finite(agent.endedAt)) return { end: agent.endedAt, kind: 'settled' }
  // MOVING, not `agent.state === 'running'`: an orphan is never extended to `now` (round 6).
  if (honesty.moving(agent) && isRunningState(agent.state)) return { end: now, kind: 'open' }
  // E5 puts `durationMs` on failed/cancelled agents with no separate terminal timestamp,
  // and there `startedAt + durationMs` IS the recorded end. Whether that figure describes
  // this execution at all is not a question the chart may answer for itself — it is
  // `honesty.duration`'s, and `recorded` is exactly its yes.
  const reading = honesty.duration(agent)
  if (reading.kind === 'recorded') return { end: agent.startedAt + reading.ms, kind: 'settled' }
  // The last fact is the last provider output, else the start itself. A boundary, not a
  // duration — see the note above.
  return {
    end: Math.max(agent.startedAt, finite(agent.lastOutputAt) ? agent.lastOutputAt : agent.startedAt),
    kind: 'truncated',
  }
}

/** The drawn boundary alone — the window maths does not care how it was established. */
export const execEnd = (agent: AgentView, honesty: ExecHonesty, now: number): number | null =>
  execExtent(agent, honesty, now).end

/**
 * The same separation for the QUEUE WAIT (round 12, B1) — and the same reason.
 *
 * The hatch used to be closed by `startedAt ?? (live ? now : end)`, where `end` is the
 * CHART's right edge. On a dead run that edge is the maximum over every agent's timestamps,
 * so a queued agent the engine abandoned was drawn a wait ending at whenever some OTHER
 * agent last did something — a proportional interval, to scale, ending at a time never
 * recorded for this agent, which reads as "and then it stopped waiting, here". Nothing on
 * disk says that. It is the last time-honesty bypass of the same class as the bar's
 * `truncated` edge, and it is closed the same way: the endpoint travels with its provenance.
 *
 *   `settled`     a recorded transition closes the wait — the `running` event, or a terminal
 *                 event for an agent that left the queue without ever starting (a spawn
 *                 failure writes `endedAt` and no `startedAt`). Both are THIS agent's own.
 *   `open`        the run's verdict says the agent is genuinely still waiting
 *                 (`honesty.waiting`), so the hatch runs to `now` and advances with it.
 *   `unrecorded`  no transition, and the wait is not open: nothing bounds it on the right.
 *                 There is a mark at `queuedAt` and NO interval — the lane says the end was
 *                 never recorded, exactly as a truncated bar says it of an execution.
 *   `absent`      no queue event to draw (pre-E4, or a cache hit that took no slot).
 */
export type QueueKind = 'absent' | 'settled' | 'open' | 'unrecorded'

export type QueueExtent =
  | { at: null; end: null; kind: 'absent' }
  | { at: number; end: number; kind: 'settled' | 'open' }
  | { at: number; end: null; kind: 'unrecorded' }

/** No queue geometry at all — the shape `absent` always takes. */
export const NO_QUEUE: QueueExtent = { at: null, end: null, kind: 'absent' }

/**
 * The slice of the verdict the wait needs. An OBJECT for the same reason `ExecHonesty` is
 * one: the endpoint cannot be reached without having asked the run about this agent first.
 */
export type QueueHonesty = Pick<RunHonesty, 'waiting'>

export function queueExtent(agent: AgentView, honesty: QueueHonesty, now: number): QueueExtent {
  const at = finite(agent.queuedAt) ? agent.queuedAt : null
  if (at == null) return NO_QUEUE
  // The `running` event is the wait's own recorded end.
  if (finite(agent.startedAt)) return { at, end: Math.max(at, agent.startedAt), kind: 'settled' }
  // Left the queue without ever starting: a spawn failure or a cancellation writes a terminal
  // timestamp for THIS agent, and that closes the wait as honestly as a start does.
  if (finite(agent.endedAt)) return { at, end: Math.max(at, agent.endedAt), kind: 'settled' }
  // Still genuinely waiting — the one case in which `now` is this agent's own right edge.
  if (honesty.waiting(agent)) return { at, end: Math.max(at, now), kind: 'open' }
  return { at, end: null, kind: 'unrecorded' }
}

/**
 * §2.4's quiet ladder (Q2): a LIVE agent whose last provider output is older than half of
 * the emitted `stallMs`. `lastOutputAt` is a real provider-output timestamp and never a
 * progress event's arrival time (Sol-11); before the first tick the clock starts at the
 * agent's own start, which is what the engine's own stall detector does.
 *
 * **Old runs are warned about, not exempted (review round 2, B2).** §2.4 is explicit: "Old
 * runs with no emitted `stallMs`: fall back to `1_800_000` (the engine default,
 * src/agent-proc.js:24) and label the tag 'quiet for Nm (stall threshold unknown)'". Round 1
 * refused the tag outright whenever the run had neither the progress capability nor an
 * observed `lastOutputAt`, on the theory that a pre-E6 run cannot support the claim. It can:
 * `startedAt` is written by every engine that ever shipped, and a pre-E6 agent that has been
 * running for 40 minutes under a 30-minute default threshold is exactly the agent Q2 exists
 * to surface. What the old run cannot support is the PRECISION, so both softenings are
 * carried on the tag — `approximate` for the defaulted threshold and `from: 'start'` for the
 * missing output timestamp — and the lane renders them.
 */
export function quietTag(
  agent: AgentView,
  // `live` is `honesty.moving(agent)` at the call site: a tag that says "quiet for 6m" is a
  // claim that something is expected to speak again, which only a moving agent supports.
  { live, now }: { live: boolean; now: number; hasProgressData?: boolean },
): QuietTag | null {
  if (!live || !isRunningState(agent.state)) return null
  const observed = finite(agent.lastOutputAt)
  const from = observed ? agent.lastOutputAt : agent.startedAt
  if (!finite(from)) return null
  const thresholdMs = finite(agent.stallMs) && agent.stallMs > 0 ? agent.stallMs : DEFAULT_STALL_MS
  const sinceMs = now - from
  if (sinceMs < thresholdMs * QUIET_FRACTION) return null
  return {
    sinceMs,
    thresholdMs,
    approximate: !finite(agent.stallMs),
    from: observed ? 'lastOutput' : 'start',
  }
}

/**
 * Every timestamp an agent contributes to the window.
 *
 * `queuedAt` and the execution's boundary are enough: a `settled` wait ends at `startedAt`
 * or `endedAt` (both here already), an `open` one at `now` (which a live run contributes
 * once), and an `unrecorded` one at nothing — which is the whole point of round 12.
 */
function agentTimes(agent: AgentView, honesty: ExecHonesty, now: number): number[] {
  const out: number[] = []
  if (finite(agent.queuedAt)) out.push(agent.queuedAt)
  if (finite(agent.startedAt)) out.push(agent.startedAt)
  const end = execEnd(agent, honesty, now)
  if (end != null) out.push(end)
  if (finite(agent.endedAt)) out.push(agent.endedAt)
  return out
}

const STEPS_MS = [
  1_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000,
  3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000,
]

/** Offset labels: `0m`, `2m`, `1h04m`. Relative to the window start, never wall clock. */
export function tickLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m ? `${h}h${String(m).padStart(2, '0')}m` : `${h}h`
}

/**
 * Gridlines on a round unit of time — the LARGEST step that still fits `target` of them,
 * so a 14-minute run gets two-minute lines rather than the five-minute ones a
 * span/target division rounds up to.
 */
export function rulerTicks(spanMs: number, target = 8): RulerTick[] {
  if (!(spanMs > 0)) return [{ at: 0, pct: 0, label: '0s' }]
  const step = STEPS_MS.find((s) => spanMs / s <= target) ?? STEPS_MS[STEPS_MS.length - 1]!
  const out: RulerTick[] = []
  for (let at = 0; at <= spanMs; at += step) {
    out.push({ at, pct: (at / spanMs) * 100, label: tickLabel(at) })
  }
  return out
}

/**
 * Where a cache hit's replay mark goes, or `null` if the run recorded no time for it.
 *
 * The three timestamps are all the replay's own (§6.4 step 3, amended round 11): the `cached`
 * event's `t` lands in `endedAt`, and the other two exist only on snapshots from a server
 * that predates the amendment. What is NOT allowed to stand in for them is the window's
 * `start` — that is another agent's event, and a mark placed there says "replayed at the top
 * of the run" about a replay nothing dates (round 12).
 */
const cachedTick = (agent: AgentView, pct: (t: number) => number): number | null => {
  const at = finite(agent.endedAt) ? agent.endedAt
    : finite(agent.startedAt) ? agent.startedAt
      : finite(agent.queuedAt) ? agent.queuedAt : null
  return at != null ? pct(at) : null
}

export interface GanttOptions {
  now: number
  /**
   * The screen's honesty verdict (`honesty.ts`). Supplied by the Timeline so the chart, the
   * header and the Agents table cannot disagree about whether the run is alive; derived from
   * the detail when the model is built standalone. The Gantt never classifies a run state
   * itself — that rule has exactly one home (round 6).
   */
  honesty?: RunHonesty
  /**
   * Clamp the window to an explicit range — the attempt-scoped Timeline's seam (and still a
   * test seam). When an EARLIER attempt is shown, the Cockpit passes that attempt's own
   * `[start, end)` — its opening `started`/`resumed` to the instant the next attempt began
   * (or its terminal event) — so the ruler measures the attempt, not the whole lineage.
   */
  window?: { start: number; end: number }
}

/**
 * Build the whole Timeline model. Pure: same snapshot + same `now` → same output.
 */
export function ganttModel(detail: RunDetail, options: GanttOptions): GanttModel {
  const now = options.now
  const honesty = options.honesty ?? deriveHonesty(detail, { now })
  const live = honesty.live
  const caps: Caps | undefined = detail.caps
  const hasQueueData = caps?.queueEvents === 'supported'
  const hasProgressData = caps?.progress === 'supported'
  const agents = detail.agents ?? []
  // The extent is decided PER AGENT, not per run: `honesty.moving` is false for an agent
  // the server marked orphaned even on a live run, and an orphan's bar must not be drawn
  // out to `now` just because something else in the run is still producing (round 6 — the
  // same rule the Agents table's live dot now obeys). `execExtent` takes the verdict
  // itself, so there is nothing left here to get wrong.

  const stamps: number[] = []
  if (finite(detail.startedAt)) stamps.push(detail.startedAt)
  else if (finite(detail.createdAt)) stamps.push(detail.createdAt)
  if (finite(detail.endedAt)) stamps.push(detail.endedAt)
  for (const agent of agents) stamps.push(...agentTimes(agent, honesty, now))
  if (live && stamps.length) stamps.push(now)

  let start = options.window?.start ?? (stamps.length ? Math.min(...stamps) : now)
  let end = options.window?.end ?? (stamps.length ? Math.max(...stamps) : now)
  // A zero-width window would divide by zero and, worse, paint every bar at 0% — a
  // just-started run is the common case, not an edge one.
  if (!(end > start)) end = start + 1000
  if (!finite(start)) start = now
  const spanMs = end - start

  const pct = (t: number): number => {
    const raw = ((t - start) / spanMs) * 100
    return raw < 0 ? 0 : raw > 100 ? 100 : raw
  }

  const lanes = agents.map((agent): GanttLane => {
    const cached = agent.state === 'cached' || agent.cached === true
    // §6.4 step 8's post-pass is the authority; the run-level fallback is here for the
    // same reason it is in `phases.ts` — parity #58 is a claim about the whole screen,
    // and one agent's missing `displayState` must not put a spinner back on a dead run.
    const orphaned = honesty.orphaned(agent)
    const moving = honesty.moving(agent)
    const startedAt = finite(agent.startedAt) ? agent.startedAt : null
    // The archived-attempt refusal (`preWindow` on the lane): nothing this agent did falls
    // inside the attempt on screen — its clock still dates an earlier attempt's execution,
    // and clamping that geometry to the left edge would date this attempt's chart with
    // another's events. The fold's `inAttempt` flag is the authority (codex round 3): the
    // resume boundary is a byte position in the events file, not a millisecond, and a
    // closing attempt's terminal or cached event can share the `resumed` event's `t` — a
    // tie the strict `< start` comparison reads as in-window. Only a record that predates
    // the flag falls back to the every-timestamp-predates-the-window inference.
    const windowStart = options.window?.start
    const ownTimes = windowStart != null && agent.inAttempt == null
      ? agentTimes(agent, honesty, now)
      : []
    const preWindow = windowStart != null && (agent.inAttempt != null
      ? !agent.inAttempt
      : ownTimes.length > 0 && Math.max(...ownTimes) < windowStart)
    // The wait's RECORDED extent, with the provenance of ITS right edge attached — the same
    // separation the execution bar makes, for the same reason (round 12, B1).
    const queue = cached || preWindow ? NO_QUEUE : queueExtent(agent, honesty, now)
    // Queue wait is DRAWN only where E4 recorded it. Without the capability there is no
    // hatch, and the tab header says why (§6.5) instead of drawing an empty one.
    const drawn = hasQueueData ? queue : NO_QUEUE
    // The bar's RECORDED EXTENT, with the provenance of its right edge attached — the two
    // are not the same fact, and only `settled`/`open` support a duration (round 7, B1).
    const extent: ExecExtent = preWindow
      ? { end: null, kind: 'unstarted' }
      : execExtent(agent, honesty, now)
    const endedAt = cached ? null : extent.end
    // The FIGURE is a separate question from the extent and is answered in exactly one
    // place for the whole cockpit (round 8, B1). A cache hit is not special-cased here
    // either: `honesty.duration` already knows a replay never took a slot. A pre-window
    // lane reads `absent`: whatever figure the archive carries dates an EARLIER attempt's
    // execution, and printing it beside "no events in this attempt" is the same leak the
    // refused geometry closes, in metadata form.
    const duration: AgentDuration = preWindow ? { kind: 'absent' } : honesty.duration(agent)

    // The mark is drawn wherever there is a queue event; the INTERVAL only where something
    // recorded closes it. `unrecorded` therefore keeps `waitLeft` and drops `waitWidth`, and
    // the lane renders an endpoint-free orphan marker at `queuedAt` (`Timeline.tsx`).
    //
    // A zero-width interval is still emitted — an agent queued in the last instant before
    // the engine died has a real queue event and a real wait of ~0, and dropping the segment
    // leaves an empty lane that reads as missing data rather than as a measurement. `.bar`'s
    // 3px floor is what makes that mark visible without widening the claim.
    const waitLeft = drawn.at != null ? pct(drawn.at) : null
    const waitWidth = drawn.end != null && waitLeft != null
      ? Math.max(0, pct(drawn.end) - waitLeft)
      : null

    let execLeft: number | null = null
    let execWidth: number | null = null
    if (startedAt != null && endedAt != null && !cached) {
      execLeft = pct(startedAt)
      execWidth = Math.max(0, pct(endedAt) - execLeft)
    }

    const notch = hasProgressData && finite(agent.lastOutputAt) && startedAt != null && !cached
      && !preWindow
      ? pct(agent.lastOutputAt)
      : null

    return {
      index: agent.index,
      key: agent.key ?? null,
      label: agent.label ?? `agent ${agent.index}`,
      adapter: agent.adapter || 'unknown',
      state: agent.state,
      // The state the lane RENDERS, after §6.4 step 8 — not the server's raw post-pass,
      // which a quiescent run reaches the client with un-applied (round 8, B2).
      displayState: honesty.effectiveState(agent),
      orphaned,
      cached,
      waitLeft,
      waitWidth,
      waitKind: drawn.kind,
      execLeft,
      execWidth,
      // A cache hit's mark sits at the REPLAY INSTANT, which §6.4 step 3 (amended round 11)
      // puts in `endedAt` — the cached event's own `t`, and the only timestamp the run
      // records for an index it never executed. It is read FIRST because the other two are
      // the fallbacks: `queuedAt`/`startedAt` exist here only for a snapshot from a server
      // that predates the amendment. Before round 11 this chain could also reach a settled
      // PREVIOUS attempt's `startedAt` and mark the replay at a time on the far side of the
      // run — and it ended at the window's own `start`, which is the round-12 leak in its
      // second form: a replay with no timestamp of its own was marked at whichever OTHER
      // agent opened the run. There is no such mark now; the lane says the time is unrecorded.
      tick: cached && !preWindow ? cachedTick(agent, pct) : null,
      notch,
      // A wait has a LENGTH only where something recorded its end. `agent.waitMs` is E4's own
      // figure and wins where it exists; the derived form is this agent's own two stamps.
      // `open` and `unrecorded` report none — a live wait has not finished, and an orphaned
      // one never did, so any number here would describe a wait that nothing observed ending.
      waitMs: queue.kind === 'settled'
        ? (finite(agent.waitMs) ? agent.waitMs : queue.end - queue.at)
        : null,
      duration,
      // The figure beside the bar describes THE BAR — and a bar whose right edge is a
      // truncation boundary rather than a recorded end has no figure at all (round 7, B1).
      durationMs: durationValue(duration),
      open: !preWindow && moving,
      truncated: !cached && extent.kind === 'truncated',
      // The rest of the pre-window suppression: a quiet tag, an error and an error code
      // are all claims ABOUT an execution, and every execution this agent's archive
      // records belongs to an earlier attempt. `waitMs` is already `null` (the queue
      // extent above is `NO_QUEUE`), and `duration` reads `absent` — the lane's one
      // statement is the badge.
      quiet: preWindow ? null : quietTag(agent, { live: moving, now }),
      errorCode: preWindow ? null : agent.errorCode ?? null,
      error: preWindow ? null : agent.error ?? null,
      preWindow,
    }
  })

  return {
    start,
    end,
    spanMs,
    live,
    lanes,
    ticks: rulerTicks(spanMs),
    nowPct: live ? pct(now) : null,
    hasQueueData,
    hasProgressData,
  }
}

/** The zoom vocabulary of §2.4: fit the column, or a fixed number of ms per pixel. */
export type Zoom = 'fit' | number

/** §2.4's `1s` and `10s per px` stops, plus the keyboard `+`/`-` ladder between them. */
export const ZOOM_STEPS: number[] = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000]

/** Track width in px for a zoom level, or `null` for `fit` (the CSS floor takes over). */
export function trackWidth(zoom: Zoom, spanMs: number): number | null {
  if (zoom === 'fit') return null
  const px = spanMs / zoom
  // A 24h run at 100ms/px is 864,000px of div. Bounded so a mis-click cannot hang paint.
  return Math.max(MIN_TRACK_PX, Math.min(px, MAX_TRACK_PX))
}

/** The floor the plot never compresses past — below it, the whole plot scrolls (§3.3). */
export const MIN_TRACK_PX = 350
export const MAX_TRACK_PX = 40_000

/** Step the zoom one stop, `+` in and `-` out. `fit` enters the ladder at 10s/px. */
export function stepZoom(zoom: Zoom, direction: 1 | -1): Zoom {
  const current = zoom === 'fit' ? 10_000 : zoom
  const at = ZOOM_STEPS.indexOf(current)
  // `+` zooms IN — fewer ms per pixel, i.e. down the ladder.
  const next = at === -1 ? 10_000 : ZOOM_STEPS[at - direction]
  return next ?? current
}
