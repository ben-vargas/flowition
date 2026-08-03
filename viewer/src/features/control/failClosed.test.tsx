// @vitest-environment jsdom
//
// §7.2's gate, from the top of the app: **no mutation is operable until `GET /api/session`
// SUCCEEDS and names it.**
//
// `walkthrough.test.tsx` pins the same rule against the composition with `capabilities`
// handed in as a prop. This file is the half that prop cannot reach: whether the SHELL ever
// produces a set that is not a successful response's. It drives the real `<App/>` over a
// stubbed `fetch` whose `/api/session` is
//
//   • DELAYED — a deferred promise that has not resolved, which is the state every viewer is
//     in for its first frames and the state a wedged server leaves it in forever; and
//   • REJECTED — a transport failure, which is what a viewer that was killed, or a proxy that
//     dropped the request, actually produces.
//
// In both, all five mutation surfaces must be present, inert and explained. Then the same
// mounted app is handed a successful response and the same controls come alive — fail-closed
// must not be indistinguishable from broken.
//
// A 401 is deliberately NOT one of the flavors: that is the token gate's case (§7.1.2), and
// `App.test.tsx` owns it. Here the credential is fine and the answer is missing.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../app/App.js'
import { resetRouteForTests } from '../../app/router.js'
import { clearTokens, setToken } from '../../api/client.js'
import { LIVE_RUN, NOW } from '../cockpit/fixtures.js'
import { BLOCKED_DETAIL, RUNS_PAGE, SESSION } from '../home/fixtures.js'

const RUNNING = LIVE_RUN.agents.find((agent) => agent.state === 'running')!

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response

/**
 * The session route as a switch the test throws, and every other route answering normally —
 * so the ONLY thing under test is what an unanswered capability probe does to the write
 * surfaces. A wholesale-broken API would disable the controls for reasons of its own.
 */
function stubFetch(session: 'pending' | 'reject' | 'ok', onSessionCall = () => {}) {
  // EVERY pending probe, not just the last one. The shell and Home each make one (the shell
  // for the app-wide gate, Home for the `$FLOWITION_HOME` path in its header), so a single
  // `resolve` slot would leave one of them hanging and make "it comes alive" untestable on
  // whichever screen lost the race.
  const resolvers: ((value: Response) => void)[] = []
  let mode = session
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init
    const url = String(input)
    if (url.startsWith('/api/session')) {
      onSessionCall()
      if (mode === 'reject') throw new TypeError('Failed to fetch')
      if (mode === 'pending') return new Promise<Response>((r) => { resolvers.push(r) })
      return ok(SESSION)
    }
    if (/\/agents\/\d+\/page/.test(url)) return ok({ items: [], start: 0, end: 0, size: 0, eof: true })
    // Home's blocked card fetches the snapshot behind its inline question: without the real
    // payload the composer would be disabled for want of a QUESTION, which is not the gate
    // under test here.
    if (new RegExp(`^/api/runs/${BLOCKED_DETAIL.runId}$`).test(url)) return ok(BLOCKED_DETAIL)
    if (/^\/api\/runs\/[^/?]+$/.test(url)) return ok(LIVE_RUN)
    if (url.startsWith('/api/runs')) return ok(RUNS_PAGE)
    return ok({})
  })
  return {
    fetchMock,
    /** Let the probe succeed with all five capabilities — pending promises included. */
    grantAll: () => {
      mode = 'ok'
      for (const resolve of resolvers.splice(0)) resolve(ok(SESSION))
    },
  }
}

/** Every mutation route §7.2 gates, as the shapes a request to one would take. */
const MUTATION_URL = /\/(send|answer|cancel|resume)$|^\/api\/runs\/[^/?]+$/
const mutationCalls = (fetchMock: ReturnType<typeof stubFetch>['fetchMock']) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const method = init?.method ?? 'GET'
    return method !== 'GET' && MUTATION_URL.test(String(input))
  })

const mountApp = (route: string, session: 'pending' | 'reject' | 'ok') => {
  const stub = stubFetch(session)
  vi.stubGlobal('fetch', stub.fetchMock)
  window.history.replaceState(null, '', `/#${route}`)
  resetRouteForTests()
  render(<App />)
  return stub
}

beforeEach(() => {
  clearTokens()
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  // A valid read credential: this file is about a missing ANSWER, never a missing token.
  setToken('read-token')
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('§7.2 — the write surface fails CLOSED until the session answers', () => {
  for (const [flavor, mode, word, placeholder] of [
    ['DELAYED', 'pending', 'checking', 'checking permissions…'],
    ['REJECTED', 'reject', 'unverified', 'permissions unverified'],
  ] as const) {
    it(`answer, cancel, resume and delete are inert and explained on a ${flavor} session`, async () => {
      mountApp(`/run/${LIVE_RUN.runId}`, mode)
      await screen.findByRole('tablist', { name: 'Cockpit views' })

      // ANSWER — present (§7.2: never hidden), inert, and saying which of the two it is.
      const box = await waitFor(() => {
        const found = document.querySelector<HTMLInputElement>('.ans-inp')
        if (!found) throw new Error('no answer composer')
        return found
      })
      expect(box.disabled).toBe(true)
      expect(box.placeholder).toBe(placeholder)

      // CANCEL and DELETE — the cockpit header's lifecycle buttons.
      for (const name of [/Cancel run/, /Delete/]) {
        expect(screen.getByRole('button', { name }).getAttribute('aria-disabled')).toBe('true')
      }

      // ANSWER, CANCEL, RESUME, DELETE — the palette, which can fire a mutation from any
      // screen and is therefore the gate's widest surface. Enter on a refused row does
      // nothing AND does not close the palette (a dialog that dismisses itself reads as
      // success).
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
      const search = await screen.findByRole('combobox')
      for (const query of ['answer the first', 'cancel run', 'resume run', 'delete run']) {
        fireEvent.change(search, { target: { value: query } })
        const row = (await screen.findAllByRole('option'))[0]!
        expect(row.getAttribute('aria-disabled')).toBe('true')
        expect(row.textContent).toContain('disabled')
        fireEvent.keyDown(search, { key: 'Enter' })
        expect(screen.getByRole('combobox')).toBeTruthy()
      }
      fireEvent.keyDown(window, { key: 'k', metaKey: true })

      // The page-level chip says the same thing once, and never the word "read-only" —
      // nothing has claimed this viewer lacks the capability.
      expect(screen.getAllByText(word).length).toBeGreaterThan(0)
      expect(screen.queryByText('read-only')).toBeNull()
      expect(screen.queryByText(/this viewer is read-only/)).toBeNull()
      expect(screen.getByText(
        mode === 'reject' ? 'permissions unverified' : 'checking permissions…',
      )).toBeTruthy()
    })

    it(`send and per-agent cancel are inert and explained on a ${flavor} session`, async () => {
      mountApp(`/run/${LIVE_RUN.runId}/agent/${RUNNING.index}`, mode)
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

  /**
   * HOME — §2.3's attention strip, and the screen the ≤2-click answer path lives on.
   *
   * It gets its own pass because it is a SEPARATE write surface from the cockpit's: its own
   * composer, its own Resume, and (until round 6) its own capability reading, which returned
   * "allowed" for a probe that had not answered. Both of its mutations are asserted present,
   * inert, explained AND unable to fire a request — the last part matters because a control
   * whose handler still runs is only cosmetically disabled.
   */
  for (const [flavor, mode, word, placeholder] of [
    ['DELAYED', 'pending', 'checking', 'checking permissions…'],
    ['REJECTED', 'reject', 'unverified', 'permissions unverified'],
  ] as const) {
    it(`Home’s Answer and Resume are inert and explained on a ${flavor} session`, async () => {
      const stub = mountApp('/', mode)

      // ANSWER — §2.3's inline composer, with the question actually in hand.
      const box = await screen.findByLabelText('Answer the question') as HTMLInputElement
      await screen.findByText(/Two call sites in src\/cli\.js/)
      expect(box.disabled).toBe(true)
      expect(box.placeholder).toBe(placeholder)
      expect((screen.getAllByRole('button', { name: /Send/ })[0] as HTMLButtonElement).disabled)
        .toBe(true)

      // RESUME — the stale card's lifecycle control.
      const stale = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement
      const resume = within(stale).getByRole('button', { name: /^Resume$/ }) as HTMLButtonElement
      expect(resume.disabled).toBe(true)

      // EXPLAINED, in the shared vocabulary — and never as a read-only claim.
      expect(screen.getAllByText(word).length).toBeGreaterThan(0)
      expect(screen.queryByText(/this viewer is read-only/)).toBeNull()
      expect(screen.queryByText(/--control=/)).toBeNull()

      // AND INERT. Pressing both, and driving the composer the way §2.7's keyboard path
      // would, produces no dialog, no snapshot read for one, and no request of any kind.
      fireEvent.click(resume)
      fireEvent.change(box, { target: { value: 'keep the shim' } })
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
      fireEvent.keyDown(window, { key: 'a' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(mutationCalls(stub.fetchMock)).toHaveLength(0)
      // Not even the READ the resume modal makes to state §7.3's graph fact: an ungranted
      // capability is refused before the card touches the network at all.
      expect(stub.fetchMock.mock.calls.some(([url]) => String(url) === '/api/runs/r_77b0e412'))
        .toBe(false)
      expect((screen.getByLabelText('Answer the question') as HTMLInputElement).disabled).toBe(true)
    })
  }

  it('Home’s Answer and Resume come alive on a session response that GRANTS them', async () => {
    const stub = mountApp('/', 'pending')
    const box = await screen.findByLabelText('Answer the question') as HTMLInputElement
    expect(box.disabled).toBe(true)

    stub.grantAll()

    await waitFor(() => expect(
      (screen.getByLabelText('Answer the question') as HTMLInputElement).disabled,
    ).toBe(false))
    const stale = (await screen.findByText(/Engine died/)).closest('.acard') as HTMLElement
    expect((within(stale).getByRole('button', { name: /^Resume$/ }) as HTMLButtonElement).disabled)
      .toBe(false)
    expect(document.querySelectorAll('.lock-chip')).toHaveLength(0)

    // Operable means it really submits: the ≤2-click answer reaches the network.
    fireEvent.change(screen.getByLabelText('Answer the question'), { target: { value: 'keep the shim' } })
    fireEvent.click(screen.getAllByRole('button', { name: /Send/ })[0]!)
    await waitFor(() => expect(
      mutationCalls(stub.fetchMock).some(([url]) => String(url).endsWith('/answer')),
    ).toBe(true))
  })

  /**
   * The other direction, on ONE mounted app: a probe that eventually succeeds hands the
   * controls back. Without this, "everything is disabled" would be satisfied by a viewer
   * that is simply broken — and the round-5 fix would be indistinguishable from the defect
   * it replaces.
   */
  it('comes alive the moment a successful session response GRANTS the capability', async () => {
    const stub = mountApp(`/run/${LIVE_RUN.runId}`, 'pending')
    await screen.findByRole('tablist', { name: 'Cockpit views' })
    const box = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>('.ans-inp')
      if (!found) throw new Error('no answer composer')
      return found
    })
    expect(box.disabled).toBe(true)

    stub.grantAll()

    await waitFor(() => expect(document.querySelector<HTMLInputElement>('.ans-inp')!.disabled).toBe(false))
    expect(screen.getByRole('button', { name: /Cancel run/ }).getAttribute('aria-disabled'))
      .not.toBe('true')
    expect(screen.queryByText('checking permissions…')).toBeNull()
    expect(screen.queryByText('permissions unverified')).toBeNull()
  })

  /**
   * §6.5's degradation rule meets the gate: a session payload from an older/other server
   * that carries no `control` key at all is an ANSWER, and the answer is "nothing granted".
   * It must read as read-only — with the `--control` advice, which is the correct next move
   * — and not as an unanswered probe.
   */
  it('treats a session with no `control` key as read-only, not as unverified (§6.5)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/session')) return ok({ version: '0.1.0', home: '/tmp' })
      if (/^\/api\/runs\/[^/?]+$/.test(url)) return ok(LIVE_RUN)
      return ok(RUNS_PAGE)
    }))
    window.history.replaceState(null, '', `/#/run/${LIVE_RUN.runId}`)
    resetRouteForTests()
    render(<App />)
    await screen.findByRole('tablist', { name: 'Cockpit views' })
    const box = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>('.ans-inp')
      if (!found) throw new Error('no answer composer')
      return found
    })
    expect(box.disabled).toBe(true)
    expect(box.placeholder).toBe('read-only viewer')
    expect(screen.getAllByText(/--control=answer/).length).toBeGreaterThan(0)
  })
})
