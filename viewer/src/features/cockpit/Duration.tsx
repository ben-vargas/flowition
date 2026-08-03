/**
 * ONE rendering of an agent's runtime, for every surface that shows one (§2.4, parity #53).
 *
 * The Timeline prints it beside the bar, the Agents table in the `dur` column, the Structure
 * chip in its meta strip and the container header as a roll-up — four widgets, one figure,
 * and until round 8 four different derivations of it. `honesty.duration` decides WHAT may be
 * said; this decides how it looks, so the four cannot drift apart in wording either.
 *
 * The class name is load-bearing: `honesty.test.tsx` reads `.dur` out of all three tabs and
 * asserts the strings are identical for the same agent. A surface that formatted the figure
 * itself would be invisible to that check, which is exactly how "end unrecorded" in the
 * Timeline and "1m1s" in the Agents table shipped on the same orphan.
 */

import { fmtDuration } from '../../format/fmt.js'
import { type AgentDuration, durationValue } from './honesty.js'

/** What the tooltip says about the figure — its provenance, not a restatement of it. */
const TITLE: Record<'recorded' | 'live', string> = {
  recorded: 'recorded runtime',
  live: 'still running — elapsed so far',
}

/**
 * The figure, or NOTHING. A reading with no figure renders no element at all: the surfaces
 * that need to explain the gap (`AgentsTab`'s blank cell, the Timeline's "end unrecorded"
 * badge) do it in their own idiom, and a shared placeholder would have put a second,
 * differently-worded absence beside each of them.
 */
export function DurationText({ reading }: { reading: AgentDuration }) {
  const ms = durationValue(reading)
  if (ms == null) return null
  const kind = reading.kind === 'live' ? 'live' : 'recorded'
  return (
    <span className={`dur${reading.kind === 'live' ? ' so-far' : ''}`} title={TITLE[kind]}>
      {fmtDuration(ms)}
    </span>
  )
}
