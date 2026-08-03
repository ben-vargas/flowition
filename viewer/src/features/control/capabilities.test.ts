// §7.2's capability gate, as pure logic (§11.1's node half).
//
// Two properties, and they are in tension until you say them precisely:
//
//   • the gate FAILS CLOSED — nothing is operable until a successful session response names
//     it, so a probe that is slow, or that failed, denies exactly like a viewer started
//     without `--control`;
//   • the READING stays three-valued — "you may not" and "nobody has told me yet" are
//     different sentences, because a viewer that reports itself read-only on a timed-out
//     probe sends the operator to restart a CLI that was already correct.
//
// Collapsing the first is the round-5 blocker (a read-only viewer with live buttons);
// collapsing the second is the defect the three-valued reading was introduced for.

import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  canOperate,
  capabilityState,
  capabilityWord,
  controlFlag,
  explainCapability,
  isLocked,
  lockParts,
  lockedExplanation,
  lockedSummary,
  unknownExplanation,
} from './capabilities.js'

describe('§7.2 capability state', () => {
  it('reports allowed / locked / unknown, and never collapses the last two', () => {
    expect(capabilityState(['answer'], 'answer')).toBe('allowed')
    expect(capabilityState(['answer'], 'delete')).toBe('locked')
    // The read-only DEFAULT is a positive claim: the server answered "you may do nothing".
    expect(capabilityState([], 'answer')).toBe('locked')
    expect(capabilityState(null, 'answer')).toBe('unknown')
    expect(capabilityState(undefined, 'answer')).toBe('unknown')
    // `isLocked` is the CONFIRMED refusal, and it stays narrow — it is a copy predicate,
    // never the gate.
    expect(isLocked(null, 'answer')).toBe(false)
    expect(isLocked([], 'answer')).toBe(true)
  })

  it('FAILS CLOSED: only an explicit grant is operable', () => {
    for (const capability of CAPABILITIES) {
      expect(canOperate(CAPABILITIES, capability)).toBe(true)
      expect(canOperate([], capability)).toBe(false)
      // The probe has not answered…
      expect(canOperate(null, capability)).toBe(false)
      // …and neither has an absent one (§6.5: a payload with no `control` key at all).
      expect(canOperate(undefined, capability)).toBe(false)
    }
    // A partial grant grants exactly what it names.
    expect(canOperate(['answer'], 'answer')).toBe(true)
    expect(canOperate(['answer'], 'delete')).toBe(false)
  })

  it('names the exact flag that unlocks each control', () => {
    for (const capability of CAPABILITIES) {
      expect(controlFlag(capability)).toBe(`flowition viewer --control=${capability}`)
      expect(lockedExplanation(capability)).toContain(`--control=${capability}`)
      expect(lockedExplanation(capability)).toContain('read-only')
    }
  })

  it('never says "read-only" when the permission is merely UNKNOWN', () => {
    const failed = unknownExplanation('answer', 'the viewer API did not answer')
    expect(failed).toContain('the permission check failed')
    expect(failed).toContain('the viewer API did not answer')
    expect(failed).toContain('disabled')
    expect(failed).not.toContain('read-only')

    const pending = unknownExplanation('answer')
    expect(pending).toContain('being checked')
    expect(pending).toContain('disabled')
    expect(pending).not.toContain('read-only')

    expect(explainCapability(null, 'delete', 'boom')).toContain('boom')
    expect(explainCapability(['delete'], 'delete')).toBeNull()
  })

  it('gives the chip a word for each state — pending and failed are not the same news', () => {
    expect(capabilityWord('allowed')).toBeNull()
    expect(capabilityWord('locked')).toBe('locked')
    expect(capabilityWord('unknown')).toBe('checking')
    expect(capabilityWord('unknown', 'ECONNREFUSED')).toBe('unverified')
  })
})

describe('§7.2 header chip', () => {
  it('says read-only only when EVERY capability is locked', () => {
    expect(lockedSummary([])!.label).toBe('read-only')
    expect(lockedSummary([])!.kind).toBe('read-only')
    expect(lockedSummary([])!.detail).toContain('--control')
  })

  it('reports a PARTIAL lock rather than pretending the viewer is fully open', () => {
    const summary = lockedSummary(['answer', 'send'])!
    expect(summary.kind).toBe('partial')
    expect(summary.label).toBe('controls partly locked')
    expect(summary.locked).toEqual(['cancel', 'resume', 'delete'])
    expect(summary.detail).toContain('--control=cancel,resume,delete')
  })

  it('is silent only when nothing is locked', () => {
    expect(lockedSummary(CAPABILITIES)).toBeNull()
  })

  it('explains an UNKNOWN set without ever calling the viewer read-only', () => {
    // Silence was right while unknown controls stayed live. It is wrong now: an unknown set
    // disables all five, so the page owes the operator the sentence — just not that one.
    const pending = lockedSummary(null)!
    expect(pending.kind).toBe('checking')
    expect(pending.label).toBe('checking permissions…')
    expect(pending.locked).toEqual([...CAPABILITIES])
    expect(pending.detail).toContain('/api/session')
    expect(pending.detail).not.toContain('read-only')

    const failed = lockedSummary(null, 'ECONNREFUSED')!
    expect(failed.kind).toBe('unverified')
    expect(failed.label).toBe('permissions unverified')
    expect(failed.detail).toContain('ECONNREFUSED')
    expect(failed.detail).toContain('disabled')
    expect(failed.detail).not.toContain('read-only')
  })
})

/**
 * The split a lock chip renders in a tight action row (round 6, B1): a VISIBLE half that is
 * the flag, and a hidden half that completes the sentence for the accessible description.
 * The chip is the only explanation a disabled control has, so neither half may be empty and
 * the two together must still be the whole sentence.
 */
describe('§7.2 lockParts — the visible flag and the announced sentence', () => {
  it('gives a locked capability its flag to show and its sentence to announce', () => {
    for (const capability of CAPABILITIES) {
      const parts = lockParts([], capability)!
      expect(parts.hint).toBe(`--control=${capability}`)
      // The hidden half is the full explanation, flag included — a description that stopped
      // at "locked" is what round 5 shipped.
      expect(parts.rest).toBe(lockedExplanation(capability))
      expect(parts.rest).toContain(controlFlag(capability))
    }
  })

  it('has no flag to show for an UNVERIFIED control, and never claims read-only', () => {
    const checking = lockParts(null, 'cancel')!
    expect(checking.hint).toBeNull()
    expect(checking.rest).toBe(unknownExplanation('cancel', null))
    expect(checking.rest).not.toContain('read-only')

    const failed = lockParts(null, 'cancel', 'ECONNREFUSED')!
    expect(failed.hint).toBeNull()
    expect(failed.rest).toContain('ECONNREFUSED')
    expect(failed.rest).not.toContain('read-only')
  })

  it('is null exactly when the capability is granted — a chip nobody renders', () => {
    expect(lockParts(CAPABILITIES, 'delete')).toBeNull()
    expect(lockParts(['delete'], 'delete')).toBeNull()
    expect(lockParts(['answer'], 'delete')).not.toBeNull()
  })
})
