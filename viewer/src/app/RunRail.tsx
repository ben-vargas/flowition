// The persistent run rail (DESIGN §2.2, parity #37–#43).
//
// A compact projection of the Home table — status glyph, name-or-id, agents done/total,
// relative time — with a total-run count in its header (#37/#38), the open run marked
// active (#39), the same API-unreachable state Home shows (#40), collapse persisted in
// localStorage (#41), an overlay drawer below 900px that closes on selection (#42), and
// a 200–480px drag-resizable split, also persisted (#43).
//
// Home stays the full-page view for filtering and the attention strip; the rail is how
// you switch runs WITHOUT leaving the cockpit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.js'
import type { RunSummary } from '../api/types.js'
import { Icon } from '../ui/Icon.js'
import { StatusGlyph } from '../ui/Status.js'
import { timeAgo } from '../format/fmt.js'
import { href, navigate } from './router.js'
import { RUNS_LIMIT_DEFAULT, useMedia, usePagedRuns, usePersistentState, usePoll } from './hooks.js'

export const RAIL_COLLAPSED_KEY = 'flowition.rail.collapsed'
export const RAIL_WIDTH_KEY = 'flowition.rail.width'
export const RAIL_MIN = 200
export const RAIL_MAX = 480
export const RAIL_DEFAULT = 280

export interface RunRailProps {
  /** The run the current route is about; `null` on Home (parity #62's no-selection). */
  activeRunId: string | null
  /** Injected in tests so the rail can be exercised without a network. */
  load?: typeof api.runs
  /** Same seam, for the pinned active run below. */
  loadDetail?: typeof api.runDetail
  /**
   * Poll cadence. Production never passes it; tests do, because the behaviour that matters
   * here — what the rail shows when the SECOND poll fails — is unobservable at 5 s without
   * either faking the clock or making the cadence injectable, and the round-3 test that
   * claimed to cover it waited 20 ms and asserted on a poll that never happened.
   */
  pollMs?: number
}

export function RunRail(
  { activeRunId, load = api.runs, loadDetail = api.runDetail, pollMs = 5000 }: RunRailProps,
) {
  const [collapsed, setCollapsed] = usePersistentState(RAIL_COLLAPSED_KEY, false)
  const [width, setWidth] = usePersistentState(RAIL_WIDTH_KEY, RAIL_DEFAULT)
  const narrow = useMedia('(max-width: 899px)')
  // #42: below 900px the rail is an overlay drawer, opened explicitly, closed on select.
  // `setDrawerRaw` has exactly two callers — `openDrawer` and `closeDrawer` below — and
  // that is the point; see the focus note there.
  const [drawerOpen, setDrawerRaw] = usePersistentState('flowition.rail.drawer', false)

  // §5.4.2's cursor contract: the rail pages like Home does. It used to ask for one
  // 50-run page forever, which made every run past the fiftieth unreachable from the
  // cockpit — a truncation the operator could not even see.
  const page = usePagedRuns(load, { limit: RUNS_LIMIT_DEFAULT }, { intervalMs: pollMs })
  const { totalOnDisk, error } = page
  const loaded = page.runs.length

  // #39 — "the open run is marked active" — is a statement about the run the route is
  // about, not about the runs that happen to be on page one. Paging alone cannot keep it:
  // deep-link `#/run/<id>` for the 56th newest run and the rail renders its first 50 rows
  // with no active marker anywhere, so the cockpit's own run is missing from the switcher
  // that is supposed to say where you are.
  //
  // The listing cannot answer "where is this one run" cheaply — keyset paging is ordered,
  // so finding a run at depth N costs N/limit sequential requests EVERY poll, unbounded in
  // the run count and paid forever by a rail that only needed one row. `GET /api/runs/:id`
  // answers it exactly, in one request, at any depth. `RunDetail` is `RunSummary` with
  // `agents` renamed to `agentCounts` (see api/types.ts) — every field a rail row reads is
  // there, so the pinned row is the same projection as a listed one, not an approximation.
  //
  // Gated on `!page.loading`: before the first page settles nothing is known to be absent,
  // and a run on page one must not cost a detail request just because the rail is young.
  const absent = activeRunId != null && !page.loading
    && !page.runs.some((r) => r.runId === activeRunId)
  const pin = usePoll<RunSummary | null>(async (signal) => {
    if (!activeRunId) return null
    const detail = await loadDetail(activeRunId, signal)
    const { agentCounts, ...rest } = detail
    return { ...rest, agents: agentCounts }
  }, { intervalMs: pollMs, enabled: absent, deps: [activeRunId] })

  // A run cannot be both pinned and listed: the listing wins the moment it reaches it
  // (`absent` flips, the pin is disabled), and this guards the render in between.
  const pinned = pin.data && !page.runs.some((r) => r.runId === pin.data!.runId)
    ? pin.data
    : null

  // The pin is a SECOND request, and its failure has exactly the consequence #39 exists to
  // prevent: the rail renders rows the operator did not ask about, with no active marker
  // anywhere and — until this — nothing saying why. The later failure is the quieter half:
  // `usePoll` keeps the last good pin behind an error, so a run that died or a viewer that
  // went away left a pinned row that looked as current as every other row.
  //
  // Suppressed while the LISTING is also failing: that is one incident, and `ApiDownNote`
  // below already states it in the stronger terms. This note is for the case the listing
  // answers and the open run alone does not.
  const pinFailed = absent && pin.error != null && error == null
  // One list for rendering AND for the roving cursor — a pinned row that arrows cannot
  // reach would be a keyboard-inaccessible row, which §3.6 does not allow.
  const runs = useMemo(
    () => (pinned ? [pinned, ...page.runs] : page.runs),
    [pinned, page.runs],
  )

  const open = narrow ? drawerOpen : !collapsed

  // §3.6 focus management, and it is a RELEASE BLOCKER, not a nicety: "opening a panel
  // moves focus to its header; closing restores it."
  //
  // These four functions are the ONLY way this component changes open/closed, and each
  // one names where focus goes. The bug that made that a rule: the scrim called a close
  // that deliberately skipped the restore — reasoning that a pointer dismiss should not
  // move focus — but the panel being unmounted may CONTAIN the focused element, and then
  // there is no focus to leave alone. The browser drops it on `document.body`, and a
  // keyboard or screen-reader user loses their position in the document entirely. A
  // pointer user who never focused anything inside the drawer is unaffected either way,
  // because focus was already on the strip's place in the layout. So there is no
  // non-restoring close path, and no parameter with which to ask for one.
  const focusNext = useRef<'rail' | 'strip' | null>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const stripBtnRef = useRef<HTMLButtonElement>(null)

  const openDrawer = useCallback(() => {
    focusNext.current = 'rail'
    setDrawerRaw(true)
  }, [setDrawerRaw])
  const closeDrawer = useCallback(() => {
    focusNext.current = 'strip'
    setDrawerRaw(false)
  }, [setDrawerRaw])
  const expandRail = useCallback(() => {
    focusNext.current = 'rail'
    setCollapsed(false)
  }, [setCollapsed])
  const collapseRail = useCallback(() => {
    focusNext.current = 'strip'
    setCollapsed(true)
  }, [setCollapsed])

  const select = useCallback((runId: string) => {
    navigate(href.run(runId))
    // Selecting closes the drawer (#42) — which unmounts the row that was just clicked or
    // Entered, so this close needs the restore as much as any other.
    if (narrow) closeDrawer()
  }, [narrow, closeDrawer])

  useEffect(() => {
    const want = focusNext.current
    if (!want) return
    focusNext.current = null
    if (want === 'rail') headRef.current?.focus()
    else stripBtnRef.current?.focus()
  }, [collapsed, drawerOpen, narrow])

  useEffect(() => {
    if (!narrow || !drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeDrawer() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [narrow, drawerOpen, closeDrawer])

  // §3.6's roving tabindex: the rail is ONE tab stop, arrows move inside it.
  //
  // The rail and Home are two roving lists on one screen, and `j` means "next" in both.
  // So a keystroke the rail HANDLES is also stopped here: Home scopes its own window-level
  // shortcuts to its subtree, and this is the same guarantee from the other side, so the
  // two can never both move on one press (review round 3).
  const [cursor, setCursor] = useState(0)
  const at = runs.length === 0 ? -1 : Math.min(Math.max(cursor, 0), runs.length - 1)
  const onListKey = (e: React.KeyboardEvent) => {
    const last = runs.length - 1
    if (last < 0) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    let next = at
    if (e.key === 'ArrowDown' || e.key === 'j') next = Math.min(last, at + 1)
    else if (e.key === 'ArrowUp' || e.key === 'k') next = Math.max(0, at - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else return
    e.preventDefault()
    e.stopPropagation()
    setCursor(next)
  }

  if (narrow && !drawerOpen) {
    return <IconStrip count={totalOnDisk} btnRef={stripBtnRef} onExpand={openDrawer} />
  }
  if (!narrow && collapsed) {
    return <IconStrip count={totalOnDisk} btnRef={stripBtnRef} onExpand={expandRail} />
  }

  return (
    <>
      {narrow && open ? (
        // Same restoring close as Escape and the button: see the §3.6 note above.
        <div className="rail-scrim" onClick={closeDrawer} aria-hidden="true" />
      ) : null}
      <nav
        className={`rail${narrow ? ' drawer' : ''}`}
        style={{ width: narrow ? RAIL_DEFAULT : width }}
        aria-label="Runs"
      >
        <div className="rail-head" ref={headRef} tabIndex={-1}>
          <span className="lbl">Runs</span>
          {totalOnDisk != null ? <span className="count">{totalOnDisk}</span> : null}
          <span className="right">
            <button
              type="button" className="icb sm"
              aria-label="Collapse run rail"
              onClick={() => { if (narrow) closeDrawer(); else collapseRail() }}
            >
              <Icon name="chevron" size={12} className="flip" />
            </button>
          </span>
        </div>

        <div className="rail-scroll">
          {/* The `loaded === 0` gate that used to gate this was the same defect the
              attention strip had: once a page had loaded, a later poll failure was
              suppressed entirely and the cached rows read as current. Rows STAY (an
              operator must not lose the switcher because one poll missed) — they are
              just no longer presented as live. */}
          {error ? (
            <div className="rail-error">
              <ApiDownNote stale={loaded > 0} />
            </div>
          ) : null}
          {pinFailed ? (
            <div className="rail-error">
              <PinDownNote
                stale={pinned != null}
                message={pin.error!.message}
                onRetry={pin.reload}
              />
            </div>
          ) : null}
          {!page.loading && runs.length === 0 && !error ? (
            <p className="dim micro" style={{ padding: 'var(--s3)' }}>No runs yet.</p>
          ) : null}
          <ul role="list" onKeyDown={onListKey}>
            {runs.map((run, i) => (
              // The pinned row is deliberately out of keyset order — it is the open run,
              // lifted out of a page the rail has not pulled — so it gets a rule under it
              // rather than pretending to be the newest run on disk.
              <li key={run.runId} className={pinned && i === 0 ? 'pinned' : undefined}>
                <RailRow
                  run={run}
                  active={run.runId === activeRunId}
                  cursor={i === at}
                  onFocus={() => setCursor(i)}
                  onSelect={() => select(run.runId)}
                />
              </li>
            ))}
          </ul>
          {page.hasMore ? (
            <div className="rail-more">
              <button className="btn sm" type="button" onClick={page.loadMore}>
                Load more
              </button>
              <span className="dim micro">
                {loaded}{totalOnDisk != null ? ` of ${totalOnDisk}` : ''}
              </span>
            </div>
          ) : null}
        </div>

        {!narrow ? <RailGrip width={width} onWidth={setWidth} /> : null}
      </nav>
    </>
  )
}

function RailRow(
  { run, active, cursor, onSelect, onFocus }: {
    run: RunSummary; active: boolean; cursor: boolean
    onSelect: () => void; onFocus: () => void
  },
) {
  const label = run.name ?? run.runId
  const when = timeAgo(run.createdAt)
  const ref = useRef<HTMLButtonElement>(null)
  // Roving focus follows the cursor, but only while focus is already inside the rail —
  // moving the selection must never steal focus from the cockpit.
  useEffect(() => {
    const el = ref.current
    if (!cursor || !el || document.activeElement === el) return
    if (el.closest('.rail')?.contains(document.activeElement)) el.focus()
  }, [cursor])

  return (
    <button
      ref={ref}
      type="button"
      className="rrow"
      tabIndex={cursor ? 0 : -1}
      onClick={onSelect}
      onFocus={onFocus}
      // Enter on a focused row opens THIS run, explicitly. Leaving it to the browser's
      // implicit button activation was the bug: a window-level page shortcut saw the same
      // keydown first and `preventDefault`ed the activation away, so the rail's Enter
      // navigated to the other list's cursor. Handling it here — and stopping it — makes
      // the rail's own selection the only thing that can happen. (Space keeps its native
      // keyup activation, which no page shortcut competes for.)
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return
        e.preventDefault()
        e.stopPropagation()
        onSelect()
      }}
      {...(active ? { 'aria-current': 'true' as const } : {})}
    >
      <StatusGlyph state={run.state} />
      <span className="trunc">
        <span className="nm trunc" style={{ display: 'block' }}>{label}</span>
        <span className="sub">
          {run.agents.total > 0
            ? `${run.agents.done}/${run.agents.total} agents`
            : 'no agents'}
          {run.openQuestions > 0 ? ` · ${run.openQuestions} ?` : ''}
        </span>
      </span>
      <span className="when">{when ?? ''}</span>
    </button>
  )
}

function IconStrip(
  { count, onExpand, btnRef }: {
    count: number | null
    onExpand: () => void
    btnRef?: React.RefObject<HTMLButtonElement | null>
  },
) {
  return (
    <div className="rail collapsed">
      <div className="strip">
        <button
          type="button" className="icb" aria-label="Expand run rail"
          onClick={onExpand} {...(btnRef ? { ref: btnRef } : {})}
        >
          <Icon name="chevron" />
        </button>
        {count != null ? <span className="dotn">{count > 99 ? '99+' : count}</span> : null}
        <span className="vlbl">Runs</span>
      </div>
    </div>
  )
}

/** #43: drag within 200–480px. Keyboard-resizable too — §3.6 admits no pointer-only UI. */
function RailGrip({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  const dragging = useRef(false)

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      onWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(e.clientX))))
    }
    const up = () => { dragging.current = false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [onWidth])

  return (
    <div
      className="rail-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize run rail"
      aria-valuenow={width}
      aria-valuemin={RAIL_MIN}
      aria-valuemax={RAIL_MAX}
      tabIndex={0}
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 8
        if (e.key === 'ArrowLeft') onWidth(Math.max(RAIL_MIN, width - step))
        else if (e.key === 'ArrowRight') onWidth(Math.min(RAIL_MAX, width + step))
        else return
        e.preventDefault()
      }}
    >
      <Icon name="drag" size={12} />
    </div>
  )
}

/**
 * parity #40: the rail shows the same API-unreachable state Home does.
 *
 * `stale` is the degraded case — the rail HAS rows and a later poll failed, so what is on
 * screen is a snapshot of the last successful poll and the note says which it is. The two
 * cases are the same incident with different consequences, so they are one component with
 * one clause of difference rather than two banners that could drift apart.
 */
/**
 * #39 when the run the route is about cannot be fetched.
 *
 * Two cases, one incident, exactly as `ApiDownNote` handles its two:
 *   • no pin yet — the rail is a list of runs the operator did not open, and the one they
 *     DID is simply missing from it. Saying "these are not it" is the whole job;
 *   • a cached pin — the row is there but it is a snapshot of the last successful read, so
 *     it is kept (losing the switcher over one failed poll would be worse) and marked.
 *
 * The Retry re-requests the pin alone: the listing is answering, so re-running it would be
 * asking a question that already has an answer.
 */
export function PinDownNote(
  { stale, message, onRetry }: { stale: boolean; message: string; onRetry: () => void },
) {
  return (
    <div className="banner warn" role="status">
      <Icon name="stale" size={14} />
      <span>
        <b>The open run could not be loaded.</b>{' '}
        {stale
          ? 'Its row here is the last thing this viewer read — it is not updating.'
          : 'It is not on the pages the rail has pulled, so it has no row here yet.'}
        {message ? <> (<span className="mono">{message}</span>)</> : null}
      </span>
      <button
        className="btn sm" type="button" style={{ marginLeft: 'auto' }} onClick={onRetry}
      >
        <Icon name="resume" size={12} />Retry
      </button>
    </div>
  )
}

export function ApiDownNote({ stale = false }: { stale?: boolean }) {
  return (
    <div className={`banner${stale ? ' warn' : ''}`} role="status">
      <Icon name={stale ? 'stale' : 'failed'} size={14} />
      <span>
        <b>API unreachable.</b> Is <code>flowition viewer</code> still running?
        {stale ? ' These runs are the last it returned — they are not updating.' : ''}
      </span>
    </div>
  )
}
