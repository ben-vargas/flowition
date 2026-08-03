/**
 * The cockpit's INTERACTIVE inbox rail (DESIGN §2.4, §7.2) — W12's replacement for the
 * read-only rail W11 built as §3.7's third column.
 *
 * W11's header says it plainly: the column's frame is W11's so the approved comp composes,
 * and "the one thing that needs the §7.2 control bridge — the answer composer — is left as
 * an explicit, labelled slot rather than faked". This is that slot, filled: same three
 * registers in the same order, same class vocabulary (so `cockpit.css` still draws it), with
 * a live answer composer on every unanswered `ask()`.
 *
 *   (1) Questions       — unanswered first, question text inline, **answer composer**.
 *                         Answered ones collapse to a history row carrying the value (E7).
 *   (2) Agent reports   — `mail` with `dir:'out'`, newest first, each linking to its agent.
 *   (3) Steering history— `dir:'in'` with origin, **delivery verdict rendered through the
 *                         §7.2 vocabulary** (`verdict.ts`) and the journaled callsite.
 *
 * The answer flow, precisely (§7.2's row):
 *   • no confirmation — "answering is the product";
 *   • optimistic: the question greys the instant the answer is SUBMITTED (not when the POST
 *     resolves — the bridge budgets 2000 ms and the operator must not be left wondering for
 *     any of them) and reconciles when the snapshot reports the `answer` event. A retryable
 *     failure rolls the grey back with the text still in the box;
 *   • a 409 is NOT this operator's failure. §7.2 reads it as *another operator answered
 *     first*, so the card says exactly that and asks the run for a fresh snapshot. This is
 *     the same bug class W8b's multi-question attention card hit from the other side (a
 *     stale snapshot re-offering an answered qid), and the cure here is structural: every
 *     open question owns its own composer keyed by qid, so there is no "current question"
 *     to go stale.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { FocusScope } from '@react-aria/focus'
import type { MailView, QuestionView, RunDetail } from '../../api/types.js'
import { href } from '../../app/router.js'
import { timeAgo } from '../../format/fmt.js'
import { isTypingTarget } from '../../theme/theme.js'
import { Icon } from '../../ui/Icon.js'
import { AdapterBadge, StatusGlyph } from '../../ui/Status.js'
import { useRunHonesty } from '../cockpit/honesty.js'
import { openQuestionsOf } from '../cockpit/InboxRail.js'
import {
  ANSWER_COMPOSER, answerFocusPending, cancelAnswerFocus, claimAnswerFocus,
  requestAnswerFocus, subscribeAnswerFocus,
} from './answerFocus.js'
import { capabilityState, gatedPlaceholder } from './capabilities.js'
import { useModalSurface } from './Dialog.js'
import { LockChip } from './Locked.js'
import { classifyFailure, describeVerdict, failureCopy } from './verdict.js'
import type { MutationFailure } from './verdict.js'

export interface ControlInboxRailProps {
  detail: RunDetail
  now: number
  /** Narrow (<900px): the rail is an overlay drawer behind a 44px handle (parity #42). */
  narrow: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  capabilities: readonly string[] | null
  capabilityError?: string | null
  /** `api.answer`, injectable so the DOM tests never touch fetch. */
  answerFn: (runId: string, qid: string, value: unknown) => Promise<unknown>
  /** Ask the run store for a fresh snapshot — used after an answer and after a 409. */
  onAnswered?: () => void
}

const byNewest = (a: MailView, b: MailView) => b.at - a.at

export function ControlInboxRail(props: ControlInboxRailProps) {
  const { detail, now, narrow } = props
  const honesty = useRunHonesty(detail, now)
  const questions = detail.questions ?? []
  const openQuestions = openQuestionsOf(detail, honesty)
  const reports = (detail.mail ?? []).filter((m) => m.dir === 'out').sort(byNewest)
  const steers = (detail.mail ?? []).filter((m) => m.dir === 'in').sort(byNewest)
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const handle = useRef<HTMLButtonElement>(null)

  /**
   * Every qid this rail has answered successfully, and every qid the server said someone
   * else had already answered. Both are LOCAL TRUTH that is newer than the snapshot: the
   * engine has to journal the answer before a poll can report it, so without this the same
   * question re-renders as answerable for one interval and the next Send 409s.
   */
  const [settled, setSettled] = useState<Record<string, 'answered' | 'taken'>>({})
  // A different run is a different set of questions; qids do not carry across one.
  const forRun = useRef(detail.runId)
  if (forRun.current !== detail.runId) {
    forRun.current = detail.runId
    if (Object.keys(settled).length) setSettled({})
  }

  /**
   * §7.2's reconciliation, committed: once the snapshot carries the run's own `answer` event
   * for a qid, this rail's local record has done its job and is dropped — the row renders from
   * the RUN from then on. Until that happens the record keeps the row grey-and-pending, which
   * is the point: an accepted POST is not the event the contract reconciles on.
   */
  useEffect(() => {
    const recorded = Object.keys(settled)
      .filter((qid) => questions.some((q) => q?.qid === qid && q.answered))
    if (!recorded.length) return
    setSettled((current) => {
      const next = { ...current }
      for (const qid of recorded) delete next[qid]
      return next
    })
  }, [questions, settled])

  const close = useCallback(() => { props.onClose() }, [props])

  /**
   * §2.7's answer-focus contract, for BOTH the surfaces that make it — the `a` key here and
   * the palette's "Answer the first open question" — through one durable intent
   * (`answerFocus.ts`).
   *
   * Round 3 solved this locally, with a `wantsFocus` ref: press `a`, open the rail, focus
   * the composer on the commit that mounted it. That works for a key this component itself
   * handles and cannot work for the palette, which is a focus-trapped modal in a different
   * subtree — it closes, runs its action synchronously while its `FocusScope` still owns
   * focus, and does not re-render this rail at all. The ref is therefore replaced by the
   * module-level intent, which survives both the modal's unmount and this component's lack
   * of a render, and the rail's job splits in two:
   *
   *   • ANNOUNCED (`subscribeAnswerFocus`) — an intent was just recorded and this rail may
   *     not be about to re-render. If the composer is not in the document, open the rail;
   *     that is a state change, so the commit it causes brings us to the second half. It
   *     deliberately does not focus: the requester may still be mounted.
   *   • EVERY COMMIT — if an intent for this run is still pending, try to satisfy it. Once
   *     the composer exists this focuses it; when the run has nothing open (an intent that
   *     can never be satisfied) it is dropped rather than left armed.
   */
  const announced = useRef<() => void>(() => {})
  announced.current = () => {
    if (document.querySelector(ANSWER_COMPOSER)) return
    if (openQuestions.length) props.onOpen()
  }
  useEffect(() => {
    const off = subscribeAnswerFocus(() => announced.current())
    // An intent for THIS run outlives a modal, not the screen. When this rail goes away the
    // operator has left the run (or the run changed underneath them), and an ask nobody can
    // serve must not sit armed waiting for an unrelated inbox to mount.
    return () => { off(); if (answerFocusPending(detail.runId)) cancelAnswerFocus() }
  }, [detail.runId])
  useEffect(() => {
    if (!answerFocusPending(detail.runId)) return
    claimAnswerFocus(detail.runId)
    // A claim that found a composer consumes the intent whether or not the composer would
    // take focus (a locked one will not), so there is nothing left to arrange.
    if (!answerFocusPending(detail.runId)) return
    // No composer in the document. The only thing this rail can do about that is open; if
    // it is already open and still has none, nothing later will produce one, so the intent
    // is dropped rather than left armed for an unrelated screen to trip over.
    if (openQuestions.length && !props.open) props.onOpen()
    else cancelAnswerFocus()
  })

  // §2.7: `a` focuses the first open question's answer box. Ignored while typing (so it can
  // be typed INTO an answer), and it opens the rail first when the rail is collapsed — a
  // shortcut that focuses something invisible is a shortcut that does nothing. Nothing is
  // trapping focus on this path, so the claim is attempted immediately and the intent only
  // has to survive when the rail has to open first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 'a' || isTypingTarget(event.target)) return
      if (!openQuestions.length && !document.querySelector(ANSWER_COMPOSER)) return
      requestAnswerFocus(detail.runId)
      claimAnswerFocus(detail.runId)
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail.runId, openQuestions.length])

  const onAnswered = useCallback((qid: string, outcome: 'answered' | 'taken') => {
    setSettled((current) => ({ ...current, [qid]: outcome }))
    props.onAnswered?.()
  }, [props])

  const answerable = capabilityState(props.capabilities, 'answer')

  const body = (
    <>
      <div className="sect">
        <h2 className="lbl" id={titleId} tabIndex={-1} ref={heading}>inbox</h2>
        <span className="count">
          {openQuestions.length ? `${openQuestions.length} open` : 'nothing open'}
        </span>
        <div className="sect-right">
          {answerable === 'allowed' ? null : (
            <LockChip
              capabilities={props.capabilities} capability="answer"
              capabilityError={props.capabilityError ?? null} compact
            />
          )}
          <button
            className="icb" type="button"
            aria-label={narrow ? 'Close inbox rail' : 'Collapse inbox rail'}
            onClick={narrow ? close : props.onClose}
          >
            <Icon name={narrow ? 'close' : 'chevron'} size={14} />
          </button>
        </div>
      </div>
      <div className="scroller">
        <Group label="questions" count={`${openQuestions.length} / ${questions.length}`}>
          {questions.length === 0 ? (
            <p className="ib-empty">
              This run has not called <span className="mono">ask()</span>.
            </p>
          ) : null}
          {[...questions]
            .sort((a, b) => Number(a.answered) - Number(b.answered) || a.askedAt - b.askedAt)
            .map((question) => (
              <Question
                key={question.qid}
                runId={detail.runId}
                question={question}
                now={now}
                abandoned={honesty.abandoned(question)}
                settled={settled[question.qid] ?? null}
                capabilities={props.capabilities}
                capabilityError={props.capabilityError ?? null}
                answerFn={props.answerFn}
                onAnswered={onAnswered}
              />
            ))}
        </Group>

        <Group label="agent reports" count={String(reports.length)} note="mail dir:out">
          {reports.length === 0 ? <p className="ib-empty">No agent has reported back.</p> : null}
          {reports.map((mail, i) => (
            <div className="mitem" key={mail.mailId ?? `out-${i}`}>
              <div className="mh">
                <AdapterBadge name={adapterOf(detail, mail.agent)} />
                {mail.agent != null ? (
                  <a className="who" href={href.agent(detail.runId, mail.agent)}>
                    {labelOf(detail, mail.agent)}
                  </a>
                ) : <span className="who">the run</span>}
                <span className="ago">{timeAgo(mail.at, now)}</span>
              </div>
              <div className="mb">{mail.message}</div>
            </div>
          ))}
        </Group>

        <Group label="steering history" count={String(steers.length)} note="mail dir:in">
          {steers.length === 0 ? <p className="ib-empty">Nothing has been steered.</p> : null}
          {steers.map((mail, i) => {
            const verdict = describeVerdict(mail.delivery)
            return (
              <div className="mitem" key={mail.mailId ?? `in-${i}`}>
                <div className="mh">
                  <Icon name="steered" size={14} />
                  <span className="who">{mail.origin ?? 'unknown origin'}</span>
                  {mail.agent != null ? (
                    <a className="badge" href={href.agent(detail.runId, mail.agent)}>
                      → agent {mail.agent}
                    </a>
                  ) : <span className="badge">run-scoped</span>}
                  <span className="ago">{timeAgo(mail.at, now)}</span>
                </div>
                <div className="mb">{mail.message}</div>
                <div className="mf">
                  {mail.delivery
                    ? (
                      <span
                        className={`verdict ${mail.delivery} t-${verdict.tone}`}
                        title={verdict.detail}
                      >
                        {verdict.label}
                      </span>
                    )
                    : <span className="dim">no delivery verdict journalled</span>}
                  {mail.callsite
                    ? <span title="the only workflow source position on disk">{mail.callsite}</span>
                    : <span className="dim">no callsite journalled</span>}
                </div>
              </div>
            )
          })}
        </Group>
      </div>
    </>
  )

  const strip = (
    <div className="col strip inbox-strip">
      <button
        className="icb" type="button" ref={handle}
        aria-label={narrow ? 'Open inbox rail' : 'Expand inbox rail'}
        aria-expanded={props.open}
        onClick={props.onOpen}
      >
        <Icon name={narrow ? 'mail' : 'chevron'} size={14} className={narrow ? undefined : 'flip'} />
      </button>
      {openQuestions.length ? <span className="dotn">{openQuestions.length}</span> : null}
      <span className="vlbl">inbox</span>
    </div>
  )

  if (!narrow) {
    if (!props.open) return strip
    return <aside className="col inbox" aria-label="Inbox">{body}</aside>
  }

  return (
    <>
      {strip}
      {props.open ? (
        <InboxDrawer onClose={close} labelledBy={titleId} heading={heading} handle={handle}>
          {body}
        </InboxDrawer>
      ) : null}
    </>
  )
}

/**
 * The narrow (<900px) rail, as a MODAL overlay — §3.7's "rails become drawers" plus §3.6's
 * modal contract, which is not satisfied by `role="dialog" aria-modal="true"` alone.
 *
 * Round 1 hand-wired the four behaviors this needs (role, Escape, scrim dismissal, focus
 * restoration) and reached for React Aria only for `FocusScope`. Two of them were then
 * simply absent: the page behind the drawer still scrolled, and it was still fully present
 * for a screen reader — so `aria-modal="true"` was a claim nothing kept, and a VoiceOver
 * user could walk straight out of the "modal" into the cockpit underneath. §16.3 names the
 * remedy and `Dialog.tsx` already had it, so this shares that composition verbatim through
 * `useModalSurface`: `useDialog` + `useOverlay` + `usePreventScroll` + `ariaHideOutside` +
 * `FocusScope contain`.
 *
 * It is a separate component because the hooks must not run when the rail is docked (the
 * ≥900px case is not a modal and must not freeze the page's scroll); mounting them with
 * the drawer is what makes "only while open" structural rather than a condition inside a
 * hook that cannot have one.
 *
 * Two things stay this file's:
 *   • **initial focus is the HEADING**, not the first tab stop — §3.6 says "opening a panel
 *     moves focus to its header", and the header is `tabIndex={-1}` precisely so it can
 *     take that focus without becoming a tab stop;
 *   • **the scrim is wired twice**, for the reason `Dialog.tsx` documents at length:
 *     `useOverlay`'s outside-press detection goes through pointer events that jsdom does
 *     not deliver identically, and §16.5 names drawer-scrim focus restoration as the path
 *     that regressed once. Two paths into one idempotent `onClose` cannot double-close.
 *
 * The restore target is the 44px handle rather than "whatever was focused", because the
 * handle is the thing the drawer replaced on screen — and it is passed explicitly, since
 * by the time this mounts the handle may not be `document.activeElement` (the `a` shortcut
 * opens the rail from anywhere).
 */
function InboxDrawer(
  { onClose, labelledBy, heading, handle, children }: {
    onClose: () => void
    labelledBy: string
    heading: RefObject<HTMLHeadingElement | null>
    handle: RefObject<HTMLButtonElement | null>
    children: ReactNode
  },
) {
  const { ref, underlayProps, surfaceProps } = useModalSurface<HTMLDivElement>({
    onClose,
    restoreFocusTo: handle.current,
    initialFocus: () => heading.current,
  })
  return (
    <>
      <div
        className="inbox-scrim"
        data-scrim="inbox"
        {...underlayProps}
        onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      />
      <FocusScope contain>
        <div
          {...surfaceProps}
          ref={ref}
          className="col inbox drawer"
          aria-modal="true"
          aria-labelledby={labelledBy}
        >
          {children}
        </div>
      </FocusScope>
    </>
  )
}

function Group(
  { label, count, note, children }: {
    label: string; count: string; note?: string; children: ReactNode
  },
) {
  return (
    <div className="inbox-group">
      <div className="sect">
        <span className="lbl">{label}</span>
        <span className="count">{count}</span>
        {note ? <span className="dim micro mono">{note}</span> : null}
      </div>
      {children}
    </div>
  )
}

/**
 * One question. Unanswered → text plus its own composer; answered → a history row carrying
 * the value (E7); abandoned → the honest dead end, with no composer to press.
 *
 * `settled` is this rail's own record of what it did (or what the server said someone else
 * did) since the snapshot was taken, and it wins over `question.answered` for exactly one
 * poll interval. Without it the operator answers, watches the same box stay live, answers
 * again, and gets a 409 for their trouble.
 */
function Question(
  { runId, question, now, abandoned, settled, capabilities, capabilityError, answerFn, onAnswered }: {
    runId: string
    question: QuestionView
    now: number
    abandoned: boolean
    settled: 'answered' | 'taken' | null
    capabilities: readonly string[] | null
    capabilityError: string | null
    answerFn: ControlInboxRailProps['answerFn']
    onAnswered: (qid: string, outcome: 'answered' | 'taken') => void
  },
) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<MutationFailure | null>(null)
  const inputId = useId()
  const state = capabilityState(capabilities, 'answer')
  /**
   * §7.2's gate, fail-closed: the composer is operable only on an explicit grant. `locked`
   * and `unknown` both produce an inert composer — they differ in the sentence beneath it
   * and in the placeholder, never in what the operator can do (review round 5, B1).
   */
  const operable = state === 'allowed'
  const placeholder = gatedPlaceholder(capabilities, 'answer', capabilityError, 'your answer')

  /**
   * §7.2's answer row, verbatim: "Optimistic UI: question greys instantly, reconciles on
   * the `answer` event."
   *
   * INSTANTLY means on submission — not on the POST's resolution. The bridge budgets 2000 ms
   * for an answer (§7.2) and a run whose engine is mid-turn can spend all of it, so greying
   * only after the promise settles leaves the operator staring at a live-looking composer
   * for two seconds after they pressed Send: the exact ambiguity ("did that go?") that
   * produces the second answer and the 409. So the row goes grey before the `await`, and the
   * three ways out are all handled:
   *
   *   • resolves          → `settled = 'answered'` (rail-level, survives this component);
   *   • 409               → `settled = 'taken'` — another operator got there first, which is
   *                         not a failure to roll back;
   *   • anything else     → ROLL BACK. The composer comes back with the operator's text
   *                         still in it and the server's own words underneath, because a
   *                         503 `run_not_live` is retryable and a permanently-greyed
   *                         question would be a lie about what the engine has.
   */
  const [pending, setPending] = useState(false)

  const submit = async () => {
    // The gate again, at the action rather than only at the control. A disabled input cannot
    // raise ⌘↵ and a disabled button cannot submit, so this is unreachable today — which is
    // exactly why it is cheap, and why it should not be the render tree's job alone to keep
    // an ungranted mutation from being sent.
    if (!operable || busy || !value.trim()) return
    setBusy(true)
    setPending(true)
    setFailure(null)
    try {
      await answerFn(runId, question.qid, value)
      setValue('')
      onAnswered(question.qid, 'answered')
    } catch (error) {
      const classified = classifyFailure(error, 'answer')
      setFailure(classified)
      // §7.2: a 409 here means ANOTHER OPERATOR ANSWERED FIRST. The question is settled —
      // it is simply not settled by us — so the composer closes and the snapshot is
      // re-read rather than the operator being invited to retry into the same 409.
      if (classified.kind === 'already-answered') onAnswered(question.qid, 'taken')
      else setPending(false)
    } finally {
      setBusy(false)
    }
  }

  if (question.answered || settled || pending) {
    // `optimistic` is the whole §7.2 distinction: the run has NOT recorded this answer yet, so
    // the row is grey-and-pending rather than a history row, whatever the POST returned. Only
    // `question.answered` — the snapshot carrying the run's own `answer` event — settles it.
    const optimistic = !question.answered
    return (
      <div className={`qitem answered${optimistic ? ' pending' : ''}`} data-pending={optimistic ? '' : undefined}>
        <div className="qh">
          <StatusGlyph state="done" />
          <span className="strong meta dim">
            {question.answered
              ? 'answered'
              : settled === 'taken'
                ? 'answered elsewhere'
                : settled === 'answered' ? 'answer sent, not recorded yet' : 'sending your answer…'}
          </span>
          <span className="ago">{timeAgo(question.askedAt, now)}</span>
        </div>
        <div className="qb">{question.question}</div>
        <div className="ans">
          <span className="lbl">answer</span>
          <span>
            {question.answer ?? (
              question.answered
                ? <span className="dim">recorded before E7 — the value was not journalled</span>
                : settled === 'taken'
                  ? <span className="dim">another operator answered first — waiting for the engine to record it</span>
                  : settled === 'answered'
                    ? <span className="dim">sent — this question stays pending until the run’s `answer` event records it</span>
                    : <span className="dim">{value || '…'}</span>
            )}
          </span>
          {question.replayed ? <span className="badge replay">replayed</span> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="qitem">
      <div className="qh">
        <StatusGlyph state={abandoned ? 'cancelled' : 'blocked'} />
        <span className="strong meta">{abandoned ? 'never answered' : 'waiting on you'}</span>
        <span className="ago">{timeAgo(question.askedAt, now)}</span>
      </div>
      <div className="qb">{question.question}</div>
      {abandoned ? (
        <div className="qf">
          <span className="dim micro mono">qid {question.qid}</span>
          <span className="dim micro">
            the run ended without an answer — the engine rejects pending asks on abort
          </span>
        </div>
      ) : (
        <form
          className="ctl-answer"
          onSubmit={(event) => { event.preventDefault(); void submit() }}
        >
          <label className="vh" htmlFor={inputId}>Answer: {question.question}</label>
          <input
            className="inp ans-inp" id={inputId} value={value} autoComplete="off"
            disabled={!operable || busy}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault(); void submit()
              }
            }}
          />
          <button
            className="btn primary lg" type="submit"
            disabled={!operable || busy || !value.trim()}
          >
            <Icon name="send" size={12} />{busy ? 'Sending…' : 'Send'}
          </button>
          <span className={`hint${failure ? ' bad' : ''}`} {...(failure ? { role: 'alert' } : {})}>
            {failure
              ? failureCopy(failure)
              : state === 'allowed'
                ? '⌘↵ sends · answer here or press a'
                : (
                  <LockChip
                    capabilities={capabilities} capability="answer"
                    capabilityError={capabilityError}
                  />
                )}
          </span>
          <span className="dim micro mono qid">qid {question.qid}</span>
        </form>
      )}
    </div>
  )
}

const agentAt = (detail: RunDetail, index: number | null) =>
  (index == null ? undefined : detail.agents?.find((a) => a.index === index))

const adapterOf = (detail: RunDetail, index: number | null): string =>
  agentAt(detail, index)?.adapter || 'unknown'

const labelOf = (detail: RunDetail, index: number | null): string =>
  agentAt(detail, index)?.label ?? `agent ${index}`
