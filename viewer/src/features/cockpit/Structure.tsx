/**
 * The Structure tab (DESIGN §2.4, Q6) — the run's shape, from the shared fold's E2 tree.
 *
 * The container shape is the point: a `parallel(3)` is a fan of item lanes and a
 * `pipeline(5 × 2)` is a 5-row × 2-stage grid, and only the grid explains why seven of ten
 * slots exist. A generic node-and-edge tree would draw the same picture for both.
 */

import type { AgentView, RunDetail } from '../../api/types.js'
import { fmtCost, fmtDuration } from '../../format/fmt.js'
import { Icon } from '../../ui/Icon.js'
import { AdapterBadge, StatusChip, StatusGlyph } from '../../ui/Status.js'
import { lookUpState } from '../../ui/icons.js'
import { DurationText } from './Duration.js'
import { type StructCell, type StructContainer, cellEmpty, structureModel } from './dag.js'
import { type RunHonesty, isActiveState, useRunHonesty } from './honesty.js'
import { pendingLabel, phaseGroups } from './phases.js'

export interface StructureProps {
  detail: RunDetail
  /** The screen's clock — see `AgentsTab`'s note; this tab renders no run duration. */
  now: number
  selectedAgent: number | null
  onOpenAgent: (index: number) => void
}

export function Structure({ detail, now, selectedAgent, onOpenAgent }: StructureProps) {
  const legacy = detail.caps?.structure === 'unsupported'
  // §6.4 step 8, from the screen's ONE verdict (`honesty.ts`). Threaded to every container
  // header and every chip in the tree: parity #58 is a claim about the whole screen, not
  // about the flat Agents table (round 4, B1).
  const honesty = useRunHonesty(detail, now)
  // `honesty` goes IN, not just onto the chips: an empty cell's reason is a sentence about
  // the present ("stage 0 still running"), and §6.4 step 8 owns the present tense (round 7).
  const model = structureModel(detail.structure, detail.agents, honesty)
  const phases = phaseGroups(detail, honesty)
  const pending = phases.filter((p) => p.pending)
  const titleFor = (index: number) => phases.find((p) => p.phaseIndex === index)?.title ?? null

  if (!detail.structure || model.containers.length === 0) {
    return (
      <div className="dag scroller">
        <div className="rawgrp">
          <Icon name="unknown" size={12} />
          <span>
            {legacy
              ? 'Structure unavailable for runs recorded before v0.2 — this engine wrote no fanout events, so the branch shape cannot be recovered. The agents are listed flat below.'
              : 'This run called neither parallel() nor pipeline(): there is no container structure to draw. The agents are listed flat below.'}
          </span>
        </div>
        <FlatList agents={detail.agents} selected={selectedAgent} onOpen={onOpenAgent} honesty={honesty} />
      </div>
    )
  }

  return (
    <div className="dag scroller">
      <div className="tl-head" style={{ marginBottom: 0 }}>
        <span className="lbl">
          structure — from the fanout events&apos; <span className="mono">path</span>
        </span>
        <span className="tl-note">
          {model.containers.length} container{model.containers.length === 1 ? '' : 's'} ·{' '}
          {model.totalAgents} agent{model.totalAgents === 1 ? '' : 's'}
          {phases.length ? ` · ${phases.length} phase${phases.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      {model.containers.map((container, ci) => (
        <ContainerNode
          key={`${container.label}-${ci}`}
          container={container}
          titleFor={titleFor}
          selectedAgent={selectedAgent}
          onOpenAgent={onOpenAgent}
          honesty={honesty}
        />
      ))}

      {pending.map((phase) => (
        <section className="node pending" key={`pending-${phase.phaseIndex}`}>
          <div className="nhead">
            <Icon name="queued" size={14} className="dim" />
            <span className="kind dim">phase {phase.phaseIndex} · {phase.title}</span>
            <div className="roll">
              <span className="chip q">
                <Icon name="queued" size={12} />{pendingLabel(honesty)}
              </span>
              <span>declared in meta.phases, not yet reached</span>
            </div>
          </div>
        </section>
      ))}

      {model.loose.length ? (
        <section className="node">
          <div className="nhead">
            <Icon name="table" size={14} className="dim" />
            <span className="kind">outside any container</span>
            <div className="roll"><span>{model.loose.length} agents</span></div>
          </div>
          <div className="nbody">
            <FlatList agents={model.loose} selected={selectedAgent} onOpen={onOpenAgent} honesty={honesty} />
          </div>
        </section>
      ) : null}
    </div>
  )
}

/**
 * A container header's chip (parity #58 at container scale).
 *
 * `mixed` is the fold's own verdict and it stays the LABEL — the approved comp's live
 * pipeline header reads "mixed" over a spinning mark
 * (docs/frontend/comps/lib/page-cockpit.mjs:292), and a mixed container on a live run is
 * genuinely in motion. What changes is what happens when the run is not: `mixed` was
 * being translated straight to `running`, so the same spinner kept turning on a failed or
 * stale run under a header that says the engine is gone (review round 4, B1). Now the
 * mark goes through §6.4 step 8 exactly like an agent's does — the label survives, the
 * animation does not.
 */
function containerRollup(
  container: StructContainer, honesty: RunHonesty,
): { state: string; orphaned: boolean; label: string | undefined } {
  const raw = container.rollup?.state ?? 'queued'
  const mixed = raw === 'mixed'
  const state = mixed ? 'running' : raw
  const active = isActiveState(state as AgentView['state'])
  // `every`, and vacuously true for a container the fold scaffolded with no agents in it:
  // an empty slot on a dead run is not waiting for anything either.
  const orphaned = active && honesty.dead
    && container.agents.every((a) => honesty.orphaned(a) || !isActiveState(a.state))
  return { state, orphaned, label: mixed ? 'mixed' : undefined }
}

/**
 * One container card. Recursive by construction, because the tree is: a `parallel()` called
 * inside a pipeline stage is scaffolded as a CHILD of that stage node
 * (src/viewer/fold.js:360), and Q6 is "what is the shape of this run" — a shape whose
 * parent-child edges have been cut is a different shape.
 */
function ContainerNode(
  { container, titleFor, selectedAgent, onOpenAgent, honesty }: {
    container: StructContainer
    titleFor: (index: number) => string | null
    selectedAgent: number | null
    onOpenAgent: (index: number) => void
    honesty: RunHonesty
  },
) {
  const cellProps = { titleFor, selected: selectedAgent, onOpen: onOpenAgent, honesty }
  const rollup = containerRollup(container, honesty)
  return (
    <section className={`node${container.depth ? ' nested' : ''}`}>
      <div className="nhead">
        <Icon name={container.kind === 'pipeline' ? 'columns' : 'tree'} size={14} className="dim" />
        <span className="kind">{container.label}</span>
        {container.phase && titleFor(container.phase.index) ? (
          <span className="badge">
            phase {container.phase.index} · {titleFor(container.phase.index)}
          </span>
        ) : null}
        <div className="roll">
          <StatusChip state={rollup.state} orphaned={rollup.orphaned} label={rollup.label} />
          {container.slots ? (
            <span>{container.slots.filled} of {container.slots.total} slots materialised</span>
          ) : (
            <span>{container.agents.length} agents</span>
          )}
          {/* The roll-up is the SUM OF THE CHIPS below it (`dag.ts`), so it is `!= null`
              rather than truthy: a container whose only agent measured `0ms` reported a
              figure, and blanking it would be the same "empty ≠ zero" error in reverse. */}
          {container.durationMs != null
            ? <span className="dur">{fmtDuration(container.durationMs)}</span>
            : null}
          {container.cost ? <span>{fmtCost(container.cost)}</span> : null}
        </div>
      </div>
      <div className="nbody">
        {container.kind === 'pipeline' ? (
          <div
            className="pipe"
            style={{ ['--stages' as string]: String(Math.max(1, container.stages)) }}
          >
            <div className="pipe-head">
              <span />
              {Array.from({ length: Math.max(1, container.stages) }, (_, s) => (
                <span className="lbl" key={s}>stage {s}</span>
              ))}
            </div>
            {container.items.map((item) => (
              <div className="pipe-row" key={item.i}>
                <span className="ilbl">item {item.i}</span>
                {item.cells.map((cell, ci2) => (
                  <Cell key={ci2} cell={cell} {...cellProps} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="fan">
            {container.items.map((item) => (
              <div className="fan-row" key={item.i}>
                <span className="ilbl">item {item.i}</span>
                {item.cells.map((cell, ci2) => (
                  <Cell key={ci2} cell={cell} {...cellProps} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * One grid cell. ALWAYS one element, so a cell holding two agents cannot push its row's
 * later cells into the next grid column.
 */
function Cell(
  { cell, selected, onOpen, titleFor, honesty }: {
    cell: StructCell
    selected: number | null
    onOpen: (index: number) => void
    titleFor: (index: number) => string | null
    honesty: RunHonesty
  },
) {
  if (cellEmpty(cell)) {
    return (
      <div className="cell">
        {/* `title` because `.trunc` clips: the reason is the whole content of the cell, and a
            clipped explanation is the generic dash `dag.ts` exists to avoid. */}
        <div className="achip empty" title={cell.reason ?? undefined}>
          <Icon name="unknown" size={16} className="dim" />
          <span className="nm trunc">{cell.reason}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="cell">
      {cell.agents.map((agent) => (
        <AgentChip
          key={agent.index} agent={agent} selected={agent.index === selected} onOpen={onOpen}
          honesty={honesty}
        />
      ))}
      {cell.children.map((child, i) => (
        <ContainerNode
          key={`${child.label}-${i}`}
          container={child}
          titleFor={titleFor}
          selectedAgent={selected}
          onOpenAgent={onOpen}
          honesty={honesty}
        />
      ))}
    </div>
  )
}

function AgentChip(
  { agent, selected, onOpen, honesty }: {
    agent: AgentView; selected: boolean; onOpen: (index: number) => void; honesty: RunHonesty
  },
) {
  // ROUND 11, B1. The chip's CLASS is a state claim exactly as its glyph is: `.achip.r`
  // paints the running border (`cockpit.css`), and derived from the raw `agent.state` it
  // kept painting it around a mark that said `orphaned` — a dead run's chip still wearing
  // the running colour, which is what §6.4 step 8 and parity #58 forbid. There is ONE
  // reading of what this agent shows, and every visual on the chip comes from it: an
  // orphan resolves to `orphaned` → the neutral `u` class, and the glyph carries the
  // dimmed mark (`.g.orphan`, primitives.css:99). A live run's `running` is untouched.
  const cls = lookUpState(honesty.effectiveState(agent))[0]
  return (
    <button
      type="button"
      className={`achip ${cls}${selected ? ' sel' : ''}`}
      onClick={() => onOpen(agent.index)}
    >
      <StatusGlyph state={agent.state} orphaned={honesty.orphaned(agent)} />
      <AdapterBadge name={agent.adapter || 'unknown'} />
      <span className="nm trunc">{agent.label ?? `agent ${agent.index}`}</span>
      {agent.state === 'cached' ? <span className="badge replay">replay</span> : null}
      <span className="m">
        {/* Round 8, B1: the chip's runtime is the screen's ONE reading, so an orphan whose
            current attempt never recorded an end shows nothing here — exactly as its lane
            does — instead of a previous attempt's figure. */}
        <DurationText reading={honesty.duration(agent)} />
        {agent.usage?.cost ? fmtCost(agent.usage.cost) : null}
      </span>
    </button>
  )
}

function FlatList(
  { agents, selected, onOpen, honesty }: {
    agents: readonly AgentView[]; selected: number | null; onOpen: (index: number) => void
    honesty: RunHonesty
  },
) {
  if (!agents.length) return null
  return (
    <div className="fan" role="list">
      {agents.map((agent) => (
        <div className="fan-row" key={agent.index} role="listitem">
          <span className="ilbl">agent {agent.index}</span>
          <AgentChip agent={agent} selected={agent.index === selected} onOpen={onOpen} honesty={honesty} />
        </div>
      ))}
    </div>
  )
}
