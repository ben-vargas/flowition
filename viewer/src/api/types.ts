// The wire types of the read API — DESIGN §6.2.
//
// §6.2 and §9.2 both say this file RE-EXPORTS the canonical declarations that live
// alongside `src/viewer/fold.js`, and that is now literally what it does: they are declared
// once, in `src/viewer/fold.d.ts`, and forwarded here through `../fold/index.ts` — the one
// door onto the shared module that `fold/shared.test.ts` allows. The earlier revision
// declared its own copy of the same contract because fold.js shipped without declarations;
// a second hand-maintained copy of a wire format is drift waiting to happen, and no test
// can see it. What stays local below is the part the fold has no opinion about: the
// route-shaped payloads (`RunsPage`, `JsonlPage`, `Session`, …), which exist only between
// this client and `src/viewer/routes.js`.

export type {
  AgentState,
  AgentView,
  Cap,
  Caps,
  LogView,
  MailView,
  PathSeg,
  PhaseView,
  QuestionView,
  RunDetail,
  RunState,
  RunSummary,
  StepState,
  StepView,
  StructNode,
} from '../fold/index.js'

import type { RunState, RunSummary } from '../fold/index.js'

/** `GET /api/runs` (§5.4.2) — a page of the listing. */
export interface RunsPage {
  runs: RunSummary[]
  nextCursor: string | null
  totalOnDisk: number
}

/**
 * `GET …/agents/:n/page` and `GET …/events/page` (§5.4.4, §5.4.6) — one byte window of a
 * JSONL file. `o` is the offset AFTER the record's newline, which is exactly the unit the
 * SSE cursor speaks, so a page and a stream can be stitched without translation.
 */
export interface JsonlPage {
  items: { o: number; rec: Record<string, unknown> }[]
  start: number
  end: number
  size: number
  eof: boolean
}

/** `GET …/result` and `GET …/agents/:n/result` (§5.4.5). */
export interface ResultPayload {
  runId?: string
  status?: string
  resultBytes?: number
  result?: unknown
  error?: unknown
  resultTruncated?: boolean
  preview?: string
  corrupt?: boolean
  pending?: boolean
  state?: RunState
}

/** `GET …/search` (§5.4.7). */
export interface SearchResults {
  matches: { agent: number | null; o: number; kind: string; snippet: string }[]
  truncated: boolean
}

/** `GET /api/session` (§5.3) — the SPA's capability bootstrap. */
export interface Session {
  version: string
  home: string
  /** Enabled mutation capabilities: send | answer | cancel | resume | delete (§7.2). */
  control: string[]
  readOnly: boolean
}

/**
 * `POST /api/runs/:id/resume` (§7.3), `202`.
 *
 * `launchAccepted` means LAUNCH ACCEPTED AND NOTHING MORE — the engine's own preflight
 * (fileHash/graphHash/args) has not run yet, and its verdict arrives later through the
 * run's events. `mode` echoes which §7.3 operation the server performed so the UI can say
 * "Replay" for a completed run and "Resume" for a dead one without re-deriving state.
 */
export interface ResumeAccepted {
  runId: string
  launchAccepted: boolean
  mode: 'replay' | 'resume'
  from: RunState
}

/**
 * `POST /api/runs/:id/send` (§7.2), `200` — W12.
 *
 * `delivery` is the engine's own delivery verdict, passed through verbatim by the bridge
 * (src/viewer/control-bridge.js:286-301) including a word this build has never heard of.
 * The composer renders it through `features/control/verdict.ts`; it is never normalized
 * here, because §6.5's degradation contract runs in both directions.
 */
export interface SendAccepted {
  ok: boolean
  runId: string
  agent: number | string
  delivery: string | null
}

/**
 * `POST /api/runs/:id/answer` (§7.2) answers `{ok, runId, qid}` and never echoes the value
 * back. The client deliberately types it as `unknown`: nothing in the UI reads the reply —
 * the authority on an answered question is the run's own `answer` event, arriving through
 * the snapshot — and a declared shape here would invite a caller to trust the POST instead.
 */

/**
 * `POST /api/runs/:id/cancel` (§7.2), `200`.
 *
 * `scope` echoes which of the two cancels the server performed — the distinction critique
 * N5 is about (an `agent` key that is present but wrong must never become a whole-run
 * abort), so the client shows what actually happened rather than what it intended.
 * `cancelled` is the job index for an agent cancel and the string `'run'` for a run abort.
 */
export interface CancelAccepted {
  ok: boolean
  runId: string
  scope: 'agent' | 'run'
  cancelled: number | string | null
}

/**
 * `DELETE /api/runs/:id` (§7.3), `200`. "Irreversible" is really "recoverable for a week":
 * the run is renamed into `$FLOWITION_HOME/trash/<entry>` and purged after `trashTtlDays`.
 */
export interface DeleteAccepted {
  ok: boolean
  runId: string
  trashEntry: string
  trashedAt: number
  trashTtlDays: number
}

/** The §5.2 error envelope. */
export interface ApiErrorBody {
  error: { code: string; message: string; runId?: string }
}

/** §2.3's state filter chips map onto the listing's `state` parameter. */
export const RUN_STATE_FILTERS = [
  'running', 'blocked', 'failed', 'completed', 'stale',
] as const
export type RunStateFilter = typeof RUN_STATE_FILTERS[number]
