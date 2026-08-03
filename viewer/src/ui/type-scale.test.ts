// §3.1's type scale, as a gate on the SHIPPED stylesheets.
//
// The rule itself — the approved set, the `.ad` monogram exemption, the two spellings a
// declaration can take — lives in `docs/frontend/comps/lib/type-scale.mjs` and is shared
// with `test/comps-type-scale.test.js`, which runs the same validator over the reference
// comps. Review round 4 is why: this test found and fixed a 10px tier in `viewer/src` and
// stayed green while the normative comp stylesheet kept seven 9px declarations, because it
// scanned `viewer/src` only. §3.7 makes the comps the thing W11 builds against, so a scale
// the product obeys and the reference drawings do not is a contract disagreeing with
// itself. One validator, two suites, both stylesheets.
//
// (The shared module is plain ESM outside `viewer/`, which is an established pattern here —
// `vite.config.ts` already allows it for the shared fold module, §9.2.)

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  APPROVED, MONOGRAM, WHY, describe as line, fontSizes, offenders, tokenSizes,
} from '../../../docs/frontend/comps/lib/type-scale.mjs'

const SRC = fileURLToPath(new URL('..', import.meta.url))

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return cssFiles(full)
    return full.endsWith('.css') ? [full] : []
  })
}

describe('§3.1 type scale', () => {
  const files = cssFiles(SRC)
  const all = files.flatMap((f) => fontSizes(readFileSync(f, 'utf8'), f.slice(SRC.length)))

  it('reads the stylesheets it claims to police', () => {
    // A guard on the guard: if the extraction silently stopped matching, the assertion
    // below would pass over an empty list and prove nothing. Sizes are overwhelmingly set
    // through the tokens, so the evidence that the scan is live is that it finds THOSE.
    expect(files.length).toBeGreaterThanOrEqual(4)
    expect(files.reduce((n, f) => n + tokenSizes(readFileSync(f, 'utf8')), 0)).toBeGreaterThan(40)
  })

  it('uses no px font size outside the approved scale', () => {
    expect(offenders(all).map(line), WHY).toEqual([])
  })

  it('spends the 9px monogram exception exactly once, on the badge §3.2 describes', () => {
    const nine = all.filter((d) => d.px === MONOGRAM.px)
    expect(nine).toHaveLength(1)
    expect(nine[0]!.selector).toBe(MONOGRAM.selector)
  })

  it('shares the approved set with the reference comps rather than restating it', () => {
    // If someone re-inlines the scale here, this fails — which is the whole point of the
    // shared module. The set is §3.1's, verbatim.
    expect([...APPROVED].sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 16, 20, 24])
  })
})
