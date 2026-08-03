/**
 * The Agents tab (DESIGN §2.4 + §2.4.1) — a dense sortable table, and the phase tree in
 * its place under the Phases grouping.
 *
 * Parity #52–#54 live in `AgentRow`, and the one that shapes it is #53: **absent fields are
 * omitted, never rendered as `0` or `—`**. A dash is a character an operator reads as a
 * measurement, so an absent cell is empty and carries a title saying which fact is missing.
 */

import { useEffect, useRef } from 'react'
import type { AgentView, RunDetail } from '../../api/types.js'
import { fmtCost, fmtDuration, fmtTokens } from '../../format/fmt.js'
import { Icon } from '../../ui/Icon.js'
import { AdapterBadge, StatusChip, StatusGlyph } from '../../ui/Status.js'
import { DurationText } from './Duration.js'
import {
  COLUMNS, type SortDir, type SortKey, inputTokens, nextSort, outputTokens, rowLabel,
  sortAgents, sortLabel, tokenScale, tokenShare,
} from './agents.js'
import { type RunHonesty, durationAbsence, durationValue, useRunHonesty } from './honesty.js'
import {
  type PhaseGroup, pendingLabel, phaseCounts, phaseGroups, phaseOpen, toggleKey,
} from './phases.js'

export type Grouping = 'flat' | 'phases'

export interface AgentsTabProps {
  detail: RunDetail
  /**
   * The screen's clock. The tab renders no run duration — it is here so the tab can derive
   * the run's honesty verdict (`honesty.ts`) when it is mounted outside the cockpit's
   * provider, rather than falling back to reading raw agent state.
   */
  now: number
  grouping: Grouping
  onGrouping: (grouping: Grouping) => void
  sort: { key: SortKey; dir: SortDir }
  onSort: (sort: { key: SortKey; dir: SortDir }) => void
  selectedAgent: number | null
  cursorAgent: number | null
  onOpenAgent: (index: number) => void
  onCursor: (index: number) => void
  /** Per `(runId, phaseIndex)`; lifted so a tab switch cannot forget it (#50 / #119). */
  toggled: Record<string, boolean>
  onToggle: (key: string, open: boolean) => void
}

export function AgentsTab(props: AgentsTabProps) {
  const { detail, grouping } = props
  // §6.4 step 8's precondition, resolved ONCE — by the screen, not by this tab — and passed
  // to every rollup, every row and every live mark below (`honesty.ts`).
  const honesty = useRunHonesty(detail, props.now)
  const groups = grouping === 'phases' ? phaseGroups(detail, honesty) : []
  const approximate = detail.caps?.phaseAssociation === 'unsupported'
  // Q4's bars are scaled across the WHOLE run, not per phase section: the comparison the
  // operator is making is "which agent", and a per-section scale would give the quietest
  // phase's biggest agent the same full-width bar as the run's actual budget eater.
  const scale = tokenScale(detail.agents ?? [])
  // The tree's open/closed state is resolved HERE so the roving tab stop can be the first
  // row that is actually on screen, across every section — one tab stop for the tree, not
  // one per phase.
  const opens = groups.map((group) => phaseOpen(group, {
    toggled: props.toggled[toggleKey(detail.runId, group.phaseIndex)],
    selectedAgent: props.selectedAgent,
  }))
  const visible = groups.flatMap((group, i) => (
    opens[i] ? sortAgents(group.agents, props.sort.key, props.sort.dir, honesty) : []
  ))
  const treeTabStop = tabStopFor(visible, props.cursorAgent)

  return (
    <div className="at">
      <div className="at-tools">
        <span className="lbl">agents{grouping === 'phases' ? ' — phases' : ''}</span>
        {grouping === 'phases' ? (
          <span className="tl-note">
            declaration order from <span className="mono">meta.phases</span>, then observed
            phase events
          </span>
        ) : null}
        <div className="seg" role="group" aria-label="Agent grouping">
          <button
            type="button" className={grouping === 'flat' ? 'sel' : undefined}
            aria-pressed={grouping === 'flat'} onClick={() => props.onGrouping('flat')}
          >
            <Icon name="table" size={12} />Flat
          </button>
          <button
            type="button" className={grouping === 'phases' ? 'sel' : undefined}
            aria-pressed={grouping === 'phases'} onClick={() => props.onGrouping('phases')}
          >
            <Icon name="tree" size={12} />Phases
          </button>
        </div>
      </div>

      {approximate && grouping === 'phases' ? (
        <div className="rawgrp" style={{ margin: '0 16px 8px' }}>
          <Icon name="unknown" size={12} />
          <span>
            Grouping approximate for runs from older engines: each agent takes the last phase
            declared before its earliest event, which is unsound under concurrency.
          </span>
        </div>
      ) : null}

      <div className="at-scroll">
        {grouping === 'flat' ? <FlatTable {...props} honesty={honesty} scale={scale} /> : null}
        {grouping === 'phases'
          ? groups.map((group, i) => (
            <PhaseSection
              key={group.phaseIndex ?? 'none'} group={group}
              open={opens[i]!} tabStop={treeTabStop} {...props} honesty={honesty} scale={scale}
            />
          ))
          : null}
        {grouping === 'phases' && groups.length === 0 ? (
          <div className="rawgrp" style={{ margin: 16 }}>
            <Icon name="unknown" size={12} />
            <span>No phases yet — this workflow has not called <span className="mono">phase()</span>.</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * §3.6's roving tabindex, and the reason it needs a DEFAULT.
 *
 * A roving list has exactly one tab stop. Before the operator has moved the cursor there is
 * no cursor, and a list whose every row is `tabIndex={-1}` is a list Tab cannot enter at all
 * — the table becomes keyboard-unreachable until a mouse is used, which is precisely the
 * dependency §3.6 forbids (review round 1, B7). So the FIRST VISIBLE ROW holds the tab stop
 * until an explicit cursor exists, and the explicit cursor survives re-sorting and
 * re-grouping because it lives in the page's state, not in the row order.
 */
const tabStopFor = (rows: readonly AgentView[], cursor: number | null): number | null =>
  (cursor != null && rows.some((a) => a.index === cursor) ? cursor : rows[0]?.index ?? null)

/** What the two table bodies need on top of the tab's own props. */
type BodyProps = AgentsTabProps & { honesty: RunHonesty; scale: number }

function FlatTable(props: BodyProps) {
  // The SAME call `visibleAgentIndices` makes for the `j`/`k` traversal, verdict included:
  // two consumers, one ordering (round 8, B2).
  const rows = sortAgents(props.detail.agents, props.sort.key, props.sort.dir, props.honesty)
  const tabStop = tabStopFor(rows, props.cursorAgent)
  return (
    <>
      {/* NOT `role="row"`/`aria-sort` (round 5, B2). `row` is only legal inside a
          `table`/`grid`/`treegrid`, and `aria-sort` only on a `columnheader`; on a plain
          div and a plain button they were invalid markup that annotated nothing. The tab
          is a LIST of rows — each row one button, named in full by `rowLabel` — so the
          sort state is carried by the control's own accessible name instead. */}
      <div className="at-row head">
        {COLUMNS.map((column) => (
          <span
            key={column.key}
            className={`lbl c-${column.key}${column.numeric ? ' r' : ''}`}
            style={column.numeric ? { textAlign: 'right' } : undefined}
          >
            <button
              type="button"
              className={props.sort.key === column.key ? 'sorted' : undefined}
              aria-label={sortLabel(column, props.sort)}
              onClick={() => props.onSort(nextSort(props.sort, column.key))}
            >
              {column.title}
              {props.sort.key === column.key ? (
                <Icon name={props.sort.dir === 'asc' ? 'chevron' : 'chevdown'} size={12} />
              ) : null}
            </button>
          </span>
        ))}
      </div>
      <ul role="list" aria-label="Agents">
        {rows.map((agent) => (
          <li key={agent.index}>
            <AgentRow
              agent={agent}
              selected={agent.index === props.selectedAgent}
              cursor={agent.index === props.cursorAgent}
              tabStop={agent.index === tabStop}
              onOpen={props.onOpenAgent}
              onCursor={props.onCursor}
              phaseTitle={phaseTitle(props.detail, agent)}
              honesty={props.honesty}
              scale={props.scale}
            />
          </li>
        ))}
      </ul>
      {rows.length === 0 ? (
        <div className="empty" style={{ padding: '28px 24px' }}>
          <Icon name="table" size={20} className="dim" />
          <p style={{ fontSize: 13 }}>
            No agents yet — the workflow hasn&apos;t called <span className="mono">agent()</span>.
          </p>
        </div>
      ) : null}
    </>
  )
}

function phaseTitle(detail: RunDetail, agent: AgentView): string | null {
  if (agent.phaseIndex == null) return null
  const observed = detail.phases?.find((p) => p.phaseIndex === agent.phaseIndex)
  if (observed) return observed.title
  return detail.declaredPhases?.[agent.phaseIndex]?.title ?? `phase ${agent.phaseIndex}`
}

function PhaseSection(
  { group, open, tabStop, ...props }: BodyProps & {
    group: PhaseGroup; open: boolean; tabStop: number | null
  },
) {
  const key = toggleKey(props.detail.runId, group.phaseIndex)
  const userToggled = props.toggled[key] !== undefined
  const rows = sortAgents(group.agents, props.sort.key, props.sort.dir, props.honesty)

  return (
    <>
      <button
        type="button"
        className={`phead${group.pending ? ' pending' : ''}`}
        aria-expanded={open}
        onClick={() => props.onToggle(key, !open)}
      >
        <Icon name="chevron" className="chev" />
        {/* Parity #58, one level up from the row: the phase keeps the state it actually
            contains and loses the spinner once the run it belongs to has stopped. */}
        {group.rollup
          ? <StatusGlyph state={group.rollup.state} orphaned={group.rollup.orphaned} />
          : <StatusGlyph state="queued" />}
        <span className="pn">{group.title}</span>
        <span className="cnt">
          {group.pending
            ? `${pendingLabel(props.honesty)} — declared, not reached`
            : phaseCounts(group)}
        </span>
        {userToggled ? (
          <span className="ptoggled">
            <Icon name="keyboard" size={12} />{open ? 'kept open by you' : 'collapsed by you'}
          </span>
        ) : <span />}
      </button>
      {open && rows.length ? (
        <div className="pbody">
          <ul role="list" aria-label={`Agents in ${group.title}`}>
            {rows.map((agent) => (
              <li key={agent.index}>
                <AgentRow
                  agent={agent}
                  selected={agent.index === props.selectedAgent}
                  cursor={agent.index === props.cursorAgent}
                  tabStop={agent.index === tabStop}
                  onOpen={props.onOpenAgent}
                  onCursor={props.onCursor}
                  phaseTitle={group.title}
                  honesty={props.honesty}
                  scale={props.scale}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  )
}

/** An absent cell: blank with a reason, never `0` and never `—` (parity #53). */
const Absent = ({ why }: { why: string }) => (
  <span className="absent" title={why} aria-label="not reported">&nbsp;</span>
)

/**
 * A count the client either KNOWS (including zero) or does not have at all.
 *
 * The type says `attempts: number`, but §6.5's contract is that old runs on disk degrade
 * gracefully, and a snapshot written by an engine that never counted attempts reaches the
 * client with the field missing. So a number — any number, `0` included — is reported, and
 * only a genuine absence goes blank.
 */
const knownCount = (value: number | null | undefined): number | null =>
  (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * §2.1 Q4's per-agent token bar: a proportional rule UNDER the `out` figure, inside the
 * cell the number already occupies.
 *
 * It is drawn there rather than as a fourteenth column on purpose — the approved comp's
 * Agents table is a thirteen-column grid whose header the §3.7 gate signed off, and a new
 * column would re-flow every one of them. Underlining the number it measures also puts
 * the shape and the value in one place, which is the reading Q4 actually asks for.
 *
 * Accessibility: the bar itself is `aria-hidden` — it restates the number beside it, and a
 * second wordless graphic per row is noise to step through — and its reading is carried in
 * words by `rowLabel`, which names the row's single tab stop. Round 4 put that reading in a
 * visually-hidden span INSIDE the row button, where the button's own `aria-label` replaced
 * it: text present in the DOM and absent from the accessibility tree (round 5, B2).
 *
 * §3.6's other half is met by the CSS: the fill is a solid `color-mix` over its track that
 * clears 3:1 in both themes, and `tokens.ts` gates that composited pair.
 */
function TokenBar({ share }: { share: number | null }) {
  if (share == null) return null
  return (
    <span className="tokbar" aria-hidden="true" data-share={share.toFixed(4)}>
      <span className="fill" style={{ width: `${(share * 100).toFixed(2)}%` }} />
    </span>
  )
}

export function AgentRow(
  { agent, selected, cursor, tabStop, onOpen, onCursor, phaseTitle: phase, honesty, scale = 0 }: {
    agent: AgentView
    selected: boolean
    /** The EXPLICIT cursor: this row pulls focus to itself when it becomes true. */
    cursor: boolean
    /** This row is the list's single tab stop — true for the first row by default. */
    tabStop: boolean
    onOpen: (index: number) => void
    onCursor: (index: number) => void
    phaseTitle: string | null
    /**
     * The screen's honesty verdict (`honesty.ts`). REQUIRED, and not a boolean: a row that
     * could default to "alive" is a row that claims liveness whenever a caller forgets, and
     * that default is how the live-token dot survived onto a quiescent run (round 6, B1).
     */
    honesty: RunHonesty
    /** The busiest agent's lifetime output tokens, for the Q4 bar's scale. */
    scale?: number
  },
) {
  const ref = useRef<HTMLButtonElement>(null)
  // §3.6: roving tabindex — one tab stop for the list, `j`/`k` inside it.
  useEffect(() => {
    if (cursor && ref.current && document.activeElement !== ref.current
      && ref.current.closest('.at')?.contains(document.activeElement)) {
      ref.current.focus()
    }
  }, [cursor])

  const out = outputTokens(agent, honesty)
  const input = inputTokens(agent, honesty)
  const orphaned = honesty.orphaned(agent)
  const duration = honesty.duration(agent)
  const share = tokenShare(agent, scale)

  return (
    <button
      ref={ref}
      type="button"
      tabIndex={tabStop ? 0 : -1}
      className={`at-row${selected ? ' sel' : ''}`}
      onClick={() => onOpen(agent.index)}
      onFocus={() => onCursor(agent.index)}
      // The whole row, as read (round 5, B2) — a button's label REPLACES its subtree, so
      // anything missing from here is missing from the screen reader's table.
      aria-label={rowLabel(agent, honesty, { phaseTitle: phase, share })}
    >
      <span className="idx c-index">{agent.index}</span>
      <span className="lab c-label">
        <StatusGlyph state={agent.state} orphaned={orphaned} />
        <span className="nm trunc">{agent.label ?? `agent ${agent.index}`}</span>
        {agent.state === 'cached' ? <span className="badge replay">replay</span> : null}
      </span>
      <span className="mdl c-adapter">
        <AdapterBadge name={agent.adapter || 'unknown'} />
        <span className="trunc">
          {agent.model ?? <Absent why="the adapter reported no model" />}
          {agent.effort ? ` · ${agent.effort}` : ''}
        </span>
      </span>
      <span className="ph c-phase trunc">
        {phase ?? <Absent why="this agent is not inside a phase()" />}
        {agent.phaseApproximate ? <span className="badge" title="grouping approximate">~</span> : null}
      </span>
      {/* Parity #54: the state cell carries the state, the error CODE chip and the error
          message inline, clamped to the row with the full text in the tooltip. It never
          borrows the last-tool cell to do it — see `COLUMNS`. W15 made that true: `chipline`
          (primitives.css) is what actually clips the cell, and the code badge ellipsizes
          with its whole value in the `title` instead of painting over the wait column. */}
      <span className="c-state st-cell chipline">
        <StatusChip state={agent.state} orphaned={orphaned} />
        {agent.errorCode
          ? <span className="badge err" title={agent.errorCode}>{agent.errorCode}</span>
          : null}
        {agent.error ? (
          <span className="errmsg trunc" title={agent.error}>{agent.error}</span>
        ) : null}
      </span>
      <span className="n c-wait">
        {/* "this attempt", not "this run": §6.4 step 3 (amended round 11) clears the wait
            when an index re-enters, so a resumed agent that started without a fresh queue
            event is blank here for the same honest reason a pre-E4 run is — no queue event
            was recorded for the execution this row describes. */}
        {fmtDuration(agent.waitMs) ?? <Absent why="no queue event was recorded for this attempt" />}
      </span>
      {/* Round 8, B1. This cell used to print `agent.durationMs` raw, so a resumed or
          orphaned agent whose current execution never recorded an end showed the PREVIOUS
          attempt's runtime — the very figure the Gantt one tab away had already refused to
          date the same agent's death with. `honesty.duration` is the one reading, and an
          absence explains which of the four gaps it is. */}
      <span className="n c-duration">
        {durationValue(duration) != null
          ? <DurationText reading={duration} />
          : <Absent why={durationAbsence(duration)} />}
      </span>
      <span className="n c-input">
        {fmtTokens(input.value) ?? <Absent why="no usage reported" />}
      </span>
      <span className="n c-output">
        {fmtTokens(out.value) ?? <Absent why="no usage reported" />}
        {/* `out.live` is `honesty.moving(agent)`, never `agent.state === 'running'`: an
            agent left `running` by an engine that went away still has a last `usage-cum`
            record, and the dot beside it claimed a counter that stopped moving before the
            operator opened the page (round 6, B1). */}
        {out.live ? <span className="live-dot" title="live from usage-cum">·</span> : null}
        <TokenBar share={share} />
      </span>
      <span className="n c-cost">
        {/* Parity #114: never $0.00 for a cost the journal never carried. */}
        {agent.usage?.cost ? fmtCost(agent.usage.cost) : <Absent why="no cost was journalled" />}
      </span>
      {/* Parity #53: `lastTool` and nothing else. A failed agent's last tool is where it
          died, so an error must not evict it. */}
      <span className="trunc c-lastTool">
        {agent.lastTool
          ? <span className="tool">{agent.lastTool}</span>
          : <Absent why="no tool call reported" />}
      </span>
      {/* KNOWN COUNTS (round 6, B2). `attempts` and `steers` are numbers the client always
          has (§6.2 — `attempts: number`, `steers: []`), so a zero here is a MEASUREMENT:
          "this agent has not been started yet" is exactly what a queued row means, and
          blanking it made a fact the run recorded look like a fact it never wrote. Parity
          #53 forbids inventing a `0` for an absent field, not reporting a real one. */}
      <span
        className="n c-attempts"
        title={knownCount(agent.attempts) == null
          ? 'this run recorded no attempt count'
          : agent.attempts === 1 ? '1 execution attempt' : `${agent.attempts} execution attempts`}
      >
        {knownCount(agent.attempts) ?? <Absent why="this run recorded no attempt count" />}
      </span>
      <span className="n c-steers" title={`${agent.steers?.length ?? 0} steers delivered`}>
        {agent.steers?.length ?? 0}
      </span>
    </button>
  )
}
