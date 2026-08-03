// @vitest-environment jsdom
//
// The ⌘K command palette and the `?` overlay (§2.7), mounted through the real
// `ControlProvider` so the keyboard path, the data fetch and the dialog contract are all
// the shipped ones.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlProvider, useControl } from './ControlProvider.js'
import { answerFocusPending, cancelAnswerFocus } from './answerFocus.js'
import { SHORTCUTS } from './Palette.js'
import { Cockpit } from '../cockpit/Cockpit.js'
import { IconSprite } from '../../ui/Icon.js'
import { LIVE_RUN, NOW, fixedApi } from '../cockpit/fixtures.js'
import { RUNS_PAGE } from '../home/fixtures.js'
import { resetRouteForTests } from '../../app/router.js'
import type { RunDetail, RunSummary } from '../../api/types.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.location.hash = '#/run/r_2f91c4a8'
  resetRouteForTests()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // The answer-focus intent is module state by design (it has to outlive an unmount), so a
  // test that leaves one armed must not arm the next one's rail.
  cancelAnswerFocus()
})

const mount = (
  { detail = LIVE_RUN as RunDetail | null, capabilities = ['send', 'answer', 'cancel', 'resume', 'delete'] as string[] | null, runs = RUNS_PAGE, runsFails = false } = {},
) => {
  const runsFn = vi.fn(async () => {
    if (runsFails) throw Object.assign(new Error('the viewer API did not answer'), { status: 0 })
    return runs
  })
  render(
    <>
      <IconSprite />
      <ControlProvider
        capabilities={capabilities}
        detail={detail}
        mutations={{ runs: runsFn as never, runDetail: (async () => detail) as never }}
      >
        <button type="button">page content</button>
      </ControlProvider>
    </>,
  )
  return { runsFn }
}

const openPalette = () => {
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  return screen.getByRole('dialog')
}
const combobox = () => screen.getByRole('combobox') as HTMLInputElement
const options = () => screen.getAllByRole('option')
/**
 * The highlighted row, resolved the way ARIA says a VIRTUAL-FOCUS combobox expresses it:
 * `aria-activedescendant` on the input points at the option under the cursor, while
 * `aria-selected` stays reserved for actual selection (which a palette never has — running
 * an action is not selecting it). This is what React Aria's own combobox does, and W12
 * round 2 adopts its hooks rather than the hand-wired `aria-selected` highlight §16.3 says
 * not to write by hand.
 */
const activeOption = () => {
  const id = combobox().getAttribute('aria-activedescendant')
  return options().find((option) => option.id === id)!
}

describe('§2.7 command palette', () => {
  it('opens on ⌘K and closes on a second ⌘K', () => {
    mount()
    openPalette()
    expect(screen.getByRole('combobox')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens on Ctrl+K too, and from inside a text field (it carries a modifier)', () => {
    mount()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true })
    expect(screen.getByRole('combobox')).toBeTruthy()
    input.remove()
  })

  it('lists actions, this run’s agents and the runs it fetched on open', async () => {
    const { runsFn } = mount()
    openPalette()
    await waitFor(() => expect(runsFn).toHaveBeenCalled())
    const kinds = options().map((option) => within(option).getByText(/^(action|agent|run)$/).textContent)
    expect(new Set(kinds)).toEqual(new Set(['action', 'agent', 'run']))
  })

  it('filters by fuzzy name and re-homes the highlight on every keystroke', async () => {
    mount()
    openPalette()
    await waitFor(() => expect(options().length).toBeGreaterThan(3))
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' })
    expect(activeOption()).toBe(options()[1])
    fireEvent.change(combobox(), { target: { value: 'survey' } })
    expect(activeOption()).toBe(options()[0])
    expect(options().every((option) => /survey/i.test(option.textContent ?? ''))).toBe(true)
  })

  /**
   * The highlight must stay on the row the palette is PRESENTING as its proposal, and the
   * list is not static: `sweepRuns` walks §5.4.2's cursor, so rows arrive after the query
   * is typed and can rank ahead of what is highlighted.
   *
   * Round 3 re-homed only on a query change or an orphaned key, so an operator who typed a
   * run id saw the run appear at row 1 with the highlight still on row 2 — and `↵` ran row
   * 2. The §12.1 walkthrough caught it activating a DISABLED action that way, which does
   * nothing and looks exactly like a palette that swallowed the keystroke.
   */
  describe('the highlight follows the proposal when the list reorders (round 4)', () => {
    /** A listing that answers only when released — the async sweep, made observable. */
    const deferredRuns = () => {
      let release: (page: typeof RUNS_PAGE) => void = () => {}
      const runsFn = vi.fn(() => new Promise<typeof RUNS_PAGE>((resolve) => { release = resolve }))
      render(
        <>
          <IconSprite />
          <ControlProvider
            capabilities={['send', 'answer', 'cancel', 'resume', 'delete']}
            detail={LIVE_RUN}
            mutations={{ runs: runsFn as never, runDetail: (async () => LIVE_RUN) as never }}
          >
            <button type="button">page content</button>
          </ControlProvider>
        </>,
      )
      return { release: (page: typeof RUNS_PAGE) => release(page) }
    }

    /** One run whose name is a better match for the query than any action or agent. */
    const LATE_PAGE = {
      ...RUNS_PAGE,
      runs: [{ ...RUNS_PAGE.runs[0]!, runId: 'r_late', name: 'survey' }],
      nextCursor: null,
    }

    it('re-homes to a row that arrives ahead of an untouched highlight', async () => {
      const { release } = deferredRuns()
      openPalette()
      // Only the actions and this run's agents are in yet, so the highlight sits on the
      // best match among them.
      fireEvent.change(combobox(), { target: { value: 'survey' } })
      await waitFor(() => expect(options().length).toBeGreaterThan(0))
      const before = activeOption()
      expect(before).toBe(options()[0])

      release(LATE_PAGE)   // …and now the run NAMED `survey` lands and ranks first.
      await waitFor(() => expect(options()[0]).not.toBe(before))
      expect(options()[0]!.textContent).toContain('r_late')
      // THE assertion: what ↵ would run is what row 1 shows.
      expect(activeOption()).toBe(options()[0])
    })

    it('but leaves a highlight the OPERATOR placed exactly where they put it', async () => {
      const { release } = deferredRuns()
      openPalette()
      fireEvent.change(combobox(), { target: { value: 'survey' } })
      await waitFor(() => expect(options().length).toBeGreaterThan(1))
      fireEvent.keyDown(combobox(), { key: 'ArrowDown' })
      const chosen = activeOption()
      expect(chosen).not.toBe(options()[0])

      release(LATE_PAGE)
      await waitFor(() => expect(options()[0]?.textContent).toContain('r_late'))
      expect(activeOption()).toBe(chosen)
    })
  })

  it('is a combobox that owns its listbox through aria-activedescendant', async () => {
    mount()
    openPalette()
    await waitFor(() => expect(options().length).toBeGreaterThan(1))
    const listbox = screen.getByRole('listbox')
    expect(combobox().getAttribute('aria-controls')).toBe(listbox.id)
    expect(combobox().getAttribute('aria-activedescendant')).toBe(activeOption().id)
    fireEvent.keyDown(combobox(), { key: 'ArrowDown' })
    expect(combobox().getAttribute('aria-activedescendant')).toBe(activeOption().id)
    fireEvent.keyDown(combobox(), { key: 'End' })
    expect(activeOption()).toBe(options().at(-1))
    fireEvent.keyDown(combobox(), { key: 'Home' })
    expect(activeOption()).toBe(options()[0])
  })

  it('runs the highlighted action on Enter and closes', async () => {
    mount()
    openPalette()
    await waitFor(() => expect(options().length).toBeGreaterThan(1))
    fireEvent.change(combobox(), { target: { value: 'toggle theme' } })
    fireEvent.keyDown(combobox(), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.documentElement.dataset.theme).toBeTruthy()
  })

  it('opens the §7.3 delete modal from the palette (actions, not just navigation)', async () => {
    mount()
    openPalette()
    fireEvent.change(combobox(), { target: { value: 'delete run' } })
    fireEvent.keyDown(combobox(), { key: 'Enter' })
    // A live run cannot be deleted — the action says so rather than opening a modal that
    // could only 409.
    expect(screen.queryByRole('heading', { name: /Delete/ })).toBeNull()
    cleanup()
    mount({ detail: { ...LIVE_RUN, state: 'completed' } })
    openPalette()
    fireEvent.change(combobox(), { target: { value: 'delete run' } })
    fireEvent.keyDown(combobox(), { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: /Delete/ })).toBeTruthy()
  })

  it('shows LOCKED actions rather than hiding them (§7.2)', async () => {
    mount({ capabilities: [] })
    openPalette()
    fireEvent.change(combobox(), { target: { value: 'cancel run' } })
    const row = options()[0]!
    expect(row.textContent).toContain('Cancel run')
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('--control=cancel')
    fireEvent.keyDown(combobox(), { key: 'Enter' })
    // Activating a locked row does nothing at all — it does not even close the palette.
    expect(screen.getByRole('combobox')).toBeTruthy()
  })

  /**
   * §7.3's lifecycle eligibility, in the palette (round 2, B3).
   *
   * Round 1 gated ONLY on capability, so with every capability granted a state-forbidden
   * action rendered as an ordinary enabled row: Delete on a running run took Enter, closed
   * the palette, and did nothing — indistinguishable, from the operator's chair, from a
   * delete that worked. The two gates have different causes and different remedies, and
   * both now disable the row and say which one it is.
   */
  describe('run-state-forbidden actions are disabled too, not just capability-locked', () => {
    const findRow = (query: string): HTMLElement => {
      fireEvent.change(combobox(), { target: { value: query } })
      const row = options()[0]
      if (!row) throw new Error(`no palette row matched "${query}"`)
      return row
    }
    /** Activation must be refused BEFORE the close — a dialog that dismisses itself reads
     *  as "something happened". */
    const expectInert = (row: HTMLElement, why: RegExp) => {
      expect(row.getAttribute('aria-disabled')).toBe('true')
      expect(row.textContent).toMatch(why)
      fireEvent.keyDown(combobox(), { key: 'Enter' })
      expect(screen.getByRole('combobox')).toBeTruthy()
      expect(screen.queryByRole('heading', { name: /Delete|Cancel run|Resume|Replay/ })).toBeNull()
    }

    it('Delete on a LIVE run', () => {
      mount({ detail: { ...LIVE_RUN, state: 'running' } as RunDetail })
      openPalette()
      expectInert(findRow('delete run'), /a live run cannot be deleted/)
    })

    it('Cancel on a TERMINAL run', () => {
      mount({ detail: { ...LIVE_RUN, state: 'completed' } as RunDetail })
      openPalette()
      expectInert(findRow('cancel run'), /is not live/)
    })

    it('Resume on a run that is not resumable (§7.3’s set)', () => {
      // `running` is outside {completed, failed, interrupted, stale}: the server answers
      // 409, and the palette says so instead of arming a modal that could only fail.
      mount({ detail: { ...LIVE_RUN, state: 'running' } as RunDetail })
      openPalette()
      expectInert(findRow('resume run'), /a running run cannot be resumed/)
    })

    it('Answer when the run has NO open question', () => {
      mount({ detail: { ...LIVE_RUN, questions: [], openQuestions: 0 } as RunDetail })
      openPalette()
      const row = findRow('answer the first open question')
      expect(row.getAttribute('aria-disabled')).toBe('true')
      expect(row.textContent).toMatch(/no open question/)
      fireEvent.keyDown(combobox(), { key: 'Enter' })
      expect(screen.getByRole('combobox')).toBeTruthy()
    })

    it('…and an ELIGIBLE action is still enabled and still runs', async () => {
      mount({ detail: { ...LIVE_RUN, state: 'completed' } as RunDetail })
      openPalette()
      const row = findRow('delete run')
      expect(row.getAttribute('aria-disabled')).toBeNull()
      fireEvent.keyDown(combobox(), { key: 'Enter' })
      expect(await screen.findByRole('heading', { name: /Delete/ })).toBeTruthy()
    })
  })

  /**
   * §2.7 says "jump to ANY run", and §5.4.2 caps a page at 200 with an opaque keyset
   * cursor. Round 1 fetched one page and dropped `nextCursor`, so run 201 and everything
   * older than it was silently unreachable — the palette rendered "Nothing matches" for a
   * run that exists. The sweep now walks the cursor to exhaustion.
   */
  describe('the run list is paginated to exhaustion (§2.7 × §5.4.2)', () => {
    const paged = (pages: RunSummary[][]) => {
      const runsFn = vi.fn(async ({ cursor }: { cursor?: string | null } = {}) => {
        const index = cursor ? Number(cursor.replace('c', '')) : 0
        const runs = pages[index] ?? []
        return {
          runs,
          nextCursor: index + 1 < pages.length ? `c${index + 1}` : null,
          totalOnDisk: pages.reduce((n, page) => n + page.length, 0),
        }
      })
      render(
        <>
          <IconSprite />
          <ControlProvider
            capabilities={['send', 'answer', 'cancel', 'resume', 'delete']}
            detail={LIVE_RUN}
            mutations={{ runs: runsFn as never, runDetail: (async () => LIVE_RUN) as never }}
          >
            <button type="button">page content</button>
          </ControlProvider>
        </>,
      )
      return { runsFn }
    }
    const page = (from: number, count: number): RunSummary[] =>
      Array.from({ length: count }, (_unused, i) => ({
        ...RUNS_PAGE.runs[0]!,
        runId: `r_page${from + i}`,
        name: `sweep-${from + i}`,
      }))

    it('selects a run that only exists on page TWO', async () => {
      // Page one is full (200 rows, §5.4.2's ceiling); the run the operator wants is the
      // 201st. Round 1 could not reach it at all.
      const { runsFn } = paged([page(0, 200), page(200, 5)])
      openPalette()
      await waitFor(() => expect(runsFn).toHaveBeenCalledTimes(2))
      // The second call carried the cursor the first page handed back — keyset, not offset.
      expect(runsFn.mock.calls[0]![0]).toEqual({ limit: 200 })
      expect(runsFn.mock.calls[1]![0]).toEqual({ limit: 200, cursor: 'c1' })

      fireEvent.change(combobox(), { target: { value: 'sweep-203' } })
      await waitFor(() => expect(options().length).toBeGreaterThan(0))
      expect(options()[0]!.textContent).toContain('sweep-203')
      fireEvent.keyDown(combobox(), { key: 'Enter' })
      expect(window.location.hash).toContain('r_page203')
    })

    it('does not loop forever on a server that repeats its cursor', async () => {
      const runsFn = vi.fn(async () => ({
        runs: page(0, 2), nextCursor: 'stuck', totalOnDisk: 999,
      }))
      render(
        <>
          <IconSprite />
          <ControlProvider capabilities={[]} mutations={{ runs: runsFn as never }}>
            <button type="button">page content</button>
          </ControlProvider>
        </>,
      )
      openPalette()
      // Two calls: the first page, then the repeat that proves the cursor did not advance.
      await screen.findByText(/the run list is incomplete/)
      expect(runsFn).toHaveBeenCalledTimes(2)
      expect(options().length).toBeGreaterThan(0)
    })
  })

  it('stays useful when the run listing fails — it says the list is incomplete', async () => {
    mount({ runsFails: true })
    openPalette()
    await screen.findByText(/the run list is incomplete/)
    // Actions and this run's agents are still there.
    expect(options().length).toBeGreaterThan(1)
  })

  it('restores focus to what the operator was on when it closes (§3.6)', async () => {
    mount()
    const content = screen.getByRole('button', { name: 'page content' })
    content.focus()
    openPalette()
    expect(document.activeElement).toBe(combobox())
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(content)
  })

  /**
   * The palette's run-scoped actions CANCEL, RESUME and DELETE a run. Which run they mean is
   * therefore a safety property, not a rendering detail, and the two ways it can drift are
   * both tested here against the PRODUCTION shape of the provider (no `detail` prop — the
   * shell does not pass one, so the snapshot always comes from the fetch below).
   */
  describe('the palette is scoped to the route it was opened on (§7.2 — mutations)', () => {
    const mountRouted = (detailFor: (runId: string) => Promise<RunDetail>) => {
      const remove = vi.fn(async () => ({ trashEntry: 'x', trashTtlDays: 7 }))
      render(
        <>
          <IconSprite />
          <ControlProvider
            capabilities={['send', 'answer', 'cancel', 'resume', 'delete']}
            mutations={{
              runs: (async () => RUNS_PAGE) as never,
              runDetail: ((runId: string) => detailFor(runId)) as never,
              remove: remove as never,
            }}
          >
            <button type="button">page content</button>
          </ControlProvider>
        </>,
      )
      return { remove }
    }
    const goto = (hash: string) => { window.location.hash = hash; resetRouteForTests() }
    const closePalette = () => fireEvent.keyDown(window, { key: 'k', metaKey: true })

    it('offers NO run action on Home, even right after a run was open', async () => {
      goto('#/run/r_2f91c4a8')
      mountRouted(async () => ({ ...LIVE_RUN, state: 'completed' } as RunDetail))
      openPalette()
      await waitFor(() => expect(screen.getByRole('listbox').textContent).toContain('Delete run'))
      closePalette()

      goto('#/')
      openPalette()
      // Home is not about a run, so there is nothing here that could cancel, resume or
      // delete one. The previous run's actions must not survive the route change.
      await waitFor(() => expect(screen.getByRole('listbox').textContent).toContain('Toggle theme'))
      const list = screen.getByRole('listbox').textContent ?? ''
      expect(list).not.toContain('Delete run')
      expect(list).not.toContain('Cancel run')
      expect(list).not.toContain('Resume run')
    })

    it('never lets run A’s late snapshot arm an action on run B', async () => {
      // A's detail request hangs; B's answers at once. The operator moves on while A is
      // still in flight, and A lands afterwards.
      const pendingA: { resolve?: (detail: RunDetail) => void } = {}
      const { remove } = mountRouted((runId) => runId === 'r_a'
        ? new Promise<RunDetail>((resolve) => { pendingA.resolve = resolve })
        : Promise.resolve({ ...LIVE_RUN, runId: 'r_b', name: 'bee', state: 'completed' } as RunDetail))

      goto('#/run/r_a')
      openPalette()
      closePalette()

      goto('#/run/r_b')
      openPalette()
      await waitFor(() => expect(screen.getByRole('listbox').textContent).toContain('Delete run bee'))

      // …and NOW A answers. It is a stale response for a route nobody is on.
      pendingA.resolve?.({ ...LIVE_RUN, runId: 'r_a', name: 'ay', state: 'completed' } as RunDetail)
      await waitFor(() => expect(screen.getByRole('listbox').textContent).toContain('Delete run bee'))
      expect(screen.getByRole('listbox').textContent).not.toContain('Delete run ay')

      // The mutation itself is what matters: type-to-confirm B's id and check the server
      // was asked to delete B.
      fireEvent.change(combobox(), { target: { value: 'delete run bee' } })
      fireEvent.keyDown(combobox(), { key: 'Enter' })
      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByRole('heading').textContent).toContain('r_b')
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'r_b' } })
      fireEvent.click(within(dialog).getByRole('button', { name: /Delete run/ }))
      await waitFor(() => expect(remove).toHaveBeenCalledWith('r_b'))
    })
  })

  /**
   * §3.6: "opening a panel moves focus to its header; closing restores it" — across a CHAIN.
   * A palette action replaces the palette with a confirmation, so by the time the
   * confirmation closes, the node that "opened" it (the palette's combobox) is long gone.
   * All three close paths are named, because the scrim is the one that regressed before
   * (§16.5) and the button path is the one people actually use.
   */
  describe('focus returns to the PAGE after palette → confirmation (§3.6)', () => {
    const openConfirmationFromPalette = () => {
      mount({ detail: { ...LIVE_RUN, state: 'completed' } as RunDetail })
      const content = screen.getByRole('button', { name: 'page content' })
      content.focus()
      openPalette()
      fireEvent.change(combobox(), { target: { value: 'delete run' } })
      fireEvent.keyDown(combobox(), { key: 'Enter' })
      return content
    }

    it('Escape from the confirmation lands back on the page', async () => {
      const content = openConfirmationFromPalette()
      const dialog = await screen.findByRole('dialog')
      expect(screen.queryByRole('combobox')).toBeNull()
      fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.activeElement).toBe(content)
    })

    it('the SCRIM path lands back on the page (§16.5 — this is the one that regressed)', async () => {
      const content = openConfirmationFromPalette()
      await screen.findByRole('dialog')
      fireEvent.click(document.querySelector('[data-scrim="delete"]')!)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.activeElement).toBe(content)
    })

    it('the safe BUTTON path lands back on the page', async () => {
      const content = openConfirmationFromPalette()
      const dialog = await screen.findByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.activeElement).toBe(content)
    })
  })
})

/**
 * §2.7's palette action list names "answer" first, and until round 4 the enabled row could
 * not keep that promise (review round 3, B1). `Palette` closes the dialog and runs the
 * action synchronously, so the focus call landed inside a `FocusScope contain` that was
 * still mounted and was immediately taken back; and in the two layouts where the rail is
 * not expanded — the operator has collapsed it, or §3.7's narrow default has it as a closed
 * drawer — there was no composer in the document at all, so the fallback navigated to a run
 * that was already open and the palette closed onto nothing.
 *
 * `answerFocus.ts` replaces the focus call with a durable INTENT executed after the palette
 * unmounts, and these three tests are the three layouts it has to work in. They mount the
 * SHIPPED composition (`ControlProvider` + W11's cockpit, which is what supplies the rail),
 * because the defect was entirely in the seam between the two.
 */
describe('§2.7 — the palette’s enabled Answer action reaches a composer', () => {
  const media = (narrow: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrow && /max-width/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))

  const mountCockpit = async ({ narrow = false } = {}) => {
    media(narrow)
    window.location.hash = `#/run/${LIVE_RUN.runId}`
    resetRouteForTests()
    render(
      <>
        <IconSprite />
        <ControlProvider
          capabilities={['send', 'answer', 'cancel', 'resume', 'delete']}
          detail={LIVE_RUN}
          mutations={{ runs: (async () => RUNS_PAGE) as never, runDetail: (async () => LIVE_RUN) as never }}
        >
          <Cockpit runId={LIVE_RUN.runId} capabilities={['send', 'answer', 'cancel', 'resume', 'delete']} storeApi={fixedApi(LIVE_RUN)} />
        </ControlProvider>
      </>,
    )
    await screen.findByRole('tablist')
  }

  const composer = () => document.querySelector<HTMLInputElement>('.qitem .ans-inp')

  /** ⌘K, type, ↵ — the whole §2.7 path, with no pointer anywhere in it. */
  const runAnswerAction = () => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    fireEvent.change(combobox(), { target: { value: 'answer the first open question' } })
    const row = options()[0]!
    expect(row.getAttribute('aria-disabled')).toBeNull()   // enabled: this run HAS one open
    fireEvent.keyDown(combobox(), { key: 'Enter' })
  }

  /** The claim runs in the effect of the commit that unmounted the palette. */
  const expectComposerFocused = async () => {
    await waitFor(() => {
      const box = composer()
      expect(box).not.toBeNull()
      expect(document.activeElement).toBe(box)
    })
    expect(screen.queryByRole('combobox')).toBeNull()      // …and the palette is gone
  }

  it('with the inbox ALREADY OPEN: the composer takes focus, not the palette input', async () => {
    await mountCockpit()
    expect(composer()).not.toBeNull()
    runAnswerAction()
    await expectComposerFocused()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('with the inbox COLLAPSED: it opens the rail first, then focuses the composer', async () => {
    await mountCockpit()
    // The operator's own ruling — §3.7's collapse, taken through the rail's own control.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse inbox rail' }))
    await waitFor(() => expect(composer()).toBeNull())

    runAnswerAction()

    // The rail opened itself: a shortcut that focuses something invisible does nothing.
    await expectComposerFocused()
    expect(screen.getByRole('button', { name: 'Collapse inbox rail' })).toBeTruthy()
  })

  it('on a NARROW viewport (§3.7’s closed drawer): it opens the drawer and focuses it', async () => {
    await mountCockpit({ narrow: true })
    expect(composer()).toBeNull()                          // the rail is a 44px handle

    runAnswerAction()

    await expectComposerFocused()
    // The drawer is up, and it is the modal §3.6 requires — the composer inside it is where
    // the operator's keyboard now is.
    const drawer = screen.getByRole('dialog')
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    expect(drawer.contains(document.activeElement)).toBe(true)
  })

  it('leaves no armed intent behind when the palette is closed WITHOUT the action', async () => {
    await mountCockpit()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse inbox rail' }))
    await waitFor(() => expect(composer()).toBeNull())
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    // Escape asked for nothing, so nothing happens: the rail stays collapsed.
    expect(composer()).toBeNull()
    expect(answerFocusPending(LIVE_RUN.runId)).toBe(false)
  })
})

describe('§2.7 shortcut overlay', () => {
  it('opens on `?` and lists the shortcuts the app actually implements', () => {
    mount()
    fireEvent.keyDown(window, { key: '?' })
    expect(screen.getByRole('heading', { name: 'Keyboard' })).toBeTruthy()
    for (const [keys] of SHORTCUTS) expect(screen.getByText(keys)).toBeTruthy()
    // The list is §2.7's, in full: j/k, Enter, Esc, [ ], /, a, l, d, ?, ⌘K.
    const text = screen.getByRole('dialog').textContent ?? ''
    for (const key of ['j / k', '[ ]', '/', 'a', 'l', 'd', '?', '⌘K / ctrl K']) {
      expect(text).toContain(key)
    }
  })

  it('is ignored while typing, like every other bare shortcut (parity #111)', () => {
    mount()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: '?' })
    expect(screen.queryByRole('dialog')).toBeNull()
    input.remove()
  })
})

describe('the control context', () => {
  it('is null when no provider is mounted, so other units are untouched by W12', () => {
    let seen: unknown = 'unset'
    function Probe() { seen = useControl(); return null }
    render(<Probe />)
    expect(seen).toBeNull()
  })
})
