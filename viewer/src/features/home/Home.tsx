// Home (`#/`) — DESIGN §2.3.
//
// "Your work queue, not a list": the attention strip on top, the run table below. All
// three not-happy-path states are first-class here — the loading skeleton, the
// API-unreachable banner that names the command (parity #40), and the zero-runs card
// carrying the quick-start snippet (a teaching card, never a bare shrug).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api } from '../../api/client.js'
import type { RunDetail, RunSummary, Session } from '../../api/types.js'
import { Icon } from '../../ui/Icon.js'
import { href, navigate, routeRunId } from '../../app/router.js'
import { claimLandingFocus } from '../../app/landing.js'
import {
  RUNS_LIMIT_DEFAULT, RUNS_LIMIT_MAX,
  useDebounced, usePagedRuns, usePoll, useRoute, useTick,
} from '../../app/hooks.js'
import { isTypingTarget } from '../../theme/theme.js'
import { useControl } from '../control/ControlProvider.js'
import { AttentionStrip } from './AttentionStrip.js'
import { RunTable } from './RunTable.js'
import './home.css'

/**
 * The states an unanswered `ask()` can live in.
 *
 * `openQuestions` is forced to 0 by the server for any settled or stale run
 * (src/viewer/summaries.js:302 — `dead` short-circuits the question count), so
 * "blocked" ⊆ these four states. That makes the client-side blocked predicate cheap AND
 * exhaustive: scan this narrow, always-small slice to exhaustion and every blocked run
 * on disk is in hand — no partial page, no silent omission.
 */
export const ACTIVE_STATES = 'running,starting,corrupt-result,unknown'

/**
 * §2.3's filter chips. `blocked` is NOT a RunState: §5.4.2's `state` parameter accepts
 * `deriveRunState` names only and rejects anything else. So the blocked chip sends the
 * ACTIVE_STATES filter (which no blocked run can fall outside of) and applies
 * `openQuestions > 0` on the client — over a scan of EVERY matching page, not one page.
 * Flagged as a spec gap with this unit — a server-side blocked filter would need W6.
 */
const CHIPS = [
  { key: 'running', label: 'running', glyph: 'running', serverState: 'running,starting', scan: false },
  { key: 'blocked', label: 'blocked', glyph: 'blocked', serverState: ACTIVE_STATES, scan: true },
  { key: 'failed', label: 'failed', glyph: 'failed', serverState: 'failed', scan: false },
  { key: 'completed', label: 'completed', glyph: 'done', serverState: 'completed', scan: false },
  { key: 'stale', label: 'stale', glyph: 'stale', serverState: 'stale', scan: false },
] as const
type ChipKey = typeof CHIPS[number]['key']

const isBlocked = (r: RunSummary) => r.openQuestions > 0

/** How many cards of each kind the strip shows before it hands off to a filter chip. */
const ASK_CARDS = 3
const STALE_CARDS = 2
const LIVE_CARDS = 2

export interface HomeProps {
  /** Test seams. Production passes nothing. */
  loadRuns?: typeof api.runs
  loadDetail?: typeof api.runDetail
  loadSession?: typeof api.session
  answerFn?: typeof api.answer
  resumeFn?: typeof api.resume
  virtualize?: boolean
}

export function Home(props: HomeProps) {
  const {
    loadRuns = api.runs, loadDetail = api.runDetail, loadSession = api.session,
  } = props
  const route = useRoute()
  const activeRunId = routeRunId(route)

  const [chip, setChip] = useState<ChipKey | null>(null)
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query)
  const [cursorIndex, setCursorIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  /** Home's own subtree — the boundary its §2.7 selection keys apply within. */
  const rootRef = useRef<HTMLDivElement>(null)

  const spec = chip ? CHIPS.find((c) => c.key === chip)! : null
  const serverState = spec?.serverState ?? null
  const wholeQuery = spec?.scan ?? false

  // The table: page 1, then one page per "Load more", each by cursor (§5.4.2). The
  // blocked chip is the exception — its predicate is client-side, so its query must be
  // scanned to exhaustion or the filter would answer over a partial page.
  const list = usePagedRuns(
    loadRuns,
    {
      state: serverState,
      q: debounced || null,
      limit: wholeQuery ? RUNS_LIMIT_MAX : RUNS_LIMIT_DEFAULT,
    },
    { intervalMs: 2000, scan: wholeQuery },
  )

  // The attention strip is NOT a view of the table's first page. It is two purpose-built
  // scans, each exhaustive over a slice bounded by how many runs can be in that state at
  // once: the active states (which is where every blocked and every running run lives)
  // and the stale states. This is what makes "nothing that needs you is missing" true.
  const active = usePagedRuns(loadRuns, { state: ACTIVE_STATES, limit: RUNS_LIMIT_MAX }, {
    intervalMs: 2000, scan: true,
  })
  const staleScan = usePagedRuns(loadRuns, { state: 'stale', limit: RUNS_LIMIT_MAX }, {
    intervalMs: 10_000, scan: true,
  })

  /**
   * The §7.2 capability bootstrap — and the fourth request this screen depends on.
   *
   * It is a ONE-SHOT (`intervalMs: 0`): capabilities change when the operator restarts the
   * viewer with different `--control` flags, not on a 2 s cadence. It is also the source of
   * the `$FLOWITION_HOME` path in the header, which is why it is still made here even when
   * the shell has already made one.
   *
   * **The app has ONE capability state, and it is the shell's** (round 6, B1). When W12's
   * control layer is mounted — which `app/App.tsx` always does — the strip reads the same
   * normalized tri-state the top bar's chip, the cockpit and the palette read, so Home
   * cannot enable a control the rest of the app has locked (or the reverse). Home's own
   * probe remains the fallback for the standalone renders (its tests, the comp harness),
   * where there is no shell to normalize anything.
   *
   * Either way the value is TRI-STATE and the gate FAILS CLOSED: `[]` is an answered
   * "nothing granted" (read-only), `null` is "no answer yet" (checking, or failed), and
   * both leave every mutation on this screen disabled-with-an-explanation per §7.2.
   */
  const control = useControl()
  const session = usePoll<Session>((signal) => loadSession(signal), { intervalMs: 0 })
  // §6.5: a payload from another engine may not carry `control` at all. A session that
  // answered without one is a viewer that granted nothing — an answer, so `[]`, not `null`.
  const probedCapabilities = session.data
    ? (Array.isArray(session.data.control) ? session.data.control : [])
    : null
  const capabilities = control ? control.capabilities : probedCapabilities
  const capabilityError = control ? control.capabilityError : (session.error?.message ?? null)

  const runs = useMemo(
    () => (chip === 'blocked' ? list.runs.filter(isBlocked) : list.runs),
    [list.runs, chip],
  )

  // A run whose state changes while a poll is in flight can freeze the clock; ticking
  // only while something is live keeps a settled Home completely still (parity #46). The
  // active scan — not the visible page — is the honest source for "is anything live".
  const runningRuns = useMemo(() => active.runs.filter((r) => r.state === 'running'), [active.runs])
  const anyLive = active.runs.some((r) => r.state === 'running' || r.state === 'starting')
  const now = useTick(anyLive)

  // Every state filter is re-applied client-side: a server that ignored the parameter (or
  // an older one that never had it) must not be able to put a completed run in the strip.
  const blockedAll = useMemo(() => active.runs.filter(isBlocked), [active.runs])
  const staleAll = useMemo(
    () => staleScan.runs.filter((r) => r.state === 'stale'),
    [staleScan.runs],
  )
  // A blocked run is also a running run. It gets ONE card — the one carrying the action
  // that unblocks it — never two rows of the same run competing in the same strip.
  const tickerRuns = useMemo(() => runningRuns.filter((r) => !isBlocked(r)), [runningRuns])
  const blockedRuns = useMemo(() => blockedAll.slice(0, ASK_CARDS), [blockedAll])
  const staleRuns = useMemo(() => staleAll.slice(0, STALE_CARDS), [staleAll])
  const liveRuns = useMemo(() => tickerRuns.slice(0, LIVE_CARDS), [tickerRuns])
  // Cards are capped; the OVERFLOW IS NEVER SILENT — each kind hands the remainder to its
  // filter chip by name and count (the review's "silently omitted" finding).
  const more = {
    blocked: blockedAll.length - blockedRuns.length,
    stale: staleAll.length - staleRuns.length,
    live: tickerRuns.length - liveRuns.length,
  }

  // §2.3 wants the QUESTION TEXT inline, which lives in RunDetail, not in the listing.
  // One detail fetch per rendered ask card is the whole cost.
  //
  // `detailNonce` is the answer's own invalidation. A run with TWO open questions is still
  // blocked after the first answer and keeps its runId, so a reload of the SUMMARIES alone
  // leaves the card pinned to the qid that was just answered — and the next Send 409s
  // `already answered` (review round 3). Answering therefore invalidates the detail
  // directly, not just the listing.
  const [detailNonce, setDetailNonce] = useState(0)
  const details = useQuestionDetails(blockedRuns, loadDetail, detailNonce)
  const retryDetails = useCallback(() => setDetailNonce((n) => n + 1), [])

  const open = useCallback((runId: string) => navigate(href.run(runId)), [])

  // §3.6's roving tabindex: the list is ONE tab stop with a live selection inside it, so
  // the selection must be valid from first paint — a -1 cursor would leave every row at
  // tabIndex=-1 and the table unreachable by Tab until a shortcut was pressed.
  const cursor = runs.length === 0 ? -1 : Math.min(Math.max(cursorIndex, 0), runs.length - 1)

  // §2.7: j/k move, Enter opens, / focuses search, a focuses the first answer box.
  //
  // SCOPE (round-3 finding). This listener is on `window`, so it also sees keys the
  // operator aimed at a DIFFERENT widget — most visibly the run rail, which is its own
  // §3.6 roving-tabindex list sitting beside Home. Two rules keep it honest:
  //
  //   • Selection keys (j/k, arrows, Home/End, Enter) act only on events that belong to
  //     this screen: the page itself (nothing focused, or focus on body/html — which is
  //     also what `fireEvent.keyDown(window)` produces) or a node inside Home's subtree.
  //     A keystroke that started on a rail row is the rail's; hijacking it moved Home's
  //     cursor AND — via preventDefault — swallowed the rail row's own activation, so
  //     Enter on the rail navigated to whatever Home's cursor happened to be on.
  //   • `Enter` never overrides a control that activates itself. A focused button or link
  //     — a run row, `Load more`, a filter chip — is activated by the browser on Enter;
  //     Home's cursor is the fallback for when focus is on none of them.
  //
  // `defaultPrevented` is checked first for the same reason: a widget that already handled
  // the key has spoken.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur()
        return
      }
      // `/` and `a` move focus to a named place ON THE PAGE and have no rail equivalent,
      // so they stay page-wide. Everything else moves or activates Home's own selection and
      // is scoped accordingly.
      const pageWide = e.key === '/' || e.key === 'a'
      if (!pageWide) {
        if (!ownsShortcut(e.target, rootRef.current)) return
        if (e.key === 'Enter' && isSelfActivating(e.target)) return
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        setCursorIndex(Math.min(runs.length - 1, cursor + 1)); e.preventDefault()
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        setCursorIndex(Math.max(0, cursor - 1)); e.preventDefault()
      } else if (e.key === 'Home' && runs.length) {
        setCursorIndex(0); e.preventDefault()
      } else if (e.key === 'End' && runs.length) {
        setCursorIndex(runs.length - 1); e.preventDefault()
      } else if (e.key === 'Enter') {
        const run = runs[cursor]
        if (run) { open(run.runId); e.preventDefault() }
      } else if (e.key === '/') {
        searchRef.current?.focus(); e.preventDefault()
      } else if (e.key === 'a') {
        const box = document.querySelector<HTMLInputElement>('.acard.ask .inp')
        if (box) { box.focus(); e.preventDefault() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runs, cursor, open])

  const unreachable = list.error?.unreachable || (list.error && !list.runs.length)
  const totalOnDisk = list.totalOnDisk ?? active.totalOnDisk

  /**
   * The attention strip is fed by TWO queries the table knows nothing about, and until
   * review round 3 a failure of either was invisible: the strip renders only what it has,
   * so a failed active scan produced an empty — or half-empty — "Needs you" that looked
   * exactly like a calm queue. That is the one lie this screen must never tell.
   *
   * So each scan's error is surfaced as a PARTIAL state, named by which cards it puts in
   * doubt. `usePoll` keeps the last good rows behind an error of the same identity, so the
   * cards already on screen stay (a transient poll failure must not empty the queue) —
   * they are simply no longer claimed to be complete.
   */
  // When the API is unreachable EVERY query is failing, and the banner above already says
  // so in the strongest terms — with a Retry that now re-runs all three. Repeating it per
  // scan inside the strip would be two alerts for one fact.
  const degraded = !unreachable && (active.error || staleScan.error)
    ? {
      blocked: active.error != null,
      live: active.error != null,
      stale: staleScan.error != null,
      message: (active.error ?? staleScan.error)!.message,
    }
    : null

  /**
   * Retry means "ask everything this screen is showing again", not "ask the table again".
   * The banner's button used to reload `list` alone, so an operator retrying an unreachable
   * viewer got the table back and kept a silently stale attention queue.
   *
   * EVERY data dependency a control on this screen renders from is in here, which is the
   * rule the two round-4 findings came from: the session probe decides whether Answer and
   * Resume are offered at all, and the per-run RunDetail carries the question those Answer
   * buttons address. A Retry that reloads neither cannot repair either one, however loudly
   * the banner above it says "Retry".
   */
  const reloadAll = useCallback(() => {
    list.reload(); active.reload(); staleScan.reload(); session.reload(); retryDetails()
    // The shell's probe is a one-shot too (`app/App.tsx`), so when it is the authoritative
    // one, Retry has to reach IT — otherwise a failed check leaves every mutation in the
    // app disabled for the life of the tab beside a button that claims to fix it.
    control?.retryCapabilities()
  }, [list.reload, active.reload, staleScan.reload, session.reload, retryDetails, control])

  /**
   * A chip count is a claim about the whole disk, so it is rendered ONLY where the client
   * has actually seen the whole disk for that state. Three sources, in order:
   *   • the unfiltered table, when it has been paged to exhaustion (the common case — a
   *     project with fewer runs than one page has every count exact from first paint);
   *   • the active scan, for running and blocked;
   *   • the stale scan, for stale.
   * Anything else renders NO number rather than a number that means "on this page".
   */
  const counts = useMemo((): Record<ChipKey, number | null> => {
    const whole = !chip && !debounced && list.complete ? list.runs : null
    if (whole) {
      return {
        running: whole.filter((r) => r.state === 'running' || r.state === 'starting').length,
        blocked: whole.filter(isBlocked).length,
        failed: whole.filter((r) => r.state === 'failed').length,
        completed: whole.filter((r) => r.state === 'completed').length,
        stale: whole.filter((r) => r.state === 'stale').length,
      }
    }
    return {
      running: active.complete
        ? active.runs.filter((r) => r.state === 'running' || r.state === 'starting').length
        : null,
      blocked: active.complete ? blockedAll.length : null,
      failed: null,
      completed: null,
      stale: staleScan.complete ? staleAll.length : null,
    }
  }, [chip, debounced, list.complete, list.runs, active.complete, active.runs, blockedAll,
    staleScan.complete, staleAll])

  // §3.6, the delete path: a mutation that destroyed the screen it was invoked from hands
  // focus off to Home rather than restoring it to a node the navigation just unmounted.
  // This is the claim half — see `app/landing.ts` for why it lives on Home's mount and not
  // on a timer in the dialog. It is a no-op unless a handoff was actually requested.
  useEffect(() => { claimLandingFocus() }, [])

  return (
    <div className="home" ref={rootRef}>
      <div className="home-head">
        {/* `tabIndex={-1}` makes the heading a focus TARGET without making it a tab stop:
            the landing destination for §7.3's delete, and the element whose text a screen
            reader announces when the operator arrives here without having navigated. */}
        <h1 tabIndex={-1} data-landing="home">Runs</h1>
        <span className="sub">
          {totalOnDisk == null
            ? 'loading…'
            : `${totalOnDisk} run${totalOnDisk === 1 ? '' : 's'}`}
          {anyLive ? ` · ${runningRuns.length} live` : ''}
          {session.data?.home ? <> · <span className="mono">{session.data.home}</span></> : null}
        </span>
      </div>

      {unreachable ? (
        <div className="banner" role="alert" style={{ marginBottom: 'var(--s4)' }}>
          <Icon name="failed" size={14} />
          <span>
            <b>API unreachable.</b> Is <code>flowition viewer</code> still running? The
            viewer shuts down after 30 minutes idle.
          </span>
          <button
            className="btn sm" type="button" style={{ marginLeft: 'auto' }}
            onClick={reloadAll}
          >
            <Icon name="resume" size={12} />Retry
          </button>
        </div>
      ) : null}

      {/* The capability probe failed on its own, so the screen still reads but may not
          write. Named, with the same Retry — and suppressed when the API is unreachable,
          where the banner above is already the whole story.

          It says DISABLED, because that is what happened (round 6, B1). The gate fails
          closed: nothing is granted until a session response grants it, so the honest
          banner states the consequence and the one action that lifts it, rather than
          telling the operator the controls are still theirs to press. */}
      {capabilityError && !unreachable ? (
        <div className="banner warn" role="alert" style={{ marginBottom: 'var(--s4)' }}>
          <Icon name="stale" size={14} />
          <span>
            <b>This viewer&apos;s permissions are unknown.</b>{' '}
            <code>/api/session</code> failed (<span className="mono">{capabilityError}</span>),
            so this viewer has not been granted any mutation: Answer and Resume are disabled
            until the check succeeds. Nothing here says the viewer is read-only — no answer
            has claimed that.
          </span>
          <button
            className="btn sm" type="button" style={{ marginLeft: 'auto' }}
            onClick={reloadAll}
          >
            <Icon name="resume" size={12} />Retry
          </button>
        </div>
      ) : null}

      <AttentionStrip
        blocked={blockedRuns.map((run) => {
          const state = details[run.runId]
          return {
            run,
            detail: state?.detail ?? null,
            detailLoading: state?.loading ?? true,
            detailError: state?.error ?? null,
            onRetryDetail: retryDetails,
          }
        })}
        stale={staleRuns}
        live={liveRuns}
        more={more}
        truncated={active.truncated || staleScan.truncated}
        degraded={degraded}
        onRetry={reloadAll}
        capabilities={capabilities}
        capabilityError={capabilityError}
        now={now}
        onAnswered={() => { setDetailNonce((n) => n + 1); list.reload(); active.reload() }}
        // A resumed run leaves `stale` and enters the active states, so BOTH scans are
        // stale the instant the launch is accepted — and the stale scan polls at 10s,
        // which is far too slow to be the operator's feedback. Reload all three.
        onResumed={() => { list.reload(); active.reload(); staleScan.reload() }}
        onShowAll={(kind) => { setChip(kind); setQuery('') }}
        {...(props.answerFn ? { answerFn: props.answerFn } : {})}
        {...(props.resumeFn ? { resumeFn: props.resumeFn } : {})}
      />

      {runs.length > 0 || !list.loading ? (
        <div className="attn-head">
          <span className="lbl">All runs</span>
          {totalOnDisk != null ? <span className="count">{totalOnDisk}</span> : null}
        </div>
      ) : null}

      <Toolbar
        chip={chip} onChip={setChip}
        query={query} onQuery={setQuery}
        counts={counts}
        searchRef={searchRef}
      />

      {list.loading ? <LoadingRows /> : null}

      {!list.loading && runs.length === 0 && !unreachable ? (
        (debounced || chip)
          ? <NoMatches onClear={() => { setChip(null); setQuery('') }} />
          : <ZeroRuns />
      ) : null}

      {!list.loading && runs.length > 0 ? (
        <>
          <RunTable
            runs={runs}
            now={now}
            activeRunId={activeRunId}
            cursorIndex={cursor}
            onOpen={open}
            onCursor={setCursorIndex}
            {...(props.virtualize === undefined ? {} : { virtualize: props.virtualize })}
          />
          {list.hasMore ? (
            <div className="rt-more">
              {/* §5.4.2 is keyset-paginated: the next page comes from `nextCursor`, never
                  from a bigger `limit` (which 400s past 200 and re-slices from the top). */}
              {wholeQuery ? (
                <span className="dim micro">
                  more than {list.runs.length} runs match this filter — the newest are shown
                </span>
              ) : (
                <button className="btn" type="button" onClick={list.loadMore}>
                  Load more
                  <span className="dim">
                    {' · '}
                    {runs.length} shown
                    {totalOnDisk != null && !chip && !debounced ? ` of ${totalOnDisk}` : ''}
                  </span>
                </button>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

// ---- shortcut scoping (§2.7 beside §3.6's per-widget roving tabindex) ----------------

/**
 * Does this keystroke belong to Home?
 *
 * True for the PAGE — an event dispatched at `window`/`document`, or one whose target is
 * `body`/`<html>`, i.e. nothing in particular is focused — and for anything inside Home's
 * own subtree. False for a focused control in the shell AROUND Home (the run rail's rows,
 * the top bar), which own their keys: two roving-tabindex lists on one screen must not
 * both answer the same `j`.
 */
function ownsShortcut(target: EventTarget | null, root: HTMLElement | null): boolean {
  const el = target as Node | null
  if (!el || typeof el.nodeType !== 'number') return true            // window
  if (el.nodeType === 9) return true                                  // document
  if (el === document.body || el === document.documentElement) return true
  // No root yet (first paint) → the page is all there is.
  return root ? root.contains(el) : true
}

/**
 * A control the browser activates on `Enter` all by itself. Home's Enter is the fallback
 * for when focus is on none of them — it must never preventDefault one of these, which is
 * exactly how a focused button's activation got swallowed.
 */
function isSelfActivating(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest('button, summary, a[href], [role="button"], [role="link"]') != null
}

// ---- pieces ------------------------------------------------------------------------

function Toolbar(
  { chip, onChip, query, onQuery, counts, searchRef }: {
    chip: ChipKey | null
    onChip: (c: ChipKey | null) => void
    query: string
    onQuery: (q: string) => void
    /** `null` = not known exactly for this state; the chip then carries no number. */
    counts: Record<ChipKey, number | null>
    searchRef: React.RefObject<HTMLInputElement | null>
  },
) {
  return (
    <div className="rt-tools" style={{ border: '1px solid var(--hairline)', borderRadius: 'var(--r2) var(--r2) 0 0', borderBottom: 0 }}>
      <span className="lbl">Filter</span>
      {CHIPS.map((c) => (
        <button
          key={c.key} type="button" className="fchip"
          aria-pressed={chip === c.key}
          onClick={() => onChip(chip === c.key ? null : c.key)}
        >
          <Icon name={c.glyph} size={12} />{c.label}
          {counts[c.key] != null ? <span className="n">{counts[c.key]}</span> : null}
        </button>
      ))}
      <div className="search">
        <Icon name="search" size={14} />
        <label className="vh" htmlFor="q">Filter by name or run id</label>
        <input
          ref={searchRef} className="inp" id="q" value={query}
          placeholder="name or run id   /"
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
    </div>
  )
}

/** Skeleton rows — no spinner, no layout shift; the real grid, greyed. */
function LoadingRows() {
  return (
    <div className="rt" data-testid="home-skeleton" aria-busy="true">
      <div className="rt-row head">
        <span /><span className="lbl">run</span><span className="lbl">adapters</span>
        <span className="lbl">agents</span>
        <span className="lbl" style={{ textAlign: 'right' }}>out</span>
        <span className="lbl" style={{ textAlign: 'right' }}>cost</span>
        <span className="lbl" style={{ textAlign: 'right' }}>duration</span>
        <span className="lbl" style={{ textAlign: 'right' }}>started</span>
      </div>
      {[62, 44, 54, 48, 58].map((w, i) => (
        <div className="rt-row" key={i}>
          <span className="skel" style={{ width: 12, height: 12, borderRadius: 999 }} />
          <span className="rt-name"><span className="skel" style={{ width: `${w}%` }} /></span>
          <span className="skel" style={{ width: 52 }} />
          <span className="skel" style={{ width: 44 }} />
          <span className="skel" style={{ width: 40, marginLeft: 'auto' }} />
          <span className="skel" style={{ width: 36, marginLeft: 'auto' }} />
          <span className="skel" style={{ width: 38, marginLeft: 'auto' }} />
          <span className="skel" style={{ width: 56, marginLeft: 'auto' }} />
        </div>
      ))}
      <span className="vh">Loading runs…</span>
    </div>
  )
}

/** Zero runs: the quick-start snippet, not a shrug. */
function ZeroRuns() {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="empty">
        <Icon name="gantt" size={20} className="dim" />
        <h3>No runs yet</h3>
        <p>
          flowition records every run under <span className="mono">.flowition/runs/</span>.
          Start one and this page fills in — the viewer is already watching.
        </p>
        <div className="snippet">
          <span className="p">$</span><span>flowition run hello.workflow.js</span>
          <button
            className="icb" type="button" aria-label="Copy command"
            onClick={() => { void navigator.clipboard?.writeText('flowition run hello.workflow.js') }}
          >
            <Icon name="copy" size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="empty">
        <Icon name="search" size={20} className="dim" />
        <h3>No runs match</h3>
        <p>There are runs on disk, but none match this filter.</p>
        <button className="btn" type="button" onClick={onClear}>Clear filters</button>
      </div>
    </div>
  )
}

/**
 * Fetch the RunDetail behind each blocked card, so the attention strip can show the
 * question text §2.3 asks for. Drops details for runs that are no longer blocked.
 *
 * **The identity of this request is (runId, openQuestions) per blocked run, never the id
 * set alone.** A run that asks two questions stays blocked — and keeps its runId — after
 * the first is answered, so an id-only key holds the already-answered qid in hand and the
 * card's next Send is a 409 `already answered` (the round-3 finding). The question COUNT
 * is the part of the listing that moves when a question is resolved, so it belongs in the
 * key; `nonce` is the answer's synchronous invalidation on top, because the summary poll
 * that carries the new count is up to 2 s (and one §5.5 cache tier) behind the operator.
 *
 * **Each blocked run gets its own loading/error/data state**, because that same identity is
 * what makes a failure permanent otherwise: nothing about (runId, openQuestions) moves when
 * a request fails, so neither the 2 s summary poll nor a listing reload reruns this effect,
 * and one failed fetch left the card on "loading the question…" behind a dead composer for
 * the life of the tab (the round-4 finding). `nonce` is therefore the RETRY as well — the
 * screen's Retry and the card's own both bump it, re-requesting the (at most three) blocked
 * details together rather than inventing a per-run invalidation for three requests.
 */
interface QuestionDetail {
  /** The last good payload — kept across a refresh AND across a failure. */
  detail: RunDetail | null
  /** The last request failed, in the server's own words. Cleared by a successful one. */
  error: string | null
  loading: boolean
}

function useQuestionDetails(
  blocked: RunSummary[],
  loadDetail: typeof api.runDetail,
  nonce = 0,
): Record<string, QuestionDetail> {
  const [details, setDetails] = useState<Record<string, QuestionDetail>>({})
  const key = blocked.map((r) => `${r.runId}:${r.openQuestions}`).join(',')
  // The ids come from the CURRENT render, so the effect never re-parses them out of the
  // key — the key is an identity, not a data structure.
  const idsRef = useRef<string[]>([])
  idsRef.current = blocked.map((r) => r.runId)

  useEffect(() => {
    if (!key) { setDetails({}); return }
    const controller = new AbortController()
    let cancelled = false
    const ids = [...idsRef.current]

    // Adopt this identity: every blocked run is loading, ids that left the strip are
    // dropped, and whatever each run last had SURVIVES the refresh — a card that already
    // shows a question must not blink back to the loading copy on every answer.
    //
    // The last ERROR survives it too, and only a successful response clears one. Clearing
    // it here instead would make the card's own Retry erase the very state that explains
    // why there is a Retry: the failed card would flip to "loading the question…", and if
    // the retry failed again the error would flash straight back — an affordance that
    // cannot report the attempt it just made. Held, `loading` is the difference between
    // "this failed" and "this failed and I am asking again".
    setDetails((prev) => Object.fromEntries(ids.map((id) => [id, {
      detail: prev[id]?.detail ?? null,
      error: prev[id]?.error ?? null,
      loading: true,
    }])))

    void (async () => {
      for (const runId of ids) {
        try {
          const detail = await loadDetail(runId, controller.signal)
          if (cancelled) return
          setDetails((prev) => (prev[runId]
            ? { ...prev, [runId]: { detail, error: null, loading: false } }
            : prev))
        } catch (err) {
          if (cancelled || (err as Error)?.name === 'AbortError') return
          // A 404 for a run that vanished, a 500, an unreachable viewer — the card is told
          // WHICH, because the alternative (this `catch` used to be empty) is a card stuck
          // on "loading the question…" with a disabled composer for the life of the tab.
          const message = err instanceof ApiError
            ? err.message
            : String((err as Error)?.message ?? err)
          setDetails((prev) => (prev[runId]
            ? { ...prev, [runId]: { detail: prev[runId]!.detail, error: message, loading: false } }
            : prev))
        }
      }
    })()
    return () => { cancelled = true; controller.abort() }
  }, [key, nonce, loadDetail])

  return details
}
