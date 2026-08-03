// @vitest-environment jsdom
//
// §12.1 item 5, as a test: "From the UI, within one session on a live mock run started with
// `--control`: answer an `ask()` (≤2 clicks from home), steer an agent and see the delivery
// verdict, cancel one agent, cancel the run via the confirm modal, resume it, delete a
// terminal run via type-to-confirm and find it in trash. On a read-only viewer: the same
// controls render locked with the explanation chip."
//
// Every step is driven the way the acceptance criterion asks — the two-click answer by
// clicks, the rest of the walkthrough by KEYBOARD ONLY (§2.7's shortcuts and Enter/⌘↵),
// through the real composition: `ControlProvider` + W11's cockpit + W10's transcript route.
//
// **What jsdom cannot do, stated rather than faked.** jsdom does not move focus on Tab and
// does not synthesize the click a browser generates for Enter/Space on a focused button. So
// `press()` below fires the keydown AND the activation the browser would produce, and the
// real Tab-order walk is W13's Playwright job (§16.5) — which is where a Tab that lands on
// an invisible element can actually be observed.

import {
  cleanup, fireEvent, render, screen, waitFor, within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlProvider, useControl } from './ControlProvider.js'
import { Cockpit } from '../cockpit/Cockpit.js'
import { Home } from '../home/Home.js'
import { TranscriptRoute } from '../transcript/Transcript.js'
import { IconSprite } from '../../ui/Icon.js'
import { LIVE_RUN, NOW, STALE_RUN, fixedApi } from '../cockpit/fixtures.js'
import { BLOCKED_DETAIL, RUNS_PAGE, SESSION } from '../home/fixtures.js'
import { resetRouteForTests } from '../../app/router.js'
import type { RunDetail } from '../../api/types.js'

const ALL = ['send', 'answer', 'cancel', 'resume', 'delete']

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.location.hash = '#/run/r_2f91c4a8'
  resetRouteForTests()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

/**
 * Keyboard activation. A browser turns Enter/Space on a focused button into a click; jsdom
 * does not, so both halves are fired here. The keydown is what the app's own handlers see;
 * the click is the browser's half of the contract.
 */
const press = (element: Element, key = 'Enter') => {
  fireEvent.keyDown(element, { key })
  if (key === 'Enter' || key === ' ') fireEvent.click(element)
}

const focused = () => document.activeElement as HTMLElement

const mutations = () => ({
  answer: vi.fn(async () => ({ ok: true })),
  send: vi.fn(async () => ({ delivery: 'queued' })),
  cancelAgent: vi.fn(async () => ({ scope: 'agent' as const, cancelled: 5 })),
  cancelRun: vi.fn(async () => ({ scope: 'run' as const, cancelled: 'run' })),
  resume: vi.fn(async () => ({ runId: STALE_RUN.runId, launchAccepted: true, mode: 'resume' as const, from: 'stale' as const })),
  remove: vi.fn(async () => ({
    ok: true, runId: 'r_2f91c4a8', trashEntry: 'r_2f91c4a8.1764000000000',
    trashedAt: NOW, trashTtlDays: 7,
  })),
  runs: vi.fn(async () => RUNS_PAGE),
  runDetail: vi.fn(async () => LIVE_RUN),
})

const mountCockpit = async (
  detail: RunDetail,
  {
    capabilities = ALL as string[] | null,
    capabilityError = undefined as string | undefined,
    calls = mutations(),
  } = {},
) => {
  render(
    <>
      <IconSprite />
      <ControlProvider
        capabilities={capabilities}
        {...(capabilityError ? { capabilityError } : {})}
        detail={detail}
        mutations={calls as never}
      >
        <Cockpit runId={detail.runId} capabilities={capabilities} storeApi={fixedApi(detail)} />
      </ControlProvider>
    </>,
  )
  await screen.findByRole('tablist')
  return calls
}

describe('§12.1 item 5 — answer an ask()', () => {
  // COMPOSITION, not end-to-end. This pins what the composer does with what it is handed —
  // the click count and the value that reaches `answerFn` — with the API stubbed. The
  // acceptance criterion itself ("≤2 clicks from Home to answered", on a live run) is
  // proven in `e2e.test.tsx`, against `<App/>`, a real viewer server and a real control
  // socket, with nothing injected: an injected `answerFn` cannot show that the request is
  // one the server accepts or that the screen reconciles to the answer (round-3 finding).
  it('is TWO CLICKS from Home: into the composer, then Send', async () => {
    // Typed with the real signature so the recorded VALUE is inspectable — the point of
    // the assertion below is that the composer sent what was typed, to this run's question.
    const answerFn = vi.fn(async (_runId: string, _qid: string, _value: unknown) => ({ ok: true }))
    window.location.hash = '#/'
    resetRouteForTests()
    render(
      <>
        <IconSprite />
        <Home
          loadRuns={async () => RUNS_PAGE}
          loadDetail={async () => BLOCKED_DETAIL}
          loadSession={async () => SESSION}
          answerFn={answerFn as never}
          virtualize={false}
        />
      </>,
    )
    const box = await screen.findByLabelText('Answer the question') as HTMLInputElement
    await waitFor(() => expect(box.disabled).toBe(false))

    let clicks = 0
    const click = (element: Element) => { clicks += 1; fireEvent.click(element) }

    click(box)                                       // click 1: into the composer
    fireEvent.change(box, { target: { value: 'keep the shim' } })
    const send = screen.getAllByRole('button', { name: /Send/ })[0]!
    click(send)                                      // click 2: Send

    await waitFor(() => expect(answerFn).toHaveBeenCalled())
    expect(clicks).toBe(2)
    expect(answerFn.mock.calls[0]![2]).toBe('keep the shim')
  })

  it('is ZERO clicks with the keyboard: `a`, type, ⌘↵ (§2.7)', async () => {
    const calls = await mountCockpit(LIVE_RUN)
    fireEvent.keyDown(window, { key: 'a' })
    expect(focused().className).toContain('ans-inp')
    fireEvent.change(focused(), { target: { value: 'rewrite both' } })
    fireEvent.keyDown(focused(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(calls.answer).toHaveBeenCalledWith(LIVE_RUN.runId, 'q_7f2a', 'rewrite both'))
    // Optimistic, and honest about what it does not yet know.
    expect(await screen.findByText(/answer sent/)).toBeTruthy()
  })
})

/**
 * §7.2's table is ONE table, and Home is a write surface. Both of Home's mutations are
 * asserted here against the shipped composition (`ControlProvider` wrapping `Home`, which is
 * what `app/App.tsx` mounts), because W12's layer being present in the tree is not the same
 * as Home actually routing through it (review round 1, B2).
 */
describe('§7.2 — Home’s write surfaces go through W12’s layer', () => {
  const mountHome = (
    over: Parameters<typeof Home>[0] = {},
    capabilities: string[] | null = ALL,
  ) => {
    window.location.hash = '#/'
    resetRouteForTests()
    const calls = mutations()
    render(
      <>
        <IconSprite />
        <ControlProvider capabilities={capabilities} mutations={calls as never}>
          <Home
            loadRuns={async () => RUNS_PAGE}
            loadDetail={async () => BLOCKED_DETAIL}
            loadSession={async () => SESSION}
            virtualize={false}
            {...over}
          />
        </ControlProvider>
      </>,
    )
    return calls
  }

  it('maps a 409 on answer to "another operator answered first" and refreshes', async () => {
    const answerFn = vi.fn(async () => {
      throw Object.assign(new Error('no pending question q_9d41'), { status: 409, code: 'conflict' })
    })
    mountHome({ answerFn: answerFn as never })
    const box = await screen.findByLabelText('Answer the question') as HTMLInputElement
    await waitFor(() => expect(box.disabled).toBe(false))
    fireEvent.change(box, { target: { value: 'keep the shim' } })
    fireEvent.click(screen.getAllByRole('button', { name: /Send/ })[0]!)

    // The shared §7.2 sentence — not a bare server string, and not "request failed".
    expect(await screen.findByText(/another operator answered first/)).toBeTruthy()
    // And the card settles into the 409 state rather than re-offering the same question.
    expect(await screen.findByText(/answered elsewhere/)).toBeTruthy()
  })

  /**
   * §7.3: "the confirmation modal … shows `graphDynamic` when set" — ON THE HOME PATH.
   *
   * Home has only a `RunSummary`, and `graphDynamic` is a `RunDetail` field. Round 1
   * therefore passed a hard `null`, which the modal reads as §6.5's "this run predates the
   * field": on a CURRENT run with a dynamic graph, the Home path stated something false
   * and omitted the preflight-refusal warning — the one sentence that tells the operator
   * this launch is likely to bounce. So the card reads the snapshot first, and the three
   * tri-state answers plus the read-failed case are all pinned through the shipped
   * composition (`ControlProvider` + `Home`), not by handing `ResumeDialog` a prop.
   */
  describe('Home’s Resume carries the real graphDynamic into §7.3’s modal (round 2, B1)', () => {
    const openResumeFromHome = async (runDetail: () => Promise<RunDetail>) => {
      const calls = mutations()
      calls.runDetail = vi.fn(runDetail) as never
      window.location.hash = '#/'
      resetRouteForTests()
      render(
        <>
          <IconSprite />
          <ControlProvider capabilities={ALL} mutations={calls as never}>
            <Home
              loadRuns={async () => RUNS_PAGE}
              loadDetail={async () => BLOCKED_DETAIL}
              loadSession={async () => SESSION}
              virtualize={false}
            />
          </ControlProvider>
        </>,
      )
      press((await screen.findAllByRole('button', { name: /^Resume$/ }))[0]!)
      return { dialog: await screen.findByRole('dialog'), calls }
    }
    /** The stale card on Home is `r_77b0e412` (RUNS_PAGE's `audit-viewer-security`). */
    const staleDetail = (over: Partial<RunDetail>): RunDetail => ({
      ...STALE_RUN, runId: 'r_77b0e412', ...over,
    } as RunDetail)

    it('true → the preflight-refusal warning (the omission that made this a blocker)', async () => {
      const { dialog, calls } = await openResumeFromHome(
        async () => staleDetail({ graphDynamic: true }),
      )
      expect(calls.runDetail).toHaveBeenCalledWith('r_77b0e412')
      expect(dialog.querySelector('[data-fact="graph-dynamic"]')).toBeTruthy()
      expect(dialog.textContent).toContain('refused by the preflight')
      expect(dialog.querySelector('[data-fact="graph-unknown"]')).toBeNull()
    })

    it('false → a statically verifiable graph, stated as such', async () => {
      const { dialog } = await openResumeFromHome(
        async () => staleDetail({ graphDynamic: false }),
      )
      expect(dialog.querySelector('[data-fact="graph-static"]')).toBeTruthy()
      expect(dialog.querySelector('[data-fact="graph-unknown"]')).toBeNull()
    })

    it('null on a REAL snapshot → §6.5’s old run, and only then', async () => {
      const { dialog } = await openResumeFromHome(
        async () => staleDetail({ graphDynamic: null }),
      )
      expect(dialog.querySelector('[data-fact="graph-unknown"]')).toBeTruthy()
      expect(dialog.textContent).toContain('journalled before the engine recorded')
    })

    it('a FAILED snapshot read is not an old run — it says the viewer could not look', async () => {
      const { dialog } = await openResumeFromHome(async () => {
        throw Object.assign(new Error('the viewer API did not answer'), { status: 0 })
      })
      // The distinction that matters: this must NOT borrow §6.5's sentence, because
      // nothing on disk was consulted and the run may well have a dynamic graph.
      expect(dialog.querySelector('[data-fact="graph-unreadable"]')).toBeTruthy()
      expect(dialog.querySelector('[data-fact="graph-unknown"]')).toBeNull()
      expect(dialog.textContent).toContain('could not read the run')
      // And the resume is still offered — the server, not this viewer, is the gate (§7.3).
      expect(within(dialog).getByRole('button', { name: /Resume run/ })).toBeTruthy()
    })
  })

  it('resumes a stale run through §7.3’s MODAL, not an inline arm', async () => {
    const calls = mountHome()
    const resume = (await screen.findAllByRole('button', { name: /^Resume$/ }))[0]!
    press(resume)

    // §7.2's resume row says "Modal per §7.3". One click, and a real dialog — the old inline
    // arm ("Resume <name>?" in place) is gone from the shipped path.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: /Resume/ })).toBeTruthy()
    expect(dialog.textContent).toContain('installed packages')
    expect(screen.queryByRole('button', { name: /Keep it stopped/ })).toBeNull()

    press(within(dialog).getByRole('button', { name: /Resume run/ }))
    await waitFor(() => expect(calls.resume).toHaveBeenCalled())
    expect((await screen.findAllByRole('status')).some(
      (node) => node.textContent?.includes('launch accepted, nothing more'),
    )).toBe(true)
  })

  /**
   * HOME FAILS CLOSED TOO — at the control, not at the toast (round 6, B1).
   *
   * The round-5 version of this test accepted an ENABLED Resume on Home followed by a
   * provider-layer refusal, on the reasoning that Home was another unit's file. That is
   * exactly what §7.2 forbids: an ungranted mutation is disabled with an explanation, never
   * offered and then declined. Home now reads the shell's normalized capability state
   * (`useControl()`), so `null` here — the probe has not succeeded — leaves both of Home's
   * write surfaces inert, whatever its own `loadSession` returned.
   *
   * `loadSession` DOES return a full grant below, which is the point: one capability state
   * per app, and it is the shell's.
   */
  it('leaves Home’s Answer and Resume inert while the session has granted nothing', async () => {
    const calls = mountHome({}, null)

    const box = await screen.findByLabelText('Answer the question') as HTMLInputElement
    // The question IS in hand — this is the capability gate, not a missing payload.
    await screen.findByText(/Two call sites in src\/cli\.js/)
    expect(box.disabled).toBe(true)
    expect(box.placeholder).toBe('checking permissions…')
    expect((screen.getAllByRole('button', { name: /Send/ })[0] as HTMLButtonElement).disabled)
      .toBe(true)

    const resume = (await screen.findAllByRole('button', { name: /^Resume$/ }))[0]! as HTMLButtonElement
    expect(resume.disabled).toBe(true)
    // Explained, not merely dead — and never as a read-only claim nobody has made.
    expect(document.querySelectorAll('.lock-chip.unknown.checking').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText(/this viewer is read-only/)).toBeNull()

    // And pressing them does nothing at all: no dialog, no snapshot read, no mutation.
    press(resume)
    fireEvent.change(box, { target: { value: 'keep the shim' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.resume).not.toHaveBeenCalled()
    expect(calls.answer).not.toHaveBeenCalled()
    expect(calls.runDetail).not.toHaveBeenCalled()
  })

  /**
   * The layer refuses even when a CALLER reaches past the rendered controls (round 5, B1).
   *
   * Home's own buttons can no longer ask (above), so the layer's gate is pinned directly:
   * any consumer calling `confirmResume` for an ungranted capability gets no modal, no
   * request, and a `role=status` sentence naming which check has not answered.
   */
  it('refuses to raise a lifecycle modal for an UNGRANTED capability, whoever asks', async () => {
    const calls = mutations()
    function Caller() {
      const control = useControl()!
      return (
        <button type="button" onClick={() => control.confirmResume({
          runId: STALE_RUN.runId, name: null, state: 'stale',
          graphDynamic: null, graphSource: 'snapshot',
        })}>
          ask the layer
        </button>
      )
    }
    render(
      <>
        <IconSprite />
        <ControlProvider capabilities={null} mutations={calls as never}>
          <Caller />
        </ControlProvider>
      </>,
    )
    press(screen.getByRole('button', { name: 'ask the layer' }))
    await waitFor(() => expect(
      screen.getAllByRole('status').some((n) => n.textContent?.includes('being checked')),
    ).toBe(true))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.resume).not.toHaveBeenCalled()
  })
})

describe('§12.1 item 5 — steer an agent and see the verdict', () => {
  it('sends from the transcript footer with ⌘↵ and shows the engine’s verdict', async () => {
    const calls = mutations()
    const running = LIVE_RUN.agents.find((agent) => agent.state === 'running')!
    render(
      <>
        <IconSprite />
        <ControlProvider capabilities={ALL} detail={LIVE_RUN} mutations={calls as never}>
          <TranscriptRoute
            runId={LIVE_RUN.runId}
            agentIndex={running.index}
            capabilities={ALL}
            dataApi={{
              runDetail: async () => LIVE_RUN,
              agentPage: async () => ({ items: [], start: 0, end: 0, size: 0, eof: true }),
              search: async () => ({ matches: [], truncated: false }),
            }}
          />
        </ControlProvider>
      </>,
    )
    const box = await screen.findByLabelText(/^Steer /) as HTMLInputElement
    expect(box.disabled).toBe(false)
    box.focus()
    fireEvent.change(box, { target: { value: 'check the SSE endpoint for token leakage' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(calls.send).toHaveBeenCalledWith(
      LIVE_RUN.runId, running.index, 'check the SSE endpoint for token leakage',
    ))
    // The verdict is the engine's own — `queued` here, with the sentence that explains it.
    const receipt = await screen.findByRole('status')
    expect(receipt.textContent).toContain('queued')
    expect(receipt.textContent).toContain('next turn')
  })

  it('cancels ONE agent through the inline arm, keyboard only', async () => {
    const calls = mutations()
    const running = LIVE_RUN.agents.find((agent) => agent.state === 'running')!
    render(
      <>
        <IconSprite />
        <ControlProvider capabilities={ALL} detail={LIVE_RUN} mutations={calls as never}>
          <TranscriptRoute
            runId={LIVE_RUN.runId} agentIndex={running.index} capabilities={ALL}
            dataApi={{
              runDetail: async () => LIVE_RUN,
              agentPage: async () => ({ items: [], start: 0, end: 0, size: 0, eof: true }),
              search: async () => ({ matches: [], truncated: false }),
            }}
          />
        </ControlProvider>
      </>,
    )
    const cancel = await screen.findByRole('button', { name: /Cancel agent/ })
    cancel.focus()
    press(cancel)
    expect(calls.cancelAgent).not.toHaveBeenCalled()   // armed, not fired
    // §7.2's confirmation, verbatim: the canonical index, on a labelled agent.
    const armed = screen.getByRole('button', { name: `Cancel agent ${running.index}?` })
    press(armed)
    await waitFor(() => expect(calls.cancelAgent).toHaveBeenCalledWith(LIVE_RUN.runId, running.index))
    expect(await screen.findByText(/cancel sent/)).toBeTruthy()
  })
})

describe('§12.1 item 5 — the lifecycle mutations, keyboard only', () => {
  it('cancels the RUN through the confirm modal (⌘K → Enter → Enter)', async () => {
    const calls = await mountCockpit(LIVE_RUN)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const search = screen.getByRole('combobox')
    fireEvent.change(search, { target: { value: 'cancel run' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    const dialog = await screen.findByRole('dialog')
    // §7.2: default focus is the SAFE action.
    expect(focused()).toBe(within(dialog).getByRole('button', { name: 'Keep running' }))
    // Escape is a real close path, and it must leave the run alone.
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(calls.cancelRun).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const again = screen.getByRole('combobox')
    fireEvent.change(again, { target: { value: 'cancel run' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    const confirm = await screen.findByRole('button', { name: /^Cancel run/ })
    press(confirm)
    await waitFor(() => expect(calls.cancelRun).toHaveBeenCalledWith(LIVE_RUN.runId))
    // The outcome outlives the modal, as a §3.6 status toast.
    expect((await screen.findAllByRole('status')).some(
      (node) => node.textContent?.includes('Cancel sent'),
    )).toBe(true)
  })

  it('resumes a stale run from the header, through §7.3’s modal', async () => {
    const calls = await mountCockpit(STALE_RUN)
    const resume = screen.getByRole('button', { name: /Resume/ })
    resume.focus()
    press(resume)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: /Resume/ })).toBeTruthy()
    // The integrity scope is stated before the operator commits (§7.3 / §1.3).
    expect(dialog.textContent).toContain('installed packages')
    press(within(dialog).getByRole('button', { name: /Resume run/ }))
    await waitFor(() => expect(calls.resume).toHaveBeenCalledWith(STALE_RUN.runId))
    expect((await screen.findAllByRole('status')).some(
      (node) => node.textContent?.includes('launch accepted, nothing more'),
    )).toBe(true)
  })

  /**
   * §7.3: "the confirmation modal … shows `graphDynamic` when set".
   *
   * Through the PRODUCTION path — the cockpit header's Resume, reading the field off the
   * snapshot the way the server now projects it (`src/viewer/snapshot.js`) — because a unit
   * test that hands `ResumeDialog` the prop directly proves the dialog can render it and
   * nothing at all about whether anything ever passes it (W12 review round 1, B6).
   */
  it('carries graphDynamic from the snapshot into §7.3’s modal, and warns', async () => {
    const dynamic: RunDetail = { ...STALE_RUN, graphDynamic: true }
    await mountCockpit(dynamic)
    press(screen.getByRole('button', { name: /Resume/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('[data-fact="graph-dynamic"]')).toBeTruthy()
    expect(dialog.textContent).toContain('graph was dynamic')
    // The warning is a PREDICTION about the engine's preflight, not a claim the viewer
    // enforces anything (§7.3: the integrity gate is the engine's).
    expect(dialog.textContent).toContain('refused by the preflight')
  })

  it('says "not recorded" for an OLD run rather than inventing a static graph (§6.5)', async () => {
    await mountCockpit({ ...STALE_RUN, graphDynamic: null } as RunDetail)
    press(screen.getByRole('button', { name: /Resume/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('journalled before the engine recorded')
    expect(dialog.querySelector('[data-fact="graph-unknown"]')).toBeTruthy()
    expect(dialog.querySelector('[data-fact="graph-dynamic"]')).toBeNull()
  })

  // The type-to-confirm gate and the trash toast, with no router outlet mounted — so
  // where focus ends up AFTER a successful delete is deliberately not this test's claim:
  // that path navigates the opener out of the document, and it is asserted against the
  // real router in `e2e.test.tsx` (round-3 finding).
  it('deletes a terminal run by typing its id, and says where it went', async () => {
    const completed: RunDetail = { ...LIVE_RUN, state: 'completed', endedAt: NOW, liveDetail: null }
    const calls = await mountCockpit(completed)
    const remove = screen.getByRole('button', { name: /Delete/ })
    remove.focus()
    press(remove)

    const dialog = await screen.findByRole('dialog')
    const confirmButton = within(dialog).getByRole('button', { name: /Delete run/ }) as HTMLButtonElement
    expect(focused()).toBe(within(dialog).getByLabelText(/Type/))
    expect(confirmButton.disabled).toBe(true)
    fireEvent.change(focused(), { target: { value: 'not the run id' } })
    expect(confirmButton.disabled).toBe(true)
    fireEvent.change(focused(), { target: { value: completed.runId } })
    expect(confirmButton.disabled).toBe(false)
    // Enter in the confirm field submits — the keyboard path an operator actually takes.
    fireEvent.submit(focused().closest('form')!)
    await waitFor(() => expect(calls.remove).toHaveBeenCalledWith(completed.runId))
    const toasts = await screen.findAllByRole('status')
    const trash = toasts.find((node) => node.textContent?.includes('trash'))!
    expect(trash.textContent).toContain('r_2f91c4a8.1764000000000')
    expect(trash.textContent).toContain('purged after 7 days')
  })
})

describe('§12.1 item 5 — the read-only viewer', () => {
  /**
   * The accessible description a screen reader computes for `el`: the text of every element
   * its `aria-describedby` names, in order (accname §5.2 — `aria-describedby` wins, and what
   * it yields is the referenced subtree's text, never the referent's `title`).
   *
   * Hand-computed because this suite has no jest-dom and §16.7 pins the dependency set; it is
   * eight lines and it is exactly the rule under test.
   */
  const accessibleDescription = (el: HTMLElement): string =>
    (el.getAttribute('aria-describedby') ?? '')
      .split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

  /**
   * §7.2's rendering of a control the session did not grant, as one assertion.
   *
   * The chip is the point (review round 5, B1) — and the chip's TEXT is the point of the
   * chip (round 6, B1). Round 5 accepted a chip reading "locked" whose explanation lived in
   * `title`: invisible until hover, absent on touch, and — because a `title` on the referent
   * never enters an `aria-describedby` computation — announced to a screen reader as the
   * single word "locked", on a button that is already inert. So the check is now: the control
   * is there, it is semantically disabled, a VISIBLE chip sits beside it, the chip's own
   * rendered text carries the flag that would unlock it, and the description the button
   * actually computes is that sentence.
   */
  const lockedControl = (button: HTMLElement, capability: string) => {
    expect(button.getAttribute('aria-disabled')).toBe('true')
    const chipId = button.getAttribute('aria-describedby')
    expect(chipId, `${button.textContent} names no lock chip`).toBeTruthy()
    const chip = document.getElementById(chipId!)
    expect(chip, `no chip #${chipId} in the document`).toBeTruthy()
    expect(chip!.className).toContain('lock-chip')
    expect(chip!.textContent).toContain('locked')
    // VISIBLE: the explanation is rendered text inside the chip, in the layout — not a
    // `title`, not `.vh`-hidden, and not on some other node.
    const why = chip!.querySelector('.lock-why')
    expect(why, `chip #${chipId} renders no visible explanation`).toBeTruthy()
    expect(why!.textContent).toContain(`--control=${capability}`)
    expect(why!.classList.contains('vh')).toBe(false)
    expect(chip!.classList.contains('vh')).toBe(false)
    expect(chip!.getAttribute('title')).toBeNull()
    // ANNOUNCED: what a screen reader reads for this button names the flag, not just "locked".
    const description = accessibleDescription(button)
    expect(description, `"${button.textContent}" is described as "${description}"`)
      .toContain(`flowition viewer --control=${capability}`)
    expect(description).toContain('locked')
    // …and beside it: same action row, adjacent node.
    expect(button.parentElement).toBe(chip!.parentElement)
    expect(button.nextElementSibling).toBe(chip)
  }

  it('renders every control LOCKED with its explanation — never hidden, never enabled', async () => {
    const calls = await mountCockpit(LIVE_RUN, { capabilities: [] })

    // Header lifecycle actions: present, disabled, EXPLAINED BY A VISIBLE CHIP, and inert.
    // A live run has no legal Delete either, which is a different refusal with a different
    // fix — so the title keeps the lifecycle reason while the chip carries the capability.
    const cancel = screen.getByRole('button', { name: /Cancel run/ })
    lockedControl(cancel, 'cancel')
    expect(cancel.getAttribute('title')).toMatch(/--control|not live|terminal|only for/)
    const remove = screen.getByRole('button', { name: /^Delete$/ })
    lockedControl(remove, 'delete')
    expect(remove.getAttribute('title')).toMatch(/only a terminal run can be deleted/)

    // Pressing them does nothing at all — no modal, no mutation. `aria-disabled` is an
    // announcement, not an enforcement, so the enforcement is asserted separately.
    fireEvent.click(cancel)
    fireEvent.click(remove)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.cancelRun).not.toHaveBeenCalled()
    expect(calls.remove).not.toHaveBeenCalled()

    // The answer composer: rendered, inert, and explained.
    const box = document.querySelector<HTMLInputElement>('.ans-inp')!
    expect(box.disabled).toBe(true)
    expect(box.placeholder).toBe('read-only viewer')
    expect(screen.getAllByText(/--control=answer/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('locked').length).toBeGreaterThan(0)

    // The palette's actions: listed, disabled, and explained rather than missing.
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const search = screen.getByRole('combobox')
    for (const [query, flag] of [['cancel run', '--control=cancel'], ['delete run', '--control=delete']]) {
      fireEvent.change(search, { target: { value: query } })
      const row = screen.getAllByRole('option')[0]!
      expect(row.getAttribute('aria-disabled')).toBe('true')
      expect(row.textContent).toContain(flag)
    }
  })

  /**
   * RESUME, on the runs where Resume is the whole point of the screen (round 5, B1).
   *
   * The read-only walk above only ever looked at a LIVE run, where Resume is disabled by
   * §7.3's state rule anyway — so it could not have seen a missing capability chip on the
   * one action an operator opens a dead run to take. Both resumable flavours are covered
   * because they take different branches: `stale` labels the button Resume, `completed` is
   * §7.3's cache replay and labels it Replay.
   */
  for (const [flavour, detail] of [
    ['a stale run', STALE_RUN],
    ['a completed run (§7.3’s Replay)', {
      ...LIVE_RUN, state: 'completed' as const, endedAt: NOW, liveDetail: null,
    }],
  ] as const) {
    it(`locks Resume on ${flavour} with the chip — visible, inert, never hidden`, async () => {
      const calls = await mountCockpit(detail as RunDetail, { capabilities: [] })
      const resume = screen.getByRole('button', { name: /Resume|Replay/ })
      lockedControl(resume, 'resume')
      // §7.3 says this state COULD be resumed, so the refusal on screen is the capability's
      // and the button must not blame the run's state for it.
      expect(resume.getAttribute('title')).not.toMatch(/enabled only for/)
      fireEvent.click(resume)
      press(resume)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(calls.resume).not.toHaveBeenCalled()
      // …and it is still a Resume, not a hidden one: the label survives the lock.
      expect(resume.textContent).toMatch(detail.state === 'completed' ? /Replay/ : /Resume/)
    })
  }

  it('chips vanish the moment the session grants the capability', async () => {
    // The other half of "never hidden, never enabled": a granted capability renders NO
    // chip, so the chip cannot become decoration the operator learns to ignore.
    await mountCockpit(LIVE_RUN, { capabilities: ALL })
    const cancel = screen.getByRole('button', { name: /Cancel run/ })
    expect(cancel.getAttribute('aria-disabled')).toBe('false')
    expect(cancel.getAttribute('aria-describedby')).toBeNull()
    expect(cancel.parentElement!.querySelectorAll('.lock-chip')).toHaveLength(0)
  })

  /**
   * The same walk on a viewer whose session probe has NOT SUCCEEDED — pending, then failed.
   *
   * §12.1 item 5's read-only clause is the acceptance criterion this covers from the other
   * side: a read-only viewer's controls are never enabled, and "the probe timed out" is
   * indistinguishable from read-only until it answers. So all five mutations are asserted
   * inert in both flavors, through the real composition rather than against the pure gate —
   * five controls in three components, each of which has its own `disabled` expression, and
   * round 4 had four of them wrong at once.
   *
   * What is NOT collapsed: neither flavor says "read-only" and neither offers `--control`
   * advice, because no one has claimed this viewer lacks the capability.
   */
  const steerRoute = (capabilities: string[] | null, capabilityError?: string) => {
    const running = LIVE_RUN.agents.find((agent) => agent.state === 'running')!
    render(
      <>
        <IconSprite />
        <ControlProvider
          capabilities={capabilities}
          {...(capabilityError ? { capabilityError } : {})}
          detail={LIVE_RUN}
          mutations={mutations() as never}
        >
          <TranscriptRoute
            runId={LIVE_RUN.runId} agentIndex={running.index} capabilities={capabilities}
            dataApi={{
              runDetail: async () => LIVE_RUN,
              agentPage: async () => ({ items: [], start: 0, end: 0, size: 0, eof: true }),
              search: async () => ({ matches: [], truncated: false }),
            }}
          />
        </ControlProvider>
      </>,
    )
  }

  for (const [flavor, capabilityError, word] of [
    ['the probe has NOT ANSWERED yet', undefined, 'checking'],
    ['the probe FAILED', 'the viewer API did not answer', 'unverified'],
  ] as const) {
    it(`fails CLOSED on all five mutations when ${flavor}`, async () => {
      await mountCockpit(LIVE_RUN, { capabilities: null, capabilityError })

      // ANSWER — the composer is present (never hidden) and inert.
      const box = document.querySelector<HTMLInputElement>('.ans-inp')!
      expect(box.disabled).toBe(true)
      expect(box.placeholder).toBe(
        capabilityError ? 'permissions unverified' : 'checking permissions…',
      )

      // CANCEL (run) and DELETE — W11's header, gated by the same session response, and
      // each carrying the chip in ITS state: `checking` / `unverified`, never `locked`,
      // because nobody has said this viewer lacks the capability.
      for (const name of [/Cancel run/, /Delete/]) {
        const button = screen.getByRole('button', { name })
        expect(button.getAttribute('aria-disabled')).toBe('true')
        const chip = document.getElementById(button.getAttribute('aria-describedby')!)
        expect(chip?.textContent).toContain(word)
        expect(chip?.textContent).not.toContain('locked')
        // The explanation is inside the chip and therefore in the button's computed
        // description — in THIS state too, where the sentence is about the check rather than
        // about a flag, and must not be mistaken for a read-only claim (round 6, B1).
        const description = accessibleDescription(button)
        expect(description).toContain(word)
        expect(description).toContain('disabled')
        expect(description).not.toContain('read-only')
      }

      // CANCEL (run), RESUME, DELETE, ANSWER — the palette, the one surface that can fire a
      // mutation from anywhere. Every row is listed, arrow-reachable and refused.
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
      const search = screen.getByRole('combobox')
      for (const query of ['answer the first', 'cancel run', 'resume run', 'delete run']) {
        fireEvent.change(search, { target: { value: query } })
        const row = screen.getAllByRole('option')[0]!
        expect(row.getAttribute('aria-disabled')).toBe('true')
        expect(row.textContent).toContain('disabled')
        expect(row.textContent).not.toContain('--control')
      }
      fireEvent.keyDown(window, { key: 'k', metaKey: true })

      // Nothing on the screen claims this viewer is read-only, and nothing tells the operator
      // to restart a CLI that may well have been started with `--control`.
      expect(screen.queryByText(/this viewer is read-only/)).toBeNull()
      expect(screen.queryByText('read-only')).toBeNull()
      expect(screen.getAllByText(word).length).toBeGreaterThan(0)
      cleanup()
      // The cockpit is really gone, so the chips asserted below belong to the transcript.
      expect(document.querySelectorAll('.ans-inp')).toHaveLength(0)
      expect(document.querySelectorAll('.lock-chip')).toHaveLength(0)

      // SEND and CANCEL (agent) — the transcript footer, in the same session state.
      steerRoute(null, capabilityError)
      const steer = await screen.findByLabelText(/^Steer /) as HTMLInputElement
      expect(steer.disabled).toBe(true)
      const footer = within(steer.closest('.steer') as HTMLElement)
      expect((footer.getByRole('button', { name: /^Send/ }) as HTMLButtonElement).disabled).toBe(true)
      expect(
        (footer.getByRole('button', { name: /Cancel agent/ }) as HTMLButtonElement).disabled,
      ).toBe(true)
      expect(screen.getAllByText(word).length).toBeGreaterThan(0)
      expect(screen.queryByText(/this viewer is read-only/)).toBeNull()
    })
  }

  it('enables the five only on a session response that GRANTS them', async () => {
    // The other half of the contract: fail-closed is not "permanently dead". A successful
    // response with all five named makes the same controls in the same composition live.
    await mountCockpit(LIVE_RUN, { capabilities: ALL })
    expect(document.querySelector<HTMLInputElement>('.ans-inp')!.disabled).toBe(false)
    expect(screen.getByRole('button', { name: /Cancel run/ }).getAttribute('aria-disabled'))
      .not.toBe('true')
    cleanup()
    steerRoute(ALL)
    const steer = await screen.findByLabelText(/^Steer /) as HTMLInputElement
    expect(steer.disabled).toBe(false)
    expect(
      (within(steer.closest('.steer') as HTMLElement)
        .getByRole('button', { name: /Cancel agent/ }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})
