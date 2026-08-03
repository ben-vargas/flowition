/**
 * §7.2's confirmation contracts, one component per row of the write-surface table.
 *
 * The table is normative and each row has a DIFFERENT contract — this file is where that
 * differentiation is spent, because a product that confirms everything the same way has
 * taught the operator to click through all of it:
 *
 *   send / answer      → no confirmation at all (they are the product; see the composers)
 *   cancel one agent   → inline arm for 3s ("Cancel agent 3?"), no modal (SteerComposer)
 *   cancel the run     → MODAL, two-step, default focus on **Keep running**
 *   resume / replay    → MODAL, distinct copy for replay-of-completed vs recover (§7.3)
 *   delete             → MODAL, **type-to-confirm the runId**, "moves to flowition's
 *                        trash; purged after 7 days"
 *
 * Shared mechanics in every one of them:
 *   • the confirming button enters a pending, DISABLED state for the request's duration
 *     (§7.2: "a double-click cannot double-cancel");
 *   • failures render the server's own words through `classifyFailure`, never a generic
 *     "request failed" — a 409 on resume means the run is running, and saying so is the
 *     difference between an operator who knows what to do next and one who retries;
 *   • the safe action is FIRST in the DOM, which is what `FocusScope autoFocus` in
 *     `Dialog.tsx` turns into §7.2's "default focus on Keep".
 */

import { useEffect, useState } from 'react'
import type { RunState } from '../../api/types.js'
import { Icon } from '../../ui/Icon.js'
import { ControlDialog } from './Dialog.js'
import { classifyFailure, failureCopy } from './verdict.js'
import type { MutationFailure } from './verdict.js'

/** What a dialog needs to know about the run it is about to change. */
export interface RunRef {
  runId: string
  name?: string | null
  state?: RunState | null
}

export interface DialogOutcome {
  /** A one-line, past-tense statement of what happened, for the §3.6 `role=status` toast. */
  message: string
  tone?: 'ok' | 'warn'
}

interface DialogBaseProps {
  run: RunRef
  onClose: () => void
  onDone?: (outcome: DialogOutcome) => void
  /**
   * §3.6's restore target, when the host knows it better than the dialog can guess — which
   * it does for a palette → confirmation chain, where the node that "opened" this dialog is
   * the palette input that is being unmounted alongside it. See `Dialog.tsx`.
   */
  restoreFocusTo?: Element | null
}

const title = (run: RunRef) => run.name ? `${run.name} (${run.runId})` : run.runId

/** The shared failure line. `role="alert"` because it is the answer to an act. */
function Failure({ failure }: { failure: MutationFailure | null }) {
  if (!failure) return null
  return (
    <p className="ctl-fail" role="alert">
      <Icon name="failed" size={12} />
      {failureCopy(failure)}
    </p>
  )
}

// ---- cancel the whole run (§7.2) ----------------------------------------------------

/**
 * "Cancel run flo_ab12? Agents in flight will be killed. [Keep running] [Cancel run]",
 * default focus on Keep — §7.2's copy, near-verbatim, because a modal whose default action
 * is the destructive one is a modal that trains people to press Enter.
 */
export function CancelRunDialog(
  { run, onClose, onDone, restoreFocusTo, cancelRunFn }: DialogBaseProps & {
    cancelRunFn: (runId: string) => Promise<{ scope?: string; cancelled?: unknown }>
  },
) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<MutationFailure | null>(null)

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const reply = await cancelRunFn(run.runId)
      // The server echoes WHICH cancel it performed (critique N5). If it ever came back
      // 'agent', this dialog would be reporting something it did not do.
      const scoped = reply?.scope === 'agent'
      onDone?.({
        message: scoped
          ? `The server cancelled a single agent, not the run — nothing else was stopped.`
          : `Cancel sent to ${run.runId}. Agents in flight are being killed; the run's own `
            + `events show them stopping.`,
        tone: scoped ? 'warn' : 'ok',
      })
      onClose()
    } catch (error) {
      setFailure(classifyFailure(error, 'cancel'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ControlDialog
      name="cancel-run"
      title={`Cancel run ${title(run)}?`}
      tone="danger"
      onClose={onClose}
      restoreFocusTo={restoreFocusTo ?? null}
      description={
        <>Agents in flight will be killed. Work they have already journaled is kept, and the
          run can be resumed afterwards — anything mid-turn is lost.</>
      }
      footer={
        <>
          {/* FIRST in the DOM = the focused default (§7.2). */}
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Keep running
          </button>
          <button
            className="btn danger" type="button" onClick={() => { void confirm() }}
            disabled={busy}
          >
            <Icon name="cancel" size={12} />{busy ? 'Cancelling…' : 'Cancel run'}
          </button>
        </>
      }
    >
      <Failure failure={failure} />
    </ControlDialog>
  )
}

// ---- resume / replay (§7.3) ---------------------------------------------------------

export interface ResumeRef extends RunRef {
  /**
   * §7.3: the modal "shows `graphDynamic` when set". Three states, and they say three
   * different things:
   *   `true`  — the engine will refuse this resume (src/engine.js:797);
   *   `false` — the engine recorded a statically verifiable graph;
   *   `null`/absent — the run predates the field (§6.5), so the viewer does not know and
   *                   must not imply either answer.
   * Projected onto `RunDetail` by `src/viewer/snapshot.js` from journal meta.
   */
  graphDynamic?: boolean | string | null
  /**
   * WHERE the tri-state above came from, because `null` alone conflates two different
   * facts and only one of them is §6.5's.
   *
   *   `'snapshot'` (default) — a `RunDetail` was read and this is what it carried, so a
   *                            `null` genuinely means the run predates the field;
   *   `'unavailable'`        — the snapshot could NOT be read (the detail request failed),
   *                            so the viewer has no basis for either sentence and says so.
   *
   * A caller that has no snapshot at all must pass `'unavailable'` rather than `null`:
   * telling the operator "this run was journalled before the engine recorded it" about a
   * current run whose graph IS dynamic suppresses §7.3's preflight-refusal warning, which
   * is the one thing this list exists to say.
   */
  graphSource?: 'snapshot' | 'unavailable'
}

/**
 * §7.3's two modals in one component, because they are the same mutation with different
 * meanings and the operator must be able to tell which one they are about to do:
 *
 *   • a COMPLETED run is a **Replay** — "re-runs the workflow; completed agents replay
 *     from the journal, no providers are re-invoked unless control flow changes";
 *   • anything else is a **Resume** — recovery of a run that stopped.
 *
 * Both state §1.3's integrity scope: the engine's own fileHash/graphHash/args preflight is
 * the gate, it covers the local graph and NOT the environment or the installed packages,
 * and the viewer neither adds to it nor bypasses it. And both are honest about the
 * response: 202 means LAUNCH ACCEPTED AND NOTHING MORE (§7.3) — the preflight's verdict
 * arrives later, in the run's own events.
 */
export function ResumeDialog(
  { run, onClose, onDone, restoreFocusTo, resumeFn }: DialogBaseProps & {
    run: ResumeRef
    resumeFn: (runId: string) => Promise<{ mode?: string; launchAccepted?: boolean }>
  },
) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<MutationFailure | null>(null)
  const replay = run.state === 'completed'

  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const reply = await resumeFn(run.runId)
      const mode = reply?.mode === 'replay' ? 'Replay' : 'Resume'
      onDone?.({
        message: `${mode} launched for ${run.runId} — launch accepted, nothing more. The `
          + `engine re-checks the workflow file, its local imports and the args before it `
          + `restarts anything; its verdict arrives in this run's events.`,
      })
      onClose()
    } catch (error) {
      setFailure(classifyFailure(error, 'resume'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ControlDialog
      name="resume"
      title={replay ? `Replay ${title(run)}?` : `Resume ${title(run)}?`}
      onClose={onClose}
      restoreFocusTo={restoreFocusTo ?? null}
      description={replay
        ? <>This run completed. Replaying re-runs the workflow; completed agents replay from
            the journal, and no providers are re-invoked unless control flow changes.</>
        : <>Restarts this run in a detached process. Completed agents replay from their keys;
            everything unfinished runs again.</>}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Leave it stopped
          </button>
          <button
            className="btn primary" type="button" onClick={() => { void confirm() }}
            disabled={busy}
          >
            <Icon name="resume" size={12} />
            {busy ? 'Launching…' : replay ? 'Replay run' : 'Resume run'}
          </button>
        </>
      }
    >
      <ul className="ctl-facts">
        <li>
          <b>The integrity check is the engine&apos;s.</b> It compares the workflow file, its
          local imports and the args against what this run recorded. It does <b>not</b> cover
          your environment, your installed packages or anything the agents touched on disk.
        </li>
        {run.graphDynamic ? (
          <li data-fact="graph-dynamic">
            <b>This run&apos;s graph was dynamic</b>
            {typeof run.graphDynamic === 'string' ? ` (${run.graphDynamic})` : ''} — the engine
            refuses to resume a run whose module graph it cannot verify, so this launch is
            likely to be refused by the preflight.
          </li>
        ) : run.graphDynamic === false ? (
          <li data-fact="graph-static">
            This run recorded a <b>statically verifiable module graph</b>, so the preflight
            has a graph hash to compare against.
          </li>
        ) : run.graphSource === 'unavailable' ? (
          // The snapshot could not be read. That is a fact about THIS VIEWER's last request,
          // not about the run, and the two must not share a sentence: §6.5's copy below
          // would tell the operator the field is absent from disk when nothing looked.
          <li className="dim" data-fact="graph-unreadable">
            This viewer could not read the run&apos;s snapshot, so it cannot say whether the
            module graph was dynamic. If it was, the engine refuses the resume — the
            preflight&apos;s verdict arrives in the run&apos;s events either way.
          </li>
        ) : (
          // Old runs only (§6.5): `meta.graphDynamic` did not exist before the engine
          // change at src/engine.js:832, so there is nothing on disk to report. Saying so
          // beats claiming a static graph nothing verified.
          <li className="dim" data-fact="graph-unknown">
            This run was journalled before the engine recorded whether its module graph was
            dynamic — if it was, the engine refuses the resume and says so in the run&apos;s
            events.
          </li>
        )}
        <li>
          The response means <b>launch accepted</b> and nothing more. Whether the preflight
          passes shows up in this run&apos;s state and events moments later.
        </li>
      </ul>
      <Failure failure={failure} />
    </ControlDialog>
  )
}

// ---- delete (§7.3) ------------------------------------------------------------------

/**
 * Type-to-confirm, exactly as §7.2's table requires: the operator types the runId, and the
 * copy states what delete actually is — "moves to flowition's trash; purged after 7 days".
 *
 * The typing gate is not theatre. A run id is the one string that distinguishes this run
 * from the one beside it in the rail, and a delete taken against the wrong one is the only
 * mutation in the product whose evidence goes away with it (which is why §7.3 also writes
 * the audit line outside the run, before the rename).
 */
export function DeleteDialog(
  { run, onClose, onDone, restoreFocusTo, deleteFn }: DialogBaseProps & {
    deleteFn: (runId: string) => Promise<{ trashEntry?: string; trashTtlDays?: number }>
  },
) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<MutationFailure | null>(null)
  const matches = typed === run.runId

  const confirm = async () => {
    if (busy || !matches) return
    setBusy(true)
    setFailure(null)
    try {
      const reply = await deleteFn(run.runId)
      const days = reply?.trashTtlDays ?? 7
      onDone?.({
        message: `${run.runId} moved to flowition's trash${
          reply?.trashEntry ? ` as ${reply.trashEntry}` : ''} — purged after ${days} days. `
          + `\`flowition rm --purge\` empties the trash now.`,
      })
      onClose()
    } catch (error) {
      setFailure(classifyFailure(error, 'delete'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ControlDialog
      name="delete"
      title={`Delete ${title(run)}?`}
      tone="danger"
      onClose={onClose}
      restoreFocusTo={restoreFocusTo ?? null}
      description={
        <>This moves the run to flowition&apos;s trash; it is purged after 7 days. Until then
          it can be restored by hand, and <span className="mono">flowition rm --purge</span>
          {' '}empties the trash immediately.</>
      }
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>Keep it</button>
          <button
            className="btn danger" type="button" onClick={() => { void confirm() }}
            disabled={busy || !matches}
            title={matches ? undefined : 'type the run id to confirm'}
          >
            <Icon name="trash" size={12} />{busy ? 'Deleting…' : 'Delete run'}
          </button>
        </>
      }
    >
      <form
        className="ctl-typed"
        onSubmit={(event) => { event.preventDefault(); void confirm() }}
      >
        <label htmlFor="ctl-delete-confirm">
          Type <span className="mono strong">{run.runId}</span> to confirm
        </label>
        <input
          className="inp" id="ctl-delete-confirm" value={typed} autoComplete="off"
          spellCheck={false} disabled={busy}
          onChange={(event) => setTyped(event.target.value)}
        />
      </form>
      <p className="ctl-note">
        A live run is refused by the server whatever is typed here: delete takes the run
        lock, re-derives the run&apos;s state under it, and refuses anything running or
        starting.
      </p>
      <Failure failure={failure} />
    </ControlDialog>
  )
}

/** The §3.6 `role="status"` toast a completed lifecycle mutation leaves behind. */
/**
 * How long a toast stays. Scaled to its own copy, because these are not one-word toasts:
 * the resume outcome is two sentences about what "launch accepted" does and does not mean,
 * and dismissing it in the four seconds a short one deserves would be dismissing it unread.
 * ~18 characters per second is the usual reading-rate figure, floored and capped.
 */
export const TOAST_MIN_MS = 6_000
export const TOAST_MAX_MS = 14_000
export const toastDurationMs = (message: string): number =>
  Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS, Math.round((message.length / 18) * 1_000)))

export function Toasts(
  { items, onDismiss }: {
    items: { id: number; message: string; tone?: 'ok' | 'warn' }[]
    onDismiss: (id: number) => void
  },
) {
  if (!items.length) return null
  return (
    // `pointer-events: none` on the layer, `auto` on each toast (control.css): the GAPS
    // between and around toasts stop being a click shield over whatever is beneath them.
    // The toast body itself still takes its own clicks — it has a Dismiss button — so this
    // is not the whole non-occlusion fix, only the half that CSS can guarantee. The other
    // half is `--action-floor` (actionFloor.ts), which keeps the stack off the bottom-docked
    // composer entirely rather than merely letting clicks through it.
    <div className="ctl-toasts">
      {items.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

/**
 * One toast, and its own clock.
 *
 * §3.6 keeps `role=status` (announced politely, never focus-stealing). W15 adds the timeout
 * the shipped one never had — a reviewer watched the resume toast sit over the transcript
 * for several minutes — with the two pauses that make an auto-dismissing notice acceptable
 * rather than a race the operator can lose: it does not expire while the pointer is over it,
 * and it does not expire while focus is inside it (the Dismiss button). The explicit Dismiss
 * remains, so nothing here is the only way to get rid of one.
 */
function Toast(
  { toast, onDismiss }: {
    toast: { id: number; message: string; tone?: 'ok' | 'warn' }
    onDismiss: (id: number) => void
  },
) {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (held) return
    const timer = setTimeout(() => onDismiss(toast.id), toastDurationMs(toast.message))
    return () => clearTimeout(timer)
  }, [held, toast.id, toast.message, onDismiss])
  return (
    <div
      className={`ctl-toast${toast.tone === 'warn' ? ' warn' : ''}`} role="status"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span>{toast.message}</span>
      <button
        className="icb sm" type="button" aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}
