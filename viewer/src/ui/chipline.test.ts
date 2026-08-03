// The class-wide overflow rule, as an invariant over the shipped stylesheets and markup.
//
// Two shipped defects had ONE root cause — a `flex: none` chip inside a row whose overflow
// computed to `visible`, so the chip left its box and painted over the neighbour:
//
//   • the agents table's `spawn_failed` badge measured x699.45–793.30 inside a `.c-state`
//     cell ending at x736, on top of the `wait` column's value (1280px, run rail open);
//   • the read-only cockpit header's lifecycle row measured 791px inside a 924px container
//     it started 509px into, putting a destructive `Delete` button on the inbox rail.
//
// The geometry is proved in a real browser by `e2e/viewer.spec.ts`. This file guards the
// thing a browser test cannot: that the CURE stays class-wide. A future row that hosts chips
// and re-invents `flex: none` locally is the same defect again, and the point of `.chipline`
// is that there is one place to look.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const primitives = read('./primitives.css')
const cockpit = read('../features/cockpit/cockpit.css')
const agentsTab = read('../features/cockpit/AgentsTab.tsx')
const runHeader = read('../features/cockpit/RunHeader.tsx')

/** The declarations of one rule, by exact selector text. */
function block(css: string, selector: string): string {
  const at = css.indexOf(selector)
  expect(at, `missing rule: ${selector}`).toBeGreaterThan(-1)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('the .chipline rule (primitives.css)', () => {
  it('clips, and can shrink — a chip row that cannot shrink overflows its column', () => {
    const decls = block(primitives, '.chipline {')
    expect(decls).toMatch(/min-width:\s*0/)
    expect(decls).toMatch(/overflow:\s*hidden/)
  })

  it('lets its chips and badges shrink and ellipsize instead of escaping', () => {
    const decls = block(primitives, '.chipline > .chip, .chipline > .badge {')
    expect(decls).toMatch(/flex:\s*0 1 auto/)
    expect(decls).toMatch(/min-width:\s*0/)
    expect(decls).toMatch(/text-overflow:\s*ellipsis/)
    expect(decls).toMatch(/white-space:\s*nowrap/)
  })

  it('gives a row of CONTROLS wrapping instead of clipping, and keeps it shrinkable', () => {
    const decls = block(primitives, '.chipline.wrap {')
    expect(decls).toMatch(/flex-wrap:\s*wrap/)
    expect(decls).toMatch(/flex:\s*0 1 auto/)
    // `flex: none` here is the exact shipped bug: it removes the shrink, so the row
    // overflows its container before it ever reaches its own wrap point.
    expect(decls).not.toMatch(/flex:\s*none/)
  })
})

describe('both shipped defects opt into it', () => {
  it('the agents-table state cell is a chipline and no longer pins its badge', () => {
    expect(agentsTab).toMatch(/className="c-state st-cell chipline"/)
    // The status chip keeps `flex: none` — it is the cell's subject and never yields — but
    // the error CODE must not, or it is unshrinkable again.
    const chip = block(cockpit, '.at-row .st-cell .chip {')
    expect(chip).toMatch(/flex:\s*none/)
    expect(cockpit).not.toMatch(/\.at-row \.st-cell \.chip, \.at-row \.st-cell \.badge \{ flex: none; \}/)
  })

  it('the error message yields before the error code does', () => {
    const errmsg = block(cockpit, '.at-row .errmsg {')
    // A shrink factor of 100 against the badge's 1 states the priority as a number.
    expect(errmsg).toMatch(/flex:\s*0 100 auto/)
  })

  it('the cockpit header action row is a wrapping chipline, and its line wraps too', () => {
    expect(runHeader).toMatch(/className="rhead-actions chipline wrap"/)
    expect(block(cockpit, '.rhead-actions {')).not.toMatch(/flex:\s*none/)
    expect(block(cockpit, '.rhead-top {')).toMatch(/flex-wrap:\s*wrap/)
  })

  it('the result view’s Resume row uses the same rule rather than a fourth local fix', () => {
    expect(read('../features/result/Result.tsx')).toMatch(/className="res-actions chipline wrap"/)
  })
})
