/**
 * `transcriptStore` — one per open agent (DESIGN §9.3).
 *
 * "A ring of parsed records bounded by **20,000 records or 8 MiB of source bytes,
 * whichever first** (critique M14: parsed JSONL expands 5–15× in the heap, so a bytes-only
 * bound cannot honor a heap budget). Eviction unit is the whole fetched page — §5.4.4
 * offsets stay contiguous; scrolling up re-fetches. Buffers are appended via chunked
 * arrays (no `[...prev, item]` per record — that spread is O(n²) over a stream)."
 *
 * Three consequences of that paragraph shape this file:
 *
 * • **Chunks, not one array.** Every fetched page is a chunk; live records append to a
 *   tail chunk that seals every `liveChunkRecords`. Appending is `push` onto the tail
 *   chunk's array — O(1) per record, versus the O(n²) a spread-per-record produces on a
 *   5,000-record transcript. The flattened view is memoized and rebuilt only when a chunk
 *   is added or dropped.
 *
 * • **Eviction is by chunk, from the edge the operator is not looking at.** Dropping half
 *   a page leaves a byte range the pager has to be able to express: §5.4.4 windows are
 *   `[start, end)` byte spans, so whole chunks are the unit that keeps every remaining
 *   span contiguous and re-fetchable. Appending at the tail evicts the OLDEST chunk;
 *   paging upward evicts the NEWEST, because evicting what was just fetched would undo the
 *   fetch and loop.
 *
 * • **The live chunk must seal.** Otherwise a long-running agent produces one unbounded
 *   chunk and the window can never evict anything — the bound would be decorative. It
 *   seals on records AND on bytes, for the same reason the window has both bounds.
 *
 * • **Both bounds hold after every load and every append, unconditionally.** "Keep at
 *   least one chunk" is not a licence to exceed them: a single page that alone busts the
 *   window is first re-requested at a smaller `maxBytes` (halving, four attempts), and if
 *   the server still returns more than fits — it is free to ignore the hint — the chunk is
 *   trimmed from its far edge, with `start`/`end` rewritten from the SURVIVING records'
 *   own offsets so the shortened span is still a window §5.4.4 can re-fetch. An earlier
 *   revision preserved an oversized last chunk and skipped eviction entirely on the
 *   upward-paging path; that made a documented memory bound (P6: ≤150 MB retained heap)
 *   unenforceable on exactly the dense transcripts it exists for.
 */

import { ApiError } from '../api/client.js'
import type { JsonlPage } from '../api/types.js'
import { createStore, type Store } from '../lib/store.js'

export interface TranscriptItem { o: number; rec: Record<string, unknown> }

interface Chunk {
  /** Byte offset of the first record's start. */
  start: number
  /** Byte offset after the last record's newline — i.e. its `o`. */
  end: number
  items: TranscriptItem[]
  /** A page still being appended to by the live tail. */
  live: boolean
}

export interface TranscriptSnapshot {
  index: number
  items: TranscriptItem[]
  records: number
  /** Source bytes retained — the §9.3 window's second bound. */
  bytes: number
  /** The retained window reaches byte 0: there is nothing older to fetch. */
  atStart: boolean
  /**
   * Paging up pushed the live tail out of the window, so appends no longer belong to the
   * retained span. The pane offers "jump to latest", which is `loadTail()`.
   */
  tailDetached: boolean
  /** Pages the window has dropped. Scrolling up re-fetches them (§9.3). */
  evicted: number
  loading: boolean
  loadingOlder: boolean
  /** 404 — no transcript file yet. Not an error: §5.4.4 says it may appear later. */
  missing: boolean
  error: ApiError | null
  /** The last page fetched reached EOF. */
  eof: boolean
  /**
   * **The newest live record this stream has produced, whether or not the retained window
   * still holds it.** §3.6's live region summarizes the run's frontier, and "live" is a
   * property of the RUN — not of the byte span the operator happens to be reading. Paging
   * up detaches the window (`tailDetached`) and every subsequent append is deliberately
   * dropped from `items`, so a frontier derived from `items` freezes on a historical record
   * and the region goes on saying "running Bash" while the agent has moved on. One record
   * is retained out of band instead: bounded by construction (a single record, itself
   * capped at 64 KiB by §5.6.5), so it costs nothing against the §9.3 window, and it is
   * NOT counted in `records`/`bytes` because it is not part of the retained span.
   *
   * It is the newest by OFFSET, never merely the last one seen, so a replayed or reordered
   * batch cannot walk the frontier backwards. `reset()` clears it: a `sys/reset` restarts
   * the stream from byte 0 and every offset before it belongs to a world that is gone.
   *
   * Two sources advance it, and both are necessary: every live `append()`, and every tail
   * page `loadTail()` installs. Without the second, a pane whose tail is evicted before the
   * first SSE frame arrives has no frontier at all, and the region falls back to the
   * displayed window — the very coupling this field exists to break.
   */
  frontier: TranscriptItem | null
}

export interface TranscriptStoreOptions {
  runId: string
  index: number
  fetchPage(
    runId: string,
    index: number,
    options: { from?: number | 'tail'; maxBytes?: number; signal?: AbortSignal },
  ): Promise<JsonlPage>
  maxRecords?: number
  maxBytes?: number
  pageBytes?: number
  liveChunkRecords?: number
  /** Byte size at which the live tail chunk seals. Defaults to a quarter of `maxBytes`. */
  liveChunkBytes?: number
}

export interface TranscriptStoreHandle {
  store: Store<TranscriptSnapshot>
  /** Open at the tail (§5.6.7 scenario 3: a 500 MB transcript must not be read whole). */
  loadTail(): Promise<void>
  /** Page backwards from the retained window's start. No-op once `atStart`. */
  loadOlder(): Promise<void>
  /** Live records from the SSE `a<n>` stream. */
  append(items: TranscriptItem[]): void
  /** `sys/reset` for this stream: drop everything and refetch the tail page (§5.6.4). */
  reset(): Promise<void>
  stop(): void
}

export const MAX_RECORDS = 20_000
export const MAX_BYTES = 8 * 1024 * 1024
export const PAGE_BYTES = 2 * 1024 * 1024
export const LIVE_CHUNK_RECORDS = 512
/** A page request will not be shrunk below this before the trim fallback takes over. */
export const MIN_PAGE_BYTES = 64 * 1024
const MAX_PAGE_SHRINKS = 4

export function createTranscriptStore(options: TranscriptStoreOptions): TranscriptStoreHandle {
  const maxRecords = options.maxRecords ?? MAX_RECORDS
  const maxBytes = options.maxBytes ?? MAX_BYTES
  const pageBytes = options.pageBytes ?? PAGE_BYTES
  const liveChunkRecords = options.liveChunkRecords ?? LIVE_CHUNK_RECORDS
  const liveChunkBytes = options.liveChunkBytes ?? Math.max(1, Math.min(pageBytes, Math.floor(maxBytes / 4)))
  // The shrink floor is relative as well as absolute, so a store configured with a small
  // `pageBytes` (tests, and a future tuned pane) still has room to halve.
  const minPageBytes = Math.max(1, Math.min(MIN_PAGE_BYTES, Math.floor(pageBytes / 2 ** MAX_PAGE_SHRINKS)))

  let chunks: Chunk[] = []
  let records = 0
  let bytes = 0
  let evicted = 0
  let atStart = false
  let tailDetached = false
  let eof = false
  let stopped = false
  /** See `TranscriptSnapshot.frontier`. Survives eviction and detachment; cleared by reset. */
  let frontier: TranscriptItem | null = null

  /**
   * **One request slot per OPERATION, not one per store.**
   *
   * `loadTail` and `loadOlder` are different jobs on different edges of the window, and a
   * single shared `inFlight` made each of them abort the other's fetch. That direction is
   * wrong for `loadOlder`→`loadTail` in a way the generation counter cannot repair:
   * `loadOlder` deliberately does NOT bump `generation` (a backwards page extends the
   * window rather than replacing it), so the tail load it aborted still passed its
   * ownership check, took the `!page` exit, and returned — leaving `loading: true` on a
   * window that had finished loading, for the rest of the pane's life.
   *
   * `failure` moves in here for the same reason: it is the answer to "why did MY fetch
   * return null", and a shared field is one more thing an overlapping call can overwrite
   * between the `await` and the read.
   */
  interface LoadSlot {
    controller: AbortController | null
    /** Why the last `fetchPage` returned null — a 404 is not a failure (§5.4.4, parity #9). */
    failure: 'missing' | 'error' | 'aborted' | null
  }
  const tailLoad: LoadSlot = { controller: null, failure: null }
  const olderLoad: LoadSlot = { controller: null, failure: null }

  /**
   * **Live records that arrive while a tail page is in flight.**
   *
   * `loadTail()` REPLACES `chunks` when its fetch resolves, so an SSE record appended in
   * the meantime was written into a list that is about to be thrown away — the pane dropped
   * frames for the whole duration of a `reset()`, which is exactly the window a reset is
   * busiest in (§5.6.4 sends the reset and then replays that stream from 0). Buffering them
   * here and replaying them through `applyAppend` after the page is installed keeps P8's
   * "zero dropped frames" true across the seam, and the offset check inside `applyAppend`
   * keeps "zero duplicates" true for the ones the fetched page already contains.
   *
   * Non-null exactly while a tail load owns the window; `generation` is what tells a
   * superseded load that a newer one has taken the buffer over.
   */
  let pendingLive: TranscriptItem[] | null = null

  /**
   * **Window ownership.** Bumped by every call that REPLACES the retained window —
   * `loadTail`, `reset` (through it) and `stop` — and read by every call that resolves into
   * one, so a page fetched for a window that no longer exists is discarded instead of
   * installed. `loadOlder` only reads it: a backwards page extends the window rather than
   * replacing it, and bumping here would make an in-flight `loadTail` disown `pendingLive`
   * and buffer live records forever.
   */
  let generation = 0

  /**
   * Where the next live record's bytes begin when the window has no chunk to abut.
   *
   * The first live chunk after a tail load that installed nothing (a 404, or a page whose
   * span held no complete record) has no predecessor to take a start offset from. Using the
   * first record's own `o` — its POST-newline offset (§5.6.3) — makes that record span zero
   * bytes, so the retained total under-counts by one line and the §9.3 8 MiB bound can be
   * exceeded by up to one maximum-sized record. Both cases have an honest anchor instead:
   * a 404 means the file does not exist yet and will be written from byte 0, and an
   * empty-of-records page has scanned as far as `page.end`.
   */
  let liveAnchor: number | null = null

  // Flags carried across publishes. Held as locals rather than read back out of the last
  // snapshot, because spreading a snapshot would invoke its lazy `items` getter (below)
  // and undo the whole point of it.
  let loading = false
  let loadingOlder = false
  let missing = false
  let error: ApiError | null = null

  const store = createStore<TranscriptSnapshot>(snapshot())

  /**
   * Flattening is LAZY, and that is a performance contract, not a style choice.
   *
   * Every publish would otherwise rebuild an array of up to 20,000 records — and a live
   * tail publishes on every append, which is the O(n²) shape §9.3 calls out by name. So a
   * publish captures the chunk list (O(chunks) ≈ 40) and materializes the flat view only
   * if a renderer actually reads it, at most once per snapshot. Capturing each chunk's
   * length at publish time is what keeps an older snapshot honest: it flattens the world
   * as it was when it was published, not as it is when it is read.
   */
  function snapshot(patch: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot {
    const capture = chunks.map((chunk) => ({ items: chunk.items, n: chunk.items.length }))
    let cached: TranscriptItem[] | null = null
    const snap: TranscriptSnapshot = {
      index: options.index,
      items: [],
      records,
      bytes,
      atStart,
      tailDetached,
      evicted,
      loading,
      loadingOlder,
      missing,
      error,
      eof,
      frontier,
      ...patch,
    }
    Object.defineProperty(snap, 'items', {
      enumerable: true,
      configurable: true,
      get() {
        if (cached) return cached
        cached = []
        for (const chunk of capture) {
          for (let i = 0; i < chunk.n; i++) cached.push(chunk.items[i]!)
        }
        return cached
      },
    })
    return snap
  }

  const publish = (patch: Partial<TranscriptSnapshot> = {}): void => {
    loading = patch.loading ?? loading
    loadingOlder = patch.loadingOlder ?? loadingOlder
    missing = patch.missing ?? missing
    if ('error' in patch) error = patch.error ?? null
    store.set(snapshot(patch))
  }

  const chunkBytes = (chunk: Chunk): number => Math.max(0, chunk.end - chunk.start)

  const recount = (): void => {
    records = 0
    bytes = 0
    for (const chunk of chunks) {
      records += chunk.items.length
      bytes += chunkBytes(chunk)
    }
  }

  const overWindow = (): boolean => records > maxRecords || bytes > maxBytes

  /**
   * The fallback for a page that alone exceeds the window: drop records from `edge` and
   * rewrite the span from the survivors' own offsets. A record's start byte IS the
   * previous record's `o`, so a front trim moves `start` to the last dropped record's `o`
   * and a back trim moves `end` to the last surviving one's — either way `[start, end)`
   * remains a §5.4.4 window the pager can ask for again.
   */
  const trimChunk = (chunk: Chunk, edge: 'front' | 'back'): void => {
    const items = chunk.items
    const len = items.length
    if (len <= 1) return
    const startAfter = (k: number): number => (k === 0 ? chunk.start : items[k - 1]!.o)
    const endBefore = (k: number): number => items[len - k - 1]!.o
    let drop = Math.max(0, len - maxRecords)
    if (edge === 'front') {
      while (drop < len - 1 && chunk.end - startAfter(drop) > maxBytes) drop++
      if (!drop) return
      chunk.start = startAfter(drop)
      chunk.items = items.slice(drop)
    } else {
      while (drop < len - 1 && endBefore(drop) - chunk.start > maxBytes) drop++
      if (!drop) return
      chunk.items = items.slice(0, len - drop)
      chunk.end = chunk.items[chunk.items.length - 1]!.o
    }
  }

  /**
   * Enforce BOTH bounds, unconditionally, evicting from the edge opposite the operator's
   * attention: `'oldest'` while they watch the live tail, `'newest'` while they page up.
   * Whole chunks first; a lone chunk that still busts the window is trimmed rather than
   * kept — an over-budget pane is not a better failure than a shortened one.
   */
  const enforce = (edge: 'oldest' | 'newest'): void => {
    recount()
    while (chunks.length > 1 && overWindow()) {
      const dropped = edge === 'oldest' ? chunks.shift()! : chunks.pop()!
      records -= dropped.items.length
      bytes -= chunkBytes(dropped)
      evicted++
      if (edge === 'oldest') atStart = false
      else { tailDetached = true; eof = false }
    }
    if (chunks.length === 1 && overWindow()) {
      trimChunk(chunks[0]!, edge === 'oldest' ? 'front' : 'back')
      if (edge === 'oldest') atStart = false
      else { tailDetached = true; eof = false }
      recount()
    }
  }

  const pageSpan = (page: JsonlPage): number =>
    Math.max(0, (page.items.length ? page.items[page.items.length - 1]!.o : page.end) - page.start)

  const chunkFromPage = (page: JsonlPage): Chunk => ({
    start: page.start,
    end: page.items.length ? page.items[page.items.length - 1]!.o : page.end,
    items: page.items,
    live: false,
  })

  async function fetchPage(
    slot: LoadSlot,
    from: number | 'tail',
    maxPageBytes = pageBytes,
  ): Promise<JsonlPage | null> {
    // Only THIS operation's previous attempt — `fetchFitted` re-asks with a smaller hint,
    // and that retry supersedes its own first try and nobody else's.
    slot.controller?.abort()
    const controller = new AbortController()
    slot.controller = controller
    slot.failure = null
    try {
      return await options.fetchPage(options.runId, options.index, {
        from, maxBytes: maxPageBytes, signal: controller.signal,
      })
    } catch (err) {
      if (stopped || (err as Error)?.name === 'AbortError') { slot.failure = 'aborted'; return null }
      const apiErr = err instanceof ApiError
        ? err
        : new ApiError(0, 'unreachable', String((err as Error)?.message ?? err))
      // 404 is "not yet", not a failure (§5.4.4, parity #9).
      slot.failure = apiErr.status === 404 ? 'missing' : 'error'
      if (apiErr.status === 404) publish({ loading: false, loadingOlder: false, missing: true, error: null })
      else publish({ loading: false, loadingOlder: false, error: apiErr })
      return null
    } finally {
      if (slot.controller === controller) slot.controller = null
    }
  }

  /**
   * Fetch a page that FITS the window, asking for less when the first answer does not.
   *
   * `maxBytes` is a hint the server may cap but need not honor downward, and even a page
   * inside the byte hint can carry more than `maxRecords` when the records are small — 2
   * MiB of 40-byte status lines is 50,000 of them. Halving the request converges on a page
   * the window can hold in a couple of round trips; `enforce` handles whatever is left.
   */
  async function fetchFitted(
    slot: LoadSlot,
    anchor: 'tail' | { before: number },
  ): Promise<JsonlPage | null> {
    let want = pageBytes
    for (let attempt = 0; ; attempt++) {
      const from = anchor === 'tail' ? 'tail' : Math.max(0, anchor.before - want)
      const page = await fetchPage(slot, from, want)
      if (!page) return null
      const fits = page.items.length <= maxRecords && pageSpan(page) <= maxBytes
      if (fits || attempt >= MAX_PAGE_SHRINKS || want <= minPageBytes) return page
      want = Math.max(minPageBytes, Math.floor(want / 2))
    }
  }

  async function loadTail(): Promise<void> {
    const mine = ++generation
    // From here until the page lands, `append()` buffers instead of writing into a chunk
    // list this call is about to replace. The buffer is SHARED with any load already in
    // flight rather than replacing it: overlapping loads (a reset while "jump to latest" is
    // still fetching) would otherwise strand the earlier one's records, which is the same
    // dropped frame in a different order.
    const buffered: TranscriptItem[] = (pendingLive ??= [])
    // This call now owns the window, so a `loadOlder` still in flight does not: its request
    // was aborted by ours and it will bail on the generation check, which means the flag it
    // set is ours to clear. Leaving it set made every later `loadOlder` a permanent no-op.
    publish({ loading: true, loadingOlder: false, error: null })
    // A backwards page is fetched to abut a window this call is about to replace, so it is
    // worthless now — and its own owning exit is skipped by the generation check below.
    olderLoad.controller?.abort()
    const page = await fetchFitted(tailLoad, 'tail')
    // A newer loadTail()/reset() started while we were waiting: it owns `pendingLive` now
    // (and aborted our request), so this call touches neither the window nor the buffer.
    if (mine !== generation) return
    pendingLive = null
    if (!page || stopped) {
      // A 404 is "the transcript does not exist yet" (§5.4.4): when it appears it is
      // written from byte 0, so that is where the first live record's bytes begin.
      if (tailLoad.failure === 'missing') liveAnchor = 0
      // **Every OWNING exit clears `loading`.** This call still holds the window (the
      // generation check above proved it), so nothing else is going to clear the flag it
      // set — and a `loading` that outlives its load is a pane stuck in its skeleton state
      // with a complete window behind it. Idempotent with the failure publishes in
      // `fetchPage`, which have already cleared it on the 404 and transport paths.
      loading = false
      if (!stopped) {
        // The window is unchanged, so the records that were held belong to it after all.
        applyAppend(buffered)
        publish({ loading: false })
      }
      return
    }
    chunks = page.items.length || page.size === 0 ? [chunkFromPage(page)] : []
    // **The tail page seeds the frontier.** A frontier advanced only by `append()` knows
    // nothing until the first SSE frame arrives, and the tail page is by definition the
    // newest bytes on disk — so a pane that mounts, loads the tail, and is paged up before
    // any frame lands would have `frontier === null` and §3.6's region would fall back to
    // whatever the retained window still shows: stale historical activity, announced
    // indefinitely. Noting it here, on the page that was actually installed, is what makes
    // the announcement independent of the displayed window rather than merely independent
    // of it once a frame happens to arrive. `noteFrontier` compares by offset, so this
    // cannot walk backwards over a `buffered` record that arrived past the page's end.
    noteFrontier(page.items)
    // A page that carried no complete record installs no chunk, but it did scan to
    // `page.end` — the live tail abuts THAT, not its own first record's post-line offset.
    liveAnchor = chunks.length ? null : page.end
    atStart = page.start === 0
    tailDetached = false
    eof = page.eof
    // The operator is at the live tail, so the oldest records are the ones to lose.
    enforce('oldest')
    // Merged by offset onto the installed page: anything it already contains is dropped by
    // the `o <= last` check, anything past its end is appended in order.
    applyAppend(buffered)
    publish({ loading: false, missing: false, error: null })
  }

  async function loadOlder(): Promise<void> {
    const first = chunks[0]
    // `loading` is in this guard as of the M1 fix: a tail load in flight is about to
    // REPLACE the window, so a page fetched to abut `first` would be spliced onto chunks
    // that are already condemned — the ownership check further down would discard it
    // anyway, one wasted round trip later. Waiting for the replacement and paging up from
    // it is both cheaper and the only reading that is ever right.
    if (!first || atStart || loading || loadingOlder || stopped) return
    // Read, never bump: see `generation`. This call extends the window it started from, so
    // it must abandon everything if that window is replaced underneath it.
    const mine = generation
    publish({ loadingOlder: true })
    const page = await fetchFitted(olderLoad, { before: first.start })
    // A loadTail()/reset()/stop() took the window over while we waited. It aborted this
    // request and has already cleared `loadingOlder` on the window it installed; prepending
    // `first`-relative records onto chunks that no longer exist would splice a page out of
    // a discarded world into the live one.
    if (mine !== generation) return
    if (!page || stopped) {
      // The abort path reaches here with the flag still set (`fetchPage` only publishes on
      // a real HTTP failure), and a flag never cleared is a pane that can never page up
      // again. Clearing it unconditionally is idempotent with the failure publishes above.
      loadingOlder = false
      if (!stopped) publish({ loadingOlder: false })
      return
    }
    // A live append evicted the chunk this page was fetched to sit in front of. It no
    // longer abuts the window, and prepending it would leave a hole between two spans that
    // §5.4.4 says are contiguous — the next scroll-up refetches from the new first chunk.
    if (chunks[0] !== first) {
      loadingOlder = false
      publish({ loadingOlder: false })
      return
    }
    // A window that starts mid-line skips forward to the first newline, so the returned
    // span can overlap what we already hold. Keep only the records strictly before us.
    const older = page.items.filter((item) => item.o <= first.start)
    if (older.length) {
      chunks.unshift({
        start: page.start,
        end: older[older.length - 1]!.o,
        items: older,
        live: false,
      })
    }
    atStart = page.start === 0
    // Evict from the NEWEST edge: the operator is reading upward, and evicting the oldest
    // would throw away the page this call just fetched. Losing the tail means live records
    // no longer abut the window, which `tailDetached` says out loud rather than silently
    // stitching a gap.
    enforce('newest')
    publish({ loadingOlder: false, error: null })
  }

  /**
   * Advance the out-of-window frontier (§3.6). By OFFSET, so a replay cannot rewind it, and
   * so it does not matter whether a tail page or the live records buffered across its fetch
   * are merged first. Returns whether it moved — `append`'s two early exits publish only
   * when it did, so a detached pane does not re-render once per SSE batch for a frontier
   * that has not changed. (`loadTail` ignores the return: it publishes unconditionally.)
   */
  const noteFrontier = (incoming: readonly TranscriptItem[]): boolean => {
    let moved = false
    for (const item of incoming) {
      if (!frontier || item.o > frontier.o) { frontier = item; moved = true }
    }
    return moved
  }

  function append(incoming: TranscriptItem[]): void {
    if (!incoming.length || stopped) return
    // The frontier is noted BEFORE either bail below: §3.6's live region is about the run,
    // and both of the paths that drop a record from the retained window still owe the
    // operator an announcement that the agent is doing something new.
    const moved = noteFrontier(incoming)
    // A tail page is in flight: hold these rather than write them into a list that fetch is
    // about to replace. `tailDetached` is deliberately NOT consulted here — a `loadTail()`
    // from the "jump to latest" affordance is precisely how a detached pane rejoins the
    // live edge, and these records belong to the window it is about to install.
    if (pendingLive) {
      for (const item of incoming) pendingLive.push(item)
      if (moved) publish()
      return
    }
    // Paging up evicted the tail, so these records do not abut the retained span (see
    // `applyAppend`). The window stays exactly as the operator left it; only the frontier
    // — which is not part of it — moves, and that is what the publish carries.
    if (tailDetached) {
      if (moved) publish()
      return
    }
    applyAppend(incoming)
  }

  function applyAppend(incoming: TranscriptItem[]): void {
    if (!incoming.length || stopped) return
    // Paging up evicted the tail, so these records do not abut the retained span and
    // appending them would forge a contiguous window out of two disjoint ones. They stay
    // on disk; `loadTail()` is how the pane rejoins the live edge. `append()` has already
    // advanced the out-of-window frontier for them, which is what keeps §3.6's live region
    // speaking about the run while the window stays where the operator put it.
    if (tailDetached) return
    // The high-water mark spans chunks: it has to survive the seal below, or the first
    // record of every new live chunk would bypass the duplicate check.
    let last = chunks.length ? chunks[chunks.length - 1]!.end : -1
    let tail = chunks[chunks.length - 1]
    const sealed = (chunk: Chunk | undefined): boolean =>
      !chunk || !chunk.live || chunk.items.length >= liveChunkRecords || chunkBytes(chunk) >= liveChunkBytes
    if (sealed(tail)) {
      // With no chunk to abut, `liveAnchor` is the byte offset the stream is known to
      // resume at; the first record's own `o` is its END, and starting there would count it
      // as zero bytes against the §9.3 window.
      const start = tail ? tail.end : Math.min(liveAnchor ?? incoming[0]!.o, incoming[0]!.o)
      liveAnchor = null
      chunks.push((tail = { start, end: start, items: [], live: true }))
    }
    for (const item of incoming) {
      // Records already retained (a replay the client did not classify as a reset) must not
      // render twice — P8's "zero duplicates" reaches all the way down to here.
      if (item.o <= last) continue
      // A live chunk that has reached either seal starts a new one, so no single chunk can
      // grow past the window on its own and make eviction unable to reach the bound.
      if (sealed(tail)) chunks.push((tail = { start: tail!.end, end: tail!.end, items: [], live: true }))
      tail!.items.push(item)
      tail!.end = item.o
      last = item.o
    }
    enforce('oldest')
    publish({ missing: false })
  }

  async function reset(): Promise<void> {
    chunks = []
    records = 0
    bytes = 0
    evicted = 0
    atStart = false
    tailDetached = false
    eof = false
    liveAnchor = null
    // `sys/reset` replays this stream from byte 0 (§5.6.4), so every offset the old frontier
    // was measured against belongs to a file this store no longer has. Keeping it would let a
    // pre-reset record outrank every post-reset one forever, since the frontier only advances.
    frontier = null
    publish()
    // `loadTail` bumps `generation` synchronously, which is what supersedes a `loadOlder`
    // in flight (and clears the flag it left set).
    await loadTail()
  }

  return {
    store,
    loadTail,
    loadOlder,
    append,
    reset,
    stop() {
      stopped = true
      // Every load in flight is superseded, including a `loadOlder` whose flag would
      // otherwise survive into a store nobody publishes from again.
      generation++
      pendingLive = null
      loading = false
      loadingOlder = false
      tailLoad.controller?.abort()
      tailLoad.controller = null
      olderLoad.controller?.abort()
      olderLoad.controller = null
    },
  }
}
