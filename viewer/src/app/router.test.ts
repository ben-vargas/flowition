// @vitest-environment jsdom
//
// DESIGN §2.2's hash grammar. The security-relevant half is the reserved-parameter
// handling: a token must reach sessionStorage and leave the URL bar BEFORE any route
// renders, and a rejected token must not loop (critique M7 / Sol-6).

import { beforeEach, describe, expect, it } from 'vitest'
import {
  consumeReserved, href, matchRoute, readRoute, resetRouteForTests, routeRunId,
  routeSnapshot, splitHash,
} from './router.js'
import { CONTROL_TOKEN_KEY, TOKEN_KEY, clearTokens, getControlToken, getToken } from '../api/client.js'

const at = (hash: string) => {
  window.history.replaceState(null, '', `/${hash}`)
  resetRouteForTests()
}

beforeEach(() => {
  clearTokens()
  sessionStorage.clear()
  at('#/')
})

describe('splitHash / matchRoute', () => {
  it('parses the four §2.2 routes', () => {
    const m = (h: string) => { const { path, params } = splitHash(h); return matchRoute(path, params) }
    expect(m('#/')).toMatchObject({ name: 'home' })
    expect(m('#/run/r_2f91c4a8')).toMatchObject({ name: 'run', runId: 'r_2f91c4a8' })
    expect(m('#/run/r_2f91c4a8/agent/3')).toMatchObject({ name: 'agent', runId: 'r_2f91c4a8', agentIndex: 3 })
    expect(m('#/run/r_2f91c4a8/result')).toMatchObject({ name: 'result', runId: 'r_2f91c4a8' })
  })

  it('treats an empty, bare or trailing-slash hash as Home', () => {
    for (const h of ['', '#', '#/', '#//']) {
      const { path, params } = splitHash(h)
      expect(matchRoute(path, params).name, h).toBe('home')
    }
  })

  it('reads `a` as the compare panel (§2.5), canonical integers only', () => {
    const m = (h: string) => { const { path, params } = splitHash(h); return matchRoute(path, params) }
    expect(m('#/run/x/agent/1?a=3')).toMatchObject({ compare: 3 })
    expect(m('#/run/x/agent/1?a=03')).toMatchObject({ compare: null })
    expect(m('#/run/x/agent/1?a=-1')).toMatchObject({ compare: null })
    expect(m('#/run/x/agent/1')).toMatchObject({ compare: null })
  })

  it('rejects a non-canonical agent index rather than guessing', () => {
    const m = (h: string) => { const { path, params } = splitHash(h); return matchRoute(path, params) }
    expect(m('#/run/x/agent/03').name).toBe('notfound')
    expect(m('#/run/x/agent/1e2').name).toBe('notfound')
    expect(m('#/run/x/agent/-1').name).toBe('notfound')
    expect(m('#/nope').name).toBe('notfound')
  })

  it('degrades a MALFORMED percent escape to not-found instead of throwing', () => {
    // `#/run/%` is one keystroke away in the URL bar, and `decodeURIComponent('%')` throws
    // `URIError`. That throw happened inside `routeSnapshot` — i.e. inside React's
    // `useSyncExternalStore` read — so it did not produce the not-found screen this file
    // already has, it took the whole render down (review round 4).
    const m = (h: string) => { const { path, params } = splitHash(h); return matchRoute(path, params) }
    for (const bad of ['#/run/%', '#/run/%zz', '#/run/%E0%A4%A', '#/run/%/result', '#/run/%/agent/1']) {
      expect(() => m(bad), bad).not.toThrow()
      expect(m(bad).name, bad).toBe('notfound')
    }
    // A WELL-FORMED escape still decodes — the guard must not have turned decoding off.
    expect(m('#/run/a%2Fb')).toMatchObject({ name: 'run', runId: 'a/b' })
  })

  it('keeps the route store readable when the hash cannot be decoded', () => {
    at('#/run/%')
    expect(() => readRoute()).not.toThrow()
    expect(routeSnapshot().name).toBe('notfound')
  })

  it('handles attacker-controlled slash runs with linear scaling', () => {
    const timedMatch = (slashes: number) => {
      const path = `${'/'.repeat(slashes)}x`
      const started = performance.now()
      expect(matchRoute(path, new URLSearchParams())).toMatchObject({
        name: 'notfound',
        path,
      })
      return performance.now() - started
    }

    timedMatch(2_000)
    timedMatch(20_000)
    const largeElapsed = timedMatch(80_000)
    // Absolute bound only. A small/large wall-clock RATIO here was noise-dominated
    // (the 20k baseline lands ~0.3ms, so one GC pause in the 80k call flaked the
    // suite 1-in-10 under full parallel load) — while this absolute gate already
    // fails by ~two orders of magnitude against the quadratic pre-fix regex.
    expect(largeElapsed).toBeLessThan((process.env.CI ? 3 : 1) * 250)
  }, 10_000)

  it('round-trips run ids that need encoding, including path separators', () => {
    // `--run-id` accepts more than `flo_…`, so the grammar has to survive spaces and a
    // slash: `href.run` percent-encodes, and the matcher decodes exactly once. A `/` that
    // stayed literal would silently become a second path segment and mis-route.
    for (const runId of ['flo_abc', 'my run', 'a/b', 'a?b', 'a#b', 'a%2e%2e']) {
      const { path, params } = splitHash(href.run(runId))
      expect(matchRoute(path, params), runId).toMatchObject({ name: 'run', runId })
    }
  })
})

describe('reserved parameters', () => {
  it('moves `t` into sessionStorage and strips it from the hash', () => {
    const { rest, stripped } = consumeReserved('#/?t=SECRET')
    expect(stripped).toBe(true)
    expect(rest).toBe('#/')
    expect(getToken()).toBe('SECRET')
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('SECRET')
    expect(rest).not.toContain('SECRET')
  })

  it('moves `c` too, and keeps every non-reserved parameter', () => {
    const { rest } = consumeReserved('#/run/x/agent/1?t=T&c=C&a=3&keep=yes')
    expect(getControlToken()).toBe('C')
    expect(rest).toContain('a=3')
    expect(rest).toContain('keep=yes')
    expect(rest).not.toContain('t=')
    expect(rest).not.toContain('c=')
  })

  it('rewrites the URL bar via replaceState BEFORE the route is returned', () => {
    at('#/run/r1?t=SECRET')
    const before = window.history.length
    const route = readRoute()
    expect(route).toMatchObject({ name: 'run', runId: 'r1' })
    expect(window.location.hash).toBe('#/run/r1')
    expect(window.location.href).not.toContain('SECRET')
    // replaceState, not pushState: the token must not sit in the back stack either.
    expect(window.history.length).toBe(before)
    expect(getToken()).toBe('SECRET')
  })

  it('leaves a token-free hash untouched', () => {
    at('#/run/r1?a=2')
    readRoute()
    expect(window.location.hash).toBe('#/run/r1?a=2')
  })

  it('does not loop when the token is later rejected', () => {
    // The 401 path clears sessionStorage (client.ts). Reading the route again must NOT
    // resurrect the token from the URL, because it was already scrubbed.
    at('#/?t=SECRET')
    readRoute()
    clearTokens()
    resetRouteForTests()
    expect(readRoute().name).toBe('home')
    expect(getToken()).toBeNull()
    expect(sessionStorage.getItem(CONTROL_TOKEN_KEY)).toBeNull()
  })
})

describe('href / routeRunId', () => {
  it('builds every in-app link through one author', () => {
    expect(href.home()).toBe('#/')
    expect(href.run('r1')).toBe('#/run/r1')
    expect(href.agent('r1', 2)).toBe('#/run/r1/agent/2')
    expect(href.result('r1')).toBe('#/run/r1/result')
  })

  it('names the run a route is about, for the rail active marking (#39)', () => {
    const m = (h: string) => { const { path, params } = splitHash(h); return matchRoute(path, params) }
    expect(routeRunId(m('#/'))).toBeNull()
    expect(routeRunId(m('#/run/r1'))).toBe('r1')
    expect(routeRunId(m('#/run/r1/agent/0'))).toBe('r1')
    expect(routeRunId(m('#/run/r1/result'))).toBe('r1')
  })
})
