// @vitest-environment jsdom
//
// The cockpit as a COMPOSITION (§11.1's DOM half). The pure model tests beside this file
// prove the arithmetic; these prove the screen — the split exists because every pure
// test can pass while the page is broken.
//
// Covered here: parity #45–#46 (header + frozen clock), #52–#54 (agents table), #56/#58
// (unknown → neutral, orphaned), #59 (last log line), #60–#62 (empty/loading), the §2.7
// keyboard, the log lane, and §6.5's degradation with visible notes and zero blank panels.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Cockpit } from './Cockpit.js'
import { LogLane } from './LogLane.js'
import { IconSprite } from '../../ui/Icon.js'
import {
  CORRUPT_RUN, DEAD_STRUCTURED_RUN, EMPTY_RUN, FRESH_RUN, LEGACY_RUN, LIVE_RUN, NOW,
  STALE_RUN, T0, fixedApi,
} from './fixtures.js'
import { fmtDuration } from '../../format/fmt.js'
import { ganttModel } from './gantt.js'
import type { RunDetail } from '../../api/types.js'
import { ApiError, api } from '../../api/client.js'
import { resetRouteForTests } from '../../app/router.js'

// Only `Date` is faked: the store commits through requestAnimationFrame and the poll runs
// on real timers, so faking those would deadlock every `waitFor` in this file.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.location.hash = '#/'
  resetRouteForTests()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * The Agents table's body rows.
 *
 * They are BUTTONS in a list, not `role="row"` (round 5, B2): `row` is only legal inside a
 * table/grid/treegrid, so the old markup exposed an invalid role and these queries found it
 * anyway. Structure is asserted by role in the accessibility block below; everywhere else
 * this reads the rows the way the operator sees them — by class, off the DOM.
 */
const bodyRows = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.at-row:not(.head)')]

const mount = async (detail: RunDetail, props: Record<string, unknown> = {}) => {
  const view = render(
    <>
      <IconSprite />
      <Cockpit runId={detail.runId} storeApi={fixedApi(detail)} {...props} />
    </>,
  )
  await screen.findByRole('tablist')
  return view
}

describe('header (parity #45, #46, #59)', () => {
  it('shows the name, the run id, the state chip and the liveness detail', async () => {
    await mount(LIVE_RUN)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('judge-panel-auth-refactor')
    expect(screen.getByRole('button', { name: /Copy run id r_2f91c4a8/ })).toBeTruthy()
    // Q2's ladder: the server's own verdict, verbatim, not a re-derivation.
    expect(screen.getByText('run.lock held by live pid 51204')).toBeTruthy()
  })

  it('carries the aggregate stats §2.4 lists', async () => {
    await mount(LIVE_RUN)
    const metrics = document.querySelector('.rhead-metrics')!
    expect(metrics.textContent).toContain('14m2s')       // elapsed
    expect(metrics.textContent).toContain('4')           // agents done
    expect(metrics.textContent).toContain('1.5M')        // input tokens
    expect(metrics.textContent).toContain('375k')        // output tokens
    expect(metrics.textContent).toContain('$9.04')       // cost
  })

  it('freezes the elapsed clock at the terminal duration (#46)', async () => {
    const done: RunDetail = {
      ...LIVE_RUN, state: 'completed', endedAt: T0 + 120_000,
      attemptSpans: [{ state: 'started', t: T0 }, { state: 'completed', t: T0 + 120_000 }],
    }
    await mount(done)
    expect(document.querySelector('.rhead-metrics')!.textContent).toContain('2m0s')
    // Advancing the wall clock must not move it: `elapsed` stops reading `now` once
    // `endedAt` exists, so there is no timer to leak either.
    act(() => { vi.setSystemTime(NOW + 600_000) })
    expect(document.querySelector('.rhead-metrics')!.textContent).toContain('2m0s')
  })

  it('renders the last workflow log line as ONE truncated row (#59)', async () => {
    await mount(LIVE_RUN)
    const lastlog = document.querySelector('.lastlog')!
    expect(lastlog.textContent).toContain('drafting the docs section…')
    expect(within(lastlog as HTMLElement).getByText('agent 7')).toBeTruthy()
  })

  it('plots the budget gauge on OUTPUT tokens, with a hatched overshoot past the ceiling', async () => {
    await mount(LIVE_RUN)
    const cell = document.querySelector('.gauge-cell')!
    expect(cell.textContent).toContain('375k')
    expect(cell.textContent).toContain('340k')
    expect(cell.textContent).toContain('soft ceiling')
    // Critique M19: neither the cost nor the INPUT tokens are the gauge's subject.
    expect(cell.textContent).not.toContain('$9.04')
    expect(cell.textContent).not.toContain('1.5M')
    expect(cell.querySelector('.gauge-bar .over')).not.toBeNull()
    const fill = cell.querySelector<HTMLElement>('.gauge-bar .fill')!
    // 375.1k against a 340k ceiling: the fill stops AT the ceiling and the hatch runs past.
    expect(Number.parseFloat(fill.style.width)).toBeCloseTo((100 / 110.32) * 100, 0)
  })

  it('offers no budget bar, and says why, when the run set no ceiling', async () => {
    await mount({ ...LIVE_RUN, budgetTotal: null })
    expect(document.querySelector('.gauge-bar')).toBeNull()
    expect(document.querySelector('.gauge-cell')!.textContent).toContain('no ceiling set')
  })
})

// §13 Q4: "Show `args`? Yes, behind an explicit 'show args' disclosure in the cockpit header
// (RunDetail `?include=args`), because args may contain secrets and must not sit in the
// default payload or the stream (§5.6.5)." The whole answer is in WHEN the request happens.
describe('the show-args disclosure (§13 Q4)', () => {
  const ARGS = { repo: 'flowition', dimensions: ['bugs', 'perf'], depth: 3 }
  const withArgs = (over: Partial<RunDetail> = {}) =>
    vi.fn(async (_runId: string, _signal?: AbortSignal) =>
      ({ ...LIVE_RUN, args: ARGS, ...over }) as RunDetail)

  const reveal = () => fireEvent.click(screen.getByRole('button', { name: /show args/ }))

  it('asks for nothing until the operator clicks, then asks exactly once', async () => {
    const argsFn = withArgs()
    await mount(LIVE_RUN, { argsFn })
    // Mounted, polled, rendered — and the audited read has NOT happened.
    expect(argsFn).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: /Run arguments/ })).toBeNull()
    expect(document.body.textContent).not.toContain('flowition')

    reveal()
    await waitFor(() => expect(argsFn).toHaveBeenCalledTimes(1))
    expect(argsFn.mock.calls[0]![0]).toBe(LIVE_RUN.runId)
    const panel = screen.getByRole('region', { name: /Run arguments/ })
    expect(panel.textContent).toContain('"repo": "flowition"')
    expect(panel.textContent).toContain('"depth": 3')

    // Close and reopen: args are written once at admission, so a second look must not
    // manufacture a second `args-read` audit line (§5.4.1).
    fireEvent.click(screen.getByRole('button', { name: /hide args/ }))
    expect(screen.queryByRole('region', { name: /Run arguments/ })).toBeNull()
    reveal()
    expect(screen.getByRole('region', { name: /Run arguments/ }).textContent)
      .toContain('"repo": "flowition"')
    expect(argsFn).toHaveBeenCalledTimes(1)
  })

  it('shows no affordance at all for a run that recorded no args', async () => {
    const argsFn = withArgs()
    await mount({ ...LIVE_RUN, hasArgs: false }, { argsFn })
    expect(screen.queryByRole('button', { name: /show args/ })).toBeNull()
    expect(argsFn).not.toHaveBeenCalled()
  })

  it('says the server withheld the value rather than showing a prefix of nothing', async () => {
    // §5.4.1: past the 1 MiB inline cap the value is OMITTED and `argsTruncated` is set.
    const argsFn = vi.fn(async () => {
      const { args: _drop, ...rest } = { ...LIVE_RUN, args: undefined }
      return { ...rest, argsTruncated: true } as RunDetail
    })
    await mount(LIVE_RUN, { argsFn })
    reveal()
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /Run arguments/ }).textContent)
        .toContain('exceeded the 1 MiB inline cap'))
    expect(document.querySelector('.args-json')).toBeNull()
  })

  it('surfaces a refusal verbatim instead of an empty panel', async () => {
    const argsFn = vi.fn(async () => {
      throw new ApiError(403, 'forbidden', 'reading args is disabled on this viewer')
    })
    await mount(LIVE_RUN, { argsFn })
    reveal()
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent)
        .toContain('reading args is disabled on this viewer'))
  })

  it('is a LOADING state while the read is in flight, not a blank box', async () => {
    let settle: (d: RunDetail) => void = () => {}
    const argsFn = vi.fn(() => new Promise<RunDetail>((resolve) => { settle = resolve }))
    await mount(LIVE_RUN, { argsFn })
    reveal()
    expect(screen.getByRole('region', { name: /Run arguments/ }).textContent)
      .toContain('reading args…')
    await act(async () => { settle({ ...LIVE_RUN, args: ARGS }) })
    expect(screen.getByRole('region', { name: /Run arguments/ }).textContent)
      .toContain('"repo": "flowition"')
  })

  it('reads args on a URL the polled snapshot route cannot produce', async () => {
    // The client half of the same claim: `runDetail` — the call the store polls — has no
    // way to ask for args, and `runArgs` is the only request in the client that does.
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    try {
      await api.runDetail('r_1')
      await api.runArgs('r_1')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(urls[0]).toBe('/api/runs/r_1')
    expect(urls[0]).not.toContain('include')
    expect(urls[1]).toBe('/api/runs/r_1?include=args')
  })
})

describe('the stale run tells the truth about what it does not know', () => {
  it('states the time of death as NOT RECORDED and never dates it from startedAt', async () => {
    await mount(STALE_RUN)
    const metrics = document.querySelector('.rhead-metrics')!
    expect(metrics.textContent).toContain('not recorded')
    expect(metrics.textContent).toMatch(/started \d+[mhd] ago/)
    // The specific fabrication the comps' ruling forbids: an elapsed figure that counts
    // upward forever on a run that stopped.
    expect(metrics.textContent).not.toMatch(/died \d/)
  })

  it('promotes the resume decision and refuses to invent a death time in its copy', async () => {
    await mount(STALE_RUN)
    const card = document.querySelector('.resume-card')!
    expect(card.textContent).toContain('wrote no terminal event')
    expect(card.textContent).toContain('orphaned')
    expect(card.textContent).not.toMatch(/died \d+[mhd] ago/)
  })

  it('renders agents left mid-flight as orphaned, never as a live spinner (#58)', async () => {
    await mount(STALE_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const stranded = bodyRows().find((r) => r.textContent?.includes('audit:tokens'))!
    expect(within(stranded).getAllByText(/orphaned/).length).toBeGreaterThan(0)
    expect(stranded.querySelector('.ic-spin')).toBeNull()
    // Nothing anywhere on a dead run may spin (parity #58).
    expect(document.querySelector('.ic-spin')).toBeNull()
  })

  /**
   * Round 3's #58 test looked only at the default FLAT Agents view while claiming nothing
   * anywhere spins. Both other groupings roll agent states up, and both rolled a stranded
   * `running` straight through to a spinning glyph (review round 4, B1). Every tab, and
   * every grouping inside it, is now walked on a run that has stopped.
   */
  describe('and nothing in ANY tab spins once it has (parity #58)', () => {
    const walkEveryTab = () => {
      fireEvent.click(screen.getByRole('tab', { name: /Timeline/ }))
      expect(document.querySelector('.ic-spin')).toBeNull()
      fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
      expect(document.querySelector('.ic-spin')).toBeNull()
      fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
      expect(document.querySelector('.ic-spin')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
      expect(document.querySelector('.ic-spin')).toBeNull()
    }

    it('holds on the stale run, whose Audit phase still holds a running agent', async () => {
      await mount(STALE_RUN)
      fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
      fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
      const audit = [...document.querySelectorAll('.phead')]
        .find((h) => h.textContent?.includes('Audit'))!
      // The phase still SAYS what it holds — one running, one queued — and says it in
      // the vocabulary of a run that has stopped.
      expect(audit.querySelector('.ic-spin')).toBeNull()
      expect(audit.querySelector('.g')!.className).toContain('orphan')
      expect(audit.querySelector('.cnt')!.textContent).toContain('2 orphaned')
      expect(audit.querySelector('.cnt')!.textContent).not.toContain('running')
      // The mark's own screen-reader text keeps BOTH facts — "orphaned (running)" — so
      // nothing is hidden from a reader who cannot see the glyph, only de-animated.
      expect(audit.querySelector('.g .vh')!.textContent).toBe('orphaned (running)')
      walkEveryTab()
    })

    it('holds on a failed run that still has its containers, phases and queue', async () => {
      // The stale fixture has `structure: null`, so it can only ever exercise the flat
      // fallback. This one keeps the live run's `parallel(3)` and `pipeline(5 × 2)`.
      await mount(DEAD_STRUCTURED_RUN)
      fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
      const heads = [...document.querySelectorAll('.node > .nhead')]
      expect(heads.length).toBeGreaterThan(1)
      // The pipeline's roll-up is still `mixed` — the fold's verdict is not overwritten —
      // but the mark beside it no longer turns.
      const pipeline = heads.find((h) => h.textContent?.includes('pipeline'))!
      expect(pipeline.textContent).toContain('mixed')
      expect(pipeline.querySelector('.ic-spin')).toBeNull()
      // …and the stranded chips inside it carry the orphaned mark, not a running one.
      const chip = [...document.querySelectorAll('.achip')]
        .find((c) => c.textContent?.includes('review:docs'))!
      expect(chip.querySelector('.g')!.className).toContain('orphan')
      // Round 11, B1: the CHIP ITSELF, not only the mark inside it. `.achip.r` paints the
      // running border (`cockpit.css:445`), so a chip that keeps `r` is a running-coloured
      // card around a glyph that says `orphaned` — parity #58 broken by the parent of the
      // element every earlier assertion looked at.
      expect(chip.className.split(/\s+/)).not.toContain('r')
      expect(chip.className.split(/\s+/)).toContain('u')
      walkEveryTab()
    })

    /**
     * The control the check above is worthless without: on a LIVE run the same agent is
     * genuinely running, and the running border is the truth. Neutralising every chip
     * would satisfy the assertion above and lose §3.2's vocabulary.
     */
    it('keeps the running colour on the chips of a run that is still live', async () => {
      await mount(LIVE_RUN)
      fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
      const chip = [...document.querySelectorAll('.achip')]
        .find((c) => c.textContent?.includes('review:docs'))!
      expect(chip.className.split(/\s+/)).toContain('r')
      expect(chip.querySelector('.g')!.className).not.toContain('orphan')
    })

    /**
     * The state the whole rule was leaking through (review round 5, B1).
     *
     * `corrupt-result` is QUIESCENT, not live: DESIGN §5.4.2 (DESIGN.md:816) groups it with
     * `stale` and `unknown`, and `deriveRunState` only reaches it after the control socket
     * fails to answer AND `run.lock` holds no live pid (src/run-state.js:141–152). Deriving
     * death as `terminalOrStale` therefore left it on the live side of every §6.4 step 8
     * rule. This fixture's agents also arrive WITHOUT `displayState`, so nothing here can
     * pass on a value the server handed down — the client's own liveness rule is the only
     * thing that can stop them.
     */
    it('holds on a corrupt-result run, which the server never marked orphaned', async () => {
      await mount(CORRUPT_RUN)
      fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
      const stranded = bodyRows().find((r) => r.textContent?.includes('review:tests'))!
      expect(within(stranded).getAllByText(/orphaned/).length).toBeGreaterThan(0)
      // …and the reading says both facts, exactly as the stale run's does.
      expect(stranded.getAttribute('aria-label')).toContain('state orphaned (running)')
      // The queued agents are stranded too, not waiting for a turn that never comes.
      expect(bodyRows().find((r) => r.textContent?.includes('verify:auth'))!
        .getAttribute('aria-label')).toContain('state orphaned (queued)')
      walkEveryTab()
    })

    it('freezes a corrupt-result run\'s Timeline instead of advancing it to now', () => {
      // Pure model, so the freeze is exact rather than observed: with the run quiescent the
      // window never reaches `now`, and the stranded agent's bar ends at its last real
      // provider output rather than growing for as long as the page stays open.
      const later = NOW + 3_600_000
      const model = ganttModel(CORRUPT_RUN, { now: later })
      expect(model.end).toBeLessThan(later)
      expect(model.end).toBeLessThanOrEqual(NOW)
      const running = model.lanes.find((l) => l.label === 'review:tests')!
      // `orphaned` is DERIVED here, not passed through: this fixture's agent still carries
      // `displayState: 'running'` from the server, which is the point (round 5, B1). The
      // RECORD keeps saying `running`; the state the lane renders is the client's own
      // verdict, and round 8 made that the one string every surface sorts and draws by.
      expect(running.state).toBe('running')
      expect(CORRUPT_RUN.agents.find((a) => a.label === 'review:tests')!.displayState)
        .toBe('running')
      expect(running.displayState).toBe('orphaned')
      expect(running.orphaned).toBe(true)
      // The bar ends at the last recorded fact, not at `now`, and says it is truncated.
      expect(running.open).toBe(false)
      expect(running.truncated).toBe(true)
      expect(model.nowPct).toBe(null)
      // The live run, same call, same clock: this one DOES run to now — the rule is about
      // death, not about caution.
      expect(ganttModel(LIVE_RUN, { now: later }).end).toBe(later)
    })

    /**
     * Parity #46, and the third shape of the clock nobody specified (round 6, B3).
     *
     * §2.4 asks for a clock that "ticks 1/s while live, freezes at terminal". Round 5 read
     * that as `elapsed(startedAt, endedAt ?? now)` and produced a THIRD behaviour on the
     * quiescent tier: `corrupt-result` has no `endedAt` and is not live, so the header froze
     * at `now - startedAt` — the length of the operator's browsing session, printed in bold
     * as the run's runtime, directly above a lineage strip that says the end time was never
     * recorded. The round-5 test asserted only that the fabricated number stopped changing,
     * which a fabrication does as soon as the tick is switched off.
     *
     * So this asserts the CONTRACT: no duration is shown at all, the specific fabricated
     * value is absent under any formatting, and the fact the run did record — its start — is
     * what the cell reports instead.
     */
    it('never fabricates a runtime for a run that recorded no end (parity #46)', async () => {
      await mount(CORRUPT_RUN)
      const metrics = () => document.querySelector('.rhead-metrics')!
      expect(metrics().textContent).not.toContain('elapsed')
      expect(metrics().textContent).toContain('died')
      expect(metrics().textContent).toContain('not recorded')
      // The exact number the old code printed: `now - startedAt`, in the header's own
      // formatter. Nothing on screen carries it.
      expect(metrics().textContent).not.toContain(fmtDuration(NOW - CORRUPT_RUN.startedAt!))
      // What it says instead is the recorded start, as an age — never as a runtime.
      expect(metrics().textContent).toMatch(/started .*(ago|just now)/)
      // …and the header now agrees with the lineage strip beside it, which already refused
      // to date the death. Two rows, one story.
      expect(document.querySelector('.lineage .unknown-end')).not.toBeNull()
    })

    it('still ticks on a live run and freezes on a real terminal duration', async () => {
      // The control for the assertion above: parity #46's clock is switched off by DEATH,
      // not by caution. `useTick(live)` installs a REAL 1 Hz interval, so this watches
      // wall-clock time.
      const elapsed = () => document.querySelector('.rhead-metrics')!.textContent
      await mount(LIVE_RUN)
      expect(elapsed()).toContain('elapsed')
      const live = elapsed()
      vi.setSystemTime(NOW + 600_000)
      await waitFor(() => expect(elapsed()).not.toBe(live), { timeout: 3_000 })
      cleanup()

      // A run that DID write a terminal event has a real, frozen duration — and it is the
      // journal's number, not the page's: 2m0s from `startedAt` to `endedAt`.
      vi.setSystemTime(NOW + 9_000_000)
      await mount(LEGACY_RUN)
      expect(elapsed()).toContain('elapsed')
      expect(elapsed()).toContain(fmtDuration(LEGACY_RUN.endedAt! - LEGACY_RUN.startedAt!))
    }, 10_000)

    it('still spins on the LIVE run — the rule is about death, not about caution', async () => {
      await mount(LIVE_RUN)
      fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
      fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
      const review = [...document.querySelectorAll('.phead')]
        .find((h) => h.textContent?.includes('Review'))!
      // `Review` holds a failed agent, so it rolls up failed rather than running…
      expect(review.textContent).toContain('failed')
      // …but the run is alive, so the Structure tab's mixed container still turns.
      fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
      expect(document.querySelector('.node .nhead .ic-spin')).not.toBeNull()
    })
  })
})

describe('§7.3 action gating', () => {
  it('disables Resume for a running run and Delete until it is terminal', async () => {
    await mount(LIVE_RUN, { capabilities: ['resume', 'delete', 'cancel'] })
    const actions = document.querySelector('.rhead-actions')!
    const resume = within(actions as HTMLElement).getByRole('button', { name: /Resume/ })
    expect(resume.getAttribute('aria-disabled')).toBe('true')
    const del = within(actions as HTMLElement).getByRole('button', { name: /Delete/ })
    expect(del.getAttribute('aria-disabled')).toBe('true')
    expect(del.getAttribute('title')).toContain('only a terminal run')
  })

  /**
   * Live-only gating on a quiescent run (round 5, B1). `corrupt-result` is not live, so
   * Cancel — which sends SIGINT to an engine that answers a socket — must be closed, and
   * Delete must be open: `src/retention.js:29` counts `corrupt-result` among the terminal
   * states a run can be deleted from. Resume stays closed because the server refuses it
   * (`src/viewer/control-bridge.js:372` — "corrupt-result needs a human"), which is a
   * different rule from liveness and must not be collapsed into it.
   */
  it('closes Cancel and opens Delete on a corrupt-result run', async () => {
    await mount(CORRUPT_RUN, { capabilities: ['resume', 'delete', 'cancel'] })
    const actions = document.querySelector('.rhead-actions') as HTMLElement
    const cancel = within(actions).getByRole('button', { name: /Cancel run/ })
    expect(cancel.getAttribute('aria-disabled')).toBe('true')
    expect(cancel.getAttribute('title')).toContain('only a running run can be cancelled')
    // Delete's liveness gate is OPEN — what still disables it in this build is the missing
    // type-to-confirm dialog (W12), which the title says instead of "only a terminal run".
    const del = within(actions).getByRole('button', { name: /Delete/ })
    expect(del.getAttribute('title')).not.toContain('only a terminal run')
    expect(del.getAttribute('title')).toContain('type its id first')
    expect(within(actions).getByRole('button', { name: /Resume/ }).getAttribute('aria-disabled'))
      .toBe('true')
  })

  it('labels a completed run\'s resume "Replay" (Sol-12, parity #99)', async () => {
    await mount({ ...LIVE_RUN, state: 'completed', endedAt: NOW }, { capabilities: ['resume'] })
    expect(screen.getByRole('button', { name: /Replay/ })).toBeTruthy()
  })

  it('arms before it resumes — one click never spawns an engine', async () => {
    await mount(STALE_RUN, { capabilities: ['resume'] })
    const resume = screen.getByRole('button', { name: /Resume/ })
    expect(resume.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(resume)
    expect(screen.getByRole('button', { name: /Resume audit-viewer-security\?/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Keep it stopped/ })).toBeTruthy()
  })

  it('says which capability is missing rather than hiding the control', async () => {
    await mount(STALE_RUN, { capabilities: [] })
    const resume = screen.getByRole('button', { name: /Resume/ })
    expect(resume.getAttribute('aria-disabled')).toBe('true')
    expect(resume.getAttribute('title')).toContain('--control=resume')
  })

  it('treats UNKNOWN capabilities as not-yet-permitted, not as unrestricted (M1)', async () => {
    // App passes `null` for the whole of the session bootstrap. A mutation that arms and
    // POSTs in that window is ungated — the capability set has not been reported yet.
    await mount(STALE_RUN, { capabilities: null })
    const resume = screen.getByRole('button', { name: /Resume/ })
    expect(resume.getAttribute('aria-disabled')).toBe('true')
    expect(resume.getAttribute('title')).toContain('waiting for the viewer session')
    // …and clicking it does not even ARM, so there is no second click that could POST.
    fireEvent.click(resume)
    expect(screen.queryByRole('button', { name: /Keep it stopped/ })).toBeNull()
    const del = screen.getByRole('button', { name: /Delete/ })
    expect(del.getAttribute('aria-disabled')).toBe('true')
    expect(del.getAttribute('title')).toContain('waiting for the viewer session')
  })

  it('opens the mutation once the session finally reports the capability', async () => {
    const view = await mount(STALE_RUN, { capabilities: null })
    expect(screen.getByRole('button', { name: /Resume/ }).getAttribute('aria-disabled')).toBe('true')
    view.rerender(
      <>
        <IconSprite />
        <Cockpit
          runId={STALE_RUN.runId} storeApi={fixedApi(STALE_RUN)} capabilities={['resume']}
        />
      </>,
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Resume/ }).getAttribute('aria-disabled')).toBe('false')
    })
  })
})

describe('the agents table (#52, #53, #54)', () => {
  beforeEach(async () => {
    await mount(LIVE_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
  })

  it('shows the label, adapter, model, effort, last tool and attempts', async () => {
    const row = bodyRows().find((r) => r.textContent?.includes('review:tests'))!
    expect(row.textContent).toContain('opus-5')
    expect(row.textContent).toContain('xhigh')
    expect(row.textContent).toContain('Grep')
    expect(within(row).getByText('adapter claude')).toBeTruthy()
  })

  it('shows a failed agent\'s error code AND its message inline (#54)', async () => {
    const row = bodyRows().find((r) => r.textContent?.includes('review:routes'))!
    expect(within(row).getByText('spawn_failed')).toBeTruthy()
    const message = within(row).getByText(/command not found/)
    expect(message.getAttribute('title')).toBe('codex: command not found — run `flowition doctor`')
    // §2.4 puts the error in the STATE cell; `last tool` is a column of its own (#53).
    const state = row.querySelector('.c-state')!
    expect(within(state as HTMLElement).getByText('spawn_failed')).toBeTruthy()
    expect(state.textContent).toContain('command not found')
  })

  // Round 1 merged the two columns, so an error EVICTED the last tool — which on a failed
  // agent is the datum that says where it died (review round 2, B1).
  it('keeps state/error and last tool as separate cells on an agent that has both', async () => {
    cleanup()
    await mount({
      ...LIVE_RUN,
      agents: LIVE_RUN.agents.map((a) => (a.index === 4
        ? {
          ...a,
          lastTool: 'Bash',
          errorCode: 'nonzero_exit',
          error: 'the adapter exited 1 after `npm test` — 3 suites failed',
        }
        : a)),
    })
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const row = bodyRows().find((r) => r.textContent?.includes('review:routes'))!

    const state = row.querySelector('.c-state')!
    expect(within(state as HTMLElement).getByText('nonzero_exit')).toBeTruthy()
    const message = within(state as HTMLElement).getByText(/exited 1 after/)
    expect(message.getAttribute('title')).toContain('3 suites failed')
    expect(state.querySelector('.chip')).not.toBeNull()          // the state chip is still there

    const tool = row.querySelector('.c-lastTool')!
    expect(tool.textContent).toContain('Bash')
    expect(tool.textContent).not.toContain('nonzero_exit')
    expect(tool.textContent).not.toContain('exited 1')
    expect(tool.querySelector('.absent')).toBeNull()
  })

  it('leaves absent fields BLANK, never 0 and never a dash (#53)', async () => {
    const row = bodyRows().find((r) => r.textContent?.includes('review:routes'))!
    // agent 4 never reported usage: in/out/cost carry no number and no placeholder glyph.
    for (const column of ['c-input', 'c-output', 'c-cost']) {
      const cell = row.querySelector(`.${column}`)!
      expect(cell.querySelector('.absent')).not.toBeNull()
      expect(cell.textContent).not.toContain('0')
      expect(cell.textContent).not.toContain('—')
      expect(cell.textContent).not.toContain('$')
    }
  })

  it('marks a cached agent as a replay (#52)', async () => {
    const row = bodyRows().find((r) => r.textContent?.includes('survey:tests'))!
    expect(within(row).getByText('replay')).toBeTruthy()
  })

  it('sorts by any column, biggest first, with absent values last', async () => {
    const labels = () => bodyRows().map((r) => r.querySelector('.c-label')?.textContent ?? '')
    // §2.1 Q4: the table OPENS on cost, descending — no click required.
    expect(labels()[0]).toContain('review:tests')          // $3.204
    expect(labels().at(-1)).toMatch(/verify:|review:routes/)

    // Flipping it puts the cheapest MEASURED agent first; the ones that reported no cost
    // at all stay at the bottom rather than being promoted as though they were free.
    fireEvent.click(screen.getByRole('button', { name: /^cost/ }))
    expect(labels()[0]).toContain('survey:tests')          // $0.121
    expect(labels().at(-1)).toMatch(/verify:|review:routes/)

    // …and another column takes over cleanly. The longest-running agent is `review:tests`
    // at 11m46s — it is still going, and the comp's own Agents table prints exactly that
    // figure for it (docs/frontend/comps/lib/fixtures.mjs:82). Before round 8 this column
    // sorted by the raw `durationMs`, which is `null` for every running agent, so the two
    // agents actually holding the run's slots sorted to the BOTTOM of a duration sort.
    fireEvent.click(screen.getByRole('button', { name: /^dur/ }))
    expect(labels()[0]).toContain('review:tests')
    expect(bodyRows()[0]!.querySelector('.c-duration')!.textContent).toBe('11m46s')
    // …and the longest SETTLED agent is next, at 3m08s.
    expect(labels()[2]).toContain('review:auth')
  })

  it('renders an unknown future state as the neutral mark, never a check (#56)', async () => {
    cleanup()
    await mount({
      ...LIVE_RUN,
      agents: [{ ...LIVE_RUN.agents[0]!, state: 'quarantined' as never, displayState: 'quarantined' as never }],
    })
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const row = bodyRows()[0]!
    expect(row.querySelector('.g.u')).not.toBeNull()
    expect(row.querySelector('.g.d')).toBeNull()
    expect(row.querySelector('use[href="#i-done"]')).toBeNull()
  })
})

describe('the phase tree (#47–#51, #119)', () => {
  const openPhases = async () => {
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
  }

  it('lists phases in declaration order with a rolled-up count (#47, #49)', async () => {
    await mount(LIVE_RUN)
    await openPhases()
    const heads = document.querySelectorAll('.phead')
    expect([...heads].map((h) => h.querySelector('.pn')!.textContent))
      .toEqual(['Survey', 'Review', 'Report'])
    expect(heads[0]!.querySelector('.cnt')!.textContent).toBe('2 done · 1 cached · 3/3')
  })

  it('shows a declared-but-unreached phase as pending, and "not run" once terminal (#48)', async () => {
    await mount(LIVE_RUN)
    await openPhases()
    expect(document.querySelectorAll('.phead')[2]!.textContent).toContain('pending')
    cleanup()
    await mount({ ...LIVE_RUN, state: 'completed', endedAt: NOW })
    await openPhases()
    expect(document.querySelectorAll('.phead')[2]!.textContent).toContain('not run')
  })

  it('auto-collapses a finished phase and leaves a mixed one open (#50)', async () => {
    await mount(LIVE_RUN)
    await openPhases()
    const heads = document.querySelectorAll('.phead')
    expect(heads[0]!.getAttribute('aria-expanded')).toBe('false')   // all done/cached
    expect(heads[1]!.getAttribute('aria-expanded')).toBe('true')    // mixed
  })

  it('an explicit toggle OVERRIDES the automatic rule and survives a fold update (#119)', async () => {
    const view = await mount(LIVE_RUN)
    await openPhases()
    const survey = () => document.querySelectorAll('.phead')[0]!
    fireEvent.click(survey())
    expect(survey().getAttribute('aria-expanded')).toBe('true')
    expect(survey().textContent).toContain('kept open by you')

    // A later fold update arrives — new props, same page. The override must not revert.
    view.rerender(
      <>
        <IconSprite />
        <Cockpit runId={LIVE_RUN.runId} storeApi={fixedApi({ ...LIVE_RUN, spend: { input: 1, output: 2, cost: 3 } })} />
      </>,
    )
    await waitFor(() => expect(survey().getAttribute('aria-expanded')).toBe('true'))
  })

  it('never drops an agent with no phase (#51)', async () => {
    await mount({
      ...LIVE_RUN,
      agents: [...LIVE_RUN.agents, { ...LIVE_RUN.agents[0]!, index: 42, label: 'stray', phaseIndex: null }],
    })
    await openPhases()
    const heads = [...document.querySelectorAll('.phead')]
    const trailing = heads[heads.length - 1]!
    expect(trailing.textContent).toContain('no phase')
  })
})

describe('empty and loading states (#60, #61, #62)', () => {
  it('shows a skeleton header and skeleton lanes before the snapshot lands (#61)', async () => {
    let resolve!: (detail: RunDetail) => void
    const pending = new Promise<RunDetail>((r) => { resolve = r })
    render(
      <>
        <IconSprite />
        <Cockpit runId={LIVE_RUN.runId} storeApi={{ runDetail: () => pending }} />
      </>,
    )
    expect(screen.getByLabelText('Loading run')).toBeTruthy()
    expect(document.querySelectorAll('.skel').length).toBeGreaterThan(3)
    await act(async () => { resolve(LIVE_RUN); await pending })
    await screen.findByRole('tablist')
  })

  it('explains a run with zero agents, differently live and terminal (#60)', async () => {
    await mount(EMPTY_RUN)
    expect(screen.getByText(/started no agents/)).toBeTruthy()
    cleanup()
    await mount({ ...EMPTY_RUN, state: 'running', endedAt: null })
    expect(screen.getByText(/hasn't called/)).toBeTruthy()
  })

  it('a fresh run whose first event has not landed shows NO older-engine copy (M2)', async () => {
    await mount(FRESH_RUN)
    expect(document.body.textContent).not.toContain('older engine')
    expect(screen.getByText(/has not written its first event/)).toBeTruthy()
  })

  it('names the failure when the API is unreachable', async () => {
    render(
      <>
        <IconSprite />
        <Cockpit
          runId="r_gone"
          storeApi={{ runDetail: () => Promise.reject(new Error('boom')) }}
        />
      </>,
    )
    expect((await screen.findByRole('alert')).textContent).toContain('API unreachable')
  })
})

describe('degradation on a pre-E1 run (§6.5) — notes, and zero blank panels', () => {
  it('names every missing capability on the Timeline and still draws bars', async () => {
    await mount(LEGACY_RUN)
    const timeline = document.querySelector('.tl')!
    expect(timeline.textContent).toContain('Recorded by an older engine')
    expect(timeline.textContent).toContain('bars start at the first')
    // The panel is REDUCED, not empty: two lanes, two bars, no saturation strip.
    expect(document.querySelectorAll('.lane')).toHaveLength(2)
    expect(document.querySelectorAll('.bar .exec').length).toBe(2)
    expect(document.querySelector('.sat')).toBeNull()
    expect(document.querySelector('.bar .wait')).toBeNull()
  })

  it('explains the missing DAG and falls back to a flat list, never a blank panel', async () => {
    await mount(LEGACY_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    const dag = document.querySelector('.dag')!
    expect(dag.textContent).toContain('Structure unavailable for runs recorded before v0.2')
    expect(dag.querySelectorAll('.achip').length).toBe(2)
  })

  it('labels approximate phase grouping in the Phases view', async () => {
    await mount({
      ...LEGACY_RUN,
      agents: LEGACY_RUN.agents.map((a) => ({ ...a, phaseIndex: 0, phaseApproximate: true })),
    })
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
    expect(document.querySelector('.at')!.textContent).toContain('Grouping approximate')
  })

  it('counts unrecognized events instead of dropping them silently', async () => {
    await mount({ ...LIVE_RUN, unknownEvents: 3, unknownEventTypes: { telemetry: 3 } })
    expect(screen.getByText(/3 unrecognized events — newer engine\?/)).toBeTruthy()
  })
})

/**
 * §3.7's grid, from the DOM side. The PIXELS are asserted in a real browser
 * (`test/comps-captures.test.js` against `capture-built.mjs`'s measurements) because jsdom
 * computes no layout; what belongs here is that the column exists, carries §2.4's three
 * registers, and becomes a handle-plus-drawer below §3.3's breakpoint.
 */
describe('the inbox rail — §3.7\'s third column', () => {
  const narrow = () => vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('899'), media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }))
  afterEach(() => { vi.unstubAllGlobals() })

  it('renders as a column with §2.4\'s three registers', async () => {
    await mount(LIVE_RUN)
    const inbox = screen.getByLabelText('Inbox')
    expect(document.querySelector('.cockpit > .col.inbox')).toBe(inbox)
    for (const register of ['questions', 'agent reports', 'steering history']) {
      expect(within(inbox).getByText(register)).toBeTruthy()
    }
    // (1) the unanswered ask with its text inline, (2) an answered one collapsed to its
    // answer value (E7), (3) dir:'out' reports, (4) dir:'in' steers with their verdict.
    expect(inbox.textContent).toContain('waiting on you')
    expect(inbox.textContent).toContain('Rewrite both, or keep a shim?')
    expect(inbox.textContent).toContain('no — they are ours')
    expect(inbox.textContent).toContain('Two high-severity findings so far.')
    expect(inbox.textContent).toContain('Also check the SSE endpoint for token leakage.')
    expect(within(inbox).getByText('live')).toBeTruthy()
  })

  it('names the composer as W12\'s rather than drawing one that cannot send', async () => {
    await mount(LIVE_RUN)
    const inbox = screen.getByLabelText('Inbox')
    expect(within(inbox).queryByRole('textbox')).toBeNull()
    expect(inbox.textContent).toContain('answer composer arrives with W12')
  })

  it('yields the whole column to W12\'s rail when one is supplied', async () => {
    await mount(LIVE_RUN, { inbox: <div data-testid="w12">the real rail</div> })
    expect(screen.getByTestId('w12')).toBeTruthy()
    expect(screen.queryByLabelText('Inbox')).toBeNull()
    expect(document.querySelectorAll('.cockpit > .col')).toHaveLength(2)
  })

  it('is a 44px handle and an overlay drawer below 900px, with the comps\' focus model', async () => {
    narrow()
    await mount(LIVE_RUN)
    // Closed: a handle carrying the open-question count, and no rail column.
    const handle = screen.getByRole('button', { name: 'Open inbox rail' })
    expect(document.querySelector('.cockpit > .col.strip')).toBeTruthy()
    expect(screen.queryByLabelText('Inbox')).toBeNull()
    expect(document.querySelector('.col.strip .dotn')!.textContent).toBe('1')

    // Opening moves focus to the drawer's HEADER (comps annotations 20–22)…
    handle.focus()
    fireEvent.click(handle)
    const drawer = screen.getByRole('dialog')
    expect(drawer.className).toContain('drawer')
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(within(drawer).getByRole('heading', { name: 'inbox' }))

    // …and Escape closes it and returns focus to the 44px handle that opened it.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open inbox rail' }))

    // The scrim is a real click-to-dismiss element, and it restores focus the same way.
    fireEvent.click(screen.getByRole('button', { name: 'Open inbox rail' }))
    fireEvent.click(document.querySelector('.inbox-scrim')!)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open inbox rail' }))
  })

  // §3.7's default states: "run rail open, inbox rail open BECAUSE THERE IS AN OPEN
  // QUESTION". Round 1 ignored `open` at desktop entirely, so Collapse did nothing and the
  // default was never applied (review round 2, B5).
  it('opens by default when the run has work in it, and collapses on demand', async () => {
    await mount(LIVE_RUN)                       // one unanswered ask + two agent reports
    expect(screen.getByLabelText('Inbox')).toBeTruthy()
    expect(document.querySelector('.cockpit')!.getAttribute('data-inbox')).toBe('open')

    // Collapse: the column becomes the 44px handle, and the grid says so.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse inbox rail' }))
    await waitFor(() => expect(screen.queryByLabelText('Inbox')).toBeNull())
    expect(document.querySelector('.cockpit > .col.strip')).toBeTruthy()
    expect(document.querySelector('.cockpit')!.getAttribute('data-inbox')).toBe('collapsed')

    // …and reopening restores it.
    fireEvent.click(screen.getByRole('button', { name: 'Expand inbox rail' }))
    await waitFor(() => expect(screen.getByLabelText('Inbox')).toBeTruthy())
    expect(document.querySelector('.cockpit')!.getAttribute('data-inbox')).toBe('open')
  })

  it('starts COLLAPSED on a run whose inbox holds nothing', async () => {
    // The stale run has no ask and no mail: the 320px belongs to the tab, not to three
    // empty registers.
    await mount(STALE_RUN)
    expect(screen.queryByLabelText('Inbox')).toBeNull()
    expect(document.querySelector('.cockpit')!.getAttribute('data-inbox')).toBe('collapsed')
    expect(screen.getByRole('button', { name: 'Expand inbox rail' })).toBeTruthy()
    // An agent report alone opens it — a report is news the operator has seen nowhere else.
    // (Mail is attempt-scoped, §6.4 step 1a, so the scope carries it too — the store folds
    // the current scope's mail onto the top level exactly as the server does.)
    cleanup()
    const report = {
      at: NOW - 1000, dir: 'out' as const, agent: 1, message: 'mapped the read surface',
      origin: null, delivery: null, callsite: null, mailId: 'm9',
    }
    await mount({
      ...STALE_RUN,
      mail: [report],
      mailTotal: 1,
      attemptScopes: [{ ...STALE_RUN.attemptScopes![0]!, mail: [report], mailTotal: 1 }],
    })
    expect(screen.getByLabelText('Inbox')).toBeTruthy()
  })

  // The comps' supporting frame, annotations 20–22, as ruled on: "…and Tab is trapped while
  // the scrim is up (role=dialog aria-modal)" (review round 2, B6).
  it('traps Tab inside the drawer while the scrim is up, forwards and backwards', async () => {
    narrow()
    await mount(LIVE_RUN)
    fireEvent.click(screen.getByRole('button', { name: 'Open inbox rail' }))
    const drawer = screen.getByRole('dialog')
    const stops = [...drawer.querySelectorAll<HTMLElement>('a[href], button')]
    expect(stops.length).toBeGreaterThan(1)
    const first = stops[0]!
    const last = stops[stops.length - 1]!

    // Focus opens on the HEADING, which is not a tab stop: the first Tab enters at the top.
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    // Tab off the end wraps to the start rather than walking out into the covered page…
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    // …and Shift+Tab off the start wraps to the end.
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    // Focus parked outside the dialog is pulled back in, not left behind the scrim.
    const outside = document.querySelector<HTMLElement>('.rhead-actions button')!
    outside.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(drawer.contains(document.activeElement)).toBe(true)

    // Escape still closes and restores focus to the handle (unchanged).
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open inbox rail' }))
  })

  it('promotes the stale run\'s resume card above the tabs ONLY below 900px', async () => {
    await mount(STALE_RUN)
    const order = () => [...document.querySelectorAll('.resume-card, .tabs')]
      .map((e) => (e.classList.contains('tabs') ? 'tabs' : 'card'))
    expect(order()).toEqual(['tabs', 'card'])
    cleanup()
    narrow()
    await mount(STALE_RUN)
    expect(order()).toEqual(['card', 'tabs'])
  })
})

describe('the §2.7 keyboard and the log lane', () => {
  it('`[` and `]` cycle the tabs', async () => {
    await mount(LIVE_RUN)
    const selected = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!
    expect(selected().textContent).toContain('Timeline')
    fireEvent.keyDown(window, { key: ']' })
    expect(selected().textContent).toContain('Structure')
    fireEvent.keyDown(window, { key: '[' })
    expect(selected().textContent).toContain('Timeline')
    fireEvent.keyDown(window, { key: '[' })
    expect(selected().textContent).toContain('Agents')
  })

  it('`l` opens the log lane and Escape closes it', async () => {
    await mount(LIVE_RUN)
    expect(screen.queryByLabelText('Log lane')).toBeNull()
    fireEvent.keyDown(window, { key: 'l' })
    expect(screen.getByLabelText('Log lane')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByLabelText('Log lane')).toBeNull()
  })

  it('moves focus INTO the log lane on open and back to the opener on every close path', async () => {
    await mount(LIVE_RUN)
    const opener = () => screen.getByRole('button', { name: /Log lane/ })

    // 1. the affordance on the last-log row: focus lands on the lane's own header…
    opener().focus()
    fireEvent.click(opener())
    const heading = within(screen.getByLabelText('Log lane')).getByRole('heading', { name: 'log lane' })
    expect(document.activeElement).toBe(heading)
    // …and the same button gets it back when the lane closes.
    fireEvent.click(within(screen.getByLabelText('Log lane')).getByRole('button', { name: /Close log lane/ }))
    expect(document.activeElement).toBe(opener())

    // 2. Escape is a close path too, and it restores the same way.
    fireEvent.click(opener())
    expect(document.activeElement).not.toBe(opener())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(opener())

    // 3. the keyboard `l` toggle, where there is no opener element to return to: focus
    //    still moves into the lane rather than being left on the body.
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(window, { key: 'l' })
    expect(within(screen.getByLabelText('Log lane')).getByRole('heading', { name: 'log lane' }))
      .toBe(document.activeElement)
  })

  it('gives the agents table a tab stop before the cursor exists, and keeps it under sorting', async () => {
    await mount(LIVE_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const rows = bodyRows
    // §3.6: a roving list Tab cannot enter is a keyboard-inaccessible list. The first
    // visible row holds the stop until the operator moves the cursor.
    expect(rows().filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1)
    expect(rows()[0]!.getAttribute('tabindex')).toBe('0')

    // Re-sorting moves the stop with the order, and there is still exactly one. (`dur`,
    // not `cost`: the table already opens on cost, so clicking it would only flip it.)
    fireEvent.click(screen.getByRole('button', { name: /^dur/ }))
    expect(rows().filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain('review:tests')
    expect(rows()[0]!.getAttribute('tabindex')).toBe('0')

    // Once the cursor is explicit it OWNS the stop, and re-sorting does not steal it back.
    fireEvent.focus(rows()[2]!)
    const chosen = rows()[2]!.getAttribute('aria-label')
    fireEvent.click(screen.getByRole('button', { name: /^dur/ }))
    const stops = rows().filter((r) => r.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
    expect(stops[0]!.getAttribute('aria-label')).toBe(chosen)

    // …and the Phases tree has ONE stop across all of its sections, not one per section.
    fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
    expect(rows().filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1)
  })

  it('ignores shortcuts while the operator is typing (parity #111\'s rule)', async () => {
    await mount(LIVE_RUN)
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'l' })
    expect(screen.queryByLabelText('Log lane')).toBeNull()
    input.remove()
  })

  it('renders the WHOLE log stream, not just the last line, and can page backwards', async () => {
    await mount(LIVE_RUN)
    fireEvent.keyDown(window, { key: 'l' })
    const lane = screen.getByLabelText('Log lane')
    // Every seeded record, not `logs.at(-1)` — the lane is a log view, not a status line.
    expect(lane.querySelectorAll('.log-row')).toHaveLength(LIVE_RUN.logs.length)
    expect(lane.textContent).toContain('1,842')
    expect(within(lane).getByRole('button', { name: /Earlier lines/ })).toBeTruthy()
    // The source lanes and the level filter are real filters over the same list.
    fireEvent.click(within(lane).getByRole('button', { name: 'engine' }))
    expect(lane.querySelectorAll('.log-row').length)
      .toBe(LIVE_RUN.logs.filter((l) => l.source === 'engine').length)
  })

  it('`j`/`k` move the agent cursor and Enter opens the transcript', async () => {
    await mount(LIVE_RUN)
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(window.location.hash).toBe('#/run/r_2f91c4a8/agent/1')
  })

  /**
   * §2.7's cursor is a claim about the VISIBLE list. Round 1 walked `detail.agents` — the
   * fold's insertion order — from every tab, so after a sort it moved unpredictably and
   * under the Phases grouping it could select a row inside a collapsed phase (review round
   * 2, M1).
   */
  it('`j`/`k` follow the SORTED order of the agents table', async () => {
    await mount(LIVE_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    fireEvent.click(screen.getByRole('button', { name: /^dur/ }))
    const rows = bodyRows
    const order = rows().map((r) => r.querySelector('.c-label')!.textContent)

    fireEvent.keyDown(window, { key: 'j' })
    const cursorLabel = () => document.querySelector('.at-row[tabindex="0"] .c-label')!.textContent
    expect(cursorLabel()).toBe(order[0]!)                 // the longest-running agent
    fireEvent.keyDown(window, { key: 'j' })
    expect(cursorLabel()).toBe(order[1]!)
    fireEvent.keyDown(window, { key: 'k' })
    expect(cursorLabel()).toBe(order[0]!)
    // …and it is the row the operator can see, not agent 0 and agent 1 of the raw list.
    expect(order[0]).toContain('review:tests')
  })

  it('`j`/`k` skip agents hidden inside a collapsed phase', async () => {
    await mount(LIVE_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
    // `Survey` is all done/cached, so #50 auto-collapses it: agents 0–2 are off screen.
    expect(document.querySelectorAll('.phead')[0]!.getAttribute('aria-expanded')).toBe('false')
    const visible = () => bodyRows().map((r) => r.getAttribute('aria-label'))

    fireEvent.keyDown(window, { key: 'j' })
    const cursor = () => document.querySelector('.at-row[tabindex="0"]')!.getAttribute('aria-label')
    expect(visible()).toContain(cursor())
    expect(cursor()).not.toContain('survey:')            // nothing from the collapsed phase

    // Walking to the end stays inside the visible rows the whole way.
    for (let i = 0; i < 12; i++) {
      fireEvent.keyDown(window, { key: 'j' })
      expect(visible()).toContain(cursor())
    }

    // Opening the collapsed phase brings its rows into the walk.
    fireEvent.click(document.querySelectorAll('.phead')[0]!)
    for (let i = 0; i < 12; i++) fireEvent.keyDown(window, { key: 'k' })
    expect(cursor()).toContain('survey:')
    expect(visible()).toContain(cursor())
  })
})

/**
 * §6.4 step 1a + the log lane's full-stream contract (review round 2, B3). The byte-domain
 * proof is in `logpaging.test.ts` against a real events file; what belongs here is that the
 * lane OFFERS the walk on an earlier attempt, and shows what it brings back.
 */
describe('the log lane on an earlier attempt', () => {
  const record = (o: number, attempt: number, i: number) => ({
    o,
    rec: {
      type: 'log', t: NOW - 100_000 + o, message: `a${attempt} line ${i}`,
      source: 'workflow', level: 'info',
    },
  })

  it('pages backwards and keeps only the selected attempt\'s records', async () => {
    // One page holding both attempts, with the resume boundary in the middle.
    const items = [
      ...Array.from({ length: 4 }, (_, i) => record(i, 0, i)),
      { o: 4, rec: { type: 'run', t: NOW - 50_000, state: 'resumed' } },
      ...Array.from({ length: 3 }, (_, i) => record(5 + i, 1, i)),
    ]
    const eventsPageFn = vi.fn(async () => ({ start: 0, end: 8, eof: true, items }))
    render(
      <>
        <IconSprite />
        <LogLane
          runId="r_scoped" logs={[]} logTotal={7} eventsOffset={8}
          scope={0} scopeCount={2}
          eventsPageFn={eventsPageFn as never}
          onClose={() => {}}
        />
      </>,
    )
    const lane = screen.getByLabelText('Log lane')
    // The walk is OFFERED — round 1 refused it out loud on a historical attempt.
    const earlier = within(lane).getByRole('button', { name: /Earlier lines/ })
    expect(lane.textContent).toContain('attempt 1 of 2')
    fireEvent.click(earlier)

    await waitFor(() => expect(lane.querySelectorAll('.log-row').length).toBe(4))
    const messages = [...lane.querySelectorAll('.log-row .m')].map((m) => m.textContent)
    expect(messages).toEqual(['a0 line 0', 'a0 line 1', 'a0 line 2', 'a0 line 3'])
    // Not one record of the attempt that replaced it, though both were in the same bytes.
    expect(lane.textContent).not.toContain('a1 line')
    // The walk knows it has reached the start of THIS attempt.
    await waitFor(() => {
      expect(lane.textContent).toContain('the start of this attempt')
    })
    expect(within(lane).queryByRole('button', { name: /Earlier lines/ })).toBeNull()
  })
})
