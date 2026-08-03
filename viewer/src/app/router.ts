// DESIGN §2.2 — ONE hash grammar everywhere: `#<route>?<params>`.
//
// Three params are reserved and stripped BEFORE route matching:
//   t  read token (§7.1.2)  →  sessionStorage, then scrubbed from the URL bar
//   c  control token        →  same
//   a  compare-panel agent (§2.5) — a route param, not part of the path
//
// Hash routing means the server needs no SPA fallback (parity #26), and fragments are
// never sent over the network, which is why the CLI can print a token in one at all.
//
// No react-router: three routes do not justify a dependency (§9.1). The store is a
// `useSyncExternalStore` source over `hashchange`.

import { setControlToken, setToken } from '../api/client.js'

export type Route =
  | { name: 'home'; params: URLSearchParams }
  | { name: 'run'; runId: string; params: URLSearchParams }
  | { name: 'agent'; runId: string; agentIndex: number; compare: number | null; params: URLSearchParams }
  | { name: 'result'; runId: string; params: URLSearchParams }
  | { name: 'notfound'; path: string; params: URLSearchParams }

export const RESERVED_PARAMS = ['t', 'c', 'a'] as const

const CANONICAL_INT = /^(0|[1-9][0-9]*)$/

/**
 * `decodeURIComponent`, but a malformed escape is a NOT-FOUND, not a crash.
 *
 * `#/run/%` is a hash any operator can produce by hand-editing the URL bar or by following
 * a truncated link, and `decodeURIComponent('%')` throws `URIError`. That throw happened
 * inside `routeSnapshot`, i.e. inside React's `useSyncExternalStore` read — so it did not
 * degrade to the not-found screen this file already has, it took the render down. §6.5's
 * "nothing throws" applies to the URL as much as to a payload.
 */
function decodeSegment(seg: string): string | null {
  try { return decodeURIComponent(seg) } catch { return null }
}

/** Split `#/run/x?a=3` into its path and its params, tolerating a missing leading `#`. */
export function splitHash(hash: string): { path: string; params: URLSearchParams } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const q = raw.indexOf('?')
  const path = q === -1 ? raw : raw.slice(0, q)
  const params = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1))
  return { path: path || '/', params }
}

/** Match a path (reserved params already removed) to a route. Pure. */
export function matchRoute(path: string, params: URLSearchParams): Route {
  const compare = (() => {
    const a = params.get('a')
    return a != null && CANONICAL_INT.test(a) ? Number(a) : null
  })()
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--
  const clean = path.slice(0, end) || '/'
  const seg = clean.split('/').filter(Boolean)

  if (seg.length === 0) return { name: 'home', params }
  if (seg[0] === 'run' && seg[1]) {
    const runId = decodeSegment(seg[1])
    if (runId != null) {
      if (seg.length === 2) return { name: 'run', runId, params }
      if (seg.length === 3 && seg[2] === 'result') return { name: 'result', runId, params }
      const index = seg[3]
      if (seg.length === 4 && seg[2] === 'agent' && index !== undefined && CANONICAL_INT.test(index)) {
        return { name: 'agent', runId, agentIndex: Number(index), compare, params }
      }
    }
  }
  return { name: 'notfound', path: clean, params }
}

/**
 * Consume the reserved params from a hash: stash the tokens and return the hash to
 * rewrite the URL to, or `null` when nothing needed stripping.
 *
 * Split out from `readRoute` so the credential handling is testable without a DOM.
 */
export function consumeReserved(hash: string): { rest: string; stripped: boolean } {
  const { path, params } = splitHash(hash)
  const t = params.get('t')
  const c = params.get('c')
  if (t) setToken(t)
  if (c) setControlToken(c)
  const stripped = params.has('t') || params.has('c')
  params.delete('t')
  params.delete('c')
  const qs = params.toString()
  return { rest: `#${path}${qs ? `?${qs}` : ''}`, stripped }
}

/**
 * Read the current route, having first moved any tokens out of the URL.
 *
 * The rewrite happens via `history.replaceState` BEFORE any route renders (§2.2), so a
 * token never reaches the URL bar's visible state, a copied link, or the back stack.
 */
export function readRoute(): Route {
  if (typeof window === 'undefined') return { name: 'home', params: new URLSearchParams() }
  const { rest, stripped } = consumeReserved(window.location.hash)
  if (stripped) {
    const url = `${window.location.pathname}${window.location.search}${rest === '#/' ? '#/' : rest}`
    window.history.replaceState(null, '', url)
  }
  const { path, params } = splitHash(window.location.hash || '#/')
  return matchRoute(path, params)
}

// ---- the store ---------------------------------------------------------------------

let current: Route | null = null
const listeners = new Set<() => void>()

function refresh() {
  current = readRoute()
  for (const fn of listeners) fn()
}

export function subscribeRoute(fn: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('hashchange', refresh)
  }
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('hashchange', refresh)
    }
  }
}

export function routeSnapshot(): Route {
  if (!current) current = readRoute()
  return current
}

/** Test seam: forget the memoized route between cases. */
export function resetRouteForTests() { current = null }

export function navigate(to: string) {
  if (typeof window === 'undefined') return
  const next = to.startsWith('#') ? to : `#${to}`
  if (window.location.hash === next) return
  window.location.hash = next
}

/** Build an in-app link. Always through here, so the grammar has one author. */
export const href = {
  home: () => '#/',
  run: (runId: string) => `#/run/${encodeURIComponent(runId)}`,
  agent: (runId: string, index: number) => `#/run/${encodeURIComponent(runId)}/agent/${index}`,
  result: (runId: string) => `#/run/${encodeURIComponent(runId)}/result`,
}

/** The run a route is "about", for the rail's active marking (parity #39). */
export function routeRunId(route: Route): string | null {
  return route.name === 'run' || route.name === 'agent' || route.name === 'result'
    ? route.runId
    : null
}
