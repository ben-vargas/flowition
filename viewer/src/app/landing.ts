// Where focus goes when a mutation DESTROYS the screen it was invoked from (§3.6).
//
// §3.6's rule is "closing a modal restores focus to what opened it", and `Dialog.tsx`
// keeps it for every close path that leaves the page standing — Escape, the scrim, Keep
// it, and a failed mutation. One path is different: a SUCCESSFUL delete. Its opener is the
// deleted run's own Delete button in the cockpit header, `ControlProvider` navigates to
// Home because the run the page is about no longer exists, and the opener is unmounted by
// that navigation. Restoring to it is then either impossible (the node is detached, and
// the guard in `useModalSurface` correctly skips it) or worse than impossible (it briefly
// succeeds, and the route change drops focus to `<body>` a tick later). Either way the
// operator ends a keyboard-driven delete with no keyboard position at all.
//
// So the successful-delete path does not restore — it HANDS OFF, deliberately, to a
// destination that outlives the run:
//
//   • `[data-landing="runs"]` — the shell's own "Runs" link. It is mounted on every route,
//     so it can take focus in the same tick the request is made and focus never passes
//     through `<body>` during the transition.
//   • `[data-landing="home"]` — Home's `<h1>`, claimed by Home itself when it mounts. This
//     is the final destination: the screen the operator was sent to, announced by its own
//     heading, with Tab continuing from the top of it.
//
// The handoff is a request + a claim rather than a timer because the route commits
// asynchronously (a `hashchange` is not synchronous with the `location.hash` write): there
// is no instant at which the caller can know Home is on screen. The claim runs when Home
// actually mounts, whichever order the unmount and the route change happen in — and it is
// idempotent, so the dialog's own restore running before or after it cannot change where
// the operator ends up.

/** Home's heading — the destination. */
const HOME_LANDING = '[data-landing="home"]'
/**
 * The shell's Runs link — always mounted, so always available as the interim. Exported
 * because `destination.ts` parks on the same node for the same reason: it is the one
 * keyboard position that survives every route transition.
 */
export const SHELL_LANDING = '[data-landing="runs"]'

let pending = false

/**
 * Ask for focus to move to Home once the route commits, and take the interim destination
 * now. Called by the one path that needs it: a delete that navigated away from the run.
 */
export function requestLandingFocus(): void {
  pending = true
  claimLandingFocus()
}

/**
 * Move focus to the best landing target currently in the document, if one was requested.
 * Returns true when the FINAL destination (Home's heading) took it, which is also what
 * disarms the request.
 */
export function claimLandingFocus(): boolean {
  if (!pending || typeof document === 'undefined') return false
  const home = document.querySelector<HTMLElement>(HOME_LANDING)
  if (home?.isConnected) {
    home.focus()
    if (document.activeElement === home) {
      pending = false
      return true
    }
  }
  // Home is not up yet (or refused focus): keep the request armed and park focus on the
  // durable shell control so the transition never leaves the operator on `<body>`.
  const runs = document.querySelector<HTMLElement>(SHELL_LANDING)
  if (runs?.isConnected) runs.focus()
  return false
}

/** Drop a pending request — used by tests and by any future path that supersedes it. */
export function cancelLandingFocus(): void {
  pending = false
}

/** Whether a handoff is still waiting for Home. Test/telemetry hook. */
export const landingFocusPending = (): boolean => pending
