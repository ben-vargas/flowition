// Where focus goes when a NAVIGATION is the whole action — §2.7's "⌘K … jump to any run or
// agent by fuzzy name", and §3.6's "focus is moved into panels when they open".
//
// **Why this is not a `.focus()` call at the call site.** The palette's row activation runs
// `onClose()` and `row.run()` synchronously in one event handler, and `row.run()` is a
// `navigate()` — a `location.hash` write whose `hashchange` is NOT synchronous. So at the
// instant the operator presses ↵ there are three things that have not happened yet: the
// dialog has not unmounted (its `FocusScope contain` is still pulling focus back inside),
// §3.6's restore has not run (it puts focus on the node that opened the palette — which, on
// a route change, is about to be unmounted), and the destination route has not rendered, let
// alone finished the fetch that produces its header. A `.focus()` there is either taken back
// by the scope, clobbered by the restore, or aimed at a node that does not exist; the
// observable end state is focus on `<body>` after the route commits, which is no keyboard
// position at all.
//
// So a palette jump RECORDS where the operator asked to go, and the destination claims it
// when it mounts — the same request+claim shape as `landing.ts` (delete → Home) and
// `features/control/answerFocus.ts` (palette → the answer composer), for the same reason:
// the requester cannot know when the destination exists, and a timer that "usually" wins is
// exactly the §16.5 defect class.
//
// Two claim sites, and both are needed:
//   • the destination's own header, on mount — the normal case, where the route had to
//     render and fetch before it could take focus;
//   • `ControlProvider`, in the commit that removed the last modal — the case where the
//     destination is ALREADY on screen (⌘K from the very agent you are looking at), so
//     nothing re-renders and no mount effect will ever run.
//
// Until the final destination answers, focus parks on the shell's always-mounted "Runs" link
// (`landing.ts`'s `SHELL_LANDING`) rather than on `<body>`: the transition is then a move
// between two real keyboard positions, never a hole between them.

import { SHELL_LANDING } from './landing.js'
import { readRoute } from './router.js'

export type Destination =
  | { kind: 'run'; runId: string }
  | { kind: 'agent'; runId: string; index: number }

/**
 * The destination's own header carries these: the cockpit's `<h1>` (the run) and the
 * transcript pane's `<h2>` (the agent), each `tabIndex={-1}` so it can take focus without
 * becoming a Tab stop. Attribute-matched rather than ref-passed because the requester and
 * the destination are in different units' files and never see each other's tree.
 *
 * The match is a scan over `[data-destination]` compared by VALUE rather than an attribute
 * selector built from the run id: a run id reaches this file straight off the wire, and a
 * selector interpolating it would need escaping to be correct (`CSS.escape` is not in every
 * environment this bundle is asked to run in). There are at most three of these nodes on any
 * screen — the cockpit's, and one per compared transcript pane.
 */
function find(to: Destination): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>('[data-destination]')) {
    if (node.dataset.destination !== to.kind || node.dataset.run !== to.runId) continue
    if (to.kind === 'agent' && node.dataset.agent !== String(to.index)) continue
    return node
  }
  return null
}

let pending: Destination | null = null
/**
 * A heading that matched the destination when the jump was requested — i.e. one belonging to
 * the screen being LEFT, which is about to be unmounted. It is refused for the life of the
 * request; see `requestDestinationFocus`.
 */
let outgoing: HTMLElement | null = null
/**
 * Whether the interim park has already been taken for THIS request. The claim runs from a
 * render effect on the destination's side, which is to say many times per second on a live
 * screen; parking once is the difference between "focus never falls through the transition"
 * and "focus is dragged back to the shell every poll tick".
 */
let parked = false

/**
 * Whether the route the operator is on is EXACTLY the one this intent is about — the run
 * route for a run, that agent's route for an agent.
 *
 * Exactly, because the agent route is §3.7's split and contains the run's cockpit too: "the
 * cockpit is on screen" and "the cockpit is the screen" are different questions, and this
 * file needs the second one for both of its jobs (telling the outgoing header from the
 * destination's, and knowing when the operator has moved on).
 */
function onRoute(to: Destination): boolean {
  const route = readRoute()
  return to.kind === 'run'
    ? route.name === 'run' && route.runId === to.runId
    : route.name === 'agent' && route.runId === to.runId && route.agentIndex === to.index
}

/**
 * Record where the operator asked to go. Called by the palette's run/agent rows BEFORE their
 * `navigate`, and that order is load-bearing.
 *
 * §3.7's agent route is a SPLIT: the transcript sits beside the run's own cockpit, so while
 * the operator is reading agent 0 there is a `run` heading in the document for the very run a
 * ⌘K jump back to the cockpit is about. It is not the destination — it is the outgoing
 * screen's, and it is unmounted a commit later when the route swaps. Focusing it is worse
 * than focusing nothing: the claim succeeds, disarms, and then the node is removed and the
 * operator is on `<body>` with no way back except the mouse. (This is exactly what the
 * §12.1 walkthrough caught on its third jump.)
 *
 * Reading the route BEFORE `navigate` is what tells the two apart: a match that exists while
 * the operator is already ON the destination's route is the real one (⌘K to the agent you
 * are looking at, where the URL barely changes and nothing will re-render to claim this
 * later); any other match belongs to the screen being left.
 */
export function requestDestinationFocus(to: Destination): void {
  pending = to
  parked = false
  outgoing = onRoute(to) ? null : find(to)
}

/**
 * Move focus to the requested destination if the destination is in the document. Returns true
 * when it took focus, which is one of the two things that disarms the request; the other is
 * the operator leaving the route it was recorded for.
 */
export function claimDestinationFocus(): boolean {
  if (!pending || typeof document === 'undefined') return false
  // The operator moved on — back, a link, another jump — and a heading that mounts later
  // must not yank focus out of whatever they are doing now.
  if (!onRoute(pending)) { cancelDestinationFocus(); return false }
  // The outgoing screen has gone; anything matching from here is the destination's own.
  if (outgoing != null && !outgoing.isConnected) outgoing = null
  const target = find(pending)
  if (target != null && target !== outgoing && target.isConnected) {
    target.focus()
    if (document.activeElement === target) {
      cancelDestinationFocus()
      return true
    }
  }
  // Not up yet (or it refused focus): keep the request armed and park on the durable shell
  // control, so the transition never passes through `<body>`.
  if (!parked) {
    const shell = document.querySelector<HTMLElement>(SHELL_LANDING)
    if (shell?.isConnected) { shell.focus(); parked = true }
  }
  return false
}

/** Drop a pending request — a newer ask supersedes it (a re-opened palette, an answer intent). */
export function cancelDestinationFocus(): void {
  pending = null
  outgoing = null
  parked = false
}

/** The destination still waiting, if any. Test/telemetry hook. */
export const destinationFocusPending = (): Destination | null => pending
