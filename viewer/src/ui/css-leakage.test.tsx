// @vitest-environment jsdom
//
// The other half of the J1 guard. `css-scope.test.ts` reads selectors; this file loads the
// real stylesheets into a real document and asks the cascade what a feature's markup
// actually computes to — which is the question the shipped bugs were answers to.
//
// jsdom performs no LAYOUT, so nothing here measures a rectangle (Playwright does that in
// `e2e/viewer.spec.ts`). It does implement the CASCADE, and each of these three regressions
// was a cascade fact — a property one feature set on another feature's element. Every
// assertion below fails on the pre-J1 tree.
//
// The stylesheets are concatenated in a fixed order, which is safe here BY CONSTRUCTION:
// each assertion names a property that only the leaking rule ever set, so no ordering
// between the feature files can decide it. The second describe repeats the Home case
// against the committed `dist/app.css`, because that file — not these sources — is what an
// installed user's browser loads (§4.6).

import { cleanup, render, screen, within } from '@testing-library/react'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Home } from '../features/home/Home.js'
import { BLOCKED_DETAIL, RUNS_PAGE, SESSION } from '../features/home/fixtures.js'
import { resetRouteForTests } from '../app/router.js'

// jsdom rewrites `import.meta.url` to an http URL, so these resolve from vitest's root
// (`viewer/`) instead — the same way `dist-freshness.test.ts` reaches the built bundle.
const SRC = resolve(process.cwd(), 'src')
const DIST = resolve(process.cwd(), 'dist/app.css')

function sourceCss(): string {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.css')) found.push(path)
    }
  }
  walk(SRC)
  return found.sort().map((path) => readFileSync(path, 'utf8')).join('\n')
}

const loadCss = (css: string) => {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
}

/**
 * Build an element tree by hand. `innerHTML` and every sibling sink are forbidden anywhere
 * under `viewer/src` (§7.1.6, `no-innerhtml.test.ts`, allowlist empty) — including here.
 */
function el(tag: string, className: string, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  node.append(...children)
  return node
}
/** Mount a fixture tree and hand back the element to interrogate. */
function paint(tree: HTMLElement, selector: string): HTMLElement {
  document.body.append(tree)
  const found = document.querySelector<HTMLElement>(selector)
  if (!found) throw new Error(`no ${selector} in the fixture markup`)
  return found
}

afterEach(() => { cleanup(); document.head.replaceChildren(); document.body.replaceChildren() })

describe('no feature stylesheet restyles another feature’s markup', () => {
  beforeEach(() => {
    loadCss(sourceCss())
    window.history.replaceState(null, '', '/#/')
    resetRouteForTests()
  })

  it('leaves Home’s agent counts legible — the mini bar stays in its row (§2.3)', async () => {
    // THE regression. cockpit.css declared a bare `.bar { position: absolute; top: 50%;
    // transform: translateY(-50%) }` for its Gantt lanes; Home's progress cell reuses the
    // class name (RunTable.tsx:185) and overrides only width/height/border-radius/background,
    // never `position`. The 34px bar therefore left `.progress-mini`'s flex row and painted
    // across the digits at the text midline — every completed run read as struck through.
    render(
      <Home
        loadRuns={() => Promise.resolve(RUNS_PAGE)}
        loadDetail={() => Promise.resolve(BLOCKED_DETAIL)}
        loadSession={() => Promise.resolve(SESSION)}
        virtualize={false}
      />,
    )
    const list = await screen.findByRole('list', { name: 'Runs' })
    const cells = [...list.querySelectorAll<HTMLElement>('.progress-mini')]
      .filter((cell) => cell.querySelector('.bar'))
    expect(cells.length, 'no run in the fixture renders an agent count').toBeGreaterThan(0)

    for (const cell of cells) {
      const bar = cell.querySelector<HTMLElement>('.bar')!
      const style = getComputedStyle(bar)
      // In normal flow, so it occupies a slot in the row rather than overlaying the digits.
      // jsdom reports an untouched property as '', which is exactly the point: no rule
      // reaches this element to set them at all.
      expect(style.position, 'the Home mini bar must stay in flow').toBe('')
      expect(style.top, 'nothing may pin the Home mini bar to a text midline').toBe('')
      expect(style.transform).toBe('')
      // …and home.css's own rule still does reach it, so the assertions above are not
      // passing because nothing matched anything.
      expect(style.width).toBe('34px')
      expect(style.height).toBe('3px')
      // The count itself is a sibling of the bar, not underneath it.
      expect(within(cell).getByText(/\d+\/\d+/)).toBeTruthy()
    }
  })

  it('leaves the saturation strip’s steps unbordered (§2.4)', () => {
    // transcript.css's step card declared a bare `.step { border: 1px solid var(--hairline);
    // border-radius: var(--r2) }`. The cockpit's saturation bars carry the same class
    // (Timeline.tsx:391) and `.sat-plot .step` sets only `border-top`, so every 1–2px bar in
    // the strip picked up a hairline on its other three sides.
    const step = paint(
      el('div', 'sat-body', el('div', 'sat-plot', el('div', 'step pinned'))),
      '.sat-plot .step',
    )
    const style = getComputedStyle(step)
    expect(style.border, 'a saturation bar carries no border but its own top rule').toBe('')
    expect(style.borderRadius, 'a 1px bar is not a 6px rounded card').toBe('')
    // The plot's own rule still reaches it — the fix scoped the transcript, it did not
    // disarm the strip.
    expect(style.position).toBe('absolute')
  })

  it('leaves a cockpit degradation note top-aligned and readable (§6.5)', () => {
    // transcript.css's raw-group BUTTON was also called `.rawgrp` and loads later, so it was
    // overriding the cockpit note's `align-items: flex-start` with `center` and its 1.5
    // line-height with 1 — cramping every multi-line note (Cockpit.tsx:533 and four others).
    const note = paint(el('div', 'rawgrp', el('b', '', 'older engine'), ' no queue events'), '.rawgrp')
    const style = getComputedStyle(note)
    expect(style.alignItems).toBe('flex-start')
    expect(style.font).toContain('/1.5')
  })

  it('leaves the cockpit’s collapsed inbox strip sized by the cockpit (§3.7)', () => {
    // shell.css's collapsed run rail used a bare `.strip`, which also matched the cockpit's
    // `<div className="col strip inbox-strip">` (cockpit/InboxRail.tsx:205) and pushed
    // `flex: 1` at a column that asks for `flex: none`.
    const strip = paint(
      el('div', 'cockpit', el('div', 'col strip inbox-strip')),
      '.col.strip',
    )
    expect(getComputedStyle(strip).flexGrow === '' || getComputedStyle(strip).flexGrow === '0').toBe(true)
  })
})

describe('the committed bundle (§4.6)', () => {
  it('ships the Home fix in dist/app.css, not only in the sources', () => {
    // `viewer/dist` is what an installed user loads. A green source-level fix with a stale
    // bundle is a fix nobody receives.
    expect(existsSync(DIST), 'run `npm --prefix viewer run build`').toBe(true)
    loadCss(readFileSync(DIST, 'utf8'))
    const bar = paint(
      el('span', 'progress-mini', el('span', 'bar', el('i', 'd')), el('span', '', '14/14')),
      '.progress-mini .bar',
    )
    expect(getComputedStyle(bar).position, 'the built bundle is stale').toBe('')
    expect(getComputedStyle(bar).height).toBe('3px')
  })
})
