/**
 * The order `j`/`k` actually walk (§2.7: "`j/k` move through … agents (cockpit)").
 *
 * Round 1 walked `detail.agents` — the fold's insertion order — from every tab. That order
 * is what the Timeline draws and is a coincidence anywhere else: after a click on `cost` the
 * cursor jumped around the sorted table, and under the Phases grouping it could land on an
 * agent inside a COLLAPSED phase, so the row it selected was not on screen at all (review
 * round 2, M1).
 *
 * A roving cursor is a claim about the visible list. So the traversal is derived from the
 * same models the tabs render from — `sortAgents` for the flat table, `phaseGroups` +
 * `phaseOpen` for the tree, `structureModel` for the DAG — and a `j` therefore always lands
 * on the next row the operator can see, whatever the tab, the sort and the collapse state.
 */

import type { RunDetail } from '../../api/types.js'
import { type AgentHonesty, type SortDir, type SortKey, sortAgents } from './agents.js'
import { type StructContainer, type StructLiveness, structureModel } from './dag.js'
import { phaseGroups, phaseOpen, toggleKey } from './phases.js'

export type CockpitTab = 'timeline' | 'structure' | 'agents'
export type Grouping = 'flat' | 'phases'

export interface VisibleArgs {
  tab: CockpitTab
  /** The ATTEMPT-SCOPED detail — the object the tab is rendering (§6.4 step 1a). */
  detail: RunDetail | null
  grouping: Grouping
  sort: { key: SortKey; dir: SortDir }
  toggled: Record<string, boolean>
  selectedAgent: number | null
  /**
   * The screen's §6.4 step 8 verdict.
   *
   * Round 7 threaded it through for `structureModel`'s cell reasons only, on the reasoning
   * that "the traversal itself does not depend on liveness — it is the same rows in the same
   * order either way". That was wrong, and round 8's B2 is the counter-example: the table
   * can be sorted BY the verdict (`state`, `duration`), so the visible order depends on it,
   * and a traversal that sorted without it walked a different list from the one on screen.
   * There is one derivation now and both consumers pass through it.
   */
  honesty: (AgentHonesty & StructLiveness) | null
}

const containerAgents = (container: StructContainer): number[] => (
  container.items.flatMap((item) => item.cells.flatMap((cell) => [
    ...cell.agents.map((a) => a.index),
    ...cell.children.flatMap(containerAgents),
  ]))
)

/** The agent indices of the active tab's rows, in the order they are painted. */
export function visibleAgentIndices(args: VisibleArgs): number[] {
  const { detail, honesty } = args
  if (!detail) return []
  const agents = detail.agents ?? []
  if (args.tab === 'timeline') {
    // The Gantt draws one lane per agent, in `detail.agents` order (`ganttModel`).
    return agents.map((a) => a.index)
  }
  // `honesty` is null exactly when there is no snapshot (`Cockpit.tsx`), and a screen with
  // no snapshot has no rows to walk. Below this line the verdict is what the ORDER is built
  // from, so there is nothing to walk without it either.
  if (honesty == null) return []
  if (args.tab === 'structure') {
    const model = structureModel(detail.structure, agents, honesty)
    return [
      ...model.containers.flatMap(containerAgents),
      ...model.loose.map((a) => a.index),
    ]
  }
  if (args.grouping === 'flat') {
    return sortAgents(agents, args.sort.key, args.sort.dir, honesty).map((a) => a.index)
  }
  // The tree: declared/observed phase order, only the OPEN sections, each sorted the way the
  // table is — exactly what `AgentsTab` renders.
  return phaseGroups(detail).flatMap((group) => {
    const open = phaseOpen(group, {
      toggled: args.toggled[toggleKey(detail.runId, group.phaseIndex)],
      selectedAgent: args.selectedAgent,
    })
    if (!open) return []
    return sortAgents(group.agents, args.sort.key, args.sort.dir, honesty).map((a) => a.index)
  })
}

/**
 * Step the cursor one row through `order`.
 *
 * A cursor that is not in the visible order — the sort moved it into a collapsed phase, or
 * the tab changed — is not silently kept: `j` enters at the first visible row and `k` at the
 * last, which is where a fresh cursor belongs.
 */
export function stepCursor(
  order: readonly number[],
  cursor: number | null,
  direction: 1 | -1,
): number | null {
  if (order.length === 0) return null
  const at = cursor == null ? -1 : order.indexOf(cursor)
  if (at === -1) return (direction === 1 ? order[0] : order[order.length - 1]) ?? null
  const next = Math.min(order.length - 1, Math.max(0, at + direction))
  return order[next] ?? null
}
