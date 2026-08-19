/**
 * The run cockpit (DESIGN §2.4) — the screen that answers Q2, Q4, Q5, Q6 and Q7.
 *
 * Composition, top to bottom: header (state + liveness ladder + budget gauge + lineage),
 * the last log line (parity #59), the three tabs, and the log lane as a bottom drawer. The
 * inbox rail is §3.7's third column and is rendered here (see `InboxRail`'s header for why
 * W11 owns the column while W12 owns the composer); `props.inbox` replaces it wholesale.
 *
 * §3.7's grid, verbatim, and asserted in a real browser by
 * `docs/frontend/comps/capture-built.mjs`: at 1440 the run rail is 280, this main column is
 * 840 and the inbox rail is 320. Below §3.3's 900px breakpoint both rails are 44px drawer
 * handles (the comps' `cockpit-live-800` annotation 14) and the main column takes the rest.
 *
 * Data comes from W9's `runStore`: snapshot → seeded fold → SSE, coalesced to at most one
 * commit per frame. Nothing here polls, derives liveness, or folds anything itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { api, getToken, subscribeToken } from '../../api/client.js'
import type { LogView, RunDetail, RunState } from '../../api/types.js'
import { deriveCaps } from '../../fold/index.js'
import {
  createRunStore,
  type RunSnapshot,
  type RunStoreApi,
  type RunStoreHandle,
} from '../../state/runStore.js'
import { useStore } from '../../state/stores.js'
import { useMedia, useTick } from '../../app/hooks.js'
import { href, navigate } from '../../app/router.js'
import { isTypingTarget } from '../../theme/theme.js'
import { Icon } from '../../ui/Icon.js'
import { StatusGlyph } from '../../ui/Status.js'
import { useControl } from '../control/ControlProvider.js'
import { AgentsTab, type Grouping } from './AgentsTab.js'
import { type RunHonesty, RunHonestyContext, deriveHonesty, isRunLive } from './honesty.js'
import { InboxRail, inboxDefaultOpen } from './InboxRail.js'
import { LastLogLine, LogLane } from './LogLane.js'
import { RunHeader, archivedAttempt, canResumeState } from './RunHeader.js'
import { Structure } from './Structure.js'
import { CockpitTabs, TABS as TAB_ORDER } from './Tabs.js'
import type { CockpitTab } from './Tabs.js'
import { Timeline, type TimelineAttempt } from './Timeline.js'
import { type SortDir, type SortKey } from './agents.js'
import { type Zoom, stepZoom } from './gantt.js'
import { stepCursor, visibleAgentIndices } from './visible.js'
import './cockpit.css'

// Re-exported from their new home so nothing outside this file has to move (W12 round 2:
// the strip itself is now React Aria's, per §16.3 — see `Tabs.tsx`).
export type { CockpitTab } from './Tabs.js'
export { TABS } from './Tabs.js'

export interface CockpitProps {
  runId: string
  /** The session's enabled control capabilities (§7.2); `null` while unknown. */
  capabilities?: readonly string[] | null
  /** The agent whose transcript is open, when the route carries one (§2.5). */
  selectedAgent?: number | null
  /**
   * W12's interactive inbox rail (§2.4). Replaces the read-only rail this unit renders as
   * §3.7's third column; the column itself exists either way.
   */
  inbox?: ReactNode
  /** Test seam: the `runDetail` slice of the API the store reads through. */
  storeApi?: RunStoreApi
  /** A route-level store shared with an open transcript split, preventing a second SSE. */
  runStore?: RunStoreHandle
  /**
   * Test seam for §13 Q4's on-demand args read. Deliberately NOT part of `storeApi`: the
   * store's job is the polled snapshot, and args must never travel on that path.
   */
  argsFn?: typeof api.runArgs
}

/**
 * Bind one `runStore` to the page. Recreated only when the run or the credential changes —
 * a re-render must never tear down a live stream.
 */
export function useRunPage(runId: string, storeApi?: RunStoreApi, shared?: RunStoreHandle): {
  snapshot: RunSnapshot
  refresh: () => void
} {
  const token = useSyncExternalStore(subscribeToken, getToken, () => null)
  const handle = useMemo(
    () => shared ?? createRunStore({ runId, api: storeApi ?? api, token }),
    [runId, token, storeApi, shared],
  )
  useEffect(() => {
    if (shared) return
    void handle.start()
    return () => handle.stop()
  }, [handle, shared])
  const snapshot = useStore(handle.store)
  const refresh = useCallback(() => { void handle.refresh() }, [handle])
  return { snapshot, refresh }
}

export function Cockpit(props: CockpitProps) {
  const { runId } = props
  // W12's control layer, or `null` when it is not mounted (tests, and any host that renders
  // the cockpit read-only). Every use below is guarded, so this unit's behavior without a
  // provider is exactly what W11 shipped.
  const control = useControl()
  const { snapshot, refresh } = useRunPage(runId, props.storeApi, props.runStore)
  const detail = snapshot.detail
  const runState = snapshot.runState ?? detail?.state ?? null
  // §5.4.2's liveness tiers, ONCE, from the store's authoritative verdict (which can lead
  // `detail.state` by a poll). `useTick` subscribes to a 1 Hz clock only while the run is
  // genuinely live, so a dead run's `now` is the page-open instant — which is exactly why
  // nothing below may build a duration out of it (`honesty.clock` is the only door).
  const live = detail != null && isRunLive(runState)
  const now = useTick(live)
  // The ONE verdict every widget on this screen reads (`honesty.ts`). Derived from the
  // store's authoritative run state rather than from `detail.state`, and provided through
  // context so no tab, row, bar or chip can reach a different answer.
  const honesty: RunHonesty | null = useMemo(
    () => (detail == null ? null : deriveHonesty(detail, { now, state: runState })),
    [detail, now, runState],
  )
  /** A dead run the operator came here to make ONE decision about (§2.4, the stale frame). */
  const stale = detail != null && canResumeState(runState) && runState !== 'completed'

  const [tab, setTab] = useState<CockpitTab>('timeline')
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [grouping, setGrouping] = useState<Grouping>('flat')
  // §2.1 Q4 answers "which agent is burning the budget?" with "the Agents table sorted by
  // cost", so that is where the table OPENS — not somewhere the operator has to click to.
  // The approved comp agrees: its header renders `cost` as the sorted column, descending
  // (docs/frontend/comps/lib/page-cockpit.mjs:330). Absent costs still sort last in both
  // directions (`sortAgents`), so this cannot put unmeasured agents at the top.
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'cost', dir: 'desc' })
  const [logOpen, setLogOpenRaw] = useState(false)
  /** `null` = the operator has not ruled; §3.7's workload default stands (see below). */
  const [inboxChoice, setInboxChoice] = useState<boolean | null>(null)
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [cursor, setCursor] = useState<number | null>(null)
  const [scope, setScope] = useState<number | null>(null)
  const selectedAgent = props.selectedAgent ?? null
  // §3.3's single breakpoint. Below it both rails are drawers and the stale run's resume
  // card is promoted above the tabs — the ONE reorder the comp set makes, and it is scoped
  // to this viewport rather than applied everywhere (review round 1, B1).
  const narrow = useMedia('(max-width: 899px)')

  // §6.4 step 1a. `attemptScopes` carries every attempt's phases/logs/mail; the top-level
  // fields are the CURRENT scope. Selecting an earlier one projects it into every tab.
  const scopes = detail?.attemptScopes ?? []
  const currentScope = Math.max(0, scopes.length - 1)
  const shownScope = scope != null && scopes[scope] ? scope : currentScope
  const view: RunDetail | null = detail == null
    ? null
    : shownScope === currentScope || !scopes[shownScope]
      ? detail
      : {
        ...detail,
        phases: scopes[shownScope]!.phases,
        logs: scopes[shownScope]!.logs,
        logTotal: scopes[shownScope]!.logTotal,
        mail: scopes[shownScope]!.mail,
        mailTotal: scopes[shownScope]!.mailTotal,
      }

  // …and the Timeline is the fourth surface the selector projects into (§6.4 step 1a,
  // amended: attempt-scoped Timeline). An earlier attempt hands the Gantt that scope's
  // ARCHIVED agents — snapshotted by the fold at the resume boundary, before the round-11
  // clear wiped their clocks — plus the attempt's own `[start, end)` window from the
  // lineage. `agents: null` is a snapshot from before archiving existed, and the Timeline
  // renders that as an explicit absence rather than the current attempt's bars under an
  // earlier attempt's label — which is exactly what it did before this wiring.
  const attempt: TimelineAttempt | null = detail != null && shownScope !== currentScope
    ? (() => {
      const located = archivedAttempt(
        detail.attemptSpans ?? [], shownScope, now, detail.createdAt ?? null, honesty,
      )
      // The capability verdict is per attempt, not per run: `run.engine` is overwritten
      // by every resume, so after an upgrade `detail.caps` describes the newest attempt
      // only — rendered under an earlier one it would claim queue waits and progress
      // ticks that attempt's engine could not emit, and suppress the older-engine notice
      // that says so. The archived scope carries its own opening event's engine; `null`
      // there is a recorded fact (no version written → caps honestly unsupported), and
      // only an absent key — an archive from before the field existed — falls back to
      // the run-level caps, the sole verdict available there.
      const scopeEngine = scopes[shownScope]?.engine
      return {
        ordinal: located?.ordinal ?? shownScope + 1,
        agents: scopes[shownScope]?.agents ?? null,
        caps: scopeEngine !== undefined ? deriveCaps({ engine: scopeEngine }) : null,
        window: located && located.endedAt != null
          ? { start: located.startedAt, end: located.endedAt }
          : null,
        // An archived attempt's fate is always a dead state: its terminal event, or
        // `stale` where the next attempt's start is all that closed it.
        state: (located?.state ?? 'stale') as RunState,
      }
    })()
    : null

  // A different run is a different set of agents and a different lineage, so the agent
  // cursor and the selected attempt scope do not carry across one. (The run rail switches
  // runs WITHOUT remounting the cockpit — §2.2 — so nothing else resets them.) Reset during
  // render, keyed on a ref, rather than in an effect that would paint the stale value first.
  const forRun = useRef(runId)
  if (forRun.current !== runId) {
    forRun.current = runId
    if (cursor !== null) setCursor(null)
    if (scope !== null) setScope(null)
    // The inbox's collapse is a ruling about THIS run's queue (§3.7's default is derived
    // from the run's own open work), so it does not carry to the next run either.
    if (inboxChoice !== null) setInboxChoice(null)
  }

  // §3.7's default state for the third column: open when the run has work in it, collapsed
  // to its 44px handle when it does not — and always the operator's own choice once they
  // have made one. Narrow viewports start closed: there the rail is an overlay drawer over
  // the content, and opening one unasked would cover the screen the operator navigated to.
  const inboxOpen = inboxChoice ?? (!narrow && inboxDefaultOpen(detail, honesty))

  const onToggle = useCallback((key: string, open: boolean) => {
    setToggled((current) => ({ ...current, [key]: open }))
  }, [])

  const openAgent = useCallback((index: number) => {
    navigate(href.agent(runId, index))
  }, [runId])

  // §3.6: "focus is moved into panels when they open and restored on close." The opener is
  // remembered here rather than inside the lane, because the lane is unmounted by the time
  // the restore has to happen — and every close path goes through `closeLog`.
  const logOpener = useRef<HTMLElement | null>(null)
  const openLog = useCallback(() => {
    const active = document.activeElement
    logOpener.current = active instanceof HTMLElement && active !== document.body ? active : null
    setLogOpenRaw(true)
  }, [])
  const closeLog = useCallback(() => {
    setLogOpenRaw(false)
    const opener = logOpener.current
    logOpener.current = null
    if (opener?.isConnected) opener.focus()
  }, [])
  const toggleLog = useCallback(() => {
    if (logOpen) closeLog()
    else openLog()
  }, [logOpen, closeLog, openLog])

  // §2.7's `j`/`k` walk the rows the operator can SEE — the active tab's order, under the
  // current sort and the current phase-collapse state (review round 2, M1). The order is
  // recomputed from the same models the tabs render from, so the two cannot disagree.
  const visible = useMemo(() => visibleAgentIndices({
    tab, detail: view, grouping, sort, toggled, selectedAgent, honesty,
  }), [tab, view, grouping, sort, toggled, selectedAgent, honesty])
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  // §2.7 keyboard: `[` `]` switch tabs, `l` toggles the log lane, `j`/`k` move the agent
  // cursor, Enter opens it, `+`/`-` zoom the Gantt. Every one is ignored while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      const key = event.key
      if (key === '[' || key === ']') {
        setTab((current) => {
          const at = TAB_ORDER.indexOf(current)
          const next = (at + (key === ']' ? 1 : TAB_ORDER.length - 1)) % TAB_ORDER.length
          return TAB_ORDER[next]!
        })
        event.preventDefault()
        return
      }
      if (key === 'l') { toggleLog(); event.preventDefault(); return }
      if (key === 'Escape' && logOpen) { closeLog(); event.preventDefault(); return }
      if (key === '+' || key === '=' || key === '-') {
        setZoom((current) => stepZoom(current, key === '-' ? -1 : 1))
        event.preventDefault()
        return
      }
      if (key === 'j' || key === 'k') {
        const order = visibleRef.current
        if (!order.length) return
        setCursor(stepCursor(order, cursorRef.current, key === 'j' ? 1 : -1))
        event.preventDefault()
        return
      }
      if (key === 'Enter' && cursorRef.current != null) {
        openAgent(cursorRef.current)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logOpen, openAgent, toggleLog, closeLog])

  const lastLog: LogView | null = view?.logs?.length ? view.logs[view.logs.length - 1]! : null

  return (
    // The whole screen reads ONE honesty verdict (`honesty.ts`). Provided here, at the top,
    // because parity #58 and #46 are claims about the SCREEN: a header that says the engine
    // is gone and a table that still spins are not two bugs, they are one screen
    // contradicting itself, and the only structural cure is a single source for the rule.
    <RunHonestyContext.Provider value={honesty}>
    <div
      className={`cockpit with-inbox${narrow ? ' narrow' : ''}`}
      data-inbox={props.inbox || inboxOpen ? 'open' : 'collapsed'}
    >
      <div className="col main">
        {snapshot.connection === 'gone' ? (
          <div className="banner" style={{ margin: 12 }} role="alert">
            <Icon name="trash" size={14} />
            This run was deleted while you were watching it.
            <button className="btn" type="button" style={{ marginLeft: 'auto' }}
              onClick={() => navigate(href.home())}
            >
              Back to runs
            </button>
          </div>
        ) : null}

        {snapshot.error && !detail ? (
          <div className="banner" style={{ margin: 12 }} role="alert">
            <Icon name="unknown" size={14} />
            {snapshot.error.status === 404
              ? `No run ${runId} on disk.`
              : `API unreachable — is \`flowition viewer\` running? (${snapshot.error.message})`}
          </div>
        ) : null}

        {detail == null ? (
          <CockpitSkeleton loading={snapshot.loading} />
        ) : (
          <>
            {snapshot.error ? (
              <div className="banner warn" style={{ margin: '8px 16px 0' }} role="status">
                <Icon name="stale" size={14} />
                Showing the last good snapshot — {snapshot.error.message}
              </div>
            ) : null}

            <RunHeader
              detail={detail}
              now={now}
              capabilities={props.capabilities ?? null}
              // Why the set is unknown, when it is — so the header's §7.2 lock chips say
              // `unverified` on a FAILED probe and `checking` only while one is in flight,
              // which is the same distinction every other gated control on the page makes.
              capabilityError={control?.capabilityError ?? null}
              onRefresh={refresh}
              // W12's §7.2 modals, when its layer is mounted. Without it these stay
              // undefined and the header renders the two buttons disabled, exactly as
              // W11 shipped them.
              {...(control ? {
                onCancelRun: () => control.confirmCancelRun(
                  { runId: detail.runId, name: detail.name, state: runState }, refresh,
                ),
                onDelete: () => control.confirmDelete(
                  { runId: detail.runId, name: detail.name, state: runState }, refresh,
                ),
                // `graphDynamic` is what §7.3 requires the resume modal to show, and the
                // snapshot is the only place it exists — so it travels with the ref.
                onResume: () => control.confirmResume(
                  {
                    runId: detail.runId,
                    name: detail.name,
                    state: runState,
                    graphDynamic: detail.graphDynamic ?? null,
                    // The snapshot IS in hand here, so a null is §6.5's null.
                    graphSource: 'snapshot',
                  },
                  refresh,
                ),
              } : {})}
              onToggleLog={toggleLog}
              logOpen={logOpen}
              scope={shownScope}
              onScope={setScope}
              {...(props.argsFn ? { argsFn: props.argsFn } : {})}
            />

            <LastLogLine
              log={lastLog}
              runId={runId}
              laneOpen={logOpen}
              onOpenLane={toggleLog}
            />

            {/* The one place the narrow layout REORDERS rather than reflows: the comps'
                `cockpit-stale-800` annotation 18 promotes this card above the tabs at 800,
                and says in the same breath that the rest of the set deliberately avoids
                reordering. So it is scoped to the breakpoint that ruled on it. */}
            {stale && narrow ? <DeadRunCard detail={detail} honesty={honesty!} /> : null}

            <CockpitTabs tab={tab} onTab={setTab}>
            {detail.agents.length === 0 ? (
              <EmptyAgents detail={detail} live={live} />
            ) : tab === 'timeline' ? (
              <Timeline
                detail={view!} now={now} zoom={zoom} onZoom={setZoom}
                selectedAgent={selectedAgent ?? cursor}
                onOpenAgent={openAgent}
                onCursor={setCursor}
                attempt={attempt}
              />
            ) : tab === 'structure' ? (
              <Structure detail={view!} now={now} selectedAgent={selectedAgent} onOpenAgent={openAgent} />
            ) : (
              <AgentsTab
                detail={view!} now={now}
                grouping={grouping} onGrouping={setGrouping}
                sort={sort} onSort={setSort}
                selectedAgent={selectedAgent}
                cursorAgent={cursor}
                onOpenAgent={openAgent}
                onCursor={setCursor}
                toggled={toggled}
                onToggle={onToggle}
              />
            )}
            </CockpitTabs>

            {/* Below 900px the card is above the tabs; at every other viewport it sits here,
                under the tab it does not belong inside. */}
            {stale && !narrow ? <DeadRunCard detail={detail} honesty={honesty!} /> : null}

            <UnknownEvents count={snapshot.unknownEvents} types={detail.unknownEventTypes} />

            {logOpen ? (
              <LogLane
                runId={runId}
                logs={view!.logs ?? []}
                logTotal={view!.logTotal ?? 0}
                // The stream cursor is the file's end whatever attempt is selected: the
                // events file is one byte space, and the lane walks back through it labelling
                // each record with the attempt its bytes fall in (§6.4 step 1a).
                eventsOffset={detail.offsets?.events ?? 0}
                scope={shownScope}
                scopeCount={Math.max(1, scopes.length)}
                onClose={closeLog}
              />
            ) : null}
          </>
        )}
      </div>
      {props.inbox ? (
        <div className="col inbox">{props.inbox}</div>
      ) : view && control ? (
        // W12's interactive rail, when the control layer is mounted (§7.2's composers).
        // `renderInbox` takes exactly the arguments `InboxRail` takes, so the column, its
        // collapse rules and its 44px handle are the same ones §3.7 approved.
        control.renderInbox({
          detail: view, now, narrow, open: inboxOpen,
          onOpen: () => setInboxChoice(true),
          onClose: () => setInboxChoice(false),
          onChanged: refresh,
        })
      ) : view ? (
        <InboxRail
          detail={view} now={now} narrow={narrow}
          open={inboxOpen}
          onOpen={() => setInboxChoice(true)}
          onClose={() => setInboxChoice(false)}
        />
      ) : null}
    </div>
    </RunHonestyContext.Provider>
  )
}

/** Parity #61: skeleton header + skeleton lanes while the snapshot is in flight. */
export function CockpitSkeleton({ loading }: { loading: boolean }) {
  return (
    <div className="ck-skel" aria-busy={loading} aria-label="Loading run">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="skel" style={{ width: 14, height: 14, borderRadius: 999 }} />
        <span className="skel" style={{ width: 210, height: 14 }} />
      </div>
      <div className="skel" style={{ width: '100%', height: 44 }} />
      {[70, 52, 84, 40].map((width, i) => (
        <div className="row" key={i}>
          <span className="skel" style={{ width: 88 }} />
          <span className="skel" style={{ width: `${width}%`, height: 12 }} />
        </div>
      ))}
    </div>
  )
}

/** Parity #60. The copy differs by liveness: a terminal run will never start one. */
function EmptyAgents({ detail, live }: { detail: RunDetail; live: boolean }) {
  const pending = Object.values(detail.caps ?? {}).every((cap) => cap === 'pending')
  return (
    <div className="empty" style={{ padding: '48px 24px' }}>
      <Icon name="gantt" size={20} className="dim" />
      <p style={{ fontSize: 13 }}>
        {pending
          ? 'This run has not written its first event yet.'
          : live
            ? <>No agents yet — the workflow hasn&apos;t called <span className="mono">agent()</span>.</>
            : 'This run started no agents.'}
      </p>
    </div>
  )
}

/**
 * The one decision an operator opens a dead run for (§2.4, the comps' stale frame). The
 * copy states what is known and refuses to date the death — see `RunHeader`'s note.
 *
 * **Its glyph and its copy read the authoritative state (round 11).** This card is the whole
 * screen's account of why the run stopped; deriving it from `detail.state` while the
 * screen-wide verdict said something else made the card contradict the header it sits under.
 * `honesty.state` is that verdict and `honesty.quiescent` is §5.4.2's "the engine simply
 * went" tier — which is the question the first two sentences actually ask, so they ask it
 * rather than pattern-matching one state string.
 *
 * Exported for `honesty.test.tsx`: through `runStore` the two states cannot diverge (it
 * composes `detail.state` FROM `runState`), so the divergence the rule exists for can only
 * be staged by rendering the card against a verdict of its own.
 */
export function DeadRunCard({ detail, honesty }: { detail: RunDetail; honesty: RunHonesty }) {
  // The screen's own count (round 6): a quiescent run whose post-pass never ran has orphans
  // the raw `displayState` cannot see, and this card exists to name exactly those.
  const orphaned = honesty.orphanedCount
  const finished = detail.agents.filter((a) => a.state === 'done' || a.state === 'cached').length
  const state = honesty.state ?? 'unknown'
  const quiescent = honesty.quiescent
  return (
    <div className="resume-card">
      <div className="rc-top">
        <StatusGlyph state={state} />
        <b>
          {quiescent
            ? 'This run\'s engine died mid-flight.'
            : state === 'failed'
              ? 'This run failed.'
              : 'This run was interrupted.'}
        </b>
      </div>
      <p>
        {quiescent
          ? 'It wrote no terminal event, so there is no time of death to report.'
          : 'It wrote a terminal event, so its own record of what happened is complete.'}
        {detail.liveDetail ? ` ${detail.liveDetail}.` : ''}
        {orphaned > 0 ? (
          <>
            {' '}{orphaned} agent{orphaned === 1 ? ' was' : 's were'} left unfinished; they render{' '}
            <b>orphaned</b> — the run&apos;s fate, dimmed — never a live spinner.
          </>
        ) : null}
        {finished > 0 ? (
          <> Resuming replays the {finished} that completed from their keys and re-runs the rest.</>
        ) : null}
      </p>
      <div className="rc-actions">
        <span className="dim micro mono">Resume is in the header actions above.</span>
      </div>
    </div>
  )
}

/** §6.5: unknown event types are counted and surfaced, never silently dropped. */
function UnknownEvents(
  { count, types }: { count: number; types?: Record<string, number> | undefined },
) {
  if (!count) return null
  const names = Object.keys(types ?? {}).slice(0, 4).join(', ')
  return (
    <div className="rawgrp" style={{ margin: '8px 16px' }} role="status">
      <Icon name="unknown" size={12} />
      <span>
        {count} unrecognized event{count === 1 ? '' : 's'} — newer engine?
        {names ? ` (${names})` : ''}
      </span>
    </div>
  )
}
