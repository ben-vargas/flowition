// @vitest-environment jsdom
//
// The shell: the paste-token gate (§7.1.2), the icon sprite, the read-only chip, the
// theme shortcut, and the router outlet including the routes W8b does not own.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import { resetRouteForTests } from './router.js'
import { GLYPH_NAMES } from '../ui/icons.js'
import { BLOCKED_DETAIL, RUNS, RUNS_PAGE, SESSION, READ_ONLY_SESSION } from '../features/home/fixtures.js'
import { TOKEN_KEY, clearTokens, setToken } from '../api/client.js'

const ok = (body: unknown) => ({
  ok: true, status: 200, json: async () => body,
}) as unknown as Response

function stubFetch(session: unknown = SESSION) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/session')) {
      if (session instanceof Error) throw session
      if (typeof session === 'number') {
        return { ok: false, status: session, json: async () => ({ error: { code: 'unauthorized', message: 'nope' } }) } as unknown as Response
      }
      return ok(session)
    }
    if (/^\/api\/runs\/[^/?]+$/.test(url)) return ok(BLOCKED_DETAIL)
    if (url.startsWith('/api/runs')) {
      // §5.4.2's `q` is honored, because the keyboard tests below need Home's list to
      // genuinely differ from the rail's — that divergence is the whole subject.
      const q = new URL(url, 'http://x').searchParams.get('q')
      if (!q) return ok(RUNS_PAGE)
      const runs = RUNS.filter((r) => `${r.name ?? ''} ${r.runId}`.toLowerCase().includes(q.toLowerCase()))
      return ok({ runs, nextCursor: null, totalOnDisk: RUNS.length })
    }
    return ok({})
  })
}

beforeEach(() => {
  clearTokens()
  localStorage.clear()
  window.history.replaceState(null, '', '/#/')
  resetRouteForTests()
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false, media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the token gate (§7.1.2)', () => {
  it('shows the paste-token screen on a 401 and names the CLI command', async () => {
    vi.stubGlobal('fetch', stubFetch(401))
    render(<App />)
    await screen.findByText('This viewer needs a token')
    expect(screen.getByText('flowition viewer --print-url')).toBeTruthy()
  })

  it('does not loop: the rejected token is cleared, and a pasted one is retried', async () => {
    window.history.replaceState(null, '', '/#/?t=BAD')
    resetRouteForTests()
    let session: unknown = 401
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/session')) {
        if (session === 401) {
          return { ok: false, status: 401, json: async () => ({ error: { code: 'unauthorized', message: 'nope' } }) } as unknown as Response
        }
        return ok(SESSION)
      }
      if (/^\/api\/runs\/[^/?]+$/.test(url)) return ok(BLOCKED_DETAIL)
      return ok(RUNS_PAGE)
    }))
    render(<App />)
    await screen.findByText('This viewer needs a token')
    // The 401 path cleared the credential rather than retrying it forever.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(window.location.href).not.toContain('BAD')

    session = SESSION
    fireEvent.change(screen.getByLabelText('Read token'), { target: { value: 'GOOD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use token' }))
    await screen.findByRole('heading', { name: 'Runs' })
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('GOOD')
  })
})

/**
 * The session probe used to be a ONE-SHOT: it ran at mount and never again. A 401 arriving
 * on any other request — the Home listing, the rail's 5 s poll, a detail fetch — clears the
 * credential in api/client.ts, but nothing told the shell, so a viewer whose token was
 * revoked mid-session kept its authenticated frame and its now-unauthenticated rows on
 * screen until the operator reloaded by hand. Found by driving the UI, not by reading it.
 */
describe('a credential revoked mid-session (§7.1.2)', () => {
  const unauthorized = () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { code: 'unauthorized', message: 'the read token was rejected' } }),
  }) as unknown as Response

  it('re-probes the session and shows the gate when a LATER poll 401s', async () => {
    setToken('GOOD')
    let revoke: (r: Response) => void = () => {}
    // The listing hangs until the test revokes the token — that is what makes "mounted
    // successfully, THEN refused" a deterministic sequence rather than a race.
    const listing = new Promise<Response>((resolve) => { revoke = resolve })

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      // The server's actual rule: no `Authorization`, no answer. So the re-probe this fix
      // introduces genuinely 401s once the credential is gone, rather than being humored.
      const authed = Boolean((init?.headers as Record<string, string> | undefined)?.authorization)
      if (url.startsWith('/api/session')) return authed ? ok(SESSION) : unauthorized()
      if (!authed) return unauthorized()
      if (/^\/api\/runs\/[^/?]+$/.test(url)) return ok(BLOCKED_DETAIL)
      return listing
    }))

    render(<App />)
    // Half one: the authenticated shell really did mount.
    await screen.findByRole('heading', { name: 'Runs' })
    expect(screen.queryByText('This viewer needs a token')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Runs' })).toBeTruthy()

    // Half two: the token is revoked server-side and the LISTING is what learns it.
    revoke(unauthorized())

    await screen.findByText('This viewer needs a token')
    // The stale authenticated shell is gone, not merely overlaid.
    expect(screen.queryByRole('navigation', { name: 'Runs' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Runs' })).toBeNull()
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('comes back on a freshly pasted token, without a reload', async () => {
    setToken('STALE')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization
      if (auth !== 'Bearer GOOD') return unauthorized()
      if (url.startsWith('/api/session')) return ok(SESSION)
      if (/^\/api\/runs\/[^/?]+$/.test(url)) return ok(BLOCKED_DETAIL)
      return ok(RUNS_PAGE)
    }))

    render(<App />)
    await screen.findByText('This viewer needs a token')
    fireEvent.change(screen.getByLabelText('Read token'), { target: { value: 'GOOD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use token' }))
    // The token change is the request identity, so the session re-probes on its own.
    await screen.findByRole('heading', { name: 'Runs' })
  })
})

describe('the shell', () => {
  it('renders the full 43-glyph sprite once, same-document', async () => {
    vi.stubGlobal('fetch', stubFetch())
    const { container } = render(<App />)
    await screen.findByRole('heading', { name: 'Runs' })
    const sprite = container.querySelector('.icon-sprite')!
    expect(sprite.querySelectorAll('symbol')).toHaveLength(GLYPH_NAMES.length)
    // §7.1.4: every reference is a fragment id, never an external file, because
    // `default-src 'none'` blocks external <use>.
    for (const use of container.querySelectorAll('use')) {
      expect(use.getAttribute('href')!.startsWith('#i-')).toBe(true)
    }
  })

  it('shows the read-only chip only when no capability is enabled (§7.2)', async () => {
    vi.stubGlobal('fetch', stubFetch(READ_ONLY_SESSION))
    const { unmount } = render(<App />)
    await screen.findByText('read-only')
    unmount()
    cleanup()
    vi.stubGlobal('fetch', stubFetch(SESSION))
    render(<App />)
    await screen.findByRole('heading', { name: 'Runs' })
    expect(screen.queryByText('read-only')).toBeNull()
  })

  it('toggles the theme on `d`, and not while typing (§2.7 / parity #111)', async () => {
    document.documentElement.dataset.theme = 'dark'
    vi.stubGlobal('fetch', stubFetch())
    render(<App />)
    await screen.findByRole('heading', { name: 'Runs' })
    fireEvent.keyDown(window, { key: 'd' })
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    const search = screen.getByLabelText('Filter by name or run id')
    search.focus()
    fireEvent.keyDown(search, { key: 'd' })
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

/**
 * Home and the run rail are TWO §3.6 roving-tabindex lists on one screen, and §2.7 gives
 * both the same keys (`j`/`k`, `Enter`). Only a composition test can see them fight: Home's
 * shortcut listener is on `window`, so it also received keys the operator aimed at a rail
 * row — it moved Home's cursor AND, by calling `preventDefault`, swallowed the rail row's
 * own activation. Enter on the rail then navigated to whatever Home's cursor was on, which
 * with Home filtered is a different run entirely (review round 3).
 *
 * This is §11.1's split doing its job again: both components' own tests passed throughout.
 */
describe('two roving lists, one keyboard (§2.7 × §3.6)', () => {
  async function mountShell() {
    const fetchSpy = stubFetch()
    vi.stubGlobal('fetch', fetchSpy)
    render(<App />)
    await screen.findByRole('heading', { name: 'Runs' })
    const rail = document.querySelector('.rail') as HTMLElement
    await waitFor(() => expect(rail.querySelectorAll('.rrow')).toHaveLength(RUNS.length))
    const rows = [...rail.querySelectorAll<HTMLButtonElement>('.rrow')]
    return { fetchSpy, rail, rows }
  }

  /** The rail row carrying the roving `tabIndex=0` — i.e. the rail's own cursor. */
  const railCursor = (rows: HTMLButtonElement[]) => rows.findIndex((r) => r.tabIndex === 0)

  it('opens the RAIL\'s run on Enter, never Home\'s cursor', async () => {
    const { fetchSpy, rows } = await mountShell()
    // The reported reproduction: Home filtered to one run, the rail focused on another.
    fireEvent.change(screen.getByLabelText('Filter by name or run id'), {
      target: { value: 'flaky-test-hunt' },
    })
    await waitFor(() => expect(
      fetchSpy.mock.calls.some(([u]) => String(u).includes('q=flaky-test-hunt')),
    ).toBe(true))

    // Row 1 of the rail is neither Home's filtered cursor (r_5c1d9a30) nor its unfiltered
    // one (r_2f91c4a8), so this assertion cannot pass by accident either way.
    rows[1]!.focus()
    fireEvent.keyDown(rows[1]!, { key: 'Enter' })
    await waitFor(() => expect(window.location.hash).toBe(`#/run/${RUNS[1]!.runId}`))
  })

  it('moves only the rail on the rail\'s j/k — Home\'s cursor stays where it was', async () => {
    const { rows } = await mountShell()
    // Home's cursor: row 1, moved by a key aimed at the page (nothing focused).
    fireEvent.keyDown(window, { key: 'j' })

    // The rail's cursor: row 3, then `k` → row 2. If Home also processed that `k`, its own
    // cursor would have gone 1 → 0.
    rows[3]!.focus()
    await waitFor(() => expect(railCursor(rows)).toBe(3))
    fireEvent.keyDown(rows[3]!, { key: 'k' })
    await waitFor(() => expect(railCursor(rows)).toBe(2))

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(window.location.hash).toBe(`#/run/${RUNS[1]!.runId}`)
  })

  it('still answers page-level keys while focus sits in the rail (§2.7)', async () => {
    // The scope rule is about the SELECTION keys two lists share. `/` and `a` move focus to
    // a named place on the page and have no rail equivalent, so they stay page-wide — the
    // fix must not have turned them off wherever focus happens to be.
    const { rows } = await mountShell()
    rows[2]!.focus()
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(screen.getByLabelText('Filter by name or run id'))
  })
})

describe('the router outlet', () => {
  it('renders Home at #/ with the run rail beside it', async () => {
    vi.stubGlobal('fetch', stubFetch())
    render(<App />)
    await screen.findByRole('heading', { name: 'Runs' })
    expect(screen.getByRole('navigation', { name: 'Runs' })).toBeTruthy()
  })

  // W11 replaced this route's placeholder with the real cockpit; the assertion that used
  // to prove "an unbuilt route is named, never blank" now proves the built one mounts in
  // its real context. W15 did the same for `#/run/:id/result` — there is no unbuilt route
  // left in §2.2's grammar, so the placeholder component is gone with them.
  it('renders the run cockpit at #/run/:id, with the rail beside it', async () => {
    window.history.replaceState(null, '', '/#/run/r_a03d51e7')
    resetRouteForTests()
    vi.stubGlobal('fetch', stubFetch())
    render(<App />)
    await screen.findByRole('tablist', { name: 'Cockpit views' })
    expect(screen.getByRole('navigation', { name: 'Runs' })).toBeTruthy()
  })

  it('renders the §2.6 result view at #/run/:id/result, with the rail beside it', async () => {
    window.history.replaceState(null, '', '/#/run/r_2f91c4a8/result')
    resetRouteForTests()
    vi.stubGlobal('fetch', stubFetch())
    render(<App />)
    await screen.findByRole('heading', { name: 'Result', level: 1 })
    expect(screen.queryByText(/lands in W12/)).toBeNull()
    // The rail is still there, so the reviewer sees it in its real context.
    expect(screen.getByRole('navigation', { name: 'Runs' })).toBeTruthy()
  })

  it('rejects a hash outside the §2.2 grammar', async () => {
    window.history.replaceState(null, '', '/#/nonsense')
    resetRouteForTests()
    vi.stubGlobal('fetch', stubFetch())
    render(<App />)
    await screen.findByText('No such screen')
  })
})
