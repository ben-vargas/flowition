/**
 * The Structure tab's model (DESIGN §2.4, Q6) — read from the SHARED fold's `structure`
 * tree (E2), never re-derived client-side.
 *
 * That is a hard rule rather than a preference: branch structure comes from the `fanout`
 * events' `path` (§6.2's one canonical container-path schema), and a client that rebuilt it
 * from agent paths would be a second implementation of the thing §6.4 exists to have
 * exactly one of. `src/viewer/fold.js:389` already scaffolds every item and stage slot from
 * the fanout width, which is precisely what makes "7 of 10 slots materialised" sayable —
 * the empty cells are declared by the engine, not inferred from an absence.
 *
 * What this module adds is only presentation-shaped: which cell is empty and, crucially,
 * WHY. A generic dash would collapse "the pipeline dropped this item because stage 0 threw"
 * and "stage 1 has not been created yet" into the same glyph, and those are a permanent
 * outcome and a pending one.
 */

import type { AgentView, PathSeg, StructNode } from '../../api/types.js'
import { type RunHonesty, durationValue, isActiveState } from './honesty.js'

/**
 * The slice of `honesty.ts`'s verdict this model needs (round 7, B2).
 *
 * A structure cell's reason is a SENTENCE about the present — "stage 0 still running" tells
 * the operator to wait. Deriving that from `agent.state` alone answers a different question
 * (what the last event said), and on a quiescent run the two disagree: `CORRUPT_RUN`'s
 * agents arrive `running`/`queued` with no `displayState` post-pass applied, so the raw
 * reading printed two "still running" cells for agents the same screen was already drawing
 * as orphaned one tab away. The verdict is threaded in rather than re-derived — this is the
 * same rule `phases.ts`, `gantt.ts` and `AgentsTab.tsx` obey, and it has exactly one home.
 *
 * `duration` joined it in round 8 for the same reason one level up: the container header's
 * roll-up is a SUM of the chips beneath it, so summing the raw `durationMs` field put an
 * orphan's previous-attempt runtime into a total whose own chip — correctly — showed
 * nothing. A roll-up that does not add up is worse than no roll-up.
 */
export type StructLiveness = Pick<RunHonesty, 'orphaned' | 'duration'>

export interface StructCell {
  /** `null` on a `parallel` fan, where an item has no stage axis. */
  stage: number | null
  agents: AgentView[]
  /**
   * Containers declared INSIDE this cell — a `parallel()` called from a pipeline stage, a
   * `pipeline()` inside a `parallel` item. `src/viewer/fold.js:360` scaffolds them as
   * CHILDREN of the owning item/stage node, so the parent-child relationship is on disk;
   * rendering them as unrelated sibling cards would throw the `path` away and leave the
   * owning cell claiming "not created" for work that demonstrably ran (review round 1, B4).
   */
  children: StructContainer[]
  /** Set only when the cell is empty: the honest reason, never a dash. */
  reason: string | null
}

export interface StructItem {
  i: number
  cells: StructCell[]
}

export interface StructContainer {
  path: PathSeg[]
  kind: 'parallel' | 'pipeline'
  count: number
  stages: number
  label: string
  /** Present when every agent under the container agrees on a phase. */
  phase: { index: number; title: string } | null
  items: StructItem[]
  /** The fold's own roll-up. Only `state` is read from it — see `cost`/`durationMs`. */
  rollup: StructNode['rollup']
  /**
   * Rolled-up cost and duration, summed from the RESOLVED agents rather than taken from
   * `node.rollup`.
   *
   * `rollup.costUsd` is computed inside `materializeFold`, which runs BEFORE
   * `applyJournalJoin` puts each agent's `usage` back (the client seeds a fold with the
   * journal-derived fields stripped, so the join owns them — `fold/index.ts`'s
   * `JOURNAL_DERIVED_FIELDS`). Every container therefore rolls up to `$0` on the client
   * even though the same code is right on the server. Summing here reads the joined
   * values and is correct on both sides; the ordering itself is reported with this unit.
   *
   * `null` means no agent under this container reported the figure at all — §2.3's
   * "empty ≠ zero", one level up.
   */
  cost: number | null
  durationMs: number | null
  /** Every agent under this container, INCLUDING the ones inside nested containers. */
  agents: AgentView[]
  /** `"7 of 10 slots materialised"` — pipelines only, where slots are declared upfront. */
  slots: { filled: number; total: number } | null
  /** Nesting depth, 0 for a container the root declared. Presentation only. */
  depth: number
}

export interface StructureModel {
  /** TOP-LEVEL containers only; nested ones hang off their owning cell's `children`. */
  containers: StructContainer[]
  /** Agents that belong to no container — `pipeline`/`parallel` were never called on them. */
  loose: AgentView[]
  totalAgents: number
}

const lastSeg = (path: PathSeg[]): PathSeg | undefined => path[path.length - 1]

const segCount = (path: PathSeg[]): { count: number; stages: number } => {
  const seg = lastSeg(path) as Extract<PathSeg, { count: number }> | undefined
  return {
    count: seg && Number.isInteger(seg.count) ? seg.count : 0,
    stages: seg && Number.isInteger(seg.stages as number) ? seg.stages as number : 0,
  }
}

/**
 * Why is this cell empty?
 *
 * Only the immediately preceding stage can answer it, and only for a pipeline: `pipeline()`
 * drops an item whose stage threw, and creates stage `s` only once stage `s-1` returned. So
 * the previous stage's agents are the evidence, and where there are none the honest answer
 * is the modest one.
 *
 * **`still running` is a present-tense claim and needs the run's liveness** (round 7, B2).
 * `failed` and `cancelled` are settled facts and read the same whoever is asking; "stage 0
 * still running" is a promise that the cell will fill in, and on a run whose engine is gone
 * it will not. So the active states go through `honesty.orphaned` — the same §6.4 step 8
 * post-pass every other widget consumes — and a stranded predecessor says so.
 */
export function emptyReason(
  stage: number | null,
  previous: AgentView[] | null,
  phases: { titleOf(stage: number): string },
  honesty: StructLiveness,
): string {
  if (stage == null || stage === 0) return 'not created'
  const before = phases.titleOf(stage - 1)
  if (!previous || previous.length === 0) return 'not created'
  if (previous.some((a) => a.state === 'failed')) return `skipped — ${before} failed`
  if (previous.some((a) => a.state === 'cancelled')) return `skipped — ${before} was cancelled`
  const active = previous.filter((a) => isActiveState(a.state))
  // Not `honesty.moving`: a `queued` predecessor on a LIVE run is not producing output but
  // is genuinely going to run, and "still running" is the wording §2.4's grid has always
  // used for it. What `moving` and this share is the thing that matters — neither survives
  // the run's death.
  if (active.some((a) => !honesty.orphaned(a))) return `not created — ${before} still running`
  if (active.length) return `not created — ${before} was orphaned`
  return 'not created'
}

/** A cell's whole population: its own agents plus every agent nested under it. */
export const cellAgents = (cell: StructCell): AgentView[] =>
  [...cell.agents, ...cell.children.flatMap((c) => c.agents)]

/** Is this cell genuinely empty — no agents of its own AND no container inside it? */
export const cellEmpty = (cell: StructCell): boolean =>
  cell.agents.length === 0 && cell.children.length === 0

/**
 * Walk the fold's tree into containers.
 *
 * Nesting is PRESERVED. `parallel()` called inside a pipeline stage produces a fanout whose
 * `path` extends the stage's path, and `src/viewer/fold.js:360` scaffolds it as a child of
 * that stage node. Flattening the tree into sibling cards throws that relationship away and
 * — worse — leaves the owning stage cell with no direct agents, so it renders "not created"
 * for a slot in which a whole nested fan-out demonstrably ran. So a nested container is
 * returned inside its owning cell and the cell is never called empty.
 */
export function structureModel(
  root: StructNode | null | undefined,
  agents: readonly AgentView[],
  honesty: StructLiveness,
): StructureModel {
  const byIndex = new Map(agents.map((a) => [a.index, a]));
  const claimed = new Set<number>()

  const resolve = (indices: readonly number[]): AgentView[] =>
    indices.map((i) => byIndex.get(i)).filter((a): a is AgentView => a != null)

  /**
   * The containers declared DIRECTLY under `node`, in tree order.
   *
   * Direct only, and deliberately: `container()` walks the item and stage nodes itself, so
   * a recursive descent here would find each nested container twice — once inside the stage
   * cell that owns it and once again through the item.
   */
  const under = (node: StructNode, depth: number): StructContainer[] =>
    (node.children ?? [])
      .filter((c) => c.kind === 'parallel' || c.kind === 'pipeline')
      .map((c) => container(c, resolve, claimed, depth, under, honesty))

  const containers = root ? under(root, 0) : []
  const loose = agents.filter((a) => !claimed.has(a.index))
  return { containers, loose, totalAgents: agents.length }
}

type Under = (node: StructNode, depth: number) => StructContainer[]

function container(
  node: StructNode,
  resolve: (i: readonly number[]) => AgentView[],
  claimed: Set<number>,
  depth: number,
  under: Under,
  honesty: StructLiveness,
): StructContainer {
  const kind = node.kind as 'parallel' | 'pipeline'
  const { count, stages } = segCount(node.path)
  const itemNodes = (node.children ?? []).filter((c) => c.kind === 'item')
  const all: AgentView[] = []

  /** Own agents first, then everything the nested containers already collected. */
  const cell = (
    stage: number | null,
    own: AgentView[],
    children: StructContainer[],
    reason: string | null,
  ): StructCell => {
    all.push(...own)
    for (const child of children) all.push(...child.agents)
    return { stage, agents: own, children, reason }
  }

  const stageTitle = (s: number) => `stage ${s}`
  const items: StructItem[] = itemNodes.map((itemNode) => {
    const seg = lastSeg(itemNode.path) as Extract<PathSeg, { i: number }> | undefined
    const i = seg && Number.isInteger(seg.i) ? seg.i : 0
    if (kind === 'parallel') {
      const own = resolve(itemNode.agentIndices ?? [])
      const nested = under(itemNode, depth + 1)
      return {
        i,
        cells: [cell(null, own, nested, own.length || nested.length ? null : 'not created')],
      }
    }
    const stageNodes = (itemNode.children ?? []).filter((c) => c.kind === 'stage')
    const cells: StructCell[] = []
    for (let s = 0; s < Math.max(stages, stageNodes.length); s++) {
      const stageNode = stageNodes.find((c) => {
        const seg2 = lastSeg(c.path) as Extract<PathSeg, { s: number }> | undefined
        return seg2 && seg2.s === s
      })
      const own = resolve(stageNode?.agentIndices ?? [])
      const nested = stageNode ? under(stageNode, depth + 1) : []
      const previous = cells[s - 1]
      cells.push(cell(
        s, own, nested,
        own.length || nested.length
          ? null
          // The evidence is the previous stage's WHOLE population — a stage whose only work
          // was a nested fan-out still counts as having run.
          : emptyReason(
            s, previous ? cellAgents(previous) : null, { titleOf: stageTitle }, honesty,
          ),
      ))
    }
    // An agent attached to the ITEM rather than to a stage (a pipeline whose stage
    // callback called `agent()` outside a stage scope) is still shown, never dropped.
    const direct = resolve(itemNode.agentIndices ?? [])
    const directNested = under(itemNode, depth + 1)
    if (direct.length || directNested.length) {
      cells.push(cell(null, direct, directNested, null))
    }
    return { i, cells }
  })

  // Agents on the container node itself (not under any item) — same rule as above.
  const onContainer = resolve(node.agentIndices ?? [])
  all.push(...onContainer)
  for (const agent of all) claimed.add(agent.index)

  const phases = new Set(all.map((a) => a.phaseIndex).filter((p): p is number => p != null))
  const filled = items.reduce(
    (n, item) => n + item.cells.filter((c) => !cellEmpty(c)).length,
    0,
  )
  const sum = (pick: (a: AgentView) => number | null | undefined): number | null => {
    let total = 0
    let seen = false
    for (const a of all) {
      const value = pick(a)
      if (value != null && Number.isFinite(value)) { total += value; seen = true }
    }
    return seen ? total : null
  }

  return {
    path: node.path,
    kind,
    count,
    stages,
    label: kind === 'pipeline'
      ? `pipeline(${count || items.length} × ${stages})`
      : `parallel(${count || items.length})`,
    phase: phases.size === 1
      ? { index: [...phases][0]!, title: '' }
      : null,
    items,
    rollup: node.rollup,
    cost: sum((a) => a.usage?.cost ?? null),
    // The sum of what the CHIPS show, agent by agent — never of the raw journal field. See
    // `StructLiveness`.
    durationMs: sum((a) => durationValue(honesty.duration(a))),
    agents: all,
    slots: kind === 'pipeline' && count && stages
      ? { filled, total: count * stages }
      : null,
    depth,
  }
}
