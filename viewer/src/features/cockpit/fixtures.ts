/**
 * Cockpit fixtures, shaped as the REAL W6 read API returns them (§6.2 /
 * `src/viewer/snapshot.js`), carrying the same fictional world as the approved comps
 * (`docs/frontend/comps/lib/fixtures.mjs`) so a reviewer can hold the built screen and the
 * comp side by side.
 *
 * The cockpit run is a MECHANICALLY VALID semaphore trace at `concurrency: 2` — every
 * admission is the direct consequence of a slot freeing, FIFO in queue order. That matters:
 * a Gantt whose queue-wait segments do not add up teaches a reviewer to distrust the chart,
 * and a saturation strip derived from an invalid trace proves nothing about the component.
 */

import type {
  AgentView, Caps, LogView, MailView, PhaseView, QuestionView, RunDetail, StructNode,
} from '../../api/types.js'
import { isActiveState } from './honesty.js'

/** t=0 for the whole world. The run started here; `NOW` is 14m02s later. */
export const T0 = 1_764_000_000_000
export const SPAN_MS = 842_000
export const NOW = T0 + SPAN_MS
export const CONCURRENCY = 2

export const SUPPORTED: Caps = {
  phaseAssociation: 'supported',
  structure: 'supported',
  queueEvents: 'supported',
  progress: 'supported',
  usageOnEvents: 'supported',
  mailIds: 'supported',
  attemptMarkers: 'supported',
}

const allCaps = (value: Caps[keyof Caps]): Caps =>
  Object.fromEntries(Object.keys(SUPPORTED).map((k) => [k, value])) as unknown as Caps

export const UNSUPPORTED: Caps = allCaps('unsupported')
export const PENDING: Caps = allCaps('pending')

const agent = (over: Partial<AgentView> & { index: number }): AgentView => ({
  key: `k${over.index}`,
  label: null,
  adapter: 'claude',
  model: null,
  effort: null,
  state: 'done',
  displayState: over.state ?? 'done',
  phaseIndex: null,
  phaseApproximate: false,
  path: null,
  promptPreview: null,
  resultPreview: null,
  error: null,
  errorCode: null,
  retryable: null,
  queuedAt: null,
  startedAt: null,
  endedAt: null,
  waitMs: null,
  stallMs: null,
  durationMs: null,
  usage: null,
  attemptUsage: null,
  liveTokens: null,
  cumTokens: null,
  lastTool: null,
  lastOutputAt: null,
  resultBytes: null,
  resultTruncated: false,
  toolIds: true,
  sessionId: null,
  attempts: 1,
  steers: [],
  cached: false,
  ...over,
})

/**
 * The ten agents of `judge-panel-auth-refactor`. `admitBecause` in the comp fixtures is the
 * audit note for each admission; it is reproduced here as a comment per row.
 */
export const AGENTS: AgentView[] = [
  // run start — slot 1 of 2
  agent({
    index: 0, label: 'survey:auth', adapter: 'claude', model: 'opus-5', effort: 'high',
    phaseIndex: 0, state: 'done', path: [{ kind: 'parallel', ordinal: 0, count: 3 }, { kind: 'item', i: 0 }],
    queuedAt: T0, startedAt: T0, endedAt: T0 + 134_000, waitMs: 0, durationMs: 134_000,
    usage: { input: 182_400, output: 38_100, cost: 0.712 }, lastTool: 'Read', stallMs: 1_800_000,
  }),
  // run start — slot 2 of 2
  agent({
    index: 1, label: 'survey:routes', adapter: 'codex', model: 'gpt-5.6-sol', effort: 'high',
    phaseIndex: 0, state: 'done', path: [{ kind: 'parallel', ordinal: 0, count: 3 }, { kind: 'item', i: 1 }],
    queuedAt: T0, startedAt: T0, endedAt: T0 + 118_000, waitMs: 0, durationMs: 118_000,
    usage: { input: 141_000, output: 31_400, cost: 0.418 }, lastTool: 'Grep', stallMs: 1_800_000,
  }),
  // cache hit — never took a slot
  agent({
    index: 2, label: 'survey:tests', adapter: 'droid',
    phaseIndex: 0, state: 'cached', cached: true,
    path: [{ kind: 'parallel', ordinal: 0, count: 3 }, { kind: 'item', i: 2 }],
    queuedAt: T0, startedAt: T0, endedAt: T0, waitMs: 0,
    usage: { input: 77_400, output: 9_800, cost: 0.121 },
  }),
  // survey:auth released a slot at 2m14s
  agent({
    index: 3, label: 'review:auth', adapter: 'claude', model: 'opus-5', effort: 'high',
    phaseIndex: 1, state: 'done',
    path: [{ kind: 'pipeline', ordinal: 1, count: 5, stages: 2 }, { kind: 'item', i: 0 }, { kind: 'stage', s: 0 }],
    queuedAt: T0 + 134_000, startedAt: T0 + 134_000, endedAt: T0 + 322_000, waitMs: 0, durationMs: 188_000,
    usage: { input: 311_600, output: 61_200, cost: 1.441 }, lastTool: 'Read', stallMs: 1_800_000,
    steers: [{ at: T0 + 200_000, origin: 'workflow', delivery: 'queued', mailId: 'm1' }],
  }),
  // survey:routes released a slot at 1m58s — and the CLI was not installed
  agent({
    index: 4, label: 'review:routes', adapter: 'codex', model: 'gpt-5.6-sol', effort: 'high',
    phaseIndex: 1, state: 'failed',
    path: [{ kind: 'pipeline', ordinal: 1, count: 5, stages: 2 }, { kind: 'item', i: 1 }, { kind: 'stage', s: 0 }],
    queuedAt: T0 + 134_000, startedAt: T0 + 134_000, endedAt: T0 + 136_000, waitMs: 0, durationMs: 2_000,
    errorCode: 'spawn_failed', retryable: false,
    error: 'codex: command not found — run `flowition doctor`',
    attempts: 1, stallMs: 1_800_000,
  }),
  // review:routes failed at 2m16s, freeing its slot. Quiet for 6m18s against a 10m stall.
  agent({
    index: 5, label: 'review:tests', adapter: 'claude', model: 'opus-5', effort: 'xhigh',
    phaseIndex: 1, state: 'running',
    path: [{ kind: 'pipeline', ordinal: 1, count: 5, stages: 2 }, { kind: 'item', i: 2 }, { kind: 'stage', s: 0 }],
    queuedAt: T0 + 134_000, startedAt: T0 + 136_000, waitMs: 2_000,
    // A workflow-tightened stall budget: 10m, so 6m18s of silence is past the 50% mark.
    stallMs: 600_000, lastOutputAt: T0 + 464_000, lastTool: 'Grep',
    // THE RESET DIALECT (§6.2 `cumTokens`). This agent was steered twice and restarted;
    // its adapter reports the JOB's own running totals, so the live counter went back to
    // zero on the current attempt and now reads 28.6k — a third of what the agent has
    // actually spent. `usage` is the two settled result records; `cumTokens` is the
    // chained cum stream across all three attempts. The lifetime figure is neither of
    // the two alone, which is precisely why an earlier revision of this fixture (usage
    // === liveTokens) could not fail (review round 4, B3).
    usage: { input: 300_000, output: 90_000, cost: 3.204 },
    liveTokens: { input: 102_900, output: 28_600 },
    cumTokens: { input: 402_900, output: 118_600 },
    attempts: 2,
    steers: [
      { at: T0 + 300_000, origin: 'operator', delivery: 'live', mailId: 'm2' },
      { at: T0 + 420_000, origin: 'operator', delivery: 'live', mailId: 'm3' },
    ],
  }),
  // review:auth released a slot at 5m22s
  agent({
    index: 6, label: 'review:client', adapter: 'amp',
    phaseIndex: 1, state: 'done',
    path: [{ kind: 'pipeline', ordinal: 1, count: 5, stages: 2 }, { kind: 'item', i: 3 }, { kind: 'stage', s: 0 }],
    queuedAt: T0 + 134_000, startedAt: T0 + 322_000, endedAt: T0 + 468_000,
    waitMs: 188_000, durationMs: 146_000,
    usage: { input: 206_800, output: 44_600, cost: 0.831 }, lastTool: 'Bash', stallMs: 1_800_000,
  }),
  // review:client released a slot at 7m48s
  agent({
    index: 7, label: 'review:docs', adapter: 'pi',
    phaseIndex: 1, state: 'running',
    path: [{ kind: 'pipeline', ordinal: 1, count: 5, stages: 2 }, { kind: 'item', i: 4 }, { kind: 'stage', s: 0 }],
    queuedAt: T0 + 134_000, startedAt: T0 + 468_000, waitMs: 334_000,
    stallMs: 1_800_000, lastOutputAt: T0 + 806_000, lastTool: 'Edit',
    // THE CONTINUED DIALECT. `pi` reports the provider THREAD's cumulative totals, so the
    // live counter already contains everything the settled result record charged. The
    // lifetime figure is 71.4k — the two must not be added, and a join that banked the
    // continued report a second time would show 142.8k here.
    usage: { input: 188_100, output: 71_400, cost: 2.318 },
    liveTokens: { input: 188_100, output: 71_400 },
    cumTokens: { input: 188_100, output: 71_400 },
  }),
  // waiting — both slots held by review:tests and review:docs
  agent({
    index: 8, label: 'verify:auth', adapter: 'opencode', model: 'qwen3-coder',
    phaseIndex: 1, state: 'queued', attempts: 0,
    path: [{ kind: 'pipeline', ordinal: 1, count: 5, stages: 2 }, { kind: 'item', i: 0 }, { kind: 'stage', s: 1 }],
    queuedAt: T0 + 322_000,
  }),
  // waiting — behind verify:auth in the semaphore queue
  agent({
    index: 9, label: 'verify:client', adapter: 'opencode', model: 'qwen3-coder',
    phaseIndex: 1, state: 'queued', attempts: 0,
    path: [{ kind: 'pipeline', ordinal: 1, count: 5, stages: 2 }, { kind: 'item', i: 3 }, { kind: 'stage', s: 1 }],
    queuedAt: T0 + 468_000,
  }),
]

/** E4 saturation samples. Ceiling 2; the run sits on it for 13 of 14 minutes. */
export const SATURATION = [
  { t: T0, active: 2, queued: 0 },
  { t: T0 + 118_000, active: 1, queued: 0 },
  { t: T0 + 134_000, active: 2, queued: 3 },
  { t: T0 + 136_000, active: 2, queued: 2 },
  { t: T0 + 322_000, active: 2, queued: 2 },
  { t: T0 + 468_000, active: 2, queued: 2 },
]

export const PHASES: PhaseView[] = [
  { phaseIndex: 0, title: 'Survey', agentIndices: [0, 1, 2], reached: true, approximate: false },
  { phaseIndex: 1, title: 'Review', agentIndices: [3, 4, 5, 6, 7, 8, 9], reached: true, approximate: false },
]

const node = (over: Partial<StructNode> & { path: StructNode['path']; kind: StructNode['kind'] }): StructNode => ({
  children: [],
  agentIndices: [],
  rollup: { state: 'done', costUsd: 0, durationMs: 0 },
  ...over,
})

/** The E2 tree exactly as `src/viewer/fold.js:389` scaffolds it: every slot pre-created. */
export const STRUCTURE: StructNode = node({
  path: [], kind: 'root',
  rollup: { state: 'mixed', costUsd: 9.045, durationMs: SPAN_MS },
  children: [
    node({
      path: [{ kind: 'parallel', ordinal: 0, count: 3 }], kind: 'parallel',
      rollup: { state: 'done', costUsd: 1.251, durationMs: 134_000 },
      children: [0, 1, 2].map((i) => node({
        path: [{ kind: 'parallel', ordinal: 0, count: 3 }, { kind: 'item', i }],
        kind: 'item',
        agentIndices: [i],
        rollup: { state: 'done', costUsd: 0, durationMs: 0 },
      })),
    }),
    node({
      path: [{ kind: 'pipeline', ordinal: 1, count: 5, stages: 2 }], kind: 'pipeline',
      rollup: { state: 'mixed', costUsd: 7.794, durationMs: 708_000 },
      children: [0, 1, 2, 3, 4].map((i) => node({
        path: [{ kind: 'pipeline', ordinal: 1, count: 5, stages: 2 }, { kind: 'item', i }],
        kind: 'item',
        rollup: { state: 'mixed', costUsd: 0, durationMs: 0 },
        children: [0, 1].map((s) => node({
          path: [
            { kind: 'pipeline', ordinal: 1, count: 5, stages: 2 },
            { kind: 'item', i }, { kind: 'stage', s },
          ],
          kind: 'stage',
          agentIndices: AGENTS
            .filter((a) => {
              const p = a.path
              if (!p || p.length !== 3) return false
              const item = p[1] as { kind: string; i: number }
              const stage = p[2] as { kind: string; s: number }
              return p[0]!.kind === 'pipeline' && item.i === i && stage.s === s
            })
            .map((a) => a.index),
          rollup: { state: 'queued', costUsd: 0, durationMs: 0 },
        })),
      })),
    }),
  ],
})

export const LOGS: LogView[] = [
  { at: T0 + 0, message: 'cache hit — replaying result for survey:tests', source: 'engine', level: 'info', agentIndex: 2 },
  { at: T0 + 134_000, message: 'phase: Review', source: 'workflow', level: 'info', agentIndex: null },
  { at: T0 + 136_000, message: 'spawn failed: codex (ENOENT)', source: 'engine', level: 'error', agentIndex: 4 },
  { at: T0 + 468_000, message: 'review:client returned 4 findings', source: 'workflow', level: 'info', agentIndex: 6 },
  { at: T0 + 667_000, message: 'ask(q_7f2a) — awaiting operator answer', source: 'engine', level: 'info', agentIndex: 5 },
  { at: T0 + 770_000, message: 'no provider output for 6m — stall threshold 10m', source: 'engine', level: 'warn', agentIndex: 5 },
  { at: T0 + 822_000, message: 'sem: 2/2 in flight, 2 queued', source: 'engine', level: 'info', agentIndex: null },
  { at: T0 + 839_000, message: 'drafting the docs section…', source: 'workflow', level: 'info', agentIndex: 7 },
]

export const MAIL: MailView[] = [
  {
    at: T0 + 300_000, dir: 'in', agent: 5, message: 'Also check the SSE endpoint for token leakage.',
    origin: 'operator', delivery: 'live', mailId: 'm2', callsite: null,
  },
  {
    at: T0 + 620_000, dir: 'out', agent: 5, message: 'Two high-severity findings so far.',
    origin: null, delivery: null, mailId: 'm4', callsite: null,
  },
]

export const QUESTIONS: QuestionView[] = [
  {
    qid: 'q_7f2a',
    question: 'review:tests wants to rewrite two call sites in src/cli.js that pass a bare '
      + 'string where the adapter API expects {path}. Rewrite both, or keep a shim?',
    askedAt: T0 + 667_000, answered: false, answer: null, replayed: false, abandoned: false,
  },
  {
    qid: 'q_1b04',
    question: 'Should the survey include vendored fonts?',
    askedAt: T0 + 90_000, answered: true, answer: 'no — they are ours', replayed: false,
    abandoned: false,
  },
]

/**
 * §6.4 step 1a's earlier scope. The first attempt reached `Survey` and was interrupted; its
 * phases, logs and mail are on the wire and are unreachable without the lineage selector.
 */
export const ATTEMPT_0 = {
  phases: [
    { phaseIndex: 0, title: 'Survey', agentIndices: [0, 1], reached: true, approximate: false },
    // A phase the FIRST attempt entered and the second one never did — the workflow took a
    // different branch after the resume. Agents are not scoped (§6.4 step 1a), so this is
    // the phase-level difference between the two scopes that is actually observable.
    { phaseIndex: 3, title: 'Bootstrap', agentIndices: [], reached: true, approximate: false },
  ] as PhaseView[],
  logs: [
    { at: T0 - 1_440_000, message: 'phase: Survey', source: 'workflow', level: 'info', agentIndex: null },
    { at: T0 - 1_010_000, message: 'first attempt interrupted — SIGINT', source: 'engine', level: 'warn', agentIndex: null },
  ] as LogView[],
  logTotal: 118,
  mail: [
    {
      at: T0 - 1_200_000, dir: 'in' as const, agent: 0,
      message: 'Start with the token handoff.', origin: 'operator' as const,
      delivery: 'live', mailId: 'm0', callsite: 'judge-panel.workflow.js:18',
    },
  ] as MailView[],
  mailTotal: 1,
}

/** The live run at the head of the comps' world: 14m02s in, over budget, resumed once. */
export const LIVE_RUN: RunDetail = {
  runId: 'r_2f91c4a8',
  name: 'judge-panel-auth-refactor',
  workflowFile: '/home/ben/projects/flowition/workflows/judge-panel.workflow.js',
  state: 'running',
  liveDetail: 'run.lock held by live pid 51204',
  createdAt: T0 - 1_440_000,
  startedAt: T0,
  endedAt: null,
  agentCounts: { total: 10, done: 4, failed: 1, running: 4, cached: 1 },
  adapters: ['claude', 'codex', 'droid', 'amp', 'pi', 'opencode'],
  spend: { input: 1_510_000, output: 375_100, cost: 9.045 },
  budgetTotal: 340_000,
  openQuestions: 1,
  resumeCount: 1,
  hasRunLog: true,
  defaults: { adapter: 'claude', model: 'opus-5', effort: 'high' },
  hasArgs: true,
  engine: '0.2.0',
  concurrency: CONCURRENCY,
  declaredPhases: [{ title: 'Survey' }, { title: 'Review' }, { title: 'Report' }],
  phases: PHASES,
  agents: AGENTS,
  questions: QUESTIONS,
  mail: MAIL,
  mailTotal: 5,
  logs: LOGS,
  logTotal: 1_842,
  structure: STRUCTURE,
  saturation: SATURATION,
  offsets: { events: 128_400, journal: 96_100 },
  caps: SUPPORTED,
  attemptSpans: [
    { state: 'started', t: T0 - 1_440_000 },
    { state: 'interrupted', t: T0 - 960_000 },
    { state: 'resumed', t: T0 },
  ],
  attemptScopes: [
    ATTEMPT_0,
    { phases: PHASES, logs: LOGS, logTotal: 1_842, mail: MAIL, mailTotal: 5 },
  ],
}

/**
 * The stale run. Note what it does NOT have: `endedAt`. A run is `stale` precisely because
 * the engine went away without writing a terminal event, so there is no time of death, and
 * a fixture that invented one would flatter every honesty test written against it.
 */
export const STALE_RUN: RunDetail = {
  ...LIVE_RUN,
  runId: 'r_77c1be92',
  name: 'audit-viewer-security',
  state: 'stale',
  liveDetail: 'run.lock held by pid 48812 — not running',
  createdAt: T0 - 4_200_000,
  startedAt: T0 - 4_200_000,
  endedAt: null,
  budgetTotal: null,
  spend: { input: 612_000, output: 148_200, cost: 4.1 },
  resumeCount: 0,
  openQuestions: 0,
  concurrency: 2,
  declaredPhases: [{ title: 'Survey' }, { title: 'Audit' }],
  phases: [
    { phaseIndex: 0, title: 'Survey', agentIndices: [0, 1], reached: true, approximate: false },
    { phaseIndex: 1, title: 'Audit', agentIndices: [2, 3, 4], reached: true, approximate: false },
  ],
  structure: null,
  saturation: [],
  agents: [
    agent({
      index: 0, label: 'survey:routes', adapter: 'claude', phaseIndex: 0, state: 'done',
      queuedAt: T0 - 4_200_000, startedAt: T0 - 4_200_000, endedAt: T0 - 4_002_000,
      waitMs: 0, durationMs: 198_000, usage: { input: 88_000, output: 21_000, cost: 0.9 },
    }),
    agent({
      index: 1, label: 'survey:auth', adapter: 'codex', phaseIndex: 0, state: 'done',
      queuedAt: T0 - 4_200_000, startedAt: T0 - 4_200_000, endedAt: T0 - 4_039_000,
      waitMs: 0, durationMs: 161_000, usage: { input: 74_000, output: 18_000, cost: 0.7 },
    }),
    agent({
      index: 2, label: 'audit:csp', adapter: 'claude', phaseIndex: 1, state: 'done',
      queuedAt: T0 - 4_002_000, startedAt: T0 - 4_000_000, endedAt: T0 - 3_762_000,
      waitMs: 2_000, durationMs: 238_000, usage: { input: 120_000, output: 40_000, cost: 1.4 },
    }),
    // Left mid-flight: `running` on a dead run, so §6.4 step 8 renders it ORPHANED and the
    // bar stops at the last provider output rather than being extended to now.
    agent({
      index: 3, label: 'audit:tokens', adapter: 'codex', phaseIndex: 1, state: 'running',
      displayState: 'orphaned',
      queuedAt: T0 - 4_002_000, startedAt: T0 - 4_000_000, lastOutputAt: T0 - 3_876_000,
      waitMs: 2_000, lastTool: 'Grep', usage: { input: 130_000, output: 29_200, cost: 0.6 },
    }),
    agent({
      index: 4, label: 'audit:rebinding', adapter: 'claude', phaseIndex: 1, state: 'queued',
      displayState: 'orphaned', attempts: 0, queuedAt: T0 - 3_800_000,
    }),
  ],
  logs: [
    { at: T0 - 4_200_000, message: 'phase: Survey', source: 'workflow', level: 'info', agentIndex: null },
    { at: T0 - 3_876_000, message: 'audit:tokens — 2 findings', source: 'workflow', level: 'info', agentIndex: 3 },
  ],
  logTotal: 412,
  questions: [],
  mail: [],
  mailTotal: 0,
  attemptSpans: [{ state: 'started', t: T0 - 4_200_000 }],
  // One attempt, so one scope — and therefore no selector (§6.4 step 1a).
  attemptScopes: [{ phases: [], logs: [], logTotal: 412, mail: [], mailTotal: 0 }],
}

/**
 * A run that FAILED with work still in flight, keeping the live run's containers and
 * phases. The stale fixture above has `structure: null`, so it exercises the flat
 * fallback and can never catch a container header that spins on a dead run — and its
 * phase tree was never opened by a test either (review round 4, B1).
 *
 * `displayState` is §6.4 step 8's post-pass, applied here exactly as the server applies
 * it: every agent left `queued`/`running` when the run died is `orphaned`.
 */
export const DEAD_STRUCTURED_RUN: RunDetail = {
  ...LIVE_RUN,
  runId: 'r_dead0001',
  name: 'judge-panel-aborted',
  state: 'failed',
  liveDetail: null,
  endedAt: NOW,
  openQuestions: 0,
  questions: QUESTIONS.map((q) => (q.answered ? q : { ...q, abandoned: true })),
  agents: AGENTS.map((a) => (isActiveState(a.state)
    ? { ...a, displayState: 'orphaned' as const }
    : a)),
  attemptSpans: [
    { state: 'started', t: T0 - 1_440_000 },
    { state: 'interrupted', t: T0 - 960_000 },
    { state: 'resumed', t: T0 },
    { state: 'failed', t: NOW },
  ],
}

/**
 * The QUIESCENT run (review round 5, B1) — `corrupt-result`, with work still in flight.
 *
 * DESIGN §5.4.2 (DESIGN.md:816) puts `corrupt-result` in the quiescent tier beside `stale`
 * and `unknown`: "not terminal, but nothing changes them without a lock or marker
 * appearing". `deriveRunState` reaches it only after the control socket fails to answer AND
 * `run.lock` holds no live pid (src/run-state.js:141–152) — the engine is gone; only its
 * result file is unreadable. Deriving death as `terminalOrStale` left every §6.4 step 8 rule
 * on the live side for exactly this state.
 *
 * Two deliberate choices make it a real test rather than a restatement:
 *   • `displayState` is NOT pre-applied. Unlike `DEAD_STRUCTURED_RUN`, whose agents arrive
 *     already `orphaned`, these arrive `running`/`queued` — so anything that stops spinning
 *     here is the CLIENT's own liveness rule, not a value handed to it.
 *   • `endedAt` is `null`. A corrupt result carries no trustworthy time of death, so the
 *     elapsed clock cannot freeze structurally; it freezes only if the cockpit stops
 *     ticking, which is the defect this fixture exists to catch.
 */
export const CORRUPT_RUN: RunDetail = {
  ...LIVE_RUN,
  runId: 'r_corrupt1',
  name: 'judge-panel-corrupt',
  state: 'corrupt-result',
  liveDetail: 'result.json is corrupt: Unexpected end of JSON input',
  endedAt: null,
  // As the server sends it once §6.4 step 8 treats the state as dead: the engine rejects
  // pending questions on abort with no `answer` event, so a live count would be phantom.
  openQuestions: 0,
  questions: QUESTIONS.map((q) => (q.answered ? q : { ...q, abandoned: true })),
  attemptSpans: [
    { state: 'started', t: T0 - 1_440_000 },
    { state: 'interrupted', t: T0 - 960_000 },
    { state: 'resumed', t: T0 },
  ],
}

/**
 * THE RETAINED-DURATION RUN (review round 8, B1) — a quiescent run whose orphan carries a
 * PREVIOUS attempt's runtime.
 *
 * `agent.durationMs` is journal-derived (§6.4 J): the join restores it from the last SETTLED
 * `result` record for the key. `review:tests` has `attempts: 2`, so on a resume it is holding
 * the first attempt's 1m01s while the second attempt — the one the engine abandoned — never
 * recorded an end at all. Round 7 taught the Gantt to refuse that number; the Agents table,
 * the Structure chip and the container roll-up all still printed and summed it, so the same
 * agent read "end unrecorded" in one tab and "1m1s" in the other two.
 *
 * Built on `CORRUPT_RUN` deliberately: its `displayState` post-pass is absent, so the refusal
 * has to come from the client's own verdict, and it keeps LIVE_RUN's containers so the
 * Structure chips AND their roll-up header are both on screen.
 */
export const RETAINED_DURATION_RUN: RunDetail = {
  ...CORRUPT_RUN,
  runId: 'r_retain01',
  name: 'judge-panel-resumed',
  agents: CORRUPT_RUN.agents.map((a) => (a.index === 5 ? { ...a, durationMs: 61_000 } : a)),
}

/** The figure `RETAINED_DURATION_RUN`'s orphan must never print. `fmtDuration` → `1m1s`. */
export const RETAINED_MS = 61_000

/**
 * THE DEAD QUEUE ENDPOINT (review round 12, B1) — and its live control.
 *
 * `verify:docs` was queued 10s into the run and never started: no `running` event, no
 * terminal event, nothing that says when its wait ended. `build` ran for the next fourteen
 * minutes and settled, so `build.endedAt` is the maximum timestamp in the run and therefore
 * the CHART's right edge. Closing the hatch at that edge — which is what `live ? now : end`
 * did — drew `verify:docs` a 13m50s queue wait, to scale, ending at a moment recorded for a
 * DIFFERENT agent.
 *
 * The two runs carry the SAME agents under two run states, which is what makes the pair a
 * control rather than two separate assertions: the geometry is asked the same question twice
 * and the only thing that differs is whether the run can still support the claim. Live, the
 * wait is genuinely open and honestly runs to `now`; dead, there is a mark and no interval.
 *
 * `displayState` is deliberately NOT pre-applied (`agent()` mirrors `state`), so the dead
 * run's refusal comes from the client's own verdict rather than from a flag the server set.
 */
const QUEUE_AGENTS: AgentView[] = [
  agent({
    index: 0, label: 'build', adapter: 'claude', state: 'done',
    queuedAt: T0, startedAt: T0, endedAt: T0 + 840_000, waitMs: 0, durationMs: 840_000,
    usage: { input: 60_000, output: 12_000, cost: 0.5 },
  }),
  agent({
    index: 1, label: 'verify:docs', adapter: 'opencode', state: 'queued', attempts: 0,
    queuedAt: T0 + 10_000,
  }),
]

/** The queue entry's `queuedAt`, and the chart edge a fabricated endpoint would come from. */
export const QUEUE_AT = T0 + 10_000
export const QUEUE_CHART_END = T0 + 840_000

const QUEUE_RUN_BASE: RunDetail = {
  ...LIVE_RUN,
  runId: 'r_queue001',
  name: 'queue-orphan',
  createdAt: T0,
  startedAt: T0,
  endedAt: null,
  agentCounts: { total: 2, done: 1, failed: 0, running: 0, cached: 0 },
  adapters: ['claude', 'opencode'],
  spend: { input: 60_000, output: 12_000, cost: 0.5 },
  budgetTotal: null,
  resumeCount: 0,
  openQuestions: 0,
  declaredPhases: null,
  phases: [],
  agents: QUEUE_AGENTS,
  questions: [],
  mail: [], mailTotal: 0, logs: [], logTotal: 0,
  structure: null,
  saturation: [],
  attemptSpans: [{ state: 'started', t: T0 }],
  attemptScopes: [{ phases: [], logs: [], logTotal: 0, mail: [], mailTotal: 0 }],
}

/** The engine went away with `verify:docs` still in the queue: no endpoint exists. */
export const ORPHAN_QUEUE_RUN: RunDetail = {
  ...QUEUE_RUN_BASE,
  runId: 'r_qorph001',
  state: 'stale',
  liveDetail: 'run.lock held by pid 33110 — not running',
}

/** The control: the same queue entry on a run that is still alive, so `now` is real. */
export const LIVE_QUEUE_RUN: RunDetail = {
  ...QUEUE_RUN_BASE,
  runId: 'r_qlive001',
  state: 'running',
  liveDetail: 'run.lock held by live pid 33110',
}

/**
 * A run recorded before E1–E12: no engine version, so every cap is `unsupported` (never
 * inferred from field presence — critique M2). No queue events, no progress, no structure,
 * and the journal join is still what supplies usage.
 */
export const LEGACY_RUN: RunDetail = {
  ...LIVE_RUN,
  runId: 'r_41ba7cc0',
  name: null,
  state: 'completed',
  liveDetail: null,
  createdAt: T0 - 600_000,
  startedAt: T0 - 600_000,
  endedAt: T0 - 480_000,
  agentCounts: { total: 2, done: 1, failed: 0, running: 0, cached: 0 },
  adapters: ['unknown'],
  spend: { input: 40_000, output: 18_300, cost: 0 },
  budgetTotal: null,
  resumeCount: 0,
  openQuestions: 0,
  engine: null,
  concurrency: null,
  declaredPhases: null,
  phases: [],
  structure: null,
  saturation: [],
  caps: UNSUPPORTED,
  questions: [],
  mail: [],
  mailTotal: 0,
  logs: [],
  logTotal: 0,
  attemptSpans: [{ state: 'started', t: T0 - 600_000 }, { state: 'completed', t: T0 - 480_000 }],
  attemptScopes: [{ phases: [], logs: [], logTotal: 0, mail: [], mailTotal: 0 }],
  agents: [
    agent({
      index: 0, adapter: 'unknown', state: 'done', phaseIndex: null, phaseApproximate: true,
      key: null, startedAt: T0 - 600_000, endedAt: T0 - 530_000, durationMs: 70_000,
      usage: { input: 30_000, output: 12_000, cost: 0 },
    }),
    agent({
      index: 1, adapter: 'unknown', state: 'cancelled', phaseIndex: null, phaseApproximate: true,
      key: null, startedAt: T0 - 530_000, endedAt: T0 - 495_000, durationMs: 35_000,
    }),
  ],
}

/** A run whose first event has not landed: caps `pending`, and NO older-engine copy (M2). */
export const FRESH_RUN: RunDetail = {
  ...LIVE_RUN,
  runId: 'r_fresh001',
  name: null,
  state: 'starting',
  liveDetail: null,
  createdAt: NOW - 400,
  startedAt: null,
  endedAt: null,
  agentCounts: { total: 0, done: 0, failed: 0, running: 0, cached: 0 },
  adapters: [],
  spend: null,
  budgetTotal: null,
  openQuestions: 0,
  resumeCount: 0,
  engine: null,
  concurrency: null,
  declaredPhases: null,
  phases: [],
  agents: [],
  questions: [],
  mail: [], mailTotal: 0, logs: [], logTotal: 0,
  structure: null, saturation: [],
  caps: PENDING,
  attemptSpans: [],
  attemptScopes: [{ phases: [], logs: [], logTotal: 0, mail: [], mailTotal: 0 }],
}

/** A completed run with zero agents — parity #60's terminal variant. */
export const EMPTY_RUN: RunDetail = {
  ...FRESH_RUN,
  runId: 'r_empty001',
  name: 'no-agents',
  state: 'completed',
  startedAt: T0,
  endedAt: T0 + 900,
  engine: '0.2.0',
  caps: SUPPORTED,
  attemptSpans: [{ state: 'started', t: T0 }, { state: 'completed', t: T0 + 900 }],
}

/**
 * A nested fan-out: `pipeline(2 × 2)` whose stage 0 calls `parallel(2)`.
 *
 * The engine's fanout `path` for the inner container EXTENDS the stage's path, so
 * `src/viewer/fold.js:360` scaffolds it as a CHILD of the stage node. Item 0's stage 0
 * therefore has no direct agents of its own — everything under it ran inside the nested
 * parallel — which is exactly the shape that used to render as "not created" beside an
 * unrelated sibling card (review round 1, B4).
 */
const PIPE2: PathSeg2 = { kind: 'pipeline', ordinal: 0, count: 2, stages: 2 }
type PathSeg2 = { kind: 'pipeline'; ordinal: number; count: number; stages: number }
const nestedPath = (i: number) => [
  PIPE2, { kind: 'item' as const, i }, { kind: 'stage' as const, s: 0 },
  { kind: 'parallel' as const, ordinal: 1, count: 2 },
]

export const NESTED_AGENTS: AgentView[] = [
  agent({
    index: 0, label: 'shard:a', adapter: 'claude', state: 'done',
    path: [...nestedPath(0), { kind: 'item', i: 0 }],
    queuedAt: T0, startedAt: T0, endedAt: T0 + 40_000, waitMs: 0, durationMs: 40_000,
    usage: { input: 1_000, output: 400, cost: 0.11 },
  }),
  agent({
    index: 1, label: 'shard:b', adapter: 'codex', state: 'running',
    path: [...nestedPath(0), { kind: 'item', i: 1 }],
    queuedAt: T0, startedAt: T0 + 5_000, waitMs: 5_000, stallMs: 1_800_000,
  }),
  agent({
    index: 2, label: 'merge', adapter: 'claude', state: 'queued', attempts: 0,
    path: [PIPE2, { kind: 'item', i: 1 }, { kind: 'stage', s: 0 }],
    queuedAt: T0 + 10_000,
  }),
]

export const NESTED_STRUCTURE: StructNode = node({
  path: [], kind: 'root',
  rollup: { state: 'mixed', costUsd: 0.11, durationMs: 40_000 },
  children: [
    node({
      path: [PIPE2], kind: 'pipeline',
      rollup: { state: 'mixed', costUsd: 0.11, durationMs: 40_000 },
      children: [0, 1].map((i) => node({
        path: [PIPE2, { kind: 'item', i }], kind: 'item',
        rollup: { state: 'mixed', costUsd: 0, durationMs: 0 },
        children: [0, 1].map((s) => node({
          path: [PIPE2, { kind: 'item', i }, { kind: 'stage', s }], kind: 'stage',
          agentIndices: i === 1 && s === 0 ? [2] : [],
          rollup: { state: 'queued', costUsd: 0, durationMs: 0 },
          children: i === 0 && s === 0
            ? [node({
              path: nestedPath(0), kind: 'parallel',
              rollup: { state: 'mixed', costUsd: 0.11, durationMs: 40_000 },
              children: [0, 1].map((j) => node({
                path: [...nestedPath(0), { kind: 'item', i: j }], kind: 'item',
                agentIndices: [j],
                rollup: { state: 'done', costUsd: 0, durationMs: 0 },
              })),
            })]
            : [],
        })),
      })),
    }),
  ],
})

export const NESTED_RUN: RunDetail = {
  ...LIVE_RUN,
  runId: 'r_nested01',
  name: 'nested-fanout',
  agentCounts: { total: 3, done: 1, failed: 0, running: 1, cached: 0 },
  declaredPhases: null,
  phases: [],
  agents: NESTED_AGENTS,
  structure: NESTED_STRUCTURE,
  saturation: [],
  questions: [],
  mail: [], mailTotal: 0, logs: [], logTotal: 0,
  attemptSpans: [{ state: 'started', t: T0 }],
  attemptScopes: [{ phases: [], logs: [], logTotal: 0, mail: [], mailTotal: 0 }],
  resumeCount: 0,
}

/**
 * A LIVE run whose agent 0 was resumed and is running RIGHT NOW while still carrying the
 * previous attempt's `durationMs` from the journal join (§6.4 J). The bar must run to `now`,
 * not stop 40s in (review round 1, B6).
 */
export const RESUMED_RUNNING: RunDetail = {
  ...LIVE_RUN,
  runId: 'r_resumed1',
  name: 'resumed-running',
  agentCounts: { total: 1, done: 0, failed: 0, running: 1, cached: 0 },
  startedAt: T0,
  endedAt: null,
  state: 'running',
  declaredPhases: null,
  phases: [],
  structure: null,
  saturation: [],
  questions: [], mail: [], mailTotal: 0, logs: [], logTotal: 0,
  attemptSpans: [{ state: 'started', t: T0 - 600_000 }, { state: 'resumed', t: T0 }],
  attemptScopes: [
    { phases: [], logs: [], logTotal: 0, mail: [], mailTotal: 0 },
    { phases: [], logs: [], logTotal: 0, mail: [], mailTotal: 0 },
  ],
  agents: [
    agent({
      index: 0, label: 'retried', adapter: 'claude', state: 'running',
      queuedAt: T0, startedAt: T0 + 2_000, waitMs: 2_000, stallMs: 1_800_000,
      // The lifetime figure the journal join restores from the LAST SETTLED result record.
      durationMs: 40_000, attempts: 2,
      usage: { input: 10_000, output: 4_000, cost: 0.4 },
    }),
  ],
}

/** The `runDetail` slice of the API, as a fake that never resolves twice differently. */
export const fixedApi = (detail: RunDetail) => ({
  runDetail: async () => detail,
})
