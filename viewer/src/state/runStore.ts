/**
 * `runStore` — the run page's data layer (DESIGN §9.3).
 *
 * Flow, exactly as specified: fetch snapshot → seed fold state + offsets → open SSE with
 * that cursor → fold batches **at most once per animation frame** → subscribers re-render
 * from immutable snapshots (parity #104).
 *
 * ## The latch, stated as rules
 *
 * These are the four rules the design recon arrived at the hard way, and every one of
 * them is a test in `runStore.test.ts`:
 *
 * 1. **Latch off the FOLDED terminal state, never the polled one** (parity #101). The
 *    status poll can report `completed` while the stream is still replaying the events
 *    that get the fold there — a run whose result landed before its transcript did. If a
 *    poll verdict could close the stream, that replay would be severed and the agent list
 *    truncated. So the poll updates the displayed state and **nothing else**; only the
 *    server's `sys/end` (§5.6.4 — terminal fold ∧ terminal `deriveRunState` ∧ 2 s of
 *    silence) closes the connection. `sse.ts` takes no poll input at all, so this is
 *    structural rather than a discipline.
 *
 *    And the `sys/end` itself is gated on the same folded verdict, not merely on the
 *    frame's arrival: `endGate` (below) folds every record already in hand and answers
 *    from `foldState.run`. An `end` that arrives while the fold is still non-terminal is
 *    held — the replay stays open — and re-asked after every subsequent fold, so the
 *    quiet-close happens on the frame that folds the terminal run event and not before.
 *    "Latch off the folded state" is then true of BOTH inputs that could close a stream,
 *    which is what the phrase in §9.3 actually says.
 * 2. **Never invent staleness from silence** (parity #102). There is no timer here that
 *    turns quiet into dead. Liveness verdicts come only from `sys/state` frames and from
 *    `deriveRunState` through the poll.
 * 3. **Quiet-close, then keep polling** (parity #98/#100). After `sys/end` the stream is
 *    closed so an auto-started viewer can idle out — but the 10 s status poll continues,
 *    because that is the only way a run resumed *later* is ever noticed.
 * 4. **Re-arm on revival** (parity #99, #118). A poll that finds the run alive again, or
 *    finds bytes past our cursor, or finds a new attempt, re-seeds from that snapshot and
 *    re-opens the stream. Nothing about the page reloads.
 *
 * ## Per-stream resets
 *
 * `sys/reset` drops exactly one stream's buffers (§9.4). For an agent transcript that is
 * the pane's page cache, forwarded to `transcriptStore`. For `events` the buffer IS the
 * fold, so the fold is dropped and rebuilt from the replay the server is about to send;
 * for `journal` it is the join delta plus the base the server had computed for the file
 * that no longer exists. Neither touches the other, and neither touches the agents.
 *
 * "The journal's buffers" means **all** of them, and that is what `JournalBase` is: one
 * object holding the snapshot's entire journal projection — per-key agent facts, keyless
 * agents joined by index, pre-E7 question answers, mail origin/callsite/`skipped`, steer
 * origins by `mailId`, and the aggregate `spend`. `seedFoldState` strips exactly that set
 * out of the fold so none of it has a second home, and a journal reset is then two
 * assignments. Otherwise an emptied rotated journal keeps reporting the old spend, session
 * ids, answers, mail origins and steering provenance forever, and a replacement journal
 * replayed from 0 gets ADDED to a base that describes a file which no longer exists.
 *
 * ## One door for every publication
 *
 * Every change to the published snapshot — folded records, connection status, `sys/state`,
 * resets, poll results AND poll failures — goes through `commit()` behind the coalescer.
 * P5 bounds *subscriber notifications*, so a `store.update()` anywhere else is a commit the
 * budget cannot see: a poll landing inside a saturated 60/s stream would make it 61.
 */

import { ApiError } from '../api/client.js'
import {
  createSseClient,
  type CursorMap,
  type SseClient,
  type SseCtor,
  type SseStatus,
  type SseTimers,
  type StreamFrame,
  type SysRecord,
} from '../api/sse.js'
import type { AgentView, RunDetail, RunState } from '../api/types.js'
import {
  createFoldState,
  deriveCaps,
  fold,
  materializeFold,
  runIsDead,
  runIsLive,
  seedFoldState,
  terminalOrStale,
  type FoldRecord,
  type FoldState,
  type MaterializedFold,
} from '../fold/index.js'
import {
  applyJournalJoin,
  createJournalBase,
  createJournalDelta,
  ingestJournalRecord,
  journalBaseFromDetail,
  type JournalBase,
  type JournalDelta,
  type Usage,
} from '../fold/journalJoin.js'
import { createCoalescer, defaultFrames, type FrameScheduler } from '../lib/frames.js'
import { createStore, type Store } from '../lib/store.js'

/** §9.3's vocabulary. `polling` is "the stream is not carrying us — the poll is". */
export type ConnectionState = 'live' | 'polling' | 'ended' | 'gone'

export interface RunSnapshot {
  runId: string
  detail: RunDetail | null
  /** The liveness verdict. `sys/state` frames and `deriveRunState` only (parity #102). */
  runState: RunState | null
  connection: ConnectionState
  /** The raw stream status, for the connection chip's tooltip. */
  streamStatus: SseStatus
  loading: boolean
  error: ApiError | null
  /** Events whose `type` the fold does not recognize — §6.5's debug row. */
  unknownEvents: number
  /** `sys/note` frames: records the server skipped (oversize, unparseable). */
  notes: number
  /** Store commits since `start()`. The assertion surface for P5. */
  commits: number
}

/** The slice of `api` this store needs — an object so tests can hand it a fake. */
export interface RunStoreApi {
  runDetail(runId: string, signal?: AbortSignal): Promise<RunDetail>
}

export interface RunStoreOptions {
  runId: string
  api: RunStoreApi
  agents?: number[]
  token?: string | null
  basePath?: string
  /** §9.3: the status poll runs at 10 s, before AND after the stream quiet-closes. */
  pollMs?: number
  frames?: FrameScheduler
  /** Wall clock for P5's commit floor. Injected so tests can assert a rate. */
  now?: () => number
  timers?: SseTimers
  EventSourceImpl?: SseCtor | null
  /** Transcript records, already coalesced into this frame's commit. */
  onAgentRecords?: (index: number, records: FoldRecord[]) => void
  /** `sys/reset` for an agent stream: that pane drops its buffer and refetches (§5.6.4). */
  onAgentReset?: (index: number) => void
}

export interface RunStoreHandle {
  store: Store<RunSnapshot>
  /** Fetch the snapshot, seed, open the stream, start the poll. Idempotent. */
  start(): Promise<void>
  /** Tear everything down. Safe to call twice. */
  stop(): void
  /** Force a status poll now (the resume button's optimistic follow-up). */
  refresh(): Promise<void>
  /** Change the streamed transcript set — a close-and-reopen on a stateless server. */
  setAgents(indices: number[]): void
  /** Commit any records folded but not yet published. Tests and teardown. */
  flush(): void
  readonly cursor: CursorMap
  readonly stream: SseClient | null
}

const TAIL_RECORDS = 200

/**
 * Mirrors `summarizeAgents` in `src/viewer/snapshot.js` (the counts `RunSummary.agents`
 * carries). It is duplicated rather than shared because it lives in the server's snapshot
 * assembly, not in `fold.js` — see the report's spec-defect note.
 */
export function summarizeAgents(agents: AgentView[]): RunDetail['agentCounts'] {
  const counts = { total: agents.length, done: 0, failed: 0, running: 0, cached: 0 }
  for (const a of agents) {
    if (a.state === 'done') counts.done++
    else if (a.state === 'failed' || a.state === 'cancelled') counts.failed++
    else if (a.state === 'running' || a.state === 'queued') counts.running++
    if (a.state === 'cached' || a.cached) counts.cached++
  }
  return counts
}

/**
 * How a bounded tail becomes a total again.
 *
 * `RunDetail` sends the most recent 200 mail/log records plus the authoritative
 * `mailTotal`/`logTotal` (§5.4.3), so the seeded fold arrays are a TAIL, not the history:
 * `projected.mail.length` is at most 200 no matter how many records the run wrote. A run
 * with 5,000 prior logs would read `logTotal: 200` the instant this store took over. So
 * the totals are carried as a base per attempt scope, alongside how many records the
 * snapshot actually seeded, and every streamed record past that seed increments them.
 * Scopes opened after seeding have no entry: their arrays ARE their history.
 */
interface ScopeSeed { mailTotal: number; mailSeeded: number; logTotal: number; logSeeded: number }

const finiteCount = (value: unknown, fallback: number): number =>
  (Number.isFinite(value) && (value as number) >= 0 ? value as number : fallback)

function seedScopeTotals(detail: RunDetail): ScopeSeed[] {
  // The same rule `seedFoldState` uses to decide what the scopes are, so the two lists
  // are index-aligned by construction.
  const scopes = (detail.attemptScopes ?? []).length
    ? detail.attemptScopes!
    : [{
      phases: detail.phases ?? [],
      mail: detail.mail ?? [],
      mailTotal: detail.mailTotal,
      logs: detail.logs ?? [],
      logTotal: detail.logTotal,
    }]
  return scopes.map((scope) => ({
    mailSeeded: scope.mail?.length ?? 0,
    mailTotal: finiteCount(scope.mailTotal, scope.mail?.length ?? 0),
    logSeeded: scope.logs?.length ?? 0,
    logTotal: finiteCount(scope.logTotal, scope.logs?.length ?? 0),
  }))
}

const agentIndexOf = (stream: string): number | null => {
  if (!/^a(0|[1-9][0-9]*)$/.test(stream)) return null
  return Number(stream.slice(1))
}

export function createRunStore(options: RunStoreOptions): RunStoreHandle {
  const { runId, api } = options
  const pollMs = options.pollMs ?? 10_000
  const frames = options.frames ?? defaultFrames()
  const timers: SseTimers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }

  let agents = [...(options.agents ?? [])]

  const store = createStore<RunSnapshot>({
    runId,
    detail: null,
    runState: null,
    connection: 'polling',
    streamStatus: 'idle',
    loading: true,
    error: null,
    unknownEvents: 0,
    notes: 0,
    commits: 0,
  })

  // ---- the folded world ----------------------------------------------------------------
  let base: RunDetail | null = null
  let foldState: FoldState = createFoldState()
  let journalBase: JournalBase = createJournalBase()
  let journalDelta: JournalDelta = createJournalDelta()
  /** Per attempt scope: the totals the snapshot carried, and how much of each it sent. */
  let scopeSeeds: ScopeSeed[] = []
  let runState: RunState | null = null
  let liveDetail: string | null = null
  let notes = 0
  let commits = 0
  /**
   * The last request failure. Held here rather than patched onto the published snapshot,
   * because EVERY publication has to go through `commit()` for P5's budget to mean
   * anything: a `store.update()` on the poll path is a real subscriber notification that
   * the coalescer never counted and never rate-limited (parity #104).
   */
  let apiError: ApiError | null = null

  let sse: SseClient | null = null
  let streamStatus: SseStatus = 'idle'
  let pollHandle: unknown = null
  let started = false
  let stopped = false
  let inFlight: AbortController | null = null
  /**
   * **Which snapshot request is allowed to write.**
   *
   * `refresh()` — the resume button's optimistic follow-up, and every other manual poll —
   * can be in flight at the same time as the scheduled 10 s one, and the network does not
   * answer in the order it was asked. Aborting the previous request is NOT sufficient on
   * its own: `abort()` is advisory, so a response already past the wire, a cached one, or
   * any implementation that does not watch the signal still resolves and walks through
   * every check below. Only the NEWEST request may write, and that is what this counts.
   *
   * The failure it closes is not cosmetic: an older `completed` response landing after a
   * newer `running` one had already re-seeded and re-opened the stream put `runState` back
   * to `completed` — which re-renders every live agent as `orphaned` (§6.4 step 8) on a run
   * that is demonstrably alive, with a stream open and folding underneath it.
   */
  let requestEpoch = 0

  // Records folded in this frame but not yet published (parity #104).
  let pendingEvents: FoldRecord[] = []
  let pendingJournal: unknown[] = []
  let pendingAgents = new Map<number, FoldRecord[]>()

  const connectionFor = (status: SseStatus): ConnectionState => {
    if (status === 'gone') return 'gone'
    if (status === 'ended') return 'ended'
    if (status === 'live') return 'live'
    return 'polling'
  }

  // ---- composition ---------------------------------------------------------------------

  function composeDetail(): RunDetail | null {
    if (!base) return null
    const caps = deriveCaps(foldState.run)
    const projected: MaterializedFold = materializeFold(foldState, runState, caps)
    // The SAME predicate `materializeFold` applied one line above (§6.4 step 8): if the
    // journal join disagreed with the projection about liveness, a quiescent run's rollups
    // would contradict its own rows.
    const dead = runIsDead(runState)
    const { spend } = applyJournalJoin(projected, journalBase, journalDelta, { dead })
    const run = (projected.run ?? {}) as Record<string, unknown>
    const cursor = sse?.cursor ?? {}
    const scopes = projected.attemptScopes ?? []

    // `materializeFold` returns the current scope's arrays BY REFERENCE as `mail`/`logs`,
    // so this identifies the current scope exactly rather than assuming it is the last.
    const currentIndex = scopes.findIndex((s) => s.mail === projected.mail)
    const totalFor = (index: number, kind: 'mail' | 'log', length: number): number => {
      const seed = scopeSeeds[index]
      if (!seed) return length
      const seeded = kind === 'mail' ? seed.mailSeeded : seed.logSeeded
      const total = kind === 'mail' ? seed.mailTotal : seed.logTotal
      return total + Math.max(0, length - seeded)
    }

    return {
      ...base,
      state: (runState ?? base.state) as RunState,
      liveDetail,
      startedAt: (run.startedAt as number | null) ?? null,
      endedAt: (run.endedAt as number | null) ?? null,
      // The run event is the CANONICAL metadata (src/engine.js:1281–1294) and the snapshot
      // is only what was known before it landed — a page opened between `createdAt` and the
      // `started` emit has nothing but `fallbackName(workflowFile)` (snapshot.js:297), and
      // must adopt the real name the moment the event folds. `?? base` keeps the server's
      // resolution for every run event that omits a field: a run whose `meta.name` is null
      // folds `name: null` and correctly falls back.
      name: (run.name as string | null) ?? base.name,
      // Same rule, with the pre-E3 shape behind it: `workflowFile` is the absolute path the
      // run event carries (engine.js:1287) and `file` its basename (:1285) — the snapshot's
      // journal-meta answer (snapshot.js:292) outranks the basename but not the path.
      workflowFile: (run.workflowFile as string | null) ?? base.workflowFile ?? (run.file as string | null) ?? null,
      defaults: (run.defaults as RunDetail['defaults']) ?? base.defaults,
      engine: (run.engine as string | null) ?? base.engine,
      concurrency: Number.isInteger(run.concurrency) ? run.concurrency as number : base.concurrency,
      declaredPhases: Array.isArray(run.phases)
        ? run.phases as RunDetail['declaredPhases']
        : base.declaredPhases,
      budgetTotal: (run.budgetTotal as number | null) ?? base.budgetTotal,
      agents: projected.agents,
      agentCounts: summarizeAgents(projected.agents),
      adapters: [...new Set(projected.agents.map((a) => a.adapter).filter(Boolean))],
      spend: spend as Usage | null,
      openQuestions: projected.openQuestions,
      resumeCount: projected.resumeCount,
      phases: projected.phases,
      questions: projected.questions,
      mail: projected.mail.slice(-TAIL_RECORDS),
      mailTotal: totalFor(currentIndex, 'mail', projected.mail.length),
      logs: projected.logs.slice(-TAIL_RECORDS),
      logTotal: totalFor(currentIndex, 'log', projected.logs.length),
      structure: projected.structure,
      saturation: projected.saturation,
      attemptSpans: projected.attemptSpans,
      attemptScopes: scopes.map((scope, index) => ({
        phases: scope.phases,
        mail: scope.mail.slice(-TAIL_RECORDS),
        mailTotal: totalFor(index, 'mail', scope.mail.length),
        logs: scope.logs.slice(-TAIL_RECORDS),
        logTotal: totalFor(index, 'log', scope.logs.length),
        // Archived per-attempt agents ride through unchanged: seeded from the snapshot or
        // written by the fold when an SSE `resumed` closes a scope. Absence stays absent.
        ...(scope.agents ? { agents: scope.agents } : {}),
        // The scope's opening-event engine rides the same rule — `null` is a recorded
        // verdict (older engine), absence a pre-field archive.
        ...(scope.engine !== undefined ? { engine: scope.engine } : {}),
      })),
      offsets: {
        events: typeof cursor.e === 'number' ? cursor.e : base.offsets?.events ?? 0,
        journal: typeof cursor.j === 'number' ? cursor.j : base.offsets?.journal ?? 0,
      },
      caps,
      unknownEvents: projected.unknownEvents,
      unknownEventTypes: projected.unknownEventTypes,
    }
  }

  function commit(): void {
    commits++
    const detail = composeDetail()
    store.set({
      runId,
      detail,
      runState,
      connection: connectionFor(streamStatus),
      streamStatus,
      loading: false,
      error: apiError,
      unknownEvents: detail?.unknownEvents ?? 0,
      notes,
      commits,
    })
  }

  /**
   * Advance the FOLD with everything queued since the last frame — the events fold and the
   * journal delta, and nothing that leaves this store.
   *
   * Separated from `commit()` because the end gate needs the fold advanced WITHOUT
   * publishing: §9.3's folded verdict has to see records that are in hand but not yet on
   * screen. Separated from `deliverAgentRecords()` for the opposite reason — see there.
   */
  function drainFold(): void {
    if (pendingEvents.length) {
      fold(foldState, pendingEvents)
      pendingEvents = []
    }
    if (pendingJournal.length) {
      for (const record of pendingJournal) ingestJournalRecord(journalDelta, record)
      pendingJournal = []
    }
  }

  /**
   * Hand this frame's transcript records to their panes — **from inside the frame, only**.
   *
   * `onAgentRecords` is a publication: a real `transcriptStore` appends and notifies its own
   * subscribers synchronously, so a call from anywhere but the coalescer is a subscriber
   * notification the P5 budget cannot see. This used to live in the same function as
   * `drainFold`, which the end gate calls — so a server `sys/end` arriving between frames
   * delivered the pending transcript records on the spot, ahead of the commit that was
   * supposed to carry them, and the ≤60/s bound stopped holding for exactly the mixed
   * terminal batch a run ends with. The gate needs the fold; it does not need the panes.
   */
  function deliverAgentRecords(): void {
    if (!pendingAgents.size) return
    const batch = pendingAgents
    pendingAgents = new Map()
    for (const [index, records] of batch) options.onAgentRecords?.(index, records)
  }

  /**
   * The FOLDED terminal verdict — the only thing allowed to latch a `sys/end` (§9.3 rule
   * 1). It reads `foldState.run`, never `runState`: the latter carries the poll's and
   * `sys/state`'s answers, and a poll that says `completed` while the events stream is
   * still replaying must not be able to sever that replay (parity #101).
   *
   * §6.4 step 1: a terminal run event sets `endedAt`, and a `resumed` event clears it —
   * so `endedAt` alone also covers the zero-length-attempt case (a workflow that failed
   * during module load emits only the terminal event, critique N14).
   */
  function foldedTerminal(): boolean {
    drainFold()
    const run = foldState.run as { state?: unknown; endedAt?: unknown } | null
    if (!run) return false
    return terminalOrStale(run.state) || run.endedAt != null
  }

  /** Guards against a status change published mid-cycle committing a second time. */
  let committing = false

  /** One commit per frame at most, and never more than 60/s (P5, parity #104). */
  const coalescer = createCoalescer(() => {
    committing = true
    try {
      drainFold()
      // These records may be exactly what a deferred `sys/end` was waiting for.
      sse?.settleEnd()
      // Inside the frame, so the panes and the run snapshot move together and the whole
      // publication is one entry in P5's budget.
      deliverAgentRecords()
      commit()
    } finally {
      committing = false
    }
  }, { schedule: frames, now: options.now ?? (() => Date.now()) })

  /**
   * Both doors are shut by `stop()`, and that is load-bearing rather than defensive.
   *
   * `sse.close()` publishes a status change (`teardown` → `setStatus('closed')`,
   * sse.ts:381–384), so the `onStatus` callback below runs INSIDE `stop()` — after the
   * coalescer was cancelled it would re-arm it, and the next frame would then drain
   * `pendingEvents`, hand transcript records to `onAgentRecords` and notify every
   * subscriber of a store that has been torn down. `stop()` also closes the stream before
   * the final cancel, so the two together leave nothing armed by either order.
   */
  const touch = () => {
    if (stopped) return
    coalescer.request()
  }

  /**
   * Commit now rather than next frame. Reserved for the LOW-frequency signals — connection
   * status, `sys/state`, resets, poll results — where a frame of latency is a visibly wrong
   * connection chip and there is no burst to coalesce. Records already waiting ride along,
   * so the status and the data land in one snapshot rather than two.
   *
   * "Now" is still subject to P5's commit floor: these signals are low-frequency by
   * convention, and the budget must not depend on the server keeping that convention.
   */
  const touchNow = () => {
    if (stopped) return      // see `touch`
    if (committing) return   // the commit in flight will carry it
    coalescer.requestNow()
  }

  // ---- seeding -------------------------------------------------------------------------

  function seed(detail: RunDetail): void {
    base = detail
    foldState = seedFoldState(detail)
    journalBase = journalBaseFromDetail(detail)
    journalDelta = createJournalDelta()
    scopeSeeds = seedScopeTotals(detail)
    runState = detail.state
    liveDetail = detail.liveDetail ?? null
    pendingEvents = []
    pendingJournal = []
    pendingAgents = new Map()
  }

  function openStream(cursor: CursorMap): void {
    sse?.close()
    for (const index of agents) if (!(`a${index}` in cursor)) cursor[`a${index}`] = 'tail'
    sse = createSseClient({
      runId,
      streams: ['events', 'journal'],
      agents,
      cursor,
      token: options.token ?? null,
      basePath: options.basePath ?? '',
      EventSourceImpl: options.EventSourceImpl ?? null,
      timers,
      onBatch: handleBatch,
      onReset: handleReset,
      onSys: handleSys,
      endGate: foldedTerminal,
      onStatus: (status) => {
        streamStatus = status
        touchNow()
      },
    })
    sse.open()
  }

  // ---- stream handlers -----------------------------------------------------------------

  function handleBatch(incoming: StreamFrame[]): void {
    for (const frame of incoming) {
      if (frame.s === 'e') { pendingEvents.push({ o: frame.o, rec: frame.r }); continue }
      if (frame.s === 'j') { pendingJournal.push(frame.r); continue }
      const index = agentIndexOf(frame.s)
      if (index == null) continue
      let list = pendingAgents.get(index)
      if (!list) pendingAgents.set(index, (list = []))
      list.push({ o: frame.o, rec: frame.r })
    }
    touch()
  }

  function handleReset(stream: string): void {
    if (stream === 'e') {
      // The events buffer IS the fold. Drop it; the server replays this stream from 0
      // immediately after the reset frame (§5.6.2 rule 3), which rebuilds it in full.
      // The seeded totals describe the snapshot the dropped fold came from, so they go
      // with it — the replay's own arrays are the whole history from here.
      foldState = createFoldState({ createdAt: base?.createdAt ?? null })
      scopeSeeds = []
      pendingEvents = []
      touchNow()
      return
    }
    if (stream === 'j') {
      // EVERY journal projection describes a file that no longer exists, and `JournalBase`
      // is the object that holds every one of them: the server's per-key join, the keyless
      // agents joined by index, pre-E7 answers, mail origin/callsite/`skipped`, the steer
      // origins E8 correlates by `mailId`, and the aggregate spend. None of them has a second home inside the fold — `seedFoldState`
      // strips exactly this set out of it — precisely so that these two lines are the whole
      // reset. The replacement file replays from 0 (§5.6.2 rule 3), so everything is
      // recomputed exactly once; an empty replacement correctly reports nothing rather than
      // the old file's totals.
      journalBase = createJournalBase()
      journalDelta = createJournalDelta()
      pendingJournal = []
      touchNow()
      return
    }
    const index = agentIndexOf(stream)
    if (index != null) {
      pendingAgents.delete(index)
      options.onAgentReset?.(index)
    }
  }

  function handleSys(record: SysRecord): void {
    if (record.type === 'state') {
      const next = record as { state?: RunState; detail?: string }
      if (next.state) runState = next.state
      liveDetail = next.detail ?? null
      touchNow()
      return
    }
    if (record.type === 'note') { notes++; touchNow(); return }
    // `end` and `gone` are handled by the client's own latch; the status change it emits
    // is what reaches this store. Deliberately nothing else happens here: the run is not
    // "dead" because the stream closed (parity #102) — the poll below owns that verdict.
  }

  // ---- the status poll -----------------------------------------------------------------

  /**
   * Take ownership of the next snapshot request: bump the epoch, abort whatever the last
   * one left running (a superseded answer is wasted bytes even though it can no longer
   * write), and hand back both so the caller can check itself against the epoch after
   * every `await`.
   */
  function beginRequest(): { epoch: number; controller: AbortController } {
    const epoch = ++requestEpoch
    inFlight?.abort()
    const controller = new AbortController()
    inFlight = controller
    return { epoch, controller }
  }

  function schedulePoll(): void {
    if (stopped || pollHandle != null || pollMs <= 0) return
    pollHandle = timers.setTimeout(() => {
      pollHandle = null
      void pollOnce().finally(() => schedulePoll())
    }, pollMs)
  }

  /**
   * The §5.5 correctness floor, and the ONLY thing that ever re-arms a quiet-closed
   * stream. It updates the displayed state unconditionally and severs nothing — rule 1.
   */
  async function pollOnce(): Promise<void> {
    if (stopped) return
    const { epoch, controller } = beginRequest()
    try {
      const detail = await api.runDetail(runId, controller.signal)
      // Superseded: a newer poll has already answered, possibly with a re-seed and a
      // re-opened stream. This response describes a moment that is over.
      if (stopped || epoch !== requestEpoch) return
      runState = detail.state
      liveDetail = detail.liveDetail ?? null
      apiError = null

      if (streamStatus === 'ended' && revived(detail)) {
        seed(detail)
        openStream({ e: detail.offsets.events, j: detail.offsets.journal })
      } else if (!base) {
        // The initial snapshot had failed; this poll is the recovery.
        seed(detail)
        openStream({ e: detail.offsets.events, j: detail.offsets.journal })
      }
      touchNow()
    } catch (err) {
      if (stopped || epoch !== requestEpoch || (err as Error)?.name === 'AbortError') return
      // Keep the last good snapshot on screen behind the banner — a live run must not lose
      // its cockpit because one poll missed. Published through the coalescer like every
      // other change: a poll landing inside a saturated stream must not add a 61st commit.
      apiError = err instanceof ApiError
        ? err
        : new ApiError(0, 'unreachable', String((err as Error)?.message ?? err))
      touchNow()
    } finally {
      if (inFlight === controller) inFlight = null
    }
  }

  /**
   * Parity #99/#118. Three independent signals, because a resume is visible in whichever
   * one the poll happens to catch first: the run is live again, a new attempt was
   * recorded, or the events file simply grew past where we stopped reading.
   */
  function revived(detail: RunDetail): boolean {
    if (runIsLive(detail.state)) return true
    if ((detail.resumeCount ?? 0) > (base?.resumeCount ?? 0)) return true
    const seen = sse?.cursor.e
    return typeof seen === 'number' && detail.offsets.events > seen
  }

  // ---- lifecycle -----------------------------------------------------------------------

  async function start(): Promise<void> {
    if (started) return
    started = true
    stopped = false
    const { epoch, controller } = beginRequest()
    try {
      const detail = await api.runDetail(runId, controller.signal)
      // A `refresh()` racing the initial load owns the store now; its own answer seeds
      // (through the `!base` branch in `pollOnce`) and this one is a moment out of date.
      if (stopped || epoch !== requestEpoch) return
      seed(detail)
      openStream({ e: detail.offsets.events, j: detail.offsets.journal })
      // Through the coalescer like every other publication, so the P5 accounting has a
      // single door. `openStream` has usually already published via its status change.
      touchNow()
    } catch (err) {
      if (stopped || epoch !== requestEpoch || (err as Error)?.name === 'AbortError') return
      apiError = err instanceof ApiError
        ? err
        : new ApiError(0, 'unreachable', String((err as Error)?.message ?? err))
      touchNow()
    } finally {
      if (inFlight === controller) inFlight = null
      // The poll arms even when the snapshot failed: it is the retry, and §5.5 makes it the
      // correctness floor rather than a garnish on the stream.
      schedulePoll()
    }
  }

  function stop(): void {
    stopped = true
    started = false
    // The stream goes FIRST: its `close()` emits a status change, and a status change that
    // lands after the cancel re-arms the coalescer (`touch`/`touchNow` above hold the same
    // line from the other side). Cancel afterwards and nothing is left scheduled.
    sse?.close()
    sse = null
    coalescer.cancel()
    inFlight?.abort()
    inFlight = null
    if (pollHandle != null) { timers.clearTimeout(pollHandle); pollHandle = null }
    // Records folded into this frame but never published belong to a store that no longer
    // exists. Dropping them is what makes "no fold change and no transcript delivery after
    // stop()" true even for a `flush()` called afterwards.
    pendingEvents = []
    pendingJournal = []
    pendingAgents = new Map()
  }

  return {
    store,
    start,
    stop,
    refresh: pollOnce,
    setAgents(indices) {
      agents = [...indices]
      sse?.reopen({ agents })
    },
    flush() {
      coalescer.flush()
    },
    get cursor() { return sse?.cursor ?? {} },
    get stream() { return sse },
  }
}
