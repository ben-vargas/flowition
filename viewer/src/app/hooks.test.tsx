// @vitest-environment jsdom
//
// `usePoll` is §5.5's correctness floor: the run list and the run rail stay right with no
// stream at all. These cases pin the two properties that make a poller safe rather than
// merely periodic — SERIALIZATION (never more than one request out) and GENERATION
// ORDERING (a superseded response can never overwrite a newer one).
//
// They matter here specifically because `usePagedRuns` drives this hook with an
// exhaustive scan: up to SCAN_PAGE_BUDGET sequential requests. On a big disk that scan
// outlives the 2s interval, which is exactly when a naive `setInterval` poller starts
// overlapping, backing up, and settling out of order.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import { usePoll } from './hooks.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
  signal: AbortSignal | null
}

/** A fetcher whose every call hangs until the test decides how it ends. */
function gatedFetcher<T>() {
  const gates: Deferred<T>[] = []
  const fetcher = vi.fn((signal: AbortSignal) => {
    const gate: Deferred<T> = { signal } as Deferred<T>
    gate.promise = new Promise<T>((res, rej) => { gate.resolve = res; gate.reject = rej })
    gates.push(gate)
    return gate.promise
  })
  return { fetcher, gates }
}

/** Let the microtask queue drain and any due timers fire, inside act(). */
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('usePoll serialization (§5.5)', () => {
  it('keeps at most ONE poll in flight, however long a poll outlives the interval', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    renderHook(() => usePoll(fetcher, { intervalMs: 100 }))

    expect(fetcher).toHaveBeenCalledTimes(1)

    // Ten intervals elapse while the first scan is still out. A setInterval poller would
    // now have eleven requests open and a queue behind them.
    await settle(1000)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Settling does not immediately re-fire either: the interval is the GAP after a poll.
    await act(async () => { gates[0]!.resolve('page one') })
    expect(fetcher).toHaveBeenCalledTimes(1)

    await settle(100)
    expect(fetcher).toHaveBeenCalledTimes(2)

    // …and the successor is subject to the same rule — no backlog accumulated behind it.
    await settle(1000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('schedules the next poll after a FAILED one too — a dead API is retried, not abandoned', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { result } = renderHook(() => usePoll(fetcher, { intervalMs: 100 }))

    await act(async () => { gates[0]!.reject(new ApiError(0, 'unreachable', 'gone')) })
    expect(result.current.error?.unreachable).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await settle(100)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('drops a superseded response — an obsolete scan cannot overwrite newer rows', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => usePoll(fetcher, { intervalMs: 0, deps: [q] }),
      { initialProps: { q: 'first' } },
    )
    expect(fetcher).toHaveBeenCalledTimes(1)

    // The question changes while generation 1 is still out.
    rerender({ q: 'second' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    // The superseded generation is told to stop; the guarantee below does not depend on
    // its fetcher honouring that.
    expect(gates[0]!.signal?.aborted).toBe(true)
    expect(gates[1]!.signal?.aborted).toBe(false)

    await act(async () => { gates[1]!.resolve('rows for second') })
    expect(result.current.data).toBe('rows for second')

    // Generation 1 settles LATE, with the answer to a question nobody is asking any more.
    await act(async () => { gates[0]!.resolve('rows for first') })
    expect(result.current.data).toBe('rows for second')
  })

  it('drops a superseded FAILURE too — a stale error cannot raise a banner over fresh data', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => usePoll(fetcher, { intervalMs: 0, deps: [q] }),
      { initialProps: { q: 'first' } },
    )
    rerender({ q: 'second' })
    await act(async () => { gates[1]!.resolve('rows for second') })

    await act(async () => { gates[0]!.reject(new ApiError(0, 'unreachable', 'gone')) })
    expect(result.current.error).toBeNull()
    expect(result.current.data).toBe('rows for second')
  })

  it('stops entirely on unmount — no timer survives to fire a poll into a dead tree', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { unmount } = renderHook(() => usePoll(fetcher, { intervalMs: 100 }))
    await act(async () => { gates[0]!.resolve('page one') })
    expect(fetcher).toHaveBeenCalledTimes(1)

    unmount()
    await settle(1000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

// The other half of generation ordering, and the one review round 4 missed: a superseded
// response is dropped, but the superseded DATA was still being displayed. `deps` is the
// identity of the request, so rows fetched for the old question must not render under the
// new one for even one frame — Home's filter chips are the case that bites, where the old
// rows look exactly like a legitimate (and wrong) answer to the newly selected chip.
describe('usePoll request identity (§9.3)', () => {
  it('drops the old rows SYNCHRONOUSLY when deps change, before the new request settles', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => usePoll(fetcher, { intervalMs: 0, deps: [q] }),
      { initialProps: { q: 'running' } },
    )
    await act(async () => { gates[0]!.resolve('the running rows') })
    expect(result.current.data).toBe('the running rows')
    expect(result.current.loading).toBe(false)

    // The operator picks a different chip. The answer to THAT question is still in flight.
    act(() => { rerender({ q: 'failed' }) })
    expect(result.current.data).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(true)

    // Still nothing, however long the new request takes.
    await settle(5000)
    expect(result.current.data).toBeNull()

    await act(async () => { gates[1]!.resolve('the failed rows') })
    expect(result.current.data).toBe('the failed rows')
    expect(result.current.loading).toBe(false)
  })

  it('does not resurrect the old rows when the new request FAILS', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => usePoll(fetcher, { intervalMs: 0, deps: [q] }),
      { initialProps: { q: 'running' } },
    )
    await act(async () => { gates[0]!.resolve('the running rows') })

    act(() => { rerender({ q: 'failed' }) })
    await act(async () => { gates[1]!.reject(new ApiError(0, 'unreachable', 'gone')) })

    // The keep-last-good path must not reach across identities: an unreachable API under
    // the `failed` chip shows a banner over NOTHING, never over the running rows. Before
    // the fix these rows stayed on screen indefinitely, mislabelled by the chip.
    expect(result.current.error?.unreachable).toBe(true)
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('keeps the last good rows across a reload() — same question', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { result } = renderHook(() => usePoll(fetcher, { intervalMs: 100, deps: ['running'] }))
    await act(async () => { gates[0]!.resolve('the running rows') })

    act(() => { result.current.reload() })
    expect(result.current.data).toBe('the running rows')   // no skeleton flash
    expect(result.current.loading).toBe(false)

    // …and a FAILED refresh of the same question still keeps them, behind the banner.
    await act(async () => { gates[1]!.reject(new ApiError(0, 'unreachable', 'gone')) })
    expect(result.current.data).toBe('the running rows')
    expect(result.current.error?.unreachable).toBe(true)
  })

  it('keeps the last good rows when an INTERVAL poll fails — the timer path, not reload()', async () => {
    // The path an operator actually hits: nobody touches the page, the viewer goes away,
    // and the poll the TIMER fired is the one that errors. Distinct from the reload() case
    // above because that request is started by an effect re-run under a new `nonce`, while
    // this one is started from inside the previous poll's `finally` — a different code path
    // through the same identity check.
    const { fetcher, gates } = gatedFetcher<string>()
    const { result } = renderHook(() => usePoll(fetcher, { intervalMs: 100, deps: ['running'] }))
    await act(async () => { gates[0]!.resolve('the running rows') })
    expect(fetcher).toHaveBeenCalledTimes(1)

    await settle(100)                                       // the interval fires it
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.current.data).toBe('the running rows')    // still on screen while it runs
    expect(result.current.refreshing).toBe(true)

    await act(async () => { gates[1]!.reject(new ApiError(0, 'unreachable', 'gone')) })
    expect(result.current.error?.unreachable).toBe(true)
    expect(result.current.data).toBe('the running rows')
    expect(result.current.loading).toBe(false)

    // …and the poller has not given up: the next gap is still armed after the failure.
    await settle(100)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('treats `refresh` as a widening of the same question, not a new one', async () => {
    // `usePagedRuns` drives page depth through `refresh`: "Load more" appends to rows the
    // operator is already reading, so blanking the table to a skeleton in order to extend
    // it would trade one bug for another.
    const { fetcher, gates } = gatedFetcher<string>()
    const { result, rerender } = renderHook(
      ({ want }: { want: number }) => usePoll(fetcher, { intervalMs: 0, deps: ['running'], refresh: [want] }),
      { initialProps: { want: 1 } },
    )
    await act(async () => { gates[0]!.resolve('page 1') })

    act(() => { rerender({ want: 2 }) })
    expect(fetcher).toHaveBeenCalledTimes(2)          // the deeper scan did start
    expect(result.current.data).toBe('page 1')        // …over what is already on screen
    expect(result.current.loading).toBe(false)

    await act(async () => { gates[1]!.resolve('pages 1-2') })
    expect(result.current.data).toBe('pages 1-2')
  })

  it('does not abort or restart an IN-FLIGHT request when the interval changes', async () => {
    // Home slows its stale scan to 10 s and the run rail polls at 5 s; those values move
    // with the route and the tab's visibility. A cadence change is not a new question, and
    // if it re-ran the request effect it would abort a scan that may be twenty pages deep
    // and start it again from page one.
    const { fetcher, gates } = gatedFetcher<string>()
    const { rerender } = renderHook(
      ({ ms }: { ms: number }) => usePoll(fetcher, { intervalMs: ms, deps: ['running'] }),
      { initialProps: { ms: 2000 } },
    )
    expect(fetcher).toHaveBeenCalledTimes(1)

    // A genuinely DIFFERENT cadence, while generation 1 is still out.
    act(() => { rerender({ ms: 10000 }) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(gates).toHaveLength(1)
    expect(gates[0]!.signal?.aborted).toBe(false)   // the in-flight scan was left alone

    // It settles normally, and the successor uses the NEW cadence — not the old one.
    await act(async () => { gates[0]!.resolve('the running rows') })
    await settle(2000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await settle(8000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('re-times a PENDING gap when the interval changes, crediting the time already waited', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { rerender } = renderHook(
      ({ ms }: { ms: number }) => usePoll(fetcher, { intervalMs: ms, deps: ['running'] }),
      { initialProps: { ms: 10000 } },
    )
    await act(async () => { gates[0]!.resolve('the running rows') })

    // 3 s into a 10 s gap the operator focuses the tab and the cadence tightens to 2 s.
    await settle(3000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    act(() => { rerender({ ms: 2000 }) })
    // Re-rendering did not itself issue a request: the cadence is not part of the request
    // identity, so nothing fires until a TIMER says so.
    expect(fetcher).toHaveBeenCalledTimes(1)
    // The gap is measured from the settle, and 3 s of a 2 s gap have already elapsed, so
    // the next poll is due now — not 2 s from now, and not 7 s from now.
    await settle(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('treats intervalMs 0 as "no successor", in both directions', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { rerender } = renderHook(
      ({ ms }: { ms: number }) => usePoll(fetcher, { intervalMs: ms, deps: ['running'] }),
      { initialProps: { ms: 100 } },
    )
    await act(async () => { gates[0]!.resolve('the running rows') })

    // Dropping to 0 cancels the gap that was already armed — a backgrounded tab stops
    // polling rather than firing one last request.
    act(() => { rerender({ ms: 0 }) })
    await settle(5000)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Raising it off 0 arms one again, without a new request identity. The settle is 5 s
    // old and the gap is 100 ms, so it is due immediately.
    act(() => { rerender({ ms: 100 }) })
    await settle(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('unmounts cleanly after an identity change — no timer from the old question survives', async () => {
    const { fetcher, gates } = gatedFetcher<string>()
    const { rerender, unmount } = renderHook(
      ({ q }: { q: string }) => usePoll(fetcher, { intervalMs: 100, deps: [q] }),
      { initialProps: { q: 'running' } },
    )
    await act(async () => { gates[0]!.resolve('the running rows') })
    act(() => { rerender({ q: 'failed' }) })
    await act(async () => { gates[1]!.resolve('the failed rows') })
    expect(fetcher).toHaveBeenCalledTimes(2)

    unmount()
    await settle(1000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
