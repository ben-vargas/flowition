// DESIGN §2.3's attention strip — Q1 made structural.
//
// Three card kinds, each carrying the ONE action that resolves it:
//   (a) blocked on an unanswered ask()  → the question text inline + an answer composer
//   (b) stale — "the engine died"       → Resume
//   (c) running                         → a live spend ticker against the soft ceiling
//
// It renders only when non-empty, so a calm queue means a calm screen. Per §3.7's action
// hierarchy this region gets exactly ONE accent fill: the answer composer's Send.

import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../api/client.js'
import type { QuestionView, RunDetail, RunSummary } from '../../api/types.js'
import { useControl } from '../control/ControlProvider.js'
import { canOperate, explainCapability, gatedPlaceholder } from '../control/capabilities.js'
import { LockChip } from '../control/Locked.js'
import type { ResumeRef } from '../control/Confirmations.js'
import { classifyFailure, failureCopy } from '../control/verdict.js'
import type { MutationFailure } from '../control/verdict.js'
import { Icon } from '../../ui/Icon.js'
import type { GlyphName } from '../../ui/icons.js'
import { StatusChip, StatusGlyph } from '../../ui/Status.js'
import { fmtDuration, fmtTokens, elapsed, pctOf, summaryCost, timeAgo } from '../../format/fmt.js'
import { href, navigate } from '../../app/router.js'

/** Runs of a kind that exist but have no card. Never silent — each is rendered. */
export interface AttentionOverflow { blocked: number; stale: number; live: number }

/**
 * A scan behind this strip failed, so the queue is a PARTIAL answer.
 *
 * Each flag names a card kind whose completeness is now unknown: the active scan feeds the
 * blocked and running cards, the stale scan feeds the stale ones. `message` is the server's
 * own words, because "something went wrong" is not an operator-actionable sentence.
 */
export interface AttentionDegraded {
  blocked: boolean
  live: boolean
  stale: boolean
  message: string
}

/**
 * One blocked run's card, with the state of the RunDetail request behind it.
 *
 * The detail is a SECOND request the listing knows nothing about, and §2.3's inline
 * question is rendered from it alone — so its three states are all explicit here. A card
 * that only ever receives `detail: RunDetail | null` cannot tell "still loading" from
 * "the request failed and nothing will retry it", and it renders the same "loading the
 * question…" copy over a disabled composer forever (review round 4).
 */
export interface AttentionQuestion {
  run: RunSummary
  detail: RunDetail | null
  /** A detail request is in flight. `detail` may still hold the previous good payload. */
  detailLoading?: boolean
  /** The last detail request FAILED, in the server's own words. */
  detailError?: string | null
  /** Re-request the question text. Wired to Home's invalidation, not to a local refetch. */
  onRetryDetail?: () => void
}

export interface AttentionProps {
  blocked: AttentionQuestion[]
  stale: RunSummary[]
  live: RunSummary[]
  /** How many more of each kind exist beyond the cards shown (§2.3 — no silent caps). */
  more?: AttentionOverflow
  /** The scan behind these cards hit its page budget, so even the counts are a floor. */
  truncated?: boolean
  /** A scan FAILED. The cards are last-good, the queue is not known to be complete. */
  degraded?: AttentionDegraded | null
  /** Re-run every query this screen depends on (the strip's own Retry). */
  onRetry?: () => void
  /**
   * Enabled §7.2 capabilities; anything but an explicit grant disables the action WITH the
   * reason — this strip runs the SAME `canOperate` gate as every other write surface
   * (`features/control/capabilities.ts`), and it fails CLOSED.
   *
   * The tri-state survives, but only as COPY. `[]` is a positive claim — the viewer was
   * asked and answered "you may do nothing" — so its controls say "read-only" and name the
   * `--control` flag that fixes it. `null` is UNKNOWN: the probe is in flight or it failed,
   * nobody has claimed read-only, and the cards say the check is what is missing. Both are
   * inert. `--control` is an opt-in whose whole point is that a viewer may not drive a
   * full-permission agent process until the operator says so (§7.2, §7.4), so a permission
   * check that has not answered denies (round 6, B1 — this strip was the last surface still
   * offering Answer and Resume on an unanswered probe).
   */
  capabilities: readonly string[] | null
  /** The session probe failed; the cards say the permission state is unknown. */
  capabilityError?: string | null
  now: number
  onAnswered?: () => void
  /** A §7.3 resume was accepted; re-poll, because the listing is what proves it took. */
  onResumed?: () => void
  /** Hand the overflow to the matching §2.3 filter chip. */
  onShowAll?: (kind: 'blocked' | 'stale' | 'running') => void
  answerFn?: typeof api.answer
  resumeFn?: typeof api.resume
}

const NO_MORE: AttentionOverflow = { blocked: 0, stale: 0, live: 0 }

export function AttentionStrip(props: AttentionProps) {
  const { blocked, stale, live } = props
  const more = props.more ?? NO_MORE
  const degraded = props.degraded ?? null
  const hidden = more.blocked + more.stale + more.live
  const total = blocked.length + stale.length + live.length + hidden
  // An empty queue means "nothing needs you", which is a CLAIM. It may only be made when
  // the scans behind it actually answered — otherwise the strip stays on screen and says
  // what it does not know (review round 3).
  if (total === 0 && !degraded) return null
  // The same reason the count carries a `+` when a scan was truncated: a partial scan
  // cannot state a total, only a floor.
  const exact = !props.truncated && !degraded

  return (
    <section className="attn" aria-labelledby="attn-h">
      <div className="attn-head">
        <span className="lbl" id="attn-h">Needs you</span>
        <span className="count">{exact ? total : `${total}+`}</span>
        <span className="dim micro" style={{ marginLeft: 4 }}>
          runs blocked on an answer, runs whose engine died, and what is burning money right now
        </span>
      </div>
      {degraded ? <PartialNote degraded={degraded} shown={total} onRetry={props.onRetry} /> : null}
      <div className="attn-grid">
        {blocked.map((item) => (
          <AskCard
            key={item.run.runId} run={item.run} detail={item.detail}
            detailLoading={item.detailLoading ?? false}
            detailError={item.detailError ?? null}
            {...(item.onRetryDetail ? { onRetryDetail: item.onRetryDetail } : {})}
            capabilities={props.capabilities}
            capabilityError={props.capabilityError ?? null}
            now={props.now}
            {...(props.onAnswered ? { onAnswered: props.onAnswered } : {})}
            {...(props.answerFn ? { answerFn: props.answerFn } : {})}
          />
        ))}
        {more.blocked > 0 ? (
          <MoreCard
            kind="blocked" n={more.blocked} glyph="blocked"
            {...(props.onShowAll ? { onShowAll: props.onShowAll } : {})}
          />
        ) : null}
        {stale.map((run) => (
          <StaleCard
            key={run.runId} run={run}
            capabilities={props.capabilities}
            capabilityError={props.capabilityError ?? null}
            now={props.now}
            {...(props.onResumed ? { onResumed: props.onResumed } : {})}
            {...(props.resumeFn ? { resumeFn: props.resumeFn } : {})}
          />
        ))}
        {more.stale > 0 ? (
          <MoreCard
            kind="stale" n={more.stale} glyph="stale"
            {...(props.onShowAll ? { onShowAll: props.onShowAll } : {})}
          />
        ) : null}
        {live.map((run) => <LiveCard key={run.runId} run={run} now={props.now} />)}
        {more.live > 0 ? (
          <MoreCard
            kind="running" n={more.live} glyph="running"
            {...(props.onShowAll ? { onShowAll: props.onShowAll } : {})}
          />
        ) : null}
      </div>
    </section>
  )
}

/**
 * The strip's partial-data state.
 *
 * §2.3's promise is that nothing needing the operator is missing from this queue, and that
 * promise is only as good as the two scans behind it. When one fails, the honest screen
 * says WHICH kinds of card are now in doubt, keeps whatever it last had (so a one-poll
 * blip does not empty the queue), and offers the same Retry the API banner does — which
 * re-runs every query on the screen, not just the one the operator can see.
 */
function PartialNote(
  { degraded, shown, onRetry }: {
    degraded: AttentionDegraded; shown: number; onRetry?: () => void
  },
) {
  const kinds = [
    degraded.blocked ? 'blocked' : null,
    degraded.live ? 'running' : null,
    degraded.stale ? 'stale' : null,
  ].filter(Boolean) as string[]
  const list = kinds.length > 1
    ? `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`
    : kinds[0]
  return (
    <div className="banner warn attn-partial" role="alert">
      <Icon name="stale" size={14} />
      <span>
        <b>This queue is incomplete.</b> The scan for {list} runs failed
        {degraded.message ? <> (<span className="mono">{degraded.message}</span>)</> : null}, so
        {shown > 0
          ? ' these cards are the last ones it returned and there may be more.'
          : ' nothing is shown here — that is a failed scan, not an empty queue.'}
      </span>
      {onRetry ? (
        <button className="btn sm" type="button" style={{ marginLeft: 'auto' }} onClick={onRetry}>
          <Icon name="resume" size={12} />Retry
        </button>
      ) : null}
    </div>
  )
}

/**
 * The strip caps cards per kind so it stays a work queue rather than a second run list.
 * The remainder is stated, counted, and one click from the filter that shows it — a card
 * count is a display decision, never a claim that nothing else needs the operator.
 */
function MoreCard(
  { kind, n, glyph, onShowAll }: {
    kind: 'blocked' | 'stale' | 'running'
    n: number
    glyph: GlyphName
    onShowAll?: (kind: 'blocked' | 'stale' | 'running') => void
  },
) {
  const noun = kind === 'blocked' ? 'blocked run' : kind === 'stale' ? 'stale run' : 'running run'
  return (
    <div className={`acard more ${kind}`}>
      <div className="acard-top">
        <StatusGlyph state={kind === 'running' ? 'running' : kind} />
        <span className="nm">{n} more {noun}{n === 1 ? '' : 's'}</span>
      </div>
      <div className="why">
        Not shown as cards — the strip keeps {kind === 'blocked' ? 'three' : 'two'} at a
        time so it stays a queue. They are all in the table.
      </div>
      <div className="acard-actions">
        <button className="btn" type="button" onClick={() => onShowAll?.(kind)}>
          <Icon name={glyph} size={12} />Show the {kind} runs
        </button>
      </div>
    </div>
  )
}

// ---- capability verdicts (§7.2) ----------------------------------------------------
//
// There is no local gate here any more. `canOperate` and `explainCapability` are imported
// from `features/control/capabilities.ts` — the one module §7.2's rule lives in — so this
// strip cannot drift from the cockpit's composer, the transcript's footer or the palette,
// which is exactly how it came to offer Answer and Resume on a probe that had not answered
// while all three of those refused it.

// ---- (a) blocked on an ask() -------------------------------------------------------

function firstOpenQuestion(
  detail: RunDetail | null,
  skip: ReadonlySet<string>,
): QuestionView | null {
  // §6.5's "nothing throws": a payload from a different engine — or a truncated one — may
  // not carry `questions` at all. The card degrades to its loading copy; it does not take
  // the app down with it.
  if (!detail || !Array.isArray(detail.questions)) return null
  // `skip` holds the qids this card has RECONCILED (the snapshot said answered) and the ones
  // another operator took (§7.2's 409). It never holds a qid whose answer is merely accepted:
  // that one is still the question on screen, greyed, until the `answer` event lands.
  return detail.questions.find(
    (q) => q?.answered === false && !q.abandoned && !skip.has(q.qid),
  ) ?? null
}

/** The snapshot's own record of one qid, or `undefined` when it does not carry it. */
const questionOf = (detail: RunDetail | null, qid: string): QuestionView | undefined =>
  (Array.isArray(detail?.questions) ? detail.questions.find((q) => q?.qid === qid) : undefined)

/**
 * §7.2's reconciliation test: has the RUN recorded this answer?
 *
 * The answer row's contract is "the question greys instantly, **reconciles on the `answer`
 * event**", and the event reaches this card as a refreshed `RunDetail` (the answer
 * invalidates it; §5.6's stream refreshes it again). So the only thing that may settle a
 * greyed question is a snapshot that reports it answered — never the POST's own 200, which
 * says the bridge accepted a command and nothing about what the engine journalled.
 *
 * `false` while there is no snapshot to reconcile against (a detail still loading, or one
 * from an engine that carries no `questions` — §6.5): an absent answer is not a recorded one.
 * A question the snapshot no longer lists at all IS settled; it left the run's open set.
 */
function answerRecorded(detail: RunDetail | null, qid: string): boolean {
  if (!detail || !Array.isArray(detail.questions)) return false
  const question = detail.questions.find((q) => q?.qid === qid)
  if (!question) return true
  return question.answered === true || Boolean(question.abandoned)
}

function AskCard(
  {
    run, detail, detailLoading, detailError, onRetryDetail,
    capabilities, capabilityError, now, onAnswered, answerFn = api.answer,
  }: {
    run: RunSummary; detail: RunDetail | null
    detailLoading: boolean; detailError: string | null; onRetryDetail?: () => void
    capabilities: readonly string[] | null; capabilityError: string | null
    now: number; onAnswered?: () => void; answerFn?: typeof api.answer
  },
) {
  /**
   * The answer this card is HOLDING, and the whole of §7.2's optimism (review round 6, B2).
   *
   *   `accepted: false` — the POST is in flight;
   *   `accepted: true`  — the bridge took it, and the run has not recorded it yet.
   *
   * Both are the SAME grey state on screen, because §7.2's answer row reconciles on the
   * `answer` event and a 200 from the bridge is not that event: it means one command reached
   * one socket. The previous revision promoted the qid to "answered here" the moment the POST
   * resolved, which removed the question — and, on a run with a second one, replaced it — while
   * the snapshot behind the card still reported it unanswered. That is the card asserting an
   * engine state nobody had observed; when the engine then refuses the answer (an ask() that
   * had already been abandoned, a run aborting in the same tick) the operator has been told
   * their answer landed and the run stays blocked with no question on screen.
   */
  const [held, setHeld] = useState<{ qid: string; value: string; accepted: boolean } | null>(null)
  const [value, setValue] = useState('')
  const [failure, setFailure] = useState<MutationFailure | null>(null)
  /** Qids the SERVER said someone else had already answered — §7.2's 409, not a failure. */
  const [takenHere, setTakenHere] = useState<ReadonlySet<string>>(() => new Set())
  /** Qids RECONCILED here: the snapshot itself reported the answer this card sent. */
  const [recordedHere, setRecordedHere] = useState<ReadonlySet<string>>(() => new Set())

  /**
   * §7.2's reconciliation, and the only thing in this file that settles an accepted answer:
   * the refreshed `RunDetail` reports the qid answered (the run's `answer` event, journalled
   * and read back). Until it does, the question below stays exactly where it is.
   *
   * Read during RENDER as well as committed in the effect, so the frame the snapshot lands on
   * is already the reconciled one — a card that showed its grey question for one extra commit
   * after the run had recorded the answer would be the same lie one frame smaller.
   */
  const reconciled = held?.accepted === true && answerRecorded(detail, held.qid)
  const holding = reconciled ? null : held
  const busy = holding !== null
  useEffect(() => {
    if (!held?.accepted) return
    if (!answerRecorded(detail, held.qid)) return
    setRecordedHere((prev) => new Set(prev).add(held.qid))
    setHeld(null)
  }, [detail, held])

  // The question on screen. A held answer PINS its own question — greyed, still readable,
  // still carrying its qid — so nothing advances to the next one on a promise the engine has
  // not kept. Otherwise it is the run's first open question that this card has not settled.
  const skip = takenHere.size || recordedHere.size
    ? new Set([...takenHere, ...recordedHere])
    : takenHere
  const question = holding
    ? questionOf(detail, holding.qid) ?? null
    : firstOpenQuestion(detail, skip)
  // §7.2's gate, fail-closed and shared: `null` (checking / failed) and `[]` (read-only)
  // both produce an inert composer. They differ in the sentence under it and in the
  // placeholder — never in what the operator can do.
  const canAnswer = canOperate(capabilities, 'answer')

  /**
   * The SAME answer contract the cockpit's inbox composer runs (`features/control/
   * InboxRail.tsx`), because §7.2's table is one table and this is the ≤2-click Home path
   * onto the same row of it:
   *
   *   • PENDING — the submitted question stays on screen, greyed, saying "sending your
   *     answer…", with its composer inert. §7.2's word for this row is "the question greys
   *     instantly, reconciles on the `answer` event": the grey is the optimism, and it is
   *     the whole of it. Advancing to the NEXT question, or claiming the answer was sent,
   *     before the bridge has accepted anything states an outcome nobody has;
   *   • accepted → still the grey question, now saying the bridge took it. It is Home's
   *     refresh (`onAnswered`) that goes and asks the run, and only the run's own `answer`
   *     event — arriving as a snapshot that reports the qid answered — moves the card on;
   *   • 409 → "another operator answered first" + a refresh, never a generic failure. The
   *     question is settled; it is simply not settled here, so the copy says so and Home
   *     re-reads rather than inviting a retry into the same 409;
   *   • anything else → rolled back to the open question, with the operator's text still in
   *     the box and the server's own words under it (`failureCopy`), because a 503 is
   *     retryable and the two seconds the bridge is allowed to take (§7.2's mutation
   *     timeout) end in an answer the operator may well want to send again.
   */
  const submit = async () => {
    // The gate at the ACTION, not only at the control. A disabled input cannot raise ⌘↵ and
    // a disabled button cannot submit this form, so today this is unreachable — which is
    // precisely why it is cheap, and why the render tree should not be the only thing
    // standing between an ungranted capability and a POST.
    if (!canAnswer || !question || !value.trim() || busy) return
    const qid = question.qid
    const sent = value
    setFailure(null)
    setHeld({ qid, value: sent, accepted: false })
    try {
      await answerFn(run.runId, qid, sent)
      // ACCEPTED — by the BRIDGE. The composer empties (there is nothing left to retry) and
      // the card asks Home for a fresh read, but the question stays greyed on screen until
      // that read reports it answered. §7.2 gives this row one reconciliation event and it is
      // not this promise.
      setHeld({ qid, value: sent, accepted: true })
      setValue('')
      onAnswered?.()
    } catch (err) {
      const classified = classifyFailure(err, 'answer')
      setHeld(null)
      setFailure(classified)
      if (classified.kind === 'already-answered') {
        // Settled, just not here: the qid leaves this card, because retrying it can only 409
        // again. This one does NOT wait for the snapshot — the server has already said the
        // question is closed, which is a stronger statement than the poll it would wait for.
        setTakenHere((prev) => new Set(prev).add(qid))
        setValue('')
        onAnswered?.()
      }
      // Any other failure: nothing was recorded anywhere, so nothing here moves. The
      // question is still open, the text is still in the box, and `failureCopy` says why.
    }
  }

  /** The grey state, in both its halves — in flight, and accepted-but-not-yet-recorded. */
  const sending = question != null && holding?.qid === question.qid
  const accepted = sending && holding?.accepted === true
  const asked = question ? timeAgo(question.askedAt, now) : null
  const blockedFor = fmtDuration(
    question ? Math.max(0, now - question.askedAt) : null,
  )

  return (
    <div className="acard ask">
      <div className="acard-top">
        <StatusGlyph state="blocked" />
        <a className="nm trunc" href={href.run(run.runId)}>{run.name ?? run.runId}</a>
        {run.name ? <span className="rid">{run.runId}</span> : null}
        <span className="right">
          <StatusChip state="blocked" label={blockedFor ? `blocked ${blockedFor}` : 'blocked'} />
        </span>
      </div>

      {question ? (
        // §7.2: from Send until the run records the answer the question is GREY and STILL
        // HERE — the whole optimistic state, and the whole of it. The `who` line carries the
        // stage so it is one flat string: the qid an operator reads back to a colleague stays
        // visible through the send, and so does the question text.
        <div
          className={`qtext${sending ? ' sending' : ''}`}
          {...(sending ? { 'data-answer': accepted ? 'accepted' : 'pending' } : {})}
        >
          <span className="who">
            {accepted
              ? `answer sent, not recorded yet · qid ${question.qid}`
              : sending
                ? `sending your answer… · qid ${question.qid}`
                : `asked ${asked ?? 'just now'} · qid ${question.qid}`}
          </span>
          {question.question}
        </div>
      ) : takenHere.size > 0 ? (
        // §7.2's 409: settled, but not by us. Home has already been asked for a fresh
        // snapshot; until it lands, the card states whose answer it is waiting on.
        <div className="qtext dim" data-answer="taken">
          <span className="who">answered elsewhere</span>
          Another operator answered first. Waiting for the engine to record it.
        </div>
      ) : recordedHere.size > 0 ? (
        // RECONCILED: the snapshot itself reported the answer this card sent, so the card may
        // finally say so — and it says the recorded thing, not the sent thing. It only reaches
        // this branch when the run has no further open question; a second one takes the
        // composer's place above instead.
        <div className="qtext dim" data-answer="sent">
          <span className="who">answer recorded</span>
          The run recorded your answer. If this run has another question, it appears here.
        </div>
      ) : detailError ? (
        // THE REQUEST BEHIND THIS CARD FAILED, and until review round 4 that was
        // indistinguishable from "still loading": the card sat on the loading copy with a
        // dead composer forever, because nothing reran the detail fetch while the run id
        // and its question count stayed put. §2.3's whole promise here is an answerable
        // question inline, so a failure says so and carries the way back.
        <div className="qtext bad" role="alert">
          <span className="who">the question could not be loaded</span>
          {detailError}. This run is still blocked on {run.openQuestions}{' '}
          {run.openQuestions === 1 ? 'question' : 'questions'} — it is the question TEXT that
          is missing, not the question.
        </div>
      ) : (
        // The listing says a question is open but the detail has not arrived (or the run
        // just settled). Say so; do not render an empty composer over nothing.
        <div className="qtext dim">
          <span className="who">loading the question…</span>
          {run.openQuestions} unanswered {run.openQuestions === 1 ? 'question' : 'questions'}
        </div>
      )}

      {/* A failure that arrived over a question already in hand keeps the question — the
          composer stays usable — and states that what is on screen is the last good read. */}
      {detailError && question ? (
        <div className="hint bad" role="alert">
          the question above is the last one this viewer loaded; the refresh failed
          ({detailError})
        </div>
      ) : null}

      {detailError && onRetryDetail ? (
        <div className="acard-actions" style={{ marginBottom: 10 }}>
          <button
            className="btn sm" type="button" disabled={detailLoading} onClick={onRetryDetail}
          >
            <Icon name="resume" size={12} />
            {detailLoading ? 'Retrying…' : 'Retry the question'}
          </button>
        </div>
      ) : null}

      <form
        className="acard-answer"
        onSubmit={(e) => { e.preventDefault(); void submit() }}
      >
        <label className="vh" htmlFor={`ans-${run.runId}`}>Answer the question</label>
        <input
          className="inp" id={`ans-${run.runId}`} value={value} autoComplete="off"
          disabled={!question || !canAnswer || busy}
          placeholder={gatedPlaceholder(capabilities, 'answer', capabilityError, 'your answer')}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit() }
          }}
        />
        <button
          className="btn primary lg" type="submit"
          disabled={!question || !canAnswer || busy || !value.trim()}
        >
          <Icon name="send" size={12} />
          {!busy ? 'Send' : holding?.accepted ? 'Sent' : 'Sending…'}
        </button>
        {/* §7.2: never hidden, never enabled — disabled WITH the explanation. The chip is
            the same one the cockpit's composer carries, so "locked" / "checking" /
            "unverified" mean the same thing on both screens. */}
        <LockChip capabilities={capabilities} capability="answer" capabilityError={capabilityError} />
        <span className={`hint${failure ? ' bad' : ''}`} {...(failure ? { role: 'alert' } : {})}>
          {failure
            // The shared §7.2 vocabulary, so a 409 reads "another operator answered first"
            // and a 503 says how long retrying is worth it — here exactly as in the cockpit.
            ? failureCopy(failure)
            : accepted
              // §7.2's reconciliation, stated: the bridge has it, the run has not recorded it
              // yet, and this question is the operator's until it does.
              ? 'answer sent — this question clears when the run records it'
              : sending
              // The one honest sentence for the in-flight window: what was sent, and that
              // nothing has accepted it yet.
              ? 'sending your answer — it stays here until the engine accepts it'
              // The shortcut hint belongs to an OPERABLE composer. When the capability is not
              // granted the chip beside this hint already carries §7.2's explanation as
              // visible text (round 6, B1), and printing the same sentence twice on one row
              // is how the operator learns to read neither.
              : canAnswer ? '⌘↵ sends · answer here or press a' : null}
        </span>
      </form>
    </div>
  )
}

// ---- (b) stale — the engine died ---------------------------------------------------

/**
 * The stale card's Resume actually resumes (§7.3) — THROUGH §7.2's MODAL.
 *
 * §7.2's write-surface table gives the resume row one confirmation UX and only one:
 * "Modal per §7.3 (distinct copy for replay-of-completed vs recover)". W8b shipped an
 * inline arm here as a placeholder for a layer that did not exist yet; now that it does,
 * this card raises the same `ResumeDialog` the cockpit header and the palette raise, so the
 * normative table is exact on the ≤2-click Home flow as well — same copy, same §1.3
 * integrity scope, same `graphDynamic` statement, same failure vocabulary, same
 * `role=status` toast on the way out.
 *
 * The inline arm survives as the NO-PROVIDER fallback only: `useControl()` returns null
 * when W12's layer is not mounted (the strip is also rendered standalone in tests and in
 * the comp-capture harness), and a card that silently drops its only action in that case
 * would be worse than one that confirms in place. The shipped app always mounts the
 * provider (`app/App.tsx`), so the shipped path is the modal.
 */
function StaleCard(
  { run, capabilities, capabilityError, now, onResumed, resumeFn = api.resume }: {
    run: RunSummary; capabilities: readonly string[] | null
    capabilityError: string | null; now: number
    onResumed?: () => void; resumeFn?: typeof api.resume
  },
) {
  // The same fail-closed gate the modal layer itself applies (ControlProvider's `refuse`):
  // this card does not raise §7.3's dialog for a capability no session response has granted.
  const canResume = canOperate(capabilities, 'resume')
  const capabilityNote = explainCapability(capabilities, 'resume', capabilityError)
  const orphaned = Math.max(0, run.agents.total - run.agents.done - run.agents.failed - run.agents.cached)
  const cost = summaryCost(run.spend)

  // THE TIME OF DEATH IS USUALLY UNKNOWN, AND THE CARD MUST SAY SO.
  //
  // `endedAt` comes from a terminal run event and from nothing else (§6.2,
  // src/viewer/summaries.js:115-118). A run is `stale` precisely because the engine went
  // away WITHOUT writing one, so for the normal stale run `endedAt` is null. Substituting
  // `startedAt` — which this card used to do — turns the run's AGE into a claim about when
  // it died: a run started three days ago and killed ten minutes later reads "Engine died
  // 3d ago". The same substitution made the runtime figure tick upward forever, because
  // `elapsed(startedAt, null, now)` measures a run that is still going.
  //
  // The viewer has no heartbeat to fall back on — nothing on disk records when the process
  // was last alive — so there is no better number to compute. The honest card states what
  // it knows (the run started then; the server's own lock verdict) and does not date the
  // death. A `lastSeenAt` on RunSummary would let it, and that is a W6 change, noted with
  // this unit rather than faked here.
  const died = timeAgo(run.endedAt, now)
  const startedAgo = timeAgo(run.startedAt, now)
  const ran = run.endedAt != null ? fmtDuration(elapsed(run.startedAt, run.endedAt, now)) : null

  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [launched, setLaunched] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** A `RunDetail` is being read so the modal can state §7.3's graph fact. */
  const [reading, setReading] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // §7.2's resume row: a modal, from W12's shared layer, whenever that layer is mounted.
  const control = useControl()

  /**
   * THE MODAL NEEDS A `RunDetail`, AND HOME ONLY HAS A `RunSummary`.
   *
   * `graphDynamic` is a detail field (`src/viewer/snapshot.js:324`), projected from journal
   * meta; the listing never carries it. Round 1 shipped a hard `graphDynamic: null` from
   * here, which reads as §6.5's "this run predates the field" — so a CURRENT run with a
   * dynamic graph opened §7.3's modal with the preflight-refusal warning silently missing,
   * on the one path (Home) the acceptance criterion calls out as ≤2 clicks. The claim was
   * false, and the omission was the dangerous half.
   *
   * So the card reads the snapshot first and carries the real tri-state in. The read is
   * one request against a run the operator has just asked to act on, and it happens
   * BEFORE the dialog rather than inside it so the dialog has no loading state of its own
   * to get wrong. If it fails, the modal still opens — the server, not this viewer, gates
   * the resume — but it says the snapshot was unreadable (`graphSource: 'unavailable'`)
   * instead of borrowing §6.5's sentence for a question nothing answered.
   */
  const openResumeDialog = control
    ? async () => {
      // Gate first: an ungranted `resume` reads no snapshot and opens no modal. The layer
      // refuses too, but a dialog that opens and then declines is a control that was
      // offered — and §7.2 says an ungranted mutation is never offered.
      if (reading || !canResume) return
      setLaunched(false)
      setFailure(null)
      setReading(true)
      let ref: ResumeRef
      try {
        const detail = await control.mutations.runDetail(run.runId)
        ref = {
          runId: run.runId,
          name: run.name,
          // The snapshot's state is fresher than the listing's, and it is what decides
          // §7.3's Replay-vs-Resume copy — the same field the cockpit's Resume reads.
          state: detail.state ?? run.state,
          // `?? null` is §6.5's null and nothing else: the server always emits the key.
          graphDynamic: detail.graphDynamic ?? null,
          graphSource: 'snapshot',
        }
      } catch {
        ref = {
          runId: run.runId, name: run.name, state: run.state,
          graphDynamic: null, graphSource: 'unavailable',
        }
      }
      if (!alive.current) return
      setReading(false)
      control.confirmResume(ref, () => { setLaunched(true); onResumed?.() })
    }
    : null

  const resume = async () => {
    if (busy || !canResume) return
    setBusy(true)
    setFailure(null)
    try {
      await resumeFn(run.runId)
      setLaunched(true)
      setArmed(false)
      // The listing is what proves the run came back; re-poll rather than pretend.
      onResumed?.()
    } catch (err) {
      setArmed(false)
      setFailure(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="acard stale">
      <div className="acard-top">
        <StatusGlyph state="stale" />
        <a className="nm trunc" href={href.run(run.runId)}>{run.name ?? run.runId}</a>
        <span className="right"><StatusChip state="stale" /></span>
      </div>
      <div className="why">
        {died
          ? `Engine died ${died}.`
          : `Engine died. It wrote no terminal event, so there is no time of death to${
            startedAgo ? ` report — the run started ${startedAgo}.` : ' report.'}`}
        {run.liveDetail ? ` ${run.liveDetail}.` : ''}{' '}
        {run.agents.total > 0 ? (
          <>
            {run.agents.done + run.agents.cached} of {run.agents.total} agents finished
            {orphaned > 0 ? <>; {orphaned} render <b>orphaned</b>, not spinning</> : null}.
          </>
        ) : null}
      </div>
      <div className="acard-actions">
        {armed && !openResumeDialog ? (
          <>
            <button
              className="btn arm" type="button" disabled={busy} autoFocus
              onClick={() => { void resume() }}
            >
              <Icon name="resume" size={12} />
              {busy ? 'Launching…' : `Resume ${run.name ?? run.runId}?`}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => setArmed(false)}>
              Keep it stopped
            </button>
          </>
        ) : (
          <button
            className="btn" type="button"
            disabled={!canResume || busy || launched || reading}
            title={capabilityNote ?? undefined}
            onClick={openResumeDialog
              ? () => { void openResumeDialog() }
              : () => {
                if (!canResume) return
                setLaunched(false); setFailure(null); setArmed(true)
              }}
          >
            <Icon name="resume" size={12} />Resume
          </button>
        )}
        {/* Disabled with the explanation beside it, never hidden (§7.2). Compact: the flag
            stays visible in the action row and the rest of the sentence is announced. */}
        <LockChip
          capabilities={capabilities} capability="resume" capabilityError={capabilityError} compact
        />
        <button className="btn" type="button" onClick={() => navigate(href.run(run.runId))}>
          Open run
        </button>
        {run.hasRunLog ? (
          <span className="badge"><Icon name="external" size={12} />detached log</span>
        ) : null}
        <span className="dim micro" style={{ marginLeft: 'auto' }}>
          {/* Labelled, because with no `endedAt` the only temporal fact left is when the
              run began — and an unlabelled figure there would read as a duration. */}
          {[ran ? `ran ${ran}` : startedAgo ? `started ${startedAgo}` : null, cost]
            .filter(Boolean).join(' · ')}
        </span>
      </div>
      {/* §7.3: the response is "launch accepted", never "the run is back". Say the
          weaker, true thing — the poll below reports the engine's own verdict. */}
      {/* The capability sentence is NOT repeated here: the lock chip above renders it as
          visible text (round 6, B1), and one row saying the same thing twice trains the
          operator to read neither. */}
      {armed || launched || failure ? (
        <div className={`hint${failure ? ' bad' : ''}`} role={failure ? 'alert' : undefined}>
          {failure
            ? failure
            : launched
              ? 'Resume launched — the engine re-checks the workflow file, its local imports and the args before it restarts anything. Watching for it here.'
              // armed
              : 'Restarts this run in a detached process. Completed agents replay from the journal; the integrity check covers the local graph, not your environment or packages.'}
        </div>
      ) : null}
    </div>
  )
}

// ---- (c) live spend ticker ---------------------------------------------------------

export function LiveCard({ run, now }: { run: RunSummary; now: number }) {
  const out = run.spend?.output ?? null
  const cost = summaryCost(run.spend)
  const pct = pctOf(out, run.budgetTotal)
  const over = pct != null && pct > 100
  // §2.4 / critique M19: the gauge plots spend.output against budgetTotal — BOTH output
  // tokens. Input tokens and dollars are separate figures and never enter the bar.
  //
  // The track is scaled to max(spend, ceiling) so an overshoot is VISIBLE rather than
  // clipped at 100%: the accent fill runs to the ceiling, the hatched zone runs past it,
  // and the ceiling rule marks where the soft limit actually sits.
  const scale = pct == null ? 100 : Math.max(pct, 100)
  const fillPct = pct == null ? 0 : (Math.min(pct, 100) / scale) * 100
  const ceilingPct = (100 / scale) * 100

  return (
    <div className="acard live">
      <div className="acard-top">
        <StatusGlyph state="running" />
        <a className="nm trunc" href={href.run(run.runId)}>{run.name ?? run.runId}</a>
        <span className="right">
          {over ? (
            // "over budget", never "blocked": the budget is pre-admission advisory and the
            // UI must never present it as a hard cap (§2.4).
            <span className="badge warn"><Icon name="bolt" size={12} />over budget</span>
          ) : (
            <span className="dim micro">{fmtDuration(elapsed(run.startedAt, null, now))}</span>
          )}
        </span>
      </div>
      <dl className="ticker">
        <dt>spend</dt>
        <dd>
          {/* Tokens are the measurement every adapter reports; the price is the one that
              may be missing (§2.3's empty ≠ zero). So tokens lead, and cost joins them
              only when the journal actually carried one — never as a dash or a $0. */}
          <b>{fmtTokens(out) ?? 'no usage yet'}</b>
          {out != null ? <span className="dim"> out</span> : null}
          {cost ? <span className="dim"> · {cost}</span> : null}
        </dd>
        <dt>budget</dt>
        <dd>
          {pct == null ? (
            <span className="dim">no ceiling set</span>
          ) : (
            <>
              <span className={over ? 'over-l' : undefined}>{pct.toFixed(1)}%</span>{' '}
              <span className="dim">of the {fmtTokens(run.budgetTotal)} soft ceiling</span>
            </>
          )}
        </dd>
        <dt>agents</dt>
        <dd>
          {run.agents.done}/{run.agents.total}
          <span className="dim">
            {run.agents.running ? ` · ${run.agents.running} running` : ''}
            {run.agents.failed ? ` · ${run.agents.failed} failed` : ''}
          </span>
        </dd>
      </dl>
      {pct != null ? (
        <div className="gauge">
          <div className="gauge-bar">
            <div className="fill" style={{ width: `${fillPct}%` }} />
            {over ? <div className="over" style={{ left: `${ceilingPct}%`, right: 0 }} /> : null}
            <div className="ceiling" style={{ left: `${ceilingPct}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
