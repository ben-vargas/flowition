/**
 * The cockpit header (DESIGN §2.4, parity #45–#46, #58–#59).
 *
 * Everything here is a fact the run wrote, or an admitted absence. The one rule that
 * decided most of the copy: **a stale run's time of death does not exist**. `endedAt` is
 * written from a terminal `run` event and from nothing else (§6.2,
 * src/viewer/summaries.js), and a run is `stale` precisely because the engine went away
 * without writing one. Neither `startedAt` nor the `run.lock` mtime may be substituted —
 * the lock dates when the engine ACQUIRED the run — so the `died` cell states *not
 * recorded* and reports the start instead. That is the ruling recorded against
 * `cockpit-stale-1440` in `docs/frontend/comps/approvals.json`, and the shipped
 * `AttentionStrip` already obeys it; this screen must not contradict it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../../api/client.js'
import type { RunDetail, RunState } from '../../api/types.js'
// `AttemptSpan` is one of §6.2's canonical declarations but is not in `api/types.ts`'s
// re-export list; `fold/index.ts` is the sanctioned door onto the same declaration file.
import type { AttemptSpan } from '../../fold/index.js'
import { fmtCost, fmtDuration, fmtStamp, fmtTokens, timeAgo } from '../../format/fmt.js'
import { type RunHonesty, useRunHonesty } from './honesty.js'
import { Icon } from '../../ui/Icon.js'
import { BudgetGauge } from '../../ui/Gauge.js'
import { StatusChip, StatusGlyph } from '../../ui/Status.js'
import { href, navigate } from '../../app/router.js'
import { claimDestinationFocus } from '../../app/destination.js'
// §7.2's lock chip, from the one module that renders it, so the cockpit's locked Cancel
// looks and reads exactly like Home's locked Resume and the transcript's locked Send.
import { LockChip } from '../control/Locked.js'

/** §7.3: the states a resume is legal from. `completed` is a full cache replay (Sol-12). */
export const RESUMABLE: readonly RunState[] = ['completed', 'failed', 'interrupted', 'stale']

export const canResumeState = (state: RunState | null | undefined): boolean =>
  state != null && RESUMABLE.includes(state)

/**
 * The slice of the screen's honesty verdict the lineage needs. Taken as a value rather than
 * re-derived from a state string, because "is this run alive?" has exactly one answer per
 * screen and `honesty.ts` is where it is computed.
 */
export type RunLiveness = Pick<RunHonesty, 'state' | 'dead'>

export interface RunHeaderProps {
  detail: RunDetail
  now: number
  /**
   * The session's enabled control capabilities (§7.2). **`null` means UNKNOWN, not
   * unrestricted**: during bootstrap `GET /api/session` has not answered yet, and arming a
   * lifecycle mutation against a capability nobody has reported is exactly the "capability
   * gating" this header claims to do (review round 1, M1).
   */
  capabilities: readonly string[] | null
  /**
   * Why the capability set is unknown, when it is (`GET /api/session` failed). It changes
   * only the WORD on the lock chip — `unverified` rather than `checking` — never what the
   * control lets through, and it is what stops the header saying "still checking" about a
   * probe that has already failed while the composer an inch away says otherwise.
   */
  capabilityError?: string | null
  onRefresh?: () => void
  onToggleLog: () => void
  logOpen: boolean
  resumeFn?: typeof api.resume
  /** Test seam for §13 Q4's on-demand args read; defaults to `api.runArgs`. */
  argsFn?: typeof api.runArgs
  /** W12 supplies the §7.2 modal for whole-run cancel; without it the button is inert. */
  onCancelRun?: () => void
  /** W12 supplies the §7.3 type-to-confirm delete; without it the button is inert. */
  onDelete?: () => void
  /**
   * W12 supplies the §7.3 resume/replay modal. Without it Resume keeps W11's inline arm,
   * which is a weaker confirmation but never an unconfirmed lifecycle mutation.
   */
  onResume?: () => void
  /** §6.4 step 1a: which attempt scope the cockpit is projecting. */
  scope?: number
  onScope?: (scope: number) => void
}

/** Unknown is not permitted. A mutation opens only once the session says the word. */
const allows = (capabilities: readonly string[] | null, control: string): boolean =>
  capabilities != null && capabilities.includes(control)

const capabilityNote = (capabilities: readonly string[] | null, control: string): string =>
  capabilities == null
    ? 'waiting for the viewer session — the enabled control capabilities are not known yet'
    : `${control} needs \`flowition viewer --control=${control}\``

export function RunHeader(props: RunHeaderProps) {
  const { detail, now } = props
  // The screen's ONE liveness verdict (`honesty.ts`) — the header does not re-derive it,
  // and every claim below (the clock, the orphan count, the action gates) reads it.
  const honesty = useRunHonesty(detail, now)
  const live = honesty.live
  // ROUND 11. The run's state on screen is the AUTHORITATIVE one, never `detail.state`.
  // `honesty.state` is `deriveRunState`'s verdict (§6.2) and `RunHonesty` documents that it
  // MAY LEAD the snapshot by a poll — so reading the snapshot here let a `stale` verdict
  // coexist with a `running` glyph: a spinning mark and a "running" chip an inch above a
  // `died: not recorded` cell, with Resume disabled because `canResumeState('running')` is
  // false. One reading for the whole header (`unknown` only when there is no verdict at all,
  // which is §3.2's neutral mark and exactly what "we do not know" should look like).
  const state: RunState = honesty.state ?? 'unknown'
  const counts = detail.agentCounts ?? { total: 0, done: 0, failed: 0, running: 0, cached: 0 }
  // Round 6: `displayState === 'orphaned'` alone under-reported the header's own count on
  // exactly the runs where it matters — a quiescent run the server's post-pass never
  // touched showed "10/10 agents" while the Agents table one tab away showed four orphans.
  const orphaned = honesty.orphanedCount

  // §3.6's "focus is moved into panels when they open", for the one entrance that has no
  // opener left to restore to: a ⌘K jump (§2.7) unmounts the palette as the route changes,
  // so the destination claims the focus the palette recorded — here, on the commit that
  // first puts this heading in the document. `app/destination.ts` is the whole contract;
  // this is a no-op when nothing asked to come here.
  useEffect(() => { claimDestinationFocus() })

  return (
    <header className="rhead">
      <div className="rhead-top">
        <StatusGlyph state={state} />
        <h1 className="trunc" tabIndex={-1} data-destination="run" data-run={detail.runId}>
          {detail.name ?? detail.runId}
        </h1>
        <CopyId runId={detail.runId} />
        <StatusChip state={state} />
        {detail.liveDetail ? (
          <span className={`live-detail trunc${live ? '' : ' dead'}`} title={detail.liveDetail}>
            {detail.liveDetail}
          </span>
        ) : null}
        <RunActions {...props} live={live} state={state} />
      </div>

      <div className="rhead-metrics">
        <RunClockCell honesty={honesty} />

        <div className="metric" style={{ minWidth: 132 }}>
          <span className="lbl">agents</span>
          <span className="v">
            <b>{counts.done}</b><span className="u">/{counts.total}</span>
            <span className="u" style={{ fontSize: 11 }}>
              {counts.cached ? ` ·${counts.cached}c` : ''}
              {counts.failed ? ` ·${counts.failed}f` : ''}
              {orphaned ? ` ·${orphaned} orphaned` : ''}
            </span>
          </span>
        </div>

        <div className="metric" style={{ minWidth: 150 }}>
          <span className="lbl">tokens in / out</span>
          <span className="v">
            {fmtTokens(detail.spend?.input) ?? <span className="absent">none</span>}
            <span className="u"> / </span>
            <b>{fmtTokens(detail.spend?.output) ?? '—'}</b>
          </span>
        </div>

        <div className="metric" style={{ minWidth: 88 }}>
          <span className="lbl">cost</span>
          <span className="v">
            {/* Parity #114: a journal with no cost renders BLANK, never $0.00. */}
            {detail.spend?.cost
              ? <b>{fmtCost(detail.spend.cost)}</b>
              : <span className="absent" title="no cost was journalled for this run">not journalled</span>}
          </span>
        </div>

        <div className="metric gauge-cell">
          <span className="lbl" id={`gauge-${detail.runId}`}>
            budget — output tokens vs budget.total
          </span>
          <BudgetGauge spent={detail.spend?.output ?? null} ceiling={detail.budgetTotal} />
        </div>
      </div>

      {/* §13 Q4: the invocation inputs, behind a click. Keyed by run so one run's arguments
          can never still be on screen when the rail switches to another (§2.2 keeps the
          cockpit mounted across that switch — the same hazard `ResumeButton` is keyed for). */}
      <ArgsDisclosure
        key={`args|${detail.runId}`}
        runId={detail.runId}
        hasArgs={detail.hasArgs}
        {...(props.argsFn ? { argsFn: props.argsFn } : {})}
      />

      <Lineage
        spans={detail.attemptSpans ?? []}
        now={now}
        honesty={honesty}
        resumeCount={detail.resumeCount ?? 0}
        createdAt={detail.createdAt}
        scopeCount={detail.attemptScopes?.length ?? 0}
        {...(props.scope != null ? { scope: props.scope } : {})}
        {...(props.onScope ? { onScope: props.onScope } : {})}
      />
    </header>
  )
}

/**
 * §2.4's elapsed clock, and the fabrication it stopped printing (review round 6, B3).
 *
 * Parity #46 asks for a clock that "ticks 1/s while live, freezes at terminal". Round 5 read
 * that as `elapsed(startedAt, endedAt ?? now)` and got a THIRD behaviour nobody specified:
 * on a run that is neither live nor terminal — `corrupt-result`, `stale`, `unknown`; §5.4.2's
 * quiescent tier — the clock froze at `now - startedAt`, i.e. at the instant the page was
 * opened. It looked exactly like a terminal duration. It was a measurement of the operator's
 * own browsing session, printed in bold as the run's runtime, one row above a lineage strip
 * that correctly says the time of death was never recorded, and the test that "proved" the
 * freeze only proved that the fabricated number had stopped moving.
 *
 * `honesty.clock` has four shapes and only two carry a duration, so this cell cannot invent
 * one. Where there is none it says so and reports the fact the run DID write — the start —
 * which is the ruling recorded against `cockpit-stale-1440` in `comps/approvals.json` and
 * the copy `AttentionStrip` already ships.
 */
function RunClockCell({ honesty }: { honesty: RunHonesty }) {
  const { clock } = honesty
  if (clock.kind === 'unrecorded') {
    return (
      <div className="metric" style={{ minWidth: 168 }}>
        {/* A quiescent run DIED; a terminal run that wrote no `endedAt` (an old run, §6.5)
            merely ended without dating it. The distinction is the run's own, not a guess. */}
        <span className="lbl">{clock.quiescent ? 'died' : 'ended'}</span>
        <span className="v">
          <span
            className="absent"
            title="endedAt is written from a terminal run event and from nothing else. This run wrote none, and neither run.lock's mtime (it dates when the engine ACQUIRED the run) nor the moment you opened this page is its time of death — so there is no runtime to report."
          >
            not recorded
          </span>
          {timeAgo(clock.startedAt, honesty.now)
            ? <span className="u"> · started {timeAgo(clock.startedAt, honesty.now)}</span>
            : null}
        </span>
      </div>
    )
  }
  return (
    <div className="metric" style={{ minWidth: 106 }}>
      <span className="lbl">elapsed</span>
      <span className="v">
        {clock.kind === 'unstarted'
          ? <span className="absent" title="no run start recorded yet">not started</span>
          : <b>{fmtDuration(clock.ms)}</b>}
      </span>
    </div>
  )
}

/** The run id, click-to-copy (§2.4). Clipboard is best-effort: no permission dialog. */
function CopyId({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = useCallback(() => {
    void navigator?.clipboard?.writeText?.(runId)
      .then(() => setCopied(true))
      // A denied clipboard is not an error the operator must act on; the id is on screen.
      .catch(() => setCopied(false))
  }, [runId])
  return (
    <button className="rid" type="button" onClick={copy} aria-label={`Copy run id ${runId}`}>
      {runId}
      <Icon name={copied ? 'check' : 'copy'} size={12} />
    </button>
  )
}

/** How much of a large `args` value the panel renders before it says it stopped. */
const ARGS_RENDER_CHARS = 20_000

/**
 * §13 Q4's **show args** disclosure — "yes, behind an explicit *show args* disclosure in the
 * cockpit header (RunDetail `?include=args`), because args may contain secrets and must not
 * sit in the default payload or the stream (§5.6.5)".
 *
 * Everything about this control follows from that sentence:
 *
 *  • **Nothing is fetched until it is clicked.** The run store's `runDetail` poll never asks
 *    for args (see `api.runArgs`, which exists so the polling path cannot grow the flag),
 *    and this component issues its one request from the click handler, not from an effect.
 *    `?include=args` also makes the server write an `args-read` audit line (§5.4.1), so a
 *    fetch-on-mount would forge an audit trail of reads no operator performed.
 *  • **`hasArgs` decides whether the affordance exists at all** (§5.4.3): the default payload
 *    carries the boolean and never the value. A run with no args gets no control, because a
 *    disclosure that opens onto "nothing" is a worse answer than not asking the question.
 *  • **The value is rendered as text**, `JSON.stringify`'d into a `<pre>`; React escapes it.
 *    Past §5.4.1's 1 MiB inline cap the server omits the value and sets `argsTruncated`, and
 *    the panel says so instead of showing a plausible-looking prefix of nothing.
 */
function ArgsDisclosure(
  { runId, hasArgs, argsFn = api.runArgs }: {
    runId: string
    hasArgs: boolean
    argsFn?: typeof api.runArgs
  },
) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState<{ args?: unknown; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  // A disclosure that is closed while its request is in flight must not leave the fetch
  // running: it is an audited read of a value nobody is looking at any more.
  useEffect(() => () => abort.current?.abort(), [])

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      if (wasOpen) return false
      // Fetch ONCE. A second open shows what the first read; args are immutable for a run
      // (`meta.args` is written at admission), so re-reading would only add audit noise.
      if (loaded == null && !busy) {
        const controller = new AbortController()
        abort.current = controller
        setBusy(true)
        setError(null)
        argsFn(runId, controller.signal)
          .then((detail) => {
            setLoaded({
              ...('args' in detail ? { args: detail.args } : {}),
              truncated: detail.argsTruncated === true,
            })
          })
          .catch((err: unknown) => {
            if (controller.signal.aborted) return
            setError(err instanceof ApiError ? err.message : String(err))
          })
          .finally(() => { if (!controller.signal.aborted) setBusy(false) })
      }
      return true
    })
  }, [argsFn, busy, loaded, runId])

  if (!hasArgs) return null
  const panelId = `args-${runId}`
  const text = loaded && 'args' in loaded ? serializeArgs(loaded.args) : null

  return (
    <div className="rhead-args">
      <button
        className="btn sm ghost" type="button"
        aria-expanded={open} aria-controls={panelId}
        onClick={toggle}
      >
        <Icon name={open ? 'chevdown' : 'chevron'} size={12} />
        {open ? 'hide args' : 'show args'}
      </button>
      <span className="cap">
        the workflow's invocation arguments — fetched only when you ask, because they can
        carry secrets and the server journals each read
      </span>
      {open ? (
        <div id={panelId} className="args-panel" role="region" aria-label={`Run arguments for ${runId}`}>
          {busy ? <span className="dim">reading args…</span> : null}
          {error ? (
            <span className="err" role="alert">could not read args — {error}</span>
          ) : null}
          {!busy && !error && loaded?.truncated ? (
            <span className="absent">
              args exceeded the 1 MiB inline cap, so the server sent the size and not the
              value (§5.4.1). Read them from the run's <code>meta.json</code> on disk.
            </span>
          ) : null}
          {!busy && !error && loaded != null && !loaded.truncated ? (
            text == null ? (
              <span className="absent">the server returned no args value for this run</span>
            ) : (
              <pre className="args-json">
                {text.slice(0, ARGS_RENDER_CHARS)}
                {text.length > ARGS_RENDER_CHARS
                  ? `\n… ${text.length - ARGS_RENDER_CHARS} more characters not shown`
                  : ''}
              </pre>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** JSON, or the value's own text when it is not JSON-representable (`undefined`, a cycle). */
function serializeArgs(value: unknown): string | null {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/**
 * §2.4's action row, gated by §7.3 and by the session's capability set.
 *
 * The gating is stated in the button's own title rather than by silently hiding controls:
 * an operator who cannot find Delete has to guess whether the viewer lacks the capability
 * or the run is still alive, and those need different fixes.
 *
 * **And a title is not an explanation (review round 5, B1).** §7.2 says a control the
 * session has not granted renders *disabled with an explanation* — never hidden, never
 * enabled — and the product's rendering of that explanation is the LOCK CHIP, which Home's
 * cards, the inbox composer and the steer footer all carry. This row had only
 * `aria-disabled` + `title`: invisible until hover, invisible on a touch screen, and
 * announced by nothing when the button itself is inert. So each capability-gated action
 * here now renders the same chip, keyed to the same `capabilities.ts` verdict, and names it
 * in `aria-describedby`. The chip appears for `locked` AND for `unknown` (checking /
 * unverified) because the gate fails closed in both, and the copy differs by state — it
 * never calls a viewer read-only on a probe that has not answered.
 *
 * The chip is about the CAPABILITY only. "This run is still live, so it cannot be deleted"
 * is a different refusal with a different fix, and it stays in the title where it was.
 *
 * Cancel and Delete are the two that W11 cannot honestly complete on its own — §7.2 gives
 * whole-run cancel a two-step modal and §7.3 gives delete a type-to-confirm dialog, and
 * that dialog (with the focus trap §3.6 requires) is W12's. They render with their real
 * enablement and hand off to the props W12 fills; with no handler they are disabled and
 * say so, rather than firing an irreversible mutation through a bare click.
 *
 * **Every gate reads the authoritative state (round 11).** `live` and `state` both arrive
 * from `honesty.ts` and are the same reading the glyph and the chip render. Deriving
 * eligibility from `detail.state` while the screen's verdict said otherwise was worse than a
 * cosmetic disagreement: on a run the store had already called `stale`, `canResumeState`
 * read the snapshot's `running` and DISABLED Resume — the one action the operator opened a
 * dead run to take — under a header that was telling them the engine had gone.
 */
function RunActions(props: RunHeaderProps & { live: boolean; state: RunState }) {
  const { detail, capabilities, live, state } = props
  const capabilityError = props.capabilityError ?? null
  const resumable = canResumeState(state)
  const replay = state === 'completed'
  const canCancel = live && allows(capabilities, 'cancel')
  const canDelete = !live && allows(capabilities, 'delete')
  // The chip ids the buttons describe themselves by. Scoped to the run so two headers can
  // never share one id (the run rail swaps runs without remounting the cockpit, §2.2).
  const lockId = (control: string) => `lock-${control}-${detail.runId}`
  const chipFor = (control: 'cancel' | 'resume' | 'delete') =>
    (allows(capabilities, control) ? undefined : lockId(control))

  return (
    // `chipline wrap` (primitives.css): shrinkable, so three lock chips on a read-only
    // viewer wrap this row onto a second line instead of pushing a destructive `Delete`
    // out of the cockpit column and onto the inbox rail (§12.1 item 5, read-only clause).
    <div className="rhead-actions chipline wrap">
      <button
        className="btn" type="button"
        aria-disabled={!canCancel || !props.onCancelRun}
        {...(chipFor('cancel') ? { 'aria-describedby': chipFor('cancel') } : {})}
        title={
          !live
            ? 'only a running run can be cancelled'
            : !allows(capabilities, 'cancel')
              ? capabilityNote(capabilities, 'cancel')
              : !props.onCancelRun
                ? 'cancelling a run asks for confirmation first — that dialog is not wired in this build'
                : undefined
        }
        onClick={() => { if (canCancel) props.onCancelRun?.() }}
      >
        <Icon name="cancel" size={12} />Cancel run
      </button>
      <LockChip
        capabilities={capabilities} capability="cancel" capabilityError={capabilityError}
        id={lockId('cancel')} compact
      />

      {/* KEYED BY RUN (review round 2, B8). The run rail switches runs WITHOUT remounting
          the cockpit (§2.2), so without the key a confirmation armed for run A survives into
          run B and the operator's second click launches a run they never confirmed. The key
          makes that structurally impossible: a different run is a different control. */}
      <ResumeButton
        key={`${detail.runId}|${(capabilities ?? ['?']).join(',')}`}
        {...(props.onResume ? { onConfirm: props.onResume } : {})}
        detail={detail}
        enabled={resumable && allows(capabilities, 'resume')}
        resumable={resumable}
        capable={allows(capabilities, 'resume')}
        capabilityNote={capabilityNote(capabilities, 'resume')}
        replay={replay}
        {...(chipFor('resume') ? { describedBy: chipFor('resume')! } : {})}
        {...(props.onRefresh ? { onResumed: props.onRefresh } : {})}
        {...(props.resumeFn ? { resumeFn: props.resumeFn } : {})}
      />
      {/* Beside Resume for the same reason it is beside Cancel — and on a run that IS
          resumable (completed / failed / interrupted / stale) this is the only thing on the
          screen that says why the one action the operator opened a dead run to take is
          refused. */}
      <LockChip
        capabilities={capabilities} capability="resume" capabilityError={capabilityError}
        id={lockId('resume')} compact
      />

      <button
        className="btn danger" type="button"
        aria-disabled={!canDelete || !props.onDelete}
        {...(chipFor('delete') ? { 'aria-describedby': chipFor('delete') } : {})}
        title={
          live
            ? 'only a terminal run can be deleted'
            : !allows(capabilities, 'delete')
              ? capabilityNote(capabilities, 'delete')
              : !props.onDelete
                ? 'deleting a run asks you to type its id first — that dialog is not wired in this build'
                : undefined
        }
        onClick={() => { if (canDelete) props.onDelete?.() }}
      >
        <Icon name="trash" size={12} />Delete
      </button>
      <LockChip
        capabilities={capabilities} capability="delete" capabilityError={capabilityError}
        id={lockId('delete')} compact
      />

      {/* The log lane's toggle lives on the last-log row below, where the thing it opens
          is (parity #59). One affordance, not two. */}
      <button className="btn" type="button" onClick={() => navigate(href.result(detail.runId))}>
        <Icon name="external" size={12} />Result
      </button>
    </div>
  )
}

/**
 * Resume / Replay. The arm-then-confirm shape is the one `AttentionStrip` already
 * established for this mutation: a lifecycle change does not go off on a single click, and
 * `202` means LAUNCH ACCEPTED and nothing more (§7.3) — the engine's fileHash/graphHash/args
 * preflight answers later, through the run's own state.
 */
function ResumeButton(
  {
    detail, enabled, resumable, capable, capabilityNote: note, replay, describedBy,
    onResumed, onConfirm, resumeFn = api.resume,
  }: {
    detail: RunDetail
    enabled: boolean
    resumable: boolean
    capable: boolean
    capabilityNote: string
    replay: boolean
    /** The id of the §7.2 lock chip rendered beside this button, when it is gated. */
    describedBy?: string
    onResumed?: () => void
    /**
     * W12's §7.3 modal, when its control layer is mounted. §7.2's table gives resume a MODAL
     * with distinct replay/recover copy — this arm was W11's honest stand-in until that
     * landed ("W12 replaces the arm with §7.2's modal"), and it is still what renders when
     * the control layer is absent.
     */
    onConfirm?: () => void
    resumeFn?: typeof api.resume
  },
) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [launched, setLaunched] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const label = replay ? 'Replay' : 'Resume'

  // Belt and braces beside the `key` at the call site: whichever run this control is looking
  // at, an armed confirmation belongs to THAT run and to the capability set that permitted
  // it. Both are reset during render, keyed on a ref, so no armed frame can paint for the
  // wrong run (review round 2, B8).
  const armedFor = useRef(`${detail.runId}|${enabled}`)
  const nowFor = `${detail.runId}|${enabled}`
  if (armedFor.current !== nowFor) {
    armedFor.current = nowFor
    if (armed) setArmed(false)
    if (launched) setLaunched(false)
    if (failure) setFailure(null)
  }

  const go = async () => {
    if (busy || !enabled) return
    setBusy(true)
    setFailure(null)
    try {
      await resumeFn(detail.runId)
      setLaunched(true)
      setArmed(false)
      onResumed?.()
    } catch (err) {
      setArmed(false)
      setFailure(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (armed) {
    return (
      <>
        <button className="btn arm" type="button" disabled={busy} onClick={() => { void go() }}>
          <Icon name="resume" size={12} />
          {busy ? 'Launching…' : `${label} ${detail.name ?? detail.runId}?`}
        </button>
        <button className="btn" type="button" disabled={busy} onClick={() => setArmed(false)}>
          Keep it stopped
        </button>
      </>
    )
  }
  return (
    <button
      className="btn" type="button"
      aria-disabled={!enabled}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      title={
        !resumable
          ? 'enabled only for a completed, failed, interrupted or stale run'
          : !capable
            ? note
            : failure ?? (launched
              ? 'Launch accepted — the engine re-checks the workflow file, its local imports and the args before it restarts anything.'
              : replay
                ? 're-runs the workflow; completed agents replay from the journal'
                : 'restarts this run in a detached process')
      }
      onClick={() => {
        if (!enabled) return
        setLaunched(false)
        setFailure(null)
        if (onConfirm) onConfirm()
        else setArmed(true)
      }}
    >
      <Icon name="resume" size={12} />{label}
      {failure ? <span className="vh"> — {failure}</span> : null}
    </button>
  )
}

/**
 * §2.4's resume lineage strip, and §6.4 step 1a's **attempt scope selector** (Q7).
 *
 * `attemptSpans` is a flat list of `{state, t}` — a `started`/`resumed` opens an attempt and
 * the next terminal state closes it (§6.4 step 1). A terminal state with no preceding start
 * is the module-load failure case (critique N14) and renders as a hatched STUB: it has no
 * width to be honest about, and it opened no scope.
 *
 * The strip is the SELECTOR because §6.4 step 1a says so: "`RunDetail.phases/logs/mail`
 * expose the current scope; earlier scopes are reachable through the lineage strip
 * selector." A resume re-executes the workflow from the top, so every `phase()`, `log()` and
 * `sendTo()` re-emits — without the selector the earlier attempt's phases, logs and mail are
 * on the wire and unreachable, and Q7 can only be answered at run scale (review round 1, B3).
 *
 * Each segment is a radio in one group: the segments are mutually exclusive views of the
 * same run, which is what a radiogroup means, and the widths stay proportional to duration.
 *
 * **`state` is the run's own verdict and it decides the LAST attempt's fate (review round 3,
 * B1).** The span list alone cannot tell a still-running final attempt from a dead one: both
 * are "a `started` with no terminal event after it". `deriveRunState` can — it reads the
 * `run.lock` — so the authoritative state comes in here rather than being guessed from
 * timestamps, and a stale run's open attempt is drawn stale with an UNKNOWN end instead of
 * blue and ticking through `now`.
 */
export function Lineage(
  { spans, now, honesty, resumeCount, createdAt, scopeCount = 0, scope, onScope }: {
    spans: readonly AttemptSpan[]
    now: number
    /** The screen's liveness verdict (`honesty.ts`), which decides the LAST attempt's fate. */
    honesty?: RunLiveness | null
    resumeCount: number
    createdAt: number | null
    /** How many attempt scopes the payload actually carries (§6.4 step 1a). */
    scopeCount?: number
    /** The selected scope; defaults to the current (last) one. */
    scope?: number
    onScope?: (scope: number) => void
  },
) {
  const attempts = attemptSegments(spans, now, createdAt, honesty ?? null)
  if (!attempts.length) return null
  const total = attempts.reduce((n, a) => n + Math.max(a.ms, 1), 0)
  // A stub attempt never opened a scope (the `started` emit sits after `await import()`),
  // so scopes are numbered over the attempts that DID start.
  let counter = 0
  const scopeOf = attempts.map((a) => (a.stub ? null : counter++))
  const current = Math.max(0, scopeCount - 1)
  const selected = scope ?? current
  // Selectable only when there are at least two attempts that ACTUALLY OPENED A SCOPE. A
  // stub-only lineage (N14) has scopes on the wire and nothing to steer them with, and a
  // radiogroup with no radios in it would be a control that is not one.
  const selectable = onScope != null && scopeCount > 1
    && scopeOf.filter((s) => s != null && s < scopeCount).length > 1
  const selectedAttempt = scopeOf.indexOf(selected)

  return (
    <div className="lineage-row">
      <span className="lbl">lineage</span>
      <div
        className="lineage"
        role={selectable ? 'radiogroup' : 'list'}
        aria-label="Run attempts"
      >
        {attempts.map((attempt, i) => {
          const at = scopeOf[i]
          const name = `attempt ${i + 1} of ${attempts.length}`
            + ` · ${i === 0 ? 'started' : 'resumed'} ${fmtStamp(attempt.startedAt) ?? 'unknown'}`
            + ` → ${attempt.endedAt != null
              ? fmtStamp(attempt.endedAt)
              // B1: an open attempt on a run the engine abandoned has NO end to name. It is
              // not "now" — the run stopped being alive at some instant nothing recorded.
              : attempt.unknownEnd ? 'time of death not recorded' : 'now'}`
            + ` · ${attempt.state}${attempt.stub ? ' (never started)' : ''}`
            // B7: an attempt closed by the next one's start wrote no terminal event, so the
            // bar's right edge is the resume, not a death time — and it says so.
            + (attempt.closedByResume
              ? ' — wrote no terminal event; time of death not recorded, so this span ends at the resume'
              : '')
            + (attempt.unknownEnd
              ? ' — wrote no terminal event; this segment has a fixed width because its'
                + ' duration is unknown'
              : '')
            + (at != null && at === current ? ' · current' : '')
          const className = `seg-l ${attempt.stub ? 'stub' : attempt.state}`
            + (attempt.unknownEnd ? ' unknown-end' : '')
            + (at != null && at === selected && selectable ? ' picked' : '')
          // An unknown duration gets a FIXED hatched width. Its `ms` is zero by construction
          // (nothing on disk supports a number), so it neither grows through `now` nor
          // silently reads as the shortest attempt of the run.
          const style = attempt.unknownEnd
            ? { flex: '0 0 44px' }
            : { flex: Math.max(attempt.ms, 1) / total }
          if (!selectable || at == null) {
            return (
              <span
                key={`${attempt.startedAt}-${i}`} role={selectable ? 'presentation' : 'listitem'}
                className={className} style={style} title={name}
              />
            )
          }
          return (
            <button
              key={`${attempt.startedAt}-${i}`}
              type="button" role="radio" aria-checked={at === selected}
              className={className} style={style} title={name} aria-label={name}
              onClick={() => onScope?.(at)}
            />
          )
        })}
      </div>
      <span className="cap">
        {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
        {resumeCount ? ` · resumed ×${resumeCount}` : ''}
        {selectable ? (
          <>
            {' · '}
            <b className={selected === current ? undefined : 'scoped'}>
              showing attempt {selectedAttempt >= 0 ? selectedAttempt + 1 : selected + 1}
              {selected === current ? ' (current)' : ''}
            </b>
            {selected !== current ? (
              <>
                {' '}
                <button className="btn sm ghost" type="button" onClick={() => onScope?.(current)}>
                  back to current
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </span>
    </div>
  )
}

export interface AttemptSegment {
  startedAt: number
  endedAt: number | null
  state: string
  ms: number
  /** A terminal event with no start: zero-length by construction (critique N14). */
  stub: boolean
  /**
   * The attempt wrote no terminal event and the NEXT attempt started: its engine died
   * somewhere in between. The span is closed at the resume boundary — the last instant it
   * can be shown to have been alive — and its time of death stays unrecorded.
   */
  closedByResume: boolean
  /**
   * The attempt is still open AND the run is not alive (review round 3, B1): the engine went
   * away without writing a terminal `run` event, so the attempt's end is a fact nothing on
   * disk carries. `endedAt` stays `null` and `ms` is `0` — the segment is drawn at a fixed
   * hatched width, never measured through `now`.
   */
  unknownEnd: boolean
}

/**
 * Fold `attemptSpans` into drawable segments (§6.4 step 1: a `started`/`resumed` opens an
 * attempt, the next terminal state closes it).
 *
 * **A stale attempt followed by a resume closes at the resume (review round 2, B7).** Round 1
 * pushed the unterminated attempt with `endedAt: null` and a width of `now - startedAt`, so
 * an attempt that died at 10:00 and was resumed at 10:05 drew as *still running* across the
 * whole of the attempt that replaced it: two overlapping segments, both in the running
 * colour, the dead one labelled "→ now". Q7 asked "what happened on each attempt" and got a
 * false fate and a fabricated duration.
 *
 * What the file actually supports: the attempt was alive at `startedAt` and was not alive at
 * the resume, and `endedAt` is written from a terminal `run` event and from nothing else
 * (§6.2) — so there is no time of death. The segment therefore ends at the resume, is
 * coloured `stale`, and SAYS the death time is unrecorded, which is the same ruling the
 * header's `died` cell and the stale attention card already obey.
 *
 * **The LAST attempt obeys the same ruling (review round 3, B1).** Round 2 fixed only the
 * attempt a resume closed; the trailing open attempt still came out `running`, with a width
 * of `now - startedAt` and a tooltip reading `→ now`, on a run the server had already called
 * `stale`. So the same header that said "died: not recorded" drew a blue bar still growing
 * — the cockpit contradicted itself in two adjacent rows, and §2.4's "each segment coloured
 * by its terminal fate" was false for the only segment whose fate the operator came to read.
 *
 * The run's liveness is the fix: `deriveRunState` is the ONLY thing that knows whether the
 * trailing attempt is alive (it reads the `run.lock`, §6.2), and the span list provably
 * cannot. When it says the run is not live, the open attempt takes the run's fate, is marked
 * `unknownEnd`, and gets no duration at all.
 *
 * The verdict arrives as `honesty.ts`'s object rather than as a bare `RunState` (round 6):
 * this function must not be a second place where a state string is classified as alive.
 */
export function attemptSegments(
  spans: readonly AttemptSpan[],
  now: number,
  createdAt: number | null,
  honesty: RunLiveness | null = null,
): AttemptSegment[] {
  const out: AttemptSegment[] = []
  let open: AttemptSegment | null = null
  for (const span of spans) {
    if (span.state === 'started' || span.state === 'resumed') {
      if (open) {
        open.endedAt = span.t
        open.state = 'stale'
        open.ms = Math.max(0, span.t - open.startedAt)
        open.closedByResume = true
        out.push(open)
      }
      open = {
        startedAt: span.t, endedAt: null, state: 'running',
        ms: Math.max(0, now - span.t), stub: false, closedByResume: false, unknownEnd: false,
      }
      continue
    }
    if (open) {
      open.endedAt = span.t
      open.state = span.state
      open.ms = Math.max(0, span.t - open.startedAt)
      out.push(open)
      open = null
      continue
    }
    // Terminal with nothing open — the run failed during module load (N14).
    const startedAt = createdAt ?? span.t
    out.push({
      startedAt, endedAt: span.t, state: span.state,
      ms: Math.max(0, span.t - startedAt), stub: true, closedByResume: false, unknownEnd: false,
    })
  }
  if (open) {
    // The trailing attempt. A live run's last attempt IS running and its width through `now`
    // is the honest one — the elapsed clock beside it says the same number. A run the server
    // calls stale (or terminal without a terminal event on disk — §6.5's old-run case) is a
    // different animal: it takes the run's own fate and admits it has no end.
    if (honesty != null && honesty.dead && honesty.state != null) {
      open.state = honesty.state
      open.ms = 0
      open.unknownEnd = true
    }
    out.push(open)
  }
  return out
}
