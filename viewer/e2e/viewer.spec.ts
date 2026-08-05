import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import fs from 'node:fs'
import path from 'node:path'

import { AXE_ALLOWLIST } from './axe-allowlist.js'
import {
  MiB,
  generateEventsRun,
  generateRunHome,
  generateTranscriptRun,
} from '../../scripts/perf-fixtures.mjs'

// macOS unix-domain sockets cap sun_path at 104 bytes. Playwright inherits a long
// per-user TMPDIR, so use the real short system temp root for engine control sockets.
const HOME = fs.mkdtempSync('/tmp/fb-')
process.env.FLOWITION_HOME = HOME

const { runWorkflow } = await import('../../src/engine.js')
const { startViewer } = await import('../../src/viewer/index.js')

const RUNS = path.join(HOME, 'runs')
const ALL_CAPABILITIES = ['send', 'answer', 'cancel', 'resume', 'delete']
let viewer: Awaited<ReturnType<typeof startViewer>>
/**
 * A SECOND viewer, started without `--control`. §12.1 item 5's read-only clause is about a
 * presentation that only exists on this process: three lock chips beside three disabled
 * lifecycle buttons. That presentation is what overflowed the cockpit column, so the
 * regression cannot be driven from the `--control` viewer at all.
 */
let readOnly: Awaited<ReturnType<typeof startViewer>>
let liveCompletion: Promise<Record<string, unknown>>
const LIVE_RUN = 'flo_browser_live'
const TERMINAL_RUN = 'flo_browser_terminal'
const PERF_EVENTS_RUN = 'flo_browser_events_10mb'
// §2.6's other two shapes: an object value (JSON tree) and a failure (error + Resume).
const OBJECT_RUN = 'flo_browser_object'
const FAILED_RUN = 'flo_browser_failed'
const FIT_RUN = 'flo_browser_fit'

function workflow(name: string, source: string): string {
  const dir = path.join(HOME, 'workflows')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
  const file = path.join(dir, `${name}.workflow.js`)
  fs.writeFileSync(file, source)
  return file
}

function deepUrl(runId?: string, agent?: number): string {
  const route = runId == null
    ? '/'
    : agent == null
      ? `/run/${encodeURIComponent(runId)}`
      : `/run/${encodeURIComponent(runId)}/agent/${agent}`
  return `http://127.0.0.1:${viewer.port}/#${route}?t=${encodeURIComponent(viewer.token)}&c=${encodeURIComponent(viewer.controlToken!)}`
}

async function openAuthenticated(page: Page, runId?: string, agent?: number) {
  await page.goto(deepUrl(runId, agent))
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-swapping')
  await expect.poll(() => new URL(page.url()).hash).not.toContain('t=')
  await expect.poll(() => new URL(page.url()).hash).not.toContain('c=')
}

async function axe(page: Page, state: string) {
  const expired = AXE_ALLOWLIST.filter((entry) => Date.parse(entry.expires) <= Date.now())
  expect(expired, `expired axe allowlist entries while scanning ${state}`).toEqual([])

  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze()
  const unexpected = result.violations.flatMap((violation) =>
    violation.nodes
      .filter((node) => !AXE_ALLOWLIST.some((entry) =>
        entry.rule === violation.id && node.target.includes(entry.target)))
      .map((node) => ({
        rule: violation.id,
        impact: violation.impact,
        target: node.target.join(' '),
        summary: node.failureSummary,
      })))
  expect(unexpected, `${state}: automated WCAG A/AA violations`).toEqual([])
}

// ---- §3.6 contrast, sampled DURING a theme swap -------------------------------------
//
// axe scans a settled page. §3.6 is normative in BOTH themes AT ALL TIMES, and the frames
// during a swap are when that is hardest to keep: `color` is not transitioned anywhere,
// while `background` is (home.css, shell.css, cockpit.css, primitives.css), so a
// suppression release that lands before the new palette is committed renders one
// palette's text over the other's background until the interpolation ends. That state
// reached axe only by luck of timing — it measured 2.8:1 on the 11px column headers — so
// this probe stops relying on luck and samples every frame of the swap window.

interface SwapSample {
  path: string
  fg: [number, number, number, number]
  bg: [number, number, number]
  size: number
  weight: number
}

interface SwapReport {
  samples: SwapSample[]
  /** CSS transitions observed running during the swap window, by property. */
  transitions: string[]
}

/**
 * Install the in-page sampler: one sweep per animation frame for `windowMs` after
 * `data-theme` changes, which must outlast the longest transition on the page
 * (--d-panel, 200ms). It records two independent things — what every piece of text was
 * painted over, and whether any CSS transition was running at all.
 */
async function installSwapProbe(page: Page, windowMs = 500) {
  await page.evaluate((ms) => {
    const scope = window as unknown as {
      __floSwap?: { samples: SwapSample[]; transitions: string[]; busy: boolean }
    }
    const state = { samples: [] as SwapSample[], transitions: [] as string[], busy: false }
    scope.__floSwap = state

    // Computed colors here are `oklab(…)` — the tokens are color-mix(in oklab, …) — so
    // parse them the only way that cannot drift from what the engine actually paints:
    // hand the string back to the engine and read the pixel out.
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')!
    ctx.globalCompositeOperation = 'copy'
    // Cached because a sweep resolves the same handful of token colours hundreds of times
    // and `getImageData` is the slow part of the frame budget this probe has to live in.
    const parsed = new Map<string, [number, number, number, number]>()
    const toRgba = (css: string): [number, number, number, number] => {
      const hit = parsed.get(css)
      if (hit) return hit
      ctx.fillStyle = '#000000'
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      const rgba: [number, number, number, number] = [d[0]!, d[1]!, d[2]!, d[3]! / 255]
      parsed.set(css, rgba)
      return rgba
    }
    const over = (
      top: [number, number, number, number],
      under: [number, number, number],
    ): [number, number, number] => [
      Math.round(top[0] * top[3] + under[0] * (1 - top[3])),
      Math.round(top[1] * top[3] + under[1] * (1 - top[3])),
      Math.round(top[2] * top[3] + under[2] * (1 - top[3])),
    ]

    /** The painted background behind `el`: the first opaque ancestor, composited down. */
    const backgroundOf = (el: Element): [number, number, number] => {
      const stack: [number, number, number, number][] = []
      for (let node: Element | null = el; node; node = node.parentElement) {
        const rgba = toRgba(getComputedStyle(node).backgroundColor)
        if (rgba[3] === 0) continue
        stack.push(rgba)
        if (rgba[3] === 1) break
      }
      let base: [number, number, number] = [255, 255, 255]
      for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i]!, base)
      return base
    }

    const pathOf = (el: Element): string => {
      const parts: string[] = []
      for (let node: Element | null = el; node && parts.length < 3; node = node.parentElement) {
        const cls = typeof node.className === 'string' && node.className
          ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : ''
        parts.unshift(`${node.tagName.toLowerCase()}${cls}`)
      }
      return parts.join(' > ')
    }

    /**
     * Every element that renders its own visible text, at a size where the 4.5:1 floor
     * applies. Deliberately NOT a hand-picked list of the elements that once failed: the
     * defect class is "the palette is inconsistent for a while", which shows up wherever
     * a transitioned background sits under untransitioned text.
     */
    const targets = (): HTMLElement[] => {
      const out: HTMLElement[] = []
      for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
        const text = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? '')
          .join('')
          .trim()
        if (!text) continue
        if (el.closest('[disabled], [aria-disabled="true"], [aria-hidden="true"]')) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue
        const rect = el.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) continue
        if (rect.bottom < 0 || rect.top > innerHeight) continue
        out.push(el)
      }
      return out
    }

    // Dedupe within one swap window only: an element that holds the same (fg, bg) for the
    // whole window is one fact, but the SAME fact in the next window is a different one —
    // dark → light → dark ends where it began, and a probe that remembered across windows
    // would record nothing at all for the way back.
    let seen = new Set<string>()
    const sample = () => {
      for (const el of targets()) {
        const cs = getComputedStyle(el)
        const fg = toRgba(cs.color)
        if (fg[3] === 0) continue                 // `.absent` renders transparent by design
        const bg = backgroundOf(el)
        const key = `${pathOf(el)}|${fg.join(',')}|${bg.join(',')}`
        if (seen.has(key)) continue
        seen.add(key)
        state.samples.push({
          path: pathOf(el),
          fg,
          bg,
          size: parseFloat(cs.fontSize),
          weight: Number(cs.fontWeight) || 400,
        })
      }
      // The mechanism behind the contrast numbers, asserted separately: an atomic swap
      // starts NO transition, because the new palette was already committed before
      // suppression was released. One that starts even a single `background` transition
      // is interpolating out of the palette it just left, whatever this frame's contrast
      // happens to measure.
      for (const animation of document.getAnimations()) {
        const property = (animation as unknown as { transitionProperty?: string }).transitionProperty
        if (property && !state.transitions.includes(property)) state.transitions.push(property)
      }
    }

    // The baseline: the settled palette, before anything moves. If this were red the
    // probe would be stricter than axe and the failure would say so, in the same shape.
    sample()

    new MutationObserver(() => {
      state.busy = true
      seen = new Set<string>()
      const until = performance.now() + ms
      /**
       * One sample per frame, from inside the animation-frame callback — and NOT from
       * this mutation callback, which is a microtask that still runs inside the swap.
       *
       * That distinction is the difference between a probe and a placebo, and it was
       * measured, not assumed. `getComputedStyle` FORCES the style recalculation, and a
       * recalculation forced while `data-theme-swapping` is still set commits the whole
       * new palette with transitions suppressed — which is precisely what the fix in
       * `theme/theme.ts` does on purpose. A probe that sampled in the microtask therefore
       * repaired the defect it exists to catch: the un-fixed build passed it every time
       * while still rendering the smear.
       *
       * A frame callback samples after the release has run, so the recalculation it
       * forces is the same one the browser was about to do: any transition the swap left
       * un-suppressed starts here, at its FROM value, and the probe reads the mismatch on
       * the first frame instead of hoping axe's scan lands inside a 120ms window. That
       * hope is what made this defect look intermittent — on an idle machine the
       * transition finishes before axe injects.
       */
      const tick = () => {
        requestAnimationFrame(() => {
          sample()
          if (performance.now() < until) tick()
          else state.busy = false
        })
      }
      tick()
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }, windowMs)
}

const luminance = ([r, g, b]: [number, number, number]) => {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastOf(sample: SwapSample): number {
  const fg: [number, number, number] = [
    Math.round(sample.fg[0] * sample.fg[3] + sample.bg[0] * (1 - sample.fg[3])),
    Math.round(sample.fg[1] * sample.fg[3] + sample.bg[1] * (1 - sample.fg[3])),
    Math.round(sample.fg[2] * sample.fg[3] + sample.bg[2] * (1 - sample.fg[3])),
  ]
  const a = luminance(fg)
  const b = luminance(sample.bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** WCAG 2.2 AA: 3:1 for large text (≥24px, or ≥18.66px bold), 4.5:1 for everything else. */
const floorFor = (sample: SwapSample) =>
  sample.size >= 24 || (sample.size >= 18.66 && sample.weight >= 700) ? 3 : 4.5

async function drainSwapProbe(page: Page): Promise<SwapReport> {
  await expect
    .poll(() => page.evaluate(() =>
      (window as unknown as { __floSwap: { busy: boolean } }).__floSwap.busy), { timeout: 5_000 })
    .toBe(false)
  const report = await page.evaluate(() => {
    const state = (window as unknown as { __floSwap: SwapReport }).__floSwap
    const taken = { samples: state.samples, transitions: state.transitions }
    state.samples = []
    state.transitions = []
    return taken
  })
  expect(report.samples.length, 'the swap probe sampled nothing — it is not wired to the DOM')
    .toBeGreaterThan(20)
  return report
}

function expectContrastHeld(report: SwapReport, direction: string) {
  const failures = report.samples
    .map((sample) => ({ ...sample, ratio: contrastOf(sample), floor: floorFor(sample) }))
    .filter((sample) => sample.ratio < sample.floor)
    .map((sample) => `${sample.path}: ${sample.ratio.toFixed(2)}:1 (needs ${sample.floor}:1,`
      + ` fg rgba(${sample.fg.join(',')}) on rgb(${sample.bg.join(',')}), ${sample.size}px)`)
  expect(
    failures,
    `${direction}: §3.6 contrast must hold on EVERY frame of the swap, not only once it settles`
    + ` — ${report.samples.length} distinct (element, fg, bg) states sampled`,
  ).toEqual([])
  expect(
    report.transitions,
    `${direction}: an atomic swap commits the new palette BEFORE releasing suppression, so no`
    + ` transition can start out of the old one`,
  ).toEqual([])
}

async function cancelLiveRun() {
  if (!viewer) return
  await fetch(`http://127.0.0.1:${viewer.port}/api/runs/${LIVE_RUN}/cancel`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${viewer.token}`,
      origin: `http://127.0.0.1:${viewer.port}`,
      'content-type': 'application/json',
      'x-flowition-control': viewer.controlToken!,
    },
    body: '{}',
  }).catch(() => null)
}

test.beforeAll(async () => {
  generateRunHome(HOME, { count: 200 })

  const terminal = await runWorkflow({
    file: workflow('browser-terminal', `
export const meta = { name: 'browser terminal', description: 'W13 terminal fixture' }
export default async function ({ agent, phase }) {
  phase('Built')
  return agent('TOOL Read\\nECHO browser-complete', { adapter: 'mock', label: 'transcript' })
}
`),
    runId: TERMINAL_RUN,
    defaults: { adapter: 'mock', cwd: process.cwd() },
    quiet: true,
  })
  expect(terminal.status).toBe('completed')
  const transcript = path.join(RUNS, TERMINAL_RUN, 'agents', '0.jsonl')
  const rows: string[] = []
  for (let i = 0; i < 5_000; i++) {
    rows.push(JSON.stringify({
      t: i * 2 + 10,
      kind: 'tool',
      name: 'Read',
      input: JSON.stringify({ path: `src/file-${i}.js` }),
      id: `browser-tool-${i}`,
    }))
    rows.push(JSON.stringify({
      t: i * 2 + 11,
      kind: 'tool-result',
      name: 'Read',
      toolUseId: `browser-tool-${i}`,
      output: `read ${i}`,
      isError: false,
    }))
    // A non-work row closes each tool step; without it, grouping correctly treats all
    // 5,000 adjacent tool calls as one parallel step and there is nothing to virtualize.
    rows.push(JSON.stringify({
      t: i * 2 + 12,
      kind: 'status',
      text: `step ${i} complete`,
    }))
  }
  fs.appendFileSync(transcript, rows.join('\n') + '\n')

  const object = await runWorkflow({
    file: workflow('browser-object', `
export const meta = { name: 'browser object', description: 'W15 object-result fixture' }
export default async function ({ agent, phase }) {
  phase('Built')
  const echoed = await agent('ECHO shipped', { adapter: 'mock', label: 'objector' })
  return {
    shipped: echoed,
    counts: { agents: 1, phases: 1 },
    files: ['viewer.spec.ts', 'Result.tsx'],
    truncatedNothing: null,
  }
}
`),
    runId: OBJECT_RUN,
    defaults: { adapter: 'mock', cwd: process.cwd() },
    quiet: true,
  })
  expect(object.status).toBe('completed')

  await runWorkflow({
    file: workflow('browser-failed', `
export const meta = { name: 'browser failed', description: 'W15 failed-result fixture' }
export default async function () {
  throw new Error('the browser fixture refused to produce a result')
}
`),
    runId: FAILED_RUN,
    defaults: { adapter: 'mock', cwd: process.cwd() },
    quiet: true,
  }).catch(() => null)
  expect(JSON.parse(fs.readFileSync(path.join(RUNS, FAILED_RUN, 'result.json'), 'utf8')).status)
    .toBe('failed')

  liveCompletion = runWorkflow({
    file: workflow('browser-live', `
export const meta = { name: 'browser live', description: 'W13 live browser fixture' }
export default async function ({ spawn, ask, phase }) {
  phase('Waiting')
  const sleeper = spawn('SLEEP 60000\\nECHO never', { adapter: 'mock', label: 'sleeper' })
  const answer = await ask('Continue the browser fixture?', { id: 'browser-question' })
  return { answer, sleeper: await sleeper.done }
}
`),
    runId: LIVE_RUN,
    defaults: { adapter: 'mock', cwd: process.cwd() },
    quiet: true,
  }) as Promise<Record<string, unknown>>

  // The lower-exclusion-zone regression needs ONE pane that is both scrollable — so §2.5's
  // "Jump to latest" can be made to appear by pausing follow — and steerable, so Send is
  // enabled beneath it. Only the live run is steerable, and its sleeper agent is asleep for
  // 60 s and writes nothing in the meantime, so padding its transcript here is safe: the
  // appends are sequential and the viewer only tails the file.
  const liveTranscript = path.join(RUNS, LIVE_RUN, 'agents', '0.jsonl')
  for (let i = 0; i < 400 && !fs.existsSync(liveTranscript); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(fs.existsSync(liveTranscript), 'the live fixture never opened its transcript').toBe(true)
  const padding: string[] = []
  for (let i = 0; i < 400; i++) {
    padding.push(JSON.stringify({
      t: i * 2 + 10,
      kind: 'tool',
      name: 'Read',
      input: JSON.stringify({ path: `src/live-${i}.js` }),
      id: `live-tool-${i}`,
    }))
    padding.push(JSON.stringify({ t: i * 2 + 11, kind: 'status', text: `live step ${i}` }))
  }
  fs.appendFileSync(liveTranscript, padding.join('\n') + '\n')

  viewer = await startViewer({
    port: 0,
    primary: false,
    control: ALL_CAPABILITIES,
  })
  viewer.unref()
  readOnly = await startViewer({ port: 0, primary: false })
  readOnly.unref()
})

test.afterAll(async () => {
  await cancelLiveRun()
  await Promise.race([
    liveCompletion?.catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ])
  await viewer?.close()
  await readOnly?.close()
  fs.rmSync(HOME, { recursive: true, force: true })
})

/**
 * §7.1.4, on EVERY route this suite visits. The static assertions in
 * test/viewer-http.test.js grep the committed dist HTML — they cannot see a policy the
 * shipped bundle violates at runtime, which is exactly how react-aria's `usePress` got to
 * prepend a blocked `<style>` element on every cockpit load without a single test noticing
 * (panel round 2). This is the durable gate: the browser reports the violation, and the
 * violation fails the test that caused it.
 *
 * `pageerror` rides along for the same reason — an uncaught exception in the shipped
 * bundle is invisible to a suite that only asserts on the DOM it expects to find.
 *
 * The listener is installed via `addInitScript`, which Playwright evaluates before any
 * page script (and is not itself subject to the page's CSP), so violations raised while
 * the document is still parsing are captured too. Reports accumulate in Node through an
 * exposed binding rather than a page global, so a navigation mid-test cannot lose them.
 */
const cspViolations: string[] = []
const pageErrors: string[] = []

test.beforeEach(async ({ page }) => {
  cspViolations.length = 0
  pageErrors.length = 0
  page.on('pageerror', (error) => { pageErrors.push(error.stack ?? String(error)) })
  await page.exposeFunction('__floReportCsp', (report: string) => { cspViolations.push(report) })
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = `${event.effectiveDirective} blocked ${event.blockedURI || '(inline)'}`
        + ` from ${event.sourceFile ?? 'unknown'}:${event.lineNumber}`
        + (event.sample ? ` — sample: ${event.sample.slice(0, 120)}` : '')
      void (window as unknown as { __floReportCsp?: (r: string) => void }).__floReportCsp?.(report)
    })
  })
})

test.afterEach(async () => {
  expect(cspViolations, '§7.1.4: the shipped bundle must not violate its own CSP at runtime').toEqual([])
  expect(pageErrors, 'the shipped bundle must not raise an uncaught error on any visited route').toEqual([])
})

test.describe.serial('built viewer in a real browser', () => {
  test('token bootstrap, 200-run Home keyboard operation, both themes, and axe', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('flowition.theme', 'dark'))
    const started = performance.now()
    await openAuthenticated(page)
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
    // 200 generated + the terminal, live, object-result and failed-result fixtures.
    await expect(page.locator('.home-head .sub')).toContainText('204 runs')
    await expect(page.locator('.rt-scroll .rt-row').first()).toBeVisible()
    expect(await page.locator('.rt-scroll .rt-row').count()).toBeLessThan(100)
    const ttfmp = performance.now() - started
    console.log(`P1 browser TTFMP: ${ttfmp.toFixed(1)} ms for 200 visible/listed runs`)
    expect(ttfmp).toBeLessThan(process.env.CI ? 1_500 : 500)

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await axe(page, 'Home dark')
    await page.keyboard.press('d')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await axe(page, 'Home light')

    // Keyboard only: `/` reaches search, Escape returns to page navigation, then the
    // Home roving selection opens the sole filtered run via End + Enter.
    await page.keyboard.press('/')
    await expect(page.getByRole('textbox', { name: 'Filter by name or run id' })).toBeFocused()
    await page.keyboard.type(TERMINAL_RUN)
    await expect(page.locator('.rt-scroll .rt-row')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'browser terminal' })).toBeVisible()
  })

  /**
   * §9.9's swap is ATOMIC, in both directions — parity #110 read the way §3.6 forces it to
   * be read. The test above scans two settled palettes; this one scans the frames between
   * them, where the defect lived: the suppression release used to be scheduled on the next
   * animation frame, which runs BEFORE that frame's style recalculation, so the palette
   * committed with transitions already re-enabled and every `transition: background`
   * interpolated out of the old canvas under text that had already changed. Home's 11px
   * column headers measured 2.8:1 that way.
   *
   * Two independent gates, because they fail differently: the frame-by-frame probe catches
   * a swap that is not atomic even when nothing is left behind, and axe run AFTER each swap
   * catches a palette that is atomic but has landed somewhere wrong.
   */
  test('the theme swap is atomic in both directions, with axe green after each', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('flowition.theme', 'dark'))
    await openAuthenticated(page)
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
    // The rows the defect was found on have to be on screen, or the probe samples a page
    // that cannot show it.
    await expect(page.locator('.rt-row.head .lbl').first()).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await installSwapProbe(page)
    // The settled baseline the probe took at install time: if the sweep were stricter than
    // axe, this is where it would say so, instead of blaming the swap for it.
    expectContrastHeld(await drainSwapProbe(page), 'dark, settled')

    for (const [from, to] of [['dark', 'light'], ['light', 'dark']] as const) {
      await page.keyboard.press('d')
      await expect(page.locator('html')).toHaveAttribute('data-theme', to)
      expectContrastHeld(await drainSwapProbe(page), `${from} → ${to}`)
      // …and mid-sequence, on a page that has been swapped rather than booted into this
      // palette. A swap that leaves one surface behind is invisible to a fresh load.
      await axe(page, `Home ${to} after a ${from} → ${to} swap`)
      await expect(page.locator('html')).not.toHaveAttribute('data-theme-swapping')
    }
  })

  test('P3: a 10 MiB cockpit becomes interactive within budget', async ({ page }) => {
    const fixture = generateEventsRun(HOME, {
      runId: PERF_EVENTS_RUN,
      targetBytes: 10 * MiB,
    })
    expect(fixture.bytes).toBeGreaterThan(9.9 * MiB)
    // The metric is cockpit interactivity, not a second download/parse of the SPA bundle:
    // boot once on Home, then take the real hash-route + cold snapshot/fold path.
    await openAuthenticated(page)
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
    const started = performance.now()
    await page.evaluate((runId) => { location.hash = `#/run/${encodeURIComponent(runId)}` }, PERF_EVENTS_RUN)
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible()
    const interactive = performance.now() - started
    console.log(`P3 browser cockpit: ${interactive.toFixed(1)} ms for 10 MiB events.jsonl`)
    expect(interactive).toBeLessThan(process.env.CI ? 3_000 : 1_000)
  })

  test('P7: a dense 100 MiB transcript paints its first row within one second', async ({ page }) => {
    const fixture = generateTranscriptRun(HOME, {
      runId: 'perf_transcript_100mb_browser',
      targetBytes: 100 * MiB,
      tailBytes: 100 * MiB,
    })
    expect(fixture.bytes).toBeGreaterThan(99.9 * MiB)
    expect(fixture.bytes).toBeLessThanOrEqual(100 * MiB)
    expect(fixture.records).toBeGreaterThan(300_000)

    // Warm only the SPA shell. The timed work begins with the client-side route change and
    // includes the real detail request, dense tail fetch, JSON parse, projection, grouping,
    // React commit and one animation frame with the first row in the document. This is the
    // operator-visible metric §12.1 item 7 names; timing the server hop alone is not it.
    await openAuthenticated(page)
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
    const elapsed = await page.evaluate((runId) => new Promise<number>((resolve, reject) => {
      const started = performance.now()
      let timeout = 0
      const observer = new MutationObserver(() => finish())
      const finish = () => {
        if (!document.querySelector('.agent-transcript .virtual-row')) return
        observer.disconnect()
        window.clearTimeout(timeout)
        requestAnimationFrame(() => resolve(performance.now() - started))
      }
      observer.observe(document.body, { childList: true, subtree: true })
      timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('the dense transcript did not render a row within 10 seconds'))
      }, 10_000)
      location.hash = `#/run/${encodeURIComponent(runId)}/agent/0`
      finish()
    }), fixture.runId)
    console.log(
      `P7 browser first row: ${elapsed.toFixed(1)} ms for ${(fixture.bytes / MiB).toFixed(1)} MiB`
      + ` / ${fixture.records.toLocaleString()} dense records`,
    )
    expect(elapsed).toBeLessThanOrEqual(process.env.CI ? 3_000 : 1_000)

    const well = page.locator('.step-body-virtual')
    await expect(well).toBeVisible()
    await expect.poll(() => well.evaluate((element) => {
      const html = element as HTMLElement
      return html.scrollHeight > html.clientHeight
    })).toBe(true)
    const scrollState = await well.evaluate((element) => {
      const html = element as HTMLElement
      return {
        overflowY: getComputedStyle(html).overflowY,
        clientHeight: html.clientHeight,
        scrollHeight: html.scrollHeight,
      }
    })
    expect(scrollState.overflowY).not.toBe('hidden')
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight)
    await well.evaluate((element) => {
      const html = element as HTMLElement
      html.scrollTop = 0
      html.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(async () => Number(
      await page.locator('.step-item-virtual').first().getAttribute('data-index'),
    )).toBe(0)
    const firstIds = await page.locator('.step-item-virtual').evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.stepItemId).filter(Boolean))
    await well.evaluate((element) => {
      const html = element as HTMLElement
      html.scrollTop = html.scrollHeight
      html.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(async () => page.locator('.step-item-virtual').evaluateAll((rows, before) =>
      rows.some((row) => {
        const id = (row as HTMLElement).dataset.stepItemId
        return Boolean(id) && !(before as string[]).includes(id!)
      }), firstIds)).toBe(true)
  })

  test('pressables carry their touch-action from OUR stylesheet, not an injected one', async ({ page }) => {
    // The other half of the §7.1.4 fix. The suite-wide afterEach proves the injection no
    // longer violates the policy; this proves the behavior it bought was not simply lost.
    // Cockpit tabs are `useTab` → `usePress`, so opening a cockpit mounts pressables.
    await openAuthenticated(page, TERMINAL_RUN)
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible()

    const slot = await page.evaluate(() => {
      const el = document.getElementById('react-aria-pressable-style')
      return el ? { tag: el.tagName, text: el.textContent } : null
    })
    // A STYLE here means react-aria injected after all — blocked, and the rule is dead.
    expect(slot).toEqual({ tag: 'META', text: '' })

    const touchActions = await page.locator('[data-react-aria-pressable]')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).touchAction))
    expect(touchActions.length, 'no pressable mounted — this test proves nothing').toBeGreaterThan(0)
    // `pan-x pan-y pinch-zoom` IS `manipulation` — the browser serializes the longhand
    // triple back to the shorthand. The default with no rule at all is `auto`, asserted
    // below, so `manipulation` here can only have come from our declaration.
    expect(new Set(touchActions)).toEqual(new Set(['manipulation']))
    const unstyled = await page.locator('.step-head, .rt-row, main').first()
      .evaluate((node) => getComputedStyle(node).touchAction)
    expect(unstyled, 'a non-pressable must be untouched — otherwise the assertion above is vacuous').toBe('auto')
  })

  test('wide cockpit tabs, inbox rail, and log lane are axe-clean without a modal', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openAuthenticated(page, LIVE_RUN)
    await expect(page.getByRole('heading', { name: 'browser live' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Inbox' })).toBeVisible()

    await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true')
    await axe(page, 'wide live cockpit Timeline with inbox rail open')
    await page.getByRole('tab', { name: 'Structure' }).click()
    await axe(page, 'wide live cockpit Structure with inbox rail open')
    await page.getByRole('tab', { name: 'Agents' }).click()
    await axe(page, 'wide live cockpit Agents with inbox rail open')

    await page.keyboard.press('l')
    await expect(page.getByRole('heading', { name: 'log lane' })).toBeFocused()
    await axe(page, 'wide live cockpit Agents with inbox rail and log lane open')
    await page.getByRole('button', { name: 'Close log lane' }).click()
    await expect(page.getByRole('heading', { name: 'log lane' })).toBeHidden()
  })

  test('sub-900px drawer scrim restores focus; SSE reconnects; tabs and cancel are keyboard reachable', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 760 })
    let streamRequests = 0
    await page.route(`**/api/runs/${LIVE_RUN}/stream*`, async (route) => {
      streamRequests++
      if (streamRequests === 1) await route.abort('connectionreset')
      else await route.continue()
    })
    await openAuthenticated(page, LIVE_RUN)
    await expect(page.getByRole('heading', { name: 'browser live' })).toBeVisible()
    await expect.poll(() => streamRequests, { timeout: 8_000 }).toBeGreaterThanOrEqual(2)

    const opener = page.getByRole('button', { name: 'Expand run rail' })
    await opener.click()
    await expect(page.locator('.rail-head')).toBeFocused()
    await page.locator('.rail-scrim').click({ position: { x: 790, y: 300 } })
    await expect(opener).toBeFocused()

    const timeline = page.getByRole('tab', { name: 'Timeline' })
    await axe(page, 'narrow live cockpit Timeline')
    await timeline.focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Structure' })).toHaveAttribute('aria-selected', 'true')
    await axe(page, 'narrow live cockpit Structure')
    await page.keyboard.press('End')
    await expect(page.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
    await axe(page, 'narrow live cockpit Agents')

    const inboxOpener = page.getByRole('button', { name: 'Open inbox rail' })
    await inboxOpener.click()
    const inbox = page.getByRole('dialog', { name: 'inbox' })
    await expect(inbox).toBeVisible()
    await axe(page, 'narrow live cockpit inbox drawer open')
    await page.getByRole('button', { name: 'Close inbox rail' }).click()
    await expect(inbox).toBeHidden()
    await expect(inboxOpener).toBeFocused()

    await page.keyboard.press('l')
    await expect(page.getByRole('heading', { name: 'log lane' })).toBeFocused()
    await axe(page, 'narrow live cockpit log lane open')
    await page.getByRole('button', { name: 'Close log lane' }).click()
    await expect(page.getByRole('heading', { name: 'log lane' })).toBeHidden()

    const cancel = page.getByRole('button', { name: 'Cancel run' })
    await cancel.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: /Cancel run browser live/ })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Keep running' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Cancel run' })).toBeFocused()
    await axe(page, 'narrow live cancel confirmation')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(cancel).toBeFocused()
  })

  test('the 5,000-row transcript is virtualized and axe-clean', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openAuthenticated(page, TERMINAL_RUN, 0)
    await expect(page.getByRole('heading', { name: 'transcript' })).toBeVisible()
    await expect(page.locator('.virtual-row').first()).toBeVisible()
    const rendered = await page.locator('.virtual-row').count()
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(100)
    const dimensions = await page.locator('.virtual-spacer').evaluate((node) => ({
      spacer: (node as HTMLElement).getBoundingClientRect().height,
      viewport: (node.parentElement as HTMLElement).getBoundingClientRect().height,
    }))
    expect(dimensions.spacer).toBeGreaterThan(dimensions.viewport * 10)
    await axe(page, 'virtualized transcript')
  })

  /**
   * The 12-pixel standoff (operator-reported, twice — as "the pane bounces" and as "Jump
   * to latest shows when I'm at the bottom"; one defect wearing two symptoms). `.tp-body`
   * carried `padding-top: var(--s3)` that the virtualizer's coordinate system knew
   * nothing about, so every scroll target and measurement correction it computed sat
   * 12 px short of the browser's real maximum. A wheel at the bottom advanced into those
   * 12 px and was snapped back (the "bounce"), the resting gap never went below 12, and
   * the ≤4 px follow threshold could therefore never re-engage — so the jump affordance
   * showed at what was, visually, the bottom. Real wheel input, not scrollTop writes:
   * programmatic clamps settle clean and can never see this bug.
   */
  test('wheeling to the bottom actually rests at the bottom — follow re-arms and the jump affordance hides', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openAuthenticated(page, TERMINAL_RUN, 0)
    await expect(page.locator('.virtual-row').first()).toBeVisible()

    const pane = page.locator('.tp-body')
    await pane.evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 400 })
    const box = (await pane.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 120)
      await page.waitForTimeout(120)
    }

    const rest = await pane.evaluate((el) => ({
      gap: Math.round((el.scrollHeight - el.scrollTop - el.clientHeight) * 10) / 10,
      follow: el.closest<HTMLElement>('[data-follow]')?.dataset.follow ?? null,
    }))
    expect(rest.gap, 'a wheel that reaches the bottom must be allowed to rest there').toBeLessThanOrEqual(1)
    expect(rest.follow, 'flush at the bottom, follow re-arms').toBe('tail')
    await expect(page.locator('.jump-tail'), 'no jump affordance while at the bottom').toHaveCount(0)
  })

  // §2.6, and the finding that made it a blocker: the previous revision of this test
  // asserted the PLACEHOLDER's heading, which is how an unbuilt screen shipped with a
  // green suite. It now asserts the run's REAL result value, in every §2.6 shape.
  test('the result route renders the run’s real value, raw toggle and all, and is axe-clean', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openAuthenticated(page, TERMINAL_RUN)
    await expect(page.getByRole('heading', { name: 'browser terminal' })).toBeVisible()
    await page.getByRole('button', { name: 'Result' }).click()
    await expect.poll(() => new URL(page.url()).hash).toContain(`/run/${TERMINAL_RUN}/result`)

    // The workflow returned the string `browser-complete`, so §2.6's string branch:
    // safe markdown, with a raw toggle beside it. No placeholder anywhere.
    await expect(page.getByRole('heading', { name: 'Result', exact: true })).toBeVisible()
    await expect(page.locator('.res-value')).toContainText('browser-complete')
    await expect(page.locator('.res-value .md p')).toHaveText('browser-complete')
    await expect(page.getByText('The result view lands in W12')).toHaveCount(0)

    const raw = page.getByRole('button', { name: 'Raw', exact: true })
    await raw.click()
    await expect(page.locator('.res-value pre')).toContainText('browser-complete')
    await axe(page, 'terminal run result route')
  })

  test('an object result renders as a §2.6 JSON tree with copy-subtree', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`http://127.0.0.1:${viewer.port}/#/run/${OBJECT_RUN}/result?t=${encodeURIComponent(viewer.token)}`)
    await expect(page.getByRole('heading', { name: 'Result', exact: true })).toBeVisible()

    const tree = page.locator('.res-value .jt')
    await expect(tree).toBeVisible()
    await expect(tree.getByText('shipped', { exact: true })).toBeVisible()
    // Children of a collapsed node are not in the tree at all.
    const shipped = page.locator('.jt-row', { hasText: 'files' }).first()
    await expect(page.getByText('viewer.spec.ts')).toBeVisible()
    await shipped.getByRole('button').first().click()
    await expect(page.getByText('viewer.spec.ts')).toHaveCount(0)

    await axe(page, 'object result JSON tree')
  })

  test('a failed run frames its error and offers Resume', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`http://127.0.0.1:${viewer.port}/#/run/${FAILED_RUN}/result?t=${encodeURIComponent(viewer.token)}&c=${encodeURIComponent(viewer.controlToken!)}`)
    await expect(page.getByRole('heading', { name: 'Result', exact: true })).toBeVisible()
    await expect(page.locator('.res-error')).toContainText('the browser fixture refused')
    await expect(page.locator('.res-frame')).toContainText('failed')
    const resume = page.getByRole('button', { name: 'Resume run' })
    await expect(resume).toBeEnabled()
    await axe(page, 'failed run result route')
  })

  test('a long future status stays inside the §3.3 result layout at 1280', async ({ page }) => {
    // §5.4.5 forwards `result.json`'s `status` verbatim, so its length is the FILE's choice —
    // an older engine's, a newer one's, or a fleet tool's. The header chip is
    // `white-space: nowrap` with no shrink and the framing prose has no break opportunity
    // inside one long token, so an unbounded word rewrites the header row and widens the
    // column. Intercepted rather than written to disk: this is a degradation case about a
    // file this engine does not produce, and the route is the whole surface under test.
    await page.setViewportSize({ width: 1280, height: 900 })
    const longStatus = `aborted-by-the-fleet-supervisor-${'x'.repeat(600)}`
    await page.route(`**/api/runs/${OBJECT_RUN}/result*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: OBJECT_RUN,
          status: longStatus,
          error: 'the supervisor stopped this run',
          result: 'partial output',
          resultBytes: 14,
        }),
      })
    })
    await page.goto(`http://127.0.0.1:${viewer.port}/#/run/${OBJECT_RUN}/result?t=${encodeURIComponent(viewer.token)}`)
    await expect(page.getByRole('heading', { name: 'Result', exact: true })).toBeVisible()

    const geometry = await page.evaluate(() => {
      const head = document.querySelector('.res-head')!.getBoundingClientRect()
      const screenBox = document.querySelector('.result-screen')!.getBoundingClientRect()
      const chipEl = document.querySelector('.res-head .chip') as HTMLElement
      const say = document.querySelector('.res-frame .res-say') as HTMLElement
      const rid = document.querySelector('.res-head .rid')!.getBoundingClientRect()
      return {
        chip: chipEl.getBoundingClientRect(),
        chipText: chipEl.textContent ?? '',
        head,
        screenBox,
        rid,
        sayScroll: say.scrollWidth,
        sayClient: say.clientWidth,
        docScroll: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }
    })
    // The chip is a swatch in the header, and it stays one.
    expect(geometry.chipText.length).toBeLessThanOrEqual(32)
    expect(geometry.chip.right).toBeLessThanOrEqual(geometry.head.right + 0.5)
    expect(geometry.chip.right).toBeLessThanOrEqual(geometry.screenBox.right + 0.5)
    // The run id it shares the row with is still on screen, not pushed off the edge.
    expect(geometry.rid.width).toBeGreaterThan(0)
    expect(geometry.rid.right).toBeLessThanOrEqual(geometry.head.right + 0.5)
    // The prose wraps inside its own column instead of widening it, and nothing widens the
    // page: no horizontal scrollbar at the panel's own width.
    expect(geometry.sayScroll).toBeLessThanOrEqual(geometry.sayClient + 1)
    expect(geometry.docScroll).toBeLessThanOrEqual(geometry.viewport + 1)
    // Neither success nor failure was claimed, and the untouched file is still one click away.
    await expect(page.locator('.res-frame.neutral')).toBeVisible()
    await expect(page.getByRole('button', { name: /Download raw/ })).toBeVisible()
    await axe(page, 'result route with a long unrecognized status at 1280')
  })

  // ---- §3.6 live region (the blocker: `grep aria-live` over viewer/src returned zero) ----

  test('a live streaming transcript carries a throttled aria-live=polite frontier', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openAuthenticated(page, LIVE_RUN, 0)
    await expect(page.getByRole('heading', { name: 'sleeper' })).toBeVisible()

    // The exact query the review panel ran against the shipped build, which returned 0.
    const regions = await page.evaluate(() =>
      [...document.querySelectorAll('[aria-live]')].map((n) => ({
        live: n.getAttribute('aria-live'),
        atomic: n.getAttribute('aria-atomic'),
        frontier: (n as HTMLElement).dataset.frontier ?? null,
        text: n.textContent,
      })))
    const frontier = regions.filter((r) => r.frontier != null)
    expect(frontier).toHaveLength(1)
    expect(frontier[0]!.live).toBe('polite')
    expect(frontier[0]!.atomic).toBe('true')
    expect(frontier[0]!.frontier).toBe('live')
    expect(frontier[0]!.text).toContain('sleeper:')

    // Throttled, not a mirror of the stream: the region must not change more than once per
    // 5 s while the agent streams. Sampled every 250 ms for 6 s.
    const samples: string[] = await page.evaluate(async () => {
      const node = document.querySelector('[data-frontier]')!
      const seen: string[] = []
      for (let i = 0; i < 24; i++) {
        const text = node.textContent ?? ''
        if (seen[seen.length - 1] !== text) seen.push(text)
        await new Promise((r) => setTimeout(r, 250))
      }
      return seen
    })
    expect(samples.length).toBeLessThanOrEqual(2)
    await axe(page, 'live transcript with frontier region')
  })

  // ---- §12.1 items 5 and 6: the two overflow defects, at the panel's own width ----

  test('the read-only lifecycle row stays inside the cockpit column at 1280 with both rails', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    // The read-only viewer, because the three lock chips are what widened the row.
    await page.goto(`http://127.0.0.1:${readOnly.port}/#/run/${LIVE_RUN}?t=${encodeURIComponent(readOnly.token)}`)
    await expect(page.getByRole('heading', { name: 'browser live' })).toBeVisible()
    // §7.2's proof that this IS the read-only presentation the finding is about.
    await expect(page.locator('.ro-chip')).toBeVisible()
    await expect(page.locator('.rhead-actions .lock-chip')).toHaveCount(3)
    // LIVE_RUN has an open ask(), so §3.7's inbox rail is open by default — the exact
    // geometry the panel measured (rail at x960–1280, cockpit column at x280–960).
    const rail = page.locator('.cockpit > .col.inbox')
    await expect(rail).toBeVisible()

    const geometry = await page.evaluate(() => {
      const column = document.querySelector('.cockpit > .col')!.getBoundingClientRect()
      const inbox = document.querySelector('.cockpit > .col.inbox')!.getBoundingClientRect()
      const buttons = [...document.querySelectorAll('.rhead-actions button')].map((b) => ({
        label: b.textContent?.trim() ?? '',
        right: b.getBoundingClientRect().right,
        left: b.getBoundingClientRect().left,
      }))
      const row = document.querySelector('.rhead-actions')!.getBoundingClientRect()
      const header = document.querySelector('.rhead-top')!.getBoundingClientRect()
      return { column, inbox, buttons, row, header }
    })

    expect(geometry.inbox.left).toBeGreaterThanOrEqual(geometry.column.right)
    // The row is inside its own header line, which is inside the cockpit column.
    expect(geometry.row.right).toBeLessThanOrEqual(geometry.header.right + 0.5)
    expect(geometry.row.left).toBeGreaterThanOrEqual(geometry.header.left - 0.5)
    // No control — least of all a destructive one — may be laid out over the inbox rail.
    for (const button of geometry.buttons) {
      expect(button.right, `${button.label} escapes the cockpit column`)
        .toBeLessThanOrEqual(geometry.column.right)
    }

    // And the hit test the panel ran: the topmost element over the rail is the rail.
    const del = page.locator('.rhead-actions button.danger')
    const box = (await del.boundingBox())!
    const hit = await page.evaluate(
      ([x, y]) => {
        const node = document.elementFromPoint(x as number, y as number)
        return { tag: node?.tagName ?? '', cls: node?.className ?? '', inRail: Boolean(node?.closest('.col.inbox')) }
      },
      [box.x + box.width / 2, box.y + box.height / 2],
    )
    expect(hit.tag).toBe('BUTTON')
    expect(hit.inRail).toBe(false)
    await axe(page, 'read-only cockpit header at 1280')
  })

  test('the error-code chip never paints over the wait column at 1280', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    // The layout is the subject, not the provenance of the code, so the exact `errorCode`
    // the panel forced out of a real uninstalled adapter (`spawn_failed`, §2.1 Q10's
    // flagship failure) is injected into the snapshot. The stream is aborted so nothing
    // folds over it — this test is about geometry at a fixed data shape.
    await page.route(`**/api/runs/${TERMINAL_RUN}`, async (route) => {
      const response = await route.fetch()
      const body = await response.json() as { agents?: Record<string, unknown>[] }
      for (const agent of body.agents ?? []) {
        agent.state = 'failed'
        agent.displayState = 'failed'
        agent.errorCode = 'spawn_failed'
        agent.error = 'CLI not installed — run flowition doctor'
      }
      await route.fulfill({ response, json: body })
    })
    await page.route(`**/api/runs/${TERMINAL_RUN}/stream*`, (route) => route.abort())

    await openAuthenticated(page, TERMINAL_RUN)
    await expect(page.getByRole('heading', { name: 'browser terminal' })).toBeVisible()

    // The narrowest the agents table ever legitimately gets at §3.3's desktop width: 1280px
    // with BOTH rails open. `TERMINAL_RUN` has no open question and no outbound mail, so
    // `inboxDefaultOpen` leaves the inbox as its 44px strip — 276px wider than the geometry
    // this test exists to pin. Expanding it is what puts the row under real pressure.
    await page.getByRole('button', { name: 'Expand inbox rail' }).click()
    await expect(page.locator('.cockpit')).toHaveAttribute('data-inbox', 'open')
    const inbox = page.locator('.col.inbox')
    await expect(inbox).toBeVisible()
    // §3.3's `--rail-inbox-w`: the open rail really is taking its 320px out of the row.
    expect((await inbox.boundingBox())!.width).toBeCloseTo(320, 0)

    await page.getByRole('tab', { name: /Agents/ }).click()
    await expect(page.locator('.at-row:not(.head) .badge.err')).toHaveText('spawn_failed')

    const cells = await page.evaluate(() => {
      const row = document.querySelector('.at-row:not(.head)')!
      const box = (sel: string) => {
        const node = row.querySelector(sel)
        return node ? node.getBoundingClientRect() : null
      }
      return {
        state: box('.c-state')!,
        badge: box('.c-state .badge.err')!,
        chip: box('.c-state .chip')!,
        wait: box('.c-wait')!,
      }
    })

    // The defect, stated as the assertion that would have failed: the badge measured
    // x699.45–793.30 while its own cell ended at x736 and `wait` began at x744.
    expect(cells.badge.right).toBeLessThanOrEqual(cells.state.right + 0.5)
    expect(cells.badge.right).toBeLessThanOrEqual(cells.wait.left)
    // The state chip is the cell's subject and is not the thing that yielded.
    expect(cells.chip.right).toBeLessThanOrEqual(cells.state.right + 0.5)

    // Nothing in the row is painted over the wait column's value.
    const overWait = await page.evaluate((waitBox) => {
      const node = document.elementFromPoint(waitBox.x + waitBox.width / 2, waitBox.y + waitBox.height / 2)
      return node?.className ?? ''
    }, cells.wait)
    expect(String(overWait)).not.toContain('badge')
    await axe(page, 'agents table with a spawn_failed code at 1280')
  })

  /**
   * §3 layout doctrine: the shell owns the viewport and the DOCUMENT never scrolls —
   * everything long scrolls inside its own well. The defect this states as an assertion:
   * every rail run row carries a `.vh` screen-reader span (`position: absolute`), and
   * `.rail-scroll` was an unpositioned scroll container — so the spans' containing block
   * was `.rail`, `overflow: auto` never clipped them, and 63 rows of invisible 1px boxes
   * below the fold stretched the document ~930px past the viewport. A wheel over any
   * non-scrolling region then scrolled the whole app off-screen into blank canvas.
   *
   * Checked on the two routes that carry the most chrome: Home, and cockpit + transcript
   * with the rail populated. Both axes — a horizontal leak is the same bug rotated.
   */
  test('the document itself never scrolls — populated Home and cockpit fit the viewport exactly', async ({ page }) => {
    const docFits = () => page.evaluate(() => {
      const se = document.scrollingElement!
      window.scrollBy(0, 400)
      const after = { x: se.scrollLeft, y: se.scrollTop }
      window.scrollTo(0, 0)
      return {
        scrollH: se.scrollHeight, innerH: window.innerHeight,
        scrollW: se.scrollWidth, innerW: window.innerWidth,
        movedTo: after,
      }
    })

    /**
     * The bounce half of the doctrine (operator-reported): macOS elastic overscroll
     * rubber-bands the pane a wheel gesture ends in. A NESTED well never shows it — its
     * overscroll chains to the parent well — so `overscroll-behavior` is required only
     * where a chain terminates: every OUTERMOST scroll container (per axis) must declare
     * `none`, and `contain` is banned everywhere — it terminates the chain like `none`
     * but still permits the local bounce, which is how the transcript pane bounced while
     * "containing" (the operator's report). Nested wells deliberately keep `auto`: a code
     * block or JSON tree that ends mid-wheel hands the remainder to its pane instead of
     * dead-stopping the read. Form controls are excluded — their UA scrollboxes are not
     * layout wells.
     */
    const bounceLeaks = () => page.evaluate(() => {
      const scrolls = (v: string) => v === 'auto' || v === 'scroll'
      const leaks: string[] = []
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        if (/^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName)) continue
        const cs = getComputedStyle(el)
        for (const axis of ['x', 'y'] as const) {
          if (!scrolls(axis === 'x' ? cs.overflowX : cs.overflowY)) continue
          let outermost = true
          for (let p = el.parentElement; p && outermost; p = p.parentElement) {
            const ps = getComputedStyle(p)
            if (scrolls(axis === 'x' ? ps.overflowX : ps.overflowY)) outermost = false
          }
          const behavior = axis === 'x' ? cs.overscrollBehaviorX : cs.overscrollBehaviorY
          if ((outermost && behavior !== 'none') || behavior === 'contain') {
            leaks.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} [${axis}] → ${behavior}`)
          }
        }
      }
      return leaks
    })

    await openAuthenticated(page)
    await expect(page.locator('.rt-scroll .rt-row').first()).toBeVisible()
    const home = await docFits()
    expect(home.scrollH, 'Home: document taller than the viewport').toBeLessThanOrEqual(home.innerH)
    expect(home.scrollW, 'Home: document wider than the viewport').toBeLessThanOrEqual(home.innerW)
    expect(home.movedTo, 'Home: window.scrollBy must be a no-op').toEqual({ x: 0, y: 0 })
    expect(await bounceLeaks(), 'Home: an outermost well without overscroll-behavior: none rubber-bands').toEqual([])

    await openAuthenticated(page, TERMINAL_RUN, 0)
    await expect(page.locator('.rail .rrow').first()).toBeVisible()
    await expect(page.locator('.step').first()).toBeVisible()
    const cockpit = await docFits()
    expect(cockpit.scrollH, 'cockpit+transcript: document taller than the viewport').toBeLessThanOrEqual(cockpit.innerH)
    expect(cockpit.scrollW, 'cockpit+transcript: document wider than the viewport').toBeLessThanOrEqual(cockpit.innerW)
    expect(cockpit.movedTo, 'cockpit+transcript: window.scrollBy must be a no-op').toEqual({ x: 0, y: 0 })
    expect(await bounceLeaks(), 'cockpit+transcript: an outermost well without overscroll-behavior: none rubber-bands').toEqual([])
  })

  /**
   * The FIT CONTRACT (cockpit.css `--meta-gutter`): fit zoom means the timeline needs NO
   * horizontal scrollbar. Any run with a real span has a lane whose bar ends at ~100% of
   * the track (the window is the min/max of agent stamps), and `.bar-meta` — the replay
   * badge and the duration — deliberately hangs PAST the bar it describes. Without reserved
   * room the meta poked beyond the track and `.tl-scrollx` grew a scrollbar at the default
   * zoom (operator-reported). The gutter is plot padding, so the meta lands inside the
   * scroller's content box, off its overflow. The fixed zooms scroll by design.
   *
   * TERMINAL_RUN cannot drive this: its instant mock run takes the zero-width-window guard
   * (gantt.ts) and paints a synthetic mid-track bar whose meta never nears the edge. The
   * fixture here SLEEPs, so its stamps open a real window and its own end IS the window's.
   */
  test('fit zoom leaves the timeline without a horizontal scrollbar, trailing metas included', async ({ page }) => {
    const fit = await runWorkflow({
      file: workflow('browser-fit', `
export const meta = { name: 'browser fit', description: 'fit-zoom gutter fixture' }
export default async function ({ agent }) {
  return agent('SLEEP 400\\nECHO fit-complete', { adapter: 'mock', label: 'span' })
}
`),
      runId: FIT_RUN,
      defaults: { adapter: 'mock', cwd: process.cwd() },
      quiet: true,
    })
    expect(fit.status).toBe('completed')

    await page.setViewportSize({ width: 1280, height: 900 })
    await openAuthenticated(page, FIT_RUN)
    await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.lane .bar-meta').first()).toBeVisible()
    const well = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.tl-scrollx')!
      const track = document.querySelector<HTMLElement>('.lane .lane-track')!
      const meta = document.querySelector<HTMLElement>('.lane .bar-meta')!
      return {
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        trackRight: track.getBoundingClientRect().right,
        metaRight: meta.getBoundingClientRect().right,
      }
    })
    // The precondition that lets this test fail: the meta really does hang past the track's
    // right edge. If a window-maths change stops producing that geometry, this fails loudly
    // instead of the scrollbar assertion going vacuous.
    expect(
      well.metaRight,
      'fixture must push its meta past the track edge — a mid-track meta asserts nothing',
    ).toBeGreaterThan(well.trackRight)
    expect(
      well.scrollW,
      'fit: .tl-scrollx must not scroll horizontally — the trailing meta must land in the gutter',
    ).toBeLessThanOrEqual(well.clientW)
  })

  // ---- the toast defect: a notice must expire, and must never eat a control ----

  test('a visible toast leaves every bottom control — Jump to latest and Send — clickable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    // A real lifecycle outcome produces a real toast — the same `role=status` card that
    // covered Send for the review panel. Deleting the failed fixture is the cheapest one
    // that spawns no process.
    await openAuthenticated(page, FAILED_RUN)
    await expect(page.getByRole('heading', { name: 'browser failed' })).toBeVisible()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: /Delete browser failed/ })
    await dialog.getByRole('textbox').fill(FAILED_RUN)
    await dialog.getByRole('button', { name: 'Delete run' }).click()
    const toast = page.locator('.ctl-toast')
    await expect(toast).toBeVisible()

    // Client-side route change: the toast outlives it, exactly as it did for the panel.
    await page.evaluate((runId) => { location.hash = `#/run/${runId}/agent/0` }, LIVE_RUN)
    await expect(page.getByRole('heading', { name: 'sleeper' })).toBeVisible()
    const pane = page.getByLabel('Transcript for sleeper')
    const send = pane.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeVisible()
    await expect(toast).toBeVisible()

    // Pause follow mode, which is what puts the SECOND bottom-right control on screen.
    // `.jump-tail` is `position: absolute; right: 18px; bottom: 12px` inside the virtual
    // frame — directly above the composer, on the same edge — so a toast lifted by only the
    // composer's height still lands on it, and `.ctl-toast` restores `pointer-events: auto`,
    // so it takes the click. Reserving one control and not its neighbour is the same defect
    // with a different button in it.
    await pane.locator('.tp-body').hover()
    await page.mouse.wheel(0, -600)
    const jump = pane.getByRole('button', { name: 'Jump to latest', exact: true })
    await expect(jump).toBeVisible()

    // Geometry: the toast layer is LIFTED above the WHOLE lower zone, not merely
    // click-through, and each control answers a hit test at its own centre.
    const layout = await page.evaluate(() => {
      const t = document.querySelector('.ctl-toast')!.getBoundingClientRect()
      const foot = document.querySelector('.tp-foot')!.getBoundingClientRect()
      const jumpBtn = document.querySelector('.jump-tail')!.getBoundingClientRect()
      const btn = [...document.querySelectorAll('.tp-foot button')]
        .find((b) => b.textContent?.trim() === 'Send')!.getBoundingClientRect()
      const at = (r: DOMRect) => document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return {
        toastBottom: t.bottom,
        toastRight: t.right,
        footTop: foot.top,
        jumpTop: jumpBtn.top,
        jumpRight: jumpBtn.right,
        overSend: at(btn)?.textContent?.trim() ?? '',
        overJump: at(jumpBtn)?.textContent?.trim() ?? '',
        overToast: at(t)?.className ?? '',
        floor: getComputedStyle(document.documentElement).getPropertyValue('--action-floor').trim(),
      }
    })
    // The two controls really do share the right edge — this is the overlap the panel found,
    // not a hypothetical one — and the toast now clears the higher of them.
    expect(Math.abs(layout.toastRight - layout.jumpRight)).toBeLessThan(24)
    expect(layout.jumpTop).toBeLessThan(layout.footTop)
    expect(layout.toastBottom).toBeLessThanOrEqual(layout.jumpTop)
    expect(layout.toastBottom).toBeLessThanOrEqual(layout.footTop)
    expect(layout.overSend).toBe('Send')
    expect(layout.overJump).toBe('Jump to latest')
    expect(layout.floor).not.toBe('')

    // And the clicks actually land on the controls, not on the notice. Playwright's own
    // actionability check would fail here if anything covered either one.
    const distanceFromTail = () => pane.locator('.tp-body')
      .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    expect(await distanceFromTail()).toBeGreaterThan(100)
    await jump.click()
    // The click was RECEIVED by the control, not swallowed by the notice: the pane jumped to
    // its tail. (Asserted on the scroll rather than on the button disappearing — on a 73,000px
    // transcript the virtualizer settles a few pixels short of the very bottom and keeps
    // offering the control, which is its own behaviour and not what this test is about.)
    await expect.poll(distanceFromTail).toBeLessThan(24)
    await expect(toast).toBeVisible()
    await pane.getByRole('textbox', { name: /Steer/ }).fill('panel B steering probe')
    await send.click()
    await expect(page.locator('.tp-foot')).toContainText(/delivered|queued|live/i)

    // The toast is itself still operable where it sits.
    await expect(toast.getByRole('button', { name: 'Dismiss' })).toBeVisible()

    // §3.6 + W15: it goes away on its own. `TOAST_MAX_MS` is 14 s; give it a little slack.
    await expect(toast).toBeHidden({ timeout: 20_000 })
  })

  test('delete confirmation is driven to its destructive action by real Tab', async ({ page }) => {
    await openAuthenticated(page, TERMINAL_RUN)
    await expect(page.getByRole('heading', { name: 'browser terminal' })).toBeVisible()
    const remove = page.getByRole('button', { name: 'Delete', exact: true })
    await remove.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: /Delete browser terminal/ })
    const input = dialog.getByRole('textbox', { name: /Type flo_browser_terminal/ })
    await expect(input).toBeFocused()
    await page.keyboard.type(TERMINAL_RUN)
    await axe(page, 'delete confirmation')
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Keep it' })).toBeFocused()
    await page.keyboard.press('Tab')
    const confirm = dialog.getByRole('button', { name: 'Delete run' })
    await expect(confirm).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeFocused()
    await expect(page.getByRole('status')).toContainText('moved to flowition')
    await axe(page, 'Home after delete')
  })
})

/**
 * §7.1.4 on iOS — the platform the Desktop Chrome project structurally cannot reach.
 *
 * react-aria has TWO runtime style injections, not one. `usePress` fires everywhere and is
 * prevented by the id claim in `ui/pressableStyle.ts`. `usePreventScroll` — which every
 * `ControlDialog` invokes — fires only when
 * `navigator.userAgentData?.platform || navigator.platform` starts with `iPhone`/`iPad`
 * (`react-aria/dist/private/utils/platform.mjs`), so on Desktop Chrome that code path never
 * runs and the suite-wide `securitypolicyviolation` gate above never had anything to catch.
 * That is exactly how the second site survived panel round 2 with zero violations reported.
 *
 * Playwright's device descriptors set the viewport, UA and touch flags but not
 * `navigator.platform`, so the platform is overridden in an init script — the one signal
 * react-aria actually reads. Chromium is deliberate: this gate has to run wherever the rest
 * of the browser job runs, and it is testing OUR policy against react-aria's DOM write,
 * neither of which is WebKit-specific.
 */
test.describe('iOS modal under the §7.1.4 policy', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      + ' (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // BOTH, in this order, or the override is a no-op: react-aria reads
      // `navigator.userAgentData?.platform || navigator.platform`, and Chromium always
      // populates `userAgentData.platform` ("macOS" here), so setting `platform` alone
      // never reaches the `||`. Safari on a real iPhone exposes no `userAgentData` at
      // all, so removing it is also the faithful emulation.
      Object.defineProperty(navigator, 'userAgentData', { value: undefined, configurable: true })
      Object.defineProperty(navigator, 'platform', { value: 'iPhone', configurable: true })
    })
  })

  test('the command palette contains scroll without violating the policy', async ({ page }) => {
    await openAuthenticated(page)
    await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()

    // Nothing injected, nothing contained, before a modal exists.
    expect(await page.evaluate(() => document.head.querySelectorAll('style').length)).toBe(0)
    const containment = () => page.evaluate(() =>
      getComputedStyle(document.body).overscrollBehaviorY)
    expect(await containment()).toBe('auto')

    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    await expect(palette).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Search runs, agents and actions' }))
      .toBeFocused()

    // First: the injection ran at all. If this is `[]` the platform override stopped
    // reaching react-aria and the rest of the test would be vacuously "green" — which is
    // the exact shape of the round-2 miss this describe exists to prevent. The text is the
    // byte string the CSP hash covers, kept in sync by `ui/preventScrollStyle.test.ts`.
    const injected = await page.evaluate(() =>
      [...document.head.querySelectorAll('style')].map((node) => node.textContent))
    expect(injected, 'the iOS injection path did not run — this test proves nothing')
      .toEqual(['@layer {\n  * {\n    overscroll-behavior: contain;\n  }\n}'])

    // Then: the rule reached the CSSOM. A BLOCKED <style> element still sits in the DOM
    // with its text intact, so the assertion above passes under the very failure this test
    // exists for — only the COMPUTED value tells "allowed" from "blocked". `auto` is the
    // initial value, and the assertion above shows nothing else supplies `contain` here.
    expect(await containment(),
      'usePreventScroll’s rule must APPLY, not merely be present and blocked').toBe('contain')
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('hidden')

    // Modal-only, which is the property that kept this rule out of `ui/base.css`.
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    expect(await containment(), 'containment must not outlive the modal').toBe('auto')
    expect(await page.evaluate(() => document.head.querySelectorAll('style').length)).toBe(0)

    // The other site stays prevented on this platform too.
    expect(await page.evaluate(() =>
      document.getElementById('react-aria-pressable-style')?.tagName)).toBe('META')
  })

  // The suite-wide afterEach is the real assertion of this describe: zero
  // securitypolicyviolation and zero pageerror events, now on the platform that injects.
})
