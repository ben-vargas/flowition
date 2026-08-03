/**
 * The control layer's host: one provider that owns every §7.2/§7.3 dialog, the ⌘K palette,
 * the `?` overlay, the `role=status` toasts, and the two slots the read-only screens hand
 * their write surfaces to (the cockpit's inbox rail, the transcript's steer composer).
 *
 * **Why a provider rather than props.** The mutation surfaces do not live together: the
 * answer composer belongs in W11's third column, the steer composer in W10's transcript
 * footer, and Cancel/Resume/Delete in W11's header — three units' components, each of which
 * would otherwise need this unit's handlers threaded through it. §12's file-ownership rule
 * exists to keep units from rewriting each other, so the wiring those files take is the
 * smallest thing that can work: `useControl()`, which returns `null` when no provider is
 * mounted, so their existing tests and their existing behavior are untouched by this unit.
 *
 * What the host is responsible for, and why it is one place:
 *   • exactly one modal at a time (opening a dialog closes whatever was up) — a stack of
 *     modals over a destructive action is a way to confirm the wrong thing;
 *   • the outcome of every lifecycle mutation, as a `role=status` toast that OUTLIVES the
 *     dialog: "moved to trash as flo_x.1764" is the only place the trash entry is ever
 *     shown, and it must not vanish with the modal that produced it;
 *   • the palette's data (it fetches the run list on open — the palette is not worth a poll,
 *     and a stale list is worse than a fresh one taken when it is asked for);
 *   • §2.7's two global keys that belong to no screen: ⌘K/Ctrl+K and `?`.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react'
import type { ReactNode } from 'react'
import { api } from '../../api/client.js'
import type { AgentView, RunDetail, RunState, RunSummary } from '../../api/types.js'
import { href, navigate, readRoute, routeRunId } from '../../app/router.js'
import { cancelLandingFocus, claimLandingFocus, requestLandingFocus } from '../../app/landing.js'
import { cancelDestinationFocus, claimDestinationFocus } from '../../app/destination.js'
import { isTypingTarget, toggleTheme } from '../../theme/theme.js'
import { cancelAnswerFocus, claimAnswerFocus, requestAnswerFocus } from './answerFocus.js'
import { type Capability, canOperate, explainCapability } from './capabilities.js'
import {
  CancelRunDialog, DeleteDialog, ResumeDialog, Toasts,
  type DialogOutcome, type ResumeRef, type RunRef,
} from './Confirmations.js'
import { ControlInboxRail } from './InboxRail.js'
import { Palette, ShortcutOverlay, type PaletteAction } from './Palette.js'
import { SteerComposer } from './SteerComposer.js'
import './control.css'

/** The mutation surface, injectable whole so no DOM test ever touches `fetch`. */
export interface ControlMutations {
  answer: typeof api.answer
  send: typeof api.send
  cancelAgent: typeof api.cancelAgent
  cancelRun: typeof api.cancelRun
  resume: typeof api.resume
  remove: typeof api.remove
  runs: typeof api.runs
  runDetail: typeof api.runDetail
}

const DEFAULT_MUTATIONS: ControlMutations = {
  answer: api.answer,
  send: api.send,
  cancelAgent: api.cancelAgent,
  cancelRun: api.cancelRun,
  resume: api.resume,
  remove: api.remove,
  runs: api.runs,
  runDetail: api.runDetail,
}

export interface InboxSlotProps {
  detail: RunDetail
  now: number
  narrow: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  onChanged?: () => void
}

export interface SteerSlotProps {
  runId: string
  detail: RunDetail
  agent: AgentView
  runLive: boolean
  onChanged?: () => void
}

export interface ControlValue {
  capabilities: readonly string[] | null
  capabilityError: string | null
  /**
   * Re-run the shell's `GET /api/session`.
   *
   * The probe is a ONE-SHOT — capabilities change when the operator restarts the viewer, not
   * on a poll — so a check that failed stays failed, and with the gate failing closed that
   * means every mutation in the app is disabled until something asks again. This is the
   * "something": the screens that own a Retry (Home's banner) call it, so the operator's one
   * visible affordance actually reaches the request that is holding the controls shut.
   * A no-op when the host passed no `onRetryCapabilities`.
   */
  retryCapabilities: () => void
  mutations: ControlMutations
  /** §7.2's whole-run cancel modal. */
  confirmCancelRun: (run: RunRef, onChanged?: () => void) => void
  /** §7.3's resume/replay modal — the copy differs on `run.state === 'completed'`. */
  confirmResume: (run: ResumeRef, onChanged?: () => void) => void
  /** §7.3's type-to-confirm delete. */
  confirmDelete: (run: RunRef, onChanged?: () => void) => void
  openPalette: () => void
  openShortcuts: () => void
  notify: (outcome: DialogOutcome) => void
  /** §2.4's inbox rail with live composers — mounted by the cockpit into §3.7's column. */
  renderInbox: (props: InboxSlotProps) => ReactNode
  /** §2.5's footer steer composer + per-agent cancel — mounted by the transcript pane. */
  renderSteer: (props: SteerSlotProps) => ReactNode
}

const ControlContext = createContext<ControlValue | null>(null)

/**
 * What the palette knows about its own run list — and it has to know more than
 * "loading/error", because §2.7 promises the operator can "jump to ANY run".
 *
 * `listed`/`total` exist so a sweep still in flight can say how much of the listing is
 * already searchable instead of silently presenting a prefix as the whole thing.
 */
interface RunsState {
  loading: boolean
  error: string | null
  /** Runs adopted so far. */
  listed: number
  /** `totalOnDisk` from the last page that answered, when one has. */
  total: number | null
}

const RUNS_IDLE: RunsState = { loading: false, error: null, listed: 0, total: null }

/**
 * §5.4.2's page ceiling. `limit` is capped at 200 server-side, so this is the largest
 * legal page and therefore the fewest possible round trips for a full sweep.
 */
const RUNS_PAGE_LIMIT = 200

/**
 * `null` when no provider is mounted. Every consumer outside this feature checks for that
 * and falls back to what it did before W12 — which is what keeps this unit's wiring to a
 * handful of lines in other units' files.
 */
export const useControl = (): ControlValue | null => useContext(ControlContext)

type Modal =
  | { kind: 'cancel-run'; run: RunRef; onChanged?: () => void }
  | { kind: 'resume'; run: ResumeRef; onChanged?: () => void }
  | { kind: 'delete'; run: RunRef; onChanged?: () => void }
  | { kind: 'palette' }
  | { kind: 'shortcuts' }
  | null

export interface ControlProviderProps {
  capabilities: readonly string[] | null
  capabilityError?: string | null
  /** Re-probe `GET /api/session` — the shell owns the request, the screens own the button. */
  onRetryCapabilities?: () => void
  mutations?: Partial<ControlMutations>
  /** The run currently on screen, when the host knows it (feeds the palette's agents). */
  detail?: RunDetail | null
  children: ReactNode
}

export function ControlProvider(props: ControlProviderProps) {
  const [modal, setModal] = useState<Modal>(null)
  const [toasts, setToasts] = useState<{ id: number; message: string; tone?: 'ok' | 'warn' }[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [runsState, setRunsState] = useState<RunsState>({ ...RUNS_IDLE })
  /** Monotonic id of the newest listing sweep; an older sweep's pages are discarded. */
  const runsFetch = useRef(0)
  /**
   * The run the palette is ABOUT, and the snapshot it fetched for that run — kept together
   * because they are only ever correct together.
   *
   * `scope` is the route's run id read AT OPEN TIME; `null` on Home (and on any non-run
   * route), which is what makes the palette offer no run-scoped actions there. `detail` is
   * tagged with the run it was fetched for, so a response that arrives after the operator
   * has moved on can be recognised and dropped instead of arming Cancel/Resume/Delete
   * against the previous run. Every run-scoped action the palette shows is a mutation, so
   * "whose run is this?" is not a cosmetic question.
   */
  const [palette, setPalette] = useState<{ scope: string | null; detail: RunDetail | null }>(
    { scope: null, detail: null },
  )
  /** Monotonic id of the newest detail fetch; anything older is discarded on arrival. */
  const paletteFetch = useRef(0)
  const toastId = useRef(1)
  const mutations = useMemo<ControlMutations>(
    () => ({ ...DEFAULT_MUTATIONS, ...props.mutations }),
    [props.mutations],
  )

  const notify = useCallback((outcome: DialogOutcome) => {
    const id = toastId.current++
    setToasts((current) => [
      ...current.slice(-2),
      { id, message: outcome.message, ...(outcome.tone ? { tone: outcome.tone } : {}) },
    ])
  }, [])
  const dismiss = useCallback(
    (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  )

  const modalRef = useRef<Modal>(null)

  /**
   * §3.6's "closing restores it", across a CHAIN of modals.
   *
   * A palette action opens a confirmation, which means the palette unmounts in the same
   * commit the dialog mounts. The dialog's own guess at its opener is then the palette's
   * combobox — a node that is being removed — so the restore is correctly skipped and focus
   * lands on `<body>`: the operator loses their place on the page, on every close path
   * (Escape, scrim, and the safe button alike). The page position that matters is the one
   * from BEFORE the first modal, so it is captured once, when a modal opens from no modal,
   * and handed to whatever dialog is up until the whole transition ends.
   */
  const pageOpener = useRef<Element | null>(null)
  const openModal = useCallback((next: Exclude<Modal, null>) => {
    if (modalRef.current === null) pageOpener.current = document.activeElement
    setModal(next)
  }, [])

  const close = useCallback(() => {
    // A listing sweep outlives the dialog that asked for it unless it is told not to.
    runsFetch.current++
    setModal(null)
  }, [])

  /**
   * §7.2's gate, at the LAYER rather than only at each entry point (review round 5, B1).
   *
   * The three lifecycle dialogs are raised through this context by three different units'
   * components — the cockpit header, Home's stale card, and this feature's own palette —
   * and each of them decides for itself whether the operator may act. That is three chances
   * to be wrong about one rule — and Home's card WAS wrong about it, reading an unknown
   * capability set as permission until round 6 put it on the same `canOperate` gate as
   * everything else. All three now refuse at the control, so this is defence in depth rather
   * than the only gate; it stays because a caller that reaches the context directly must not
   * be able to raise a dialog for a capability this viewer has not been granted. It says why
   * in the same `role=status` toast every other outcome uses — nothing silently does nothing,
   * which is the defect the palette's `disabledReason` exists to prevent.
   */
  const refuse = useCallback((capability: Capability): boolean => {
    if (canOperate(props.capabilities, capability)) return false
    notify({
      message: explainCapability(props.capabilities, capability, props.capabilityError ?? null)!,
      tone: 'warn',
    })
    return true
  }, [props.capabilities, props.capabilityError, notify])

  const confirmCancelRun = useCallback((run: RunRef, onChanged?: () => void) => {
    if (refuse('cancel')) return
    openModal({ kind: 'cancel-run', run, ...(onChanged ? { onChanged } : {}) })
  }, [openModal, refuse])
  const confirmResume = useCallback((run: ResumeRef, onChanged?: () => void) => {
    if (refuse('resume')) return
    openModal({ kind: 'resume', run, ...(onChanged ? { onChanged } : {}) })
  }, [openModal, refuse])
  const confirmDelete = useCallback((run: RunRef, onChanged?: () => void) => {
    if (refuse('delete')) return
    openModal({ kind: 'delete', run, ...(onChanged ? { onChanged } : {}) })
  }, [openModal, refuse])
  const openShortcuts = useCallback(() => openModal({ kind: 'shortcuts' }), [openModal])

  /**
   * §2.7's "jump to ANY run", as keyset pagination followed to exhaustion.
   *
   * Round 1 fetched ONE page of 200 and dropped `nextCursor` on the floor, so on a machine
   * with more than 200 runs every older run was simply absent from the palette — invisibly,
   * because a palette that shows nothing for a query is indistinguishable from a palette
   * that has nothing to show. §5.4.2 caps `limit` at 200 and hands back an opaque
   * `{createdAt, runId}` cursor precisely so a client that wants everything can walk it.
   *
   * The walk is:
   *   • PROGRESSIVE — every page is adopted as it lands, so the first 200 runs are
   *     searchable while the rest are still arriving and the operator never waits on a
   *     sweep they may not need;
   *   • ABANDONABLE — `seq` is the open generation, so a sweep whose palette has closed (or
   *     been reopened) stops writing state rather than racing the newer one;
   *   • TERMINATING — a null cursor ends it, and a server that repeats a cursor or answers
   *     a cursored page with no rows is treated as an error rather than looped on. Neither
   *     can happen against §5.4.2's keyset, and neither may hang the browser if it does;
   *   • HONEST — a failure part-way keeps the pages already in hand and records the error,
   *     which the palette renders as "the run list is incomplete". §2.3's no-silent-caps
   *     rule is the same rule: a truncated list must say it is truncated.
   */
  const sweepRuns = useCallback(async (seq: number) => {
    const collected: RunSummary[] = []
    const seenCursors = new Set<string>()
    // Keyset pages do not overlap, but a run id is the palette's React key and a duplicate
    // one is a rendering defect, not a listing defect — so the walk is idempotent on ids
    // whatever the server does.
    const seenRuns = new Set<string>()
    let cursor: string | null = null
    try {
      for (;;) {
        const page = await mutations.runs({
          limit: RUNS_PAGE_LIMIT, ...(cursor ? { cursor } : {}),
        })
        if (seq !== runsFetch.current) return
        for (const run of page.runs) {
          if (seenRuns.has(run.runId)) continue
          seenRuns.add(run.runId)
          collected.push(run)
        }
        const next = page.nextCursor ?? null
        setRuns([...collected])
        setRunsState({
          loading: next != null, error: null,
          listed: collected.length, total: page.totalOnDisk ?? null,
        })
        if (next == null) return
        if (seenCursors.has(next) || page.runs.length === 0) {
          throw new Error('the run listing did not advance past its cursor')
        }
        seenCursors.add(next)
        cursor = next
      }
    } catch (error) {
      if (seq !== runsFetch.current) return
      // A failed page does NOT close the palette and does not throw away the pages that
      // did answer: this run's agents, every action and every run already listed are
      // still there, and saying "the run list is incomplete" beats an empty dialog.
      setRunsState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [mutations])

  // The palette takes its run list ON OPEN. A poll behind a closed dialog would be a
  // background cost for a surface nobody is looking at, and a cached list would be exactly
  // as stale as the last time somebody opened it.
  const openPalette = useCallback(() => {
    // A palette opened again supersedes whatever the last one asked for — an intent that
    // never found a composer, or a jump whose destination never mounted, must not fire into
    // this one's surface (`answerFocus.ts`, `app/destination.ts`).
    cancelAnswerFocus()
    cancelDestinationFocus()
    openModal({ kind: 'palette' })
    setRuns([])
    setRunsState({ loading: true, error: null, listed: 0, total: null })
    // The open run's own agents and lifecycle actions come from a snapshot taken here, for
    // the same reason as the listing: the palette is a surface that is asked for, and the
    // host (the shell) has no run store of its own to borrow from. A failure leaves the
    // palette with actions and runs — never with an error screen.
    //
    // WHAT IT MUST NOT DO is show the last run's actions. The scope is re-read from the
    // route on every open and the previous snapshot is dropped in the same breath, so a
    // palette opened on Home has no run actions at all and a palette opened on run B never
    // shows run A's — not for the width of a fetch, not if that fetch fails, and not if A's
    // response lands after B's open (the sequence check and the run-id tag below both have
    // to agree before anything is adopted).
    const runId = routeRunId(readRoute())
    const seq = ++paletteFetch.current
    setPalette({ scope: runId, detail: null })
    if (runId && !props.detail) {
      mutations.runDetail(runId)
        .then((fetched) => {
          if (seq !== paletteFetch.current) return
          if (routeRunId(readRoute()) !== runId) return
          setPalette({ scope: runId, detail: fetched })
        })
        .catch(() => {
          if (seq === paletteFetch.current) setPalette({ scope: runId, detail: null })
        })
    }
    void sweepRuns(++runsFetch.current)
  }, [mutations, openModal, props.detail, sweepRuns])

  // §2.7's two global keys. ⌘K/Ctrl+K carries a modifier, so it is NOT suppressed while
  // typing — it is how an operator inside a composer gets to the palette. `?` is a bare
  // character and is suppressed while typing, like every other bare shortcut (parity #111).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'k' || event.key === 'K')) {
        if (modalRef.current?.kind === 'palette') close()
        else openPalette()
        event.preventDefault()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (event.key === '?') { openShortcuts(); event.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, openPalette, openShortcuts])

  /**
   * The other half of the palette's answer action (`answerFocus.ts`): the intent is
   * recorded inside a focus-trapped modal and EXECUTED HERE, once no modal is up.
   *
   * This effect runs in the commit that removed the palette, after React has run the
   * palette's unmount cleanups — which is to say after `ariaHideOutside` has given the page
   * back to assistive tech, after `FocusScope contain` has stopped pulling focus into a
   * dialog that no longer exists, and after §3.6's restore has put focus back where the
   * operator was. That ordering is the whole point: the composer is focused last, so it is
   * the position the operator ends up in, and no timer is involved in getting there.
   *
   * When the composer needs the inbox to open first, this claim finds nothing and the rail
   * (which was notified when the intent was recorded) satisfies it on the commit that
   * mounts it. Either way the intent is consumed exactly once.
   *
   * The same commit settles §2.7's OTHER keyboard promise — "jump to any run or agent" —
   * for the one case the destination's own mount effect cannot cover: a jump to the route
   * already on screen, where `navigate` is a no-op, nothing re-renders and no mount effect
   * will ever run. `app/destination.ts` carries the rest of that story. The two intents are
   * never both worth serving: an answer intent is the more specific ask and wins outright,
   * and it drops whatever jump it superseded rather than leaving it armed.
   */
  useEffect(() => {
    if (modal !== null) return
    if (claimAnswerFocus(routeRunId(readRoute()))) {
      cancelDestinationFocus()
      cancelLandingFocus()
    } else if (!claimDestinationFocus()) {
      // "Go to all runs" from a palette opened ON Home: the route does not move, so Home
      // never remounts and its own claim never runs again.
      claimLandingFocus()
    }
  }, [modal])

  modalRef.current = modal

  const renderInbox = useCallback((slot: InboxSlotProps) => (
    <ControlInboxRail
      detail={slot.detail}
      now={slot.now}
      narrow={slot.narrow}
      open={slot.open}
      onOpen={slot.onOpen}
      onClose={slot.onClose}
      capabilities={props.capabilities}
      capabilityError={props.capabilityError ?? null}
      answerFn={mutations.answer}
      {...(slot.onChanged ? { onAnswered: slot.onChanged } : {})}
    />
  ), [mutations, props.capabilities, props.capabilityError])

  const renderSteer = useCallback((slot: SteerSlotProps) => (
    <SteerComposer
      runId={slot.runId}
      detail={slot.detail}
      agent={slot.agent}
      runLive={slot.runLive}
      capabilities={props.capabilities}
      capabilityError={props.capabilityError ?? null}
      sendFn={mutations.send}
      cancelAgentFn={mutations.cancelAgent}
      {...(slot.onChanged ? { onChanged: slot.onChanged } : {})}
    />
  ), [mutations, props.capabilities, props.capabilityError])

  const onRetryCapabilities = props.onRetryCapabilities
  const retryCapabilities = useCallback(() => { onRetryCapabilities?.() }, [onRetryCapabilities])

  const value = useMemo<ControlValue>(() => ({
    capabilities: props.capabilities,
    capabilityError: props.capabilityError ?? null,
    retryCapabilities,
    mutations,
    confirmCancelRun,
    confirmResume,
    confirmDelete,
    openPalette,
    openShortcuts,
    notify,
    renderInbox,
    renderSteer,
  }), [
    props.capabilities, props.capabilityError, retryCapabilities, mutations, confirmCancelRun,
    confirmResume, confirmDelete, openPalette, openShortcuts, notify, renderInbox, renderSteer,
  ])

  /**
   * The run the palette may act on — and `null` unless everything agrees on which run that
   * is. The host's own `detail` (the cockpit hands it over in tests and could in future)
   * only counts when it is the SAME run the palette was opened for; the fetched snapshot
   * only counts when it carries that run's id. Anything else — Home, a route that moved,
   * a snapshot from the previous run — yields no run-scoped actions rather than the wrong
   * ones.
   */
  const detail =
    palette.scope == null
      ? null
      : props.detail?.runId === palette.scope
        ? props.detail
        : palette.detail?.runId === palette.scope
          ? palette.detail
          : null
  const actions = usePaletteActions({
    detail,
    confirmCancelRun,
    confirmResume,
    confirmDelete,
    openShortcuts,
  })
  // Handed to every dialog so a palette → confirmation chain restores focus to the page,
  // not to the palette input that no longer exists (§3.6).
  const restoreFocusTo = pageOpener.current

  return (
    <ControlContext.Provider value={value}>
      {props.children}
      {modal?.kind === 'cancel-run' ? (
        <CancelRunDialog
          run={modal.run}
          cancelRunFn={mutations.cancelRun}
          onClose={close}
          restoreFocusTo={restoreFocusTo}
          onDone={(outcome) => { notify(outcome); modal.onChanged?.() }}
        />
      ) : null}
      {modal?.kind === 'resume' ? (
        <ResumeDialog
          run={modal.run}
          resumeFn={mutations.resume}
          onClose={close}
          restoreFocusTo={restoreFocusTo}
          onDone={(outcome) => { notify(outcome); modal.onChanged?.() }}
        />
      ) : null}
      {modal?.kind === 'delete' ? (
        <DeleteDialog
          run={modal.run}
          deleteFn={mutations.remove}
          onClose={close}
          restoreFocusTo={restoreFocusTo}
          onDone={(outcome) => {
            notify(outcome)
            modal.onChanged?.()
            // The run this page is about no longer exists. Staying on it would render the
            // "deleted while you were watching it" banner over a screen the operator asked
            // to leave; Home is where the outcome (and the toast) belong.
            //
            // …and this is the ONE close path where §3.6's restore cannot apply, because
            // the navigation below unmounts the very node the restore targets — the deleted
            // run's Delete button in the cockpit header. Restoring to it leaves the operator
            // on `<body>` a tick later, so success hands focus OFF to Home instead (see
            // `app/landing.ts`). Every other close path — Escape, the scrim, Keep it, and a
            // FAILED delete, where the page and its opener are still standing — keeps the
            // restore untouched.
            if (routeRunId(readRoute()) === modal.run.runId) {
              navigate(href.home())
              requestLandingFocus()
            }
          }}
        />
      ) : null}
      {modal?.kind === 'palette' ? (
        <Palette
          onClose={close}
          detail={detail}
          runs={runs}
          runsLoading={runsState.loading}
          runsError={runsState.error}
          runsListed={runsState.listed}
          runsTotal={runsState.total}
          capabilities={props.capabilities}
          capabilityError={props.capabilityError ?? null}
          actions={actions}
          restoreFocusTo={restoreFocusTo}
        />
      ) : null}
      {modal?.kind === 'shortcuts'
        ? <ShortcutOverlay onClose={close} restoreFocusTo={restoreFocusTo} />
        : null}
      <Toasts items={toasts} onDismiss={dismiss} />
    </ControlContext.Provider>
  )
}

/** §7.3's resumable set, mirrored client-side so the palette can label Replay vs Resume. */
const RESUMABLE: readonly RunState[] = ['completed', 'failed', 'interrupted', 'stale']

/**
 * §2.7's "invoke actions (answer, cancel, resume, theme)".
 *
 * Every run-scoped action is offered whenever a run is open and is LOCKED — visible,
 * disabled, and carrying its reason — when the capability is missing OR the run's state
 * forbids it. The palette is where an operator goes when they cannot find a control, so it
 * is the last place that should hide one.
 *
 * **The two gates are separate, and round 1 only had one.** A capability gate answers "may
 * this viewer ever do this?"; `disabledReason` answers "may it do this to THIS run, right
 * now?" — §7.3's lifecycle eligibility (delete refuses a live run, cancel needs a live one,
 * resume needs `completed|failed|interrupted|stale`) plus the degenerate case of answering
 * a run with nothing open. Round 1 folded the second into a plain `hint`, which renders as
 * grey text beside an otherwise ordinary row: Delete on a running run looked enabled, took
 * Enter, closed the palette and then did nothing at all. That is worse than a refusal —
 * the operator has no way to tell it from a delete that worked.
 */
function usePaletteActions(
  { detail, confirmCancelRun, confirmResume, confirmDelete, openShortcuts }: {
    detail: RunDetail | null
    confirmCancelRun: (run: RunRef) => void
    confirmResume: (run: ResumeRef) => void
    confirmDelete: (run: RunRef) => void
    openShortcuts: () => void
  },
): PaletteAction[] {
  return useMemo(() => {
    const actions: PaletteAction[] = []
    if (detail) {
      const run: RunRef = { runId: detail.runId, name: detail.name, state: detail.state }
      // The resume modal is the one that has to state §7.3's graph-verification fact, and
      // the snapshot it is read from is in hand here, so a null means §6.5's null.
      const resumeRun: ResumeRef = {
        ...run, graphDynamic: detail.graphDynamic ?? null, graphSource: 'snapshot',
      }
      const live = detail.state === 'running' || detail.state === 'starting'
      const open = (detail.questions ?? []).filter((q) => !q.answered && !q.abandoned).length
      actions.push({
        id: 'answer',
        text: 'Answer the first open question',
        glyph: 'blocked',
        capability: 'answer',
        ...(open
          ? { hint: `${open} open` }
          : { disabledReason: 'this run has no open question' }),
        /**
         * §2.7's palette answer action, as a durable INTENT rather than a focus call.
         *
         * Round 3 focused `.qitem .ans-inp` right here. `Palette` runs this synchronously
         * from inside the modal it is closing, so the focus was taken back by the palette's
         * own `FocusScope contain` before the operator could type into it — and in the two
         * layouts where the rail is collapsed (the operator's own choice) or a drawer (the
         * narrow default, §3.7) there was no composer in the document at all, so the else
         * branch navigated to a run that was ALREADY OPEN and the palette closed onto
         * nothing. `answerFocus.ts` fixes both: the ask is recorded, the rail opens itself
         * if it has to, and the composer takes focus after this modal has actually
         * unmounted.
         *
         * The navigation is still here for the one case that needs it: the answer composers
         * live in the cockpit's inbox rail, so an operator who opens the palette from this
         * run's TRANSCRIPT (or from anywhere else that is not the run screen) has to be
         * taken there first. The intent outlives the route change and is satisfied when the
         * rail mounts.
         */
        run: () => {
          requestAnswerFocus(detail.runId)
          const route = readRoute()
          if (route.name !== 'run' || route.runId !== detail.runId) {
            navigate(href.run(detail.runId))
          }
        },
      })
      actions.push({
        id: 'cancel-run',
        text: `Cancel run ${detail.name ?? detail.runId}`,
        glyph: 'cancel',
        capability: 'cancel',
        ...(live ? {} : { disabledReason: `a ${detail.state ?? 'unknown'} run is not live — there is nothing to cancel` }),
        run: () => confirmCancelRun(run),
      })
      const resumable = detail.state != null && RESUMABLE.includes(detail.state)
      actions.push({
        id: 'resume',
        text: detail.state === 'completed'
          ? `Replay run ${detail.name ?? detail.runId}`
          : `Resume run ${detail.name ?? detail.runId}`,
        glyph: 'resume',
        capability: 'resume',
        ...(resumable ? {} : { disabledReason: `a ${detail.state ?? 'unknown'} run cannot be resumed` }),
        run: () => confirmResume(resumeRun),
      })
      actions.push({
        id: 'delete',
        text: `Delete run ${detail.name ?? detail.runId}`,
        glyph: 'trash',
        capability: 'delete',
        ...(live ? { disabledReason: 'a live run cannot be deleted — cancel it first' } : {}),
        run: () => confirmDelete(run),
      })
    }
    actions.push({ id: 'theme', text: 'Toggle theme', glyph: 'sun', run: () => toggleTheme() })
    actions.push({
      id: 'shortcuts', text: 'Keyboard shortcuts', glyph: 'keyboard', run: openShortcuts,
    })
    // Same hand-off as the run/agent jumps, through the module that already owns Home as a
    // destination: the palette unmounts as the route changes, so without it the operator
    // lands on Home with focus on `<body>`.
    actions.push({
      id: 'home',
      text: 'Go to all runs',
      glyph: 'table',
      run: () => { navigate(href.home()); requestLandingFocus() },
    })
    return actions
  }, [detail, confirmCancelRun, confirmResume, confirmDelete, openShortcuts])
}
