/**
 * The §2.4.1 phase tree's model — grouping, roll-up, and the collapse rule (parity
 * #47–#51, #119). Pure, so the collapse override can be proven without a renderer and then
 * proven again through the DOM.
 */

import type { AgentState, AgentView, RunDetail } from '../../api/types.js'
import {
  ACTIVE_STATES, type RunHonesty, agentEffectiveState, deriveHonesty, isActiveState,
  orphanedAgent,
} from './honesty.js'

/**
 * §2.4.1's roll-up precedence, with `cancelled` folded in beside `failed`: both are
 * terminal non-success, and a phase holding one of each must not read as merely "running".
 */
export const ROLLUP_ORDER: readonly AgentState[] = [
  'failed', 'cancelled', 'running', 'queued', 'cached', 'done',
]

// §6.4 step 8's rules — `ACTIVE_STATES`/`isActiveState` and `orphanedAgent` — are
// `honesty.ts`'s, not this file's (see that module's note on the class of defect it closes).
// Re-exported here only because the phase tree's own model is the historical door onto them.
export { ACTIVE_STATES, isActiveState, orphanedAgent }

export interface Rollup {
  /** The precedence winner over the group's RAW states — what the group contains. */
  state: AgentState
  /** …and whether rendering that state as-is would claim liveness a dead run has not got. */
  orphaned: boolean
}

export interface PhaseGroup {
  /** `null` is the trailing "no phase" section (parity #51) — never a dropped agent. */
  phaseIndex: number | null
  title: string
  /** A phase event was observed, or an agent claims it. */
  reached: boolean
  /** Declared in `meta.phases` (E3) and not yet reached. */
  pending: boolean
  /** Old-run heuristic assignment (§6.4 step 8) — the UI labels it. */
  approximate: boolean
  agents: AgentView[]
  /** `null` for a pending phase, which has no agents to roll up. */
  rollup: Rollup | null
  /** The run this phase belongs to has stopped — §6.4 step 8's precondition. */
  dead: boolean
  done: number
  total: number
}

/**
 * The group's mark, in two parts.
 *
 * `state` is the precedence winner over the agents' OWN states, never `displayState`:
 * `orphaned` is a rendering of the run's fate onto an agent, and rolling it up would
 * erase what the phase actually contains — a phase of five stranded agents would read
 * the same as a phase of one.
 *
 * `orphaned` is the honesty half. A phase whose winner is `running` or `queued` on a run
 * that has stopped is not running or queued: nothing is going to happen in it. Rendered
 * raw it draws a SPINNING glyph, so opening Phases on a dead run put motion on screen
 * that claimed the engine was alive — the exact fabrication the stale card's copy
 * forbids two panels away (review round 4, B1). The caller renders the winner through
 * this flag so the group keeps its meaning and loses the animation.
 */
export const rollupState = (
  agents: readonly AgentView[], dead = false,
): Rollup | null => {
  if (!agents.length) return null
  const seen = new Set(agents.map((a) => a.state))
  const state = ROLLUP_ORDER.find((s) => seen.has(s)) ?? agents[0]!.state
  return {
    state,
    // EVERY holder of the winning state, not some: a group is only orphaned when nothing
    // in it can still move. One agent whose post-pass is missing must not strip the
    // spinner off a phase that genuinely has an agent producing output.
    orphaned: isActiveState(state)
      && agents.filter((a) => a.state === state).every((a) => orphanedAgent(a, dead)),
  }
}

/** A phase's `done/total` (parity #49): a cached agent is done — it produced its result. */
export const doneCount = (agents: readonly AgentView[]): number =>
  agents.filter((a) => a.state === 'done' || a.state === 'cached').length

/**
 * Phases in DECLARATION order first (`meta.phases` via E3), then observed phase events
 * appended in `phaseIndex` order (parity #47), then the trailing no-phase section.
 *
 * The two lists are joined on `phaseIndex`, which is the identity §6.4 step 2 gives a
 * phase — titles repeat legally (Sol-10), so joining on the title would merge two distinct
 * phases that happen to share a name.
 */
export function phaseGroups(detail: RunDetail | null, honesty?: RunHonesty | null): PhaseGroup[] {
  if (!detail) return []
  const agents = detail.agents ?? []
  // The run's own liveness, read once for every group in it (§6.4 step 8) — and read from
  // the SCREEN's verdict when there is one, so a phase rollup cannot disagree with the
  // header two panels above it.
  const dead = honesty != null ? honesty.dead : deriveHonesty(detail, { now: 0 }).dead
  const observed = new Map((detail.phases ?? []).map((p) => [p.phaseIndex, p]))
  const byPhase = new Map<number, AgentView[]>()
  const noPhase: AgentView[] = []
  for (const agent of agents) {
    if (agent.phaseIndex == null) { noPhase.push(agent); continue }
    const list = byPhase.get(agent.phaseIndex)
    if (list) list.push(agent)
    else byPhase.set(agent.phaseIndex, [agent])
  }

  const out: PhaseGroup[] = []
  const emitted = new Set<number>()
  const push = (index: number, title: string, declared: boolean) => {
    if (emitted.has(index)) return
    emitted.add(index)
    const list = byPhase.get(index) ?? []
    const view = observed.get(index)
    const reached = view?.reached ?? list.length > 0
    out.push({
      phaseIndex: index,
      title,
      reached,
      // A declared phase with no agents and no phase event has not been entered.
      pending: declared && !reached && list.length === 0,
      approximate: view?.approximate ?? list.some((a) => a.phaseApproximate),
      agents: list,
      rollup: rollupState(list, dead),
      dead,
      done: doneCount(list),
      total: list.length,
    })
  }

  const declared = detail.declaredPhases ?? []
  declared.forEach((phase, index) => push(index, phase.title ?? `phase ${index}`, true))
  for (const view of [...(detail.phases ?? [])].sort((a, b) => a.phaseIndex - b.phaseIndex)) {
    push(view.phaseIndex, view.title ?? `phase ${view.phaseIndex}`, false)
  }
  // An agent can carry a phaseIndex no phase event ever named (an old run's heuristic
  // assignment, or a phase event lost to a torn line). It gets a group rather than a hole.
  for (const index of [...byPhase.keys()].sort((a, b) => a - b)) {
    push(index, `phase ${index}`, false)
  }

  if (noPhase.length) {
    out.push({
      phaseIndex: null,
      title: 'no phase',
      reached: true,
      pending: false,
      approximate: false,
      agents: noPhase,
      rollup: rollupState(noPhase, dead),
      dead,
      done: doneCount(noPhase),
      total: noPhase.length,
    })
  }
  return out
}

/**
 * Parity #48: a phase that was never entered reads "pending" live and "not run" after.
 * The wording is `honesty.pendingLabel` — one liveness rule, one place (see `honesty.ts`).
 */
export function pendingLabel(honesty: RunHonesty): string {
  return honesty.pendingLabel
}

/**
 * Parity #50, normative. Three rules in strict precedence:
 *
 *   1. an explicit user toggle wins, for the life of the page, and later fold updates must
 *      not revert it — which is why the map is keyed by `(runId, phaseIndex)` and consulted
 *      BEFORE the automatic rule rather than seeded into it;
 *   2. the phase containing the selected agent defaults open;
 *   3. a phase whose agents are all done/cached auto-collapses.
 */
export function phaseOpen(
  group: PhaseGroup,
  { toggled, selectedAgent }: {
    toggled: boolean | undefined
    selectedAgent: number | null
  },
): boolean {
  if (toggled !== undefined) return toggled
  if (selectedAgent != null && group.agents.some((a) => a.index === selectedAgent)) return true
  if (group.pending) return false
  if (!group.agents.length) return false
  return !group.agents.every((a) => a.state === 'done' || a.state === 'cached')
}

/** The per-page override map's key. One page, one run — but the key carries both (#50). */
export const toggleKey = (runId: string, phaseIndex: number | null): string =>
  `${runId}::${phaseIndex ?? 'none'}`

/**
 * The count line: "2 done · 1 cached · 3/3" — absent categories are omitted, not zeroed.
 *
 * On a dead run the stranded agents are counted as `orphaned`, matching their own chips
 * one row below. "2 running" under a header that says the engine is gone is the same
 * false claim the spinner makes, in words.
 */
const COUNT_ORDER = ['done', 'cached', 'failed', 'cancelled', 'orphaned', 'running', 'queued'] as const

export function phaseCounts(group: PhaseGroup): string {
  const by = new Map<string, number>()
  for (const agent of group.agents) {
    // The SAME derivation the row's glyph, chip, accessible name and sort key use
    // (`honesty.agentEffectiveState`) — the count line is a fourth reading of one agent's
    // state, and a fourth hand-rolled copy of the rule is how round 8's B2 happened.
    const label = agentEffectiveState(agent, orphanedAgent(agent, group.dead))
    by.set(label, (by.get(label) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const state of COUNT_ORDER) {
    const n = by.get(state)
    if (n) parts.push(`${n} ${state}`)
  }
  parts.push(`${group.done}/${group.total}`)
  return parts.join(' · ')
}
