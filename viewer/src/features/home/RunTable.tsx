// The §2.3 run table: virtualized rows, eight aligned columns, `j/k` + Enter.
//
// Two rules from the comp's annotations do the heavy lifting:
//   • "Empty ≠ zero" (annotation 5 / parity #53, #114): a cost the journal never carried
//     renders BLANK. Never `$0.00`, never a placeholder dash that reads as a measurement.
//   • Numbers are right-aligned mono with tnum so magnitudes compare down the column.

import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { RunSummary } from '../../api/types.js'
import { Icon } from '../../ui/Icon.js'
import { AdapterCluster, StatusGlyph } from '../../ui/Status.js'
import { elapsed, fmtDuration, fmtTokens, summaryCost, timeAgo } from '../../format/fmt.js'

export const ROW_HEIGHT = 44

export interface RunTableProps {
  runs: RunSummary[]
  now: number
  activeRunId: string | null
  cursorIndex: number
  onOpen: (runId: string) => void
  onCursor: (index: number) => void
  /** Test seam: jsdom reports every element as 0×0, so virtualization windows to nothing. */
  virtualize?: boolean
}

export function RunTable(props: RunTableProps) {
  const { runs, virtualize = true } = props
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    enabled: virtualize,
  })

  const items = virtualize ? virtualizer.getVirtualItems() : null

  // Keep the keyboard cursor in view (§2.7 `j/k`).
  useEffect(() => {
    if (!virtualize || props.cursorIndex < 0) return
    virtualizer.scrollToIndex(props.cursorIndex, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.cursorIndex])

  return (
    <div className="rt">
      {/* Visual column labels for the list below, not an ARIA table row. Claiming
          `role=row` here without a grid/table parent and cell children violates the
          required-owned-elements contract; the interactive data stays a named list. */}
      <div className="rt-row head">
        <span />
        <span className="lbl">run</span>
        {/* `col-ad` / `col-out` are the two columns the 800px rules drop (home.css). */}
        <span className="lbl col-ad">adapters</span>
        <span className="lbl">agents</span>
        <span className="lbl col-out" style={{ textAlign: 'right' }}>out</span>
        <span className="lbl" style={{ textAlign: 'right' }}>cost</span>
        <span className="lbl" style={{ textAlign: 'right' }}>duration</span>
        <span className="lbl" style={{ textAlign: 'right' }}>started ↓</span>
      </div>
      <div className="rt-scroll" ref={scrollRef}>
        <ul
          role="list"
          aria-label="Runs"
          style={items ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}
        >
          {items
            ? items.map((item) => (
              <li
                key={runs[item.index]!.runId}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute', top: 0, left: 0, width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <RunRow
                  run={runs[item.index]!}
                  index={item.index}
                  now={props.now}
                  active={runs[item.index]!.runId === props.activeRunId}
                  cursor={item.index === props.cursorIndex}
                  onOpen={props.onOpen}
                  onCursor={props.onCursor}
                />
              </li>
            ))
            : runs.map((run, index) => (
              <li key={run.runId}>
                <RunRow
                  run={run} index={index} now={props.now}
                  active={run.runId === props.activeRunId}
                  cursor={index === props.cursorIndex}
                  onOpen={props.onOpen} onCursor={props.onCursor}
                />
              </li>
            ))}
        </ul>
      </div>
    </div>
  )
}

function RunRow(
  { run, index, now, active, cursor, onOpen, onCursor }: {
    run: RunSummary; index: number; now: number; active: boolean; cursor: boolean
    onOpen: (runId: string) => void; onCursor: (i: number) => void
  },
) {
  const ref = useRef<HTMLButtonElement>(null)
  // §3.6: roving tabindex in the run list — one stop for the whole list, arrows inside.
  useEffect(() => {
    if (cursor && ref.current && document.activeElement !== ref.current
      && ref.current.closest('.rt')?.contains(document.activeElement)) {
      ref.current.focus()
    }
  }, [cursor])

  const out = fmtTokens(run.spend?.output)
  const cost = summaryCost(run.spend)
  // The clock runs to `now` only while the run is actually live. A run that stopped WITHOUT
  // writing a terminal event has no `endedAt` (the `stale` case — §6.2), and measuring it
  // to `now` would report its age as its duration and keep incrementing it. That is a
  // number the engine never recorded, so by this file's own "empty ≠ zero" rule the cell
  // is blank and says why (parity #53/#114).
  const live = run.state === 'running' || run.state === 'starting'
  const dur = fmtDuration(
    live || run.endedAt != null ? elapsed(run.startedAt, run.endedAt, now) : null,
  )
  const when = timeAgo(run.createdAt, now)

  return (
    <button
      ref={ref}
      type="button"
      className="rt-row"
      tabIndex={cursor ? 0 : -1}
      {...(active ? { 'aria-current': 'true' as const } : {})}
      onFocus={() => onCursor(index)}
      onClick={() => onOpen(run.runId)}
    >
      <StatusGlyph state={run.state} />
      <span className="rt-name">
        <span className="nm trunc">
          {run.name ?? <span className="mono dim">{run.runId}</span>}
        </span>
        {run.name ? <span className="rid">{run.runId}</span> : null}
        <Badges run={run} />
      </span>
      <span className="col-ad"><AdapterCluster names={run.adapters} /></span>
      <span><Progress agents={run.agents} /></span>
      <Cell value={out} title="output tokens" className="col-out" />
      <Cell value={cost} title="cost from the journal" />
      <Cell value={dur} title="duration" />
      <span className="when">{when ?? ''}</span>
    </button>
  )
}

/**
 * parity #53/#114. An absent number is a BLANK cell carrying an explanatory title — not a
 * zero, not a dash. `title` is on a non-interactive span deliberately: the value is
 * absent, so there is nothing to activate.
 */
function Cell(
  { value, title, className = '' }: { value: string | null; title: string; className?: string },
) {
  const cls = `n${className ? ` ${className}` : ''}`
  if (value == null) {
    return <span className={`${cls} absent`} title={`no ${title} recorded for this run`}>&nbsp;</span>
  }
  return <span className={cls}>{value}</span>
}

function Progress({ agents }: { agents: RunSummary['agents'] }) {
  if (agents.total === 0) return <span className="progress-mini dim">—</span>
  const settled = agents.done + agents.cached
  const pct = (n: number) => `${(n / agents.total) * 100}%`
  return (
    <span className="progress-mini">
      <span className="bar" aria-hidden="true">
        <i className="d" style={{ width: pct(settled) }} />
      </span>
      <span>
        {agents.done}/{agents.total}
        {agents.cached ? <span className="dim"> +{agents.cached}c</span> : null}
      </span>
    </span>
  )
}

function Badges({ run }: { run: RunSummary }) {
  const badges: React.ReactNode[] = []
  if (run.openQuestions > 0) {
    badges.push(
      <span className="badge ask" key="ask">
        <Icon name="blocked" size={12} />
        {run.openQuestions} question{run.openQuestions === 1 ? '' : 's'}
      </span>,
    )
  }
  if (run.hasRunLog) {
    // NOT "detached": the file persists and is written by both detached launchers, so it
    // is not proof the current attempt is detached (critique N12).
    badges.push(
      <span className="badge" key="log"><Icon name="external" size={12} />detached log</span>,
    )
  }
  if (run.resumeCount > 0) {
    badges.push(<span className="badge" key="res">resumed ×{run.resumeCount}</span>)
  }
  if (run.budgetTotal != null) {
    badges.push(<span className="badge" key="bud"><Icon name="bolt" size={12} />budget</span>)
  }
  if (run.agents.cached > 0) {
    badges.push(
      <span className="badge replay" key="cached">
        <Icon name="cached" size={12} />{run.agents.cached} cached
      </span>,
    )
  }
  if (badges.length === 0) return null
  return <span className="rt-badges">{badges}</span>
}
