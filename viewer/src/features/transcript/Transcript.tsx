/**
 * W10 transcript route. One runStore owns the multiplexed events/journal/agent SSE and
 * forwards agent frames into one bounded transcriptStore per open pane.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react'

import { api, getToken, subscribeToken } from '../../api/client.js'
import type { AgentView, JsonlPage, RunDetail, SearchResults } from '../../api/types.js'
import { fmtCost, fmtDuration, fmtTokens } from '../../format/fmt.js'
import { createRunStore, type RunStoreApi } from '../../state/runStore.js'
import {
  createTranscriptStore,
  type TranscriptStoreHandle,
} from '../../state/transcriptStore.js'
import { useStore } from '../../state/stores.js'
import { useMedia, usePersistentState } from '../../app/hooks.js'
import { href, navigate } from '../../app/router.js'
import { claimDestinationFocus } from '../../app/destination.js'
import { Cockpit } from '../cockpit/Cockpit.js'
import { useControl } from '../control/ControlProvider.js'
import { useActionFloorClaim } from '../control/actionFloor.js'
import { Icon } from '../../ui/Icon.js'
import { AdapterBadge, StatusChip, StatusGlyph } from '../../ui/Status.js'
import { groupTimeline, retainedManualIds } from './grouping.js'
import { LiveFrontier } from './LiveFrontier.js'
import { SearchBar, type SearchNavigation } from './SearchBar.js'
import { toItems } from './toItems.js'
import type { TimelineItem } from './types.js'
import { VirtualTimeline } from './VirtualTimeline.js'
import './transcript.css'

export interface TranscriptApi extends RunStoreApi {
  agentPage(
    runId: string,
    index: number,
    options?: { from?: number | 'tail'; maxBytes?: number; signal?: AbortSignal },
  ): Promise<JsonlPage>
  search(
    runId: string,
    q: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<SearchResults>
}

export interface TranscriptRouteProps {
  runId: string
  agentIndex: number
  compare?: number | null
  capabilities?: readonly string[] | null
  dataApi?: TranscriptApi
}

interface Resources {
  run: ReturnType<typeof createRunStore>
  panes: Map<number, TranscriptStoreHandle>
}

export const TRANSCRIPT_SPLIT_WIDTH_KEY = 'flowition.transcript.split.width'
export const TRANSCRIPT_SPLIT_MIN = 360
export const TRANSCRIPT_SPLIT_MAX = 760
export const TRANSCRIPT_SPLIT_DEFAULT = 560

function createResources(
  runId: string,
  indices: number[],
  dataApi: TranscriptApi,
  token: string | null,
): Resources {
  const panes = new Map<number, TranscriptStoreHandle>()
  for (const index of indices) {
    panes.set(index, createTranscriptStore({
      runId,
      index,
      fetchPage: (id, n, options) => dataApi.agentPage(id, n, options),
    }))
  }
  const run = createRunStore({
    runId,
    api: dataApi,
    agents: indices,
    token,
    onAgentRecords(index, records) { panes.get(index)?.append(records) },
    onAgentReset(index) { void panes.get(index)?.reset() },
  })
  return { run, panes }
}

export function TranscriptRoute({
  runId,
  agentIndex,
  compare = null,
  capabilities = null,
  dataApi = api,
}: TranscriptRouteProps) {
  const token = useSyncExternalStore(subscribeToken, getToken, () => null)
  const indices = useMemo(
    () => compare != null && compare !== agentIndex ? [agentIndex, compare] : [agentIndex],
    [agentIndex, compare],
  )
  const key = indices.join(',')
  const resources = useMemo(
    () => createResources(runId, indices, dataApi, token),
    // `key` makes the array's value, rather than its identity, the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, key, dataApi, token],
  )
  const snapshot = useStore(resources.run.store)
  const [pinnedStep, setPinnedStep] = useState<number | null>(null)
  const narrow = useMedia('(max-width: 899px)')
  const [panelWidth, setPanelWidth] = usePersistentState(
    TRANSCRIPT_SPLIT_WIDTH_KEY,
    TRANSCRIPT_SPLIT_DEFAULT,
  )
  const splitRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    for (const pane of resources.panes.values()) void pane.loadTail()
    void resources.run.start()
    return () => {
      resources.run.stop()
      for (const pane of resources.panes.values()) pane.stop()
    }
  }, [resources])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isTyping(event.target)) {
        navigate(href.run(runId))
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runId])

  const detail = snapshot.detail
  const runLive = snapshot.runState === 'running' || snapshot.runState === 'starting'
  const compared = indices.length === 2

  let transcript: ReactNode
  if (snapshot.loading && !detail) {
    transcript = <div className="transcript-loading"><div className="skel" /><div className="skel" /></div>
  } else if (snapshot.error && !detail) {
    transcript = <div className="banner" role="alert"><Icon name="failed" />{snapshot.error.message}</div>
  } else if (!detail) {
    transcript = <div className="empty"><h3>Run details are not available yet</h3></div>
  } else transcript = (
    <section className={`transcript-route${compared ? ' comparing' : ''}`}>
      {compared ? (
        <div className="compare-bar">
          <span className="lbl">comparing</span>
          <CompareWho detail={detail} index={indices[0]!} />
          <span className="dim">vs</span>
          <CompareWho detail={detail} index={indices[1]!} />
          <button className="btn sm ghost compare-end" type="button" onClick={() => navigate(href.agent(runId, agentIndex))}>
            <Icon name="close" size={12} />End comparison
          </button>
        </div>
      ) : null}
      {compared ? (
        <div className="compare-pin">
          <Icon name="drag" size={12} />
          {pinnedStep == null
            ? 'Pin a step in either panel to align both transcripts'
            : <>pinned to <b>step {pinnedStep + 1}</b> in both panels</>}
          {pinnedStep != null ? (
            <button className="btn sm ghost" type="button" onClick={() => setPinnedStep(null)}>Unpin</button>
          ) : null}
        </div>
      ) : null}
      <div className="compare-panes" data-layout={compared ? 'side-by-side' : 'single'}>
        {indices.map((index) => (
          <TranscriptPane
            key={index}
            runId={runId}
            detail={detail}
            index={index}
            transcript={resources.panes.get(index)!}
            runLive={runLive}
            search={dataApi.search}
            compared={compared}
            pinnedStep={pinnedStep}
            onPinnedStep={compared ? setPinnedStep : undefined}
          />
        ))}
      </div>
    </section>
  )

  if (narrow) return transcript
  const width = Math.min(TRANSCRIPT_SPLIT_MAX, Math.max(TRANSCRIPT_SPLIT_MIN, panelWidth))
  return (
    <div
      ref={splitRef}
      className="agent-route-split"
      style={{ gridTemplateColumns: `minmax(0, 1fr) 7px minmax(${TRANSCRIPT_SPLIT_MIN}px, ${width}px)` }}
    >
      <div className="agent-cockpit">
        <Cockpit
          runId={runId}
          capabilities={capabilities}
          selectedAgent={agentIndex}
          runStore={resources.run}
        />
      </div>
      <TranscriptSplitGrip
        width={width}
        root={splitRef}
        onWidth={(next) => setPanelWidth(Math.min(
          TRANSCRIPT_SPLIT_MAX,
          Math.max(TRANSCRIPT_SPLIT_MIN, next),
        ))}
      />
      <div className="agent-transcript">{transcript}</div>
    </div>
  )
}

function TranscriptSplitGrip(
  { width, root, onWidth }: {
    width: number
    root: RefObject<HTMLDivElement | null>
    onWidth(width: number): void
  },
) {
  const dragging = useRef(false)
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current) return
      const right = root.current?.getBoundingClientRect().right ?? window.innerWidth
      onWidth(Math.round(right - event.clientX))
    }
    const up = () => { dragging.current = false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [onWidth, root])
  return (
    <div
      className="transcript-split-grip"
      role="separator"
      aria-label="Resize transcript panel"
      aria-orientation="vertical"
      aria-valuemin={TRANSCRIPT_SPLIT_MIN}
      aria-valuemax={TRANSCRIPT_SPLIT_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        dragging.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') onWidth(width + 24)
        else if (event.key === 'ArrowRight') onWidth(width - 24)
        else if (event.key === 'Home') onWidth(TRANSCRIPT_SPLIT_MIN)
        else if (event.key === 'End') onWidth(TRANSCRIPT_SPLIT_MAX)
        else return
        event.preventDefault()
      }}
    />
  )
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

function CompareWho({ detail, index }: { detail: RunDetail; index: number }) {
  const agent = detail.agents.find((entry) => entry.index === index)
  return agent ? (
    <span className="compare-who">
      <StatusGlyph state={agent.displayState} orphaned={agent.displayState === 'orphaned'} />
      <b>{agent.label ?? `agent ${index}`}</b><span className="aidx">agent {index}</span>
    </span>
  ) : <span className="compare-who">agent {index}</span>
}

function TranscriptPane(
  { runId, detail, index, transcript, runLive, search, compared, pinnedStep, onPinnedStep }:
  {
    runId: string
    detail: RunDetail
    index: number
    transcript: TranscriptStoreHandle
    runLive: boolean
    search: TranscriptApi['search']
    compared: boolean
    pinnedStep: number | null
    onPinnedStep?(step: number): void
  },
) {
  const snapshot = useStore(transcript.store)
  const control = useControl()
  const agent = detail.agents.find((entry) => entry.index === index) ?? null
  // §2.5's bottom-docked composer is the control the shipped resume toast landed on top of.
  // It publishes its own height so `.ctl-toasts` can float ABOVE it instead (actionFloor.ts).
  const footRef = useRef<HTMLElement | null>(null)
  useActionFloorClaim(footRef)
  // …and the composer is not the only thing down there: the detached "jump to latest" sits
  // immediately above it, inside the same band. Both claim; the floor is the taller.
  const detachedRef = useRef<HTMLButtonElement | null>(null)
  useActionFloorClaim(detachedRef)
  const projection = useMemo(
    () => toItems(snapshot.items, { initialAttempt: Math.max(1, agent?.attempts ?? 1) }),
    [snapshot.items, agent?.attempts],
  )
  const attemptNumbers = useMemo(
    () => [...new Set(projection.attempts.map((attempt) => attempt.n))].sort((a, b) => a - b),
    [projection.attempts],
  )
  const lastAttempt = attemptNumbers.at(-1) ?? 1
  const [selectedAttempt, setSelectedAttempt] = useState(lastAttempt)
  const selectedRef = useRef(lastAttempt)
  const previousLast = useRef(lastAttempt)
  useEffect(() => {
    const prior = previousLast.current
    if (prior !== lastAttempt && selectedRef.current === prior) {
      selectedRef.current = lastAttempt
      setSelectedAttempt(lastAttempt)
    }
    previousLast.current = lastAttempt
  }, [lastAttempt])
  const chooseAttempt = (attempt: number) => {
    selectedRef.current = attempt
    setSelectedAttempt(attempt)
  }

  const visibleItems = useMemo(
    () => orderAttemptItems(projection.items.filter((item) => item.attempt === selectedAttempt)),
    [projection.items, selectedAttempt],
  )
  // §3.6's frontier is the LIVE one, and "live" is a property of the run — not of what the
  // operator happens to be reading. TWO things make what the operator is reading a narrower
  // thing than the run, and the frontier has to be independent of BOTH:
  //
  //  1. **The attempt selection.** `visibleItems` follows it, so deriving the announcement
  //     from it means an operator who opens attempt 1 while attempt 3 is running is told,
  //     once, what attempt 1 was doing and then never again: the current attempt's records
  //     land in `projection.items` but never in `visibleItems`, so the candidate stops
  //     changing and the region goes silent on the only activity there is. Hence
  //     `lastAttempt`, not `selectedAttempt`.
  //  2. **The retained byte window.** Paging up detaches the tail (§9.3) and the store then
  //     drops every subsequent live record from `snapshot.items` on purpose — they no longer
  //     abut the retained span. `projection.items` is built from `snapshot.items`, so a
  //     frontier taken from it FREEZES at the moment of detachment and the region goes on
  //     announcing "running Bash" about a tool that finished minutes ago. The store keeps
  //     the newest live record out of band for exactly this (`snapshot.frontier`); it is
  //     projected on its own here and wins whenever it is newer than anything in the window.
  //
  // The sighted "Working…/Thinking…" indicator below reads the same item for the same reason:
  // §3.6 makes the region that channel's equivalent, and an equivalent that disagrees with
  // the thing it replaces is not one.
  const windowLatest = useMemo(
    () => orderAttemptItems(
      projection.items.filter((item) => item.attempt === lastAttempt),
    ).at(-1) ?? null,
    [projection.items, lastAttempt],
  )
  // One record, projected alone. `toItems` is a fold over a contiguous run of records, and a
  // single out-of-window record has no predecessors to pair a tool result against — so this
  // deliberately claims nothing about pairing or attempt boundaries, only "what kind of thing
  // just happened", which is all `frontierAnnouncement` reads. The attempt hint is the newest
  // one the window knows about, so an announcement never regresses to attempt 1's number.
  const frontierLatest = useMemo(() => {
    const record = snapshot.frontier
    if (!record) return null
    return toItems([record], { initialAttempt: lastAttempt }).items.at(-1) ?? null
  }, [snapshot.frontier, lastAttempt])
  const liveLatest = useMemo(() => {
    if (!frontierLatest) return windowLatest
    if (!windowLatest) return frontierLatest
    // The window's own high-water offset, not `windowLatest.o`: `orderAttemptItems` sorts
    // prompts to the front, so the last ITEM is not necessarily the last BYTE.
    const held = snapshot.items.at(-1)?.o ?? -Infinity
    return frontierLatest.o > held ? frontierLatest : windowLatest
  }, [frontierLatest, windowLatest, snapshot.items])
  const units = useMemo(() => groupTimeline(visibleItems), [visibleItems])
  const [manual, setManual] = useState<Record<string, boolean>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTarget, setSearchTarget] = useState<{ offset: number; index: number; itemId: string } | null>(null)
  const retainedManual = useMemo(() => retainedManualIds(projection.items), [projection.items])

  // §2.5.1 #93: eviction clears overrides for rows no longer in the retained 8 MiB window.
  useEffect(() => {
    setManual((current) => {
      let changed = false
      const next: Record<string, boolean> = {}
      for (const [id, value] of Object.entries(current)) {
        if (retainedManual.has(id)) next[id] = value
        else changed = true
      }
      return changed ? next : current
    })
  }, [retainedManual])

  const navigateSearch = useCallback((offset: number): SearchNavigation => {
    const first = snapshot.items[0]?.o
    const last = snapshot.items.at(-1)?.o
    if (first == null || last == null) return 'empty'
    if (offset < first) return 'before-window'
    if (offset > last) return 'after-window'

    let previous = -Infinity
    let targetId: string | null = null
    let targetAttempt: number | null = null
    for (const item of projection.items) {
      if (offset > previous && offset <= item.o) {
        targetId = item.id
        targetAttempt = item.attempt
        break
      }
      previous = Math.max(previous, item.o)
    }
    if (targetId == null || targetAttempt !== selectedAttempt) return 'other-attempt'
    const index = units.findIndex((unit) => (
      unit.kind === 'row'
        ? unit.item.id === targetId
        : unit.items.some((item) => item.id === targetId)
    ))
    if (index < 0) return 'other-attempt'
    setSearchTarget({ offset, index, itemId: targetId })
    return 'loaded'
  }, [projection.items, selectedAttempt, snapshot.items, units])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && !isTyping(event.target)) {
        setSearchOpen(true)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!agent) {
    return <div className="tp"><div className="empty"><h3>Agent {index} is not in this run</h3></div></div>
  }
  const live = runLive && agent.state === 'running' && agent.displayState !== 'orphaned'
  const steer = control?.renderSteer({ runId, detail, agent, runLive })
  const failure = agent.state === 'failed' && agent.error
    ? { message: agent.error, code: agent.errorCode, retryable: agent.retryable }
    : null

  return (
    <article className="tp" aria-label={`Transcript for ${agent.label ?? `agent ${index}`}`}>
      {/* §3.6's screen-reader clause. Mounted unconditionally and ALWAYS FIRST in the pane:
          a live region has to already be in the document when its content changes, so one
          that appears with its first message is one assistive tech may never speak. The
          sighted operator's equivalents — the spinner, the "Working…" indicator, the
          streaming cards — are all below; this is the same information for someone who has
          none of them, throttled to one sentence per 5 s and never the raw stream. */}
      <LiveFrontier agent={agent} live={live} latest={liveLatest} />
      <TranscriptHeader
        runId={runId}
        agent={agent}
        compared={compared}
        searchOpen={searchOpen}
        onSearch={() => setSearchOpen((open) => !open)}
        detail={detail}
      />
      <SearchBar
        runId={runId}
        agent={index}
        open={searchOpen}
        search={search}
        onClose={() => setSearchOpen(false)}
        onMatch={navigateSearch}
      />
      {attemptNumbers.length > 1 ? (
        <AttemptBar
          attempts={attemptNumbers}
          selected={selectedAttempt}
          approximate={projection.attempts.find((attempt) => attempt.n === selectedAttempt)?.approximate ?? false}
          agent={agent}
          onSelect={chooseAttempt}
        />
      ) : null}
      {snapshot.loading && !snapshot.records ? <div className="transcript-loading"><div className="skel" /></div> : null}
      {snapshot.missing ? <div className="empty"><h3>This agent has not started writing yet</h3></div> : null}
      {snapshot.error ? <div className="banner" role="alert">{snapshot.error.message}</div> : null}
      {!snapshot.loading && !snapshot.missing && !units.length
        ? <div className="empty"><h3>No transcript records in this attempt</h3></div>
        : null}
      {units.length || failure ? (
        <VirtualTimeline
          units={units}
          live={live}
          oldMayBeTruncated={detail.caps.attemptMarkers === 'unsupported'}
          manual={manual}
          onManual={(id, expanded) => setManual((current) => ({ ...current, [id]: expanded }))}
          onLoadOlder={snapshot.atStart || snapshot.loadingOlder ? undefined : () => { void transcript.loadOlder() }}
          searchTarget={searchTarget}
          pinnedStep={pinnedStep}
          onPinnedStep={onPinnedStep}
          failure={failure}
        />
      ) : null}
      {/* The detached twin of `.jump-tail`, and in the same exclusion zone: it sits directly
          above the composer, so it claims the action floor too (actionFloor.ts). */}
      {snapshot.tailDetached ? (
        <button
          ref={detachedRef} type="button" className="btn jump-detached"
          onClick={() => { void transcript.loadTail() }}
        >
          Jump to latest — live tail is outside this window
        </button>
      ) : null}
      {live || steer ? (
        <footer className="tp-foot" ref={footRef}>
          {live ? (
            <div className="working">
              <Icon name="running" size={12} spin />
              {liveLatest?.kind === 'reasoning' ? 'Thinking…' : 'Working…'}
            </div>
          ) : null}
          {/* §2.5's steer composer + per-agent Cancel, from W12's control layer when it is
              mounted (§7.2). Rendered for a NON-live agent too: §7.2 requires the control to
              be visible and disabled-with-a-reason rather than absent. */}
          {steer}
        </footer>
      ) : null}
    </article>
  )
}

function orderAttemptItems(items: TimelineItem[]): TimelineItem[] {
  const prompts = items.filter((item) => item.kind === 'prompt')
  const rest = items.filter((item) => item.kind !== 'prompt' && item.kind !== 'attempt')
  return [...prompts, ...rest]
}

function TranscriptHeader(
  { runId, agent, compared, searchOpen, onSearch, detail }:
  {
    runId: string
    agent: AgentView
    compared: boolean
    searchOpen: boolean
    onSearch(): void
    detail: RunDetail
  },
) {
  const usage = lifetimeUsage(agent)
  // A ⌘K jump to this agent (§2.7) recorded where the operator asked to go and could not
  // focus it — the palette was still up and this pane did not exist. It is claimed here, on
  // the commit that first renders the pane's own heading (§3.6, `app/destination.ts`).
  useEffect(() => { claimDestinationFocus() })
  return (
    <header className="tp-head">
      <div className="r1">
        <StatusGlyph state={agent.displayState} orphaned={agent.displayState === 'orphaned'} />
        <h2 tabIndex={-1} data-destination="agent" data-run={runId} data-agent={agent.index}>
          {agent.label ?? `agent ${agent.index}`}
        </h2>
        <span className="aidx">agent {agent.index}</span>
        <StatusChip state={agent.displayState} orphaned={agent.displayState === 'orphaned'} />
        <span className="right">
          <button type="button" className="btn sm ghost" aria-pressed={searchOpen} onClick={onSearch}>
            <Icon name="search" size={12} />In transcript
          </button>
          {!compared && detail.agents.length > 1 ? (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                const other = detail.agents.find((entry) => entry.index !== agent.index)
                if (other) navigate(`${href.agent(runId, agent.index)}?a=${other.index}`)
              }}
            >
              <Icon name="columns" size={12} />Compare
            </button>
          ) : null}
          <button className="icb" type="button" aria-label="Close transcript panel" onClick={() => navigate(href.run(runId))}>
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      <div className="tp-facts">
        <span><AdapterBadge name={agent.adapter} /> {agent.adapter}{agent.model ? ` · ${agent.model}` : ''}{agent.effort ? ` · ${agent.effort}` : ''}</span>
        {usage ? <span><b>lifetime</b> {fmtTokens(usage.input)} in / {fmtTokens(usage.output)} out</span> : null}
        {agent.usage ? <span><b>cost</b> {fmtCost(agent.usage.cost)}</span> : null}
        {agent.durationMs != null ? <span><b>duration</b> {fmtDuration(agent.durationMs)}</span> : null}
        {agent.sessionId ? (
          <span>
            <button className="rid" type="button" title="provider conversation handle" onClick={() => { void navigator.clipboard?.writeText(agent.sessionId!) }}>
              {shortSession(agent.sessionId)} <Icon name="copy" size={12} />
            </button>
          </span>
        ) : null}
      </div>
    </header>
  )
}

function lifetimeUsage(agent: AgentView): { input: number; output: number } | null {
  if (!agent.usage && !agent.cumTokens && !agent.liveTokens) return null
  return {
    input: Math.max(agent.usage?.input ?? 0, agent.cumTokens?.input ?? 0, agent.liveTokens?.input ?? 0),
    output: Math.max(agent.usage?.output ?? 0, agent.cumTokens?.output ?? 0, agent.liveTokens?.output ?? 0),
  }
}

function shortSession(value: string) {
  return value.length <= 20 ? value : `${value.slice(0, 12)}…${value.slice(-5)}`
}

function AttemptBar(
  { attempts, selected, approximate, agent, onSelect }:
  {
    attempts: number[]
    selected: number
    approximate: boolean
    agent: AgentView
    onSelect(attempt: number): void
  },
) {
  const isLast = selected === attempts.at(-1)
  return (
    <div className="attempt-bar">
      <span className="lbl">attempt</span>
      <span className="attempt-steps">
        {attempts.map((attempt) => (
          <button type="button" key={attempt} aria-pressed={selected === attempt} onClick={() => onSelect(attempt)}>
            {attempt}
          </button>
        ))}
      </span>
      <span className="lt">
        {attempts.indexOf(selected) + 1} of {attempts.length}
        {approximate ? ' · approximate old-run boundary' : ''}
        {isLast && agent.attemptUsage
          ? ` · this attempt ${fmtTokens(agent.attemptUsage.output)} out · ${fmtCost(agent.attemptUsage.cost)}`
          : !isLast ? ' · this attempt metrics are not exposed by this viewer API' : ''}
        {agent.usage ? ` · lifetime ${fmtTokens(agent.usage.output)} out · ${fmtCost(agent.usage.cost)}` : ''}
      </span>
    </div>
  )
}
