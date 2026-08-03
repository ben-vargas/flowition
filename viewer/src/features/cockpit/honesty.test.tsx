// @vitest-environment jsdom
//
// THE CLASS TEST (review round 6).
//
// Five rounds of review each found a different widget claiming something the run could not
// support — a spinning phase rollup, a container header still turning, a lineage bar growing
// toward `now`, a "live from usage-cum" dot beside an orphaned agent, an elapsed clock
// counting the operator's own browsing session — and each round fixed the widget. They are
// not five defects. They are ONE rule broken in five places:
//
//   **the UI must never claim liveness, motion, or knowledge that the authoritative run
//   state does not support.**
//
// `honesty.ts` is the structural fix: one derivation, consumed by every widget. This file is
// the rule's test, and it is deliberately NOT written per-widget. It walks EVERY TAB of
// EVERY FIXTURE — live, stale, quiescent, and an old run from before E1 — and asserts the
// invariant over the whole rendered document. A sixth site cannot be added to the cockpit
// without either passing this or failing it; it cannot be added and go unnoticed.
//
// The three assertions the round-6 blockers name are folded in as the named cases at the
// foot: B1 (live tokens on a quiescent run), B2 (absent announced / known zero hidden),
// B3 (a fabricated runtime).

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Cockpit, DeadRunCard } from './Cockpit.js'
import { IconSprite } from '../../ui/Icon.js'
import { RunHonestyContext, agentDuration, deriveHonesty, durationValue, runClock } from './honesty.js'
import { RunHeader } from './RunHeader.js'
import { structureModel } from './dag.js'
import { sortAgents } from './agents.js'
import {
  CORRUPT_RUN, DEAD_STRUCTURED_RUN, LEGACY_RUN, LIVE_QUEUE_RUN, LIVE_RUN, NOW,
  ORPHAN_QUEUE_RUN, QUEUE_AT, QUEUE_CHART_END, RESUMED_RUNNING, RETAINED_DURATION_RUN,
  RETAINED_MS, STALE_RUN, T0, fixedApi,
} from './fixtures.js'
import type { RunDetail } from '../../api/types.js'
import { fmtDuration } from '../../format/fmt.js'
import { resetRouteForTests } from '../../app/router.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.location.hash = '#/'
  resetRouteForTests()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const mount = async (detail: RunDetail) => {
  render(
    <>
      <IconSprite />
      <Cockpit runId={detail.runId} storeApi={fixedApi(detail)} />
    </>,
  )
  await screen.findByRole('tablist')
}

const TABS = ['Timeline', 'Structure', 'Agents'] as const

/** Every tab, and inside Agents both groupings — the phase tree is a tab of its own. */
const walkEveryView = (visit: (where: string) => void) => {
  for (const tab of TABS) {
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(tab) }))
    visit(tab)
    if (tab === 'Agents') {
      fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
      visit('Agents/phases')
      fireEvent.click(screen.getByRole('button', { name: /Flat/ }))
    }
  }
  // The log lane is a fourth surface, and the inbox rail a fifth.
  fireEvent.keyDown(window, { key: 'l' })
  visit('log lane')
  fireEvent.keyDown(window, { key: 'l' })
}

/**
 * The four runs the rule has to hold over, and what each one is FOR.
 *
 * `live` is the control: every assertion below is "unless the run is genuinely live", and a
 * suite with no live case would pass by rendering a dead screen for everything.
 */
const FIXTURES: { name: string; detail: RunDetail; live: boolean }[] = [
  // The control. Four agents in flight, an open question, an unbounded lineage.
  { name: 'LIVE_RUN', detail: LIVE_RUN, live: true },
  // The engine went away without writing a terminal event: no `endedAt`, ever.
  { name: 'STALE_RUN', detail: STALE_RUN, live: false },
  // §5.4.2's quiescent tier. Its agents arrive WITHOUT `displayState: 'orphaned'`, so
  // nothing here can pass on a value the server handed down — the client's own rule is the
  // only thing that can stop them.
  { name: 'CORRUPT_RUN', detail: CORRUPT_RUN, live: false },
  // Terminal with work still in flight, and the server's post-pass applied.
  { name: 'DEAD_STRUCTURED_RUN', detail: DEAD_STRUCTURED_RUN, live: false },
  // §6.5: recorded before E1–E12. Every cap unsupported, no structure, no phases.
  { name: 'LEGACY_RUN (pre-E1)', detail: LEGACY_RUN, live: false },
]

describe('the honesty invariant, over every tab of every run', () => {
  for (const { name, detail, live } of FIXTURES) {
    describe(name, () => {
      it(live ? 'may claim motion — it is alive' : 'claims no motion anywhere', async () => {
        await mount(detail)
        walkEveryView((where) => {
          const spinners = document.querySelectorAll('.ic-spin').length
          const dots = document.querySelectorAll('.live-dot').length
          const labels = [...document.querySelectorAll('[aria-label]')]
            .filter((el) => el.getAttribute('aria-label')!.includes('(live)')).length
          const nowLine = document.querySelectorAll('.now-line').length
          const quiet = document.querySelectorAll('.quiet-tag').length
          if (live) {
            // The control has to actually exercise the machinery, or "no spinner on a dead
            // run" is satisfied by a component that never spins at all.
            expect({ where, spins: spinners > 0 }).toEqual({ where, spins: true })
          } else {
            expect({ where, spinners }).toEqual({ where, spinners: 0 })
            expect({ where, dots }).toEqual({ where, dots: 0 })
            expect({ where, labels }).toEqual({ where, labels: 0 })
            expect({ where, nowLine }).toEqual({ where, nowLine: 0 })
            // A "quiet for 6m" tag says something is expected to speak again.
            expect({ where, quiet }).toEqual({ where, quiet: 0 })
          }
        })
      })

      it('shows no duration the run did not record, and no blank panel', async () => {
        await mount(detail)
        const metrics = () => document.querySelector('.rhead-metrics')!.textContent ?? ''
        const clock = runClock({
          startedAt: detail.startedAt, endedAt: detail.endedAt, live,
          quiescent: false, now: NOW,
        })
        if (clock.kind === 'unrecorded') {
          // The whole of B3: no elapsed figure, and specifically not the one `now -
          // startedAt` would have produced.
          expect(metrics()).not.toContain('elapsed')
          expect(metrics()).toContain('not recorded')
          expect(metrics()).not.toContain(fmtDuration(NOW - detail.startedAt!))
        } else if (clock.kind !== 'unstarted') {
          expect(metrics()).toContain('elapsed')
          expect(metrics()).toContain(fmtDuration(clock.ms))
        }
        // §6.5 / parity #60–#62: every tab renders SOMETHING, with a reason where a
        // capability is missing. A blank panel is its own kind of dishonesty.
        walkEveryView((where) => {
          const panel = document.querySelector('.tl, .dag, .at, .lane-drawer')
          expect({ where, empty: (panel?.textContent ?? '').trim().length < 8 })
            .toEqual({ where, empty: false })
        })
      })

      it('omits what the run never recorded and reports the counts it has', async () => {
        await mount(detail)
        fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
        for (const row of document.querySelectorAll<HTMLElement>('.at-row:not(.head)')) {
          const label = row.getAttribute('aria-label') ?? ''
          // Nothing is EVER announced as missing (round 6, B2): an absent field is silent
          // in the reading exactly as it is blank in the cell.
          expect({ label, announced: label.includes('not reported') })
            .toEqual({ label, announced: false })
          // A cell with no value carries no character an operator can read as a number.
          for (const cell of row.querySelectorAll('.absent')) {
            expect(cell.textContent!.trim()).toBe('')
          }
          // …and the two counts the client always has are always in the reading, zero
          // included, and always in the cells.
          expect(label).toMatch(/\d+ (attempt|attempts)/)
          expect(label).toMatch(/\d+ (steer|steers)/)
          expect(row.querySelector('.c-steers')!.textContent).toMatch(/^\d+$/)
        }
      })
    })
  }
})

/**
 * The three sites the reviewer named, each as its own assertion so a regression points at
 * the defect rather than at "the invariant".
 */
describe('the three named sites', () => {
  it('B1 — a quiescent run marks no token figure live, on any surface', async () => {
    await mount(CORRUPT_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    // The agent that carries a `usage-cum` stream AND is still `running` in the journal.
    const row = [...document.querySelectorAll<HTMLElement>('.at-row:not(.head)')]
      .find((r) => r.textContent?.includes('review:tests'))!
    expect(row.querySelector('.c-output')!.textContent).toContain('119k')  // the figure stays
    expect(row.querySelector('.live-dot')).toBeNull()                      // the claim goes
    expect(row.getAttribute('aria-label')).not.toContain('(live)')
    expect(row.getAttribute('aria-label')).toContain('state orphaned (running)')

    // The control, same agent, same records, on the live run: the dot IS there. Without
    // this the assertion above passes against a table that never marks anything live.
    cleanup()
    await mount(LIVE_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const alive = [...document.querySelectorAll<HTMLElement>('.at-row:not(.head)')]
      .find((r) => r.textContent?.includes('review:tests'))!
    expect(alive.querySelector('.live-dot')).not.toBeNull()
    expect(alive.getAttribute('aria-label')).toContain('(live)')
  })

  it('B2 — absent fields are omitted, known zeros are announced', async () => {
    await mount(LIVE_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const row = [...document.querySelectorAll<HTMLElement>('.at-row:not(.head)')]
      .find((r) => r.textContent?.includes('verify:auth'))!
    const label = row.getAttribute('aria-label')!
    expect(label).not.toMatch(/\b(output|input|cost|last tool|duration|wait)\b/)
    expect(label).toContain('0 attempts')
    expect(row.querySelector('.c-attempts')!.textContent).toBe('0')
  })

  it('B3 — a run with no recorded end reports its start, not a runtime', async () => {
    await mount(CORRUPT_RUN)
    const metrics = document.querySelector('.rhead-metrics')!.textContent ?? ''
    expect(metrics).toContain('not recorded')
    expect(metrics).toMatch(/started .*(ago|just now)/)
    expect(metrics).not.toContain(fmtDuration(NOW - CORRUPT_RUN.startedAt!))
  })
})

/**
 * Round 7's two, which are the same rule at the two remaining sites: a Gantt bar's extent is
 * not a duration, and a grid cell's "still running" is not a fact about a dead run.
 */
describe('round 7 — the extent that is not a duration, and the tense that is not the present', () => {
  const laneMeta = (label: string): HTMLElement => {
    const lane = [...document.querySelectorAll<HTMLElement>('.lane')]
      .find((l) => l.textContent?.includes(label))!
    return lane.querySelector<HTMLElement>('.bar-meta')!
  }

  it('B1 — an orphaned lane prints no runtime, on stale and on corrupt-result alike', async () => {
    for (const detail of [STALE_RUN, CORRUPT_RUN]) {
      cleanup()
      await mount(detail)
      const orphanLabel = detail === STALE_RUN ? 'audit:tokens' : 'review:tests'
      const meta = laneMeta(orphanLabel)
      // Nothing in the strip reads as a duration — no `0ms`, no `2m04s`, nothing.
      const text = meta.textContent ?? ''
      expect({ run: detail.runId, duration: /\d+(ms|s\b|m\b|h\b)/.test(text) })
        .toEqual({ run: detail.runId, duration: false })
      expect(text).not.toContain('0ms')
      // …and the badge that replaces it says WHY there is no figure.
      expect(meta.textContent).toContain('end unrecorded')
      expect(meta.querySelector('.badge')!.getAttribute('title'))
        .toContain('no terminal event was ever written')
    }
  })

  it('B1 control — a settled lane on the SAME dead run still prints its real duration', async () => {
    await mount(STALE_RUN)
    // `survey:routes` ended: 198s is a recorded fact and survives the run's death.
    expect(laneMeta('survey:routes').textContent).toContain(fmtDuration(198_000))
  })

  it('B2 — the Structure grid says "still running" only where something is', async () => {
    await mount(LIVE_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    // The control: the live run DOES say it, so the assertion below is not vacuous.
    expect(document.querySelector('.dag')!.textContent)
      .toContain('not created — stage 0 still running')

    for (const detail of [STALE_RUN, CORRUPT_RUN, DEAD_STRUCTURED_RUN]) {
      cleanup()
      await mount(detail)
      fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
      const dag = document.querySelector('.dag')!.textContent ?? ''
      expect({ run: detail.runId, claims: dag.includes('still running') })
        .toEqual({ run: detail.runId, claims: false })
    }
  })

  it('B2 — and re-words those exact cells rather than falling back to a bare dash', async () => {
    // `CORRUPT_RUN` carries LIVE_RUN's containers verbatim, so these are the SAME two cells
    // the reviewer read as "stage 0 still running" on a quiescent run.
    await mount(CORRUPT_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    const cells = [...document.querySelectorAll('.achip.empty')].map((c) => c.textContent!.trim())
    expect(cells).toContain('not created — stage 0 was orphaned')
    // The settled reasons are untouched — `failed` reads the same whoever is asking.
    expect(cells).toContain('skipped — stage 0 failed')
    // And every reason is still specific, never the dash `dag.ts` exists to avoid.
    for (const text of cells) expect(text.length).toBeGreaterThan(3)
  })
})

/**
 * ROUND 12 — the same refusal for the QUEUE wait, read off the rendered lane.
 *
 * `gantt.test.ts` proves the model draws no interval. This proves the SCREEN does not either,
 * and that what stands in its place is a sentence rather than a blank lane — the two halves
 * the stale card's honesty rules require of any absence (§2.4, parity #53).
 */
describe('round 12 — an orphaned queue entry has a mark, a sentence, and no interval', () => {
  const laneFor = (label: string): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>('.lane')].find((l) => l.textContent?.includes(label))!

  it('B1 — the dead queue entry is a marker at queuedAt with unrecorded-end copy', async () => {
    await mount(ORPHAN_QUEUE_RUN)
    const lane = laneFor('verify:docs')
    const bar = lane.querySelector<HTMLElement>('.bar')!
    // ONE mark, at the queued event, with no width of its own to be read as a duration.
    expect(lane.querySelectorAll('.bar')).toHaveLength(1)
    expect(bar.classList.contains('qorphan')).toBe(true)
    expect(bar.style.width).toBe('')
    expect(parseFloat(bar.style.left)).toBeCloseTo(((QUEUE_AT - T0) / (QUEUE_CHART_END - T0)) * 100, 4)
    // The lane is not blank — the mark carries the sentence, and so does the badge.
    for (const title of [bar.getAttribute('title'), lane.querySelector('.badge')!.getAttribute('title')]) {
      expect(title).toContain('nothing on disk records when')
      expect(title).toContain('draws no interval past it')
    }
    const meta = lane.querySelector<HTMLElement>('.bar-meta')!.textContent ?? ''
    expect(meta).toContain('orphaned — queue end unrecorded')
    // And nothing in the strip reads as a length — no `13m50s`, no `0ms` (parity #53).
    expect(/\d+(ms|s\b|m\b|h\b)/.test(meta)).toBe(false)
  })

  it('B1 control — the SAME queue entry on a live run draws a real, open hatch', async () => {
    await mount(LIVE_QUEUE_RUN)
    const lane = laneFor('verify:docs')
    const bar = lane.querySelector<HTMLElement>('.bar')!
    expect(bar.classList.contains('qorphan')).toBe(false)
    // Open at the right (`.bar.open`'s dashed edge) and genuinely wide: it runs to `now`.
    expect(bar.classList.contains('open')).toBe(true)
    expect(bar.querySelector('.wait')).not.toBeNull()
    expect(parseFloat(bar.style.width)).toBeGreaterThan(90)
    expect(lane.textContent).not.toContain('unrecorded')
  })

  it('B1 control — the settled lane on the dead run keeps its real wait and duration', async () => {
    await mount(ORPHAN_QUEUE_RUN)
    const lane = laneFor('build')
    expect(lane.querySelector('.bar')!.classList.contains('qorphan')).toBe(false)
    expect(lane.querySelector('.bar-meta')!.textContent).toContain(fmtDuration(840_000))
  })
})

/**
 * ROUND 8 — the class, read ACROSS tabs rather than inside one.
 *
 * Round 7 fixed the Gantt and the Structure grid and the suite proved both. It could not
 * prove the thing that was still broken, because every assertion in it looked at one surface
 * at a time: `review:tests` read "end unrecorded" beside its bar and "1m1s" in the Agents
 * table's `dur` column and in its Structure chip and in the container roll-up above it, and
 * four single-surface tests all passed.
 *
 * So the invariant is stated between surfaces: **for one agent on one fixture, the state and
 * the runtime the cockpit shows are the same string in every tab.** Anything that derives
 * either for itself fails this by construction, whichever surface it lives on.
 */
describe('cross-tab agreement — one agent, one state, one runtime', () => {
  /** Everything a row/lane/chip SAYS about an agent, keyed by the label it shows. */
  const readShown = (
    row: string, label: string,
  ): Map<string, { state: string; duration: string }> => {
    const out = new Map<string, { state: string; duration: string }>()
    for (const el of document.querySelectorAll<HTMLElement>(row)) {
      const name = el.querySelector(label)?.textContent?.trim()
      if (!name) continue
      out.set(name, {
        // `StatusGlyph`'s own hidden text — the state as it is READ OUT, which is the same
        // string on all three surfaces because all three mount the same component.
        state: el.querySelector('.g .vh')?.textContent?.trim() ?? '',
        // `Duration.tsx`'s `.dur`; the empty string means "this surface shows no runtime".
        duration: el.querySelector('.dur')?.textContent?.trim() ?? '',
      })
    }
    return out
  }

  /** #50 auto-collapses finished phases; the tree can only be compared once it is open. */
  const openEveryPhase = () => {
    for (let guard = 0; guard < 10; guard++) {
      const shut = [...document.querySelectorAll<HTMLElement>('.phead')]
        .find((h) => h.getAttribute('aria-expanded') === 'false')
      if (!shut) return
      fireEvent.click(shut)
    }
  }

  const tabsOf = async (detail: RunDetail) => {
    await mount(detail)
    fireEvent.click(screen.getByRole('tab', { name: /Timeline/ }))
    const timeline = readShown('.lane', '.nm')
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    const structure = readShown('.achip:not(.empty)', '.nm')
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const agents = readShown('.at-row:not(.head)', '.c-label .nm')
    fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
    openEveryPhase()
    const tree = readShown('.at-row:not(.head)', '.c-label .nm')
    return { timeline, structure, agents, tree }
  }

  const RUNS: { name: string; detail: RunDetail }[] = [
    { name: 'LIVE_RUN', detail: LIVE_RUN },
    { name: 'STALE_RUN', detail: STALE_RUN },
    { name: 'CORRUPT_RUN', detail: CORRUPT_RUN },
    { name: 'DEAD_STRUCTURED_RUN', detail: DEAD_STRUCTURED_RUN },
    { name: 'LEGACY_RUN (pre-E1)', detail: LEGACY_RUN },
    // The two the class is actually about: a resumed agent running RIGHT NOW, and the same
    // agent after the engine went away — both carrying a settled attempt's `durationMs`.
    { name: 'RESUMED_RUNNING', detail: RESUMED_RUNNING },
    { name: 'RETAINED_DURATION_RUN', detail: RETAINED_DURATION_RUN },
  ]

  for (const { name, detail } of RUNS) {
    it(`${name} — every tab agrees, agent by agent`, async () => {
      const { timeline, structure, agents, tree } = await tabsOf(detail)
      // The fixture has to actually put agents on screen, or "they all agree" is vacuous.
      expect(timeline.size).toBe(detail.agents.length)
      for (const [label, shown] of timeline) {
        for (const [where, map] of [
          ['structure', structure], ['agents', agents], ['agents/phases', tree],
        ] as const) {
          expect({ label, where, ...(map.get(label) ?? { missing: true }) })
            .toEqual({ label, where, ...shown })
        }
      }
    })
  }

  /**
   * Round 8's B1, at the site the reviewer named and on the surfaces that were still
   * printing it. The agreement test above would catch a regression; this one says what the
   * agreed answer has to BE, so a build that agreed on `1m1s` everywhere still fails.
   */
  it('B1 — a prior attempt\'s runtime is printed by nobody, and summed by nobody', async () => {
    const { timeline, structure, agents, tree } = await tabsOf(RETAINED_DURATION_RUN)
    for (const [where, map] of [
      ['timeline', timeline], ['structure', structure], ['agents', agents], ['tree', tree],
    ] as const) {
      const shown = map.get('review:tests')!
      expect({ where, ...shown }).toEqual({ where, state: 'orphaned (running)', duration: '' })
    }
    // The cell is BLANK, not `0` and not a dash — and it says which gap it is (#53).
    fireEvent.click(screen.getByRole('button', { name: /Flat/ }))
    const row = [...document.querySelectorAll<HTMLElement>('.at-row:not(.head)')]
      .find((r) => r.textContent?.includes('review:tests'))!
    const cell = row.querySelector('.c-duration')!
    expect(cell.textContent!.trim()).toBe('')
    expect(cell.querySelector('.absent')!.getAttribute('title'))
      .toContain('belongs to an earlier attempt')
    // …and the reading of the row omits it rather than announcing it (round 6, B2).
    expect(row.getAttribute('aria-label')).not.toContain('duration')

    // THE ROLL-UP. `1m1s` must not reappear one level up as part of a container total: the
    // header is the sum of the chips beneath it, and those chips show nothing.
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    const honesty = deriveHonesty(RETAINED_DURATION_RUN, { now: NOW })
    const model = structureModel(
      RETAINED_DURATION_RUN.structure, RETAINED_DURATION_RUN.agents, honesty,
    )
    for (const container of model.containers) {
      const expected = container.agents
        .map((a) => durationValue(honesty.duration(a)))
        .filter((ms): ms is number => ms != null)
      expect({ path: container.label, sum: container.durationMs })
        .toEqual({ path: container.label, sum: expected.length ? expected.reduce((x, y) => x + y, 0) : null })
      // The retained figure is in none of the terms, so it cannot be in the total.
      expect(container.agents.some((a) => durationValue(honesty.duration(a)) === RETAINED_MS))
        .toBe(false)
    }
    // And the header the operator reads does not contain it either.
    expect(document.querySelector('.dag')!.textContent).not.toContain(fmtDuration(RETAINED_MS))
  })

  /**
   * Round 8's B2. The state column renders `orphaned` through the verdict but SORTED by the
   * raw `displayState ?? state`, so on a snapshot whose post-pass is absent — every
   * quiescent run, and every run from a server that predates step 8 — the rows came back in
   * an order no cell on screen explained, and `j`/`k` walked it.
   */
  describe('B2 — the state column sorts by the state the row renders', () => {
    const shownStates = () => [...document.querySelectorAll<HTMLElement>('.at-row:not(.head)')]
      .map((r) => r.querySelector('.g .vh')!.textContent!.trim())

    const sortByState = async (detail: RunDetail) => {
      await mount(detail)
      fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
      fireEvent.click(screen.getByRole('button', { name: /^state \/ error/ }))
    }

    it('groups a quiescent run\'s orphans together, not under running and queued', async () => {
      await sortByState(CORRUPT_RUN)
      // The glyph names the record it was applied to — "orphaned (running)" — so the SORT
      // KEY is the part before the parenthesis, and inside one key the tie breaks on index.
      const states = shownStates().map((s) => s.replace(/ \(.*\)$/, ''))
      // Ascending: `cached` < `done` < `failed` < `orphaned`. The raw ordering would have
      // been … `queued`, `queued`, `running`, `running` — four rows in two groups, in the
      // wrong place, under four cells that all say `orphaned`.
      expect(states).toEqual([...states].sort())
      expect(states.filter((s) => s === 'orphaned')).toHaveLength(4)
      // The orphans are contiguous and last, and the two the RAW sort would have separated
      // (`queued` before `running`) are now adjacent.
      const labels = [...document.querySelectorAll<HTMLElement>('.at-row:not(.head)')]
        .map((r) => r.querySelector('.c-label .nm')!.textContent)
      expect(labels.slice(-4)).toEqual(['review:tests', 'review:docs', 'verify:auth', 'verify:client'])
      // …and that is NOT what the raw `displayState ?? state` produces: it sorts `queued`
      // before `running`, so the shipped build painted these four in the other order.
      const raw = [...CORRUPT_RUN.agents]
        .filter((a) => a.state === 'queued' || a.state === 'running')
        .sort((a, b) => (a.displayState ?? a.state).localeCompare(b.displayState ?? b.state)
          || a.index - b.index)
        .map((a) => a.label)
      expect(raw).toEqual(['verify:auth', 'verify:client', 'review:tests', 'review:docs'])
    })

    it('and the SORT is the traversal — j/k walks the rows as painted', async () => {
      await sortByState(CORRUPT_RUN)
      const painted = () => [...document.querySelectorAll<HTMLElement>('.at-row:not(.head)')]
        .map((r) => r.querySelector('.c-label .nm')!.textContent)
      const order = painted()
      const cursor = () => document.querySelector('.at-row[tabindex="0"] .c-label .nm')!.textContent
      for (let i = 0; i < order.length; i++) {
        fireEvent.keyDown(window, { key: 'j' })
        expect({ step: i, at: cursor() }).toEqual({ step: i, at: order[i] })
      }
      fireEvent.keyDown(window, { key: 'k' })
      expect(cursor()).toBe(order[order.length - 2])
    })

    it('flips with the column, and the LIVE control still sorts by the record', async () => {
      await sortByState(CORRUPT_RUN)
      fireEvent.click(screen.getByRole('button', { name: /^state \/ error/ }))
      expect(shownStates()[0]).toMatch(/^orphaned/)

      // The same click on the live run: nothing is orphaned, so the raw and effective
      // orderings coincide — the fix is about disagreement, not about reordering by fiat.
      cleanup()
      await sortByState(LIVE_RUN)
      expect(shownStates()).toEqual([...shownStates()].sort())
      expect(shownStates().some((s) => s.startsWith('orphaned'))).toBe(false)
    })

    it('is one derivation, not two — the model agrees with the DOM', async () => {
      // The unit-level statement of the same thing: `sortAgents` is what both the table and
      // `visibleAgentIndices` call, and it takes the verdict.
      const honesty = deriveHonesty(CORRUPT_RUN, { now: NOW })
      const byEffective = sortAgents(CORRUPT_RUN.agents, 'state', 'asc', honesty)
      expect(byEffective.map((a) => honesty.effectiveState(a)))
        .toEqual([...byEffective.map((a) => honesty.effectiveState(a))].sort())
      // With a LIVE verdict over the same agents the ordering is the raw one — which is the
      // ordering the shipped build produced for a dead run.
      const asIfLive = deriveHonesty({ ...CORRUPT_RUN, state: 'running' }, { now: NOW })
      expect(sortAgents(CORRUPT_RUN.agents, 'state', 'asc', asIfLive).map((a) => a.index))
        .not.toEqual(byEffective.map((a) => a.index))
    })
  })
})

/**
 * The derivation itself, as arithmetic — the rules the DOM above only observes.
 */
describe('deriveHonesty (§5.4.2 tiers, §6.4 step 8)', () => {
  const of = (state: RunDetail['state'], over: Partial<RunDetail> = {}) =>
    deriveHonesty({ ...LIVE_RUN, state, ...over }, { now: NOW })

  it('puts exactly {running, starting} on the live side', () => {
    expect(of('running').live).toBe(true)
    expect(of('starting').live).toBe(true)
    for (const dead of ['stale', 'unknown', 'corrupt-result', 'completed', 'failed', 'interrupted'] as const) {
      expect({ dead, live: of(dead).live }).toEqual({ dead, live: false })
    }
  })

  it('separates the QUIESCENT tier from the terminal one', () => {
    // Both are dead; only the quiescent ones died without saying so, which is what decides
    // whether the header's cell reads "died" or "ended".
    expect(of('stale').quiescent).toBe(true)
    expect(of('corrupt-result').quiescent).toBe(true)
    expect(of('unknown').quiescent).toBe(true)
    expect(of('completed').quiescent).toBe(false)
    expect(of('failed').quiescent).toBe(false)
  })

  it('strands an agent the server never marked, and only on a dead run', () => {
    const running = LIVE_RUN.agents[5]!
    expect(of('running').orphaned(running)).toBe(false)
    expect(of('running').moving(running)).toBe(true)
    expect(of('corrupt-result').orphaned(running)).toBe(true)
    expect(of('corrupt-result').moving(running)).toBe(false)
    // The server's own post-pass still wins on a LIVE run — it reads the lock, we do not.
    expect(of('running').moving({ ...running, displayState: 'orphaned' })).toBe(false)
    // A settled agent was never moving in the first place.
    expect(of('running').moving(LIVE_RUN.agents[0]!)).toBe(false)
  })

  it('counts the orphans the header prints, without waiting for the post-pass', () => {
    // CORRUPT_RUN's agents arrive with `displayState` untouched: four are `running`/`queued`.
    expect(of('corrupt-result').orphanedCount).toBe(4)
    expect(of('running').orphanedCount).toBe(0)
  })

  it('abandons an unanswered question the moment the run stops', () => {
    const open = { qid: 'q', question: '?', askedAt: NOW, answered: false, answer: null, replayed: false, abandoned: false }
    const detail = { ...LIVE_RUN, questions: [open] }
    expect(deriveHonesty(detail, { now: NOW }).abandoned(open)).toBe(false)
    expect(deriveHonesty(detail, { now: NOW }).openQuestions).toHaveLength(1)
    const dead = deriveHonesty({ ...detail, state: 'corrupt-result' }, { now: NOW })
    expect(dead.abandoned(open)).toBe(true)
    expect(dead.openQuestions).toHaveLength(0)
    // An ANSWERED question is never abandoned, dead run or not.
    expect(dead.abandoned({ ...open, answered: true, answer: 'yes' })).toBe(false)
  })

  /**
   * `agentDuration`, as arithmetic. The DOM tests above prove the four surfaces agree; this
   * proves what they agree ON, case by case — including the two that carry a number nobody
   * may print.
   */
  describe('agentDuration — five readings, two of them printable', () => {
    const at = (over: Partial<Parameters<typeof agentDuration>[0]>, ctx: Partial<Parameters<typeof agentDuration>[1]> = {}) =>
      agentDuration({ ...LIVE_RUN.agents[0]!, ...over }, { moving: false, orphaned: false, now: 5_000, ...ctx })

    it('takes a terminal event as the fact it is, alive or dead', () => {
      expect(at({ startedAt: 1_000, endedAt: 3_000, durationMs: null }))
        .toEqual({ kind: 'recorded', ms: 2_000 })
      // The engine's own figure wins over the subtraction where it has one.
      expect(at({ startedAt: 1_000, endedAt: 3_000, durationMs: 1_900 }))
        .toEqual({ kind: 'recorded', ms: 1_900 })
    })

    it('reads a MOVING agent as "so far", never as the attempt on file', () => {
      expect(at({ state: 'running', startedAt: 1_000, endedAt: null, durationMs: 40_000 }, { moving: true }))
        .toEqual({ kind: 'live', ms: 4_000 })
    })

    it('refuses the retained figure the moment the current attempt has no end', () => {
      const stranded = { state: 'running' as const, startedAt: 1_000, endedAt: null }
      // Orphaned by the post-pass, or simply not moving with the record still `running`.
      expect(at({ ...stranded, durationMs: 61_000 }, { orphaned: true }))
        .toEqual({ kind: 'prior', ms: 61_000 })
      expect(at({ ...stranded, durationMs: 61_000 })).toEqual({ kind: 'prior', ms: 61_000 })
      expect(at({ ...stranded, durationMs: null })).toEqual({ kind: 'unrecorded' })
      // …and NEITHER is printable, which is the whole point of the two kinds.
      expect(durationValue({ kind: 'prior', ms: 61_000 })).toBeNull()
      expect(durationValue({ kind: 'unrecorded' })).toBeNull()
    })

    it('keeps E5\'s durationMs for an agent that settled without a timestamp', () => {
      expect(at({ state: 'failed', startedAt: 1_000, endedAt: null, durationMs: 2_000 }))
        .toEqual({ kind: 'recorded', ms: 2_000 })
    })

    it('gives a queued agent nothing, and a cache hit its replayed lifetime', () => {
      expect(at({ state: 'queued', startedAt: null, endedAt: null, durationMs: null }))
        .toEqual({ kind: 'absent' })
      // A cache hit's three timestamps are one instant, so `endedAt - startedAt` is `0ms` —
      // exactly the fabrication #53 forbids. Its `durationMs` is the original's.
      expect(at({ state: 'cached', cached: true, startedAt: 9, endedAt: 9, durationMs: 4_000 }))
        .toEqual({ kind: 'recorded', ms: 4_000 })
      expect(at({ state: 'cached', cached: true, startedAt: 9, endedAt: 9, durationMs: null }))
        .toEqual({ kind: 'absent' })
    })

    it('advances a live reading with the clock, and freezes a recorded one', () => {
      const live = LIVE_RUN.agents[5]!
      const early = agentDuration(live, { moving: true, orphaned: false, now: T0 + 500_000 })
      const later = agentDuration(live, { moving: true, orphaned: false, now: T0 + 600_000 })
      expect(durationValue(later)! - durationValue(early)!).toBe(100_000)
      const settled = LIVE_RUN.agents[0]!
      expect(agentDuration(settled, { moving: false, orphaned: false, now: T0 + 500_000 }))
        .toEqual(agentDuration(settled, { moving: false, orphaned: false, now: T0 + 9_000_000 }))
    })
  })

  it('builds a duration only where one exists (parity #46)', () => {
    const at = (over: Partial<Parameters<typeof runClock>[0]>) => runClock({
      startedAt: 1_000, endedAt: null, live: false, quiescent: false, now: 5_000, ...over,
    })
    expect(at({ live: true })).toEqual({ kind: 'ticking', startedAt: 1_000, ms: 4_000 })
    expect(at({ endedAt: 3_000 })).toEqual({ kind: 'settled', startedAt: 1_000, endedAt: 3_000, ms: 2_000 })
    // The defect: not live, no end — and therefore NO `ms` field to render at all.
    expect(at({ quiescent: true })).toEqual({ kind: 'unrecorded', startedAt: 1_000, quiescent: true })
    expect(at({ startedAt: null })).toEqual({ kind: 'unstarted' })
    // A terminal event beats liveness: `endedAt` is the fact, `now` is not.
    expect(at({ live: true, endedAt: 3_000 }).kind).toBe('settled')
  })
})

/**
 * ROUND 11 — the LAST consumer family, and the one the enumeration walked straight past:
 * the run's own state.
 *
 * Rounds 6–10 moved agent state, agent durations and the run clock onto the verdict. None of
 * them touched the field the verdict is ABOUT. `RunHonesty.state` is `deriveRunState`'s
 * answer, polled separately from the snapshot (§6.4), and its own type says it MAY LEAD
 * `detail.state`. That window is not a corrupt payload to be rejected — it is the normal
 * one-poll lag this module exists to resolve, and inside it the header rendered a SPINNING
 * glyph and a `running` chip an inch above its own "died: not recorded" cell, and
 * `canResumeState(detail.state)` DISABLED Resume: the one action an operator opens a dead
 * run to take, refused by the only widget that had not been told the run was dead.
 *
 * `boundary.test.ts` is what stops a fourth site. This is what the three fixed ones now do.
 */
describe('the run-level verdict leads the snapshot (round 11)', () => {
  /** `deriveRunState` has called this run stale; the snapshot in hand still says `running`. */
  const SNAPSHOT_SAYS_RUNNING: RunDetail = { ...STALE_RUN, state: 'running' }
  const verdict = (state: RunDetail['state']) =>
    deriveHonesty(SNAPSHOT_SAYS_RUNNING, { now: NOW, state })

  const header = (state: RunDetail['state']) => render(
    <>
      <IconSprite />
      <RunHonestyContext.Provider value={verdict(state)}>
        <RunHeader
          detail={SNAPSHOT_SAYS_RUNNING} now={NOW}
          capabilities={['resume', 'cancel', 'delete']}
          logOpen={false} onToggleLog={() => {}}
          onCancelRun={() => {}} onDelete={() => {}}
        />
      </RunHonestyContext.Provider>
    </>,
  )

  const button = (name: RegExp) => screen.getByRole('button', { name })

  it('shows the header no spinner and no "running" chip', () => {
    header('stale')
    // Parity #58's exact prohibition. The snapshot says `running`; `spins('running')` is
    // true; the mark on screen is the one the VERDICT supports.
    expect(document.querySelectorAll('.ic-spin')).toHaveLength(0)
    expect(screen.getAllByText('stale').length).toBeGreaterThan(0)
    expect(screen.queryByText('running')).toBeNull()
    // …and the clock cell agrees with it rather than ticking through the page-open instant.
    expect(screen.getByText('died')).toBeTruthy()
    expect(screen.getByText('not recorded')).toBeTruthy()
  })

  it('gates Resume, Cancel and Delete on the verdict, not on the snapshot', () => {
    header('stale')
    // The defect in one assertion: `canResumeState('running')` is false, so the shipped
    // header disabled the only control this screen exists for.
    expect(button(/^Resume$/).getAttribute('aria-disabled')).toBe('false')
    // A dead run cannot be cancelled and CAN be deleted — both read `honesty.live`.
    expect(button(/Cancel run/).getAttribute('aria-disabled')).toBe('true')
    expect(button(/Cancel run/).getAttribute('title')).toBe('only a running run can be cancelled')
    expect(button(/Delete/).getAttribute('aria-disabled')).toBe('false')
  })

  it('and arming it actually reaches the API — the gate is not cosmetic', async () => {
    const resumeFn = vi.fn(async () => ({
      runId: STALE_RUN.runId, launchAccepted: true, mode: 'resume' as const, from: 'stale' as const,
    }))
    render(
      <>
        <IconSprite />
        <RunHonestyContext.Provider value={verdict('stale')}>
          <RunHeader
            detail={SNAPSHOT_SAYS_RUNNING} now={NOW} capabilities={['resume']}
            logOpen={false} onToggleLog={() => {}} resumeFn={resumeFn}
          />
        </RunHonestyContext.Provider>
      </>,
    )
    fireEvent.click(button(/^Resume$/))
    fireEvent.click(button(/Resume audit-viewer-security\?/))
    await vi.waitFor(() => expect(resumeFn).toHaveBeenCalledWith(STALE_RUN.runId))
  })

  it('the CONTROL: a live verdict over the same snapshot spins and refuses the resume', () => {
    // Without this the suite passes on a header that never spins and never resumes at all.
    header('running')
    expect(document.querySelectorAll('.ic-spin').length).toBeGreaterThan(0)
    expect(button(/^Resume$/).getAttribute('aria-disabled')).toBe('true')
    expect(button(/^Resume$/).getAttribute('title'))
      .toBe('enabled only for a completed, failed, interrupted or stale run')
    expect(button(/Cancel run/).getAttribute('aria-disabled')).toBe('false')
    expect(button(/Delete/).getAttribute('aria-disabled')).toBe('true')
  })

  it('labels Replay from the verdict too, not from the snapshot', () => {
    header('completed')
    expect(button(/^Replay$/)).toBeTruthy()
    expect(button(/^Replay$/).getAttribute('aria-disabled')).toBe('false')
  })

  it('gives the dead-run card the verdict\'s glyph and the verdict\'s copy', () => {
    render(
      <>
        <IconSprite />
        <DeadRunCard detail={SNAPSHOT_SAYS_RUNNING} honesty={verdict('stale')} />
      </>,
    )
    expect(document.querySelectorAll('.ic-spin')).toHaveLength(0)
    expect(screen.getByText(/engine died mid-flight/)).toBeTruthy()
    // The stale ruling the header, the lineage and `AttentionStrip` already obey: no
    // fabricated time of death, from the copy that used to key off `detail.state === 'stale'`
    // and so read "it wrote a terminal event" on a run that provably had not.
    expect(screen.getByText(/no terminal event, so there is no time of death/)).toBeTruthy()
  })

  it('and the card\'s terminal control still reads as terminal', () => {
    render(
      <>
        <IconSprite />
        <DeadRunCard detail={SNAPSHOT_SAYS_RUNNING} honesty={verdict('failed')} />
      </>,
    )
    expect(screen.getByText('This run failed.')).toBeTruthy()
    expect(screen.getByText(/wrote a terminal event/)).toBeTruthy()
  })
})
