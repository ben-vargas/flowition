import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { fmtClock, fmtStamp, timeAgo } from '../../format/fmt.js'
import { HardenedMarkdown } from '../../lib/markdown.js'
import { Icon } from '../../ui/Icon.js'
import { useScrollClip } from '../../ui/useScrollClip.js'
import { useActionFloorClaim } from '../control/actionFloor.js'
import {
  DisclosureBody,
  MailMarker,
  OrphanResultCard,
  PromptCard,
  RawGroup,
  ReasoningCard,
  StatusLine,
  ToolCard,
  UnknownRow,
} from './Cards.js'
import { autoStepExpanded } from './grouping.js'
import { observeElementOffsetCancellable } from './observeOffset.js'
import type { OrphanResultItem, TimelineUnit, ToolItem } from './types.js'
import { buildWorkSummaryLabel } from './workSummary.js'

export interface VirtualTimelineProps {
  units: TimelineUnit[]
  live: boolean
  oldMayBeTruncated: boolean
  manual: Record<string, boolean>
  onManual(id: string, expanded: boolean): void
  onLoadOlder?(): void
  searchTarget?: { offset: number; index: number; itemId: string } | null
  pinnedStep?: number | null
  onPinnedStep?(step: number): void
  failure?: { message: string; code: string | null; retryable: boolean | null } | null
  now?: number
}

const ESTIMATE = 92
const LARGE_STEP_ITEMS = 100
const STEP_ITEM_ESTIMATE = 150
/* The pane's breathing room above the first row — owned by the virtualizer, NEVER by CSS
 * padding on `.tp-body`. The two coordinate systems must be identical: a `padding-top`
 * the library cannot see puts every scroll target and measurement correction that many
 * pixels short of the browser's real maximum, so a wheel at the bottom gets snapped back
 * (the "bounce"), the resting gap never closes, and the follow threshold cannot re-arm.
 * 12 = --s3 (ui/base.css); the wheel-to-bottom e2e test pins the behavior. */
const PANE_PADDING_START = 12

export function VirtualTimeline(props: VirtualTimelineProps) {
  const {
    units, live, manual, onManual, oldMayBeTruncated, failure,
    pinnedStep, searchTarget, onPinnedStep,
  } = props
  const parentRef = useRef<HTMLDivElement>(null)
  const programmatic = useRef(false)
  const pointerHeld = useRef(false)
  const lastIntent = useRef(-Infinity)
  const [follow, setFollow] = useState(true)
  const fades = useScrollClip(parentRef)
  const count = units.length + (failure ? 1 : 0)
  const tailUnit = units.at(-1)
  const tailKey = tailUnit?.id ?? ''
  const tailExtent = tailUnit ? unitContentExtent(tailUnit) : 0
  const virtual = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATE,
    paddingStart: PANE_PADDING_START,
    overscan: 8,
    getItemKey: (index) => index < units.length ? units[index]!.id : 'agent-failure',
    initialRect: { width: 800, height: 600 },
    // The library's own offset observer leaks its "scrolling stopped" debounce past
    // unsubscribe, so a scroll in the last 150 ms of this component's life re-renders it
    // after unmount. See `observeOffset.ts` — same behavior, cancellable.
    observeElementOffset: observeElementOffsetCancellable,
  })

  const updateMetrics = () => {
    const el = parentRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (bottom <= 4) setFollow(true)
    else if (!programmatic.current && (pointerHeld.current || performance.now() - lastIntent.current <= 350)) {
      setFollow(false)
    }
    if (el.scrollTop <= 80) props.onLoadOlder?.()
  }

  useEffect(() => {
    if (!follow || !count) return
    programmatic.current = true
    virtual.scrollToIndex(count - 1, { align: 'end' })
    const id = requestAnimationFrame(() => { programmatic.current = false; updateMetrics() })
    return () => cancelAnimationFrame(id)
  }, [count, follow, tailKey, tailExtent, virtual])

  useEffect(() => {
    if (searchTarget == null || searchTarget.index < 0 || searchTarget.index >= units.length) return
    setFollow(false)
    programmatic.current = true
    virtual.scrollToIndex(searchTarget.index, { align: 'center' })
    // Cancelled on unmount for the same reason the follow effect above cancels its own:
    // scheduled work that outlives the component is scheduled work that runs against a
    // torn-down tree.
    const id = requestAnimationFrame(() => { programmatic.current = false; updateMetrics() })
    return () => cancelAnimationFrame(id)
  }, [searchTarget, units.length, virtual])

  useEffect(() => {
    if (pinnedStep == null) return
    let seen = -1
    const at = units.findIndex((unit) => {
      if (unit.kind !== 'step') return false
      seen++
      return seen === pinnedStep
    })
    if (at < 0) return
    setFollow(false)
    programmatic.current = true
    virtual.scrollToIndex(at, { align: 'center' })
    const id = requestAnimationFrame(() => { programmatic.current = false; updateMetrics() })
    return () => cancelAnimationFrame(id)
  }, [pinnedStep, units, virtual])

  // "Jump to latest" is a page control the toast layer must not cover (actionFloor.ts).
  const jumpRef = useRef<HTMLButtonElement | null>(null)
  useActionFloorClaim(jumpRef)

  const items = virtual.getVirtualItems()
  const stepOrdinal = useMemo(() => {
    const map = new Map<string, number>()
    let n = 0
    for (const unit of units) if (unit.kind === 'step') map.set(unit.id, n++)
    return map
  }, [units])
  const now = props.now ?? Date.now()

  return (
    <div className={`virtual-frame${fades.top ? ' fade-top' : ''}${fades.bottom ? ' fade-bottom' : ''}`}>
      <div
        ref={parentRef}
        className="tp-body"
        data-follow={follow ? 'tail' : 'paused'}
        onScroll={updateMetrics}
        onWheel={() => { lastIntent.current = performance.now() }}
        onTouchStart={() => { lastIntent.current = performance.now() }}
        onPointerDown={() => { pointerHeld.current = true }}
        onPointerUp={() => { pointerHeld.current = false; updateMetrics() }}
        onPointerCancel={() => { pointerHeld.current = false; updateMetrics() }}
      >
        <div className="virtual-spacer" style={{ height: virtual.getTotalSize() }}>
          {items.map((virtualRow) => {
            const unit = units[virtualRow.index]
            return (
              <div
                key={virtualRow.key}
                ref={virtual.measureElement}
                data-index={virtualRow.index}
                data-timeline-row-list=""
                className="virtual-row"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {unit ? (
                  <TimelineRow
                    unit={unit}
                    index={virtualRow.index}
                    total={units.length}
                    live={live}
                    oldMayBeTruncated={oldMayBeTruncated}
                    manual={manual}
                    onManual={onManual}
                    now={now}
                    minuteBoundary={minuteBoundary(units, virtualRow.index)}
                    stepOrdinal={stepOrdinal.get(unit.id) ?? null}
                    onPinnedStep={onPinnedStep}
                    searchItemId={searchTarget?.index === virtualRow.index ? searchTarget.itemId : null}
                  />
                ) : failure ? <FailureCard failure={failure} /> : null}
              </div>
            )
          })}
        </div>
      </div>
      {/* Bottom-right of the frame, directly above §2.5's composer and on the same edge as
          its Send button — so it is part of the lower interactive exclusion zone the toast
          layer must clear, and it claims the floor itself rather than trusting the composer
          below it to have reserved enough (actionFloor.ts). The ref is on the button, so the
          claim exists exactly while the control does. */}
      {!follow && units.length ? (
        <button
          ref={jumpRef} type="button" className="jump-tail btn" onClick={() => setFollow(true)}
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  )
}

function minuteBoundary(units: TimelineUnit[], index: number): boolean {
  const t = units[index]?.t
  if (t == null) return false
  if (index === 0) return true
  const before = units[index - 1]?.t
  return before == null || Math.floor(before / 60_000) !== Math.floor(t / 60_000)
}

function itemContentExtent(
  item: Extract<TimelineUnit, { kind: 'row' }>['item'] | Extract<TimelineUnit, { kind: 'step' }>['items'][number],
): number {
  if (
    item.kind === 'prompt' || item.kind === 'text' || item.kind === 'reasoning'
    || item.kind === 'status' || item.kind === 'mail'
  ) return item.text.length
  if (item.kind === 'raw') return item.lines.reduce((total, line) => total + line.length, 0)
  if (item.kind === 'unknown') return Object.keys(item.value).length
  if (item.kind === 'attempt') return 0
  if (item.kind === 'orphan-result') return item.result.text.length
  let extent = item.inputText.length + (item.command?.length ?? 0) + (item.result?.text.length ?? 0)
  for (const file of item.files) {
    extent += file.path.length + (file.movePath?.length ?? 0) + (file.diff?.length ?? 0)
  }
  return extent
}

function unitContentExtent(unit: TimelineUnit): number {
  return unit.kind === 'row'
    ? itemContentExtent(unit.item)
    : unit.items.reduce((total, item) => total + itemContentExtent(item), 0)
}

interface TimelineRowProps {
  unit: TimelineUnit
  index: number
  total: number
  live: boolean
  oldMayBeTruncated: boolean
  manual: Record<string, boolean>
  onManual(id: string, expanded: boolean): void
  now: number
  minuteBoundary: boolean
  stepOrdinal: number | null
  onPinnedStep?(step: number): void
  searchItemId: string | null
}

function sameTimelineItem(
  a: Extract<TimelineUnit, { kind: 'row' }>['item'] | Extract<TimelineUnit, { kind: 'step' }>['items'][number],
  b: Extract<TimelineUnit, { kind: 'row' }>['item'] | Extract<TimelineUnit, { kind: 'step' }>['items'][number],
): boolean {
  if (a === b) return true
  if (a.id !== b.id || a.kind !== b.kind || a.o !== b.o || a.t !== b.t || a.attempt !== b.attempt) return false
  if (a.kind === 'prompt' && b.kind === 'prompt') return a.text === b.text && a.truncated === b.truncated
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text
  if (a.kind === 'reasoning' && b.kind === 'reasoning') return a.text === b.text
  if (a.kind === 'status' && b.kind === 'status') return a.text === b.text
  if (a.kind === 'mail' && b.kind === 'mail') {
    return a.text === b.text && a.direction === b.direction
      && a.origin === b.origin && a.delivery === b.delivery
  }
  if (a.kind === 'raw' && b.kind === 'raw') {
    return a.lines.length === b.lines.length && a.lines.every((line, index) => line === b.lines[index])
  }
  if (a.kind === 'attempt' && b.kind === 'attempt') return a.approximate === b.approximate
  if (a.kind === 'unknown' && b.kind === 'unknown') return true
  if (a.kind === 'orphan-result' && b.kind === 'orphan-result') {
    return a.name === b.name && a.toolUseId === b.toolUseId
      && a.result.text === b.result.text && a.result.isError === b.result.isError
      && a.result.exitCode === b.result.exitCode && a.result.t === b.result.t
  }
  if (a.kind === 'tool' && b.kind === 'tool') {
    if (
      a.card !== b.card || a.name !== b.name || a.inputText !== b.inputText
      || a.toolId !== b.toolId || a.approximate !== b.approximate || a.command !== b.command
      || a.files.length !== b.files.length
    ) return false
    if (Boolean(a.result) !== Boolean(b.result)) return false
    if (a.result && b.result && (
      a.result.text !== b.result.text || a.result.isError !== b.result.isError
      || a.result.exitCode !== b.result.exitCode || a.result.t !== b.result.t
    )) return false
    return a.files.every((file, index) => {
      const other = b.files[index]!
      return file.action === other.action && file.path === other.path && file.movePath === other.movePath
        && file.diff === other.diff && file.additions === other.additions && file.deletions === other.deletions
    })
  }
  return false
}

function sameUnit(a: TimelineUnit, b: TimelineUnit): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.id !== b.id || a.t !== b.t || a.attempt !== b.attempt) return false
  if (a.kind === 'row' && b.kind === 'row') return sameTimelineItem(a.item, b.item)
  if (a.kind === 'step' && b.kind === 'step') {
    return a.pending === b.pending && a.items.length === b.items.length
      && a.items.every((item, index) => sameTimelineItem(item, b.items[index]!))
  }
  return false
}

function sameManualForUnit(
  unit: TimelineUnit,
  before: Record<string, boolean>,
  after: Record<string, boolean>,
): boolean {
  if (before === after) return true
  if (before[unit.id] !== after[unit.id]) return false
  if (unit.kind !== 'step') return true
  return unit.items.every((item) => {
    if (before[item.id] !== after[item.id]) return false
    if (item.kind !== 'tool' || item.card !== 'file') return true
    const count = Math.max(1, item.files.length)
    for (let index = 0; index < count; index++) {
      const rowId = `${item.id}:file:${index}`
      if (before[rowId] !== after[rowId]) return false
    }
    return true
  })
}

const TimelineRow = memo(function TimelineRow(
  { unit, index, total, live, oldMayBeTruncated, manual, onManual, now, minuteBoundary: boundary, stepOrdinal, onPinnedStep, searchItemId }:
  TimelineRowProps,
) {
  const t = unit.t
  const breakout = unit.kind === 'step'
    && unit.items.some((item) => item.kind === 'tool' && (item.card === 'terminal' || item.card === 'file'))
  return (
    <div className={`trow${breakout ? ' breakout' : ''}`} data-timeline-row-id={unit.id}>
      <div className="gut" title={fmtStamp(t) ?? undefined}>
        {boundary ? <span className="abs">{fmtClock(t)?.slice(0, index === 0 ? 8 : 5)}</span> : null}
        <span className="rel dim">{timeAgo(t, now)}</span>
      </div>
      <div className="bd">
        {unit.kind === 'step' ? (
          <Step
            unit={unit}
            expanded={(manual[unit.id] ?? autoStepExpanded(unit, index, total, live)) || searchItemId != null}
            manual={manual}
            onManual={onManual}
            live={live && index === total - 1}
            searchItemId={searchItemId}
            onPin={stepOrdinal != null && onPinnedStep ? () => onPinnedStep(stepOrdinal) : undefined}
          />
        ) : <Boundary item={unit.item} oldMayBeTruncated={oldMayBeTruncated} manual={manual} onManual={onManual} />}
      </div>
    </div>
  )
}, (before, after) => (
  sameUnit(before.unit, after.unit)
  && before.index === after.index
  && before.oldMayBeTruncated === after.oldMayBeTruncated
  && before.minuteBoundary === after.minuteBoundary
  && before.stepOrdinal === after.stepOrdinal
  && Boolean(before.onPinnedStep) === Boolean(after.onPinnedStep)
  && before.searchItemId === after.searchItemId
  && (before.live && before.index === before.total - 1) === (after.live && after.index === after.total - 1)
  && sameManualForUnit(after.unit, before.manual, after.manual)
))

function Step(
  { unit, expanded, manual, onManual, live, onPin, searchItemId }:
  {
    unit: Extract<TimelineUnit, { kind: 'step' }>
    expanded: boolean
    manual: Record<string, boolean>
    onManual(id: string, expanded: boolean): void
    live: boolean
    onPin?: () => void
    searchItemId: string | null
  },
) {
  const tools = unit.items.filter((item): item is ToolItem => item.kind === 'tool')
  const summary = buildWorkSummaryLabel(tools, live)
  return (
    <section className="step">
      <div className="step-head">
        <button type="button" className="step-toggle" aria-expanded={expanded} onClick={() => onManual(unit.id, !expanded)}>
          <Icon name="chevron" className="chev" />
          <Icon name="tool" size={14} className="dim" />
          <span className="sum">{summary}</span>
          <span className="right">{unit.items.length} {unit.items.length === 1 ? 'row' : 'rows'}</span>
        </button>
        {onPin ? <button type="button" className="icb sm" aria-label="Pin both panes to this step" onClick={onPin}><Icon name="drag" size={12} /></button> : null}
      </div>
      <DisclosureBody expanded={expanded} className="step-collapse">
        <StepItems
          items={unit.items}
          manual={manual}
          onManual={onManual}
          followTail={unit.pending || live}
          searchItemId={searchItemId}
        />
      </DisclosureBody>
    </section>
  )
}

type StepItem = ToolItem | OrphanResultItem

function StepItems(
  { items, manual, onManual, followTail, searchItemId }: {
    items: readonly StepItem[]
    manual: Record<string, boolean>
    onManual(id: string, expanded: boolean): void
    followTail: boolean
    searchItemId: string | null
  },
) {
  if (items.length > LARGE_STEP_ITEMS) {
    return (
      <VirtualStepItems
        items={items}
        manual={manual}
        onManual={onManual}
        followTail={followTail}
        searchItemId={searchItemId}
      />
    )
  }
  return (
    <div className="step-body">
      {items.map((item, index) => (
        <StepItemCard
          key={item.id}
          item={item}
          index={index}
          total={items.length}
          manual={manual}
          onManual={onManual}
        />
      ))}
    </div>
  )
}

/**
 * One transcript step may contain thousands of adjacent tool records. It is still ONE
 * semantic step (§9.6), but eagerly constructing every card made a dense 100 MiB tail wait
 * ~1.5–2 s before React could paint even the header. The outer timeline cannot help: it sees
 * the whole step as one row. Large expanded steps therefore get a bounded inner viewport;
 * every record remains scroll-reachable while only the visible cards are materialized.
 */
function VirtualStepItems(
  { items, manual, onManual, followTail, searchItemId }: {
    items: readonly StepItem[]
    manual: Record<string, boolean>
    onManual(id: string, expanded: boolean): void
    followTail: boolean
    searchItemId: string | null
  },
) {
  const parentRef = useRef<HTMLDivElement>(null)
  const programmatic = useRef(false)
  const pointerHeld = useRef(false)
  const lastIntent = useRef(-Infinity)
  const searchIndex = useMemo(
    () => searchItemId == null ? -1 : items.findIndex((item) => item.id === searchItemId),
    [items, searchItemId],
  )
  const [follow, setFollow] = useState(followTail && searchIndex < 0)
  const initialIndex = searchIndex >= 0 ? searchIndex : followTail ? items.length - 1 : 0
  const initialOffset = Math.max(
    0,
    initialIndex * STEP_ITEM_ESTIMATE - (searchIndex >= 0 ? 300 : 600 - STEP_ITEM_ESTIMATE),
  )
  const tailItem = items.at(-1)
  const tailKey = tailItem?.id ?? ''
  const tailExtent = tailItem ? itemContentExtent(tailItem) : 0
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => STEP_ITEM_ESTIMATE,
    overscan: 6,
    getItemKey: (index) => items[index]!.id,
    initialRect: { width: 800, height: 600 },
    initialOffset,
    observeElementOffset: observeElementOffsetCancellable,
  })

  const updateMetrics = () => {
    const el = parentRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (bottom <= 4) setFollow(true)
    else if (!programmatic.current && (pointerHeld.current || performance.now() - lastIntent.current <= 350)) {
      setFollow(false)
    }
  }

  useEffect(() => {
    if (!follow || !followTail || !items.length) return
    programmatic.current = true
    virtual.scrollToIndex(items.length - 1, { align: 'end' })
    const id = requestAnimationFrame(() => { programmatic.current = false; updateMetrics() })
    return () => cancelAnimationFrame(id)
  }, [follow, followTail, items.length, tailKey, tailExtent, virtual])

  useEffect(() => {
    if (searchIndex < 0) return
    setFollow(false)
    programmatic.current = true
    virtual.scrollToIndex(searchIndex, { align: 'center' })
    const id = requestAnimationFrame(() => { programmatic.current = false; updateMetrics() })
    return () => cancelAnimationFrame(id)
  }, [searchIndex, searchItemId, virtual])

  return (
    <div
      ref={parentRef}
      className="step-body step-body-virtual"
      data-follow={follow ? 'tail' : 'paused'}
      role="list"
      aria-label={`${items.length.toLocaleString()} tool records in this step`}
      onScroll={updateMetrics}
      onWheel={() => { lastIntent.current = performance.now() }}
      onTouchStart={() => { lastIntent.current = performance.now() }}
      onPointerDown={() => { pointerHeld.current = true }}
      onPointerUp={() => { pointerHeld.current = false; updateMetrics() }}
      onPointerCancel={() => { pointerHeld.current = false; updateMetrics() }}
    >
      <div className="step-items-spacer" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((row) => (
          <div
            key={row.key}
            ref={virtual.measureElement}
            data-index={row.index}
            data-step-item-id={items[row.index]!.id}
            className="step-item-virtual"
            role="listitem"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <StepItemCard
              item={items[row.index]!}
              index={row.index}
              total={items.length}
              manual={manual}
              onManual={onManual}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function StepItemCard(
  { item, index, total, manual, onManual }: {
    item: StepItem
    index: number
    total: number
    manual: Record<string, boolean>
    onManual(id: string, expanded: boolean): void
  },
) {
  if (item.kind === 'orphan-result') return <OrphanResultCard item={item} />
  const pendingFrontier = item.result == null && index === total - 1
  const open = manual[item.id] ?? pendingFrontier
  return (
    <ToolCard
      item={item}
      expanded={open}
      onExpanded={(next) => onManual(item.id, next)}
      manual={manual}
      onManual={onManual}
    />
  )
}

function Boundary(
  { item, oldMayBeTruncated, manual, onManual }:
  {
    item: Extract<TimelineUnit, { kind: 'row' }>['item']
    oldMayBeTruncated: boolean
    manual: Record<string, boolean>
    onManual(id: string, expanded: boolean): void
  },
) {
  const expanded = manual[item.id] ?? false
  const toggle = (next: boolean) => onManual(item.id, next)
  if (item.kind === 'prompt') return <PromptCard item={item} oldMayBeTruncated={oldMayBeTruncated} expanded={expanded} onExpanded={toggle} />
  if (item.kind === 'text') return <HardenedAnswer text={item.text} />
  if (item.kind === 'reasoning') return <ReasoningCard item={item} expanded={expanded} onExpanded={toggle} />
  if (item.kind === 'mail') return <MailMarker item={item} />
  if (item.kind === 'status') return <StatusLine item={item} />
  if (item.kind === 'raw') return <RawGroup item={item} expanded={expanded} onExpanded={toggle} />
  if (item.kind === 'unknown') return <UnknownRow item={item} expanded={expanded} onExpanded={toggle} />
  return (
    <div className="attempt-marker">
      <span /><span className="badge"><Icon name="resume" size={12} />attempt {item.attempt} begins here{item.approximate ? ' (approximate)' : ''}</span><span />
    </div>
  )
}

function HardenedAnswer({ text }: { text: string }) {
  // No wrapper and no class of its own: the renderer already emits the `.prose` block this
  // row needs, and `.trow > .bd` already gives it the 88ch column and the `min-width: 0`.
  // The wrapper's old `className="answer"` matched home.css's answer-composer grid, which
  // is the only thing it ever contributed — a two-column layout for one child.
  return <HardenedMarkdown source={text} />
}

function FailureCard({ failure }: { failure: NonNullable<VirtualTimelineProps['failure']> }) {
  return (
    <div className="trow breakout" data-timeline-row-id="agent-failure">
      <div className="gut" />
      <div className="bd">
        <section className="errcard" role="alert">
          <div className="eh"><Icon name="failed" size={14} /><span className="t">agent failed</span></div>
          <div className="em">{failure.message}</div>
          <div className="micro mono">
            {failure.code ? `code ${failure.code}` : 'no error code reported'}
            {failure.retryable != null ? ` · ${failure.retryable ? 'retryable' : 'not retryable'}` : ''}
          </div>
        </section>
      </div>
    </div>
  )
}
