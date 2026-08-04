import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createFoldState,
  deriveCaps,
  fold,
  materializeFold,
  runIsDead,
  runIsLive,
  terminalOrStale,
} from '../src/viewer/fold.js'
import {
  openResultReadStream,
  SNAPSHOT_CACHE_MAX_ENTRIES,
  SnapshotStore,
  readAgentResult,
  readRunResult,
} from '../src/viewer/snapshot.js'
import { readFirstJournalMeta } from '../src/viewer/journal-view.js'
import { readJsonlPage } from '../src/viewer/pages.js'

const records = (events, start = 0) => {
  let o = start
  return events.map((rec) => ({ o: (o += Buffer.byteLength(JSON.stringify(rec)) + 1), rec }))
}
const jsonl = (items) => items.map((r) => JSON.stringify(r)).join('\n') + '\n'

test('§6.4 agent transitions clear G11 outcome fields; annotations do not transition', () => {
  const state = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'failed', error: 'old', code: 'stalled', retryable: true, durationMs: 9, resultPreview: 'bad' },
    { t: 3, type: 'agent', index: 0, state: 'queued' },
    { t: 4, type: 'agent', index: 0, state: 'running', stallMs: 50 },
    { t: 5, type: 'agent', index: 0, state: 'progress', tool: 'grep', outputTokens: 7, lastOutputAt: 4 },
    { t: 6, type: 'agent', index: 0, state: 'steered', origin: 'workflow', delivery: 'queued' },
    { t: 7, type: 'agent', index: 0, state: 'done', durationMs: 3, resultPreview: 'ok' },
  ]))
  const agent = state.agents[0]
  assert.equal(agent.state, 'done')
  assert.equal(agent.error, null)
  assert.equal(agent.errorCode, null)
  assert.equal(agent.retryable, null)
  assert.equal(agent.lastTool, 'grep')
  assert.deepEqual(agent.liveTokens, { input: 0, output: 7 })
  assert.equal(agent.lastOutputAt, 4, 'progress uses its provider-output timestamp, not event t')
  assert.deepEqual(agent.steers, [{ at: 6, origin: 'workflow', delivery: 'queued' }])
})

test('§6.4 step 3 expires the previous execution clock when an index re-enters', () => {
  // done → resume → queued. Agents are not attempt-scoped (step 1a) but their CLOCK is:
  // nothing the finished attempt dated may survive into a queued one.
  const resumedQueued = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'queued' },
    { t: 3, type: 'agent', index: 0, state: 'running', waitMs: 1, stallMs: 1000 },
    { t: 4, type: 'agent', index: 0, state: 'progress', tool: 'old-tool', lastOutputAt: 4 },
    { t: 5, type: 'agent', index: 0, state: 'done', durationMs: 2, resultPreview: 'ok' },
    { t: 100, type: 'run', state: 'resumed' },
    { t: 101, type: 'agent', index: 0, state: 'queued' },
  ])).agents[0]
  assert.equal(resumedQueued.state, 'queued')
  assert.equal(resumedQueued.queuedAt, 101)
  assert.equal(resumedQueued.startedAt, null, 'the finished attempt did not start this one')
  assert.equal(resumedQueued.endedAt, null)
  assert.equal(resumedQueued.waitMs, null)
  assert.equal(resumedQueued.stallMs, null)
  assert.equal(resumedQueued.lastOutputAt, null, 'no output has been produced since t=101')
  assert.equal(resumedQueued.lastTool, null)
  assert.equal(resumedQueued.durationMs, null)
  assert.equal(resumedQueued.key, 'k', 'identity survives; only the clock expires')

  // The same re-entry straight into `running`, with no queue event: the wait must come from
  // the event or be absent, never from `startedAt - <a previous attempt's queuedAt>`.
  const resumedRunning = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'queued' },
    { t: 3, type: 'agent', index: 0, state: 'running', waitMs: 1, stallMs: 1000 },
    { t: 4, type: 'agent', index: 0, state: 'progress', tool: 'old-tool', lastOutputAt: 4 },
    { t: 5, type: 'agent', index: 0, state: 'failed', error: 'boom', durationMs: 2 },
    { t: 100, type: 'run', state: 'resumed' },
    { t: 101, type: 'agent', index: 0, state: 'running' },
  ])).agents[0]
  assert.equal(resumedRunning.startedAt, 101)
  assert.equal(resumedRunning.queuedAt, null)
  assert.equal(resumedRunning.waitMs, null, 'never 99 — the queue entry belongs to attempt 1')
  assert.equal(resumedRunning.stallMs, null)
  assert.equal(resumedRunning.lastOutputAt, null, 'running before the first output of THIS attempt')
  assert.equal(resumedRunning.lastTool, null)
  assert.equal(resumedRunning.error, null)

  // A running event that carries its own measurements still writes them: the reset runs
  // before the merge, it does not overrule the event.
  const measured = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, state: 'done', durationMs: 1 },
    { t: 10, type: 'agent', index: 0, state: 'running', waitMs: 7, stallMs: 900, lastOutputAt: 9 },
  ])).agents[0]
  assert.equal(measured.waitMs, 7)
  assert.equal(measured.stallMs, 900)
  assert.equal(measured.lastOutputAt, 9)

  // queued → running is one execution ADVANCING, so the wait it measured is kept.
  const advancing = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, state: 'queued' },
    { t: 9, type: 'agent', index: 0, state: 'running' },
  ])).agents[0]
  assert.equal(advancing.queuedAt, 2)
  assert.equal(advancing.startedAt, 9)
  assert.equal(advancing.waitMs, 7, 'derived from this attempt’s own queue entry')
})

test('§6.4 step 3 dates a cache hit by its replay event, not a previous attempt', () => {
  const cached = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'queued' },
    { t: 3, type: 'agent', index: 0, state: 'running', waitMs: 1, stallMs: 1000 },
    { t: 4, type: 'agent', index: 0, state: 'progress', tool: 'old-tool', lastOutputAt: 4 },
    { t: 5, type: 'agent', index: 0, state: 'done', durationMs: 2, resultPreview: 'ok' },
    { t: 100, type: 'run', state: 'resumed' },
    { t: 101, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'cached' },
  ])).agents[0]
  assert.equal(cached.state, 'cached')
  assert.equal(cached.cached, true)
  assert.equal(cached.endedAt, 101, 'the replay instant — the only timestamp a cache hit has')
  assert.equal(cached.startedAt, null, 'a replay never executed, and attempt 1’s start is gone')
  assert.equal(cached.queuedAt, null)
  assert.equal(cached.waitMs, null)
  assert.equal(cached.durationMs, null, 'the figure comes from the journal’s replayed lifetime')
  assert.equal(cached.lastOutputAt, null)
  assert.equal(cached.lastTool, null)

  // A cache hit the engine did queue first keeps that queue entry: it is this attempt's.
  const queuedThenCached = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, state: 'queued' },
    { t: 3, type: 'agent', index: 0, state: 'cached' },
  ])).agents[0]
  assert.equal(queuedThenCached.queuedAt, 2)
  assert.equal(queuedThenCached.endedAt, 3)
})

test('§6.4 resumed runs clear terminal latch and isolate attempt phases/logs/mail', () => {
  const state = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'phase', phaseIndex: 0, title: 'first' },
    { t: 3, type: 'log', message: 'old log' },
    { t: 4, type: 'mail', dir: 'out', agent: '0', message: 'old mail' },
    { t: 5, type: 'question', qid: 'q', question: 'old?' },
    { t: 6, type: 'run', state: 'failed', error: 'boom' },
    { t: 7, type: 'run', state: 'resumed' },
    { t: 8, type: 'phase', phaseIndex: 1, title: 'second' },
    { t: 9, type: 'log', message: 'new log' },
    { t: 10, type: 'mail', dir: 'in', agent: '0', message: 'new mail' },
    { t: 11, type: 'question', qid: 'q', question: 'again?' },
  ]))
  assert.equal(state.run.endedAt, null)
  assert.equal(state.run.error, null)
  assert.deepEqual(state.phases.map((p) => p.title), ['second'])
  assert.deepEqual(state.logs.map((l) => l.message), ['new log'])
  assert.deepEqual(state.mail.map((m) => m.message), ['new mail'])
  assert.equal(state.questions.length, 1)
  assert.equal(state.questions[0].question, 'again?')
  assert.equal(state.questions[0].askedAt, 11)
  assert.equal(state.resumeCount, 1)
  assert.deepEqual(state.attemptSpans.map((s) => s.state), ['started', 'failed', 'resumed'])
})

test('§6.4 post-pass orphans live-looking agents and abandons terminal questions', () => {
  const raw = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, adapter: 'mock', state: 'running' },
    { t: 3, type: 'question', qid: 'q', question: 'blocked?' },
    { t: 4, type: 'run', state: 'interrupted' },
  ]))
  const view = materializeFold(raw, 'interrupted')
  assert.equal(view.agents[0].displayState, 'orphaned')
  assert.equal(view.openQuestions, 0)
  assert.equal(view.questions[0].abandoned, true)
})

// The post-pass's PRECONDITION, which round 4 got wrong (review round 5, B1). DESIGN
// §5.4.2 (DESIGN.md:816) classifies `stale|unknown|corrupt-result` as quiescent — "not
// terminal, but nothing changes them" — and deriveRunState returns `corrupt-result` only
// after the control socket fails to answer AND run.lock holds no live pid
// (src/run-state.js:141–152). Deriving death as terminal-or-stale left every quiescent
// verdict claiming live agents, so a corrupt run kept spinners, a growing Gantt and a live
// question count. Liveness is `running|starting` and nothing else.
test('§6.4 step 8 treats every QUIESCENT run state as stopped, not only stale', () => {
  const raw = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, adapter: 'mock', state: 'running' },
    { t: 3, type: 'agent', index: 1, adapter: 'mock', state: 'queued' },
    { t: 4, type: 'question', qid: 'q', question: 'blocked?' },
  ]))
  for (const state of ['corrupt-result', 'unknown', 'stale', 'completed']) {
    const view = materializeFold(raw, state)
    assert.equal(view.agents[0].displayState, 'orphaned', `${state}: running agent`)
    assert.equal(view.agents[1].displayState, 'orphaned', `${state}: queued agent`)
    assert.equal(view.openQuestions, 0, `${state}: open questions`)
    assert.equal(view.questions[0].abandoned, true, `${state}: abandoned`)
  }
  for (const state of ['running', 'starting']) {
    const view = materializeFold(raw, state)
    assert.equal(view.agents[0].displayState, 'running', `${state}: running agent`)
    assert.equal(view.agents[1].displayState, 'queued', `${state}: queued agent`)
    assert.equal(view.openQuestions, 1, `${state}: open questions`)
    assert.equal(view.questions[0].abandoned, false, `${state}: abandoned`)
  }
  // An unrecognised verdict from a newer server is NOT live: motion is a claim, and a
  // state this layer cannot read cannot support one (§6.5 degrades, never fabricates).
  assert.equal(materializeFold(raw, 'quarantined').agents[0].displayState, 'orphaned')
  assert.equal(runIsLive('running'), true)
  assert.equal(runIsLive('corrupt-result'), false)
  assert.equal(runIsDead('starting'), false)
  // …and `terminalOrStale` keeps its own, narrower meaning: the FOLDED engine status.
  assert.equal(terminalOrStale('corrupt-result'), false)
  assert.equal(terminalOrStale('stale'), true)
})

test('caps derive from engine version, including zero-agent and pre-run states', () => {
  const engineVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.ok(Object.values(deriveCaps(null)).every((v) => v === 'pending'))
  const current = deriveCaps({ state: 'started', engine: engineVersion })
  assert.ok(Object.values(current).every((v) => v === 'supported'))
  const old = deriveCaps({ state: 'started' })
  assert.ok(Object.values(old).every((v) => v === 'unsupported'))
  assert.ok(Object.values(deriveCaps({ state: 'started', engine: '0.1.1' })).every((v) => v === 'unsupported'))

  const zeroAgent = materializeFold(fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: engineVersion },
  ])), 'running')
  assert.equal(zeroAgent.agents.length, 0)
  assert.equal(zeroAgent.caps.structure, 'supported')
})

test('terminal without started creates a zero-length stub attempt at journal createdAt', () => {
  const raw = fold(createFoldState({ createdAt: 41 }), records([
    { t: 99, type: 'run', state: 'failed', error: 'module load' },
  ]))
  assert.deepEqual(raw.attemptSpans, [
    { state: 'started', t: 41 },
    { state: 'failed', t: 99 },
  ])
})

test('old phase association is approximate; future states/types survive without throws', () => {
  const raw = fold(null, records([
    { t: 1, type: 'run', state: 'started' },
    { t: 2, type: 'phase', title: 'A' },
    { t: 3, type: 'agent', index: 2, adapter: 'future', state: 'quantum' },
    { t: 4, type: 'newer-event', value: 1 },
  ]))
  const view = materializeFold(raw, 'running')
  assert.equal(view.agents[0].state, 'quantum')
  assert.equal(view.agents[0].phaseIndex, 0)
  assert.equal(view.agents[0].phaseApproximate, true)
  assert.equal(view.unknownEvents, 1)
  assert.deepEqual(view.unknownEventTypes, { 'newer-event': 1 })
})

test('incremental fold is equivalent to a batch fold across resumed attempt scopes', () => {
  const events = [
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'fanout', path: [{ kind: 'parallel', ordinal: 0, count: 2 }], kind: 'parallel', count: 2 },
    { t: 3, type: 'phase', phaseIndex: 0, title: 'work' },
    { t: 4, type: 'agent', index: 0, adapter: 'mock', state: 'queued', phaseIndex: 0, path: [{ kind: 'parallel', ordinal: 0, count: 2 }, { kind: 'item', i: 0 }] },
    { t: 5, type: 'agent', index: 0, state: 'done', durationMs: 1 },
    { t: 6, type: 'run', state: 'failed' },
    { t: 7, type: 'run', state: 'resumed', engine: '0.2.0' },
    { t: 8, type: 'phase', phaseIndex: 1, title: 'verify' },
    { t: 9, type: 'agent', index: 1, adapter: 'mock', state: 'done', phaseIndex: 1 },
    { t: 10, type: 'run', state: 'completed' },
  ]
  const all = records(events)
  const batch = materializeFold(fold(null, all), 'completed')
  for (const split of [1, 3, 5, 6, 7, 9]) {
    const incrementalRaw = fold(fold(null, all.slice(0, split)), all.slice(split))
    const incremental = materializeFold(incrementalRaw, 'completed')
    assert.deepEqual(incremental, batch, `split at event ${split}`)
  }
  assert.deepEqual(batch.attemptScopes[0].phases[0].agentIndices, [0])
  assert.deepEqual(batch.attemptScopes[1].phases[0].agentIndices, [1])
  assert.deepEqual(batch.structure.children[0].children[0].agentIndices, [0])
})

test('old engine log heuristics classify all five known diagnostics only', () => {
  const diagnostics = [
    'aborting run: operator cancelled',
    'journal had a torn final record (crash mid-write) — repaired',
    'agent [7] retrying after: provider unavailable',
    'agent [7] post-completion telemetry error (completed result stands): disk full',
    'spawn: 2 queued message(s) dropped — agent replayed from cache without starting',
  ]
  const state = fold(null, records([
    ...diagnostics.map((message, i) => ({ t: i + 1, type: 'log', message })),
    { t: 9, type: 'log', message: 'workflow dropped a queued message intentionally' },
  ]))
  assert.deepEqual(state.logs.slice(0, 5).map((log) => [log.source, log.heuristic]), [
    ['engine', true],
    ['engine', true],
    ['engine', true],
    ['engine', true],
    ['engine', true],
  ])
  assert.equal(state.logs[5].source, 'workflow')
  assert.equal(state.logs[5].heuristic, undefined)
})

test('snapshot joins raw journal attempts, lifetime usage, zero resets, answers, and mail ids', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-snap-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
    { t: 10, type: 'run', state: 'started', engine: '0.2.0', name: 'join', budgetTotal: 100 },
    { t: 11, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'running' },
    { t: 12, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'done', resultPreview: 'event' },
    { t: 13, type: 'question', qid: 'q', question: 'old answer?' },
    { t: 14, type: 'mail', dir: 'in', agent: 0, message: 'hi', mailId: 'm' },
    { t: 15, type: 'run', state: 'completed' },
  ]))
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), jsonl([
    { t: 1, type: 'meta', runId: path.basename(dir), workflowFile: '/tmp/join.js', createdAt: 1, defaults: { adapter: 'mock' }, args: { secret: true } },
    { t: 2, type: 'started', key: 'k', index: 0, adapter: 'mock' },
    { t: 3, type: 'result', key: 'k', index: 0, status: 'failed', usage: { input: 1, output: 2, cost: 0.1 }, durationMs: 3, result: 'bad' },
    { t: 4, type: 'result', key: 'k', index: 0, status: 'completed', usage: { input: 4, output: 5, cost: 0.2 }, durationMs: 6, result: 'good' },
    { t: 5, type: 'session', key: 'k', sessionId: 'sess' },
    { t: 6, type: 'usage-cum', key: 'k', cum: { input: 9, output: 10 } },
    { t: 7, type: 'usage-cum', key: 'k', cum: { input: 0, output: 0 } },
    { t: 8, type: 'answer', qid: 'q', value: 'yes' },
    { t: 9, type: 'mail', key: 'k', id: 'm', text: 'hi', origin: 'workflow', callsite: 'x.js:1:1' },
    { t: 10, type: 'mail-done', key: 'k', id: 'm' },
  ]))
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ runId: path.basename(dir), status: 'completed', result: 'final' }))

  const store = new SnapshotStore({ deriveState: async () => ({ state: 'completed' }) })
  const detail = await store.get(dir, { includeArgs: true })
  const agent = detail.agents[0]
  assert.equal(agent.attempts, 2)
  assert.deepEqual(agent.usage, { input: 5, output: 7, cost: 0.30000000000000004 })
  assert.deepEqual(agent.attemptUsage, { input: 4, output: 5, cost: 0.2 })
  assert.deepEqual(agent.liveTokens, { input: 0, output: 0 })
  assert.equal(agent.sessionId, 'sess')
  assert.equal(agent.resultPreview, '"good"')
  assert.equal(detail.questions[0].answer, 'yes')
  assert.equal(detail.openQuestions, 0)
  assert.equal(detail.mail[0].origin, 'workflow')
  assert.equal(detail.mail[0].callsite, 'x.js:1:1')
  assert.deepEqual(detail.args, { secret: true })
  assert.equal(agent.toolIds, false, 'the mock transcript is not advertised as id-paired')
  assert.equal(detail.offsets.events, fs.statSync(path.join(dir, 'events.jsonl')).size)
  assert.equal(detail.offsets.journal, fs.statSync(path.join(dir, 'journal.jsonl')).size)

  assert.deepEqual(await readRunResult(dir), {
    runId: path.basename(dir), status: 'completed', resultBytes: fs.statSync(path.join(dir, 'result.json')).size, result: 'final',
  })
  assert.deepEqual(readAgentResult(dir, 0), { agent: 0, status: 'completed', resultBytes: 6, result: 'good' })
})

test('RunDetail retains bounded attempt scopes and derives toolIds per mixed adapter', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-scopes-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const engine = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
    { t: 1, type: 'run', state: 'started', engine },
    { t: 2, type: 'phase', phaseIndex: 0, title: 'old phase' },
    ...Array.from({ length: 205 }, (_, i) => ({ t: 3 + i, type: 'log', message: `old-${i}` })),
    { t: 300, type: 'mail', dir: 'out', agent: 0, message: 'old mail' },
    { t: 301, type: 'run', state: 'failed' },
    { t: 302, type: 'run', state: 'resumed', engine },
    { t: 303, type: 'phase', phaseIndex: 1, title: 'new phase' },
    { t: 304, type: 'log', message: 'new log' },
    { t: 305, type: 'agent', index: 0, key: 'mock-key', adapter: 'mock', state: 'done' },
    { t: 306, type: 'agent', index: 1, key: 'codex-key', adapter: 'codex', state: 'done' },
  ]))
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), jsonl([
    { type: 'meta', createdAt: 1, workflowFile: '/tmp/scopes.js' },
  ]))

  const detail = await new SnapshotStore({
    deriveState: async () => ({ state: 'completed' }),
  }).get(dir)
  assert.equal(detail.attemptScopes.length, 2)
  assert.deepEqual(detail.attemptScopes[0].phases.map((p) => p.title), ['old phase'])
  assert.equal(detail.attemptScopes[0].logTotal, 205)
  assert.equal(detail.attemptScopes[0].logs.length, 200)
  assert.equal(detail.attemptScopes[0].logs[0].message, 'old-5')
  assert.deepEqual(detail.attemptScopes[0].mail.map((m) => m.message), ['old mail'])
  assert.deepEqual(detail.phases.map((p) => p.title), ['new phase'])
  assert.deepEqual(detail.agents.map((a) => [a.adapter, a.toolIds]), [
    ['mock', false],
    ['codex', true],
  ])
})

test('snapshot cursor crosses complete oversize event records exactly once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-oversize-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const engine = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    jsonl([{ t: 1, type: 'run', state: 'started', engine }])
    + JSON.stringify({ t: 2, type: 'log', message: 'x'.repeat(1024 * 1024 + 64) }) + '\n')
  const store = new SnapshotStore({ deriveState: async () => ({ state: 'running' }) })
  const first = await store.get(dir)
  const size = fs.statSync(path.join(dir, 'events.jsonl')).size
  assert.equal(first.offsets.events, size)
  assert.equal(first.unknownEvents, 1)
  const second = await store.get(dir)
  assert.equal(second.offsets.events, size)
  assert.equal(second.unknownEvents, 1, 'the skipped line was not re-read and re-counted')
})

test('byte pages skip corrupt/torn lines and a sparse 500 MB tail opens boundedly', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-page-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const small = path.join(dir, 'small.jsonl')
  fs.writeFileSync(small, '{"kind":"text","text":"α"}\nnot-json\n{"kind":"text","text":"torn"}')
  const page = readJsonlPage(small, { from: 0, maxBytes: 1024 })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].rec.text, 'α')
  assert.equal(page.eof, true)
  assert.ok(page.end < page.size)

  const huge = path.join(dir, 'huge.jsonl')
  const fd = fs.openSync(huge, 'w')
  fs.ftruncateSync(fd, 500 * 1024 * 1024 - 256)
  fs.closeSync(fd)
  fs.appendFileSync(huge, '\n' + jsonl([
    { kind: 'text', text: 'tail one' },
    { kind: 'status', text: 'tail two' },
  ]))
  const started = performance.now()
  const tail = readJsonlPage(huge, { from: 'tail' })
  const elapsed = performance.now() - started
  assert.deepEqual(tail.items.map((i) => i.rec.text), ['tail one', 'tail two'])
  assert.ok(elapsed < 1000, `tail page took ${elapsed.toFixed(1)}ms`)
  assert.ok(tail.start > 490 * 1024 * 1024)
})

test('args and result projections enforce their inline caps without losing metadata', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-caps-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const large = 'z'.repeat(1024 * 1024 + 128)
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), jsonl([
    { type: 'meta', runId: path.basename(dir), createdAt: 2, workflowFile: '/tmp/large.js', args: large },
    { type: 'result', key: 'k', index: 3, status: 'completed', result: large },
  ]))
  fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
    { t: 2, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 3, type: 'agent', index: 3, key: 'k', adapter: 'mock', state: 'done' },
  ]))
  const detail = await new SnapshotStore({ deriveState: async () => ({ state: 'running' }) }).get(dir, { includeArgs: true })
  assert.equal(detail.createdAt, 2, 'a >1 MiB meta first line is still classified')
  assert.equal(detail.hasArgs, true)
  assert.equal(detail.argsTruncated, true)
  assert.ok(!('args' in detail))

  const agent = readAgentResult(dir, 3)
  assert.equal(agent.resultTruncated, true)
  assert.equal(agent.resultBytes, Buffer.byteLength(JSON.stringify(large)))
  assert.ok(Buffer.byteLength(agent.preview) <= 64 * 1024)

  assert.deepEqual(await readRunResult(dir, { deriveState: async () => ({ state: 'starting' }) }), { pending: true, state: 'starting' })
  fs.writeFileSync(path.join(dir, 'result.json'), '{')
  assert.deepEqual(await readRunResult(dir), { corrupt: true })
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'completed', result: large }))
  const run = await readRunResult(dir)
  assert.equal(run.resultTruncated, true)
  assert.ok(!('result' in run))
  assert.ok(Buffer.byteLength(run.preview) <= 64 * 1024)
})

test('first journal metadata read stops after the first 64 KiB page', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-meta-page-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'journal.jsonl')
  const first = jsonl([{ type: 'meta', createdAt: 7, workflowFile: '/tmp/page.js' }])
  fs.writeFileSync(file, first)
  fs.truncateSync(file, 30 * 1024 * 1024)

  let bytesRequested = 0
  const fsImpl = {
    ...fs,
    readSync(fd, buffer, offset, length, position) {
      bytesRequested += length
      return fs.readSync(fd, buffer, offset, length, position)
    },
  }
  const out = readFirstJournalMeta(file, { fsImpl })
  assert.equal(out.cacheable, true)
  assert.equal(out.meta.createdAt, 7)
  assert.equal(bytesRequested, 64 * 1024)
})

test('SnapshotStore is LRU-bounded and drops a vanished run entry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-lru-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const make = (name) => {
    const dir = path.join(root, name)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
      { t: 1, type: 'run', state: 'completed', engine: '0.2.0' },
    ]))
    return dir
  }
  const dirs = Array.from({ length: SNAPSHOT_CACHE_MAX_ENTRIES + 1 }, (_, i) => make(`run-${i}`))
  const store = new SnapshotStore({
    maxEntries: SNAPSHOT_CACHE_MAX_ENTRIES,
    deriveState: async () => ({ state: 'completed' }),
  })
  for (const dir of dirs) await store.get(dir)
  assert.equal(store.cache.size, SNAPSHOT_CACHE_MAX_ENTRIES)
  assert.equal(store.cache.has(dirs[0]), false, 'least recently used run was evicted')

  const vanished = dirs.at(-1)
  fs.rmSync(vanished, { recursive: true })
  await assert.rejects(store.get(vanished), (error) => error?.code === 'ENOENT')
  assert.equal(store.cache.has(vanished), false)
})

test('raw result stream and content length stay pinned to one inode across replacement', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-result-fd-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'result.json')
  const oldBody = JSON.stringify({ result: 'old' })
  const newBody = JSON.stringify({ result: 'new and longer' })
  fs.writeFileSync(file, oldBody)
  const opened = openResultReadStream(dir)
  fs.writeFileSync(path.join(dir, 'result.tmp'), newBody)
  fs.renameSync(path.join(dir, 'result.tmp'), file)

  const chunks = []
  for await (const chunk of opened.stream) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  assert.equal(opened.stat.size, Buffer.byteLength(oldBody))
  assert.equal(body.length, opened.stat.size)
  assert.equal(body.toString(), oldBody)
})

/**
 * §7.3 requires the viewer's resume modal to "show `graphDynamic` when set", and journal
 * `meta` (src/engine.js:832) is the only place it exists. It is therefore projected onto
 * `RunDetail` — additively, and TRI-STATE, because §6.5's degradation contract makes "the
 * field was never journalled" a different fact from "the graph was static": the engine
 * refuses to resume a run whose module graph it cannot verify (src/engine.js:797), so a UI
 * that turned an absent field into `false` would promise a preflight that cannot be checked.
 */
test('RunDetail projects meta.graphDynamic, tri-state, without disturbing old runs (§7.3 / §6.5)', async (t) => {
  const store = () => new SnapshotStore({ deriveState: async () => ({ state: 'completed' }) })
  const make = (meta) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-gd-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), jsonl([
      { type: 'meta', runId: path.basename(dir), createdAt: 1, workflowFile: '/tmp/gd.js', ...meta },
    ]))
    fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
      { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    ]))
    return dir
  }

  assert.equal((await store().get(make({ graphDynamic: true }))).graphDynamic, true)
  assert.equal((await store().get(make({ graphDynamic: false }))).graphDynamic, false)
  // An old run: the key is absent from meta, so the answer is "not recorded", never `false`.
  assert.equal((await store().get(make({}))).graphDynamic, null)
})

test('step events fold first-class: lifecycle, replay, re-run clears outcome, never unknown', () => {
  const state = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    // s1: failed on the first attempt, re-run to done on resume — the failure must not survive.
    { t: 2, type: 'step', key: 's1', name: 'create-branch', state: 'running', phaseIndex: 0, path: [] },
    { t: 3, type: 'step', key: 's1', state: 'failed', error: 'boom', durationMs: 5 },
    { t: 4, type: 'step', key: 's1', state: 'running' },
    { t: 5, type: 'step', key: 's1', state: 'done', durationMs: 3, resultPreview: '{"branch":"x"}' },
    // s2: a journal replay — one event, nothing executed.
    { t: 6, type: 'step', key: 's2', name: 'push', state: 'cached' },
    // keyless records are dropped, not folded into a phantom entry
    { t: 7, type: 'step', state: 'running' },
  ]))
  assert.equal(state.unknownEvents, 0, 'step is a known event type, never the debug row')
  assert.equal(state.steps.length, 2)
  const [s1, s2] = state.steps
  assert.equal(s1.name, 'create-branch')
  assert.equal(s1.state, 'done')
  assert.equal(s1.error, null, 're-run cleared the previous failure')
  assert.equal(s1.startedAt, 4, 're-entry restarts the clock')
  assert.equal(s1.endedAt, 5)
  assert.equal(s1.durationMs, 3)
  assert.equal(s1.resultPreview, '{"branch":"x"}')
  assert.equal(s1.cached, false)
  assert.equal(s2.state, 'cached')
  assert.equal(s2.cached, true)
  assert.equal(s2.durationMs, null, 'a replay executed nothing; no duration')
  assert.equal(s2.endedAt, 6, 'dated by the replay instant')
})

test('materializeFold orphans a running step under a dead run and ships steps on the view', () => {
  const raw = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'step', key: 's1', name: 'slow', state: 'running' },
    { t: 3, type: 'step', key: 's2', name: 'fast', state: 'running' },
    { t: 4, type: 'step', key: 's2', state: 'done', durationMs: 1 },
    { t: 5, type: 'run', state: 'interrupted' },
  ]))
  const view = materializeFold(raw, 'interrupted')
  assert.equal(view.steps.length, 2)
  assert.equal(view.steps[0].displayState, 'orphaned', 'a step the dead run left running is stranded')
  assert.equal(view.steps[0].state, 'running', 'displayState projects; the folded state is untouched')
  assert.equal(view.steps[1].displayState, 'done')
})

test('a JSON round trip of the fold state preserves steps and keeps folding onto them', () => {
  const before = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'step', key: 's1', name: 'a', state: 'running' },
  ]))
  // Snapshots cross the server/browser boundary as JSON (normalizeState's contract).
  const revived = JSON.parse(JSON.stringify(before))
  delete revived._stepByKey
  const after = fold(revived, records([
    { t: 3, type: 'step', key: 's1', state: 'done', durationMs: 2 },
  ], before.lastOffset))
  assert.equal(after.steps.length, 1)
  assert.equal(after.steps[0].state, 'done')
  assert.equal(after.steps[0].name, 'a', 'identity fields survived the round trip')
})
