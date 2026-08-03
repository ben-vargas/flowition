// @vitest-environment jsdom
//
// The run rail, §2.2 / parity #37–#43.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RAIL_COLLAPSED_KEY, RAIL_MAX, RAIL_MIN, RAIL_WIDTH_KEY, RunRail } from './RunRail.js'
import { BLOCKED_DETAIL, RUNS_PAGE, fakeListing, makeRun } from '../features/home/fixtures.js'
import { ApiError } from '../api/client.js'
import type { RunDetail, RunSummary } from '../api/types.js'

const load = () => Promise.resolve(RUNS_PAGE)

/**
 * `GET /api/runs/:id` for a run out of a generated pool — the seam the pinned active row
 * reads. `RunDetail` is `RunSummary` with `agents` renamed to `agentCounts` (api/types.ts),
 * so a summary round-trips through it exactly, which is what makes the pinned row the same
 * projection as a listed one rather than a lookalike.
 */
const detailFor = (runId: string, pool: RunSummary[]): RunDetail => {
  const run = pool.find((r) => r.runId === runId)
  if (!run) throw new ApiError(404, 'not_found', 'no such run')
  const { agents, ...rest } = run
  return { ...BLOCKED_DETAIL, ...rest, agentCounts: agents, questions: [] }
}

const mount = (props: Partial<Parameters<typeof RunRail>[0]> = {}) =>
  render(<RunRail activeRunId={null} load={load} {...props} />)

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/#/')
  // Default to the wide layout; the drawer test opts into narrow explicitly.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false, media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the compact projection (#37, #38)', () => {
  it('lists every run with status, name-or-id and agents done/total', async () => {
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    const rows = await within(nav).findAllByRole('button', { name: /judge-panel|migrate|audit/ })
    expect(rows.length).toBeGreaterThan(0)
    const first = rows[0]!
    expect(first.textContent).toContain('4/10 agents')
    expect(within(first).getByText('running')).toBeTruthy()   // §3.6: never color alone
  })

  it('shows a run with no name as its run id', async () => {
    mount()
    expect(await screen.findByText('flo_0f2d44b1')).toBeTruthy()
  })

  it('carries a total-run count in its header (#38)', async () => {
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    await waitFor(() => expect(within(nav).getByText(String(RUNS_PAGE.totalOnDisk))).toBeTruthy())
  })

  it('surfaces open questions, so the rail says which run wants you', async () => {
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    const blocked = (await within(nav).findByText('migrate-callsites')).closest('button')!
    expect(blocked.textContent).toContain('1 ?')
  })
})

describe('active marking and selection (#39, #42)', () => {
  it('marks the open run active', async () => {
    mount({ activeRunId: 'r_77b0e412' })
    const active = (await screen.findByText('audit-viewer-security')).closest('button')!
    expect(active.getAttribute('aria-current')).toBe('true')
    const other = screen.getByText('docs-sweep').closest('button')!
    expect(other.getAttribute('aria-current')).toBeNull()
  })

  it('navigates on selection', async () => {
    mount()
    fireEvent.click((await screen.findByText('docs-sweep')).closest('button')!)
    expect(window.location.hash).toBe('#/run/r_9ab24d10')
  })

  // The regression: #39 was implemented against the LOADED rows, so a deep link to a run
  // deeper than the first page rendered a rail of 50 unrelated runs with no active marker
  // anywhere — the cockpit's own run missing from the switcher meant to say where you are.
  // Browser QA reproduced it at run 56 of 60: 50 rows, zero `aria-current`.
  it('pins the open run when it lives past the pages the rail has pulled (#39)', async () => {
    const many = Array.from({ length: 60 }, (_, i) => makeRun(i))
    const server = fakeListing(many)
    const detail = vi.fn(async (runId: string) => detailFor(runId, many))
    mount({ activeRunId: 'r_gen0055', load: server.load, loadDetail: detail })

    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    await within(nav).findByText('generated-run-0000')

    const pinned = (await within(nav).findByText('generated-run-0055')).closest('button')!
    expect(pinned.getAttribute('aria-current')).toBe('true')
    // Exactly one active row, and it is reachable: it is a row of the one roving list, not
    // a decoration outside it (§3.6).
    expect(nav.querySelectorAll('.rrow[aria-current]')).toHaveLength(1)
    expect(nav.querySelectorAll('.rrow')).toHaveLength(51)
    expect(pinned.closest('li')!.className).toContain('pinned')
    // One exact request, not a blind walk of the listing until the run turns up.
    expect(detail).toHaveBeenCalledTimes(1)
    expect(detail.mock.calls[0]![0]).toBe('r_gen0055')
    expect(server.calls).toHaveLength(1)
  })

  it('does not pin — or fetch — a run the listing already carries', async () => {
    const many = Array.from({ length: 60 }, (_, i) => makeRun(i))
    const server = fakeListing(many)
    const detail = vi.fn(async (runId: string) => detailFor(runId, many))
    mount({ activeRunId: 'r_gen0003', load: server.load, loadDetail: detail })

    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    const active = (await within(nav).findByText('generated-run-0003')).closest('button')!
    expect(active.getAttribute('aria-current')).toBe('true')
    expect(nav.querySelectorAll('.rrow')).toHaveLength(50)
    expect(nav.querySelectorAll('li.pinned')).toHaveLength(0)
    // A run on page one costs no detail request — including in the window before the first
    // page settles, when nothing is yet KNOWN to be absent.
    await new Promise((r) => setTimeout(r, 30))
    expect(detail).not.toHaveBeenCalled()
  })

  it('drops the pin as soon as paging reaches the run itself', async () => {
    const many = Array.from({ length: 60 }, (_, i) => makeRun(i))
    const server = fakeListing(many)
    mount({
      activeRunId: 'r_gen0055',
      load: server.load,
      loadDetail: async (runId: string) => detailFor(runId, many),
    })
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    await waitFor(() => expect(nav.querySelectorAll('.rrow')).toHaveLength(51))

    fireEvent.click(within(nav).getByRole('button', { name: 'Load more' }))
    // 60 listed rows, and the pinned duplicate is gone — never two rows for one run.
    await waitFor(() => expect(nav.querySelectorAll('.rrow')).toHaveLength(60))
    expect(within(nav).getAllByText('generated-run-0055')).toHaveLength(1)
    expect(nav.querySelectorAll('.rrow[aria-current]')).toHaveLength(1)
  })
})

describe('collapse (#41)', () => {
  it('collapses to an icon strip and persists the choice', async () => {
    const { unmount } = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse run rail' }))
    expect(screen.getByRole('button', { name: 'Expand run rail' })).toBeTruthy()
    expect(screen.queryByText('judge-panel-auth-refactor')).toBeNull()
    expect(JSON.parse(localStorage.getItem(RAIL_COLLAPSED_KEY)!)).toBe(true)

    // …and it survives a remount, which is what "persisted" has to mean.
    unmount()
    mount()
    expect(await screen.findByRole('button', { name: 'Expand run rail' })).toBeTruthy()
  })

  it('reopens', async () => {
    localStorage.setItem(RAIL_COLLAPSED_KEY, 'true')
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand run rail' }))
    expect(await screen.findByText('judge-panel-auth-refactor')).toBeTruthy()
  })
})

describe('resize (#43)', () => {
  it('is a labelled separator with the 200–480px bounds exposed', async () => {
    mount()
    const grip = await screen.findByRole('separator', { name: 'Resize run rail' })
    expect(grip.getAttribute('aria-valuemin')).toBe(String(RAIL_MIN))
    expect(grip.getAttribute('aria-valuemax')).toBe(String(RAIL_MAX))
  })

  it('resizes by keyboard and persists — §3.6 admits no pointer-only control', async () => {
    mount()
    const grip = await screen.findByRole('separator', { name: 'Resize run rail' })
    fireEvent.keyDown(grip, { key: 'ArrowRight', shiftKey: true })
    await waitFor(() => expect(JSON.parse(localStorage.getItem(RAIL_WIDTH_KEY)!)).toBe(312))
    for (let i = 0; i < 40; i++) fireEvent.keyDown(grip, { key: 'ArrowLeft', shiftKey: true })
    // Clamped at the floor, never negative or zero-width.
    expect(JSON.parse(localStorage.getItem(RAIL_WIDTH_KEY)!)).toBe(RAIL_MIN)
  })
})

describe('the narrow drawer (#42)', () => {
  const narrow = () => vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('899'), media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }))

  it('starts as an icon strip below 900px and closes on selection', async () => {
    narrow()
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand run rail' }))
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    expect(nav.className).toContain('drawer')
    fireEvent.click((await screen.findByText('docs-sweep')).closest('button')!)
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Runs' })).toBeNull())
    expect(window.location.hash).toBe('#/run/r_9ab24d10')
  })

  it('moves focus into the drawer, closes on Escape, and restores focus (§3.6)', async () => {
    narrow()
    mount()
    const expand = await screen.findByRole('button', { name: 'Expand run rail' })
    expand.focus()
    fireEvent.click(expand)
    // Opening a panel moves focus to its header — §3.6, "requirements, not aspirations".
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    await waitFor(() => expect(document.activeElement).toBe(nav.querySelector('.rail-head')))

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Runs' })).toBeNull())
    // …and closing restores it to the control that stands in the drawer's place, rather
    // than dropping the keyboard user on document.body.
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('button', { name: 'Expand run rail' })))
  })

  /**
   * The scrim was the one close path that deliberately did NOT restore focus, on the
   * reasoning that a pointer dismiss should not move the caret. But the thing being
   * unmounted may be holding focus, and then there is nothing to leave alone: the browser
   * drops focus on `document.body` and a keyboard or screen-reader user loses their place
   * in the document entirely. §3.6 makes "closing restores focus" release-blocking, with
   * no exception for how the close was triggered.
   *
   * Escape and the collapse button were already covered — which is exactly why the gap
   * survived four rounds of review and was found by driving the UI instead.
   */
  it('restores focus when the SCRIM dismisses the drawer (§3.6)', async () => {
    narrow()
    mount()
    const expand = await screen.findByRole('button', { name: 'Expand run rail' })
    expand.focus()
    fireEvent.click(expand)
    const nav = await screen.findByRole('navigation', { name: 'Runs' })

    // Put the keyboard INSIDE the drawer — the state the scrim used to strand.
    const row = (await within(nav).findByText('docs-sweep')).closest('button')!
    row.focus()
    expect(document.activeElement).toBe(row)

    const scrim = document.querySelector('.rail-scrim')!
    fireEvent.click(scrim)
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Runs' })).toBeNull())

    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('button', { name: 'Expand run rail' })))
    expect(document.activeElement).not.toBe(document.body)
  })

  it('restores focus when SELECTING a run closes the drawer (#42 × §3.6)', async () => {
    // The fourth close path. It unmounts the very row that was just activated, so it needs
    // the restore for the same reason — and it gets it because there is only one close.
    narrow()
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand run rail' }))
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    const row = (await within(nav).findByText('docs-sweep')).closest('button')!
    row.focus()
    fireEvent.click(row)

    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Runs' })).toBeNull())
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('button', { name: 'Expand run rail' })))
  })

  it('restores focus when the rail is collapsed by its own button', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse run rail' }))
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole('button', { name: 'Expand run rail' })))
    fireEvent.click(screen.getByRole('button', { name: 'Expand run rail' }))
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    await waitFor(() => expect(document.activeElement).toBe(nav.querySelector('.rail-head')))
  })
})

describe('keyboard navigation (§2.7, §3.6)', () => {
  it('is ONE tab stop with a roving selection, not a stop per run', async () => {
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    await within(nav).findByText('judge-panel-auth-refactor')
    const rows = [...nav.querySelectorAll<HTMLButtonElement>('.rrow')]
    expect(rows.length).toBe(RUNS_PAGE.runs.length)
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1)
    expect(rows[0]!.tabIndex).toBe(0)

    // Arrows move the selection AND the focus, because focus is already inside the rail.
    rows[0]!.focus()
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(rows[1]))
    expect(rows[1]!.tabIndex).toBe(0)
    expect(rows[0]!.tabIndex).toBe(-1)
    fireEvent.keyDown(rows[1]!, { key: 'End' })
    await waitFor(() => expect(document.activeElement).toBe(rows[rows.length - 1]))
    fireEvent.keyDown(rows[rows.length - 1]!, { key: 'Home' })
    await waitFor(() => expect(document.activeElement).toBe(rows[0]))
  })
})

describe('paging (§5.4.2 cursor contract)', () => {
  const many = Array.from({ length: 130 }, (_, i) => makeRun(i))

  it('reaches runs past the first page instead of truncating at 50', async () => {
    // The regression: the rail asked for one 50-run page forever, so run 51 was
    // unreachable from the cockpit and nothing on screen said so.
    const server = fakeListing(many)
    mount({ load: server.load })
    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    await within(nav).findByText('generated-run-0000')
    expect(nav.querySelectorAll('.rrow')).toHaveLength(50)
    expect(within(nav).getByText('50 of 130')).toBeTruthy()

    fireEvent.click(within(nav).getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(nav.querySelectorAll('.rrow')).toHaveLength(100))
    fireEvent.click(within(nav).getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(nav.querySelectorAll('.rrow')).toHaveLength(130))
    expect(within(nav).queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(within(nav).getByText('generated-run-0129')).toBeTruthy()
    expect(server.calls.every((c) => (c.limit ?? 50) <= 200)).toBe(true)
    expect(server.calls.some((c) => c.cursor)).toBe(true)
  })
})

describe('the API-unreachable state (#40)', () => {
  it('shows the same banner Home does, naming the command', async () => {
    mount({ load: () => Promise.reject(new ApiError(0, 'unreachable', 'gone')) })
    const banner = await screen.findByText('API unreachable.')
    expect(banner.closest('.banner')!.textContent).toContain('flowition viewer')
  })

  /**
   * Round 3's finding, and it was a fair one: the previous version of this test flipped a
   * mock to failure, waited 20 ms against a 5,000 ms cadence, and asserted the rows were
   * still there. No second request ever happened, so it proved only that React had not
   * spontaneously unmounted the list. The real question — what does the rail SAY once a
   * poll has actually failed under it — went untested, and the answer was "nothing", because
   * the note was gated on `loaded === 0`.
   *
   * So the cadence is now injectable and the second request is awaited and asserted.
   */
  it('polls again on its own cadence, and the second request is real', async () => {
    const load = vi.fn().mockResolvedValue(RUNS_PAGE)
    mount({ load, pollMs: 10 })
    await screen.findByText('docs-sweep')
    const after = load.mock.calls.length
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(after))
  })

  it('keeps the last good rows AND says they are stale when a later poll fails', async () => {
    let fail = false
    const load = vi.fn(() => (fail
      ? Promise.reject(new ApiError(0, 'unreachable', 'gone'))
      : Promise.resolve(RUNS_PAGE)))
    mount({ load, pollMs: 10 })
    await screen.findByText('docs-sweep')
    expect(screen.queryByText('API unreachable.')).toBeNull()

    const before = load.mock.calls.length
    fail = true
    // A SECOND request happens and rejects — that is the event under test.
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(before))

    // An operator watching a live run must not lose the rail because one poll missed…
    const note = await screen.findByText('API unreachable.')
    expect(screen.getByText('docs-sweep')).toBeTruthy()
    // …but the rows must not read as current either. Both facts, or the rail is lying.
    const banner = note.closest('.banner')!
    expect(banner.className).toContain('warn')
    expect(banner.textContent).toContain('last it returned')
    expect(banner.textContent).toContain('not updating')
  })

  it('recovers silently once a poll succeeds again', async () => {
    let fail = true
    const load = vi.fn(() => (fail
      ? Promise.reject(new ApiError(0, 'unreachable', 'gone'))
      : Promise.resolve(RUNS_PAGE)))
    mount({ load, pollMs: 10 })
    await screen.findByText('API unreachable.')
    fail = false
    await screen.findByText('docs-sweep')
    await waitFor(() => expect(screen.queryByText('API unreachable.')).toBeNull())
  })
})

/**
 * Round-4's MAJOR: the rail surfaced the LISTING's error and swallowed the PIN's.
 *
 * The pin is the second request behind #39 — the one that answers "where is the run the
 * route is about" when it lives past the pages the rail has pulled. Its two failure modes
 * had no UI at all:
 *
 *   • the first request fails → the rail is a list of runs the operator did not open, with
 *     no active marker anywhere and nothing saying why. That is precisely the state #39
 *     exists to prevent, arrived at silently;
 *   • a later poll fails → `usePoll` keeps the last good pin, so a row that is now a
 *     snapshot of a dead read sat among live rows looking exactly as current as they did.
 *
 * Both are exercised here the way the listing's are above: the failing request is real and
 * awaited, the cached row is checked for survival AND for being marked, and the way back is
 * pressed rather than assumed.
 */
describe('the pinned active run when ITS request fails (#39)', () => {
  const many = Array.from({ length: 60 }, (_, i) => makeRun(i))
  /** The deep-linked run: past the rail's first 50-row page, so it must be pinned. */
  const DEEP = 'r_gen0055'
  const DEEP_NAME = 'generated-run-0055'

  it('says the open run could not be loaded when the FIRST request fails', async () => {
    const server = fakeListing(many)
    const detail = vi.fn().mockRejectedValue(new ApiError(500, 'internal', 'snapshot read failed'))
    mount({ activeRunId: DEEP, load: server.load, loadDetail: detail })

    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    const banner = (await within(nav).findByText('The open run could not be loaded.'))
      .closest('.banner') as HTMLElement
    // The two things the operator cannot otherwise know: there is no row for their run,
    // and the reason is a failed request rather than an empty disk.
    expect(banner.textContent).toContain('no row here yet')
    expect(banner.textContent).toContain('snapshot read failed')
    // The rest of the rail is intact and honest: rows, no active marker, no pinned row.
    expect(nav.querySelectorAll('.rrow')).toHaveLength(50)
    expect(nav.querySelectorAll('.rrow[aria-current]')).toHaveLength(0)
    expect(nav.querySelectorAll('li.pinned')).toHaveLength(0)
    // The listing answered, so it is not implicated.
    expect(screen.queryByText('API unreachable.')).toBeNull()
  })

  it('is repaired by its own Retry — the listing is not re-asked', async () => {
    const server = fakeListing(many)
    let fail = true
    const detail = vi.fn(async (runId: string) => {
      if (fail) throw new ApiError(500, 'internal', 'snapshot read failed')
      return detailFor(runId, many)
    })
    // The production cadence: nothing polls within this test's window, so the recovery
    // below is the button's doing and cannot be a poll that happened to land.
    mount({ activeRunId: DEEP, load: server.load, loadDetail: detail })

    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    const banner = (await within(nav).findByText('The open run could not be loaded.'))
      .closest('.banner') as HTMLElement
    expect(detail).toHaveBeenCalledTimes(1)
    const listingCalls = server.calls.length

    fail = false
    fireEvent.click(within(banner).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2))

    // #39 restored: the run is pinned, marked, and the note is gone.
    const pinned = (await within(nav).findByText(DEEP_NAME)).closest('button')!
    expect(pinned.getAttribute('aria-current')).toBe('true')
    expect(pinned.closest('li')!.className).toContain('pinned')
    await waitFor(() =>
      expect(screen.queryByText('The open run could not be loaded.')).toBeNull())
    // The listing was answering all along; re-running it would be asking a question that
    // already has an answer.
    expect(server.calls).toHaveLength(listingCalls)
  })

  it('keeps a cached pin when a LATER poll fails, and marks it as not updating', async () => {
    const server = fakeListing(many)
    let fail = false
    const detail = vi.fn(async (runId: string) => {
      if (fail) throw new ApiError(0, 'unreachable', 'gone')
      return detailFor(runId, many)
    })
    mount({ activeRunId: DEEP, load: server.load, loadDetail: detail, pollMs: 10 })

    const nav = await screen.findByRole('navigation', { name: 'Runs' })
    await within(nav).findByText(DEEP_NAME)
    expect(screen.queryByText('The open run could not be loaded.')).toBeNull()

    const before = detail.mock.calls.length
    fail = true
    // A SECOND pin request happens and rejects — that is the event under test.
    await waitFor(() => expect(detail.mock.calls.length).toBeGreaterThan(before))

    const banner = (await within(nav).findByText('The open run could not be loaded.'))
      .closest('.banner') as HTMLElement
    expect(banner.className).toContain('warn')
    expect(banner.textContent).toContain('last thing this viewer read')
    expect(banner.textContent).toContain('not updating')
    // Losing the switcher over one failed poll would be worse than showing a stale row, so
    // the row stays — it is simply no longer claimed to be current.
    const pinned = within(nav).getByText(DEEP_NAME).closest('button')!
    expect(pinned.getAttribute('aria-current')).toBe('true')

    // …and it clears itself once a poll answers again, with no action from the operator.
    fail = false
    await waitFor(() =>
      expect(screen.queryByText('The open run could not be loaded.')).toBeNull())
    expect(within(nav).getByText(DEEP_NAME)).toBeTruthy()
  })

  it('does not add a second note when the LISTING is failing too', async () => {
    // One incident. `ApiDownNote` already states it in the stronger terms, and a rail with
    // two banners about one dead viewer is two alerts for one fact.
    const load = vi.fn().mockRejectedValue(new ApiError(0, 'unreachable', 'gone'))
    const detail = vi.fn().mockRejectedValue(new ApiError(0, 'unreachable', 'gone'))
    mount({ activeRunId: DEEP, load, loadDetail: detail, pollMs: 10 })

    await screen.findByText('API unreachable.')
    await new Promise((r) => setTimeout(r, 40))
    expect(screen.queryByText('The open run could not be loaded.')).toBeNull()
  })
})
