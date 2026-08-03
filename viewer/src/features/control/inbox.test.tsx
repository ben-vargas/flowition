// @vitest-environment jsdom
//
// The inbox rail's answer flow (§2.4, §7.2's `answer` row, §2.7's `a`).
//
// The rows this file pins:
//   • no confirmation — answering IS the product;
//   • optimistic: the question greys the instant the POST resolves, and says it is waiting
//     for the engine to record it rather than claiming it is recorded;
//   • a 409 is "another operator answered first" and triggers a refresh — NOT a retry loop
//     into the same conflict (the W8b multi-question bug class, from the other side);
//   • two open questions are two independent composers, so answering the first cannot make
//     the second send the wrong qid;
//   • a read-only viewer renders the composer LOCKED with its explanation — never hidden.

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlInboxRail } from './InboxRail.js'
import { IconSprite } from '../../ui/Icon.js'
import { LIVE_RUN, NOW, QUESTIONS, STALE_RUN } from '../cockpit/fixtures.js'
import type { QuestionView, RunDetail } from '../../api/types.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const OPEN_QID = 'q_7f2a'

const mount = (
  detail: RunDetail,
  props: Partial<Parameters<typeof ControlInboxRail>[0]> = {},
) => {
  const answerFn = props.answerFn ?? vi.fn(async () => ({ ok: true }))
  const view = render(
    <>
      <IconSprite />
      <ControlInboxRail
        detail={detail} now={NOW} narrow={false} open
        onOpen={() => {}} onClose={() => {}}
        capabilities={['answer', 'send', 'cancel', 'resume', 'delete']}
        {...props}
        answerFn={answerFn}
      />
    </>,
  )
  return { ...view, answerFn }
}

/** The card for one question, found by its text — the operator's own handle on it. */
const card = (needle: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('.qitem')]
    .find((element) => element.textContent?.includes(needle))
  if (!found) throw new Error(`no question card containing "${needle}"`)
  return found
}

describe('§2.4 inbox rail — the three registers', () => {
  it('renders questions, agent reports and steering history with the §7.2 verdict copy', () => {
    mount(LIVE_RUN)
    expect(screen.getByText('questions')).toBeTruthy()
    expect(screen.getByText('agent reports')).toBeTruthy()
    expect(screen.getByText('steering history')).toBeTruthy()
    // The steered mail in the fixture was delivered `live`; the chip carries the §7.2
    // sentence as its tooltip rather than leaving a bare word on the screen.
    const verdict = document.querySelector('.mf .verdict')!
    expect(verdict.textContent).toBe('live')
    expect(verdict.getAttribute('title')).toContain('current turn')
  })

  it('counts only the questions the operator can still act on', () => {
    mount(LIVE_RUN)
    expect(screen.getByText('1 open')).toBeTruthy()
  })
})

describe('§7.2 answer', () => {
  it('sends the qid the composer belongs to, with no confirmation step', async () => {
    const answerFn = vi.fn(async () => ({ ok: true }))
    mount(LIVE_RUN, { answerFn })
    const composer = within(card('rewrite two call sites'))
    fireEvent.change(composer.getByLabelText(/^Answer:/), { target: { value: 'keep a shim' } })
    fireEvent.click(composer.getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(answerFn).toHaveBeenCalledWith(LIVE_RUN.runId, OPEN_QID, 'keep a shim'))
  })

  it('sends on ⌘↵ as well as the button (§2.5’s composer idiom)', async () => {
    const answerFn = vi.fn(async () => ({ ok: true }))
    mount(LIVE_RUN, { answerFn })
    const input = within(card('rewrite two call sites')).getByLabelText(/^Answer:/)
    fireEvent.change(input, { target: { value: 'rewrite both' } })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(answerFn).toHaveBeenCalledWith(LIVE_RUN.runId, OPEN_QID, 'rewrite both'))
  })

  it('greys the question optimistically and refuses to claim the engine recorded it', async () => {
    const onAnswered = vi.fn()
    mount(LIVE_RUN, { onAnswered })
    const composer = within(card('rewrite two call sites'))
    fireEvent.change(composer.getByLabelText(/^Answer:/), { target: { value: 'shim' } })
    fireEvent.click(composer.getByRole('button', { name: /Send/ }))
    await screen.findByText(/answer sent, not recorded yet/)
    expect(screen.getByText(/stays pending until the run’s `answer` event records it/)).toBeTruthy()
    // The snapshot is what proves it: the rail asks for a fresh one.
    expect(onAnswered).toHaveBeenCalled()
  })

  /**
   * §7.2's answer row reconciles on the **`answer` event**, and the POST's own resolution is
   * not that event (review round 6, B2).
   *
   * The ordering is forced rather than raced: the POST resolves first, and the snapshot is
   * only replaced afterwards, by this test acting as the run. Between the two the row must
   * still be pending — grey, `data-pending`, counted OPEN by the rail's header, and carrying
   * no recorded answer — because the only thing that has happened is that a command reached a
   * socket. Delivering the event settles it, and settles it as the RUN's row: the journalled
   * value, no pending marker, nothing open.
   */
  it('settles ONLY on the answer event — the accepted POST leaves it pending (§7.2)', async () => {
    const recorded: RunDetail = {
      ...LIVE_RUN,
      questions: (LIVE_RUN.questions ?? []).map((question) => (
        question.qid === OPEN_QID
          ? { ...question, answered: true, answer: 'shim' }
          : question
      )),
    }
    const view = mount(LIVE_RUN)
    const composer = within(card('rewrite two call sites'))
    fireEvent.change(composer.getByLabelText(/^Answer:/), { target: { value: 'shim' } })
    fireEvent.click(composer.getByRole('button', { name: /Send/ }))

    // POST RESOLVED, and the run has not recorded anything: still the pending row.
    await screen.findByText(/answer sent, not recorded yet/)
    const pending = card('rewrite two call sites')
    expect(pending.className).toContain('pending')
    expect(pending.hasAttribute('data-pending')).toBe(true)
    expect(pending.textContent).not.toContain('shim recorded')
    // The rail counts what the RUN says is open, not what this operator believes.
    expect(screen.getByText('1 open')).toBeTruthy()

    // THE EVENT. The engine journalled the answer, so the refreshed detail carries it — and
    // that is what turns the pending row into the history row (E7's value included).
    view.rerender(
      <>
        <IconSprite />
        <ControlInboxRail
          detail={recorded} now={NOW} narrow={false} open
          onOpen={() => {}} onClose={() => {}}
          capabilities={['answer', 'send', 'cancel', 'resume', 'delete']}
          answerFn={view.answerFn}
        />
      </>,
    )
    await waitFor(() => {
      const settled = card('rewrite two call sites')
      expect(settled.className).not.toContain('pending')
      expect(settled.hasAttribute('data-pending')).toBe(false)
    })
    const settled = card('rewrite two call sites')
    expect(within(settled).getByText('answered')).toBeTruthy()
    expect(settled.textContent).toContain('shim')
    expect(settled.textContent).not.toContain('not recorded yet')
    expect(screen.getByText('nothing open')).toBeTruthy()
  })

  /**
   * "INSTANTLY" is the word §7.2 uses, and a mock that resolves on the microtask queue
   * cannot tell the difference between "greys on submit" and "greys when the POST comes
   * back". So this one never resolves: the bridge is allowed 2000 ms for an answer, and for
   * every one of them the operator must be able to see that their answer went.
   */
  it('greys BEFORE the request resolves — the promise here never settles (§7.2)', async () => {
    let release: (() => void) | null = null
    const answerFn = vi.fn(() => new Promise<unknown>((resolve) => { release = () => resolve({}) }))
    mount(LIVE_RUN, { answerFn })
    const composer = within(card('rewrite two call sites'))
    fireEvent.change(composer.getByLabelText(/^Answer:/), { target: { value: 'shim' } })
    fireEvent.click(composer.getByRole('button', { name: /Send/ }))

    // In flight: the row is already the greyed, settled-looking one, and it says which
    // state it is in rather than claiming the engine has the answer.
    await screen.findByText(/sending your answer…/)
    expect(card('rewrite two call sites').className).toContain('pending')
    expect(within(card('rewrite two call sites')).queryByRole('button', { name: /Send/ })).toBeNull()
    expect(answerFn).toHaveBeenCalledTimes(1)

    release!()
    await screen.findByText(/answer sent/)
  })

  it('ROLLS BACK the optimistic grey on a retryable failure, text intact', async () => {
    let reject: ((error: unknown) => void) | null = null
    const answerFn = vi.fn(() => new Promise<unknown>((_resolve, rejectFn) => {
      reject = (error) => rejectFn(error)
    }))
    mount(LIVE_RUN, { answerFn })
    const composer = within(card('rewrite two call sites'))
    fireEvent.change(composer.getByLabelText(/^Answer:/), { target: { value: 'shim' } })
    fireEvent.click(composer.getByRole('button', { name: /Send/ }))
    await screen.findByText(/sending your answer…/)

    reject!(Object.assign(new Error('run is not live — it may have finished'), {
      status: 503, code: 'run_not_live',
    }))
    // A 503 is retryable, so a permanently-greyed question would be a lie about what the
    // engine has. The composer comes back with the operator's text still in it.
    await screen.findByText(/run is not live/)
    const back = within(card('rewrite two call sites'))
    expect((back.getByLabelText(/^Answer:/) as HTMLInputElement).value).toBe('shim')
    expect(back.getByRole('button', { name: /Send/ })).toBeTruthy()
    expect(card('rewrite two call sites').className).not.toContain('answered')
  })

  it('reads a 409 as "another operator answered first" and refreshes (§7.2)', async () => {
    const onAnswered = vi.fn()
    const answerFn = vi.fn(async () => {
      throw Object.assign(new Error('no pending question q_7f2a'), { status: 409, code: 'conflict' })
    })
    mount(LIVE_RUN, { answerFn, onAnswered })
    const composer = within(card('rewrite two call sites'))
    fireEvent.change(composer.getByLabelText(/^Answer:/), { target: { value: 'shim' } })
    fireEvent.click(composer.getByRole('button', { name: /Send/ }))
    await screen.findByText(/answered elsewhere/)
    expect(screen.getByText(/another operator answered first/)).toBeTruthy()
    expect(onAnswered).toHaveBeenCalled()
    // And the composer is GONE for that question — retrying into the same 409 is not an
    // affordance worth offering.
    expect(within(card('rewrite two call sites')).queryByRole('button', { name: /Send/ })).toBeNull()
  })

  it('keeps the composer alive on a transient failure, with the server’s words', async () => {
    const answerFn = vi.fn(async () => {
      throw Object.assign(new Error('run is not live — it may have finished'), {
        status: 503, code: 'run_not_live',
      })
    })
    mount(LIVE_RUN, { answerFn })
    const composer = within(card('rewrite two call sites'))
    fireEvent.change(composer.getByLabelText(/^Answer:/), { target: { value: 'shim' } })
    fireEvent.click(composer.getByRole('button', { name: /Send/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('not live')
    expect(composer.getByRole('button', { name: /Send/ })).toBeTruthy()
  })

  // The W8b bug class: a card with ONE composer bound to "the first open question" re-offers
  // an answered qid for a poll interval and 409s on the second answer. Here each question
  // owns its composer, so the second answer addresses the second question by construction.
  it('addresses the SECOND question with the second composer (the multi-question class)', async () => {
    const answerFn = vi.fn(async () => ({ ok: true }))
    const twoOpen: RunDetail = {
      ...LIVE_RUN,
      questions: [
        QUESTIONS[0]!,
        {
          qid: 'q_9c31', question: 'Ship the docs section with this run?',
          askedAt: NOW - 30_000, answered: false, answer: null, replayed: false, abandoned: false,
        } satisfies QuestionView,
      ],
      openQuestions: 2,
    }
    mount(twoOpen, { answerFn })
    expect(screen.getByText('2 open')).toBeTruthy()

    const first = within(card('rewrite two call sites'))
    fireEvent.change(first.getByLabelText(/^Answer:/), { target: { value: 'shim' } })
    fireEvent.click(first.getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(answerFn).toHaveBeenCalledTimes(1))

    const second = within(card('Ship the docs section'))
    fireEvent.change(second.getByLabelText(/^Answer:/), { target: { value: 'yes' } })
    fireEvent.click(second.getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(answerFn).toHaveBeenCalledTimes(2))
    expect(answerFn.mock.calls[0]).toEqual([twoOpen.runId, OPEN_QID, 'shim'])
    expect(answerFn.mock.calls[1]).toEqual([twoOpen.runId, 'q_9c31', 'yes'])
  })

  it('never offers a composer for an ABANDONED question (§6.4 step 8 / critique M6)', () => {
    // A pending ask on a run whose engine is gone can never be answered — the engine
    // rejects pending asks on abort with no answer event. The rail reads that through
    // `honesty.abandoned`, which layers liveness over the server's own flag, so this holds
    // even for a snapshot taken the moment before the engine died.
    const abandoned: RunDetail = {
      ...STALE_RUN,
      questions: [{ ...QUESTIONS[0]!, abandoned: true }],
      openQuestions: 0,
    }
    mount(abandoned)
    const dead = card('rewrite two call sites')
    expect(within(dead).queryByRole('button', { name: /Send/ })).toBeNull()
    expect(dead.textContent).toContain('never answered')
    expect(screen.getByText('nothing open')).toBeTruthy()
  })

  it('shows an ANSWERED question’s value as history (E7)', () => {
    mount(LIVE_RUN)
    expect(card('vendored fonts').textContent).toContain('no — they are ours')
  })
})

describe('§7.2 read-only viewer', () => {
  it('renders the composer LOCKED with its explanation — never hidden, never enabled', () => {
    mount(LIVE_RUN, { capabilities: [] })
    const composer = within(card('rewrite two call sites'))
    const input = composer.getByLabelText(/^Answer:/) as HTMLInputElement
    const send = composer.getByRole('button', { name: /Send/ }) as HTMLButtonElement
    expect(input).toBeTruthy()          // present
    expect(input.disabled).toBe(true)   // and inert
    expect(send.disabled).toBe(true)
    expect(input.placeholder).toBe('read-only viewer')
    expect(composer.getAllByText(/--control=answer/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('locked').length).toBeGreaterThan(0)
  })

  /**
   * The gate fails closed, and the copy still tells the truth about WHY (round 5, B1).
   *
   * The previous revision left this composer live on an unknown set, on the argument that a
   * failed probe must not present itself as a denial. Half of that survives — the sentence
   * beneath the composer never says "read-only", because nothing has said so — but the
   * composer itself is inert: `answer` is a capability the operator opted into with
   * `--control`, and a check that has not succeeded has granted nothing.
   */
  it('FAILS CLOSED while the session probe has not answered, without claiming read-only', () => {
    mount(LIVE_RUN, { capabilities: null })
    const composer = within(card('rewrite two call sites'))
    const box = composer.getByLabelText(/^Answer:/) as HTMLInputElement
    expect(box).toBeTruthy()                       // present…
    expect(box.disabled).toBe(true)                // …and inert
    expect(box.placeholder).toBe('checking permissions…')
    expect(composer.getByRole('button', { name: /Send/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getAllByText('checking').length).toBeGreaterThan(0)
    expect(screen.queryByText(/this viewer is read-only/)).toBeNull()
  })

  it('FAILS CLOSED when the probe FAILED, and names the failure instead of blaming the CLI', () => {
    mount(LIVE_RUN, { capabilities: null, capabilityError: 'the viewer API did not answer' })
    const composer = within(card('rewrite two call sites'))
    const box = composer.getByLabelText(/^Answer:/) as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(box.placeholder).toBe('permissions unverified')
    expect(screen.getAllByText('unverified').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/the viewer API did not answer/).length).toBeGreaterThan(0)
    // The distinction the three-valued reading exists for: no `--control=answer` advice, and
    // no read-only claim, on a probe nobody answered.
    expect(screen.queryByText(/this viewer is read-only/)).toBeNull()
    expect(screen.queryByText(/--control=answer/)).toBeNull()
  })

  it('will not SEND on an ungranted capability even if the composer is driven directly', async () => {
    const answerFn = vi.fn(async () => ({ ok: true }))
    mount(LIVE_RUN, { capabilities: null, answerFn })
    const box = within(card('rewrite two call sites'))
      .getByLabelText(/^Answer:/) as HTMLInputElement
    // A disabled input raises no events in a browser; this drives the state change and the
    // ⌘↵ path anyway, because the gate must not live only in the render tree.
    fireEvent.change(box, { target: { value: 'ship it' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    fireEvent.submit(box.closest('form')!)
    await Promise.resolve()
    expect(answerFn).not.toHaveBeenCalled()
  })
})

describe('§2.7 keyboard', () => {
  it('`a` focuses the first open question’s answer box', () => {
    mount(LIVE_RUN)
    fireEvent.keyDown(window, { key: 'a' })
    expect((document.activeElement as HTMLElement).className).toContain('ans-inp')
  })

  it('`a` is ignored while typing, so it can be typed INTO an answer (parity #111)', () => {
    mount(LIVE_RUN)
    const input = within(card('rewrite two call sites')).getByLabelText(/^Answer:/)
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    fireEvent.keyDown(outside, { key: 'a' })
    expect(document.activeElement).toBe(outside)
    expect(document.activeElement).not.toBe(input)
    outside.remove()
  })

  it('opens the collapsed rail before focusing, rather than focusing nothing', () => {
    const onOpen = vi.fn()
    render(
      <>
        <IconSprite />
        <ControlInboxRail
          detail={LIVE_RUN} now={NOW} narrow={false} open={false}
          onOpen={onOpen} onClose={() => {}}
          capabilities={['answer']} answerFn={async () => ({})}
        />
      </>,
    )
    fireEvent.keyDown(window, { key: 'a' })
    expect(onOpen).toHaveBeenCalled()
  })
})

describe('§3.6 the narrow drawer', () => {
  // Driven through REAL state, not a spy: with a controlled `open` that never changes, the
  // focus trap would legitimately pull focus back and the restore assertion would be
  // testing the harness rather than the rail.
  //
  // The `background` button is here for the §16.3 modality assertions: a drawer that says
  // `aria-modal="true"` has to MAKE the rest of the page inert, and the only way to see
  // that is to have some rest-of-the-page.
  function Drawer() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <IconSprite />
        <main><button type="button">background content</button></main>
        <ControlInboxRail
          detail={LIVE_RUN} now={NOW} narrow open={open}
          onOpen={() => setOpen(true)} onClose={() => setOpen(false)}
          capabilities={['answer']} answerFn={async () => ({})}
        />
      </>
    )
  }

  /** Escape goes to the surface, the way React Aria's overlay hooks receive it (§16.3). */
  const escape = () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

  it('moves focus to the header on open and restores it to the handle on Escape', () => {
    render(<Drawer />)
    const handle = screen.getByRole('button', { name: 'Open inbox rail' })
    handle.focus()
    fireEvent.click(handle)
    expect((document.activeElement as HTMLElement).textContent).toBe('inbox')
    escape()
    expect(document.querySelector('.inbox.drawer')).toBeNull()
    expect(document.activeElement).toBe(handle)
  })

  /**
   * §16.3 / §3.6: `aria-modal="true"` is a PROMISE, and round 1's drawer made it without
   * keeping it — the cockpit behind the drawer stayed in the accessibility tree and stayed
   * scrollable, so a screen-reader user could walk straight out of the "modal" and a touch
   * scroll moved the page under it. `ariaHideOutside` and `usePreventScroll` are what make
   * the claim true, and both are asserted here rather than assumed from the import.
   */
  it('makes the page behind it inaccessible and unscrollable while it is open', () => {
    render(<Drawer />)
    const background = screen.getByRole('button', { name: 'background content' })
    const main = background.closest('main')!
    expect(main.getAttribute('aria-hidden')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open inbox rail' }))
    // The background is gone for assistive tech: hidden in the tree, and unreachable by
    // the accessible queries that walk it.
    expect(main.getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByRole('button', { name: 'background content' })).toBeNull()
    // …and the page under it cannot scroll (§3.6's modal contract).
    expect(document.documentElement.style.overflow).toBe('hidden')

    escape()
    // Closing gives all of it back — a modal that leaks either state is worse than one
    // that never claimed to be modal.
    expect(main.getAttribute('aria-hidden')).toBeNull()
    expect(screen.getByRole('button', { name: 'background content' })).toBeTruthy()
    expect(document.documentElement.style.overflow).not.toBe('hidden')
  })

  it('closes and restores focus on the SCRIM path too (§16.5)', () => {
    render(<Drawer />)
    const handle = screen.getByRole('button', { name: 'Open inbox rail' })
    handle.focus()
    fireEvent.click(handle)
    fireEvent.click(document.querySelector('.inbox-scrim')!)
    expect(document.querySelector('.inbox.drawer')).toBeNull()
    expect(document.activeElement).toBe(handle)
  })

  it('closes on its own Close button and restores focus (the third close path)', () => {
    render(<Drawer />)
    const handle = screen.getByRole('button', { name: 'Open inbox rail' })
    handle.focus()
    fireEvent.click(handle)
    fireEvent.click(screen.getByRole('button', { name: 'Close inbox rail' }))
    expect(document.querySelector('.inbox.drawer')).toBeNull()
    expect(document.activeElement).toBe(handle)
  })

  /**
   * The fourth close path, and the one no handler in this file can see: the PARENT simply
   * decides the rail is shut (a layout change, a route change, `Esc` handled upstairs).
   * §3.6 says "closing restores it" without qualifying which close, which is why the
   * restore lives in the drawer's own unmount cleanup rather than in three handlers.
   */
  it('restores focus when the PARENT closes it, with no close handler involved', () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <IconSprite />
          <button type="button" onClick={() => setOpen(false)}>shut it from outside</button>
          <ControlInboxRail
            detail={LIVE_RUN} now={NOW} narrow open={open}
            onOpen={() => setOpen(true)} onClose={() => {}}
            capabilities={['answer']} answerFn={async () => ({})}
          />
        </>
      )
    }
    render(<Host />)
    const handle = screen.getByRole('button', { name: 'Open inbox rail' })
    handle.focus()
    fireEvent.click(handle)
    expect(screen.getByRole('dialog')).toBeTruthy()
    // The host's own button is outside the drawer, so it is `aria-hidden` while the drawer
    // is up — clicking it is what a layout change does, not what an operator does.
    fireEvent.click(document.querySelector('button')!)
    expect(document.querySelector('.inbox.drawer')).toBeNull()
    expect(document.activeElement).toBe(handle)
  })
})
