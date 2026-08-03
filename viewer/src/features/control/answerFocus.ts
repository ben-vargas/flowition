// Where focus goes when something OTHER than the inbox asks for the answer composer —
// §2.7's "`a` focuses the first open question's answer box", and the command palette's
// "Answer the first open question" action, which is the same promise made from inside a
// focus-trapped modal.
//
// **Why an intent rather than a `.focus()` call.** The palette's row activation runs
// `onClose()` and then the action, synchronously, in one event handler: the palette is
// still mounted and its `FocusScope contain` is still pulling focus back inside when the
// action body runs. A composer focused there is focused and then immediately taken back —
// and in the layout §3.7 defaults to on a narrow viewport, or after the operator has
// collapsed the rail, there is no composer in the document to focus at all. So the action
// does not focus anything. It RECORDS what the operator asked for, and the surfaces that
// can actually satisfy it — the inbox rail, which can open itself, and `ControlProvider`,
// which knows when the last modal has unmounted — execute it from an effect, after the
// commit that removed the modal. No timer, no retry loop, no guessing at how long a
// FocusScope takes to let go: an intent that cannot be satisfied this commit simply waits
// for the commit that can.
//
// This is the same shape as `app/landing.ts` (request + claim, fulfilled by whoever mounts
// the destination) for the same reason: the requester cannot know when the destination
// exists, and a timer that "usually" wins is exactly the §16.5 defect class.
//
// The intent carries the run it was made for. A palette opened on run A must never focus
// run B's composer if the operator has moved on before it could be satisfied, and an intent
// that outlives its run would otherwise sit armed and steal focus from an unrelated screen.

/** The first open question's composer. Answered/abandoned questions render no input. */
export const ANSWER_COMPOSER = '.qitem .ans-inp'

interface AnswerFocusIntent {
  /** The run whose composer was asked for. `null` = any run's (nothing asks for that yet). */
  runId: string | null
}

let intent: AnswerFocusIntent | null = null
const subscribers = new Set<() => void>()

/** Whether the intent (if any) is about the run currently on screen. */
const matches = (runId: string | null | undefined): boolean =>
  intent != null && (intent.runId == null || runId == null || intent.runId === runId)

/**
 * Record the operator's ask. Deliberately does NOT focus: the caller may be inside the
 * modal that has to come down first. Subscribers are notified synchronously so a COLLAPSED
 * rail can start opening in the same batch — opening is a state change, focusing is not.
 */
export function requestAnswerFocus(runId: string | null = null): void {
  intent = { runId }
  for (const notify of [...subscribers]) notify()
}

/**
 * Try to satisfy a pending intent against the composers currently in the document.
 * `onScreenRunId` is the run those composers belong to, so a stale intent cannot be
 * satisfied by a different run's inbox.
 *
 * Returns true when focus actually landed — the only thing that disarms the intent, apart
 * from a composer that exists and refuses focus (a disabled read-only composer), which
 * disarms it too rather than leaving it armed for the next screen to trip over.
 */
export function claimAnswerFocus(onScreenRunId: string | null = null): boolean {
  if (!matches(onScreenRunId) || typeof document === 'undefined') return false
  const box = document.querySelector<HTMLElement>(ANSWER_COMPOSER)
  // Not in the document yet: the rail may still have to open. Keep waiting.
  if (!box?.isConnected) return false
  box.focus()
  intent = null
  return document.activeElement === box
}

/** Drop a pending intent — the operator asked for something else, or nothing can serve it. */
export function cancelAnswerFocus(): void {
  intent = null
}

/** Whether an intent for this run (or for no particular run) is still waiting. */
export function answerFocusPending(runId: string | null = null): boolean {
  return matches(runId)
}

/**
 * Be told the instant an intent is recorded. The inbox rail uses this: when the palette
 * asks for a composer that is not on screen, the rail is not re-rendered by that (the
 * modal lives in `ControlProvider` and the cockpit's tree bails out), so without a push it
 * would never learn there is anything to do.
 */
export function subscribeAnswerFocus(listener: () => void): () => void {
  subscribers.add(listener)
  return () => { subscribers.delete(listener) }
}
