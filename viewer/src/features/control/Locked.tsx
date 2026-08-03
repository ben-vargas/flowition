/**
 * The lock chip: what a control that the operator may not use looks like.
 *
 * §7.2's rule, and the one acceptance criterion this file exists for: a viewer without a
 * capability renders the control **disabled with an explanation — never hidden, never
 * enabled**. Hiding it makes "this viewer is read-only" indistinguishable from "this
 * product cannot do that", and the operator's next move (restart with `--control`) stops
 * being discoverable at exactly the moment they need it.
 *
 * Three renderings, one rule (`capabilities.ts`), and all three of the non-allowed ones sit
 * beside a DISABLED control — the gate fails closed:
 *   • allowed   → nothing at all;
 *   • locked    → a chip reading "locked" plus the flag that unlocks it;
 *   • unknown   → a chip reading "checking" while the session probe is in flight, or
 *                 "unverified" once it has failed. Neither says read-only — nobody has
 *                 claimed that — and both sit beside a control that cannot be operated,
 *                 because a capability this viewer has not been granted is one it does not
 *                 have.
 *
 * **The explanation is IN THE CHIP, always** (review round 6, B1). The previous revision
 * rendered the sentence — the one carrying `--control=<capability>`, i.e. the operator's only
 * way out — into the chip's `title` unless a caller opted in with an `inline` prop. A title is
 * not an explanation: it is invisible until hover, absent on touch, and — critically — it does
 * NOT enter the accessible description, so a button whose `aria-describedby` pointed here
 * computed a description of exactly one word, "locked". §7.2 says *disabled with an
 * explanation* and §3.6 does not accept a hover-only one, so the chip now renders its
 * explanation as TEXT, in the layout, in every context, and there is no `title` anywhere.
 *
 * `compact` chooses how much of that text is visible, never whether it exists: the flag stays
 * on screen and the rest of the sentence is visually hidden inside the same chip, so the
 * `aria-describedby` computation is whole on every surface.
 */

import { Icon } from '../../ui/Icon.js'
import {
  type Capability,
  capabilityState,
  capabilityWord,
  explainCapability,
  lockParts,
  lockedSummary,
} from './capabilities.js'

export interface LockChipProps {
  capabilities: readonly string[] | null | undefined
  capability: Capability
  /** The session probe's error, when there is one — it goes into the unknown copy. */
  capabilityError?: string | null
  /**
   * An id for the chip, so the control it explains can name it in `aria-describedby`
   * (the cockpit header's lifecycle actions do). Without the association a screen-reader
   * user hears "Cancel run, dimmed" and nothing about which flag would undim it — the
   * sighted operator reads the chip an inch away, and §3.6 does not accept a visual-only
   * explanation for a control that is otherwise inert.
   *
   * The association is only worth as much as what it points AT: the description a screen
   * reader computes is this chip's own text, which is why the sentence below is a text node
   * and not an attribute.
   */
  id?: string
  /**
   * Sit in a tight ACTION ROW (the cockpit header's three lifecycle buttons, the rail's
   * header, the per-agent cancel) rather than in a composer's own hint slot.
   *
   * It changes how much of the sentence is *visible*, never whether the sentence is there:
   * compact keeps the flag on screen — the half an operator has to type, and the half a
   * tooltip is worst at — and completes the sentence in a visually-hidden span, so the
   * accessible description is whole either way. Rendering three full sentences into a header
   * row of buttons pushed the run's own actions off the line and clipped the flag mid-word,
   * which is a worse failure of the same rule.
   */
  compact?: boolean
}

export function LockChip(
  { capabilities, capability, capabilityError, id, compact }: LockChipProps,
) {
  const state = capabilityState(capabilities, capability)
  if (state === 'allowed') return null
  const explanation = explainCapability(capabilities, capability, capabilityError ?? null)!
  const word = capabilityWord(state, capabilityError ?? null)!
  const parts = compact ? lockParts(capabilities, capability, capabilityError ?? null)! : null
  return (
    <span className={`lock-chip ${state} ${word}${compact ? ' compact' : ''}`} {...(id ? { id } : {})}>
      <Icon name={state === 'locked' ? 'cancel' : 'unknown'} size={12} />
      <span className="lock-word">{word}</span>
      {parts
        ? (
          <>
            {parts.hint ? <span className="lock-why">{parts.hint}</span> : null}
            <span className="vh">{parts.rest}</span>
          </>
        )
        : <span className="lock-why">{explanation}</span>}
    </span>
  )
}

/**
 * §7.2's persistent header chip. `null` only when every capability is granted: an unknown
 * set now disables every mutation on the page (`capabilities.ts`), so the page says so —
 * without ever calling itself read-only, which is a claim only an answered probe can support.
 */
export function ControlsLockedChip(
  { capabilities, capabilityError }: {
    capabilities: readonly string[] | null | undefined
    capabilityError?: string | null
  },
) {
  const summary = lockedSummary(capabilities, capabilityError ?? null)
  if (!summary) return null
  return (
    <span className={`ro-chip ${summary.kind}`} title={summary.detail}>
      <Icon name={summary.kind === 'checking' || summary.kind === 'unverified' ? 'unknown' : 'cancel'} size={12} />
      {summary.label}
    </span>
  )
}
