// Fixtures shaped as the REAL W6 read API returns them (§6.2 / src/viewer/summaries.js
// and snapshot.js), not as the components happen to want them. The fictional world is the
// one the approved comps use, so a reviewer can hold the two side by side.

import { ApiError, type RunsQuery } from '../../api/client.js'
import type { QuestionView, RunDetail, RunSummary, RunsPage, Session } from '../../api/types.js'

export const NOW = 1_764_000_000_000

const base = (over: Partial<RunSummary> & { runId: string }): RunSummary => ({
  name: null,
  workflowFile: null,
  state: 'completed',
  liveDetail: null,
  createdAt: NOW - 3_600_000,
  startedAt: NOW - 3_600_000,
  endedAt: NOW - 3_500_000,
  agents: { total: 0, done: 0, failed: 0, running: 0, cached: 0 },
  adapters: [],
  spend: null,
  budgetTotal: null,
  openQuestions: 0,
  resumeCount: 0,
  hasRunLog: false,
  ...over,
})

export const RUNS: RunSummary[] = [
  base({
    runId: 'r_2f91c4a8',
    name: 'judge-panel-auth-refactor',
    workflowFile: '/home/ben/projects/flowition/judge-panel.workflow.js',
    state: 'running',
    liveDetail: 'run.lock held by live pid 51204',
    createdAt: NOW - 1_278_000,
    startedAt: NOW - 1_278_000,
    endedAt: null,
    agents: { total: 10, done: 4, failed: 1, running: 2, cached: 0 },
    adapters: ['claude', 'codex', 'amp', 'droid', 'opencode'],
    spend: { input: 1_204_000, output: 375_100, cost: 9.052 },
    budgetTotal: 340_000,
    resumeCount: 1,
    hasRunLog: true,
  }),
  base({
    runId: 'r_a03d51e7',
    name: 'migrate-callsites',
    state: 'running',
    createdAt: NOW - 620_000,
    startedAt: NOW - 620_000,
    endedAt: null,
    agents: { total: 6, done: 2, failed: 0, running: 1, cached: 0 },
    adapters: ['claude', 'codex'],
    spend: { input: 82_000, output: 41_400, cost: 1.204 },
    openQuestions: 1,
  }),
  // A stale run as the SERVER actually produces one. `endedAt` is set from a terminal run
  // event and from nothing else (src/viewer/summaries.js:115-118, DESIGN §6.2), and a run
  // is `stale` precisely because it stopped WITHOUT writing one — the lock is held by a pid
  // that is gone. So `endedAt: null` is not an edge case here, it is the only shape this
  // state has, and the fixture that once gave it a terminal timestamp was flattering the
  // UI: it hid a card that reported the run's age as its time of death (review round 4).
  base({
    runId: 'r_77b0e412',
    name: 'audit-viewer-security',
    state: 'stale',
    liveDetail: 'run.lock held by pid 48812 — not running',
    createdAt: NOW - 4_200_000,
    startedAt: NOW - 4_200_000,
    endedAt: null,
    agents: { total: 9, done: 5, failed: 0, running: 0, cached: 0 },
    adapters: ['claude'],
    spend: { input: 300_100, output: 96_400, cost: 4.1 },
    hasRunLog: true,
  }),
  base({
    runId: 'r_5c1d9a30',
    name: 'flaky-test-hunt',
    state: 'failed',
    agents: { total: 4, done: 1, failed: 3, running: 0, cached: 0 },
    adapters: ['codex'],
    spend: { input: 40_000, output: 12_000, cost: 0.42 },
  }),
  base({
    runId: 'r_9ab24d10',
    name: 'docs-sweep',
    state: 'completed',
    agents: { total: 8, done: 2, failed: 0, running: 0, cached: 6 },
    adapters: ['claude', 'pi'],
    spend: { input: 120_000, output: 33_000, cost: 1.11 },
    resumeCount: 2,
  }),
  // Row with NO cost in its journal — the cell must render blank, never $0.00 (#114).
  base({
    runId: 'r_11c9f0aa',
    name: 'hello.workflow.js',
    state: 'completed',
    agents: { total: 1, done: 1, failed: 0, running: 0, cached: 0 },
    adapters: ['mock'],
    spend: null,
  }),
  // Row with NO name — the run id renders in mono instead.
  base({
    runId: 'flo_0f2d44b1',
    state: 'completed',
    agents: { total: 2, done: 2, failed: 0, running: 0, cached: 0 },
    adapters: ['amp'],
    spend: { input: 9_000, output: 2_400, cost: 0.09 },
  }),
  // A state a NEWER engine emits, which this client has never heard of (§6.5).
  base({
    runId: 'r_future01',
    name: 'from-a-newer-engine',
    state: 'quarantined' as never,
    agents: { total: 1, done: 0, failed: 0, running: 0, cached: 0 },
    adapters: ['zeta'],
  }),
]

export const RUNS_PAGE: RunsPage = { runs: RUNS, nextCursor: null, totalOnDisk: RUNS.length }

/**
 * A stale run that started long ago and — like every nonterminal stale run — has no
 * `endedAt`. Its whole job is to make the difference visible: a card that infers death
 * time from `startedAt` says "died 3d ago" about a run it cannot date at all, and its
 * runtime figure climbs for as long as the tab stays open.
 *
 * Parameterized by `startedAt` because Home's clock is the real `Date.now()` whenever
 * nothing is live, so a test that wants "three days old" has to say so against that clock
 * rather than against this file's frozen `NOW`.
 */
export const oldStaleRun = (startedAt: number): RunSummary => base({
  runId: 'r_oldstale',
  name: 'nightly-doc-sweep',
  state: 'stale',
  liveDetail: 'run.lock held by pid 3312 — not running',
  createdAt: startedAt,
  startedAt,
  endedAt: null,
  agents: { total: 4, done: 1, failed: 0, running: 0, cached: 0 },
  adapters: ['codex'],
  spend: { input: 20_000, output: 8_000, cost: 0.31 },
})

export const SESSION: Session = {
  version: '0.2.0',
  home: '/home/ben/projects/flowition/.flowition',
  control: ['send', 'answer', 'cancel', 'resume', 'delete'],
  readOnly: false,
}

export const READ_ONLY_SESSION: Session = {
  version: '0.2.0',
  home: '/home/ben/projects/flowition/.flowition',
  control: [],
  readOnly: true,
}

/** The RunDetail behind the blocked card, carrying the question text §2.3 shows inline. */
export const BLOCKED_DETAIL: RunDetail = {
  ...RUNS[1]!,
  agents: [],
  agentCounts: RUNS[1]!.agents,
  defaults: { adapter: 'claude' },
  hasArgs: false,
  engine: '0.2.0',
  concurrency: 2,
  declaredPhases: null,
  phases: [],
  questions: [{
    qid: 'q_9d41',
    question: 'Two call sites in src/cli.js pass a bare string where the new adapter API expects {path}. Rewrite both, or keep a compatibility shim for one release?',
    askedAt: NOW - 120_000,
    answered: false,
    answer: null,
    replayed: false,
    abandoned: false,
  }],
  mail: [], mailTotal: 0, logs: [], logTotal: 0,
  structure: null, saturation: [],
  offsets: { events: 0, journal: 0 },
  caps: {
    phaseAssociation: 'supported', structure: 'supported', queueEvents: 'supported',
    progress: 'supported', usageOnEvents: 'supported', mailIds: 'supported',
    attemptMarkers: 'supported',
  },
  attemptSpans: [],
}

// ---- a §5.4.2-faithful fake listing, for the pagination tests ------------------------

/** A synthetic run, for the tests that need more runs than the designed world has. */
export const makeRun = (i: number, over: Partial<RunSummary> = {}): RunSummary => base({
  runId: `r_gen${String(i).padStart(4, '0')}`,
  name: `generated-run-${String(i).padStart(4, '0')}`,
  // Descending createdAt with i, so index order IS the server's newest-first order.
  createdAt: NOW - 10_000 - i * 1_000,
  startedAt: NOW - 10_000 - i * 1_000,
  endedAt: NOW - 9_000 - i * 1_000,
  ...over,
})

export interface FakeListing {
  load: (query: RunsQuery) => Promise<RunsPage>
  /** Every query the component actually sent — the cursor contract is asserted on these. */
  calls: RunsQuery[]
}

/**
 * `GET /api/runs` as §5.4.2 specifies it, including the parts that BITE:
 *   • `limit` over 200 is a 400, not a bigger page;
 *   • paging is keyset — `cursor` is opaque and identifies the last row of the page
 *     before it, so pages stay stable while rows are appended at the top;
 *   • `state` accepts RunState names only, and rejects anything else (so a test can prove
 *     the client never sends `state=blocked`);
 *   • `totalOnDisk` counts the whole disk, not the filtered slice.
 */
export function fakeListing(all: RunSummary[]): FakeListing {
  const calls: RunsQuery[] = []
  // §5.4.2 step 3: createdAt desc, runId as the tiebreak — the keyset order itself.
  const ordered = [...all].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
    || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
  const known = new Set([
    'running', 'starting', 'completed', 'failed', 'interrupted', 'corrupt-result',
    'stale', 'unknown',
  ])

  const load = async (query: RunsQuery = {}): Promise<RunsPage> => {
    calls.push({ ...query })
    const limit = query.limit ?? 50
    if (limit < 1 || limit > 200) throw new ApiError(400, 'bad_request', 'limit must be between 1 and 200')
    let pool = ordered
    if (query.state) {
      const states = query.state.split(',').map((s) => s.trim()).filter(Boolean)
      if (states.some((s) => !known.has(s))) {
        throw new ApiError(400, 'bad_request', 'state contains an unknown run state')
      }
      pool = pool.filter((r) => states.includes(r.state))
    }
    if (query.q) {
      const needle = query.q.toLowerCase()
      pool = pool.filter((r) => `${r.name ?? ''} ${r.runId}`.toLowerCase().includes(needle))
    }
    let start = 0
    if (query.cursor) {
      const after = atob(query.cursor)
      const at = pool.findIndex((r) => r.runId === after)
      if (at < 0) throw new ApiError(400, 'bad_request', 'cursor does not address this listing')
      start = at + 1
    }
    const page = pool.slice(start, start + limit)
    const last = page[page.length - 1]
    const nextCursor = last && start + limit < pool.length ? btoa(last.runId) : null
    return { runs: page, nextCursor, totalOnDisk: all.length }
  }

  return { load, calls }
}

// ---- a run that asks TWICE, with a server that refuses a repeat answer ----------------

/**
 * One `running` run with TWO open `ask()` questions, plus a listing, a detail and an
 * `answer` that behave like the real server:
 *
 *   • answering resolves exactly one qid, and the run STAYS BLOCKED with its runId
 *     unchanged — the state in which a card keyed only by run ids holds a dead qid;
 *   • `openQuestions` drops by one, because that is the only part of the LISTING that
 *     moves when a question is resolved;
 *   • answering the same qid twice is `409 already answered` — the engine resolves a qid
 *     once (src/engine.js:1113's unique qids), and the viewer maps a refused control
 *     command to a conflict. So a client that re-offers an answered question does not
 *     merely look stale here: it FAILS, exactly as it did in review.
 */
export function twoQuestionRun() {
  const questions: QuestionView[] = [
    {
      qid: 'q_first',
      question: 'First: rewrite both call sites, or keep a shim for one release?',
      askedAt: NOW - 240_000,
      answered: false, answer: null, replayed: false, abandoned: false,
    },
    {
      qid: 'q_second',
      question: 'Second: should the shim log a deprecation warning on every call?',
      askedAt: NOW - 90_000,
      answered: false, answer: null, replayed: false, abandoned: false,
    },
  ]
  const answered = new Set<string>()
  const open = () => questions.length - answered.size

  const summary = (): RunSummary => base({
    runId: 'r_twoq',
    name: 'asks-twice',
    state: 'running',
    createdAt: NOW - 300_000,
    startedAt: NOW - 300_000,
    endedAt: null,
    agents: { total: 3, done: 1, failed: 0, running: 1, cached: 0 },
    adapters: ['claude'],
    openQuestions: open(),
  })

  const load = async (query: RunsQuery = {}): Promise<RunsPage> => {
    const states = query.state ? query.state.split(',').map((s) => s.trim()) : null
    // The run is `running`, so it answers the unfiltered listing and every active-state
    // scan, and never the stale one.
    const runs = !states || states.includes('running') ? [summary()] : []
    return { runs, nextCursor: null, totalOnDisk: 1 }
  }

  const loadDetail = async (): Promise<RunDetail> => ({
    ...BLOCKED_DETAIL,
    runId: 'r_twoq',
    name: 'asks-twice',
    openQuestions: open(),
    questions: questions.map((q) => (
      answered.has(q.qid) ? { ...q, answered: true, answer: 'recorded' } : q
    )),
  })

  const answer = async (_runId: string, qid: string, _value: unknown): Promise<unknown> => {
    if (answered.has(qid)) throw new ApiError(409, 'conflict', 'already answered')
    answered.add(qid)
    return undefined
  }

  return { questions, answered, load, loadDetail, answer }
}
