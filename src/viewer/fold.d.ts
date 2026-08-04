// The declarations for `fold.js` — and, with it, DESIGN §6.2's canonical viewer-facing
// types, verbatim.
//
// §6.2: "These are the wire types of the API and the SPA's domain model.
// `src/viewer/fold.js` produces them; `viewer/src/api/types.ts` re-exports them (generated
// `.d.ts` alongside the JS by hand — the shapes below are the contract)." This file is that
// hand-written `.d.ts`. It exists because the alternative that shipped first — a parallel
// copy of the contract inside `viewer/src/api/types.ts` plus `as unknown as` casts over the
// untyped JS in `viewer/src/fold/index.ts` — is two type surfaces for one wire format, and
// nothing can detect them drifting apart. There is now ONE declaration and two consumers:
//
//   • `viewer/src/fold/index.ts` imports it (it is the SPA's only door onto `fold.js`, and
//     `fold/shared.test.ts` keeps it that way);
//   • `viewer/src/api/types.ts` re-exports it through that door, and declares only the
//     route-shaped payloads (`JsonlPage`, `Session`, …) that the fold has no opinion about.
//
// TypeScript resolves a relative `./fold.js` specifier to this file before the JS, so the
// import in `fold/index.ts` is unchanged and the RUNTIME import is still `fold.js` itself —
// a declaration file emits nothing, so the SPA bundle and the server both keep loading the
// one shared module. `fold/shared.test.ts` asserts that identity by reference; the fold
// tests (`viewer/src/fold/fold.test.ts`, `test/viewer-fold.test.js`) are what hold these
// shapes and the implementation in agreement.
//
// Node does not read this file: `src/**` is plain ESM with zero dependencies (§4.6) and
// nothing here is executable. It ships in the published package with the rest of `src`,
// which is a bonus rather than a requirement.

// ---- §6.2 canonical viewer-facing types --------------------------------------------------

export type RunState =
  | 'running' | 'starting' | 'completed' | 'failed' | 'interrupted'
  | 'corrupt-result' | 'stale' | 'unknown'

export type AgentState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'cached'
// `steered` and `progress` events are annotations folded INTO AgentView, never states.
/** Step transitions are a strict subset of agent states: no queue, no cancel. */
export type StepState = 'running' | 'done' | 'failed' | 'cached'

/** §6.2: one canonical container-path schema (critiques M15/Sol-10). */
export type PathSeg =
  | { kind: 'parallel' | 'pipeline'; ordinal: number; count: number; stages?: number }
  | { kind: 'item'; i: number }
  | { kind: 'stage'; s: number }

export interface RunSummary {
  runId: string
  name: string | null
  workflowFile: string | null
  state: RunState
  liveDetail: string | null
  createdAt: number | null
  startedAt: number | null
  endedAt: number | null
  agents: { total: number; done: number; failed: number; running: number; cached: number }
  adapters: string[]
  spend: { input: number; output: number; cost: number } | null
  budgetTotal: number | null
  /** §6.4 step 8: forced to 0 for terminal/stale runs (critique M6). */
  openQuestions: number
  resumeCount: number
  /**
   * run.log exists. The badge reads "detached log" and NOT "detached" — the file is
   * written by both detached launchers and persists afterwards, so it is not proof the
   * current attempt is detached (critique N12).
   */
  hasRunLog: boolean
}

export interface QuestionView {
  qid: string
  question: string
  askedAt: number
  answered: boolean
  answer: string | null
  replayed: boolean
  /** Asked, never answered, run terminal — the engine rejects pending asks on abort with
   *  NO answer event (critique M6). The composer is disabled. */
  abandoned: boolean
}

export interface MailView {
  at: number
  dir: 'in' | 'out'
  agent: number | null
  message: string
  origin: 'operator' | 'workflow' | null
  delivery: string | null
  mailId: string | null
  callsite: string | null
}

export interface LogView {
  at: number
  message: string
  source: 'workflow' | 'engine'
  level: 'info' | 'warn' | 'error'
  agentIndex: number | null
}

export interface PhaseView {
  phaseIndex: number
  title: string
  agentIndices: number[]
  reached: boolean
  approximate: boolean
}

export interface AgentView {
  index: number
  key: string | null
  label: string | null
  adapter: string
  model: string | null
  effort: string | null
  state: AgentState
  displayState: AgentState | 'orphaned'
  phaseIndex: number | null
  phaseApproximate: boolean
  path: PathSeg[] | null
  promptPreview: string | null
  resultPreview: string | null
  error: string | null
  errorCode: string | null
  retryable: boolean | null
  queuedAt: number | null
  startedAt: number | null
  endedAt: number | null
  waitMs: number | null
  stallMs: number | null
  durationMs: number | null
  /** LIFETIME: summed over all of the key's journal result records (Sol-13). */
  usage: { input: number; output: number; cost: number } | null
  /** The LAST attempt's own result record. */
  attemptUsage: { input: number; output: number; cost: number } | null
  liveTokens: { input: number; output: number } | null
  /**
   * LIFETIME-TO-DATE from the `usage-cum` stream: the chained sum of POSITIVE deltas
   * across every one of the key's `usage-cum` records, which is what makes it
   * zero-reset aware. `usage-cum` speaks two dialects (src/journal.js:5–8) — the
   * provider thread's cumulative totals for adapters that report them, and the job's own
   * per-attempt running totals for per-event adapters, whose counter restarts at `{0,0}`
   * on every attempt (src/agent-proc.js:42,482,520). Chaining positive deltas is correct
   * for both: a continued cumulative report contributes its increment once (never
   * double-counted against earlier attempts), and a restarted counter contributes its
   * own run-up on top of what it already banked. Identical to `Journal.load`'s own
   * budget accounting (src/journal.js:100–116,167–176), which is the point — the viewer
   * and the engine must agree about how many tokens an agent has spent.
   *
   * `null` when the key reported no `usage-cum` at all. It is NOT a substitute for
   * `usage`: a lifetime-to-date figure is `max(usage, cumTokens)` componentwise, because
   * result records can carry usage the cum stream never reported and vice versa.
   */
  cumTokens: { input: number; output: number } | null
  lastTool: string | null
  lastOutputAt: number | null
  resultBytes: number | null
  resultTruncated: boolean
  toolIds: boolean
  sessionId: string | null
  attempts: number
  // `mailId` is E8's additive field on the `steered` event (§8 E8, src/engine.js:657) and
  // is what the journal join correlates a steer's ORIGIN through (snapshot.js:123–129) —
  // the event itself carries no origin, so a steer without an id has none to join to.
  steers: {
    at: number
    origin: 'operator' | 'workflow'
    delivery: string | null
    mailId?: string | null
  }[]
  cached: boolean
}

/**
 * A durable `step()` — journaled local code (src/engine.js stepImpl). Its identity is
 * the journal KEY (branch + ordinal + name + canonical args), not an index: a resume
 * re-run of a failed step folds onto the same entry and clears the previous outcome.
 * `cached` means the completed result was replayed from the journal; nothing executed,
 * so `durationMs` stays null and `endedAt` is the replay instant.
 */
export interface StepView {
  key: string
  name: string | null
  state: StepState
  displayState: StepState | 'orphaned'
  phaseIndex: number | null
  path: PathSeg[] | null
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  error: string | null
  resultPreview: string | null
  cached: boolean
}

export interface StructNode {
  path: PathSeg[]
  kind: 'root' | 'parallel' | 'pipeline' | 'item' | 'stage'
  children: StructNode[]
  agentIndices: number[]
  rollup: { state: AgentState | 'mixed'; costUsd: number; durationMs: number }
}

export type Cap = 'supported' | 'unsupported' | 'pending'

export interface Caps {
  phaseAssociation: Cap
  structure: Cap
  queueEvents: Cap
  progress: Cap
  usageOnEvents: Cap
  mailIds: Cap
  attemptMarkers: Cap
}

/**
 * SPEC DEFECT, resolved in W6's favor: §6.2 writes `interface RunDetail extends
 * RunSummary` while redeclaring `agents` as `AgentView[]`, which cannot extend
 * RunSummary's `agents` COUNT object — the declaration does not compile. W6's
 * `src/viewer/snapshot.js` ships `agents: AgentView[]` plus a separate `agentCounts`
 * carrying the summary shape, which is the only reading that serves both consumers.
 * These types follow the wire, not the prose.
 */
export interface RunDetail extends Omit<RunSummary, 'agents'> {
  /** The RunSummary counts, under their own key (see the note above). */
  agentCounts: RunSummary['agents']
  defaults: { adapter: string; model?: string; effort?: string; cwd?: string } | null
  hasArgs: boolean
  args?: unknown
  argsTruncated?: boolean
  /**
   * Journal `meta.graphDynamic` (src/engine.js:832), projected because §7.3 requires the
   * resume modal to show it. `null` — not `false` — on a run journalled before the field
   * existed (§6.5): the engine refuses to resume a run whose module graph it cannot verify,
   * so "we do not know" and "it was static" are different statements and the modal makes
   * different promises about them.
   */
  graphDynamic?: boolean | null
  engine: string | null
  concurrency: number | null
  declaredPhases: { title: string; detail?: string }[] | null
  phases: PhaseView[]
  agents: AgentView[]
  /** Durable `step()` calls, in event order. Absent on runs from engines without steps. */
  steps?: StepView[]
  questions: QuestionView[]
  mail: MailView[]
  mailTotal: number
  logs: LogView[]
  logTotal: number
  structure: StructNode | null
  saturation: { t: number; active: number; queued: number }[]
  offsets: { events: number; journal: number }
  caps: Caps
  attemptSpans: { state: 'started' | 'resumed' | RunState; t: number }[]
  /**
   * Earlier attempt scopes (§6.4 step 1a), reachable through the lineage strip selector.
   * `phases`/`logs`/`mail` at the top level are the CURRENT scope; these carry all of
   * them, with the same 200-record tails and their own totals.
   *
   * Wire fields W6 ships that §6.2's prose omits — declared here because the client seeds a
   * fold from this payload and needs every part of it (`src/viewer/snapshot.js`).
   */
  attemptScopes?: {
    phases: PhaseView[]
    mail: MailView[]
    mailTotal: number
    logs: LogView[]
    logTotal: number
  }[]
  /** §6.5's debug row: events whose `type` the fold does not recognize. */
  unknownEvents?: number
  /** Per-type breakdown of the above. Maintained client-side; absent on the wire. */
  unknownEventTypes?: Record<string, number>
}

// ---- the fold's own types ----------------------------------------------------------------

/** A JSONL record with the byte offset **after** its newline (§5.6.3 `o`). */
export interface FoldRecord {
  o: number
  rec: Record<string, unknown>
}

export interface AttemptSpan {
  state: 'started' | 'resumed' | RunState
  t: number
}

export interface AttemptScope {
  phases: PhaseView[]
  logs: LogView[]
  mail: MailView[]
}

/**
 * The mutable fold accumulator. Private members (`_`-prefixed) belong to `fold.js`; they
 * are declared through the index signature only so `seedFoldState` can rebuild them, and
 * are never read by the UI. `fold()` updates this object IN PLACE — that is what keeps the
 * SSE reducer O(delta) — so it is not a render snapshot. `materializeFold()` produces those.
 */
export interface FoldState {
  run: Record<string, unknown> | null
  phases: PhaseView[]
  agents: AgentView[]
  steps: StepView[]
  questions: QuestionView[]
  mail: MailView[]
  logs: LogView[]
  structure: StructNode | null
  saturation: { t: number; active: number; queued: number }[]
  attemptSpans: AttemptSpan[]
  resumeCount: number
  attemptScopes: AttemptScope[]
  unknownEvents: number
  unknownEventTypes: Record<string, number>
  lastOffset: number
  [priv: string]: unknown
}

/** What `materializeFold` returns: §6.4 step 8 applied, nothing mutated. */
export interface MaterializedFold {
  run: Record<string, unknown> | null
  phases: PhaseView[]
  agents: AgentView[]
  steps: StepView[]
  questions: QuestionView[]
  mail: MailView[]
  logs: LogView[]
  structure: StructNode | null
  saturation: { t: number; active: number; queued: number }[]
  attemptSpans: AttemptSpan[]
  resumeCount: number
  attemptScopes: AttemptScope[]
  unknownEvents: number
  unknownEventTypes: Record<string, number>
  openQuestions: number
  caps: Caps
  lastOffset: number
}

// ---- the module's runtime surface ---------------------------------------------------------

/** The engine version E1–E12 first shipped in. */
export const FIRST_VIEWER_EVENT_VERSION: string
/** E11: the version from which transcripts pair tools by id. */
export const TOOL_IDS_VERSION: string
/** The minimum engine version each §6.2 `Cap` requires (critique M2: version, not fields). */
export const CAP_VERSIONS: Readonly<Record<keyof Caps, string>>

export function createFoldState(options?: { createdAt?: number | null }): FoldState

/**
 * Fold complete JSONL records in **byte order** (§6.4 — never `t`). The returned object is
 * the supplied state, updated in place.
 */
export function fold(prev: FoldState | null, recs: FoldRecord[]): FoldState

export function semverGte(actual: unknown, minimum: unknown): boolean

/** §6.2: caps come from the run event's `engine` version, never from field presence. */
export function deriveCaps(run: unknown): Caps

/** The FOLDED engine status is terminal, or the run is stale (never a liveness verdict). */
export function terminalOrStale(state: unknown): boolean

/** §5.4.2 liveness: `running|starting` and nothing else may move the screen. */
export function runIsLive(state: unknown): boolean

/** The complement of {@link runIsLive} — §6.4 step 8's "the run has stopped". */
export function runIsDead(state: unknown): boolean

/** §6.4 step 8: the run-state-aware projection, with the raw fold left untouched. */
export function materializeFold(
  raw: FoldState | null,
  runState: RunState | string | null | undefined,
  caps?: Caps,
): MaterializedFold
