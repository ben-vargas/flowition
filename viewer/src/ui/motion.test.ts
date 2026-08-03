// §3.4's motion budget, as an invariant over the shipped stylesheets.
//
// "The running-state spinner is the only looping animation." That is a design decision
// with teeth: a screen where a second thing loops has no single place the eye goes when
// something is actually happening. The skeleton used to pulse forever, which is exactly
// the failure — a page still loading looked as busy as a page running work.
//
// Everything else may animate, but only ONCE per state change (the 300ms state pulse, the
// skeleton's fade-in, disclosure and hover transitions).

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const srcDir = fileURLToPath(new URL('..', import.meta.url))

function sheets(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sheets(full))
    else if (entry.name.endsWith('.css')) out.push(full)
  }
  return out
}

/** `animation:` shorthand and `animation-iteration-count:` declarations, one per line. */
function animationDecls(css: string): { file: string; text: string }[] {
  return css
    .split(/[;{}]/)
    .map((d) => d.trim())
    .filter((d) => /^animation(-iteration-count|-name)?\s*:/.test(d))
    .map((text) => ({ file: '', text }))
}

describe('§3.4 — the spinner is the only looping animation', () => {
  const files = sheets(srcDir)

  it('finds the stylesheets it is supposed to be guarding', () => {
    expect(files.length).toBeGreaterThan(2)
  })

  it('has exactly one infinite animation, and it is the spinner', () => {
    const looping: string[] = []
    for (const file of files) {
      const css = readFileSync(file, 'utf8')
      for (const decl of animationDecls(css)) {
        if (/\binfinite\b|iteration-count\s*:\s*infinite/.test(decl.text)) {
          looping.push(`${path.relative(srcDir, file)}: ${decl.text}`)
        }
      }
    }
    expect(looping, looping.join('\n')).toHaveLength(1)
    expect(looping[0]).toMatch(/spin/)
  })

  it('does not let the loading skeleton pulse', () => {
    const css = readFileSync(path.join(srcDir, 'ui', 'primitives.css'), 'utf8')
    const skeleton = /\.skel\s*\{[^}]*\}/g
    const blocks = css.match(skeleton) ?? []
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).not.toMatch(/\binfinite\b/)
      expect(block).not.toMatch(/alternate/)
    }
  })

  it('still kills the spinner under prefers-reduced-motion (§3.4 / §3.6)', () => {
    const css = readFileSync(path.join(srcDir, 'ui', 'base.css'), 'utf8')
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/.exec(css)
    expect(block, 'base.css must carry a prefers-reduced-motion block').not.toBeNull()
    expect(block![0]).toMatch(/animation-iteration-count:\s*1\s*!important/)
    expect(block![0]).toMatch(/transition-duration:\s*0\.01ms\s*!important/)
  })
})
