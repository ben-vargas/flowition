// §6.3's formatting rules, and the absent-value rule they encode.

import { describe, expect, it } from 'vitest'
import { elapsed, fmtCost, fmtDuration, fmtTokens, pctOf, summaryCost, timeAgo } from './fmt.js'

describe('fmtTokens', () => {
  it('renders §6.3 shapes', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(41_000)).toBe('41k')
    expect(fmtTokens(41_400)).toBe('41.4k')
    expect(fmtTokens(375_100)).toBe('375k')
    expect(fmtTokens(1_200_000)).toBe('1.2M')
  })
  it('returns null for an absent value', () => {
    expect(fmtTokens(null)).toBeNull()
    expect(fmtTokens(undefined)).toBeNull()
    expect(fmtTokens(Number.NaN)).toBeNull()
  })
})

describe('fmtDuration', () => {
  it('matches src/util.js:137–141 exactly, so the CLI and the viewer agree', () => {
    expect(fmtDuration(820)).toBe('820ms')
    expect(fmtDuration(4200)).toBe('4.2s')
    expect(fmtDuration(59_999)).toBe('60.0s')
    expect(fmtDuration(187_000)).toBe('3m7s')
    expect(fmtDuration(1_278_000)).toBe('21m18s')
  })
  it('returns null rather than "0ms" for an absent duration', () => {
    expect(fmtDuration(null)).toBeNull()
    expect(fmtDuration(undefined)).toBeNull()
  })
})

describe('fmtCost — parity #114', () => {
  it('never renders $0.00 for a nonzero cost', () => {
    for (const v of [0.0001, 0.004, 0.009, 0.0000004]) {
      const out = fmtCost(v)!
      expect(out, String(v)).not.toBe('$0.00')
      expect(out, String(v)).not.toMatch(/^\$0\.0+$/)
    }
  })
  it('uses 2dp above $1, 3dp above $0.01, 4dp below', () => {
    expect(fmtCost(9.05)).toBe('$9.05')
    expect(fmtCost(1)).toBe('$1.00')
    expect(fmtCost(0.014)).toBe('$0.014')
    expect(fmtCost(0.0004)).toBe('$0.0004')
    expect(fmtCost(0.00004)).toBe('<$0.0001')
  })
  it('distinguishes a real zero from an absent cost', () => {
    expect(fmtCost(0)).toBe('$0')
    expect(fmtCost(null)).toBeNull()      // → a BLANK cell, never a fabricated $0.00
    expect(fmtCost(undefined)).toBeNull()
  })
})

describe('timeAgo', () => {
  const now = 1_700_000_000_000
  it('renders relative times', () => {
    expect(timeAgo(now, now)).toBe('just now')
    expect(timeAgo(now - 120_000, now)).toBe('2m ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(timeAgo(now - 4 * 86_400_000, now)).toBe('4d ago')
  })
  it('returns null with no timestamp', () => {
    expect(timeAgo(null, now)).toBeNull()
  })
})

describe('elapsed — parity #46', () => {
  const now = 1_000_000
  it('ticks while live and freezes at terminal', () => {
    expect(elapsed(now - 5000, null, now)).toBe(5000)
    expect(elapsed(now - 5000, now - 1000, now)).toBe(4000)
    // The frozen value must not depend on `now` at all.
    expect(elapsed(now - 5000, now - 1000, now + 999_999)).toBe(4000)
  })
  it('returns null when the run never started', () => {
    expect(elapsed(null, null, now)).toBeNull()
  })
})

describe('pctOf — the budget gauge input', () => {
  it('computes percent of the soft ceiling', () => {
    expect(pctOf(375_100, 340_000)).toBeCloseTo(110.32, 2)
    expect(pctOf(170_000, 340_000)).toBe(50)
  })
  it('returns null without a ceiling — never a fake 0%', () => {
    expect(pctOf(1000, null)).toBeNull()
    expect(pctOf(null, 340_000)).toBeNull()
    expect(pctOf(1000, 0)).toBeNull()
  })
})

describe('summaryCost — the summary’s "empty ≠ zero" (parity #53/#114)', () => {
  it('renders a real, journal-sourced price', () => {
    expect(summaryCost({ cost: 9.052 })).toBe('$9.05')
    expect(summaryCost({ cost: 0.0004 })).toBe('$0.0004')
  })
  it('renders NOTHING for a summary that carries no price', () => {
    // The shared fold coerces a missing cost to 0 (src/viewer/fold.js:28), so a zero here
    // means "this adapter reported tokens but no price" — the mock adapter, any local
    // model — and a fabricated `$0` would read as a measurement that was never taken.
    expect(summaryCost({ cost: 0 })).toBeNull()
    expect(summaryCost({ cost: null })).toBeNull()
    expect(summaryCost(null)).toBeNull()
    expect(summaryCost(undefined)).toBeNull()
    expect(summaryCost({ cost: Number.NaN })).toBeNull()
    // …while fmtCost keeps its literal contract for a caller with a genuine zero.
    expect(fmtCost(0)).toBe('$0')
  })
})
