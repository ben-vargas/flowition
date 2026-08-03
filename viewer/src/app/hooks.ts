// Hand-rolled data hooks (§9.1: no react-query — SSE is hand-rolled anyway, and the
// caching story is the server's, not the client's).
//
// `usePoll` is the CORRECTNESS FLOOR of §5.5: the run list and the run rail stay correct
// with no stream at all. W9's SSE client is a latency optimization layered on top; it
// does not replace this.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, type RunsQuery } from '../api/client.js'
import type { RunSummary, RunsPage } from '../api/types.js'
import { routeSnapshot, subscribeRoute, type Route } from './router.js'
import { currentTheme, subscribeTheme } from '../theme/theme.js'

export function useRoute(): Route {
  return useSyncExternalStore(subscribeRoute, routeSnapshot, routeSnapshot)
}

export function useTheme() {
  return useSyncExternalStore(
    (fn) => subscribeTheme(() => fn()),
    currentTheme,
    () => 'dark' as const,
  )
}

/**
 * A number that increments whenever the ELEMENTS of `values` change (`Object.is` per slot),
 * so a freshly-built array can key an effect without spreading into its dependency list.
 *
 * Mutating a ref during render is safe here because it is idempotent in the input: a
 * repeated render with unchanged values compares equal and does not increment, which is
 * what makes it survive React's double-invoked renders in development.
 */
function useCounter(values: unknown[]): number {
  const held = useRef<{ values: unknown[]; n: number }>({ values, n: 0 })
  if (
    held.current.values.length !== values.length
    || held.current.values.some((v, i) => !Object.is(v, values[i]))
  ) {
    held.current = { values, n: held.current.n + 1 }
  }
  return held.current.n
}

export interface Poll<T> {
  data: T | null
  error: ApiError | null
  /**
   * True until the first settle **of the current request identity** — a refresh of the
   * same identity must not flash the skeleton back in, but a *different* question has no
   * answer yet and must not borrow the previous one's.
   */
  loading: boolean
  /** A poll is in flight over data we already have. */
  refreshing: boolean
  reload: () => void
}

/**
 * Fetch on mount, then again `intervalMs` after each poll SETTLES, plus on demand.
 *
 * `deps` is the identity of the request: change it and the hook drops its data and
 * shows the loading state again, because the old rows answer a different question.
 *
 * **The drop is SYNCHRONOUS with the render that changed `deps`**, keyed off a generation
 * counter rather than performed by the effect. Effects run after paint, so a version that
 * cleared in the effect still committed one frame of the old answer under the new
 * question: click Home's `failed` chip and the *running* rows it had already fetched
 * rendered beneath it, indistinguishable from a real result. Worse, if the new request
 * then failed, `setState((s) => ({ data: s.data, … }))` — the deliberate keep-last-good
 * path below — preserved those foreign rows behind the error banner INDEFINITELY. Both
 * defects are the same missing distinction: last-good data belongs to an identity, and is
 * only good for refreshes of that identity.
 *
 * `reload()` and the interval are the same identity by construction, so they keep their
 * rows; only a `deps` change is a new question.
 *
 * `refresh` is the third case, and it is why `deps` alone is not enough: a value that must
 * re-run the request while KEEPING what is on screen, because it widens the same question
 * instead of replacing it. `usePagedRuns`'s page depth is the only one — "Load more" asks
 * for a superset of rows the operator is already reading, and blanking the table to a
 * skeleton in order to append to it would be a worse bug than the one this identity
 * machinery exists to fix.
 *
 * **Serialized, not scheduled.** The interval is a gap between polls, never a fixed
 * cadence that fires whether or not the last one came back. `usePagedRuns` below drives
 * this hook with an EXHAUSTIVE scan — up to `SCAN_PAGE_BUDGET` sequential requests over a
 * disk with thousands of runs — and a `setInterval` at 2s over a scan that takes longer
 * than 2s produces three defects at once: overlapping scans multiplying the server's
 * work, a backlog that grows without bound while the disk stays slow, and out-of-order
 * settling in which an older scan's rows overwrite a newer scan's. So the next poll is
 * scheduled by the previous one's `finally`, and exactly one is ever in flight.
 *
 * **A cadence change re-times the next gap; it never restarts the request.** `intervalMs`
 * is deliberately NOT an effect dependency. Home slows its stale scan to 10 s while the
 * run rail polls at 5 s, and those values move with the route and with the tab's
 * visibility — if the request effect re-ran on them, every cadence change would abort a
 * scan that may be twenty pages deep and start it again from page one, which is both a
 * request storm and (for the operator) a table that blanks for no reason. So the interval
 * is read from a ref at scheduling time, and a change while a poll is in flight is simply
 * what the NEXT gap uses. A change while the poller is idle re-arms the pending timer
 * against the same settle instant, so shortening 10 s → 2 s after 3 s have already elapsed
 * fires immediately rather than waiting a further 2 s, and lengthening never fires early.
 * `intervalMs: 0` means "no successor" in both directions: it cancels a pending timer, and
 * raising it off zero arms one.
 *
 * **Generation guard.** `cancelled` is captured per effect run, so a response from a
 * superseded generation — a changed `deps`, a `reload()`, an unmount — is dropped rather
 * than written, even if its fetcher ignored the abort signal and settled late. Aborting
 * is the fast path; the closure is what makes the guarantee.
 */
export function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  { intervalMs = 2000, deps = [] as unknown[], refresh = [] as unknown[], enabled = true } = {},
): Poll<T> {
  // The request identity and the refresh trigger, each as a monotonic counter derived
  // during render. Neither array can be compared by reference — both are freshly built
  // every render — so their ELEMENTS are compared, exactly as an effect dependency list
  // reads them. A counter rather than a spread keeps the effect's dependency list a fixed
  // length, which a variable-length spread is not.
  const gen = useCounter(deps)
  const refreshTick = useCounter(refresh)

  interface Snapshot { gen: number; data: T | null; error: ApiError | null; loading: boolean; refreshing: boolean }
  const blank = (g: number): Snapshot =>
    ({ gen: g, data: null, error: null, loading: enabled, refreshing: false })
  const [snap, setSnap] = useState<Snapshot>(() => blank(gen))
  const [nonce, setNonce] = useState(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // The cadence, and a handle onto the idle poller's pending timer. `armed` is non-null
  // exactly while a poll has settled and its successor is waiting; during a request it is
  // null, which is what makes a cadence change mid-flight a no-op on the request itself.
  const intervalRef = useRef(intervalMs)
  const armed = useRef<((ms: number) => void) | null>(null)

  useEffect(() => {
    if (intervalRef.current === intervalMs) return
    intervalRef.current = intervalMs
    armed.current?.(intervalMs)
  }, [intervalMs])

  useEffect(() => {
    if (!enabled) {
      setSnap({ gen, data: null, error: null, loading: false, refreshing: false })
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // The instant the last poll settled — the gap is measured from here, so re-arming at a
    // new cadence credits the time already waited instead of restarting the clock.
    let settledAt = 0
    const controller = new AbortController()

    const arm = (ms: number) => {
      if (timer) { clearTimeout(timer); timer = null }
      if (cancelled || ms <= 0) return
      timer = setTimeout(() => { timer = null; void run() }, Math.max(0, settledAt + ms - Date.now()))
    }
    // Adopt this generation. Same identity → keep the rows and skip the skeleton; new
    // identity → start from nothing, because there is nothing yet that answers it.
    setSnap((s) => (s.gen === gen
      ? { ...s, loading: s.data == null }
      : { gen, data: null, error: null, loading: true, refreshing: false }))

    const run = async () => {
      if (cancelled) return
      // In flight: there is no gap to re-time, so a cadence change must not touch this
      // request. The `finally` below picks the new value up for the successor.
      armed.current = null
      setSnap((s) => (s.gen === gen ? { ...s, refreshing: true } : s))
      try {
        const data = await fetcherRef.current(controller.signal)
        if (!cancelled) setSnap({ gen, data, error: null, loading: false, refreshing: false })
      } catch (err) {
        if (cancelled || (err as Error)?.name === 'AbortError') return
        const apiErr = err instanceof ApiError
          ? err
          : new ApiError(0, 'unreachable', String((err as Error)?.message ?? err))
        // Keep the last good data on screen behind the banner: an operator watching a
        // live run should not lose the table because one poll missed. Only ever this
        // generation's data, though — see the identity note in the doc comment.
        setSnap((s) => ({
          gen,
          data: s.gen === gen ? s.data : null,
          error: apiErr,
          loading: false,
          refreshing: false,
        }))
      } finally {
        // The next tick belongs here, after the settle. A poll that is still running has
        // not earned a successor. (`refreshing` is cleared by the writes above, which
        // must land in the same update as the data they describe.)
        if (!cancelled) {
          settledAt = Date.now()
          armed.current = arm
          arm(intervalRef.current)
        }
      }
    }

    void run()
    return () => {
      cancelled = true
      controller.abort()
      if (timer) clearTimeout(timer)
      armed.current = null
    }
    // `intervalMs` is excluded on purpose — see the cadence note in the doc comment. It is
    // read through `intervalRef` at scheduling time and re-armed by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, gen, refreshTick])

  // Between the render that changed `deps` and the effect that adopts the new generation,
  // `snap` still describes the OLD question. Read through it rather than out of it.
  const current = snap.gen === gen ? snap : blank(gen)
  return {
    data: current.data,
    error: current.error,
    loading: current.loading,
    refreshing: current.refreshing,
    reload,
  }
}

// ---- keyset pagination (§5.4.2) -------------------------------------------------------

/** §5.4.2's page ceiling. A request for more than this is a 400, never a bigger page. */
export const RUNS_LIMIT_MAX = 200
/** §5.4.2's default page — what the run table asks for per "Load more". */
export const RUNS_LIMIT_DEFAULT = 50
/**
 * A full scan gives up after this many pages (25 × 200 = 5,000 runs — §10's P2 fixture
 * size) and reports `truncated`, so a pathological disk degrades into a visible partial
 * answer rather than an unbounded request storm.
 */
export const SCAN_PAGE_BUDGET = 25

export interface PagedRunsQuery {
  /** RunState names only — §5.4.2 rejects anything else. */
  state?: string | null
  q?: string | null
  limit?: number
}

export interface PagedRuns {
  runs: RunSummary[]
  totalOnDisk: number | null
  /**
   * Every page this query matches has been consumed, so counts derived from `runs` are
   * EXACT. Anything the UI states as a number must be gated on this.
   */
  complete: boolean
  /** Unfetched pages remain (either unrequested, or past the scan budget). */
  hasMore: boolean
  /** The scan hit `SCAN_PAGE_BUDGET`; `runs` is a prefix and the UI must say so. */
  truncated: boolean
  /** Pages already pulled — `loadMore()` asks for one more. */
  pages: number
  loadMore: () => void
  loading: boolean
  refreshing: boolean
  error: ApiError | null
  reload: () => void
}

interface Accum {
  runs: RunSummary[]
  totalOnDisk: number | null
  complete: boolean
  truncated: boolean
}

/**
 * §5.4.2's cursor contract, client side.
 *
 * The listing is KEYSET-paginated over `(createdAt, runId)`: the only legal way to see
 * more rows is to pass the previous page's `nextCursor` back. Enlarging `limit` instead
 * is wrong twice over — it 400s the moment it passes 200, and it re-slices from the top
 * on every poll, so a run created mid-scroll shifts the window (the very instability the
 * keyset design exists to prevent). This hook therefore *accumulates pages*: page 1, then
 * each subsequent page by cursor, deduped by runId (a run appended between two page
 * fetches can otherwise surface in both).
 *
 * `scan: true` walks to exhaustion (bounded by `SCAN_PAGE_BUDGET`). That is what a
 * client-side predicate like "blocked" — which §5.4.2 has no server filter for — requires
 * to be honest: filtering the first page only answers a different, smaller question.
 */
export function usePagedRuns(
  load: (query: RunsQuery) => Promise<RunsPage>,
  query: PagedRunsQuery,
  { intervalMs = 2000, scan = false, enabled = true } = {},
): PagedRuns {
  const limit = Math.min(query.limit ?? RUNS_LIMIT_DEFAULT, RUNS_LIMIT_MAX)
  const state = query.state ?? null
  const q = query.q ?? null

  // Paging depth is per-question: change the filter and the depth resets to one page,
  // synchronously (an effect would fire one wasted deep request first).
  //
  // `JSON.stringify` rather than a joined string because `q` is operator free text: any
  // separator character it can contain makes two different questions collide on one key,
  // and the one character it cannot contain is NUL — which is what this used to use, at
  // the cost of making the file BINARY to git, so the hook at the centre of this unit
  // showed up in review as `Bin 11307 bytes`, with no diff at all.
  const key = JSON.stringify([limit, state, q])
  const [paging, setPaging] = useState({ key, pages: 1 })
  const pages = paging.key === key ? paging.pages : 1
  const loadMore = useCallback(
    () => setPaging((p) => ({ key, pages: (p.key === key ? p.pages : 1) + 1 })),
    [key],
  )

  const want = scan ? SCAN_PAGE_BUDGET : pages

  const poll = usePoll<Accum>(async (signal) => {
    const runs: RunSummary[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    let totalOnDisk: number | null = null
    let fetched = 0
    let exhausted = false

    while (fetched < want) {
      const page = await load({ limit, cursor, state, q, signal })
      if (signal.aborted) break
      if (page?.totalOnDisk != null) totalOnDisk = page.totalOnDisk
      for (const run of page?.runs ?? []) {
        if (run && !seen.has(run.runId)) { seen.add(run.runId); runs.push(run) }
      }
      fetched++
      cursor = page?.nextCursor ?? null
      if (!cursor) { exhausted = true; break }
    }
    // Truncation is a SCAN failure mode only: a paged table that has not been asked for
    // its next page is merely `hasMore`, not truncated.
    return { runs, totalOnDisk, complete: exhausted, truncated: scan && !exhausted }
    // Depth is a `refresh`, not part of the identity: "Load more" widens THIS question, so
    // the rows already on screen stay while the deeper scan runs. The filter and the page
    // size are the identity — those replace the question, and the old rows are then wrong
    // answers that must not render under the new one.
  }, { intervalMs, enabled, deps: [limit, state, q], refresh: [want] })

  const data = poll.data
  return {
    runs: data?.runs ?? [],
    totalOnDisk: data?.totalOnDisk ?? null,
    complete: data?.complete ?? false,
    hasMore: data ? !data.complete : false,
    truncated: data?.truncated ?? false,
    pages,
    loadMore,
    loading: poll.loading,
    refreshing: poll.refreshing,
    error: poll.error,
    reload: poll.reload,
  }
}

/** A value that lags its input by `ms`, for the free-text filter (§2.3). */
export function useDebounced<T>(value: T, ms = 220): T {
  const [held, setHeld] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setHeld(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return held
}

/** A 1 Hz clock for elapsed timers and spend tickers; frozen values never subscribe. */
export function useTick(enabled: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [enabled, ms])
  return now
}

/** localStorage-backed UI state (rail collapse #41, rail width #43). */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? initial : JSON.parse(raw) as T
    } catch { return initial }
  })
  const set = useCallback((v: T) => {
    setValue(v)
    try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* private mode */ }
  }, [key])
  return [value, set]
}

/** `window.matchMedia`, as a hook. Drives the <900px drawer rules (§3.3, parity #42). */
export function useMedia(query: string, fallback = false): boolean {
  const subscribe = useCallback((fn: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
    const m = window.matchMedia(query)
    m.addEventListener?.('change', fn)
    return () => m.removeEventListener?.('change', fn)
  }, [query])
  const read = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback
    return window.matchMedia(query).matches
  }, [query, fallback])
  return useSyncExternalStore(subscribe, read, () => fallback)
}
