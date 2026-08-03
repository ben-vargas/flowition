// The design system's structural invariants: the emitted stylesheet matches its source,
// the D1 ruling holds in the CSS a browser actually loads, and the sprite is the
// 43-glyph inventory the operator approved.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ADAPTER_MONO, ADAPTER_ORDER, STATUS_ORDER, THEMES, tokenCss } from './tokens.js'
import { GLYPH_NAMES, GLYPH_PATHS, STATE_LOOK, lookUpState, spins } from './icons.js'
import { HEADER } from '../../scripts/emit-tokens.mjs'

const cssPath = fileURLToPath(new URL('./tokens.css', import.meta.url))
const css = readFileSync(cssPath, 'utf8')

describe('tokens.css', () => {
  it('is byte-identical to what tokens.ts emits (run `npm run tokens`)', () => {
    expect(css).toBe(`${HEADER}\n${tokenCss()}\n`)
  })

  it('mixes in OKLAB everywhere — deviation D1, ruled to STAND', () => {
    // The one-line version of the whole deviation: no `color-mix(in oklch, …)` may exist
    // in the shipped stylesheet, in either theme.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')   // the header comment is prose
    expect(rules).not.toMatch(/color-mix\(\s*in\s+oklch/i)
    const spaces = [...rules.matchAll(/color-mix\(\s*in\s+([\w-]+)/g)].map((m) => m[1])
    expect(spaces.length).toBeGreaterThan(30)
    expect(new Set(spaces)).toEqual(new Set(['oklab']))
    // Every `color-mix(` occurrence must have been one of those — no bare or malformed
    // call slipped through the count.
    expect((rules.match(/color-mix\(/g) ?? []).length).toBe(spaces.length)
  })

  it('keeps the anchor technique live — surfaces derive from --ink and --canvas', () => {
    // §3.2's two-anchor technique: move the canvas and
    // every surface follows. That only stays true if the derived tokens are emitted as
    // color-mix() calls over var(--canvas), not as frozen literals.
    for (const token of ['--surface', '--surface-raised', '--hairline', '--border', '--text-2', '--text-3']) {
      const rule = new RegExp(`${token}:\\s*color-mix\\(in oklab, var\\(--ink\\) \\d+%, var\\(--canvas\\)\\)`)
      expect(css, token).toMatch(rule)
    }
    expect(css).toMatch(/--surface-selected:\s*color-mix\(in oklab, var\(--accent\) \d+%, var\(--canvas\)\)/)
  })

  it('defines both themes plus the theme-invariant terminal well', () => {
    expect(css).toContain('[data-theme="light"] {')
    expect(css).toContain('[data-theme="dark"] {')
    expect(css).toMatch(/:root \{[\s\S]*--well:/)
    for (let i = 0; i < 16; i++) expect(css).toContain(`--ansi-${i}:`)
    // §3.2 "Decision final": the well is fixed in BOTH themes, so it must live on :root
    // and never be redeclared inside a theme block.
    const light = css.slice(css.indexOf('[data-theme="light"]'), css.indexOf('[data-theme="dark"]'))
    expect(light).not.toContain('--well')
  })

  it('declares every §3.2 status and adapter token in both themes', () => {
    for (const block of ['light', 'dark'] as const) {
      const start = css.indexOf(`[data-theme="${block}"]`)
      const body = css.slice(start, css.indexOf('}', start))
      for (const s of STATUS_ORDER) {
        expect(body, `${block} --st-${s}`).toContain(`--st-${s}:`)
        expect(body, `${block} --st-${s}-tint`).toContain(`--st-${s}-tint:`)
      }
      for (const a of ADAPTER_ORDER) {
        expect(body, `${block} --ad-${a}`).toContain(`--ad-${a}:`)
        expect(body, `${block} --ad-${a}-tint`).toContain(`--ad-${a}-tint:`)
      }
      expect(body).toContain(`color-scheme: ${block}`)
    }
  })

  it('keeps the dark theme §3.2 verbatim', () => {
    // The deviations are light-theme contrast fixes (D2, D3, D5); dark was already
    // passing and must not have been "fixed" along with it.
    expect(THEMES.dark.canvas).toEqual([0.165, 0.012, 255])
    expect(THEMES.dark.ink).toEqual([0.93, 0.006, 95])
    expect(THEMES.dark.accent).toEqual([0.72, 0.13, 255])
    expect(THEMES.dark.status.running).toEqual([0.70, 0.14, 250])
    expect(THEMES.dark.status.done).toEqual([0.70, 0.13, 150])
    expect(THEMES.dark.status.cached).toEqual([0.72, 0.10, 190])
    expect(THEMES.dark.status.failed).toEqual([0.66, 0.19, 25])
    expect(THEMES.dark.status.stale).toEqual([0.76, 0.14, 75])
    expect(THEMES.dark.status.blocked).toEqual([0.70, 0.15, 300])
    expect(THEMES.dark.adapters).toEqual({
      claude: [0.72, 0.12, 40], codex: [0.72, 0.10, 220], amp: [0.78, 0.11, 85],
      droid: [0.74, 0.12, 130], opencode: [0.70, 0.12, 295], pi: [0.72, 0.12, 350],
    })
  })
})

describe('the §3.5 icon sprite', () => {
  it('keeps ALL 43 glyphs — the W8a ruling 2 rejects "~24" as a budget', () => {
    expect(GLYPH_NAMES).toHaveLength(43)
  })

  it('keeps the four file-action glyphs and clock/bolt (ruling 2, explicitly)', () => {
    for (const name of ['filenew', 'fileedit', 'filedel', 'filemove', 'clock', 'bolt']) {
      expect(GLYPH_NAMES, name).toContain(name)
    }
  })

  it('keeps 11 status marks — the nine §3.2 states plus unknown and orphaned', () => {
    for (const s of STATUS_ORDER) expect(GLYPH_NAMES, s).toContain(s)
    expect(GLYPH_NAMES).toContain('unknown')   // parity #56
    expect(GLYPH_NAMES).toContain('orphaned')  // §6.4 step 8 / parity #58
  })

  it('keeps chevdown separate from chevron', () => {
    // A rotated chevron would inherit the disclosure transition and animate when it must
    // not — that is the argument, so the two must stay distinct symbols.
    expect(GLYPH_PATHS.chevron).not.toEqual(GLYPH_PATHS.chevdown)
  })

  it('has unique ids and non-empty geometry for every glyph', () => {
    expect(new Set(GLYPH_NAMES).size).toBe(GLYPH_NAMES.length)
    for (const [name, parts] of Object.entries(GLYPH_PATHS)) {
      expect(parts.length, name).toBeGreaterThan(0)
      for (const part of parts) {
        if (part.t === 'path') expect(part.d.length, name).toBeGreaterThan(2)
        else if (part.t === 'circle') expect(part.r, name).toBeGreaterThan(0)
        else expect(part.w * part.h, name).toBeGreaterThan(0)
      }
    }
  })
})

describe('the state vocabulary', () => {
  it('maps an UNKNOWN state to the neutral info circle, never a success check (#56)', () => {
    for (const state of ['unknown', 'corrupt-result', 'something-a-newer-engine-emits', '']) {
      const [, glyph] = lookUpState(state)
      expect(glyph, state).toBe('unknown')
      expect(glyph, state).not.toBe('done')
    }
  })

  it('carries a screen-reader label for every mark (§3.6 — never color alone)', () => {
    for (const [state, look] of Object.entries(STATE_LOOK)) {
      expect(look[2], state).toBeTruthy()
      expect(GLYPH_NAMES, `${state} → ${look[1]}`).toContain(look[1])
    }
  })

  it('spins only the running mark (§3.4: one looping animation)', () => {
    expect(spins('running')).toBe(true)
    for (const s of Object.keys(STATE_LOOK)) {
      if (s !== 'running') expect(spins(s), s).toBe(false)
    }
  })

  it('gives every §3.2 adapter a monogram and never a vendor brand mark (#57)', () => {
    for (const a of ADAPTER_ORDER) {
      expect(ADAPTER_MONO[a], a).toBeTruthy()
      expect(ADAPTER_MONO[a]!.length, a).toBeLessThanOrEqual(2)
    }
    expect(ADAPTER_MONO.pi).toBe('π')
    expect(ADAPTER_MONO.unknown).toBe('·')
  })
})
