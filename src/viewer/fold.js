// Pure, byte-ordered viewer fold. This file is consumed verbatim by both Node and the
// browser build: no imports, platform globals, or server-only types belong here.

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'interrupted'])
const ENDED_AGENT_STATES = new Set(['done', 'failed', 'cancelled'])
const TRANSITION_STATES = new Set(['queued', 'running', 'cached', 'done', 'failed', 'cancelled'])
const CLEAR_OUTCOME_STATES = new Set(['queued', 'running', 'cached', 'done'])

// E1-E12 first ship together in this checkout. Keeping the thresholds named
// independently makes later capability additions additive instead of field-presence
// guesses.
export const FIRST_VIEWER_EVENT_VERSION = '0.1.2'
export const TOOL_IDS_VERSION = FIRST_VIEWER_EVENT_VERSION
export const CAP_VERSIONS = Object.freeze({
  phaseAssociation: FIRST_VIEWER_EVENT_VERSION,
  structure: FIRST_VIEWER_EVENT_VERSION,
  queueEvents: FIRST_VIEWER_EVENT_VERSION,
  progress: FIRST_VIEWER_EVENT_VERSION,
  usageOnEvents: FIRST_VIEWER_EVENT_VERSION,
  mailIds: FIRST_VIEWER_EVENT_VERSION,
  attemptMarkers: FIRST_VIEWER_EVENT_VERSION,
})

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const finite = (v) => Number.isFinite(v) ? v : null
const valueOr = (next, prior, fallback = null) => next ?? prior ?? fallback
const usage = (v) => v && typeof v === 'object'
  ? { input: Number(v.input) || 0, output: Number(v.output) || 0, cost: Number(v.cost) || 0 }
  : null

function blankScope() {
  return { phases: [], logs: [], mail: [] }
}

export function createFoldState({ createdAt = null } = {}) {
  const scope = blankScope()
  return {
    run: null,
    phases: scope.phases,
    agents: [],
    questions: [],
    mail: scope.mail,
    logs: scope.logs,
    structure: null,
    saturation: [],
    attemptSpans: [],
    resumeCount: 0,
    attemptScopes: [scope],
    unknownEvents: 0,
    unknownEventTypes: {},
    lastOffset: 0,
    _createdAt: finite(createdAt),
    _scope: 0,
    _attemptOpen: false,
    _agentByIndex: Object.create(null),
    _questionById: Object.create(null),
    _fanouts: [],
    _lastPhaseIndex: null,
  }
}

function normalizeState(prev) {
  if (!prev) return createFoldState()
  // Snapshots cross the server/browser boundary as JSON, so tolerate loss of
  // null-prototypes and reconstruct private indexes if a caller passes one back.
  prev._agentByIndex ??= Object.fromEntries((prev.agents ?? []).map((a) => [a.index, a]))
  prev._questionById ??= Object.fromEntries((prev.questions ?? []).map((q) => [q.qid, q]))
  prev._fanouts ??= []
  prev.attemptScopes ??= [{ phases: prev.phases ?? [], logs: prev.logs ?? [], mail: prev.mail ?? [] }]
  prev._scope ??= Math.max(0, prev.attemptScopes.length - 1)
  prev.saturation ??= []
  prev.attemptSpans ??= []
  prev.resumeCount ??= prev.attemptSpans.filter((s) => s.state === 'resumed').length
  prev.unknownEventTypes ??= {}
  prev.unknownEvents ??= 0
  return prev
}

function currentScope(state) {
  if (!state.attemptScopes[state._scope]) state.attemptScopes[state._scope] = blankScope()
  return state.attemptScopes[state._scope]
}

function exposeScope(state) {
  const scope = currentScope(state)
  state.phases = scope.phases
  state.logs = scope.logs
  state.mail = scope.mail
}

function openAttempt(state, ev) {
  const firstEmpty = state.attemptSpans.length === 0
    && state.attemptScopes.length === 1
    && state.attemptScopes[0].phases.length === 0
    && state.attemptScopes[0].logs.length === 0
    && state.attemptScopes[0].mail.length === 0
  if (firstEmpty) state._scope = 0
  else {
    state.attemptScopes.push(blankScope())
    state._scope = state.attemptScopes.length - 1
  }
  state._lastPhaseIndex = null
  state._attemptOpen = true
  state.attemptSpans.push({ state: ev.state, t: finite(ev.t) ?? 0 })
  exposeScope(state)
}

function foldRun(state, ev) {
  const wasTerminal = TERMINAL_RUN_STATES.has(state.run?.state)
  if (ev.state === 'started' || ev.state === 'resumed') {
    openAttempt(state, ev)
    if (ev.state === 'resumed') state.resumeCount++
    if (wasTerminal) {
      if (state.run) {
        delete state.run.endedAt
        delete state.run.error
      }
    }
  }

  const merged = { ...(state.run ?? {}), ...ev }
  if (state.run?.startedAt != null) merged.startedAt = state.run.startedAt
  else if (ev.state === 'started') merged.startedAt = finite(ev.t)
  else merged.startedAt ??= null

  if (TERMINAL_RUN_STATES.has(ev.state)) {
    if (!state._attemptOpen) {
      const t = state._createdAt ?? finite(ev.t) ?? 0
      if (state.attemptSpans.length === 0) state.attemptSpans.push({ state: 'started', t })
    }
    merged.endedAt = finite(ev.t)
    merged.error = ev.error ?? null
    state.attemptSpans.push({ state: ev.state, t: finite(ev.t) ?? 0 })
    state._attemptOpen = false
  } else if (ev.state === 'started' || ev.state === 'resumed') {
    merged.endedAt = null
    merged.error = null
  }
  state.run = merged
}

function foldPhase(state, ev) {
  const scope = currentScope(state)
  const phaseIndex = Number.isInteger(ev.phaseIndex) ? ev.phaseIndex : scope.phases.length
  const found = scope.phases.find((p) => p.phaseIndex === phaseIndex)
  if (found) {
    found.title = String(ev.title ?? found.title ?? '')
    if (ev.detail !== undefined) found.detail = ev.detail
  } else {
    scope.phases.push({
      phaseIndex,
      title: String(ev.title ?? ''),
      ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
      agentIndices: [],
      reached: true,
      approximate: !Number.isInteger(ev.phaseIndex),
    })
  }
  state._lastPhaseIndex = phaseIndex
}

function blankAgent(index) {
  return {
    index,
    key: null,
    label: null,
    adapter: 'unknown',
    model: null,
    effort: null,
    state: 'queued',
    displayState: 'queued',
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
    toolIds: false,
    sessionId: null,
    attempts: 0,
    steers: [],
    cached: false,
    _firstOffset: null,
    _approxPhaseIndex: null,
  }
}

function mergeIdentity(agent, ev) {
  agent.key = valueOr(ev.key, agent.key)
  agent.label = valueOr(ev.label, agent.label)
  agent.adapter = valueOr(ev.adapter, agent.adapter, 'unknown')
  agent.model = valueOr(ev.model, agent.model)
  agent.effort = valueOr(ev.effort, agent.effort)
  agent.phaseIndex = valueOr(ev.phaseIndex, agent.phaseIndex)
  agent.path = valueOr(ev.path, agent.path)
  agent.promptPreview = valueOr(ev.promptPreview, agent.promptPreview)
}

function clearOutcome(agent) {
  agent.error = null
  agent.errorCode = null
  agent.retryable = null
  agent.durationMs = null
  agent.resultPreview = null
  agent.endedAt = null
}

/**
 * Does this transition begin a NEW execution of the index, rather than advance the one it
 * is already inside?
 *
 * §6.4 step 1a says agents are not attempt-scoped — index 3 in attempt 2 is the same agent
 * as index 3 in attempt 1 — and that is right for its IDENTITY and for its lifetime totals.
 * It is not right for the timestamps, which describe one execution and expire with it.
 *
 * The ladder inside one execution is `queued → running → terminal` (or a bare `running` on a
 * run whose engine predates E4). So a `running` event that lands on a `queued` agent is that
 * agent advancing — and `waitMs` is derived from the `queuedAt` the queue entry recorded, so
 * treating it as a fresh execution would delete the wait it is there to measure. Anything
 * else — `queued` at all, or `running`/`cached` arriving on an agent that is settled, already
 * running, or replayed — is the index entering a new execution.
 */
function entersNewExecution(prevState, next) {
  if (next === 'running' || next === 'cached') return prevState !== 'queued'
  return next === 'queued'
}

/**
 * Wipe the timestamps and progress metadata of the execution that just ended (round 11, B1).
 *
 * `clearOutcome` above deals with the previous attempt's RESULT. This deals with its clock,
 * and the two were not the same hole: a `done → resume → queued` fold produced an agent whose
 * state read `queued` at t=101 while it still carried `startedAt` and `lastOutputAt` from the
 * attempt that had already finished at t=4. Every cockpit surface then reported that stale
 * pair as the present — the Timeline drew the old attempt's execution bar under a `queued`
 * lane and labelled its right edge "end unrecorded", the Agents table printed and sorted by
 * the old wait, and on a `running` re-entry the old `lastOutputAt` was instantly older than
 * half the stall threshold, so the lane opened with a quiet warning and a progress notch for
 * output the new attempt had not produced. Those are Q2/Q5 claims with nothing behind them.
 *
 * What survives is what §6.2 defines as LIFETIME data — `usage`, `cumTokens`, `attempts`,
 * `sessionId` — plus identity and `steers`, which accumulate across attempts by construction.
 * The journal-derived outcome fields (`durationMs`, `attemptUsage`, `resultBytes`, …) are not
 * listed here on purpose: `clearOutcome` blanks the ones §6.4 step 3 names and the §6.4 J
 * join puts the journal's own answer straight back, which is the behaviour `honesty.duration`
 * is built on. None of the fields below is journal-derived, so clearing them sticks.
 */
function resetExecutionClock(agent) {
  agent.queuedAt = null
  agent.startedAt = null
  agent.waitMs = null
  agent.stallMs = null
  agent.lastOutputAt = null
  agent.lastTool = null
}

function foldAgent(state, ev, offset) {
  if (!Number.isInteger(ev.index) || ev.index < 0) return
  let agent = state._agentByIndex[ev.index]
  if (!agent) state._agentByIndex[ev.index] = (agent = blankAgent(ev.index))
  if (agent._firstOffset == null) {
    agent._firstOffset = offset
    agent._approxPhaseIndex = state._lastPhaseIndex
  }
  mergeIdentity(agent, ev)

  if (ev.state === 'steered') {
    agent.steers.push({
      at: finite(ev.t) ?? 0,
      origin: ev.origin === 'workflow' ? 'workflow' : 'operator',
      delivery: ev.delivery ?? null,
      ...(ev.mailId != null ? { mailId: ev.mailId } : {}),
    })
    return
  }
  if (ev.state === 'progress') {
    if (own(ev, 'lastTool') || own(ev, 'tool')) agent.lastTool = ev.lastTool ?? ev.tool ?? null
    if (own(ev, 'lastOutputAt')) agent.lastOutputAt = finite(ev.lastOutputAt)
    if (own(ev, 'outputTokens')) {
      agent.liveTokens = { input: agent.liveTokens?.input ?? 0, output: Number(ev.outputTokens) || 0 }
    }
    return
  }

  // Future state strings are intentionally retained. Only known transitions receive
  // outcome/timestamp semantics; the renderer can show every other string neutrally.
  const prevState = agent.state
  agent.state = typeof ev.state === 'string' ? ev.state : agent.state
  agent.displayState = agent.state
  if (!TRANSITION_STATES.has(ev.state)) return
  if (CLEAR_OUTCOME_STATES.has(ev.state)) clearOutcome(agent)
  // Order matters: the reset runs BEFORE the event's own fields are read below, so a
  // `running` event that carries `waitMs`/`stallMs`/`lastOutputAt` still writes them.
  if (entersNewExecution(prevState, ev.state)) resetExecutionClock(agent)

  if (ev.state === 'queued') agent.queuedAt = finite(ev.t)
  if (ev.state === 'running') {
    agent.startedAt = finite(ev.t)
    agent.waitMs = finite(ev.waitMs) ?? (
      agent.startedAt != null && agent.queuedAt != null ? Math.max(0, agent.startedAt - agent.queuedAt) : null
    )
    agent.stallMs = finite(ev.stallMs)
  }
  if (ENDED_AGENT_STATES.has(ev.state)) {
    agent.endedAt = finite(ev.t)
    agent.durationMs = finite(ev.durationMs)
  }
  if (ev.state === 'cached') {
    // The REPLAY INSTANT (§6.4 step 3, amended round 11). A cache hit emits exactly one
    // event and no `queued`/`running` pair (src/engine.js:959), so this `t` is the only
    // timestamp the run records for the index — and now that the reset above has taken the
    // previous attempt's `startedAt` away, it is also the only thing the Timeline's replay
    // mark can honestly stand on. It is NOT an execution end: nothing executed, which is
    // why `durationMs` stays cleared and a cache hit's figure comes from the journal's
    // replayed lifetime (`honesty.agentDuration`) rather than from `endedAt - startedAt`.
    agent.endedAt = finite(ev.t)
  }
  agent.cached = ev.state === 'cached'
  if (own(ev, 'error')) agent.error = ev.error == null ? null : String(ev.error)
  if (own(ev, 'errorCode') || own(ev, 'code')) agent.errorCode = ev.errorCode ?? ev.code ?? null
  if (own(ev, 'retryable')) agent.retryable = ev.retryable == null ? null : Boolean(ev.retryable)
  if (own(ev, 'resultPreview')) agent.resultPreview = ev.resultPreview ?? null
  if (own(ev, 'usage')) {
    agent.attemptUsage = usage(ev.usage)
    agent.usage = usage(ev.usage)
  }
  if (own(ev, 'lastOutputAt')) agent.lastOutputAt = finite(ev.lastOutputAt)
  if (ev.sem && Number.isFinite(ev.sem.active) && Number.isFinite(ev.sem.queued)) {
    state.saturation.push({ t: finite(ev.t) ?? 0, active: ev.sem.active, queued: ev.sem.queued })
  }
}

function foldQuestion(state, ev) {
  const qid = String(ev.qid ?? '')
  if (!qid) return
  const prior = state._questionById[qid]
  state._questionById[qid] = {
    qid,
    question: String(ev.question ?? prior?.question ?? ''),
    askedAt: finite(ev.t) ?? prior?.askedAt ?? 0,
    answered: prior?.answered ?? false,
    answer: prior?.answer ?? null,
    replayed: prior?.replayed ?? false,
    abandoned: false,
  }
}

function foldAnswer(state, ev) {
  const qid = String(ev.qid ?? '')
  if (!qid) return
  const q = state._questionById[qid] ?? {
    qid, question: '', askedAt: finite(ev.t) ?? 0, answered: false,
    answer: null, replayed: false, abandoned: false,
  }
  q.answered = true
  if (own(ev, 'value')) q.answer = ev.value
  if (own(ev, 'replayed')) q.replayed = Boolean(ev.replayed)
  state._questionById[qid] = q
}

function foldMail(state, ev) {
  const n = Number(ev.agent)
  currentScope(state).mail.push({
    at: finite(ev.t) ?? 0,
    dir: ev.dir === 'out' ? 'out' : 'in',
    agent: Number.isInteger(n) ? n : null,
    message: String(ev.message ?? ''),
    origin: ev.origin === 'operator' || ev.origin === 'workflow' ? ev.origin : null,
    delivery: ev.delivery ?? null,
    mailId: ev.mailId ?? null,
    callsite: ev.callsite ?? null,
  })
}

const ENGINE_LOG_PATTERNS = [
  /^aborting run:/i,
  /^journal had a torn final record/i,
  /^agent \[\d+] retrying after:/i,
  /telemetry.*(?:failed|error)/i,
  /^spawn: \d+ queued message\(s\) dropped/i,
]

function foldLog(state, ev) {
  const message = String(ev.message ?? '')
  const heuristicEngine = ev.source == null && ENGINE_LOG_PATTERNS.some((re) => re.test(message))
  const index = Number(ev.agentIndex ?? ev.index)
  currentScope(state).logs.push({
    at: finite(ev.t) ?? 0,
    message,
    source: ev.source === 'engine' || heuristicEngine ? 'engine' : 'workflow',
    level: ev.level === 'warn' || ev.level === 'error' ? ev.level : 'info',
    agentIndex: Number.isInteger(index) ? index : null,
    ...(heuristicEngine ? { heuristic: true } : {}),
  })
}

const segEqual = (a, b) => {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'parallel' || a.kind === 'pipeline') {
    return a.ordinal === b.ordinal && a.count === b.count && a.stages === b.stages
  }
  return a.i === b.i && a.s === b.s
}
const pathPrefix = (prefix, full) =>
  Array.isArray(prefix) && Array.isArray(full) && prefix.length <= full.length
  && prefix.every((seg, i) => segEqual(seg, full[i]))

function nodeFor(root, path, create = true) {
  let node = root
  for (let i = 0; i < path.length; i++) {
    const prefix = path.slice(0, i + 1)
    let child = node.children.find((c) => pathPrefix(prefix, c.path) && c.path.length === prefix.length)
    if (!child) {
      if (!create) return node
      child = { path: prefix, kind: path[i].kind, children: [], agentIndices: [], rollup: { state: 'queued', costUsd: 0, durationMs: 0 } }
      node.children.push(child)
    }
    node = child
  }
  return node
}

function rollup(node, agents) {
  for (const child of node.children) rollup(child, agents)
  const ownAgents = node.agentIndices.map((i) => agents.find((a) => a.index === i)).filter(Boolean)
  const states = [
    ...ownAgents.map((a) => a.state),
    ...node.children.map((c) => c.rollup.state),
  ]
  node.rollup.costUsd = ownAgents.reduce((n, a) => n + (a.usage?.cost ?? 0), 0)
    + node.children.reduce((n, c) => n + c.rollup.costUsd, 0)
  node.rollup.durationMs = ownAgents.reduce((n, a) => n + (a.durationMs ?? 0), 0)
    + node.children.reduce((n, c) => n + c.rollup.durationMs, 0)
  node.rollup.state = states.length === 0 ? 'queued' : states.every((s) => s === states[0]) ? states[0] : 'mixed'
}

function buildStructure(state) {
  if (state._fanouts.length === 0) return null
  const root = { path: [], kind: 'root', children: [], agentIndices: [], rollup: { state: 'queued', costUsd: 0, durationMs: 0 } }
  for (const f of state._fanouts) {
    const container = nodeFor(root, f.path)
    for (let i = 0; i < (Number(f.count) || 0); i++) {
      const itemPath = [...f.path, { kind: 'item', i }]
      nodeFor(root, itemPath)
      if (f.kind === 'pipeline') {
        for (let s = 0; s < (Number(f.stages) || 0); s++) nodeFor(root, [...itemPath, { kind: 'stage', s }])
      }
    }
    container.kind = f.kind
  }
  for (const agent of state.agents) {
    if (!Array.isArray(agent.path)) {
      root.agentIndices.push(agent.index)
      continue
    }
    nodeFor(root, agent.path, false).agentIndices.push(agent.index)
  }
  rollup(root, state.agents)
  return root
}

function exposeCollections(state) {
  exposeScope(state)
  state.agents = Object.values(state._agentByIndex).sort((a, b) => a.index - b.index)
  state.questions = Object.values(state._questionById).sort((a, b) => a.askedAt - b.askedAt)
  state.structure = buildStructure(state)
}

/**
 * Fold complete JSONL records in byte order. `o` is the byte offset after each
 * record's newline. The returned object is the supplied state, updated in place; this
 * is intentional so both the server delta cache and the SPA SSE reducer stay O(delta).
 */
export function fold(prev, recs) {
  const state = normalizeState(prev)
  for (const item of recs ?? []) {
    const ev = item?.rec
    if (!ev || typeof ev !== 'object') continue
    const offset = Number.isFinite(item.o) ? item.o : state.lastOffset
    state.lastOffset = Math.max(state.lastOffset ?? 0, offset ?? 0)
    switch (ev.type) {
      case 'run': foldRun(state, ev); break
      case 'phase': foldPhase(state, ev); break
      case 'agent': foldAgent(state, ev, offset); break
      case 'question': foldQuestion(state, ev); break
      case 'answer': foldAnswer(state, ev); break
      case 'mail': foldMail(state, ev); break
      case 'log': foldLog(state, ev); break
      case 'fanout':
        if (Array.isArray(ev.path) && (ev.kind === 'parallel' || ev.kind === 'pipeline')) state._fanouts.push(ev)
        break
      default:
        state.unknownEvents++
        state.unknownEventTypes[String(ev.type ?? 'unknown')] = (state.unknownEventTypes[String(ev.type ?? 'unknown')] ?? 0) + 1
    }
  }
  exposeCollections(state)
  return state
}

function parseSemver(v) {
  const m = String(v ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
}

export function semverGte(actual, minimum) {
  const a = parseSemver(actual)
  const b = parseSemver(minimum)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a.n[i] !== b.n[i]) return a.n[i] > b.n[i]
  }
  if (a.pre == null && b.pre != null) return true
  if (a.pre != null && b.pre == null) return false
  return String(a.pre ?? '') >= String(b.pre ?? '')
}

export function deriveCaps(run) {
  const hasRunEvent = Boolean(run)
  if (!hasRunEvent) return Object.fromEntries(Object.keys(CAP_VERSIONS).map((k) => [k, 'pending']))
  if (!run.engine) return Object.fromEntries(Object.keys(CAP_VERSIONS).map((k) => [k, 'unsupported']))
  return Object.fromEntries(Object.entries(CAP_VERSIONS).map(([k, v]) => [k, semverGte(run.engine, v) ? 'supported' : 'unsupported']))
}

/**
 * The FOLDED engine status is terminal, or the run is stale. This answers a question about
 * `run.state` as the events file recorded it — where `corrupt-result` and `unknown` cannot
 * appear, because they are `deriveRunState` verdicts, not engine-written statuses.
 * For the liveness question ("may this screen move?") use `runIsLive`/`runIsDead` below.
 */
export const terminalOrStale = (state) => TERMINAL_RUN_STATES.has(state) || state === 'stale'

/**
 * Liveness, defined POSITIVELY (review round 5, B1).
 *
 * DESIGN §5.4.2 partitions `deriveRunState`'s verdicts into three tiers, and only ONE of
 * them is live: `{running, starting}`. `{stale, unknown, corrupt-result}` are **quiescent**
 * — "not terminal, but nothing changes them without a lock or marker appearing" (§5.4.2,
 * DESIGN.md:816) — and `deriveRunState` reaches `corrupt-result` only after the socket
 * probe fails AND `run.lock` holds no live pid (src/run-state.js:141–152), so a corrupt
 * result is a run that has genuinely stopped.
 *
 * Deriving death as `terminalOrStale` therefore left `corrupt-result` (and `unknown`) on
 * the live side of every §6.4 step 8 rule: spinners kept turning, the Gantt kept advancing
 * toward `now`, the clock kept ticking, and live-only actions stayed armed on a run nobody
 * owns. A verdict this layer does not recognise is treated as NOT live for the same reason
 * parity #58 exists: motion is a claim, and an unrecognised state cannot support it.
 */
const LIVE_RUN_STATES = new Set(['running', 'starting'])
export const runIsLive = (state) => LIVE_RUN_STATES.has(state)
export const runIsDead = (state) => !LIVE_RUN_STATES.has(state)

/**
 * Produce the public, run-state-aware projection without mutating the cached raw fold.
 * This is §6.4 step 8: liveness never enters the pure event history cache.
 */
export function materializeFold(raw, runState, caps = deriveCaps(raw?.run)) {
  const state = normalizeState(raw)
  exposeCollections(state)
  // §6.4 step 8's precondition. `runIsDead`, not `terminalOrStale`: a quiescent verdict
  // (`stale|unknown|corrupt-result`, §5.4.2) is a run that has stopped, and an agent left
  // `queued|running` under any of them is stranded, never live.
  const dead = runIsDead(runState)
  const agents = state.agents.map((source) => {
    const agent = { ...source, steers: source.steers.map((s) => ({ ...s })) }
    delete agent._firstOffset
    const approximate = caps.phaseAssociation === 'unsupported'
    if (approximate) agent.phaseIndex = source._approxPhaseIndex
    delete agent._approxPhaseIndex
    agent.phaseApproximate = approximate
    agent.displayState = dead && (agent.state === 'queued' || agent.state === 'running') ? 'orphaned' : agent.state
    return agent
  })
  const questions = state.questions.map((q) => ({ ...q, abandoned: dead && !q.answered }))
  const phases = state.phases.map((p) => ({
    ...p,
    agentIndices: agents.filter((a) => a.phaseIndex === p.phaseIndex).map((a) => a.index),
    approximate: caps.phaseAssociation === 'unsupported' || Boolean(p.approximate),
  }))
  const attemptScopes = state.attemptScopes.map((scope, index) => ({
    phases: index === state._scope ? phases : scope.phases.map((p) => ({
      ...p,
      agentIndices: agents.filter((a) => a.phaseIndex === p.phaseIndex).map((a) => a.index),
      approximate: caps.phaseAssociation === 'unsupported' || Boolean(p.approximate),
    })),
    logs: scope.logs.map((l) => ({ ...l })),
    mail: scope.mail.map((m) => ({ ...m })),
  }))
  return {
    run: state.run ? { ...state.run } : null,
    phases,
    agents,
    questions,
    mail: attemptScopes[state._scope]?.mail ?? [],
    logs: attemptScopes[state._scope]?.logs ?? [],
    structure: caps.structure === 'unsupported' ? null : state.structure,
    saturation: caps.queueEvents === 'supported' ? state.saturation.map((s) => ({ ...s })) : [],
    attemptSpans: state.attemptSpans.map((s) => ({ ...s })),
    resumeCount: state.resumeCount,
    attemptScopes,
    unknownEvents: state.unknownEvents,
    unknownEventTypes: { ...state.unknownEventTypes },
    openQuestions: dead ? 0 : questions.filter((q) => !q.answered).length,
    caps,
    lastOffset: state.lastOffset,
  }
}
