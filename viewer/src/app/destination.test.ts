// @vitest-environment jsdom
//
// The focus handoff a ⌘K jump uses (§2.7 + §3.6), on its own. The end of the path — an
// operator crossing four route changes by keyboard and never losing their position — is the
// §12.1 walkthrough in `features/control/e2e.test.tsx`; what is asserted here is what that
// test cannot observe from the outside: the interim park, the staleness rule, and the fact
// that a claim which runs on every render of a live screen moves focus at most once.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cancelDestinationFocus, claimDestinationFocus, destinationFocusPending,
  requestDestinationFocus,
} from './destination.js'
import { resetRouteForTests } from './router.js'

const at = (hash: string) => { window.location.hash = hash; resetRouteForTests() }

beforeEach(() => { at('#/'); document.body.replaceChildren() })
afterEach(() => { cancelDestinationFocus(); document.body.replaceChildren() })

/** The shell's durable Runs link — the interim position, always mounted (§3.6). */
const shell = () => {
  const runs = document.createElement('a')
  runs.href = '#/'
  runs.dataset.landing = 'runs'
  runs.textContent = 'Runs'
  document.body.append(runs)
  return runs
}

/** A destination header, built the way the cockpit and the transcript build theirs. */
const heading = (kind: 'run' | 'agent', runId: string, index?: number) => {
  const node = document.createElement(kind === 'run' ? 'h1' : 'h2')
  node.tabIndex = -1
  node.dataset.destination = kind
  node.dataset.run = runId
  if (index != null) node.dataset.agent = String(index)
  document.body.append(node)
  return node
}

/**
 * A jump, the way the palette performs one: record the intent while still on the OUTGOING
 * route, then navigate. The order is the contract (see `requestDestinationFocus`).
 */
const jump = (to: Parameters<typeof requestDestinationFocus>[0], hash: string) => {
  requestDestinationFocus(to)
  at(hash)
}

describe('the ⌘K jump focus handoff', () => {
  it('parks on the shell while the destination route is still in flight', () => {
    const runs = shell()
    jump({ kind: 'run', runId: 'r_1' }, '#/run/r_1')
    expect(claimDestinationFocus()).toBe(false)
    expect(document.activeElement).toBe(runs)
    expect(destinationFocusPending()).toEqual({ kind: 'run', runId: 'r_1' })
  })

  it('parks ONCE — a claim per render must not drag focus back off the page', () => {
    shell()
    jump({ kind: 'run', runId: 'r_1' }, '#/run/r_1')
    expect(claimDestinationFocus()).toBe(false)
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    // The cockpit re-renders (a poll tick, a stream frame) before its header exists.
    expect(claimDestinationFocus()).toBe(false)
    expect(document.activeElement).toBe(elsewhere)
  })

  it('hands over to the run’s heading when the cockpit mounts, once', () => {
    shell()
    jump({ kind: 'run', runId: 'r_1' }, '#/run/r_1')
    const h1 = heading('run', 'r_1')
    expect(claimDestinationFocus()).toBe(true)
    expect(document.activeElement).toBe(h1)
    expect(destinationFocusPending()).toBeNull()
  })

  /**
   * The §3.7 split: the agent route renders the run's cockpit header BESIDE the transcript,
   * so a jump back to the cockpit finds a `run` heading that belongs to the screen being
   * left. Focusing it succeeds, disarms, and then the route swap removes the node — the
   * operator ends on `<body>`. This is the round-1 blocker, in one case.
   */
  it('refuses the OUTGOING screen’s matching heading, and takes the real one', () => {
    const runs = shell()
    at('#/run/r_1/agent/0')
    const beside = heading('run', 'r_1')          // the split's cockpit, about to unmount
    requestDestinationFocus({ kind: 'run', runId: 'r_1' })
    at('#/run/r_1')
    expect(claimDestinationFocus()).toBe(false)
    expect(document.activeElement).toBe(runs)     // parked, NOT on the doomed heading
    beside.remove()                                // the route commits
    const real = heading('run', 'r_1')
    expect(claimDestinationFocus()).toBe(true)
    expect(document.activeElement).toBe(real)
  })

  it('takes the destination IMMEDIATELY when it is already on screen', () => {
    shell()
    at('#/run/r_1/agent/3')
    const h2 = heading('agent', 'r_1', 3)
    // ⌘K → "agent 3" from agent 3's own transcript: the route does not move, so the heading
    // in the document IS the destination and the next claim must take it.
    requestDestinationFocus({ kind: 'agent', runId: 'r_1', index: 3 })
    expect(claimDestinationFocus()).toBe(true)
    expect(document.activeElement).toBe(h2)
    expect(destinationFocusPending()).toBeNull()
  })

  it('matches the agent PANE, not merely the run — compare mounts two of them', () => {
    shell()
    at('#/run/r_1/agent/7?a=2')
    heading('agent', 'r_1', 2)
    const wanted = heading('agent', 'r_1', 7)
    requestDestinationFocus({ kind: 'agent', runId: 'r_1', index: 7 })
    expect(claimDestinationFocus()).toBe(true)
    expect(document.activeElement).toBe(wanted)
  })

  it('is dropped when the operator has moved on — a late mount steals nothing', () => {
    shell()
    at('#/run/r_1')
    requestDestinationFocus({ kind: 'run', runId: 'r_1' })
    at('#/run/r_2')                        // back, a link, another jump — anything
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    heading('run', 'r_1')                  // the abandoned route finally renders
    expect(claimDestinationFocus()).toBe(false)
    expect(document.activeElement).toBe(elsewhere)
    expect(destinationFocusPending()).toBeNull()
  })

  it('does nothing at all when no jump was requested', () => {
    const runs = shell()
    at('#/run/r_1')
    const h1 = heading('run', 'r_1')
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    expect(claimDestinationFocus()).toBe(false)
    expect(document.activeElement).toBe(elsewhere)
    expect(document.activeElement).not.toBe(runs)
    expect(document.activeElement).not.toBe(h1)
  })
})
