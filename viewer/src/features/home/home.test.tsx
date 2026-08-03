// @vitest-environment jsdom
//
// Home against the real W6 wire shapes (§2.3). §11.1's split is deliberate: the pure
// tests above cannot see composition bugs, and that failure mode is what the split
// guards against — a suite of pure tests passing while the screen is broken.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_STATES, Home } from './Home.js'
import {
  BLOCKED_DETAIL, READ_ONLY_SESSION, RUNS, RUNS_PAGE, SESSION, fakeListing, makeRun,
  oldStaleRun, twoQuestionRun,
} from './fixtures.js'
import { ApiError, type api } from '../../api/client.js'
import type { RunDetail } from '../../api/types.js'
import { resetRouteForTests } from '../../app/router.js'

// Typed with the real signature so a spy's recorded arguments are inspectable — the
// `state=blocked` assertion below depends on seeing what was actually sent.
const loadRuns: typeof api.runs = () => Promise.resolve(RUNS_PAGE)
const loadDetail = () => Promise.resolve(BLOCKED_DETAIL)
const loadSession = () => Promise.resolve(SESSION)

/** jsdom reports every element as 0×0, so the virtualizer would window to nothing. */
const mount = (props: Parameters<typeof Home>[0] = {}) =>
  render(<Home loadRuns={loadRuns} loadDetail={loadDetail} loadSession={loadSession} virtualize={false} {...props} />)

/**
 * Names appear TWICE on this screen — once in an attention card, once in the table — and
 * that is the design, so every table assertion scopes itself to the table.
 */
const table = () => screen.getByRole('list', { name: 'Runs' })
/** A §2.3 filter chip. Selected by its own element, not by a text match that also hits
 *  a run row whose state happens to share the word. */
const chip = (label: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('.fchip')]
    .find((el) => el.textContent?.startsWith(label))
  if (!found) throw new Error(`no filter chip "${label}"`)
  return found
}

const row = async (name: string): Promise<HTMLElement> => {
  // The table only exists once the first page settles; before that Home shows skeletons.
  const list = await screen.findByRole('list', { name: 'Runs' })
  const label = await within(list).findByText(name)
  return label.closest('.rt-row') as HTMLElement
}

beforeEach(() => {
  window.history.replaceState(null, '', '/#/')
  resetRouteForTests()
})
afterEach(cleanup)

describe('the run table (§2.3)', () => {
  it('renders one row per run with its status glyph and adapter cluster', async () => {
    mount()
    await row('judge-panel-auth-refactor')
    const list = screen.getByRole('list', { name: 'Runs' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(RUNS.length)
    // §3.6: state is text, not just color.
    expect(within(list).getAllByText('running').length).toBeGreaterThan(0)
    expect(within(list).getAllByText(/^adapter claude$/).length).toBeGreaterThan(0)
  })

  it('leaves a cost the journal never carried BLANK — never $0.00 (#53/#114)', async () => {
    mount()
    const noSpend = await row('hello.workflow.js')
    expect(noSpend.textContent).not.toContain('$')
    // Neither numeric cell renders a value; both are blank spans with an explanation.
    const numeric = [...noSpend.querySelectorAll('.n')]
    expect(numeric.filter((n) => n.className.includes('absent'))).toHaveLength(2)
    const titles = numeric.map((n) => n.getAttribute('title'))
    // Both journal-sourced numbers are absent for this run, and BOTH say so rather than
    // rendering a zero the engine never measured.
    expect(titles).toContain('no cost from the journal recorded for this run')
    expect(titles).toContain('no output tokens recorded for this run')
    // A run that DOES have a cost still shows it, so the blank is a real distinction.
    expect((await row('docs-sweep')).textContent).toContain('$1.11')
  })

  it('shows a run with no name as its run id, in mono', async () => {
    mount()
    await row('judge-panel-auth-refactor')
    const id = within(table()).getByText('flo_0f2d44b1')
    expect(id.className).toContain('mono')
  })

  it('renders a state a NEWER engine emits as the neutral mark, never a check (§6.5, #56)', async () => {
    mount()
    const future = await row('from-a-newer-engine')
    const mark = future.querySelector('.g')!
    expect(mark.className).toContain('g u')          // neutral, not .g d
    expect(mark.querySelector('use')!.getAttribute('href')).toBe('#i-unknown')
    expect(within(future).getByText('quarantined')).toBeTruthy()
  })

  it('renders the §2.3 badges', async () => {
    mount()
    await row('judge-panel-auth-refactor')
    const t = within(table())
    expect(t.getAllByText('detached log').length).toBeGreaterThan(0)
    expect(t.getByText('resumed ×2')).toBeTruthy()
    expect(t.getByText('6 cached')).toBeTruthy()
    expect(t.getAllByText('budget').length).toBeGreaterThan(0)
    expect(t.getByText('1 question')).toBeTruthy()
  })
})

describe('the attention strip (§2.3 / Q1)', () => {
  it('shows the blocked question text inline and an answer composer', async () => {
    mount()
    const card = (await screen.findByText(/Two call sites in src\/cli\.js/)).closest('.acard')!
    expect(card.className).toContain('ask')
    expect(within(card as HTMLElement).getByText(/qid q_9d41/)).toBeTruthy()
    expect(within(card as HTMLElement).getByLabelText('Answer the question')).toBeTruthy()
  })

  it('POSTs the answer and reports failure inline rather than silently', async () => {
    const answerFn = vi.fn().mockResolvedValue({})
    mount({ answerFn })
    const input = await screen.findByLabelText('Answer the question')
    fireEvent.change(input, { target: { value: 'rewrite both — no shim' } })
    // The composer is deliberately disabled while question detail loads (W8b B4 fix);
    // under parallel suite load the fetch can still be in flight here, and a click on
    // the disabled button no-ops. Wait for enablement — that IS the designed contract.
    await waitFor(() => expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(answerFn).toHaveBeenCalledWith('r_a03d51e7', 'q_9d41', 'rewrite both — no shim'))

    cleanup()
    const failing = vi.fn().mockRejectedValue(new ApiError(409, 'conflict', 'already answered'))
    mount({ answerFn: failing })
    const input2 = await screen.findByLabelText('Answer the question')
    fireEvent.change(input2, { target: { value: 'x' } })
    await waitFor(() => expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    // §7.2's answer row maps a 409 to "another operator answered first", not to a generic
    // failure — the SAME `failureCopy` sentence the cockpit's inbox composer renders (W12
    // review round 1, B2). The server's own words are still there, in front of it.
    await screen.findByText(/already answered — another operator answered first/)
  })

  /**
   * §7.2's answer row, in the window the previous revision could not represent at all
   * (review round 5, B2).
   *
   * The normative UX is "the question greys instantly, reconciles on the `answer` event" —
   * grey, and STILL THERE. Round 4 added the qid to the answered set before the POST
   * resolved, so on Send the question vanished (or the run's next question took its place)
   * under the words "answer sent", stating an outcome nothing had granted: a bridge that
   * takes its full 2 s (§7.2's mutation timeout) and then 503s left the operator looking at
   * a settled card for two seconds and then at a rolled-back one, and a 503 that the
   * operator never saw is an answer they believe they sent.
   *
   * A NEVER-RESOLVING request is the only way to observe that window deterministically, so
   * that is what this uses. Nothing here mocks the card's internals.
   */
  it('keeps the question visible and GREY while the answer is in flight (§7.2)', async () => {
    const answerFn = vi.fn(() => new Promise<never>(() => { /* never settles */ }))
    mount({ answerFn: answerFn as never })
    const input = await screen.findByLabelText('Answer the question') as HTMLInputElement
    // Text first: Send is disabled on an empty box by design, so enablement is only
    // observable once there is something to send (and once the capability probe answers).
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'rewrite both — no shim' } })
    await waitFor(() => expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(answerFn).toHaveBeenCalled())

    // STILL HERE, and identifiably the same question: the text, the qid, the card.
    const card = screen.getByText(/Two call sites in src\/cli\.js/).closest('.acard') as HTMLElement
    const qtext = card.querySelector('.qtext') as HTMLElement
    expect(qtext.textContent).toContain('qid q_9d41')
    // GREY: the pending presentation, not the answered one and not the untouched one.
    expect(qtext.className).toContain('sending')
    expect(qtext.getAttribute('data-answer')).toBe('pending')
    expect(qtext.textContent).toContain('sending your answer…')
    // And nothing claims acceptance yet — "answer sent" is what a resolved POST earns.
    expect(card.textContent).not.toContain('answer sent')
    expect(card.querySelector('[data-answer="sent"]')).toBeNull()
    // The composer is inert for the duration, so a second ⌘↵ cannot double-answer.
    expect(input.disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Sending/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(answerFn).toHaveBeenCalledTimes(1)
  })

  it('rolls the question back — text intact — when the send FAILS (§7.2)', async () => {
    // A 503 is retryable: §7.2 maps a bridge timeout to `run_not_live` with a
    // `retryAfterMs`, so the operator must get their question, their text and their button
    // back rather than a card that has already moved on.
    const answerFn = vi.fn().mockRejectedValue(new ApiError(503, 'run_not_live', 'run is not live'))
    mount({ answerFn })
    const input = await screen.findByLabelText('Answer the question') as HTMLInputElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'rewrite both — no shim' } })
    await waitFor(() => expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))

    await screen.findByText(/run is not live/)
    const card = screen.getByText(/Two call sites in src\/cli\.js/).closest('.acard') as HTMLElement
    const qtext = card.querySelector('.qtext') as HTMLElement
    expect(qtext.className).not.toContain('sending')
    expect(qtext.textContent).toContain('qid q_9d41')
    expect(input.value).toBe('rewrite both — no shim')
    expect(input.disabled).toBe(false)
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  /**
   * §7.2's answer row reconciles on the **`answer` event** — not on the POST's 200 (review
   * round 6, B2).
   *
   * The two are different claims about different systems. The 200 says the bridge delivered
   * one command to one socket (§7.2's bridge column); the event says the ENGINE accepted the
   * answer and journalled it, which is what makes the question answered for every later read
   * and what unblocks the run. Round 5 settled the card on the 200: the question left the
   * screen under the words "answer sent" while the very snapshot behind the card still
   * reported it unanswered — and if the engine then refused it (an ask() abandoned in the same
   * tick, a run aborting), the operator had been told an answer landed that nothing recorded.
   *
   * So: a server that ACCEPTS the answer and then does not move. The question must still be
   * there, greyed, saying what is true.
   */
  it('holds the accepted answer GREY until the run records it — the 200 settles nothing', async () => {
    // The default fixture's detail never changes: the listing keeps `openQuestions: 1` and the
    // snapshot keeps the question unanswered, which is exactly the window between a POST being
    // accepted and the engine journalling the answer.
    mount({ answerFn: vi.fn().mockResolvedValue({}) })
    const input = await screen.findByLabelText('Answer the question') as HTMLInputElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'rewrite both' } })
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))

    // ACCEPTED — and the question has NOT moved. Same card, same qid, same text, grey.
    await screen.findByText(/this question clears when the run records it/)
    const card = screen.getByText(/Two call sites in src\/cli\.js/).closest('.acard') as HTMLElement
    const qtext = card.querySelector('.qtext') as HTMLElement
    expect(qtext.className).toContain('sending')
    expect(qtext.getAttribute('data-answer')).toBe('accepted')
    expect(qtext.textContent).toContain('qid q_9d41')
    expect(qtext.textContent).toContain('answer sent, not recorded yet')
    // Nothing claims the run has it: no "recorded" copy, and the composer stays inert so a
    // second ⌘↵ cannot double-answer the qid the run has yet to close.
    expect(card.querySelector('[data-answer="sent"]')).toBeNull()
    expect(card.textContent).not.toContain('answer recorded')
    expect(input.disabled).toBe(true)

    // …and it stays that way. Polls keep arriving; none of them says the answer is recorded.
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    expect(screen.getByText(/qid q_9d41/)).toBeTruthy()
    expect(screen.getByText(/this question clears when the run records it/)).toBeTruthy()
  })

  it('settles ONLY when the snapshot reports the qid answered (§7.2 reconciliation)', async () => {
    // The ordering the contract is about, forced rather than raced: the POST resolves FIRST
    // and the refreshed snapshot is held open, so the two events cannot arrive together. The
    // answer's own invalidation (Home's `onAnswered`) is what asks for that snapshot; this
    // test simply holds it in flight until it has looked at the card.
    const held: ((detail: RunDetail) => void)[] = []
    let reads = 0
    const loadDetail = () => {
      reads += 1
      return reads === 1
        ? Promise.resolve(BLOCKED_DETAIL)
        : new Promise<RunDetail>((resolve) => { held.push(resolve) })
    }
    // The engine's side of the `answer` event, as the next read sees it.
    const recorded: RunDetail = {
      ...BLOCKED_DETAIL,
      questions: (BLOCKED_DETAIL.questions ?? []).map((q) => ({
        ...q, answered: true, answer: 'rewrite both',
      })),
    }
    mount({ loadDetail, answerFn: vi.fn().mockResolvedValue({}) })
    const input = await screen.findByLabelText('Answer the question') as HTMLInputElement
    await waitFor(() => expect(input.disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'rewrite both' } })
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))

    // POST resolved; nothing has told this card the run recorded anything, so the question is
    // exactly where the operator left it.
    await screen.findByText(/this question clears when the run records it/)
    expect(screen.getByText(/qid q_9d41/)).toBeTruthy()
    await waitFor(() => expect(held.length).toBeGreaterThan(0))

    // THE EVENT — the run's own `answer` record, arriving as the refreshed RunDetail. That,
    // and nothing before it, clears the question.
    await act(async () => {
      for (const resolve of held) resolve(recorded)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByText(/qid q_9d41/)).toBeNull())
    const card = document.querySelector('.acard.ask') as HTMLElement
    expect(card.querySelector('[data-answer="sent"]')).toBeTruthy()
    expect(card.textContent).toContain('answer recorded')
    expect(card.textContent).not.toContain('not recorded yet')
  })

  it('survives a RunDetail with no `questions` at all (§6.5 — nothing throws)', async () => {
    // A payload from a different engine, or one truncated in transit, must degrade to the
    // card's loading copy rather than taking the whole screen down. Found by the App-level
    // composition test, which is exactly the class of bug §11.1's jsdom split exists for.
    mount({ loadDetail: () => Promise.resolve({} as never) })
    await row('judge-panel-auth-refactor')
    expect(screen.getByText(/loading the question/)).toBeTruthy()
    expect(screen.getByText(/1 unanswered question/)).toBeTruthy()
    expect((screen.getByLabelText('Answer the question') as HTMLInputElement).disabled).toBe(true)
  })

  it('disables answering on a read-only viewer, and says why (§7.2)', async () => {
    mount({ loadSession: () => Promise.resolve(READ_ONLY_SESSION) })
    const input = await screen.findByLabelText('Answer the question')
    expect((input as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/--control=answer/)).toBeTruthy()
  })

  it('offers Resume on a stale run and explains that the engine died', async () => {
    mount()
    const card = (await screen.findByText(/Engine died/)).closest('.acard')!
    expect(card.className).toContain('stale')
    expect(card.textContent).toContain('run.lock held by pid 48812 — not running')
    expect(card.textContent).toMatch(/4 render/)          // orphaned, not spinning
    expect(within(card as HTMLElement).getByRole('button', { name: /Resume/ })).toBeTruthy()
  })

  /**
   * MAJOR 3, and it was a FIXTURE lying before it was a UI bug.
   *
   * `endedAt` is written from a terminal run event and from nothing else (§6.2,
   * src/viewer/summaries.js:115-118). A run is `stale` precisely because the engine
   * vanished WITHOUT writing one, so the normal stale run the API serves has
   * `endedAt: null` — and the stale fixture used to hand the card a terminal timestamp it
   * would never get from the real server. Under that flattery the card's
   * `run.endedAt ?? run.startedAt` never took its second branch, and nothing on this
   * screen could see that the branch reported the run's AGE as its time of death.
   */
  describe('a stale run has no time of death (§6.2 × §2.3)', () => {
    /** Home's clock is the real `Date.now()` when nothing is live, so the fixture uses it. */
    const threeDaysAgo = () => Date.now() - 3 * 86_400_000
    const onlyStale = (run: ReturnType<typeof oldStaleRun>): typeof loadRuns =>
      async ({ state } = {}) => ({
        runs: !state || state.split(',').includes('stale') ? [run] : [],
        nextCursor: null,
        totalOnDisk: 1,
      })

    it('never dates the death from startedAt, however old the run is', async () => {
      const run = oldStaleRun(threeDaysAgo())
      expect(run.endedAt, 'the fixture must match the wire contract').toBeNull()
      mount({ loadRuns: onlyStale(run) })

      const card = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement
      // The old copy on this exact run: "Engine died 3d ago." It died at an unknown moment
      // inside those three days, and the viewer has nothing on disk that narrows it.
      expect(card.textContent).not.toMatch(/Engine died \d/)
      expect(card.textContent).toContain('no time of death')
      // What it DOES know is stated, and labelled as what it is.
      expect(card.textContent).toContain('the run started 3d ago')
      expect(card.textContent).toContain('started 3d ago')
      // The server's own verdict is the closest thing to evidence, so it stays.
      expect(card.textContent).toContain('run.lock held by pid 3312 — not running')
    })

    it('does not invent a runtime that keeps growing', async () => {
      const run = oldStaleRun(threeDaysAgo())
      mount({ loadRuns: onlyStale(run) })
      const card = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement
      // `elapsed(startedAt, null, now)` is a measurement of a run that is STILL GOING. On a
      // dead run it is a fabricated number, and it ticked upward once a second.
      expect(card.textContent).not.toMatch(/ran \d/)
      expect(card.textContent).not.toMatch(/\d+m\d+s/)
      // The cost the journal did carry is still shown — this is about absent numbers, not
      // about hiding real ones.
      expect(card.textContent).toContain('$0.31')
    })

    it('leaves the table\'s duration cell BLANK for it, never a growing age (#53/#114)', async () => {
      const run = oldStaleRun(threeDaysAgo())
      mount({ loadRuns: onlyStale(run) })
      const row = (await within(await screen.findByRole('list', { name: 'Runs' }))
        .findByText('nightly-doc-sweep')).closest('.rt-row') as HTMLElement
      const absent = [...row.querySelectorAll('.n.absent')].map((n) => n.getAttribute('title'))
      expect(absent).toContain('no duration recorded for this run')
    })

    it('still states a death time when the run DID write a terminal event', async () => {
      // The other branch has to keep working: `endedAt` is the one thing that can date it.
      const ended = Date.now() - 2 * 3_600_000
      const run = { ...oldStaleRun(threeDaysAgo()), endedAt: ended }
      mount({ loadRuns: onlyStale(run) })
      const card = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement
      expect(card.textContent).toContain('Engine died 2h ago')
      expect(card.textContent).not.toContain('no time of death')
      expect(card.textContent).toMatch(/ran \d/)
    })
  })

  it('POSTs the §7.3 resume for that exact run, and re-polls once it is accepted', async () => {
    // The regression this pins: Resume used to be a link to the run route in a Resume
    // button's clothing. An enabled control that does not perform its control is worse
    // than a disabled one, because the operator believes the run is coming back.
    const resumeFn = vi.fn().mockResolvedValue({
      runId: 'r_77b0e412', launchAccepted: true, mode: 'resume', from: 'stale',
    })
    const loadSpy = vi.fn(loadRuns)
    mount({ resumeFn, loadRuns: loadSpy })
    const card = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement

    // A lifecycle mutation arms before it fires — one stray click cannot spawn a process.
    fireEvent.click(within(card).getByRole('button', { name: /^Resume$/ }))
    expect(resumeFn).not.toHaveBeenCalled()
    expect(card.textContent).toContain('Completed agents replay from the journal')

    const polls = loadSpy.mock.calls.length
    fireEvent.click(within(card).getByRole('button', { name: /Resume audit-viewer-security\?/ }))
    await waitFor(() => expect(resumeFn).toHaveBeenCalledTimes(1))
    // The exact request: this run's id, and nothing else — §7.3 takes no parameters.
    expect(resumeFn).toHaveBeenCalledWith('r_77b0e412')

    // §7.3: `launchAccepted` is launch accepted and NOTHING MORE, so the card says that
    // rather than claiming the run is running…
    await screen.findByText(/Resume launched/)
    expect(card.textContent).not.toMatch(/running again|resumed successfully/)
    // …and the listing — the thing that can actually prove it — is re-polled at once,
    // instead of waiting out the stale scan's 10s interval.
    await waitFor(() => expect(loadSpy.mock.calls.length).toBeGreaterThan(polls))
  })

  it('shows a refused resume inline — a 409 is never swallowed (§7.3)', async () => {
    const resumeFn = vi.fn().mockRejectedValue(
      new ApiError(409, 'conflict', 'run r_77b0e412 has no journal meta record — there is nothing to resume'),
    )
    mount({ resumeFn })
    const card = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /^Resume$/ }))
    fireEvent.click(within(card).getByRole('button', { name: /Resume audit-viewer-security\?/ }))

    const alert = await within(card).findByRole('alert')
    expect(alert.textContent).toContain('there is nothing to resume')
    expect(alert.className).toContain('bad')
    // It disarms rather than latching, so the operator can retry after fixing the cause.
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: /^Resume$/ })).toBeTruthy())
  })

  it('disables Resume on a read-only viewer, and names the flag (§7.2)', async () => {
    const resumeFn = vi.fn()
    mount({ loadSession: () => Promise.resolve(READ_ONLY_SESSION), resumeFn })
    const card = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement
    const button = within(card).getByRole('button', { name: /^Resume$/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(card.textContent).toContain('--control=resume')
    fireEvent.click(button)
    expect(resumeFn).not.toHaveBeenCalled()
  })

  it('shows a live spend ticker plotting OUTPUT tokens against the soft ceiling', async () => {
    mount()
    const card = (await screen.findByText('110.3%')).closest('.acard')!
    expect(card.className).toContain('live')
    expect(card.textContent).toContain('$9.05')
    expect(card.textContent).toContain('375k out')
    expect(card.textContent).toContain('of the 340k soft ceiling')
    // critique M19: the gauge is output tokens vs budgetTotal. Cost and INPUT tokens are
    // separate figures and must not appear as the gauge's subject.
    expect(card.textContent).not.toContain('1.2M')
    // §2.4: over a pre-admission advisory ceiling reads "over budget", never "blocked".
    expect(within(card as HTMLElement).getByText('over budget')).toBeTruthy()
    expect(card.querySelector('.gauge-bar .over')).not.toBeNull()
    const fill = card.querySelector<HTMLElement>('.gauge-bar .fill')!
    // Track scaled to 110.3%: the fill stops at the ceiling (90.66%), not at 100%.
    expect(parseFloat(fill.style.width)).toBeCloseTo(90.66, 1)
  })

  it('is absent entirely when nothing needs the operator', async () => {
    mount({
      loadRuns: () => Promise.resolve({
        runs: RUNS.filter((r) => r.state === 'completed'), nextCursor: null, totalOnDisk: 3,
      }),
    })
    await row('docs-sweep')
    expect(screen.queryByText('Needs you')).toBeNull()
  })
})

describe('loading, error and empty states (§2.3, parity #40)', () => {
  it('shows skeleton rows before the first page settles', async () => {
    // Home issues several queries (the table, the active scan, the stale scan); the
    // skeleton is gated on the TABLE's first settle, so every pending promise is held and
    // then released together.
    const pending: ((v: typeof RUNS_PAGE) => void)[] = []
    mount({ loadRuns: () => new Promise((r) => { pending.push(r) }) })
    expect(screen.getByTestId('home-skeleton')).toBeTruthy()
    expect(screen.getByText('Loading runs…')).toBeTruthy()
    await act(async () => {
      for (const release of pending) release(RUNS_PAGE)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByTestId('home-skeleton')).toBeNull())
  })

  it('names the command when the API is unreachable, and offers Retry (#40)', async () => {
    const failing = vi.fn().mockRejectedValue(new ApiError(0, 'unreachable', 'gone'))
    mount({ loadRuns: failing })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('API unreachable')
    expect(alert.textContent).toContain('flowition viewer')
    // It does not blame the network; it names the process and the idle shutdown.
    expect(alert.textContent).toContain('30 minutes idle')
    const calls = failing.mock.calls.length
    fireEvent.click(within(alert).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(failing.mock.calls.length).toBeGreaterThan(calls))
  })

  /**
   * The attention strip is fed by two scans the table knows nothing about (ACTIVE_STATES
   * and `stale`). Round 3's finding: a failure of either was INVISIBLE — the strip renders
   * what it has, so a failed active scan produced an empty "Needs you" that is pixel-for-
   * pixel the calm-queue state. These tests fail exactly one scan at a time.
   */
  describe('a failing auxiliary scan (§2.3 — the queue may not lie)', () => {
    /** Rejects the queries whose `state` matches; everything else answers normally. */
    const failScan = (match: (state: string | null | undefined) => boolean) => {
      const calls: (string | null | undefined)[] = []
      const load: typeof loadRuns = ({ state } = {}) => {
        calls.push(state)
        return match(state)
          ? Promise.reject(new ApiError(0, 'unreachable', 'scan failed'))
          : Promise.resolve(RUNS_PAGE)
      }
      return { load, calls }
    }

    it('says the queue is incomplete when the ACTIVE scan alone fails', async () => {
      // Blocked and running cards come from this scan; stale does not.
      const server = failScan((s) => s === ACTIVE_STATES)
      mount({ loadRuns: server.load })
      await row('judge-panel-auth-refactor')

      const note = await screen.findByRole('alert')
      expect(note.textContent).toContain('This queue is incomplete')
      expect(note.textContent).toContain('blocked')
      expect(note.textContent).toContain('running')
      // The scan that DID answer is not implicated…
      expect(note.textContent).not.toContain('stale runs failed')
      // …and its cards still render, so a partial failure degrades rather than blanks.
      expect(within(screen.getByRole('region', { name: 'Needs you' }))
        .getByText('audit-viewer-security')).toBeTruthy()
      // The count is a floor, never an exact total, while a scan is missing.
      expect(document.querySelector('.attn-head .count')!.textContent).toMatch(/\+$/)
      // The table is unaffected — this is a partial screen, not a broken one.
      expect(within(table()).getAllByRole('listitem').length).toBe(RUNS.length)
    })

    it('says so when the STALE scan alone fails, naming only stale', async () => {
      const server = failScan((s) => s === 'stale')
      mount({ loadRuns: server.load })
      await row('judge-panel-auth-refactor')

      const note = await screen.findByRole('alert')
      expect(note.textContent).toContain('This queue is incomplete')
      expect(note.textContent).toContain('stale')
      expect(note.textContent).not.toContain('blocked')
      // The blocked card from the healthy active scan is still there.
      expect(within(screen.getByRole('region', { name: 'Needs you' }))
        .getByText('migrate-callsites')).toBeTruthy()
    })

    it('never shows an empty queue as a calm one when its scan failed', async () => {
      // Both scans down, the table up: the strip has NOTHING to show, and that is exactly
      // the case that used to render as "nothing needs you" — i.e. as good news.
      const server = failScan((s) => s === ACTIVE_STATES || s === 'stale')
      mount({ loadRuns: server.load })
      await row('judge-panel-auth-refactor')

      const note = await screen.findByRole('alert')
      expect(screen.getByRole('region', { name: 'Needs you' })).toBeTruthy()
      expect(note.textContent).toContain('that is a failed scan, not an empty queue')
      expect(document.querySelectorAll('.acard')).toHaveLength(0)
    })

    it('retries EVERY query the screen depends on, not just the table', async () => {
      const server = failScan((s) => s === 'stale')
      mount({ loadRuns: server.load })
      await row('judge-panel-auth-refactor')
      const note = await screen.findByRole('alert')

      const before = {
        list: server.calls.filter((s) => s == null).length,
        active: server.calls.filter((s) => s === ACTIVE_STATES).length,
        stale: server.calls.filter((s) => s === 'stale').length,
      }
      fireEvent.click(within(note).getByRole('button', { name: /Retry/ }))
      await waitFor(() => {
        expect(server.calls.filter((s) => s == null).length).toBeGreaterThan(before.list)
        expect(server.calls.filter((s) => s === ACTIVE_STATES).length).toBeGreaterThan(before.active)
        expect(server.calls.filter((s) => s === 'stale').length).toBeGreaterThan(before.stale)
      })
    })
  })

  /**
   * Round-4's two findings, and they are ONE defect at two sites: the screen depends on
   * four requests, and two of them — the §7.2 capability probe and the per-run RunDetail —
   * had no error state at all. A single transient failure of either produced a screen that
   * looked healthy and was not:
   *
   *   • `/api/session` failing collapsed into `capabilities: []`, which reads as "this
   *     viewer may do nothing". Answer and Resume were disabled, the copy blamed a flag the
   *     operator had actually passed, and Retry — which reloaded only the three run queries
   *     — could not undo it. §2.3's live inline answer and stale resume were both gone.
   *   • a failed RunDetail left the card on "loading the question…" behind a dead composer
   *     for the life of the tab: nothing about (runId, openQuestions) moves when a request
   *     fails, so neither the 2 s summary poll nor a listing reload reruns it.
   *
   * So each of these is exercised the same way the scans above are: fail once, prove the
   * screen SAYS so and still offers what the server has not refused, then retry and prove
   * it comes back.
   */
  describe('a failing auxiliary REQUEST (§9.3 — loading, error and data, each explicit)', () => {
    /** The capability banner's own headline — the cards repeat its words in their hints. */
    const CAPABILITY_BANNER = "This viewer's permissions are unknown."

    /** A promise the test settles by hand, so "in flight" is an assertable state. */
    const deferred = <T,>() => {
      let settle!: (v: T) => void
      let fail!: (e: unknown) => void
      const promise = new Promise<T>((res, rej) => { settle = res; fail = rej })
      return { promise, settle, fail }
    }

    describe('the §7.2 capability probe', () => {
      const probeFailed = new ApiError(500, 'internal', 'session read failed')

      /**
       * A FAILED probe grants nothing — and §7.2's gate fails closed (round 6, B1).
       *
       * The round-4 version of this test asserted the opposite: it accepted an enabled
       * composer and an enabled Resume on the argument that the server holds the real gate.
       * That is true of the server and false of this UI's job. `--control` exists so a
       * viewer cannot drive a full-permission agent process until the operator opts in
       * (§7.2, §7.4); a permission check that never answered must therefore deny.
       *
       * What round 4 got right is kept whole, and it is the whole difference between this
       * test and the read-only one above: NOTHING here says read-only, and nothing tells
       * the operator to restart a CLI they may well have started with `--control`.
       */
      it('disables both mutations on a failed probe — without claiming read-only', async () => {
        const session = vi.fn().mockRejectedValue(probeFailed)
        mount({ loadSession: session })

        // The failure is NAMED — this is the state that used to be entirely silent.
        const banner = (await screen.findByText(CAPABILITY_BANNER)).closest('.banner')!
        expect(banner.textContent).toContain('/api/session')
        expect(banner.textContent).toContain('session read failed')
        // …and it states the consequence, rather than promising controls that do not work.
        expect(banner.textContent).toContain('has not been granted any mutation')
        expect(banner.textContent).toContain('disabled until the check succeeds')

        // ANSWER — present (never hidden), inert, and saying WHICH kind of disabled it is.
        const input = await screen.findByLabelText('Answer the question') as HTMLInputElement
        expect(input.disabled).toBe(true)
        expect(input.placeholder).toBe('permissions unverified')
        expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled)
          .toBe(true)

        // RESUME — the same, on the stale card.
        const stale = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement
        expect((within(stale).getByRole('button', { name: /^Resume$/ }) as HTMLButtonElement)
          .disabled).toBe(true)

        // The read-only copy is a claim about what the server SAID. Nothing said it.
        expect(screen.queryByText(/--control=answer/)).toBeNull()
        expect(screen.queryByText(/--control=resume/)).toBeNull()
        expect(screen.queryByText(/this viewer is read-only/)).toBeNull()
        // Both cards carry the shared "unverified" chip and the sentence behind it.
        expect(document.querySelectorAll('.lock-chip.unknown.unverified').length)
          .toBeGreaterThanOrEqual(2)
        expect(document.body.textContent).toContain('the permission check failed')
      })

      /** The other direction: a grant makes the same controls live (round 6, B1). */
      it('enables both the moment a session response GRANTS them', async () => {
        const session = vi.fn()
          .mockRejectedValueOnce(probeFailed)
          .mockResolvedValue(SESSION)
        mount({ loadSession: session })
        const banner = (await screen.findByText(CAPABILITY_BANNER)).closest('.banner')!
        const input = screen.getByLabelText('Answer the question') as HTMLInputElement
        expect(input.disabled).toBe(true)

        fireEvent.click(within(banner as HTMLElement).getByRole('button', { name: /Retry/ }))

        await waitFor(() => expect(
          (screen.getByLabelText('Answer the question') as HTMLInputElement).disabled,
        ).toBe(false))
        const stale = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement
        expect((within(stale).getByRole('button', { name: /^Resume$/ }) as HTMLButtonElement)
          .disabled).toBe(false)
        expect(document.querySelectorAll('.lock-chip')).toHaveLength(0)
      })

      it('is re-probed by Retry, and the screen recovers', async () => {
        const session = vi.fn()
          .mockRejectedValueOnce(probeFailed)
          .mockResolvedValue(SESSION)
        mount({ loadSession: session })
        const banner = (await screen.findByText(CAPABILITY_BANNER)).closest('.banner')!
        expect(session).toHaveBeenCalledTimes(1)

        // The probe is a ONE-SHOT (§7.2 capabilities change on a viewer restart, not on a
        // 2 s cadence), so nothing re-runs it on its own. That is precisely why Retry has
        // to reach it: it is the only path back.
        await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
        expect(session).toHaveBeenCalledTimes(1)

        fireEvent.click(within(banner as HTMLElement).getByRole('button', { name: /Retry/ }))
        await waitFor(() => expect(session).toHaveBeenCalledTimes(2))
        await waitFor(() => expect(screen.queryByText(/permissions are unknown/)).toBeNull())
        // Recovered into the KNOWN-permitted state, not merely into "no banner".
        expect(screen.getByText(/⌘↵ sends/)).toBeTruthy()
        expect(screen.getByText(/\/home\/ben\/projects\/flowition\/\.flowition/)).toBeTruthy()
      })

      it('holds the controls shut while the probe is still in flight, and says so', async () => {
        // Pending is also "unknown", so it is also inert — but it is not an ERROR, and the
        // screen must not invent a failure banner nor a read-only claim for a probe that is
        // simply still going. The chip says "checking", which is the true difference.
        mount({ loadSession: () => new Promise<never>(() => {}) })
        // Wait for the QUESTION, not just the composer: an input with no question in hand
        // is disabled for a reason that has nothing to do with capabilities.
        await screen.findByText(/Two call sites in src\/cli\.js/)
        const input = screen.getByLabelText('Answer the question') as HTMLInputElement
        expect(input.disabled).toBe(true)
        expect(input.placeholder).toBe('checking permissions…')
        expect(screen.getAllByText('checking').length).toBeGreaterThan(0)
        expect(screen.queryByText(/permissions are unknown/)).toBeNull()
        expect(screen.queryByText(/this viewer is read-only/)).toBeNull()
        expect(screen.queryByText(/--control=/)).toBeNull()
      })

      it('does not add a second alert when the whole API is down', async () => {
        // One incident, one banner: the unreachable state already explains every failing
        // request on the screen, and the session probe is one of them.
        mount({
          loadRuns: () => Promise.reject(new ApiError(0, 'unreachable', 'gone')),
          loadSession: () => Promise.reject(new ApiError(0, 'unreachable', 'gone')),
        })
        const alert = await screen.findByRole('alert')
        expect(alert.textContent).toContain('API unreachable')
        expect(screen.getAllByRole('alert')).toHaveLength(1)
        expect(screen.queryByText(/permissions are unknown/)).toBeNull()
      })
    })

    describe('the per-run RunDetail behind a blocked card', () => {
      const detailFailed = new ApiError(500, 'internal', 'snapshot read failed')

      it('surfaces the failure, retries on demand, and recovers', async () => {
        const held = deferred<typeof BLOCKED_DETAIL>()
        const detail = vi.fn(async (_runId: string) => BLOCKED_DETAIL)
        detail.mockRejectedValueOnce(detailFailed)
        detail.mockImplementationOnce(() => held.promise)
        mount({ loadDetail: detail })

        // FAIL ONCE. The card says what happened and to which run, and does not pretend to
        // still be loading something nothing is fetching.
        const card = (await screen.findByText('the question could not be loaded'))
          .closest('.acard') as HTMLElement
        expect(card.textContent).toContain('snapshot read failed')
        expect(card.textContent).toContain('still blocked on 1 question')
        expect(card.textContent).toContain('it is the question TEXT that is missing')
        expect(within(card).queryByText(/loading the question/)).toBeNull()
        expect((within(card).getByLabelText('Answer the question') as HTMLInputElement).disabled)
          .toBe(true)

        // Nothing reruns it on its own — the identity (runId, openQuestions) has not moved,
        // which is the whole reason this state needed an affordance rather than a spinner.
        await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
        expect(detail).toHaveBeenCalledTimes(1)
        expect(screen.getByText('the question could not be loaded')).toBeTruthy()

        // RETRY. The request is re-made, and the card reports the attempt rather than
        // silently reverting to the first-load copy.
        fireEvent.click(within(card).getByRole('button', { name: /Retry the question/ }))
        await waitFor(() => expect(detail).toHaveBeenCalledTimes(2))
        const retrying = within(card).getByRole('button', { name: /Retrying/ }) as HTMLButtonElement
        expect(retrying.disabled).toBe(true)

        // RECOVER. §2.3's inline question is back, with a live composer and no residue.
        await act(async () => { held.settle(BLOCKED_DETAIL); await held.promise })
        await within(card).findByText(/Two call sites in src\/cli\.js/)
        expect(within(card).queryByText('the question could not be loaded')).toBeNull()
        expect(within(card).queryByRole('button', { name: /Retry the question/ })).toBeNull()
        expect((within(card).getByLabelText('Answer the question') as HTMLInputElement).disabled)
          .toBe(false)
      })

      it('keeps a question already in hand when a later fetch fails, and says it is stale', async () => {
        // The quieter half. A refresh failing over a question the card ALREADY has must not
        // throw the question away — the operator can still answer it — but the card may not
        // present a possibly-superseded question as freshly read either.
        const detail = vi.fn(async (_runId: string) => BLOCKED_DETAIL)
        // The capability banner's Retry is what re-runs the detail fetch, so the probe has
        // to fail once to produce it — and SUCCEED on that retry, or the composer this test
        // is about would be inert for a reason (§7.2's fail-closed gate) that has nothing to
        // do with the question it is asserting.
        const session = vi.fn().mockRejectedValueOnce(detailFailed).mockResolvedValue(SESSION)
        mount({ loadDetail: detail, loadSession: session })
        await screen.findByText(/Two call sites in src\/cli\.js/)

        detail.mockRejectedValue(detailFailed)
        const banner = (await screen.findByText(CAPABILITY_BANNER)).closest('.banner')!
        fireEvent.click(within(banner as HTMLElement).getByRole('button', { name: /Retry/ }))
        await waitFor(() => expect(detail).toHaveBeenCalledTimes(2))

        const card = (await screen.findByText(/Two call sites in src\/cli\.js/))
          .closest('.acard') as HTMLElement
        expect(card.textContent).toContain('the question above is the last one this viewer loaded')
        expect(card.textContent).toContain('snapshot read failed')
        // The composer stays usable — the question is still open and still answerable.
        const input = within(card).getByLabelText('Answer the question') as HTMLInputElement
        expect(input.disabled).toBe(false)
      })

      it('is re-requested by the screen-level Retry, not only by the card\'s own', async () => {
        // The round-4 rule: EVERY dependency a control renders from is behind the Retry the
        // operator is told to press. Here the failing scan is what puts a Retry on screen,
        // and the detail request — a different query entirely — must ride along.
        const load: typeof loadRuns = ({ state } = {}) => (state === 'stale'
          ? Promise.reject(new ApiError(0, 'unreachable', 'scan failed'))
          : Promise.resolve(RUNS_PAGE))
        const detail = vi.fn(async (_runId: string) => BLOCKED_DETAIL)
        detail.mockRejectedValueOnce(detailFailed)
        mount({ loadRuns: load, loadDetail: detail })

        await screen.findByText('the question could not be loaded')
        const note = (await screen.findByText('This queue is incomplete.')).closest('.banner')!
        fireEvent.click(within(note as HTMLElement).getByRole('button', { name: /Retry/ }))

        await screen.findByText(/Two call sites in src\/cli\.js/)
        expect(screen.queryByText('the question could not be loaded')).toBeNull()
      })
    })
  })

  it('offers the quick-start snippet when there are zero runs (weakness #30)', async () => {
    mount({ loadRuns: () => Promise.resolve({ runs: [], nextCursor: null, totalOnDisk: 0 }) })
    await screen.findByText('No runs yet')
    expect(screen.getByText('flowition run hello.workflow.js')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy()
  })

  // Round-4 finding, at the composition level where the operator would see it: `usePoll`
  // kept its last-good rows across a change of REQUEST IDENTITY, so a newly selected chip
  // rendered the previous query's rows beneath it — indistinguishable from a real answer —
  // and if the new request then failed, they stayed there behind the banner indefinitely.
  describe('changing the filter (§9.3 request identity)', () => {
    /** Answers the unfiltered listing and the strip's scans; `state=failed` is held open. */
    const heldFailedFilter = () => {
      const held: { resolve: (v: typeof RUNS_PAGE) => void; reject: (e: unknown) => void }[] = []
      const load: typeof loadRuns = ({ state } = {}) => {
        if (state === 'failed') {
          return new Promise((resolve, reject) => { held.push({ resolve, reject }) })
        }
        return Promise.resolve(RUNS_PAGE)
      }
      return { load, held }
    }

    it('shows the skeleton, not the previous chip\'s rows, while the new query is pending', async () => {
      const server = heldFailedFilter()
      mount({ loadRuns: server.load })
      await row('judge-panel-auth-refactor')

      fireEvent.click(chip('failed'))
      // Synchronously with the click: the table is gone, the skeleton is back. No row of
      // the old question survives one frame under the new one.
      expect(screen.queryByRole('list', { name: 'Runs' })).toBeNull()
      expect(screen.getByTestId('home-skeleton')).toBeTruthy()
      await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
      expect(screen.queryByRole('list', { name: 'Runs' })).toBeNull()

      // …and the rows that DO arrive are the answer to the new question.
      await act(async () => {
        for (const gate of server.held) gate.resolve({ runs: [], nextCursor: null, totalOnDisk: 6 })
      })
      await waitFor(() => expect(screen.queryByTestId('home-skeleton')).toBeNull())
      // Zero `failed` runs, so this is the empty-FILTER state — not six running rows, and
      // not "No runs yet" either (there ARE runs on disk; none match).
      expect(screen.getByText('No runs match')).toBeTruthy()
      expect(screen.queryByRole('list', { name: 'Runs' })).toBeNull()
    })

    it('shows the unreachable banner over NOTHING when the new query fails', async () => {
      const server = heldFailedFilter()
      mount({ loadRuns: server.load })
      await row('judge-panel-auth-refactor')

      fireEvent.click(chip('failed'))
      await act(async () => {
        for (const gate of server.held) gate.reject(new ApiError(0, 'unreachable', 'gone'))
      })

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('API unreachable')
      // The keep-last-good path is for refreshes of the SAME question. These rows answered
      // a different one and must not sit under the `failed` chip, banner or no banner —
      // not now, and not for the rest of the session. (The attention strip above is a
      // different, unfiltered query and legitimately keeps showing what needs the operator.)
      expect(screen.queryByRole('list', { name: 'Runs' })).toBeNull()
      await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
      expect(screen.queryByRole('list', { name: 'Runs' })).toBeNull()
    })
  })

  it('distinguishes "no runs on disk" from "nothing matches this filter"', async () => {
    mount()
    await row('judge-panel-auth-refactor')
    fireEvent.change(screen.getByLabelText('Filter by name or run id'), {
      target: { value: 'nothing-matches-this' },
    })
    // The filter is server-side; the client-side blocked chip is what this exercises.
    fireEvent.click(chip('blocked'))
    await waitFor(() => expect(screen.queryByText('No runs yet')).toBeNull())
  })
})

describe('filters and keyboard (§2.3, §2.7)', () => {
  it('filters `blocked` client-side, because it is not a RunState', async () => {
    const spy = vi.fn(loadRuns)
    mount({ loadRuns: spy })
    await row('judge-panel-auth-refactor')
    fireEvent.click(chip('blocked'))
    await waitFor(() => expect(within(table()).queryByText('judge-panel-auth-refactor')).toBeNull())
    expect(within(table()).getByText('migrate-callsites')).toBeTruthy()
    // …and it never sends `state=blocked`, which §5.4.2 would reject with a 400.
    for (const call of spy.mock.calls) {
      expect(call[0]?.state ?? null).not.toBe('blocked')
    }
  })

  it('sends a real RunState filter to the server', async () => {
    const spy = vi.fn(loadRuns)
    mount({ loadRuns: spy })
    await row('judge-panel-auth-refactor')
    fireEvent.click(chip('failed'))
    await waitFor(() => {
      expect(spy.mock.calls.some((c) => c[0]?.state === 'failed')).toBe(true)
    })
  })

  it('starts with a VALID roving selection — the table is Tab-reachable (§3.6)', async () => {
    // Regression: the cursor used to start at -1, which left every row at tabIndex=-1 and
    // the whole list unreachable by Tab until a shortcut had been pressed. A roving
    // tabindex means one stop, always present — not zero stops.
    mount()
    await row('judge-panel-auth-refactor')
    const rows = within(table()).getAllByRole('button')
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1)
    expect(rows[0]!.tabIndex).toBe(0)
    rows[0]!.focus()
    expect(document.activeElement).toBe(rows[0])
  })

  it('moves the cursor with j/k, jumps with Home/End, and opens with Enter', async () => {
    mount()
    await row('judge-panel-auth-refactor')
    fireEvent.keyDown(window, { key: 'j' })      // from row 0 to row 1
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(window.location.hash).toBe('#/run/r_a03d51e7')

    fireEvent.keyDown(window, { key: 'k' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(window.location.hash).toBe('#/run/r_2f91c4a8')

    fireEvent.keyDown(window, { key: 'End' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(window.location.hash).toBe(`#/run/${RUNS[RUNS.length - 1]!.runId}`)
    fireEvent.keyDown(window, { key: 'Home' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(window.location.hash).toBe('#/run/r_2f91c4a8')
  })

  it('focuses the search field on `/` and the answer box on `a`', async () => {
    mount()
    await row('judge-panel-auth-refactor')
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(screen.getByLabelText('Filter by name or run id'))
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(window, { key: 'a' })
    expect(document.activeElement).toBe(screen.getByLabelText('Answer the question'))
  })

  it('ignores shortcuts while typing (parity #111)', async () => {
    mount()
    const search = await screen.findByLabelText('Filter by name or run id')
    search.focus()
    fireEvent.keyDown(search, { key: 'j' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(window.location.hash).toBe('#/')
  })
})

describe('the §5.4.2 cursor contract', () => {
  /** 240 runs — more than the API's 200-run page ceiling, which is the whole point. */
  const many = Array.from({ length: 240 }, (_, i) => makeRun(i, {
    state: i % 10 === 3 ? 'failed' : 'completed',
  }))

  it('pages with nextCursor and NEVER by growing limit past the 200 ceiling', async () => {
    const server = fakeListing(many)
    mount({ loadRuns: server.load })
    await row('generated-run-0000')
    expect(within(table()).getAllByRole('listitem')).toHaveLength(50)

    // Three "Load more" clicks walk the keyset; a limit-growing client would 400 here.
    for (const expected of [100, 150, 200]) {
      fireEvent.click(screen.getByRole('button', { name: /Load more/ }))
      await waitFor(() =>
        expect(within(table()).getAllByRole('listitem')).toHaveLength(expected))
    }
    // Past 200 rows — unreachable at all with a single-request client.
    fireEvent.click(screen.getByRole('button', { name: /Load more/ }))
    await waitFor(() => expect(within(table()).getAllByRole('listitem')).toHaveLength(240))
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull()

    // Every request stayed legal, and the deep pages were reached by cursor.
    expect(server.calls.every((c) => (c.limit ?? 50) <= 200)).toBe(true)
    expect(server.calls.some((c) => c.cursor)).toBe(true)
    // Rows are not duplicated when the same page is re-walked by the 2s poll.
    const names = within(table()).getAllByRole('listitem').map((li) => li.textContent)
    expect(new Set(names).size).toBe(names.length)
  })

  it('finds a blocked run that lives past the first page (attention + filter)', async () => {
    // The regression this pins: the strip and the blocked chip used to read the first
    // page only, so a run needing an answer at position 137 was silently absent.
    const deep = [...many]
    deep[137] = makeRun(137, { state: 'running', openQuestions: 1 })
    const server = fakeListing(deep)
    mount({ loadRuns: server.load, loadDetail: () => Promise.resolve(BLOCKED_DETAIL) })

    // It is in the attention strip, even though the table's first page never held it.
    const card = await screen.findByText('generated-run-0137')
    expect(card.closest('.acard')!.className).toContain('ask')
    expect(within(table()).queryByText('generated-run-0137')).toBeNull()

    // …and the blocked chip finds it, over a scan of every matching page.
    fireEvent.click(chip('blocked'))
    await waitFor(() => expect(within(table()).getByText('generated-run-0137')).toBeTruthy())
    expect(within(table()).getAllByRole('listitem')).toHaveLength(1)
    // The scan asked the server for the states a question can be open in — never
    // `state=blocked`, which §5.4.2 answers with a 400.
    expect(server.calls.every((c) => !String(c.state ?? '').includes('blocked'))).toBe(true)
    expect(server.calls.some((c) => c.state === 'running,starting,corrupt-result,unknown')).toBe(true)
  })

  it('counts the attention overflow instead of silently dropping it', async () => {
    const blockedMany = many.map((run, i) => (i % 20 === 5
      ? makeRun(i, { state: 'running', openQuestions: 2 })
      : run))
    const server = fakeListing(blockedMany)
    mount({ loadRuns: server.load })
    // 12 blocked runs, 3 cards: the other 9 are STATED, with a way to see them.
    const more = await screen.findByText(/9 more blocked runs/)
    expect(more).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Show the blocked runs/ }))
    await waitFor(() => expect(within(table()).getAllByRole('listitem')).toHaveLength(12))
    // The "Needs you" count is the truth (12), not the number of cards (3) — and a
    // blocked run is counted once, not again as a running run.
    expect(screen.getByText('Needs you').parentElement!.textContent).toContain('12')
    expect(screen.queryByText(/more running runs/)).toBeNull()
  })

  it('answers TWO questions from the same run, one after the other (round-3 regression)', async () => {
    // The run stays blocked and keeps its runId after the first answer, so the details
    // cache — which used to be keyed by the blocked run IDS ALONE — held the qid that had
    // just been answered. The card re-offered it, and the second Send was a 409 `already
    // answered`. The fixture's server enforces that 409, so this test fails LOUDLY if the
    // card ever addresses a resolved question again.
    const server = twoQuestionRun()
    const detail = vi.fn(server.loadDetail)
    const answer = vi.fn(server.answer)
    mount({ loadRuns: server.load, loadDetail: detail, answerFn: answer })

    await screen.findByText(/First: rewrite both call sites/)
    expect(screen.getByText(/qid q_first/)).toBeTruthy()
    const fetchesBefore = detail.mock.calls.length

    const send = () => screen.getByRole('button', { name: /Send/ })
    fireEvent.change(screen.getByLabelText('Answer the question'), { target: { value: 'rewrite both' } })
    fireEvent.click(send())
    await waitFor(() => expect(answer).toHaveBeenCalledWith('r_twoq', 'q_first', 'rewrite both'))

    // The card advances to the SECOND question — without waiting for the 2 s summary poll,
    // because the answer is what invalidated the detail.
    await screen.findByText(/Second: should the shim log a deprecation warning/)
    expect(screen.getByText(/qid q_second/)).toBeTruthy()
    // …and the RunDetail behind the card was genuinely refetched, not just re-read.
    expect(detail.mock.calls.length).toBeGreaterThan(fetchesBefore)

    fireEvent.change(screen.getByLabelText('Answer the question'), { target: { value: 'no warning' } })
    fireEvent.click(send())
    await waitFor(() => expect(answer).toHaveBeenCalledWith('r_twoq', 'q_second', 'no warning'))

    // Two answers, two distinct qids, in order — and no conflict ever surfaced.
    expect(answer.mock.calls.map((c) => c[1])).toEqual(['q_first', 'q_second'])
    expect(screen.queryByText('already answered')).toBeNull()
    // Both resolved: the card offers no third question and the run leaves the queue once
    // the listing reports it. This is asserted as the SETTLED end state, deliberately: the
    // "answer sent" copy in between is real but transient — the answer's own invalidation
    // and the listing reload race by design — and the test below pins that copy against a
    // server that does not move, instead of racing this one.
    await waitFor(() => expect(screen.queryByText(/qid q_/)).toBeNull())
    expect(answer.mock.calls).toHaveLength(2)
  })

  it('states a count on a filter chip only where it has seen the whole disk', async () => {
    const server = fakeListing(many)
    mount({ loadRuns: server.load })
    await row('generated-run-0000')
    // 240 runs > one page: `failed` and `completed` cannot be counted from what is
    // loaded, so no number is shown rather than a number that means "on this page".
    expect(chip('failed').querySelector('.n')).toBeNull()
    expect(chip('completed').querySelector('.n')).toBeNull()
    // The small world — every run on disk in one page — does show them all.
    cleanup()
    mount()
    await row('judge-panel-auth-refactor')
    await waitFor(() => expect(chip('failed').querySelector('.n')!.textContent).toBe('1'))
    expect(chip('completed').querySelector('.n')!.textContent)
      .toBe(String(RUNS.filter((r) => r.state === 'completed').length))
  })
})
