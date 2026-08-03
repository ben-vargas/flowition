/**
 * §3.6's live region for the transcript's frontier.
 *
 * The region is rendered ALWAYS — on a settled transcript, on an empty one, before the first
 * record arrives — and starts empty. That is not a stylistic choice: assistive technology
 * announces changes to a region it was already observing, and a region inserted into the
 * document together with its first message is announced unreliably or not at all. A viewer
 * whose live region appears only once there is something to say is a viewer that says
 * nothing, which is the defect this file closes.
 *
 * `aria-live="polite"` and not `role="status"`: the two are equivalent to a screen reader,
 * but `role=status` also gives the node an implicit ARIA role in the accessibility tree
 * beside the transcript's own `article`, and this node is not a status region the operator
 * should be able to find and read — it is a channel. `aria-atomic` is on, so a changed
 * sentence is read whole rather than diffed word by word.
 */

import { useEffect, useRef, useState } from 'react'

import type { AgentView } from '../../api/types.js'
import type { TimelineItem } from './types.js'
import {
  FRONTIER_THROTTLE_MS,
  type ThrottleState,
  frontierAnnouncement,
  initialThrottle,
  speakableIdentifier,
  throttleStep,
} from './frontier.js'

export function LiveFrontier(
  { agent, live, latest, windowMs = FRONTIER_THROTTLE_MS }: {
    agent: AgentView
    live: boolean
    latest: TimelineItem | null
    /** Overridden only by tests; §3.6 fixes the product value at 5 s. */
    windowMs?: number
  },
) {
  // `label` is whatever string the workflow author passed to `agent({label})`; the index is
  // the viewer's own. Naming the fallback here rather than letting `frontierAnnouncement`
  // reach for its generic one means an agent with an unspeakable label is still announced as
  // the agent the operator can find in the table.
  const name = speakableIdentifier(agent.label, `agent ${agent.index}`)
  const candidate = frontierAnnouncement({
    agent: name,
    state: agent.displayState ?? agent.state,
    live,
    latest,
  })

  const [announced, setAnnounced] = useState('')
  const state = useRef<ThrottleState>(initialThrottle())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // One place decides what the region says, and it is `throttleStep`. This effect is only
    // the clock: apply a step, and if the step asked to be re-run when the window opens,
    // arm exactly one timer for it. Re-running on every candidate change is what keeps the
    // held sentence the NEWEST one rather than the first of the burst.
    const apply = () => {
      const { next, waitMs } = throttleStep(state.current, candidate, Date.now(), windowMs)
      state.current = next
      setAnnounced(next.announced)
      if (timer.current != null) { clearTimeout(timer.current); timer.current = null }
      if (waitMs != null) {
        timer.current = setTimeout(() => {
          timer.current = null
          const opened = throttleStep(
            state.current, state.current.pending, Date.now(), windowMs,
          )
          state.current = opened.next
          setAnnounced(opened.next.announced)
        }, waitMs)
      }
    }
    apply()
    return () => {
      if (timer.current != null) { clearTimeout(timer.current); timer.current = null }
    }
  }, [candidate, windowMs])

  return (
    <div
      className="vh tp-frontier"
      data-frontier={live ? 'live' : 'settled'}
      aria-live="polite"
      aria-atomic="true"
    >
      {announced}
    </div>
  )
}
