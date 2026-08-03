// One consistent fictional world across home.html, cockpit.html and transcript.html.
// Shapes follow DESIGN §6.2 (RunSummary / AgentView / QuestionView / MailView / LogView)
// and §6.3 formatting (fmtTokens, fmtDuration, fmtCost).
//
// The cockpit run's timeline is a MECHANICALLY VALID semaphore trace: with
// concurrency 2, every admission below is the direct consequence of a slot freeing,
// FIFO in queue order. That matters — a Gantt whose queue-wait segments do not add up
// teaches the reviewer to distrust the chart. Derivation in cockpit.html annotation 4.
//
// Deliberate choices that exercise the spec's honesty rules:
//   * `hello.workflow.js` has no journalled cost -> the cell is EMPTY, never "$0.00"
//     or "—" (parity #53/#114, DESIGN §2.3).
//   * `audit-viewer-security` is stale with agents left mid-flight -> displayState
//     'orphaned', never a live spinner (parity #58, §6.4 step 8).
//   * the last run has no name and a pre-E1 engine -> id in mono + degraded copy (§6.5).

export const NOW = '14:22:07';
export const STARTED = '14:08:05';

/* ==========================================================================
   The cockpit run: r_2f91c4a8 judge-panel-auth-refactor
   concurrency 2 · budget.total 340k output tokens · resumed once
   t=0 is 14:08:05 (this attempt's start); now = t+842_000 (14m02s).
   ========================================================================== */
export const CONCURRENCY = 2;
export const SPAN_MS = 842000;
export const BUDGET = {
  total: 340000, totalLabel: '340k',
  spent: 375100, spentLabel: '375.1k',
  pct: 110.3, ceilingAt: 90.6,   // 340000 / 375100
};
export const RUN = {
  id: 'r_2f91c4a8', name: 'judge-panel-auth-refactor',
  file: 'workflows/judge-panel.workflow.js',
  engine: '0.2.0', concurrency: 2,
  state: 'running', liveDetail: 'run.lock held by live pid 51204',
  elapsed: '14m02s',
  tin: '1.51M', tout: '375.1k', cost: '$9.05',
  agents: { total: 10, done: 4, cached: 1, failed: 1, running: 2, queued: 2 },
};

/**
 * The trace. `wait`/`start`/`end` are ms from t=0; null end = still open.
 * `admitBecause` records which slot-freeing event admitted the agent — this is what
 * makes the chart auditable.
 */
export const AGENTS = [
  { i: 0, label: 'survey:auth', adapter: 'claude', model: 'opus-5', effort: 'high',
    phase: 'Survey', pi: 0, state: 'done',
    wait: null, start: 0, end: 134000, dur: '2m14s', waitLabel: '—',
    tin: '182.4k', tout: '38.1k', cost: '$0.712', lastTool: 'Read', attempts: 1, steers: 0,
    admitBecause: 'run start — slot 1 of 2' },

  { i: 1, label: 'survey:routes', adapter: 'codex', model: 'gpt-5.6-sol', effort: 'high',
    phase: 'Survey', pi: 0, state: 'done',
    wait: null, start: 0, end: 118000, dur: '1m58s', waitLabel: '—',
    tin: '141.0k', tout: '31.4k', cost: '$0.418', lastTool: 'Grep', attempts: 1, steers: 0,
    admitBecause: 'run start — slot 2 of 2' },

  { i: 2, label: 'survey:tests', adapter: 'droid', model: null, effort: null,
    phase: 'Survey', pi: 0, state: 'cached',
    wait: null, start: 0, end: 0, dur: '—', waitLabel: '—',
    tin: '77.4k', tout: '9.8k', cost: '$0.121', lastTool: null, attempts: 1, steers: 0,
    cached: true, admitBecause: 'cache hit — never took a slot' },

  { i: 3, label: 'review:auth', adapter: 'claude', model: 'opus-5', effort: 'high',
    phase: 'Review', pi: 1, state: 'done',
    wait: null, start: 134000, end: 322000, dur: '3m08s', waitLabel: '—',
    tin: '311.6k', tout: '61.2k', cost: '$1.441', lastTool: 'Read', attempts: 1, steers: 1,
    admitBecause: 'survey:auth released a slot at 2m14s' },

  { i: 4, label: 'review:routes', adapter: 'codex', model: 'gpt-5.6-sol', effort: 'high',
    phase: 'Review', pi: 1, state: 'failed',
    wait: null, start: 134000, end: 136000, dur: '2.0s', waitLabel: '—',
    tin: null, tout: null, cost: null, lastTool: null, attempts: 1, steers: 0,
    errorCode: 'spawn_failed', retryable: false,
    error: 'codex: command not found — run `flowition doctor`',
    admitBecause: 'survey:routes released a slot at 1m58s' },

  { i: 5, label: 'review:tests', adapter: 'claude', model: 'opus-5', effort: 'xhigh',
    phase: 'Review', pi: 1, state: 'running',
    wait: 134000, start: 136000, end: null, dur: '11m46s', waitLabel: '2.0s',
    tin: '402.9k', tout: '118.6k', cost: '$3.204', lastTool: 'Grep', attempts: 2, steers: 2,
    quiet: '6m18s', stallMs: 1800000, lastOutputAt: 464000,
    notches: [178000, 246000, 318000, 392000, 464000],
    admitBecause: 'review:routes failed at 2m16s, freeing its slot' },

  { i: 6, label: 'review:client', adapter: 'amp', model: null, effort: null,
    phase: 'Review', pi: 1, state: 'done',
    wait: 134000, start: 322000, end: 468000, dur: '2m26s', waitLabel: '3m08s',
    tin: '206.8k', tout: '44.6k', cost: '$0.831', lastTool: 'Bash', attempts: 1, steers: 0,
    admitBecause: 'review:auth released a slot at 5m22s' },

  { i: 7, label: 'review:docs', adapter: 'pi', model: null, effort: null,
    phase: 'Review', pi: 1, state: 'running',
    wait: 134000, start: 468000, end: null, dur: '6m14s', waitLabel: '5m34s',
    tin: '188.1k', tout: '71.4k', cost: '$2.318', lastTool: 'Edit', attempts: 1, steers: 0,
    notches: [520000, 604000, 700000, 806000],
    admitBecause: 'review:client released a slot at 7m48s' },

  { i: 8, label: 'verify:auth', adapter: 'opencode', model: 'qwen3-coder', effort: null,
    phase: 'Review', pi: 1, state: 'queued',
    wait: 322000, start: null, end: null, dur: null, waitLabel: '8m40s',
    tin: null, tout: null, cost: null, lastTool: null, attempts: 0, steers: 0,
    queuePos: 1, admitBecause: 'waiting — both slots held by review:tests and review:docs' },

  { i: 9, label: 'verify:client', adapter: 'opencode', model: 'qwen3-coder', effort: null,
    phase: 'Review', pi: 1, state: 'queued',
    wait: 468000, start: null, end: null, dur: null, waitLabel: '6m14s',
    tin: null, tout: null, cost: null, lastTool: null, attempts: 0, steers: 0,
    queuePos: 2, admitBecause: 'waiting — behind verify:auth in the semaphore queue' },
];

/** E4 saturation samples: [tMs, active, queued]. Ceiling = CONCURRENCY. */
export const SATURATION = [
  [0, 2, 0], [118000, 1, 0], [134000, 2, 3], [136000, 2, 2],
  [322000, 2, 2], [468000, 2, 2], [842000, 2, 2],
];

/** Attempt lineage (§2.4 resume lineage strip) — this run has been resumed once. */
export const LINEAGE = [
  { state: 'interrupted', label: 'attempt 1 · 13:44 → 13:52 · interrupted', frac: 0.36 },
  { state: 'running', label: 'attempt 2 · 14:08 → now · running', frac: 0.64 },
];

export const PHASES = [
  { title: 'Survey', pi: 0, agents: [0, 1, 2], reached: true },
  { title: 'Review', pi: 1, agents: [3, 4, 5, 6, 7, 8, 9], reached: true },
  { title: 'Report', pi: 2, agents: [], reached: false },
];

export const QUESTIONS = [
  {
    qid: 'q_7f2a', asked: '14:19:12', ago: '2m ago', answered: false, agent: 5,
    from: 'agent 5 · review:tests',
    text: 'Two call sites in src/cli.js pass a bare string where the new adapter API expects {path}. Rewrite both call sites, or keep a compatibility shim for one release?',
  },
  {
    qid: 'q_1b93', asked: '14:11:40', ago: '10m ago', answered: true, agent: 0,
    from: 'agent 0 · survey:auth',
    text: 'Should the survey include viewer/src, or the engine only?',
    answer: 'engine only — the viewer is W8',
  },
];

export const MAIL = [
  { dir: 'out', agent: 5, ago: '3m ago', who: 'agent 5 · review:tests',
    body: 'Two high-severity findings so far: the token compare is not constant-time, and the Host check accepts a trailing dot. Continuing on the CSP surface.' },
  { dir: 'out', agent: 3, ago: '16m ago', who: 'agent 3 · review:auth',
    body: 'auth.js is the only file that reads the token. 41 files surveyed, 3 relevant.' },
  { dir: 'in', agent: 5, ago: '7m ago', who: 'operator', origin: 'operator',
    body: 'Also check the SSE endpoint for token leakage in error envelopes.',
    delivery: 'live' },
  { dir: 'in', agent: 3, ago: '11m ago', who: 'workflow', origin: 'workflow',
    body: 'Reviewer 2 disagreed on the auth ordering — reconcile before returning.',
    delivery: 'queued', callsite: 'judge-panel.workflow.js:48' },
  { dir: 'in', agent: 4, ago: '17m ago', who: 'operator', origin: 'operator',
    body: 'skip the routes dimension',
    delivery: 'dropped' },
];

export const LOGS = [
  { t: '14:22:04', s: 'workflow', lvl: 'info', a: 7, m: 'drafting the docs section…' },
  { t: '14:21:47', s: 'engine', lvl: 'info', a: null, m: 'sem: 2/2 in flight, 2 queued' },
  { t: '14:20:55', s: 'engine', lvl: 'warn', a: 5, m: 'no provider output for 6m — stall threshold 30m' },
  { t: '14:19:12', s: 'engine', lvl: 'info', a: 5, m: 'ask(q_7f2a) — awaiting operator answer' },
  { t: '14:15:53', s: 'workflow', lvl: 'info', a: 6, m: 'review:client returned 4 findings' },
  { t: '14:10:21', s: 'engine', lvl: 'error', a: 4, m: 'spawn failed: codex (ENOENT)' },
  { t: '14:10:19', s: 'workflow', lvl: 'info', a: null, m: 'phase: Review' },
  { t: '14:08:05', s: 'engine', lvl: 'info', a: 2, m: 'cache hit — replaying result for survey:tests' },
];
export const LAST_LOG = { s: 'workflow', a: 7, t: '14:22:04', m: 'drafting the docs section…' };

/* ==========================================================================
   Home run list
   ========================================================================== */
export const RUNS = [
  {
    id: 'r_2f91c4a8', name: 'judge-panel-auth-refactor', state: 'running',
    agents: { total: 10, done: 4, cached: 1, failed: 1 },
    adapters: ['claude', 'codex', 'droid', 'amp'], more: 2,
    out: '375.1k', cost: '$9.05', dur: '14m02s', when: 'started 14m ago',
    badges: ['budget', 'log', 'resumed1'], sel: true,
  },
  {
    id: 'r_a03d51e7', name: 'migrate-callsites', state: 'blocked',
    agents: { total: 8, done: 3 },
    adapters: ['claude', 'codex'],
    out: '96.4k', cost: '$1.87', dur: '4m31s', when: 'started 5m ago',
    badges: ['ask'],
  },
  {
    id: 'r_77c1be92', name: 'audit-viewer-security', state: 'stale',
    agents: { total: 9, done: 5 },
    adapters: ['codex'],
    out: '233.1k', cost: '$4.10', dur: '21m18s', when: 'started 47m ago',
    badges: ['resumed1', 'log'],
  },
  {
    id: 'r_5e40aa16', name: 'review-changes', state: 'completed',
    agents: { total: 12, done: 12 },
    adapters: ['claude', 'codex', 'opencode'],
    out: '588.0k', cost: '$11.20', dur: '8m42s', when: '2h ago',
    badges: [],
  },
  {
    id: 'r_be8207f4', name: 'find-flaky-tests', state: 'failed',
    agents: { total: 9, done: 7, failed: 1 },
    adapters: ['droid', 'claude'],
    out: '141.7k', cost: '$2.65', dur: '3m18s', when: '5h ago',
    badges: ['err:spawn_failed'],
  },
  {
    id: 'r_0c9f31da', name: 'pipeline-migrate-tests', state: 'completed',
    agents: { total: 9, done: 3, cached: 6 },
    adapters: ['codex'],
    out: '71.9k', cost: '$0.938', dur: '1m52s', when: '9h ago',
    badges: ['resumed2', 'cached'],
  },
  {
    id: 'r_hello_1', name: 'hello.workflow.js', state: 'completed',
    agents: { total: 1, done: 1 },
    adapters: ['mock'],
    out: '1.2k', cost: null, dur: '820ms', when: 'yesterday',
    badges: [],
  },
  {
    id: 'r_41ba7cc0', name: null, state: 'interrupted',
    agents: { total: 4, done: 2 },
    adapters: ['unknown'],
    out: '18.3k', cost: null, dur: '46s', when: 'yesterday',
    badges: ['old'],
  },
];
