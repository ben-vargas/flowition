/**
 * The cockpit's inbox rail (DESIGN §2.4) — §3.7's third column, and below §3.3's 900px
 * breakpoint the second of the two 44px drawer handles the approved comps draw
 * (`docs/frontend/comps/lib/page-cockpit.mjs` — `inboxRail`, `drawerStrip`;
 * `approvals.json` → `cockpit-live-1440` "run rail 280 │ main 840 │ inbox 320" and
 * `cockpit-live-800` annotation 14).
 *
 * **Why this lives in W11 and not W12.** §12 gives W12 "inbox rail, composers". The
 * COMPOSITION is W11's acceptance criterion — "screens match approved comps" — and a cockpit
 * that leaves the third column unrendered is 840px of main content sitting in 1160px, which
 * is not the approved screen at any viewport. So the rail's *frame and its three registers*
 * are built here from data `RunDetail` already carries, and the one thing that needs the
 * §7.2 control bridge — the answer composer — is left as an explicit, labelled slot rather
 * than faked. `CockpitProps.inbox` still overrides the whole column, so when W12 lands its
 * interactive rail it replaces this one wholesale instead of being grafted onto it.
 *
 * The three registers are §2.4's, in order: (1) questions — unanswered first with the
 * question text inline, answered ones collapsed to a history row showing the answer value
 * (E7); (2) agent reports — `mail` with `dir:'out'`, newest first, each linking to its
 * agent; (3) steering history — `dir:'in'` with origin, delivery verdict and the journalled
 * callsite (the only workflow source position on disk, RECON-flowition §1.4).
 */

import { useCallback, useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import type { MailView, QuestionView, RunDetail } from '../../api/types.js'
import { trapTab } from './focus.js'
import { type RunHonesty, deriveHonesty, useRunHonesty } from './honesty.js'
import { timeAgo } from '../../format/fmt.js'
import { Icon } from '../../ui/Icon.js'
import { AdapterBadge, StatusGlyph } from '../../ui/Status.js'
import { href } from '../../app/router.js'

export interface InboxRailProps {
  detail: RunDetail
  now: number
  /** Narrow (<900px): the rail is an overlay drawer behind a 44px handle (parity #42). */
  narrow: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
}

const byNewest = (a: MailView, b: MailView) => b.at - a.at

/**
 * The questions an operator can still act on.
 *
 * `q.abandoned` is the server's own post-pass (§6.4 step 8) and is the authority — but it is
 * only as current as the snapshot, and a run whose engine went away between polls arrives
 * with pending questions still marked open. Rendering those as "waiting on you", counting
 * them in the rail's "1 open", and opening the rail on their account are three claims that
 * the run is still able to receive an answer. So the rule goes through `honesty.abandoned`,
 * which layers the run's liveness over the server's flag exactly as `materializeFold` does
 * (src/viewer/fold.js:528) — one derivation, in one module (round 6).
 */
export const openQuestionsOf = (
  detail: RunDetail, honesty?: RunHonesty | null,
): QuestionView[] => {
  const verdict = honesty ?? deriveHonesty(detail, { now: 0 })
  return (detail.questions ?? []).filter((q) => !q.answered && !verdict.abandoned(q))
}

/**
 * §3.7's default state for this column, as a function of the run rather than a constant.
 *
 * The comp set annotates the 1440 cockpit's default states as "run rail open, **inbox rail
 * open _because there is an open question_**, log lane closed, Timeline active"
 * (`page-cockpit.mjs`, the §3.7 note). So the default is CONDITIONAL: the rail opens when it
 * holds work — an unanswered `ask()`, or a report an agent sent up that the operator has not
 * been shown anywhere else. A run with neither opens collapsed to its 44px handle and gives
 * the 320px to the tab, which is what round 1 shipped by accident and round 2 ships on
 * purpose (review round 2, B5).
 *
 * Steering history is deliberately NOT counted: it is a record of what the operator already
 * did, so it is never news.
 */
export const inboxDefaultOpen = (
  detail: RunDetail | null, honesty?: RunHonesty | null,
): boolean => {
  if (!detail) return false
  return openQuestionsOf(detail, honesty).length > 0
    || (detail.mail ?? []).some((m) => m.dir === 'out')
}

export function InboxRail(props: InboxRailProps) {
  const { detail, now, narrow } = props
  const honesty = useRunHonesty(detail, now)
  const questions = detail.questions ?? []
  const openQuestions = openQuestionsOf(detail, honesty)
  const reports = (detail.mail ?? []).filter((m) => m.dir === 'out').sort(byNewest)
  const steers = (detail.mail ?? []).filter((m) => m.dir === 'in').sort(byNewest)
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const handle = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  // §3.6 / the comps' annotations 20–22: opening moves focus to the drawer HEADER, Escape
  // closes and returns focus to the 44px handle that opened it, and Tab is TRAPPED while the
  // scrim is up — `aria-modal="true"` is a promise that the rest of the page is inert.
  const drawer = narrow && props.open
  useEffect(() => {
    if (drawer) heading.current?.focus()
  }, [drawer])
  const close = useCallback(() => {
    props.onClose()
    handle.current?.focus()
  }, [props])
  useEffect(() => {
    if (!drawer) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); event.preventDefault(); return }
      if (panel.current && trapTab(panel.current, event)) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer, close])

  const body = (
    <>
      <div className="sect">
        <h2 className="lbl" id={titleId} tabIndex={-1} ref={heading}>inbox</h2>
        <span className="count">
          {openQuestions.length ? `${openQuestions.length} open` : 'nothing open'}
        </span>
        <div className="sect-right">
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
                key={question.qid} question={question} now={now}
                abandoned={honesty.abandoned(question)}
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
          {steers.map((mail, i) => (
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
                  ? <span className={`verdict ${mail.delivery}`}>{mail.delivery}</span>
                  : <span className="dim">no delivery verdict journalled</span>}
                {mail.callsite
                  ? <span title="the only workflow source position on disk">{mail.callsite}</span>
                  : <span className="dim">no callsite journalled</span>}
              </div>
            </div>
          ))}
        </Group>
      </div>
    </>
  )

  // The 44px handle, in both of the states that have one: the narrow drawer's, and the
  // desktop column's COLLAPSED state (parity #41's idiom, and the comps' own `inboxStrip`,
  // which is how a collapsed inbox is drawn beside the transcript at 1440).
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

  // Desktop: the rail HONOURS `open`. Round 1 rendered the column unconditionally, so its
  // own Collapse button did nothing (review round 2, B5).
  if (!narrow) {
    if (!props.open) return strip
    return <aside className="col inbox" aria-label="Inbox">{body}</aside>
  }

  return (
    <>
      {strip}
      {props.open ? (
        <>
          <div className="inbox-scrim" onClick={close} />
          <div
            className="col inbox drawer" role="dialog" aria-modal="true"
            aria-labelledby={titleId} ref={panel}
          >
            {body}
          </div>
        </>
      ) : null}
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
 * An unanswered question renders its text inline; an answered one collapses to a history row
 * carrying the answer VALUE (E7). The composer is §7.2's, and it is named rather than drawn:
 * a disabled-looking input the operator cannot use is worse than a sentence saying why.
 */
function Question(
  { question, now, abandoned }: {
    question: QuestionView
    now: number
    /** `honesty.abandoned` — never `question.abandoned` alone (see `openQuestionsOf`). */
    abandoned: boolean
  },
) {
  if (question.answered) {
    return (
      <div className="qitem answered">
        <div className="qh">
          <StatusGlyph state="done" />
          <span className="strong meta dim">answered</span>
          <span className="ago">{timeAgo(question.askedAt, now)}</span>
        </div>
        <div className="qb">{question.question}</div>
        <div className="ans">
          <span className="lbl">answer</span>
          <span>
            {question.answer ?? (
              <span className="dim">
                recorded before E7 — the value was not journalled
              </span>
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
      <div className="qf">
        <span className="dim micro mono">qid {question.qid}</span>
        <span className="dim micro">
          {abandoned
            ? 'the run ended without an answer — the engine rejects pending asks on abort'
            : 'the answer composer arrives with W12’s control wiring (§7.2)'}
        </span>
      </div>
    </div>
  )
}

const agentAt = (detail: RunDetail, index: number | null) =>
  (index == null ? undefined : detail.agents?.find((a) => a.index === index))

const adapterOf = (detail: RunDetail, index: number | null): string =>
  agentAt(detail, index)?.adapter || 'unknown'

const labelOf = (detail: RunDetail, index: number | null): string =>
  agentAt(detail, index)?.label ?? `agent ${index}`
