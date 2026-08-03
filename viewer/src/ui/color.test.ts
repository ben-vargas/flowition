// The color math the §3.6 gate stands on. If these are wrong, every ratio in
// contrast.test.ts is confidently wrong too.

import { describe, expect, it } from 'vitest'
import { contrast, hex, luminance, mix, oklchToLinearSrgb } from './color.js'
import { LIGHT, THEMES } from './tokens.js'

describe('OKLCH → sRGB', () => {
  it('round-trips the achromatic anchors', () => {
    expect(hex([0, 0, 0])).toBe('#000000')
    expect(hex([1, 0, 0])).toBe('#ffffff')
    // OKLab lightness is perceptual, not sRGB-linear: L=0.5 paints #636363, appreciably
    // darker than sRGB's #808080 mid grey. Pinning the real value is the point — a
    // "looks about right" transform would sail past this.
    expect(hex([0.5, 0, 0])).toBe('#636363')
    expect(hex([0.63, 0, 0])).toBe('#898989')
  })

  it('clips out-of-gamut colors the way a browser paints them', () => {
    // Chroma far beyond sRGB: every channel clamps into range rather than going NaN or
    // wrapping. This is the property that makes "passes on paper, fails on screen"
    // impossible.
    const painted = hex([0.6, 0.9, 25])
    expect(painted).toMatch(/^#[0-9a-f]{6}$/)
    const [r, g, b] = oklchToLinearSrgb(0.6, 0.9, 25)
    expect(Math.max(r, g, b)).toBeGreaterThan(1)     // genuinely out of gamut
    expect(Number.isFinite(luminance([0.6, 0.9, 25]))).toBe(true)
  })

  it('computes WCAG contrast symmetrically, with black-on-white at 21:1', () => {
    expect(contrast([0, 0, 0], [1, 0, 0])).toBeCloseTo(21, 4)
    expect(contrast([1, 0, 0], [0, 0, 0])).toBeCloseTo(21, 4)
    expect(contrast([0.5, 0, 0], [0.5, 0, 0])).toBeCloseTo(1, 6)
  })
})

describe('mix() — deviation D1, ruled to STAND', () => {
  it('interpolates in OKLab, so --surface-selected is a cool tint and NOT pale green', () => {
    // The exact case the deviation is about: light theme, accent 10% into canvas.
    // In OKLab: #e1e8ef. In OKLCH the hue walks the 160° arc to H=111 and paints
    // #e9eadc — a pale GREEN — which is why §3.2's `in oklch` had to be amended.
    const selected = mix(THEMES.light.accent, THEMES.light.canvas, 10)
    expect(hex(selected)).toBe('#e1e8ef')
    expect(hex(LIGHT['surface-selected']!)).toBe('#e1e8ef')

    // Blue channel above green is the whole point: a cool tint, not a warm/green one.
    const [, g, b] = [1, 2, 3].map((_, i) => parseInt(hex(selected).slice(1 + i * 2, 3 + i * 2), 16))
    expect(b!).toBeGreaterThan(g!)
  })

  it('is an identity at 100% and 0%', () => {
    const a = THEMES.dark.accent
    const b = THEMES.dark.canvas
    expect(hex(mix(a, b, 100))).toBe(hex(a))
    expect(hex(mix(a, b, 0))).toBe(hex(b))
  })

  it('keeps the neutral ramp neutral (the quieter half of D1)', () => {
    // In OKLCH the same mixes drift green at C≈0.005. In OKLab a hairline between two
    // near-neutral anchors keeps chroma tiny.
    const hairline = mix(THEMES.light.ink, THEMES.light.canvas, 12)
    expect(hairline[1]).toBeLessThan(0.01)
  })
})
