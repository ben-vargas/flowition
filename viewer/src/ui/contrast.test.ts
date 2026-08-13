// THE §3.6 CONTRAST GATE.
//
// The W8a sign-off made this NORMATIVE (ruling 3): `docs/frontend/comps/generate.mjs`
// recomputes the comps' 71 pairs and exits non-zero on any failure, and W8 ports that gate
// into the viewer suite "so a token change that breaks contrast fails CI". This file is
// that port, and it is the LIVE one: the comps are a static approval artifact, so a pair a
// later unit's UI introduces is added here. W11's Q4 token bar is the 72nd — which is why
// the count below is one ahead of the comps README's published table.
//
// It is not a smoke test — it is the reason the token table is allowed to claim the ratios
// the comps' README prints.
//
// Ratios are computed against the GAMUT-CLIPPED sRGB a browser actually paints, so an
// out-of-gamut token cannot pass on paper and fail on screen.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FAILING, PAIRS, TOK, WELL } from './tokens.js'
import { contrast, hex, r2 } from './color.js'

describe('§3.6 contrast gate', () => {
  it('checks every (fg, bg) token pair in BOTH themes', () => {
    // 15 fixed + 9 status × 3 roles + 10 adapters + 5 chart + 1 well + 16 ANSI = 74.
    expect(PAIRS).toHaveLength(74)
    for (const p of PAIRS) {
      expect(Number.isFinite(p.light), `${p.label} light`).toBe(true)
      expect(Number.isFinite(p.dark), `${p.label} dark`).toBe(true)
    }
  })

  it('has ZERO failing pairs', () => {
    const report = FAILING
      .map((p) => `  ${p.label}\n    need ${p.need}:1 · light ${r2(p.light)} · dark ${r2(p.dark)}`)
      .join('\n')
    expect(FAILING.length, `\n§3.6 contrast gate FAILED — ${FAILING.length} of ${PAIRS.length} pairs:\n${report}\n\nFix the token in src/ui/tokens.ts. Do not ship a failing swatch.\n`)
      .toBe(0)
  })

  it('applies 4.5:1 to text and 3:1 to UI, per WCAG 2.2 AA', () => {
    for (const p of PAIRS) {
      if (p.role === 'text') expect(p.need, p.label).toBe(4.5)
      else if (p.role === 'ui') expect(p.need, p.label).toBe(3)
      else expect(p.need, p.label).toBe(0)
    }
  })

  it('grants exactly ONE exemption, and it carries a stated reason (D8)', () => {
    const exempt = PAIRS.filter((p) => p.role === 'decor')
    expect(exempt).toHaveLength(1)
    expect(exempt[0]!.label).toMatch(/^ANSI 0 black on --well$/)
    // "exempt" without a reason is how a real failure hides. The reason must name the
    // §9.8 mechanism that keeps the color legible when it IS used.
    expect(exempt[0]!.note).toMatch(/background/i)
    expect(exempt[0]!.note).toMatch(/9\.8/)
  })

  it('gates --text-3 as real AA text — a "quiet" label that fails is broken, not quiet (D7)', () => {
    const quiet = PAIRS.filter((p) => p.label.startsWith('--text-3'))
    expect(quiet.length).toBeGreaterThan(0)
    for (const p of quiet) {
      expect(p.role).toBe('text')
      expect(Math.min(p.light, p.dark)).toBeGreaterThanOrEqual(4.5)
    }
  })

  /**
   * The gate's blind spot, closed (review round 5, B3).
   *
   * Every assertion above reads TOKENS. A stylesheet that paints a token at `opacity: 0.55`
   * paints a colour no token names — compositing happens in gamma-encoded sRGB, so the Q4
   * token bar's fill was 2.14:1 (light) / 2.83:1 (dark) over its own track while the gate
   * reported 71 of 71 passing. Alpha on a gated foreground is therefore banned outright in
   * the rules that draw §3.6-governed fills: the painted colour must BE the checked one.
   */
  it('lets no stylesheet composite a gated fill out of compliance (B3)', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../features/cockpit/cockpit.css', import.meta.url)), 'utf8',
    )
    const rule = /\.at-row \.tokbar \.fill \{([^}]*)\}/.exec(css)
    expect(rule, 'the Q4 token bar fill rule must exist to be gated').toBeTruthy()
    expect(rule![1], 'the fill is gated as a whole token — no alpha, no opacity')
      .not.toMatch(/\bopacity\s*:/)
    expect(rule![1]).toMatch(/background:\s*var\(--accent\)/)
    // No other rule may reintroduce it either (round 4 shipped a `.sel` variant at 0.85).
    for (const match of css.matchAll(/\.tokbar[^{]*\{([^}]*)\}/g)) {
      expect(match[1], `\`${match[0].split('{')[0]!.trim()}\` must not composite the fill`)
        .not.toMatch(/\bopacity\s*:\s*0?\.\d/)
    }
    // …and the pair the fill actually paints is IN the gate, at the UI threshold.
    const bar = PAIRS.find((p) => p.label.startsWith('agents token-bar fill'))!
    expect(bar, 'the token bar pair must be gated').toBeDefined()
    expect(bar.role).toBe('ui')
    expect(Math.min(bar.light, bar.dark)).toBeGreaterThanOrEqual(3)
  })

  it('reproduces the ratios the comps README publishes', () => {
    // Spot-checks against docs/frontend/comps/README.md's table. If the port drifted, the
    // published numbers would become fiction; these pin the ones the deviations argue.
    const byLabel = new Map(PAIRS.map((p) => [p.label, p]))
    const check = (label: string, light: string, dark: string) => {
      const p = byLabel.get(label)
      expect(p, label).toBeDefined()
      expect(r2(p!.light), `${label} light`).toBe(light)
      expect(r2(p!.dark), `${label} dark`).toBe(dark)
    }
    check('--text on --canvas', '16.48', '15.68')
    check('--accent link on --surface-raised', '4.92', '7.00')   // D2
    check('--st-stale label on --surface', '5.32', '8.34')       // D3, the worst offender
    check('--st-queued label on --surface', '5.20', '5.42')      // D4
    check('adapter amp monogram on --ad-amp-tint', '4.78', '7.64') // D5
    check('adapter mock monogram on --ad-mock-tint', '4.56', '4.87') // D6
    check('--border (input edge) on --surface', '3.77', '3.27')  // D7
    check('ANSI 8 bright black on --well', '5.07', '5.07')       // D8
  })

  it('keeps the terminal well theme-invariant (§3.2, decision final)', () => {
    for (const p of PAIRS) {
      if (!p.label.includes('--well')) continue
      expect(p.light, p.label).toBeCloseTo(p.dark, 10)
    }
    expect(hex(WELL.bg)).toBe(hex(WELL.bg))
  })

  it('separates every status color from its own tint in both themes', () => {
    // The chip pairs already assert 4.5:1, but a token that accidentally resolved to the
    // SAME value in both slots would also "pass" a naive equality-free check. Pin that
    // the fg and bg are genuinely different colors.
    for (const theme of ['light', 'dark'] as const) {
      for (const key of Object.keys(TOK[theme])) {
        if (!key.endsWith('-tint')) continue
        const base = key.slice(0, -'-tint'.length)
        expect(hex(TOK[theme][base]!), `${theme} ${key}`).not.toBe(hex(TOK[theme][key]!))
        expect(contrast(TOK[theme][base]!, TOK[theme][key]!)).toBeGreaterThan(1.5)
      }
    }
  })
})
