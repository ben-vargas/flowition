// DESIGN §3.1's type scale, enforced on the REFERENCE COMPS as well as the product.
//
// Review round 4 found the hole this closes. The runtime stylesheet had just had an
// unapproved 10px tier removed and a gate written for it — `viewer/src/ui/type-scale.
// test.ts` — but that gate scans `viewer/src`, and the comp stylesheet still carried seven
// non-monogram 9px declarations. §3.7 makes the comps normative ("W8/W11 acceptance then
// includes a side-by-side of built screens against the approved comps"), so the reference
// drawings could drift below §3.1's floor indefinitely with every test green, and W11 would
// have been building against a typography the spec forbids.
//
// The validator is `docs/frontend/comps/lib/type-scale.mjs`, shared with the viewer suite,
// so the scale cannot be amended for one stylesheet and not the other. This file points it
// at the comps; the viewer file points it at `viewer/src`. Both must be empty.
//
// The scan is over the comp lib's SOURCE, not the emitted HTML, so it catches both the
// stylesheet in `css.mjs` and the inline `style="font-size:…"` attributes the page modules
// write — the emitted HTML is generated from exactly these files, and a violation there is
// a violation here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APPROVED, MONOGRAM, WHY, describe, fontSizes, offenders, tokenSizes,
} from '../docs/frontend/comps/lib/type-scale.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(ROOT, 'docs', 'frontend', 'comps', 'lib')

const sources = fs.readdirSync(LIB).filter((f) => f.endsWith('.mjs')).sort()
const read = (f) => fs.readFileSync(path.join(LIB, f), 'utf8')

test('§3.1: the comp stylesheet is scanned, and it is the one that draws the comps', () => {
  // A guard on the guard — an extraction that silently stopped matching would report zero
  // offenders forever. Sizes are overwhelmingly set through the §3.1 tokens, so the
  // evidence the scan is live is that it finds THOSE.
  assert.ok(sources.includes('css.mjs'), 'the comp stylesheet must be among the scanned sources')
  assert.ok(sources.length >= 8, `expected the comp lib's modules, found ${sources.length}`)
  assert.ok(
    sources.reduce((n, f) => n + tokenSizes(read(f)), 0) > 40,
    'the scan found almost no var(--fs-*) declarations — it is no longer reading the CSS',
  )
})

test('§3.1: the reference comps use no px font size outside the approved scale', () => {
  const all = sources.flatMap((f) => fontSizes(read(f), `docs/frontend/comps/lib/${f}`))
  assert.ok(all.length > 0, 'no hard-coded px sizes found at all — the extraction is broken')
  assert.deepEqual(offenders(all).map(describe), [], WHY)
})

test('§3.2: the comps spend the 9px monogram exception exactly once, on .ad', () => {
  const nine = sources
    .flatMap((f) => fontSizes(read(f), `docs/frontend/comps/lib/${f}`))
    .filter((d) => d.px === MONOGRAM.px)
  assert.deepEqual(
    nine.map(describe).map((s) => s.replace(/:\d+ /, ' ')),
    ['docs/frontend/comps/lib/css.mjs — 9px on ".ad"'],
    '§3.2 reserves 9px for the adapter monogram and for nothing else. A 9px label is not a '
    + 'badge glyph; use var(--fs-micro).',
  )
})

test('§3.1: product and comps share one approved set, not two copies of it', () => {
  // The drift this whole file exists to stop is two validators disagreeing. If the set is
  // ever re-inlined into either suite, one of them stops matching §3.1 and this catches it.
  assert.deepEqual([...APPROVED].sort((a, b) => a - b), [11, 12, 13, 14, 16, 20, 24])
  assert.deepEqual(MONOGRAM, { px: 9, selector: '.ad' })
  const viewerGate = fs.readFileSync(
    path.join(ROOT, 'viewer', 'src', 'ui', 'type-scale.test.ts'), 'utf8',
  )
  assert.match(
    viewerGate, /from '\.\.\/\.\.\/\.\.\/docs\/frontend\/comps\/lib\/type-scale\.mjs'/,
    'the viewer suite must import the shared validator rather than restate the scale',
  )
})
