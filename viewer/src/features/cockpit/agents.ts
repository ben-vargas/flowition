/**
 * The Agents table's model (DESIGN §2.4, parity #52–#54) — column definitions, the
 * absent-value rule, and sorting.
 *
 * The rule that shapes all three: **a field the engine never wrote is BLANK**, never `0`,
 * never `—` (parity #53; §2.3's "empty ≠ zero"). That has a consequence for sorting which
 * is easy to get wrong: an absent number is not a small number. Sorting by cost ascending
 * must not put the agents that reported no cost at the top as though they were the cheap
 * ones. Absent values therefore sort LAST in both directions — they are not in the ordering
 * at all, they are appended to it.
 */

import type { AgentView } from '../../api/types.js'
import { fmtCost, fmtDuration, fmtTokens } from '../../format/fmt.js'
import { type RunHonesty, durationValue } from './honesty.js'

/**
 * The slice of `honesty.ts` this module needs: whether an agent's numbers may be presented
 * as still moving, whether it is stranded, what state its row shows and how long it ran.
 * Taken as a PARAMETER and never derived — a function that could answer "is this live?" from
 * `agent.state` alone is exactly how a quiescent run kept its live-token dots (round 6, B1),
 * and one that reads `displayState` directly is how the state column came to SORT rows as
 * running while every cell in them said orphaned (round 8, B2).
 */
export type AgentHonesty = Pick<
  RunHonesty, 'moving' | 'orphaned' | 'effectiveState' | 'duration'
>

export type SortDir = 'asc' | 'desc'

export type SortKey =
  | 'index' | 'label' | 'adapter' | 'phase' | 'state'
  | 'wait' | 'duration' | 'input' | 'output' | 'cost'
  | 'lastTool' | 'attempts' | 'steers'

export interface ColumnDef {
  key: SortKey
  /** The header label; `null` where the header is a glyph column. */
  title: string
  numeric: boolean
  /** The first click on this header sorts this way — biggest-first for magnitudes. */
  initial: SortDir
}

export const COLUMNS: readonly ColumnDef[] = [
  { key: 'index', title: '#', numeric: true, initial: 'asc' },
  { key: 'label', title: 'label', numeric: false, initial: 'asc' },
  { key: 'adapter', title: 'adapter · model · effort', numeric: false, initial: 'asc' },
  { key: 'phase', title: 'phase', numeric: false, initial: 'asc' },
  // §2.4: "state (+error code chip **and the error message inline**…— parity #54)". The
  // error belongs to the STATE cell; `last tool` is its own column (#53) and the two are
  // never merged — a failed agent's last tool is exactly the datum that says where it died
  // (review round 2, B1).
  { key: 'state', title: 'state / error', numeric: false, initial: 'asc' },
  { key: 'wait', title: 'wait', numeric: true, initial: 'desc' },
  { key: 'duration', title: 'dur', numeric: true, initial: 'desc' },
  { key: 'input', title: 'in', numeric: true, initial: 'desc' },
  { key: 'output', title: 'out', numeric: true, initial: 'desc' },
  { key: 'cost', title: 'cost', numeric: true, initial: 'desc' },
  { key: 'lastTool', title: 'last tool', numeric: false, initial: 'asc' },
  { key: 'attempts', title: 'att', numeric: true, initial: 'desc' },
  { key: 'steers', title: 'steer', numeric: true, initial: 'desc' },
]

/**
 * LIFETIME-TO-DATE tokens (§2.4, §2.1 Q4), and the one arithmetic in this file that is
 * easy to get subtly, invisibly wrong.
 *
 * Three per-agent token figures reach the client and NONE of them is the answer alone:
 *
 *   `usage`       the sum over the key's settled journal `result` records (Sol-13) — a
 *                 lifetime figure, but blind to the attempt currently in flight.
 *   `liveTokens`  the LAST `usage-cum` record. For an adapter that reports the provider
 *                 thread's cumulative totals this contains the earlier attempts too; for
 *                 a per-event adapter it is the current attempt ONLY, because the counter
 *                 restarts at `{0,0}` on every attempt (src/agent-proc.js:42,482,520).
 *                 Reading it as the lifetime therefore undercounts every resumed agent on
 *                 half the adapters — silently, and worst for the agents that burned most.
 *   `cumTokens`   the zero-reset-aware chain of positive `usage-cum` deltas (§6.2), which
 *                 is a lifetime figure in BOTH dialects.
 *
 * So the answer is `max(usage, cumTokens)` componentwise — the same rule `Journal.load`
 * uses to charge the budget (src/journal.js:167–176). `max`, not a sum: a continued
 * cumulative report already contains what the settled records charged, and adding them
 * would double every thread-cumulative agent's burn.
 *
 * Absent stays absent: an agent that reported neither returns `null`, never `0` (#53).
 */
export const lifetimeTokens = (
  agent: AgentView, field: 'input' | 'output',
): number | null => {
  const settled = agent.usage?.[field] ?? null
  const chained = agent.cumTokens?.[field] ?? null
  return settled == null ? chained : chained == null ? settled : Math.max(settled, chained)
}

export interface TokenReading { value: number | null; live: boolean }

/**
 * The lifetime figure, and whether it is STILL MOVING (review round 6, B1).
 *
 * `live` used to read `agent.state === 'running' && liveTokens != null`, which is a fact
 * about the last record the agent wrote and not about the present. On a quiescent run —
 * `corrupt-result`, `stale`, `unknown` — the agent is still `running` in the journal
 * because nothing ever wrote its terminal record, so the table kept a pulsing "live from
 * usage-cum" dot and an accessible name ending "(live)" beside an agent the same row
 * renders ORPHANED. Two contradictory claims, one row apart.
 *
 * `honesty.moving` is the whole rule: the run is in §5.4.2's live tier AND the agent is not
 * stranded. Nothing here may shortcut it.
 */
const lifetime = (
  agent: AgentView, field: 'input' | 'output', honesty: AgentHonesty,
): TokenReading => ({
  value: lifetimeTokens(agent, field),
  live: honesty.moving(agent) && agent.liveTokens?.[field] != null,
})

export const outputTokens = (agent: AgentView, honesty: AgentHonesty): TokenReading =>
  lifetime(agent, 'output', honesty)

export const inputTokens = (agent: AgentView, honesty: AgentHonesty): TokenReading =>
  lifetime(agent, 'input', honesty)

/**
 * §2.1 Q4's per-agent token bars: each agent's output burn as a fraction of the busiest
 * agent's, so the row that is eating the budget is findable by shape before it is read.
 *
 * The scale is the MAXIMUM rather than the total: a share-of-total bar on a ten-agent run
 * is ten hairlines, and Q4 is a comparison between agents, not a pie.
 */
export const tokenScale = (agents: readonly AgentView[]): number =>
  agents.reduce((max, a) => Math.max(max, lifetimeTokens(a, 'output') ?? 0), 0)

/** `0`–`1`; `null` when the agent reported nothing, which draws no bar at all (#53). */
export function tokenShare(agent: AgentView, scale: number): number | null {
  const value = lifetimeTokens(agent, 'output')
  if (value == null) return null
  if (!(scale > 0)) return 0
  return Math.min(1, value / scale)
}

/**
 * §3.6's screen-reader contract for the Agents table (review round 5, B2).
 *
 * The table is a CSS grid of one BUTTON per row — the row is the control that opens the
 * transcript — and a button's `aria-label` REPLACES its subtree in the accessibility tree.
 * So the label is not a decoration on the row: it is the entire row, as read. A label of
 * "agent 5 review:tests" therefore did not annotate thirteen columns, it deleted twelve of
 * them, including the state, the burn, the token share and the cost the whole tab exists to
 * report (§2.1 Q4).
 *
 * This builds that reading in the visual column order — and it makes the reading agree with
 * the pixels rather than contradicting them (review round 6, B2).
 *
 * **Absent is OMITTED, not announced.** §2.4 is explicit: "Fields that are absent are
 * omitted, never rendered as `0`/`—` fabrications (#53)", and the table obeys it — an
 * unreported cost is a blank cell. Round 5 read the same absence out loud as "cost not
 * reported", so the two readings of one table disagreed about what the run recorded, and the
 * screen-reader user was told thirteen facts where only nine exist. A phrase that says
 * "there is nothing here" IS the `—` this parity item forbids, spoken.
 *
 * **A known zero is a measurement and is always announced.** `attempts` and `steers` are
 * counts the client always has (§6.2 — `attempts: number`, `steers: []`), so `0` is a fact
 * about the agent, not a gap in the journal; `attempts === 0` was being reported as
 * "attempts not reported" for every queued agent, which is the same class of lie in the
 * other direction.
 */
export function rowLabel(
  agent: AgentView,
  honesty: AgentHonesty,
  context: { phaseTitle: string | null; share: number | null },
): string {
  const out = outputTokens(agent, honesty)
  const input = inputTokens(agent, honesty)
  const effective = honesty.effectiveState(agent)
  // "orphaned (running)" rather than a bare "orphaned": the reading has to carry BOTH the
  // verdict and the record it was applied to, which is what `StatusGlyph`'s own hidden text
  // says one element away.
  const state = effective === 'orphaned' ? `orphaned (${agent.state})` : effective
  const parts: string[] = [
    `agent ${agent.index}`,
    agent.label ?? `agent ${agent.index}`,
    `state ${state}`,
  ]
  if (agent.errorCode) parts.push(`error ${agent.errorCode}`)
  if (agent.error) parts.push(agent.error)
  if (agent.state === 'cached') parts.push('replayed from cache')
  parts.push(`adapter ${agent.adapter || 'unknown'}`)
  if (agent.model) parts.push(`model ${agent.model}`)
  if (agent.effort) parts.push(`effort ${agent.effort}`)
  if (context.phaseTitle) {
    parts.push(`phase ${context.phaseTitle}${agent.phaseApproximate ? ' (grouping approximate)' : ''}`)
  }
  const wait = fmtDuration(agent.waitMs)
  if (wait) parts.push(`wait ${wait}`)
  // The SAME reading the cell renders, including its absence: a duration the run did not
  // record for THIS attempt is silent here exactly as the cell is blank (round 6 B2's rule,
  // round 8 B1's figure).
  const reading = honesty.duration(agent)
  const duration = fmtDuration(durationValue(reading))
  if (duration) parts.push(`duration ${duration}${reading.kind === 'live' ? ' so far' : ''}`)
  const inTokens = fmtTokens(input.value)
  if (inTokens) parts.push(`input ${inTokens}`)
  // The one figure with a second, GRAPHICAL reading beside it. The bar is `aria-hidden`
  // (it restates the number), so its share has to arrive here or not at all.
  const outTokens = fmtTokens(out.value)
  if (outTokens) {
    const share = context.share == null
      ? ''
      : ` — ${Math.round(context.share * 100)}% of the busiest agent`
    parts.push(`output ${outTokens}${share}${out.live ? ' (live)' : ''}`)
  }
  if (agent.usage?.cost) parts.push(`cost ${fmtCost(agent.usage.cost)}`)
  if (agent.lastTool) parts.push(`last tool ${agent.lastTool}`)
  if (typeof agent.attempts === 'number' && Number.isFinite(agent.attempts)) {
    parts.push(`${agent.attempts} attempt${agent.attempts === 1 ? '' : 's'}`)
  }
  const steers = agent.steers?.length ?? 0
  parts.push(steers === 1 ? '1 steer' : `${steers} steers`)
  return parts.join(', ')
}

/**
 * The sort control's accessible name. The VISIBLE label leads it (WCAG 2.5.3, label in
 * name), and the sort state follows as words — `aria-sort` is a property of a
 * `columnheader`, and putting it on a plain button annotated nothing (round 5, B2).
 */
export function sortLabel(
  column: ColumnDef,
  sort: { key: SortKey; dir: SortDir },
): string {
  const title = column.title === '#' ? 'index' : column.title
  if (sort.key !== column.key) {
    return `${title} — not sorted; activate to sort ${column.initial === 'asc' ? 'ascending' : 'descending'}`
  }
  return sort.dir === 'asc'
    ? `${title} — sorted ascending; activate to sort descending`
    : `${title} — sorted descending; activate to sort ascending`
}

/**
 * The sort value, or `null` for "this agent has no value here" (see the module note).
 *
 * **A column sorts by what its cells SAY** (round 8, B2). Two of these are not properties of
 * the record but readings of it, and taking the record instead put the table into a state an
 * operator can see is wrong: on a snapshot whose §6.4 step 8 post-pass is absent — a
 * `corrupt-result` run, an older server — clicking `state` ordered the rows as
 * `queued`/`running` while every cell, glyph and accessible name in them read `orphaned`,
 * and `j`/`k` walked that same invisible ordering. So both go through the screen's verdict,
 * and the comparator can no longer disagree with the pixels.
 */
export function sortValue(
  agent: AgentView, key: SortKey, honesty: AgentHonesty,
): string | number | null {
  switch (key) {
    case 'index': return agent.index
    case 'label': return agent.label ?? `agent ${agent.index}`
    case 'adapter': return `${agent.adapter ?? ''} ${agent.model ?? ''} ${agent.effort ?? ''}`.trim() || null
    case 'phase': return agent.phaseIndex
    // The state column carries the error, so a failed agent sorts by `failed` and then by
    // its error code — the two failure modes of one column, in one ordering.
    case 'state': return `${honesty.effectiveState(agent)}${agent.errorCode ? ` ${agent.errorCode}` : ''}`
    case 'wait': return agent.waitMs ?? null
    // Absent, and NOT a small number: an orphan whose retained `durationMs` belongs to a
    // previous attempt has no duration here, so it sorts to the bottom in both directions
    // rather than into the middle at a width nothing on screen shows.
    case 'duration': return durationValue(honesty.duration(agent))
    case 'input': return lifetimeTokens(agent, 'input')
    case 'output': return lifetimeTokens(agent, 'output')
    case 'cost': return agent.usage?.cost ?? null
    case 'lastTool': return agent.lastTool ?? null
    // `attempts` and `steers` are COUNTS the client always knows — zero of them is a
    // measured zero, not an absence, so these never go blank in the sort.
    case 'attempts': return agent.attempts ?? 0
    case 'steers': return agent.steers?.length ?? 0
    default: return null
  }
}

/**
 * The rendered order. `honesty` is REQUIRED and has no default: a fallback that assumed the
 * run was alive would silently restore the raw ordering for any caller that forgot it, and
 * `visibleAgentIndices` — the `j`/`k` traversal — is one of exactly two callers that have to
 * agree with this one to the row (round 8, B2).
 */
export function sortAgents(
  agents: readonly AgentView[],
  key: SortKey,
  dir: SortDir,
  honesty: AgentHonesty,
): AgentView[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...agents].sort((a, b) => {
    const av = sortValue(a, key, honesty)
    const bv = sortValue(b, key, honesty)
    if (av == null && bv == null) return a.index - b.index
    // Absent last in BOTH directions — see the module note.
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') {
      return av === bv ? a.index - b.index : (av - bv) * sign
    }
    const cmp = String(av).localeCompare(String(bv))
    return cmp === 0 ? a.index - b.index : cmp * sign
  })
}

/** Clicking the sorted column flips it; clicking another adopts that column's default. */
export function nextSort(
  current: { key: SortKey; dir: SortDir },
  clicked: SortKey,
): { key: SortKey; dir: SortDir } {
  if (current.key === clicked) {
    return { key: clicked, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  }
  const column = COLUMNS.find((c) => c.key === clicked)
  return { key: clicked, dir: column?.initial ?? 'asc' }
}
