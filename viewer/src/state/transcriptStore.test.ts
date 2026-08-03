/**
 * §9.3's transcript window: 20,000 records **or** 8 MiB of source bytes, whichever first,
 * evicted a whole page at a time, appended through chunked arrays.
 *
 * The bounds are tested at small sizes with the real code path rather than at production
 * sizes with a mock — what matters is that BOTH bounds bite, that eviction is by page, and
 * that the append path is not quadratic.
 */

import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api/client.js'
import type { JsonlPage } from '../api/types.js'
import { createTranscriptStore } from './transcriptStore.js'

/** A page of `count` records, each `bytes` long, starting at byte `start`. */
function page(start: number, count: number, bytes = 100, eof = true): JsonlPage {
  const items = []
  let o = start
  for (let i = 0; i < count; i++) {
    o += bytes
    items.push({ o, rec: { type: 'text', text: `r${o}` } })
  }
  return { items, start, end: o, size: o, eof }
}

function setup(pages: Record<string, JsonlPage>, options: Record<string, number> = {}) {
  const asked: (number | 'tail')[] = []
  const handle = createTranscriptStore({
    runId: 'r1',
    index: 3,
    fetchPage: async (_runId, _index, opts) => {
      const from = opts.from ?? 'tail'
      asked.push(from)
      const found = pages[String(from)]
      if (!found) throw new ApiError(404, 'not_found', 'no transcript yet')
      return found
    },
    ...options,
  })
  return { handle, asked }
}

/**
 * A server that HONORS `maxBytes`: it returns as many records as fit, from the tail
 * backwards or from `from` forwards. This is what makes the adaptive shrink observable —
 * the fixed-page `setup` above cannot show it, because its answer never changes.
 */
function elasticSetup(total: number, bytes = 100, options: Record<string, number> = {}) {
  const asked: { from: number | 'tail'; maxBytes: number | undefined }[] = []
  const all = page(0, total, bytes).items
  const size = total * bytes
  const handle = createTranscriptStore({
    runId: 'r1',
    index: 3,
    fetchPage: async (_runId, _index, opts) => {
      const from = opts.from ?? 'tail'
      asked.push({ from, maxBytes: opts.maxBytes })
      const span = Math.max(bytes, opts.maxBytes ?? size)
      const start = from === 'tail' ? Math.max(0, size - span) : Math.min(from, size)
      const end = from === 'tail' ? size : Math.min(size, start + span)
      const items = all.filter((i) => i.o > start && i.o <= end)
      return { items, start, end, size, eof: end >= size }
    },
    ...options,
  })
  return { handle, asked }
}

describe('opening at the tail (§5.6.7 scenario 3)', () => {
  it('loads the tail page and reports how far back the window reaches', async () => {
    const { handle, asked } = setup({ tail: page(500_000, 10) })
    await handle.loadTail()
    const snap = handle.store.getSnapshot()
    expect(asked).toEqual(['tail'])
    expect(snap.records).toBe(10)
    expect(snap.items[0]!.o).toBe(500_100)
    expect(snap.atStart).toBe(false)   // 500 MB of history remains above
    expect(snap.loading).toBe(false)
  })

  it('a 404 is "no transcript yet", not an error (parity #9)', async () => {
    const { handle } = setup({})
    await handle.loadTail()
    const snap = handle.store.getSnapshot()
    expect(snap.missing).toBe(true)
    expect(snap.error).toBeNull()

    // …and the pane recovers the moment records start arriving.
    handle.append([{ o: 40, rec: { type: 'text' } }])
    expect(handle.store.getSnapshot().missing).toBe(false)
  })

  it('a transport failure is an error and keeps what was already retained', async () => {
    const { handle } = setup({ tail: page(0, 5) })
    await handle.loadTail()
    const failing = createTranscriptStore({
      runId: 'r1', index: 3,
      fetchPage: async () => { throw new ApiError(0, 'unreachable', 'gone') },
    })
    await failing.loadTail()
    expect(failing.store.getSnapshot().error?.unreachable).toBe(true)
    expect(handle.store.getSnapshot().records).toBe(5)
  })
})

describe('paging backwards (§5.4.4)', () => {
  it('prepends older records and stops once the window reaches byte 0', async () => {
    const { handle, asked } = setup(
      { tail: page(1000, 5), 0: page(0, 10) },
      { pageBytes: 1000 },
    )
    await handle.loadTail()
    expect(handle.store.getSnapshot().atStart).toBe(false)
    await handle.loadOlder()

    const snap = handle.store.getSnapshot()
    expect(asked).toEqual(['tail', 0])
    expect(snap.atStart).toBe(true)
    expect(snap.records).toBe(15)
    // Offsets stay ascending across the seam — §5.4.4's windows remain contiguous.
    const offsets = snap.items.map((i) => i.o)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)

    await handle.loadOlder()
    expect(asked).toEqual(['tail', 0])   // no-op once at the start
  })

  it('drops the overlap when a backwards window runs past our own start', async () => {
    // A window that begins mid-line skips forward to the first newline, so the server can
    // legitimately return records we already hold.
    const older: JsonlPage = { items: page(0, 12).items, start: 0, end: 1200, size: 1500, eof: false }
    const { handle } = setup({ tail: page(1000, 5), 0: older }, { pageBytes: 1000 })
    await handle.loadTail()
    await handle.loadOlder()
    const offsets = handle.store.getSnapshot().items.map((i) => i.o)
    // The tail already held 1100–1500; the older window returned 100–1200, so its last two
    // records are the overlap and must be dropped rather than rendered a second time.
    expect(new Set(offsets).size).toBe(offsets.length)
    expect(offsets).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500])
  })
})

describe('the live tail', () => {
  it('appends without re-copying the buffer, and drops replayed duplicates', async () => {
    const { handle } = setup({ tail: page(0, 3) })
    await handle.loadTail()
    handle.append([{ o: 400, rec: { type: 'text' } }, { o: 500, rec: { type: 'text' } }])
    // A replay the client did not classify as a reset must not render twice (P8).
    handle.append([{ o: 400, rec: { type: 'text' } }, { o: 600, rec: { type: 'text' } }])
    const offsets = handle.store.getSnapshot().items.map((i) => i.o)
    expect(offsets).toEqual([100, 200, 300, 400, 500, 600])
  })

  it('seals the live chunk so the window has something to evict', async () => {
    const { handle } = setup({ tail: page(0, 1) }, { liveChunkRecords: 4, maxRecords: 6 })
    await handle.loadTail()
    let o = 100
    for (let i = 0; i < 20; i++) handle.append([{ o: (o += 10), rec: { type: 'text' } }])
    const snap = handle.store.getSnapshot()
    // Without sealing, one unbounded live chunk would make the bound decorative.
    expect(snap.evicted).toBeGreaterThan(0)
    expect(snap.records).toBeLessThanOrEqual(8)
    expect(snap.atStart).toBe(false)
  })

  it('a duplicate at the seam of a sealed chunk is still a duplicate', async () => {
    const { handle } = setup({ tail: page(0, 1) }, { liveChunkRecords: 2 })
    await handle.loadTail()
    handle.append([{ o: 200, rec: {} }, { o: 300, rec: {} }])
    handle.append([{ o: 300, rec: {} }, { o: 400, rec: {} }])
    expect(handle.store.getSnapshot().items.map((i) => i.o)).toEqual([100, 200, 300, 400])
  })
})

describe('the window (§9.3, critique M14)', () => {
  it('the RECORD bound evicts by whole page, to EXACTLY the configured limit', async () => {
    const { handle } = setup(
      { tail: page(0, 4), 0: page(0, 4) },
      { maxRecords: 6, liveChunkRecords: 4 },
    )
    await handle.loadTail()
    let o = 400
    for (let i = 0; i < 8; i++) handle.append([{ o: (o += 10), rec: {} }])
    const snap = handle.store.getSnapshot()
    // Not "the limit plus a page" — the limit. A tolerance here is a bound that does not
    // bind, which is what the P6 heap budget cannot survive.
    expect(snap.records).toBeLessThanOrEqual(6)
    expect(snap.evicted).toBeGreaterThanOrEqual(1)
    // Evicted from the OLDEST end: the live tail is what the operator is watching.
    expect(snap.items[snap.items.length - 1]!.o).toBe(o)
  })

  it('the BYTE bound evicts even when the record count is comfortable', async () => {
    // The reason both bounds exist: 20,000 records of 1 KiB each is 20 MiB of source.
    const { handle } = setup(
      { tail: page(0, 2, 5000) },
      { maxRecords: 10_000, maxBytes: 12_000, liveChunkRecords: 2 },
    )
    await handle.loadTail()
    let o = 10_000
    for (let i = 0; i < 8; i++) handle.append([{ o: (o += 5000), rec: {} }])
    const snap = handle.store.getSnapshot()
    expect(snap.bytes).toBeLessThanOrEqual(12_000)
    expect(snap.evicted).toBeGreaterThan(0)
  })

  it('a single dense page is re-requested smaller rather than retained whole', async () => {
    // 400 records inside one 2 KiB-per-record page: the byte hint was honored and the
    // RECORD bound still busts. Halving the request converges on a page that fits.
    const { handle, asked } = elasticSetup(400, 100, { maxRecords: 5, pageBytes: 4000, maxBytes: 10_000 })
    await handle.loadTail()
    const snap = handle.store.getSnapshot()
    expect(asked.length).toBeGreaterThan(1)
    expect(asked[asked.length - 1]!.maxBytes!).toBeLessThan(asked[0]!.maxBytes!)
    expect(snap.records).toBeLessThanOrEqual(5)
    expect(snap.bytes).toBeLessThanOrEqual(10_000)
    // Opened at the TAIL: the last record of the file is retained, not the first.
    expect(snap.items[snap.items.length - 1]!.o).toBe(40_000)
  })

  it('a server that ignores the hint is trimmed, and the trimmed span stays re-fetchable', async () => {
    // `maxBytes` is a hint. This server returns the same 50-record page however small the
    // request, so the shrink cannot help and the window is held by trimming instead.
    const { handle, asked } = setup({ tail: page(0, 50) }, { maxRecords: 5 })
    await handle.loadTail()
    const snap = handle.store.getSnapshot()
    expect(asked.length).toBe(1 + 4)                 // one try plus MAX_PAGE_SHRINKS
    expect(snap.records).toBe(5)                     // exactly the limit, never 50
    expect(snap.items.map((i) => i.o)).toEqual([4600, 4700, 4800, 4900, 5000])
    // The retained span is [4500, 5000) — a §5.4.4 window, so paging up still works: the
    // trim rewrote `start` from the surviving records' own offsets, it did not guess.
    expect(snap.bytes).toBe(500)
    expect(snap.atStart).toBe(false)
  })

  it('paging up evicts from the NEWEST edge — and says so instead of forging a gap', async () => {
    const { handle } = setup(
      { tail: page(1000, 5), 0: page(0, 10) },
      { maxRecords: 10, pageBytes: 1000 },
    )
    await handle.loadTail()
    await handle.loadOlder()
    const snap = handle.store.getSnapshot()
    expect(snap.records).toBeLessThanOrEqual(10)
    // The page that was just fetched survived; the tail is what went.
    expect(snap.items[0]!.o).toBe(100)
    expect(snap.tailDetached).toBe(true)
    // Live records no longer abut the window, so they are not stitched onto it.
    handle.append([{ o: 9999, rec: {} }])
    expect(handle.store.getSnapshot().records).toBe(snap.records)
    // …and rejoining the live edge is a tail load, which clears the flag.
    await handle.loadTail()
    expect(handle.store.getSnapshot().tailDetached).toBe(false)
  })

  it('keeps the newest live record as the frontier even while the window is detached', async () => {
    // §3.6's live region summarizes the RUN's frontier, and a detached window stops seeing
    // it (above). Dropping those records from `items` is correct; dropping them entirely is
    // what froze the announcement on a historical record. One record is retained out of
    // band — outside `records`/`bytes`, so it costs nothing against the §9.3 window.
    const { handle } = setup(
      { tail: page(1000, 5), 0: page(0, 10) },
      { maxRecords: 10, pageBytes: 1000 },
    )
    await handle.loadTail()
    // The tail page IS the newest bytes on disk, so it seeds the frontier — nothing has to
    // arrive live first. (This assertion read `toBe(null)` while the frontier was advanced
    // only by `append()`; the seeding case below is what that gap costs.)
    expect(handle.store.getSnapshot().frontier!.o).toBe(1500)
    handle.append([{ o: 2000, rec: { type: 'text', text: 'live' } }])
    expect(handle.store.getSnapshot().frontier!.o).toBe(2000)

    await handle.loadOlder()
    const detached = handle.store.getSnapshot()
    expect(detached.tailDetached).toBe(true)
    const held = detached.records

    // The append the window refuses still moves the frontier, and publishes so the region
    // re-renders — the whole point of the retention.
    let published = 0
    const stop = handle.store.subscribe(() => { published++ })
    handle.append([{ o: 9000, rec: { type: 'tool', name: 'Edit' } }])
    const after = handle.store.getSnapshot()
    expect(published).toBe(1)
    expect(after.records).toBe(held)
    expect(after.items.some((item) => item.o === 9000)).toBe(false)
    expect(after.frontier!.o).toBe(9000)
    expect(after.frontier!.rec).toEqual({ type: 'tool', name: 'Edit' })
    // Bounded and monotone: a replayed OLDER record cannot walk the frontier backwards, and
    // a no-op append does not re-publish.
    handle.append([{ o: 8000, rec: { type: 'text', text: 'replay' } }])
    expect(handle.store.getSnapshot().frontier!.o).toBe(9000)
    expect(published).toBe(1)
    stop()

    // `sys/reset` restarts the stream from byte 0 (§5.6.4), so pre-reset offsets are
    // meaningless — keeping one would outrank every post-reset record forever. The reset
    // clears it and the refetched tail page immediately reseeds it from the NEW file, which
    // is the only offset space that exists now: 9000 is gone rather than carried over.
    await handle.reset()
    expect(handle.store.getSnapshot().frontier!.o).toBe(1500)
  })

  it('seeds the frontier from the tail page and keeps it across upward eviction', async () => {
    // THE regression this pair of assertions exists for. `loadOlder` evicts from the NEWEST
    // edge, so the record the tail page ended on leaves `items`. If the frontier were only
    // ever advanced by `append()`, a pane paged up before the first SSE frame would hold
    // `frontier === null` and §3.6's region would fall back to the displayed window —
    // announcing historical activity, indefinitely, with nothing to correct it. The frontier
    // is a property of the STREAM, so it is seeded by the fetch and outlives the eviction.
    const { handle } = setup(
      { tail: page(1000, 5), 0: page(0, 10) },
      { maxRecords: 10, pageBytes: 1000 },
    )
    await handle.loadTail()
    const seeded = handle.store.getSnapshot().frontier
    expect(seeded!.o).toBe(1500)

    await handle.loadOlder()
    const detached = handle.store.getSnapshot()
    // The window really did drop it — this is eviction, not a window that happens to still
    // hold the record.
    expect(detached.tailDetached).toBe(true)
    expect(detached.items.some((item) => item.o === 1500)).toBe(false)
    // …and the announcement's source did not move. Same record, no live frame involved.
    expect(detached.frontier).toBe(seeded)

    // A later live frame still advances it from there, past the retained span.
    handle.append([{ o: 9000, rec: { type: 'tool', name: 'Edit' } }])
    expect(handle.store.getSnapshot().frontier!.o).toBe(9000)
  })

  it('does not let a tail page walk the frontier backwards past live records it raced', async () => {
    // `append()` buffers into `pendingLive` while a tail fetch is in flight, and those
    // records can be NEWER than the page that lands. `noteFrontier` compares by offset, so
    // the merge order does not matter — but only because it compares. A seed that simply
    // assigned the page's last record would rewind the announcement to before the frame the
    // operator's screen reader has already been told about.
    let release!: (page: JsonlPage) => void
    const handle = createTranscriptStore({
      runId: 'r1',
      index: 3,
      fetchPage: () => new Promise<JsonlPage>((resolve) => { release = resolve }),
    })
    const loading = handle.loadTail()
    handle.append([{ o: 9000, rec: { type: 'tool', name: 'Edit' } }])
    expect(handle.store.getSnapshot().frontier!.o).toBe(9000)
    release(page(1000, 5))
    await loading
    const snap = handle.store.getSnapshot()
    expect(snap.frontier!.o).toBe(9000)
    // The buffered record was still installed into the window, ahead of the page's own.
    expect(snap.items.at(-1)!.o).toBe(9000)
  })

  it('appends 20,000 records in linear time (no per-record spread)', async () => {
    const { handle } = setup({ tail: page(0, 1) }, { maxRecords: 20_000, maxBytes: 8 * 1024 * 1024 })
    await handle.loadTail()
    const started = performance.now()
    let o = 100
    for (let i = 0; i < 20_000; i++) handle.append([{ o: (o += 40), rec: { type: 'text', i } }])
    const elapsed = performance.now() - started
    console.log(`transcript append: 20,000 records in ${elapsed.toFixed(0)} ms`)
    const snap = handle.store.getSnapshot()
    expect(snap.records).toBeGreaterThan(15_000)
    expect(snap.records).toBeLessThanOrEqual(20_000)
    expect(snap.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(elapsed).toBeLessThan(process.env.CI ? 9000 : 3000)
  })

  it('holds BOTH production bounds through a mixed load/page/append walk', async () => {
    // The acceptance shape: default limits, records dense enough that the record bound
    // bites first in one phase and the byte bound in another, with paging in between.
    const { handle } = elasticSetup(60_000, 200, {})
    await handle.loadTail()
    const bounded = () => {
      const s = handle.store.getSnapshot()
      expect(s.records).toBeLessThanOrEqual(20_000)
      expect(s.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    }
    bounded()
    for (let i = 0; i < 5; i++) { await handle.loadOlder(); bounded() }
    await handle.loadTail()
    let o = 60_000 * 200
    for (let i = 0; i < 30_000; i++) handle.append([{ o: (o += 200), rec: { type: 'text', i } }])
    bounded()
  })
})

describe('sys/reset for this stream (§5.6.4)', () => {
  it('drops everything and refetches the tail page', async () => {
    const { handle, asked } = setup({ tail: page(0, 3) })
    await handle.loadTail()
    handle.append([{ o: 400, rec: {} }])
    expect(handle.store.getSnapshot().records).toBe(4)

    await handle.reset()
    expect(asked).toEqual(['tail', 'tail'])
    expect(handle.store.getSnapshot().records).toBe(3)
    expect(handle.store.getSnapshot().evicted).toBe(0)
  })

  /**
   * **The window a reset is busiest in.** §5.6.4 sends `sys/reset` and then replays that
   * stream from 0, so the live records arrive WHILE `reset()`'s tail fetch is still in
   * flight — and `loadTail()` replaces `chunks` when it resolves. An earlier revision
   * appended those records to the list that was about to be thrown away, so the pane
   * dropped every frame that landed inside the fetch and P8's "zero dropped frames" was
   * false for exactly the duration of the refetch. The existing tests all awaited the
   * reset before appending, which is the one ordering that cannot see it.
   */
  function deferredSetup(pages: Record<string, JsonlPage>) {
    let release: (() => void) | null = null
    const handle = createTranscriptStore({
      runId: 'r1',
      index: 3,
      fetchPage: async (_runId, _index, opts) => {
        const from = String(opts.from ?? 'tail')
        await new Promise<void>((resolve) => { release = resolve })
        return pages[from]!
      },
    })
    return { handle, release: () => release?.() }
  }

  it('records that arrive DURING the reset fetch survive it, exactly once', async () => {
    // The fetched page ends at 300; the replay overlaps it (200, 300) and continues (400).
    const { handle, release } = deferredSetup({ tail: page(0, 3) })
    const pending = handle.reset()
    handle.append([{ o: 200, rec: { type: 'text', text: 'dup' } }])
    handle.append([{ o: 300, rec: { type: 'text', text: 'dup' } }])
    handle.append([{ o: 400, rec: { type: 'text', text: 'live' } }])
    // Nothing was published into the doomed window…
    expect(handle.store.getSnapshot().records).toBe(0)

    release()
    await pending

    const snap = handle.store.getSnapshot()
    // …and after the page lands: its 3 records plus the one the page did not contain.
    expect(snap.records).toBe(4)
    expect(snap.items.map((i) => i.o)).toEqual([100, 200, 300, 400])
    expect(snap.items.filter((i) => i.o === 300)).toHaveLength(1)   // zero duplicates
    expect(snap.loading).toBe(false)
  })

  it('a FAILED tail fetch hands the buffered records back to the window it left standing', async () => {
    let calls = 0
    let release: (() => void) | null = null
    const handle = createTranscriptStore({
      runId: 'r1',
      index: 3,
      fetchPage: async () => {
        if (++calls === 1) return page(0, 2)
        await new Promise<void>((resolve) => { release = resolve })
        throw new ApiError(500, 'boom', 'nope')
      },
    })
    await handle.loadTail()
    expect(handle.store.getSnapshot().records).toBe(2)

    const inflight = handle.loadTail()
    handle.append([{ o: 300, rec: { type: 'text', text: 'live' } }])
    release!()
    await inflight

    // Nothing was replaced, so the held record simply belongs to the existing window.
    expect(handle.store.getSnapshot().items.map((i) => i.o)).toEqual([100, 200, 300])
    expect(handle.store.getSnapshot().error?.status).toBe(500)
  })

  it('a second reset supersedes the first WITHOUT stranding the first’s records', async () => {
    const resolvers: (() => void)[] = []
    const pages = [page(0, 1), page(0, 3)]
    let call = 0
    const handle = createTranscriptStore({
      runId: 'r1',
      index: 3,
      fetchPage: async () => {
        const mine = call++
        await new Promise<void>((resolve) => resolvers.push(resolve))
        return pages[Math.min(mine, pages.length - 1)]!
      },
    })
    const first = handle.reset()
    handle.append([{ o: 500, rec: { type: 'text', text: 'a' } }])
    const second = handle.reset()
    handle.append([{ o: 600, rec: { type: 'text', text: 'b' } }])
    for (const resolve of resolvers) resolve()
    await Promise.all([first, second])

    const snap = handle.store.getSnapshot()
    // The winner's page, plus BOTH live records — the one buffered while the superseded
    // load was in flight is not the loser's to drop.
    expect(snap.items.map((i) => i.o)).toEqual([100, 200, 300, 500, 600])
  })
})

/**
 * **Ownership.** A page load resolves into a window that may not be the one it was started
 * for: `loadTail`/`reset` REPLACE the retained chunks, and the aborted `loadOlder` they
 * supersede has to leave both the window and the paging flag to them. An earlier revision
 * returned from the aborted call without clearing `loadingOlder`, and the replacement tail
 * load carried the stale flag into its own publish — so `loadOlder` short-circuited on it
 * for the rest of the pane's life and the operator could never scroll up again.
 */
describe('overlapping page loads', () => {
  function gatedStore(options: Record<string, number> = {}) {
    const gate: { from: number | 'tail'; resolve: (page: JsonlPage) => void }[] = []
    const handle = createTranscriptStore({
      runId: 'r1',
      index: 3,
      pageBytes: 1000,
      // The signal is deliberately ignored: an abort cannot un-resolve a fetch that has
      // already landed, so the generation check is what has to hold the line.
      fetchPage: (_runId, _index, opts) =>
        new Promise<JsonlPage>((resolve) => { gate.push({ from: opts.from ?? 'tail', resolve }) }),
      ...options,
    })
    return { handle, gate }
  }

  it('a reset that lands mid-loadOlder clears the flag and discards the stale page', async () => {
    const { handle, gate } = gatedStore()
    const opened = handle.loadTail()
    gate[0]!.resolve(page(1000, 5))
    await opened
    expect(handle.store.getSnapshot().records).toBe(5)

    // Scroll up… and, while that page is in flight, `sys/reset` on this agent stream.
    const older = handle.loadOlder()
    expect(handle.store.getSnapshot().loadingOlder).toBe(true)
    const reset = handle.reset()
    gate[2]!.resolve(page(2000, 3))
    await reset

    // The superseded page resolves into a window that no longer exists.
    gate[1]!.resolve(page(0, 10))
    await older

    const snap = handle.store.getSnapshot()
    expect(snap.loadingOlder).toBe(false)
    expect(snap.records).toBe(3)                      // the reset's page, not the stale one
    expect(snap.items[0]!.o).toBe(2100)
    expect(gate).toHaveLength(3)

    // …and paging up still works, which is the whole point of the flag being clear.
    const again = handle.loadOlder()
    expect(gate).toHaveLength(4)
    gate[3]!.resolve(page(1000, 10))
    await again
    expect(handle.store.getSnapshot().items[0]!.o).toBe(1100)
  })

  /**
   * The same seam in the OTHER order, which is where M1 lived.
   *
   * `gatedStore` above deliberately ignores the abort signal, so it cannot show this one:
   * the bug was that `loadOlder` and `loadTail` shared a single `inFlight` controller, so
   * starting a backwards page ABORTED the tail fetch. A real `fetch` rejects on abort —
   * this gate does too — and the tail load then took its `!page` exit while still OWNING
   * the window (`loadOlder` does not bump `generation`, by design), returning without ever
   * clearing the `loading: true` it had published. The pane sat in its skeleton state, over
   * a window that had finished loading, until it was unmounted.
   */
  function abortingGate(options: Record<string, number> = {}) {
    const gate: { from: number | 'tail'; resolve: (page: JsonlPage) => void }[] = []
    const handle = createTranscriptStore({
      runId: 'r1',
      index: 3,
      pageBytes: 1000,
      fetchPage: (_runId, _index, opts) => new Promise<JsonlPage>((resolve, reject) => {
        gate.push({ from: opts.from ?? 'tail', resolve })
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
      ...options,
    })
    return { handle, gate }
  }

  it('a loadOlder started during a tail replacement leaves the pane loadable (M1)', async () => {
    const { handle, gate } = abortingGate()
    const opened = handle.loadTail()
    gate[0]!.resolve(page(1000, 5))
    await opened
    expect(handle.store.getSnapshot().records).toBe(5)

    // "Jump to latest" (or a `sys/reset`) is fetching a replacement window…
    const tail = handle.loadTail()
    expect(handle.store.getSnapshot().loading).toBe(true)
    // …and the operator scrolls up before it lands. The tail load owns the window, so this
    // call waits for it rather than fetching a page against chunks that are condemned —
    // and, critically, rather than aborting the fetch that is going to install them.
    const older = handle.loadOlder()
    expect(gate).toHaveLength(2)
    expect(handle.store.getSnapshot().loadingOlder).toBe(false)

    gate[1]!.resolve(page(3000, 2))
    await tail
    await older

    const settled = handle.store.getSnapshot()
    expect(settled.loading).toBe(false)
    expect(settled.loadingOlder).toBe(false)
    expect(settled.items.map((i) => i.o)).toEqual([3100, 3200])

    // …and paging up works on the window that actually arrived.
    const again = handle.loadOlder()
    expect(gate).toHaveLength(3)
    gate[2]!.resolve(page(2000, 4))
    await again
    expect(handle.store.getSnapshot().items[0]!.o).toBe(2100)
    expect(handle.store.getSnapshot().loading).toBe(false)
  })

  /**
   * The invariant the M1 fix states in general: an OWNING `loadTail` clears the flag it
   * published on every exit it can take, not only the one that installs a window. Held
   * here as a property over all three outcomes so no future early return can reintroduce
   * a pane stuck in its skeleton state.
   */
  for (const [outcome, fetchPage] of [
    ['a page', async () => page(1000, 5)],
    ['a 404', async () => { throw new ApiError(404, 'not_found', 'no transcript yet') }],
    ['a transport failure', async () => { throw new ApiError(0, 'unreachable', 'gone') }],
  ] as [string, () => Promise<JsonlPage>][]) {
    it(`a loadTail that ends in ${outcome} leaves loading false`, async () => {
      const handle = createTranscriptStore({ runId: 'r1', index: 3, fetchPage })
      await handle.loadTail()
      expect(handle.store.getSnapshot().loading).toBe(false)
    })
  }

  it('a loadTail that supersedes a loadOlder leaves neither the flag nor a stale page', async () => {
    const { handle, gate } = gatedStore()
    const opened = handle.loadTail()
    gate[0]!.resolve(page(1000, 5))
    await opened

    const older = handle.loadOlder()
    const tail = handle.loadTail()          // "jump to latest" while the page is in flight
    gate[2]!.resolve(page(3000, 2))
    await tail
    gate[1]!.resolve(page(0, 10))
    await older

    const snap = handle.store.getSnapshot()
    expect(snap.loadingOlder).toBe(false)
    expect(snap.items.map((i) => i.o)).toEqual([3100, 3200])
  })
})

/**
 * The window's byte total has to count the bytes of every record it holds, including the
 * first one after a load that installed no chunk. A record's `o` is the offset AFTER its
 * newline (§5.6.3), so starting a live chunk at the first record's own `o` makes that
 * record span zero bytes — and the §9.3 8 MiB bound is then short by up to one maximum
 * line, on exactly the transcripts the bound exists for.
 */
describe('byte accounting with no page to abut', () => {
  it('after a 404, the live chunk starts at byte 0 — where the file will be written', async () => {
    const { handle } = setup({})
    await handle.loadTail()
    expect(handle.store.getSnapshot().missing).toBe(true)

    handle.append([{ o: 4096, rec: { type: 'text', text: 'first' } }])
    const snap = handle.store.getSnapshot()
    expect(snap.records).toBe(1)
    expect(snap.bytes).toBe(4096)   // not 0: this record's bytes are retained data
  })

  it('…and the bound then bites on the documented 404-then-live transition', async () => {
    const { handle } = setup({}, { maxBytes: 1000, liveChunkRecords: 1 })
    await handle.loadTail()
    for (const o of [400, 800, 1200]) handle.append([{ o, rec: { type: 'text' } }])

    const snap = handle.store.getSnapshot()
    // Three 400-byte records is 1,200 bytes of source against a 1,000-byte window, so one
    // page goes. Under-counting the first record would retain all three inside a bound the
    // window believed it was honoring.
    expect(snap.bytes).toBe(800)
    expect(snap.records).toBe(2)
    expect(snap.evicted).toBe(1)
    expect(snap.items.map((i) => i.o)).toEqual([800, 1200])
  })

  it('a page that carried no complete record still anchors the live tail at its end', async () => {
    // The window was fetched, scanned to `end`, and held no whole line (§5.4.4).
    const empty: JsonlPage = { items: [], start: 500, end: 900, size: 900, eof: true }
    const { handle } = setup({ tail: empty })
    await handle.loadTail()
    expect(handle.store.getSnapshot().records).toBe(0)

    handle.append([{ o: 1300, rec: { type: 'text' } }])
    expect(handle.store.getSnapshot().bytes).toBe(400)
  })
})

describe('subscription', () => {
  it('notifies subscribers on every publish and stops after unsubscribe', async () => {
    const { handle } = setup({ tail: page(0, 1) })
    const seen = vi.fn()
    const off = handle.store.subscribe(seen)
    await handle.loadTail()
    handle.append([{ o: 200, rec: {} }])
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(2)
    off()
    const before = seen.mock.calls.length
    handle.append([{ o: 300, rec: {} }])
    expect(seen.mock.calls.length).toBe(before)
  })

  it('stop() makes appends and in-flight fetches inert', async () => {
    const { handle } = setup({ tail: page(0, 1) })
    await handle.loadTail()
    handle.stop()
    handle.append([{ o: 200, rec: {} }])
    expect(handle.store.getSnapshot().records).toBe(1)
  })
})
