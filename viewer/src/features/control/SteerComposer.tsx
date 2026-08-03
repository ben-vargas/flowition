/**
 * The transcript footer's steer composer and per-agent Cancel (DESIGN §2.5, §7.2).
 *
 * §2.5 is exact about when this is usable: "the steer composer is enabled **iff the agent's
 * folded state is exactly `running`**" — the engine's `findJob` resolves only jobs inside
 * `sem.with` (src/engine.js:670, :948), so a queued agent is not steerable and a settled one
 * has no turn left to consume mail. The composer therefore has four states and NONE of them
 * is "hidden":
 *
 *   running  → enabled. ⌘↵ sends. The delivery verdict lands inline, verbatim.
 *   queued   → disabled, "agent hasn't started yet — steering opens when it runs", plus its
 *              queue position (from the E4 queue data; when the run predates E4 the position
 *              is stated as unknown rather than invented).
 *   settled  → disabled, and honest about why: a send would come back `dropped`.
 *   locked   → disabled with §7.2's explanation chip (`--control=send`).
 *
 * The verdict is the point of the whole surface. `live`/`queued`/`replayed` are deliveries
 * of different strength and `dropped` means the message went nowhere; a composer that
 * flashed "sent" for all five would be lying in four of them. Each send appends a receipt
 * with the engine's own word and the sentence that explains it (`verdict.ts`), and the
 * message itself appears in the transcript when the engine journals its `mail-in` record —
 * this UI never fabricates that row.
 *
 * Per-agent cancel is §7.2's inline arm, not a modal: the button arms for 3 seconds
 * ("Cancel agent 3?"), a second press sends, and a queued agent's button is labelled
 * "Remove from queue" because the engine's abort covers admission.
 */

import { useEffect, useRef, useState } from 'react'
import type { AgentView, RunDetail } from '../../api/types.js'
import { Icon } from '../../ui/Icon.js'
import { capabilityState } from './capabilities.js'
import { LockChip } from './Locked.js'
import { classifyFailure, describeVerdict, failureCopy } from './verdict.js'
import type { MutationFailure, VerdictCopy } from './verdict.js'

/** §7.2's arm window for the inline per-agent cancel. */
export const ARM_MS = 3000

export interface SteerComposerProps {
  runId: string
  detail: RunDetail
  agent: AgentView
  /** The run's own liveness verdict — a dead run's `running` agent is orphaned, not live. */
  runLive: boolean
  capabilities: readonly string[] | null
  capabilityError?: string | null
  sendFn: (runId: string, agent: number | string, message: string) => Promise<{ delivery?: string | null }>
  cancelAgentFn: (runId: string, agent: number | string) => Promise<{ scope?: string; cancelled?: unknown }>
  /** Re-read the run after a cancel — the agent's state change arrives with the snapshot. */
  onChanged?: () => void
}

interface Receipt {
  id: number
  message: string
  copy: VerdictCopy
}

/**
 * Queue position from the fold's own data (§2.5's "queue position from the E4 `sem` gauge").
 *
 * Rank among the agents still queued, ordered by `queuedAt` — which is exactly the order the
 * semaphore admits them in. Returns `null` when the run predates E4 (`queueEvents` is not
 * `supported`, or this agent has no `queuedAt`): §6.5 forbids inventing the number, and "3rd
 * in the queue" is a claim, not a decoration.
 */
export function queuePosition(detail: RunDetail, agent: AgentView): number | null {
  if (detail.caps?.queueEvents !== 'supported') return null
  if (agent.queuedAt == null) return null
  const queued = detail.agents
    .filter((a) => a.state === 'queued' && a.queuedAt != null)
    .sort((a, b) => a.queuedAt! - b.queuedAt! || a.index - b.index)
  const at = queued.findIndex((a) => a.index === agent.index)
  return at < 0 ? null : at + 1
}

export function SteerComposer(props: SteerComposerProps) {
  const { agent, detail, runId } = props
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<MutationFailure | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const nextId = useRef(1)

  const sendState = capabilityState(props.capabilities, 'send')
  const steerable = props.runLive && agent.state === 'running' && agent.displayState !== 'orphaned'
  const settled = agent.state !== 'running' && agent.state !== 'queued'
  const position = agent.state === 'queued' ? queuePosition(detail, agent) : null
  // §7.2's gate, fail-closed (review round 5, B1): a composer that has not been GRANTED
  // `send` is inert, whether the session said no or has not said anything. Steering text is
  // an instruction to a process running with full permissions (§7.2, §7.4); it is not a
  // control to offer on the strength of an unanswered permission check.
  const enabled = steerable && sendState === 'allowed'

  const submit = async () => {
    if (!enabled || busy || !value.trim()) return
    const message = value
    setBusy(true)
    setFailure(null)
    try {
      const reply = await props.sendFn(runId, agent.index, message)
      setValue('')
      setReceipts((current) => [
        ...current.slice(-3),
        { id: nextId.current++, message, copy: describeVerdict(reply?.delivery ?? null) },
      ])
    } catch (error) {
      setFailure(classifyFailure(error, 'send'))
    } finally {
      setBusy(false)
    }
  }

  const label = agent.label ?? `agent ${agent.index}`

  return (
    <div className="steer">
      <form
        className="steer-form"
        onSubmit={(event) => { event.preventDefault(); void submit() }}
      >
        <label className="vh" htmlFor={`steer-${agent.index}`}>Steer {label}</label>
        <input
          className="inp steer-inp" id={`steer-${agent.index}`} value={value} autoComplete="off"
          disabled={!enabled || busy}
          placeholder={enabled ? `steer ${label}…` : 'steering unavailable'}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault(); void submit()
            }
          }}
        />
        <button
          className="btn primary" type="submit"
          disabled={!enabled || busy || !value.trim()}
        >
          <Icon name="send" size={12} />{busy ? 'Sending…' : 'Send'}
        </button>
        <CancelAgentButton {...props} />
      </form>

      <div className={`steer-why${failure ? ' bad' : ''}`} {...(failure ? { role: 'alert' } : {})}>
        {failure ? failureCopy(failure) : null}
        {!failure && sendState !== 'allowed' ? (
          <LockChip
            capabilities={props.capabilities} capability="send"
            capabilityError={props.capabilityError ?? null}
          />
        ) : null}
        {!failure && sendState === 'allowed' && !steerable ? (
          <span className="dim micro">
            {agent.state === 'queued'
              ? (
                <>
                  agent hasn&apos;t started yet — steering opens when it runs
                  {position != null
                    ? ` · ${position === 1 ? 'next in the queue' : `${position} in the queue`}`
                    : detail.caps?.queueEvents === 'supported'
                      ? ''
                      : ' · queue position unavailable — this run was recorded by an older engine'}
                </>
              )
              : settled
                ? 'this agent has settled — a message sent now would come back `dropped`'
                : 'the run is not live — a message sent now would not reach the engine'}
          </span>
        ) : null}
        {!failure && enabled ? <span className="dim micro">⌘↵ sends</span> : null}
      </div>

      {receipts.length ? (
        <ul className="steer-receipts" aria-label="Delivery verdicts">
          {receipts.map((receipt) => (
            <li className={`receipt t-${receipt.copy.tone}`} key={receipt.id} role="status">
              <span className={`verdict-chip t-${receipt.copy.tone}`}>{receipt.copy.label}</span>
              <span className="rc-msg">{receipt.message}</span>
              <span className="rc-why">{receipt.copy.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * §7.2's per-agent cancel: an inline arm rather than a modal, and a 3-second window rather
 * than a sticky armed state — an armed destructive button that waits forever is a mis-click
 * looking for a place to happen.
 */
function CancelAgentButton(props: SteerComposerProps) {
  const { agent } = props
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<MutationFailure | null>(null)
  const [done, setDone] = useState(false)
  const cancelState = capabilityState(props.capabilities, 'cancel')
  const cancellable = props.runLive
    && (agent.state === 'running' || agent.state === 'queued')
    && agent.displayState !== 'orphaned'
  const queued = agent.state === 'queued'

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(timer)
  }, [armed])

  /**
   * "Esc or wait to disarm" — the promise the armed hint makes, kept (review round 1, M1;
   * §2.7's "Esc closes panel / drawer" reads the same way here: Escape dismisses the
   * innermost transient thing on screen, and an armed destructive button is exactly that).
   *
   * On `window` and in the CAPTURE phase because the armed state is not a DOM subtree the
   * operator has to be standing in: focus may be in the steer input beside it, or on the
   * armed button itself, and either way Escape must disarm rather than reach whatever else
   * handles Escape on this screen (the transcript's search bar, the narrow inbox drawer).
   * Capture also means it consumes the key, so one Escape does one thing.
   *
   * The exception is a modal: `aria-modal` is a promise that nothing behind the dialog is
   * live, so while one is up Escape belongs to it and this stays out of the way.
   */
  useEffect(() => {
    if (!armed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[data-dialog]')) return
      event.preventDefault()
      event.stopPropagation()
      setArmed(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [armed])

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const reply = await props.cancelAgentFn(props.runId, agent.index)
      setArmed(false)
      // The server tells us WHICH cancel it performed (critique N5). A per-agent request
      // that came back run-scoped is a fact the operator must see, not one to swallow.
      setDone(true)
      if (reply?.scope === 'run') {
        setFailure({
          kind: 'conflict',
          message: 'the server cancelled the WHOLE RUN, not just this agent',
          refresh: true,
        })
      }
      props.onChanged?.()
    } catch (error) {
      setArmed(false)
      setFailure(classifyFailure(error, 'cancel'))
    } finally {
      setBusy(false)
    }
  }

  // Fail-closed, like the composer beside it: only an explicit `cancel` grant arms this
  // button. The chip below carries which of the two refusals it is.
  if (cancelState !== 'allowed' || !cancellable) {
    const why = cancelState !== 'allowed'
      ? undefined
      : props.runLive
        ? 'this agent has already settled'
        : 'the run is not live'
    return (
      <span className="steer-cancel">
        <button className="btn" type="button" disabled title={why}>
          <Icon name="cancel" size={12} />{queued ? 'Remove from queue' : 'Cancel agent'}
        </button>
        {cancelState !== 'allowed' ? (
          <LockChip
            capabilities={props.capabilities} capability="cancel"
            capabilityError={props.capabilityError ?? null} compact
          />
        ) : null}
        {/*
          The operator's own confirmation OUTLIVES the agent it was aimed at.
          `cancellable` goes false the moment the next snapshot reports the agent settled
          — which, after a cancel that worked, is immediately, and can even beat the
          reply: the engine writes the `cancelled` event before it answers, so the
          settle can arrive over the live feed first. Rendering the verdict only in the
          armable branch made "did that land?" a race the operator could lose through no
          fault of their own, and it is the same race that made the walkthrough's
          `cancel sent` assertion flaky (round 4, item 12). A verdict about a request THIS
          session made is not conditional on the target's current state.
        */}
        {failure ? <span className="hint bad" role="alert">{failureCopy(failure)}</span> : null}
        {!failure && done ? (
          <span className="hint" role="status">
            cancel sent — the agent&apos;s own events carry what happened
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <span className="steer-cancel">
      {armed ? (
        <button
          className="btn arm danger" type="button" disabled={busy}
          onClick={() => { void cancel() }}
        >
          <Icon name="cancel" size={12} />
          {/*
            §7.2's confirmation is "Cancel agent 3?" — the CANONICAL INDEX, always, label or
            no label (review round 1, B2). The index is the engine's own identity for the
            agent (`{cmd:'cancel', agent}` takes it, src/engine.js:711) and it is unique for
            the life of the run; a label is neither. Two agents can carry the same label, a
            label can change between attempts, and "Cancel auditor?" over a destructive
            action then names a target the operator cannot resolve to the thing that is about
            to be killed. The label is already on the pane's own heading an inch above.
          */}
          {busy
            ? 'Cancelling…'
            : queued
              ? `Remove agent ${agent.index} from the queue?`
              : `Cancel agent ${agent.index}?`}
        </button>
      ) : (
        <button
          className="btn" type="button" disabled={busy || done}
          onClick={() => { setFailure(null); setArmed(true) }}
        >
          <Icon name="cancel" size={12} />{queued ? 'Remove from queue' : 'Cancel agent'}
        </button>
      )}
      {failure ? <span className="hint bad" role="alert">{failureCopy(failure)}</span> : null}
      {!failure && done ? (
        <span className="hint" role="status">
          cancel sent — the agent&apos;s own events carry what happened
        </span>
      ) : null}
      {!failure && !done && armed ? (
        <span className="hint">press again within 3s · Esc or wait to disarm</span>
      ) : null}
    </span>
  )
}
