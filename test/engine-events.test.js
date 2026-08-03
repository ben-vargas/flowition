// W1 — engine events change-set (DESIGN §8: E1–E7, E15).
//
// The FIRST two tests are determinism pins: they snapshot resume-key derivation
// (unit level) and the end-to-end journal key sequence (integration level) against
// values captured on the pre-change tree. Nothing in this unit — phase association,
// the structural path, queue events — may move a single byte of them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// short prefix: run-dir control.sock paths must stay under the ~104-byte sun_path cap
process.env.FLOWITION_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ev-'))

const K = await import('../src/keys.js')
const { runWorkflow } = await import('../src/engine.js')
const { controlRequest } = await import('../src/control.js')
const { foldEvents } = await import('../src/events.js')
const { runDir, readJsonl } = await import('../src/util.js')

const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ev-wf-'))
let wfSeq = 0
// Workflows are written as .mjs so Node parses them as ESM regardless of the
// temp dir's (absent) package.json.
const writeWf = (src) => {
  const file = path.join(wfDir, `wf${wfSeq++}.workflow.mjs`)
  fs.writeFileSync(file, src)
  return file
}
const eventsOf = (runId) => readJsonl(path.join(runDir(runId), 'events.jsonl'))
const journalOf = (runId) => readJsonl(path.join(runDir(runId), 'journal.jsonl'))
const sockOf = (runId) => path.join(runDir(runId), 'control.sock')
const byLabel = (evs, label, state) => evs.find((e) => e.type === 'agent' && e.label === label && e.state === state)

async function until(fn, ms = 10000) {
  const t0 = Date.now()
  for (;;) {
    let v = null
    try { v = await fn() } catch { /* not ready */ }
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('until(): timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

// ── the §8 field matrix ─────────────────────────────────────────────────────
// Every agent event this suite produces is checked against this table, and the
// last test asserts the suite actually exercised every state (so a state that
// stops being emitted fails loudly rather than silently skipping its row).
const MATRIX = {
  queued: ['index', 'key', 'label', 'adapter', 'model', 'phase', 'phaseIndex', 'path', 'sem'],
  running: ['index', 'key', 'label', 'adapter', 'model', 'effort', 'phase', 'phaseIndex', 'path', 'promptPreview', 'waitMs', 'stallMs', 'sem'],
  cached: ['index', 'key', 'label', 'adapter', 'model', 'phase', 'phaseIndex', 'path'],
  done: ['index', 'key', 'label', 'adapter', 'model', 'phase', 'phaseIndex', 'durationMs', 'outputTokens', 'usage', 'lastOutputAt', 'resultPreview'],
  failed: ['index', 'key', 'label', 'adapter', 'model', 'phase', 'phaseIndex', 'error', 'code', 'retryable', 'durationMs', 'usage', 'lastOutputAt'],
  cancelled: ['index', 'key', 'label', 'adapter', 'model', 'phase', 'phaseIndex', 'error', 'code', 'retryable', 'durationMs', 'usage', 'lastOutputAt'],
  progress: ['index', 'key', 'tool', 'outputTokens', 'lastOutputAt'],
  steered: ['index', 'label', 'adapter', 'delivery', 'phase', 'phaseIndex'],
}
const seenStates = new Set()
function assertMatrix(evs) {
  for (const ev of evs) {
    if (ev.type !== 'agent') continue
    const required = MATRIX[ev.state]
    assert.ok(required, `agent event with unknown state ${ev.state}`)
    seenStates.add(ev.state)
    for (const f of required) assert.ok(f in ev, `${ev.state} event is missing "${f}": ${JSON.stringify(ev)}`)
    assert.ok(typeof ev.t === 'number', 'every event carries t')
  }
}

// ── determinism pins ────────────────────────────────────────────────────────

test('pin: agentKey/deriveBranch/explicitKey outputs are byte-identical to pre-change', () => {
  assert.equal(K.KEY_VERSION, 'k2')
  const root = K.rootCtx('seed-abc')
  assert.equal(root.branch, 'ceebde6ef15b105100aec3ba39b753ff7d7cd598e1a30bf5ea5bbc38babc7415')

  const par = K.deriveBranch(root.branch, 'parallel', 0)
  const pip = K.deriveBranch(root.branch, 'pipeline', 1)
  const item = K.deriveBranch(par, 'item', 2)
  const stage = K.deriveBranch(K.deriveBranch(pip, 'item', 0), 'stage', 1)
  assert.equal(par, 'df6d469edf36c0c354b053fad15cfd0559cf6ff4feb73f834bd3a591dee72fb8')
  assert.equal(pip, 'b5febddc0c33ef75761beeeb25d551bb98f3b03de74b067216682d27e690bf5d')
  assert.equal(item, '79aff37f2d06e077d6102f6aa92ed461379e3924982b85cd0fa78ef7dc1537b3')
  assert.equal(stage, '6dcac73c695e55601ed952c4bf29346f91f803932170a49177ad157dd399ddfa')
  assert.equal(K.explicitKey('my-key'), '498b5258f38283f4fdd9d15ef47bb8c8b024c1f81f85b8b5a768d1dbd128ddd6')

  const keyed = { adapter: 'mock', model: null, mode: null, effort: null, system: null, schema: null, cwd: null }
  const ctx = K.makeCtx(root.branch, 'seed-abc')
  assert.equal(K.agentKey(ctx, 'ECHO hello', keyed), '51079aac99b6a21fff841bd272b1a2f2875f42fd5e67305eb8326146211fb392')
  assert.equal(K.agentKey(ctx, 'ECHO hello', keyed), 'bef336bb90d62d2c63527b74b728f3990d31372d53aae1cf893e1debaf37eeab')
  const deep = K.makeCtx(item, 'seed-abc')
  assert.equal(K.agentKey(deep, 'ECHO deep', { ...keyed, model: 'm', effort: 'high' }), 'd22449c826077dd44d1e61c7542ed6f7ec81fe310a285bf7d05e5352a0a725be')

  // a path argument (E2) must not perturb the branch-local RNG either
  const rng = K.makeCtx(root.branch, 'seed-abc', [{ kind: 'item', i: 3 }])
  assert.equal(K.nextRandom(rng), 0.5958163836039603)
  assert.equal(K.nextRandom(rng), 0.8132297622505575)
})

// The same workflow shape the viewer cares about (phase + parallel + pipeline +
// per-agent phase override + a sibling fanout), pinned end to end: if phase or path
// ever leaked into `keyed`, agentKey(), or a branch derivation, these change.
const WF_PIN = `export const meta = { name: 'pin', description: 'key stability pin' }
export default async function ({ agent, parallel, pipeline, phase }) {
  phase('alpha')
  const a = await agent('ECHO a', { adapter: 'mock' })
  const p = await parallel([
    () => agent('ECHO p0', { adapter: 'mock', label: 'p0' }),
    () => { phase('beta'); return agent('ECHO p1', { adapter: 'mock' }) },
  ])
  const q = await pipeline(['x'],
    (i) => agent('ECHO s0-' + i, { adapter: 'mock' }),
    (prev) => agent('ECHO s1-' + prev, { adapter: 'mock', phase: 'gamma' }))
  const s = await parallel([() => agent('ECHO second', { adapter: 'mock' })])
  return { a, p, q, s }
}
`

test('pin: end-to-end journal key sequence is byte-identical to pre-change', async () => {
  const pinFile = writeWf(WF_PIN)
  const out = await runWorkflow({ file: pinFile, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  const started = journalOf(out.runId).filter((e) => e.type === 'started').sort((a, b) => a.index - b.index)
  assert.deepEqual(started.map((e) => [e.index, e.key]), [
    [0, '8529e74cac3c778ca68e6532ee6141c0f84e51aa387d1613f5fb5af6da4d3e9b'],
    [1, '5a67e1c3341abf73708527301ebc68a5a5c55eddc9a84d3c4ffc67524563b8e3'],
    [2, '49d7f14eb1462b6215424e8e4764a2f6b97cd482bfefbf4dc0dc269aa86ebe7b'],
    [3, 'c7ad5759d699949362fef203d5dddfdb42440c5fd1ac7129bc5c42c0e09ad9cd'],
    [4, '4aea1e0673b448dbc77684ae90643753885789ddd22c0742eb444b5f31b922d6'],
    [5, '90f9190955f43953accfce24efed31fda1e4c6caf61293498429abcbb94b7a6c'],
  ])
  // and the keys still cache-hit on resume (the property the pin protects)
  const again = await runWorkflow({ file: pinFile, defaults: { adapter: "mock" }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(eventsOf(out.runId).filter((e) => e.type === 'agent' && e.state === 'cached').length, 6)
})

// ── E1: phase association ───────────────────────────────────────────────────

const WF_PHASE = `export const meta = { name: 'phases', description: 'phase association' }
export default async function ({ agent, parallel, phase }) {
  phase('setup')
  await parallel([
    () => agent('ECHO inherit', { adapter: 'mock', label: 'inherit' }),
    () => { phase('work'); return agent('ECHO w', { adapter: 'mock', label: 'w' }) },
  ])
  await parallel([
    () => { phase('dup'); return agent('ECHO d0', { adapter: 'mock', label: 'd0' }) },
    () => { phase('dup'); return agent('ECHO d1', { adapter: 'mock', label: 'd1' }) },
  ])
  await agent('ECHO after', { adapter: 'mock', label: 'after' })
  return 'ok'
}
`

test('E1: phase rides the ALS context — inherited by fanout children, isolated between concurrent branches', async () => {
  const out = await runWorkflow({ file: writeWf(WF_PHASE), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  const evs = eventsOf(out.runId)
  assertMatrix(evs)

  // phase events carry an index; identity is the index, not the title
  const phases = evs.filter((e) => e.type === 'phase')
  assert.deepEqual(phases.map((p) => p.title).sort(), ['dup', 'dup', 'setup', 'work'])
  assert.deepEqual([...new Set(phases.map((p) => p.phaseIndex))].length, 4)
  assert.equal(phases.find((p) => p.title === 'setup').phaseIndex, 0)

  const q = (label) => byLabel(evs, label, 'queued')
  // a top-level phase() flows into every parallel item...
  assert.equal(q('inherit').phase, 'setup')
  assert.equal(q('inherit').phaseIndex, 0)
  // ...while a phase() inside one branch stays in that branch
  assert.equal(q('w').phase, 'work')
  // repeated titles in CONCURRENT branches get distinct indexes — no global race
  assert.equal(q('d0').phase, 'dup')
  assert.equal(q('d1').phase, 'dup')
  assert.notEqual(q('d0').phaseIndex, q('d1').phaseIndex)
  // and neither branch's phase() ever leaked back into the parent context
  assert.equal(q('after').phase, 'setup')
  assert.equal(q('after').phaseIndex, 0)

  // the phase is carried on every state of an agent's life, not just `running`
  for (const state of ['queued', 'running', 'done']) {
    assert.equal(byLabel(evs, 'w', state).phase, 'work')
    assert.equal(byLabel(evs, 'w', state).phaseIndex, q('w').phaseIndex)
  }
})

const WF_PHASE_OPT = `export const meta = { name: 'phaseopt', description: 'explicit phase' }
export default async function ({ agent, phase }) {
  phase('one')
  phase('two')
  await agent('ECHO a', { adapter: 'mock', label: 'pinned', phase: 'one' })
  await agent('ECHO b', { adapter: 'mock', label: 'ambient' })
  await agent('ECHO c', { adapter: 'mock', label: 'undeclared', phase: 'later' })
  return 'ok'
}
`

test('E1: an explicit AgentOptions.phase wins over interleaved phase() calls', async () => {
  const out = await runWorkflow({ file: writeWf(WF_PHASE_OPT), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  const evs = eventsOf(out.runId)
  assertMatrix(evs)

  // the ambient phase at call time is 'two'; the override reclaims 'one' AND its index
  assert.equal(byLabel(evs, 'pinned', 'running').phase, 'one')
  assert.equal(byLabel(evs, 'pinned', 'running').phaseIndex, 0)
  assert.equal(byLabel(evs, 'ambient', 'running').phase, 'two')
  assert.equal(byLabel(evs, 'ambient', 'running').phaseIndex, 1)
  // a title no phase() declared opens its own group, announced as an implicit phase
  const undeclared = byLabel(evs, 'undeclared', 'running')
  assert.equal(undeclared.phase, 'later')
  const implicit = evs.find((e) => e.type === 'phase' && e.title === 'later')
  assert.equal(implicit.implicit, true)
  assert.equal(implicit.phaseIndex, undeclared.phaseIndex)
})

// ── E2: structural path ─────────────────────────────────────────────────────

const WF_PATH = `export const meta = { name: 'paths', description: 'structural path' }
export default async function ({ agent, parallel, pipeline }) {
  await parallel([
    () => agent('ECHO p0', { adapter: 'mock', label: 'p0' }),
    () => pipeline(['x'],
      () => agent('ECHO s0', { adapter: 'mock', label: 's0' }),
      () => parallel([() => agent('ECHO deep', { adapter: 'mock', label: 'deep' })])),
  ])
  await parallel([() => agent('ECHO sib', { adapter: 'mock', label: 'sib' })])
  return 'ok'
}
`

test('E2: nested parallel-in-pipeline path shape; sibling fanouts get distinct ordinals', async () => {
  const out = await runWorkflow({ file: writeWf(WF_PATH), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  const evs = eventsOf(out.runId)
  assertMatrix(evs)

  const outer = [{ kind: 'parallel', ordinal: 0, count: 2 }]
  assert.deepEqual(byLabel(evs, 'p0', 'queued').path, [...outer, { kind: 'item', i: 0 }])

  const pipe = [...outer, { kind: 'item', i: 1 }, { kind: 'pipeline', ordinal: 0, count: 1, stages: 2 }]
  assert.deepEqual(byLabel(evs, 's0', 'queued').path, [...pipe, { kind: 'item', i: 0 }, { kind: 'stage', s: 0 }])
  assert.deepEqual(byLabel(evs, 'deep', 'queued').path, [
    ...pipe, { kind: 'item', i: 0 }, { kind: 'stage', s: 1 },
    { kind: 'parallel', ordinal: 0, count: 1 }, { kind: 'item', i: 0 },
  ])
  // a SEQUENTIAL sibling fanout at the same level is disambiguated by its ordinal
  assert.deepEqual(byLabel(evs, 'sib', 'queued').path, [{ kind: 'parallel', ordinal: 1, count: 1 }, { kind: 'item', i: 0 }])

  // fanout events: one per container, carrying the container's OWN full path
  const fanouts = evs.filter((e) => e.type === 'fanout')
  assert.deepEqual(fanouts.map((f) => [f.kind, f.count, f.stages ?? null]), [
    ['parallel', 2, null], ['pipeline', 1, 2], ['parallel', 1, null], ['parallel', 1, null],
  ])
  assert.deepEqual(fanouts[0].path, outer)
  assert.deepEqual(fanouts[1].path, pipe)
  assert.deepEqual(fanouts[3].path, [{ kind: 'parallel', ordinal: 1, count: 1 }])
  // the path travels with the agent through every pre-terminal state
  for (const state of ['queued', 'running']) assert.deepEqual(byLabel(evs, 'deep', state).path, byLabel(evs, 'deep', 'queued').path)
})

// ── E3: run-start metadata ──────────────────────────────────────────────────

const WF_META = `export const meta = { name: 'metarun', description: 'run metadata', phases: [{ title: 'Scan', detail: 'grep' }] }
export default async function ({ agent }) {
  return agent('ECHO m', { adapter: 'mock', label: 'm' })
}
`

test('E3: the run-start event describes the run — file, cwd, defaults, concurrency, budget, phases, engine', async () => {
  const file = writeWf(WF_META)
  const out = await runWorkflow({ file, defaults: { adapter: 'mock', model: 'm1', effort: 'high' }, concurrency: 3, budgetTotal: 100000, quiet: true })
  assert.equal(out.status, 'completed')
  const start = eventsOf(out.runId).find((e) => e.type === 'run' && e.state === 'started')
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(start.workflowFile, file)
  assert.ok(path.isAbsolute(start.workflowFile))
  assert.equal(start.file, path.basename(file))   // the old basename field is untouched
  assert.equal(start.cwd, process.cwd())
  assert.deepEqual(start.defaults, { adapter: 'mock', model: 'm1', effort: 'high' })
  assert.equal(start.concurrency, 3)
  assert.equal(start.budgetTotal, 100000)
  assert.deepEqual(start.phases, [{ title: 'Scan', detail: 'grep' }])
  assert.equal(start.engine, pkg.version)
  assert.equal(start.name, 'metarun')

  // resume restores the budget, and its own start event says so
  const again = await runWorkflow({ file, defaults: { adapter: 'mock', model: 'm1', effort: 'high' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  const resumed = eventsOf(out.runId).find((e) => e.type === 'run' && e.state === 'resumed')
  assert.equal(resumed.budgetTotal, 100000)
  assert.equal(resumed.engine, pkg.version)
  assertMatrix(eventsOf(out.runId))
})

// ── E4: queue admission ─────────────────────────────────────────────────────

// Saturation at concurrency 2: three agents, two long enough to hold both slots
// while the third waits. Concurrency 1 could never distinguish "the gauge works"
// from "there is only ever one slot" — the §2.4 saturation strip needs both.
const WF_QUEUE = `export const meta = { name: 'queue', description: 'queue admission' }
export default async function ({ agent, parallel }) {
  return parallel([
    () => agent('SLEEP 600\\nECHO first', { adapter: 'mock', label: 'first', stallMs: 1234 }),
    () => agent('SLEEP 600\\nECHO second', { adapter: 'mock', label: 'second' }),
    () => agent('ECHO third', { adapter: 'mock', label: 'third' }),
  ])
}
`

test('E4: at concurrency 2, two slots saturate and the third agent waits — queued→running ordering, waitMs, and the sem gauge across admission and handoff', async () => {
  const out = await runWorkflow({ file: writeWf(WF_QUEUE), defaults: { adapter: 'mock' }, concurrency: 2, quiet: true })
  assert.equal(out.status, 'completed')
  const evs = eventsOf(out.runId)
  assertMatrix(evs)
  const agentEvs = evs.filter((e) => e.type === 'agent')
  const order = agentEvs.map((e) => `${e.label}:${e.state}`)
  // all three are admitted to the QUEUE before any of them is admitted to a slot
  assert.deepEqual(order.slice(0, 5), ['first:queued', 'second:queued', 'third:queued', 'first:running', 'second:running'])
  assert.equal(order.indexOf('third:running') > order.indexOf('first:done') || order.indexOf('third:running') > order.indexOf('second:done'), true, order.join(' '))

  // ── exact gauges. Sampled AT each emit site (E4): `queued` before sem.with, so an
  // agent's own queued event reports the queue it is about to join, not the one it
  // has joined; `running` inside the callback.
  assert.deepEqual(byLabel(evs, 'first', 'queued').sem, { active: 0, queued: 0, limit: 2 })
  assert.deepEqual(byLabel(evs, 'second', 'queued').sem, { active: 1, queued: 0, limit: 2 })
  assert.deepEqual(byLabel(evs, 'third', 'queued').sem, { active: 2, queued: 0, limit: 2 })
  // both slots held, one waiter — the state the saturation strip must be able to draw
  assert.deepEqual(byLabel(evs, 'first', 'running').sem, { active: 2, queued: 1, limit: 2 })
  assert.deepEqual(byLabel(evs, 'second', 'running').sem, { active: 2, queued: 1, limit: 2 })
  // handoff: release() passes the slot straight to the waiter without decrementing,
  // so the freed-and-refilled instant still reads at the limit with an empty queue
  assert.deepEqual(byLabel(evs, 'third', 'running').sem, { active: 2, queued: 0, limit: 2 })

  // waitMs: the two admitted immediately waited ~nothing; the third waited out a
  // 600ms sleep. This is the number the old event set could not express at all
  // (running fires only after admission).
  const third = byLabel(evs, 'third', 'running')
  assert.ok(third.waitMs >= 300, `waitMs ${third.waitMs}`)
  assert.ok(third.waitMs <= third.t - byLabel(evs, 'third', 'queued').t + 50)
  for (const l of ['first', 'second']) {
    const r = byLabel(evs, l, 'running')
    assert.ok(r.waitMs >= 0 && r.waitMs < third.waitMs, `${l} waitMs ${r.waitMs}`)
  }

  // and the emitted stream itself never shows more than `concurrency` agents
  // executing at once, while genuinely reaching the limit
  let live = 0
  let peak = 0
  for (const e of agentEvs) {
    if (e.state === 'running') peak = Math.max(peak, ++live)
    else if (e.state === 'done' || e.state === 'failed' || e.state === 'cancelled') live--
  }
  assert.equal(peak, 2, 'both slots were held simultaneously')
  assert.equal(live, 0, 'every admitted agent reached a terminal event')

  // stallMs is the RESOLVED per-agent value, so the viewer's stall warning is
  // honest instead of assuming the 30-minute default
  assert.equal(byLabel(evs, 'first', 'running').stallMs, 1234)
  assert.equal(byLabel(evs, 'second', 'running').stallMs, 30 * 60_000)
})

const WF_ABORT = `export const meta = { name: 'abortq', description: 'abort while queued' }
export default async function ({ agent, parallel }) {
  return parallel([
    () => agent('SLEEP 8000\\nECHO blocker', { adapter: 'mock', label: 'blocker' }),
    () => agent('ECHO never', { adapter: 'mock', label: 'never' }),
  ])
}
`

test('E4: an agent aborted while queued gets a terminal event instead of hanging on `queued` forever', async () => {
  const runId = 'flo_ev_abortq'
  const p = runWorkflow({ file: writeWf(WF_ABORT), defaults: { adapter: 'mock' }, concurrency: 1, runId, quiet: true })
  await until(() => byLabel(eventsOf(runId), 'never', 'queued') && byLabel(eventsOf(runId), 'blocker', 'running'))
  // steer the live agent first — the only emitter of `steered`, and the one event
  // site with no ALS context to read the phase from
  const sent = await controlRequest(sockOf(runId), { cmd: 'send', agent: 'blocker', message: 'hello' })
  assert.ok(sent.ok)
  await controlRequest(sockOf(runId), { cmd: 'cancel' })
  const out = await p
  assert.equal(out.status, 'interrupted')

  const evs = eventsOf(runId)
  assertMatrix(evs)
  const never = evs.filter((e) => e.type === 'agent' && e.label === 'never')
  assert.deepEqual(never.map((e) => e.state), ['queued', 'cancelled'])
  const terminal = never[1]
  assert.equal(terminal.error, 'run aborted')
  assert.equal(terminal.usage, null)          // it never ran: no spend to report
  assert.equal(terminal.lastOutputAt, null)
  assert.ok(terminal.waitMs >= 0)
  // the running agent's own terminal event keeps the code the engine branched on
  const blocker = byLabel(evs, 'blocker', 'cancelled')
  assert.equal(blocker.code, 'cancelled')
  assert.equal(blocker.retryable, false)
  assert.ok(blocker.durationMs >= 0 && typeof blocker.usage === 'object')
  // and `flowition status` never shows either of them as still queued/running
  const folded = foldEvents(runDir(runId))
  assert.deepEqual([...folded.agents.values()].map((a) => a.state).sort(), ['cancelled', 'cancelled'])
})

// ── E5: terminal-event completeness ─────────────────────────────────────────

const WF_FAIL = `export const meta = { name: 'failinfo', description: 'terminal completeness' }
const SCHEMA = { type: 'object', required: ['zzz'], properties: { zzz: { type: 'string' } } }
export default async function ({ agent, phase }) {
  phase('checks')
  await agent('ECHO ok', { adapter: 'mock', label: 'good', model: 'm1' })
  return agent('JSON {"n":1}', { adapter: 'mock', label: 'bad', model: 'm1', schema: SCHEMA })
}
`

test('E5: done carries usage+model; failed carries code/retryable/usage/durationMs/lastOutputAt, and the journal records adapter+model', async () => {
  const out = await runWorkflow({ file: writeWf(WF_FAIL), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'failed')
  const evs = eventsOf(out.runId)
  assertMatrix(evs)

  const done = byLabel(evs, 'good', 'done')
  assert.equal(done.model, 'm1')
  assert.deepEqual(Object.keys(done.usage).sort(), ['cost', 'input', 'output'])
  assert.equal(done.usage.output, done.outputTokens)
  assert.ok(done.usage.input > 0)
  assert.ok(done.lastOutputAt > 0 && done.lastOutputAt <= done.t)
  assert.equal(done.phase, 'checks')

  const failed = byLabel(evs, 'bad', 'failed')
  assert.equal(failed.code, 'schema_invalid')   // previously dropped on the floor
  assert.equal(failed.retryable, false)
  assert.equal(failed.model, 'm1')
  assert.equal(failed.phase, 'checks')
  assert.ok(failed.durationMs >= 0)
  assert.ok(failed.usage.output > 0, 'a failed attempt still spent tokens')
  assert.ok(failed.lastOutputAt > 0)
  assert.match(failed.error, /failed schema/)

  const rec = journalOf(out.runId).find((e) => e.type === 'result' && e.status === 'failed')
  assert.equal(rec.adapter, 'mock')
  assert.equal(rec.model, 'm1')
})

// ── E6: throttled progress ──────────────────────────────────────────────────

const WF_PROGRESS = `export const meta = { name: 'progress', description: 'throttled progress' }
export default async function ({ agent }) {
  return agent('TOOL alpha\\nSLEEP 2700\\nTOOL beta\\nSLEEP 2700\\nECHO done', { adapter: 'mock', label: 'slow' })
}
`

test('E6: progress is throttled to one event per window per agent and reports the provider\'s own lastOutputAt', async () => {
  const runId = 'flo_ev_progress'
  const p = runWorkflow({ file: writeWf(WF_PROGRESS), defaults: { adapter: 'mock' }, runId, quiet: true })
  // the live socket exposes the same timestamp (§8 E6, src/engine.js status payload)
  const live = await until(async () => {
    const st = await controlRequest(sockOf(runId), { cmd: 'status' })
    return st?.ok && st.agents.length && st.agents[0].lastOutputAt ? st : null
  })
  assert.ok(live.agents[0].lastOutputAt <= Date.now())
  const out = await p
  assert.equal(out.status, 'completed')

  const evs = eventsOf(runId)
  assertMatrix(evs)
  const prog = evs.filter((e) => e.type === 'agent' && e.state === 'progress')
  const running = byLabel(evs, 'slow', 'running')
  const done = byLabel(evs, 'slow', 'done')
  assert.ok(prog.length >= 1, 'a working agent reports progress')
  // ceiling: one per window over the agent's life, plus one for rounding
  assert.ok(prog.length <= Math.ceil((done.t - running.t) / 2500) + 1, `${prog.length} progress events in ${done.t - running.t}ms`)
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i].t - prog[i - 1].t >= 2400, 'throttled to the window')
  for (const e of prog) {
    assert.equal(e.index, 0)
    assert.equal(e.key, running.key)
    // the age the client shows is measured from REAL output, never from the
    // event's own arrival — a silent agent must look silent
    assert.ok(e.lastOutputAt <= e.t, 'lastOutputAt is not in the future')
    assert.ok(e.lastOutputAt >= running.t - 50)
  }
  // the agent went quiet for 2.7s between tool calls, so at least one progress
  // event is meaningfully older than its own timestamp
  assert.ok(prog.some((e) => e.t - e.lastOutputAt > 1000), JSON.stringify(prog.map((e) => e.t - e.lastOutputAt)))
  assert.ok(prog.some((e) => e.tool === 'alpha' || e.tool === 'beta'), 'the last tool is reported')
  // annotations never become the agent's state
  assert.equal(foldEvents(runDir(runId)).agents.get(0).state, 'done')
})

// The other half of E6: an agent whose provider says NOTHING. `NOSESSION` suppresses
// the mock's opening session event, so the turn emits no protocol event at all until
// it returns — the only script that is genuinely silent.
const WF_SILENT = `export const meta = { name: 'silent', description: 'a provider that says nothing' }
export default async function ({ agent }) {
  return agent('NOSESSION\\nSLEEP 4000\\nECHO quiet', { adapter: 'mock', label: 'mute', stallMs: 1200 })
}
`

test('E6: a silent agent emits no progress at all, and the stall warning fires off its frozen lastOutputAt', async () => {
  const runId = 'flo_ev_silent'
  const STALL = 1200
  const p = runWorkflow({ file: writeWf(WF_SILENT), defaults: { adapter: 'mock' }, runId, quiet: true })
  const sample = async () => {
    const st = await controlRequest(sockOf(runId), { cmd: 'status' })
    return st?.ok && st.agents.length && st.agents[0].lastOutputAt ? { at: Date.now(), lastOutputAt: st.agents[0].lastOutputAt } : null
  }
  const early = await until(sample)
  // §2.4 / Q2: amber "quiet for Nm" once the age of the agent's REAL last output
  // passes 50% of its emitted stallMs. The client ages the absolute timestamp — never
  // the event's own arrival time — which is the whole point of E6.
  const quietFor = (s) => s.at - s.lastOutputAt
  const warns = (lastOutputAt, now, stallMs) => now - lastOutputAt > stallMs / 2
  assert.equal(warns(early.lastOutputAt, early.lastOutputAt, STALL), false)
  assert.equal(warns(early.lastOutputAt, early.lastOutputAt + STALL / 2, STALL), false, 'exactly at the threshold is not yet a warning')
  assert.equal(warns(early.lastOutputAt, early.lastOutputAt + STALL / 2 + 1, STALL), true)

  await new Promise((r) => setTimeout(r, STALL))
  const later = await sample()
  assert.ok(later, 'the agent is still live')
  // the clock did not move: nothing was emitted, and the progress timer must never
  // write it — this is exactly what makes a silent agent look silent
  assert.equal(later.lastOutputAt, early.lastOutputAt)
  assert.ok(quietFor(later) >= STALL, `quiet for ${quietFor(later)}ms`)
  assert.equal(warns(later.lastOutputAt, later.at, STALL), true, 'the viewer would show the amber quiet tag by now')

  const out = await p
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'quiet')
  const evs = eventsOf(runId)
  assertMatrix(evs)
  const running = byLabel(evs, 'mute', 'running')
  const done = byLabel(evs, 'mute', 'done')
  assert.equal(running.stallMs, STALL)
  // >4s of silence spans several 2,500ms windows; a gate that mistook the turn-start
  // baseline (or a synthesized parser event) for output would have emitted here
  assert.ok(done.t - running.t >= 4000, `ran for ${done.t - running.t}ms`)
  assert.equal(evs.filter((e) => e.type === 'agent' && e.state === 'progress').length, 0, 'silence emits nothing')
  // the silence clock still starts at turn start, so the age is measured from
  // admission rather than from event zero
  assert.ok(early.lastOutputAt >= running.t - 50, `${early.lastOutputAt - running.t}ms after running`)
  // and real output at the very end (the returned text) does advance it
  assert.ok(done.lastOutputAt > early.lastOutputAt && done.lastOutputAt <= done.t)
  assert.equal(foldEvents(runDir(runId)).agents.get(0).state, 'done')
})

// ── E7: answer values ───────────────────────────────────────────────────────

const WF_ASK = `export const meta = { name: 'asker', description: 'answer visibility' }
export default async function ({ agent, ask }) {
  const color = await ask('what color?')
  return agent('ECHO ' + color, { adapter: 'mock', label: 'painter' })
}
`

test('E7: answer events carry the value, and a resumed run re-emits it as replayed', async () => {
  const runId = 'flo_ev_ask'
  const file = writeWf(WF_ASK)
  const p = runWorkflow({ file, defaults: { adapter: 'mock' }, runId, quiet: true })
  const q = await until(() => eventsOf(runId).find((e) => e.type === 'question'))
  assert.ok((await controlRequest(sockOf(runId), { cmd: 'answer', qid: q.qid, value: 'blue' })).ok)
  const out = await p
  assert.equal(out.result, 'blue')

  const answer = eventsOf(runId).find((e) => e.type === 'answer')
  assert.equal(answer.value, 'blue')
  assert.equal(answer.replayed, undefined)

  const again = await runWorkflow({ file, defaults: { adapter: 'mock' }, resumeId: runId, quiet: true })
  assert.equal(again.status, 'completed')
  const replayed = eventsOf(runId).filter((e) => e.type === 'answer')
  assert.equal(replayed.length, 2)
  assert.equal(replayed[1].value, 'blue')
  assert.equal(replayed[1].replayed, true)
  assertMatrix(eventsOf(runId))
})

// ── E15: fold staleness ─────────────────────────────────────────────────────

const WF_FLAKY = `export const meta = { name: 'flaky', description: 'fold staleness' }
export default async function ({ agent }) {
  return agent('FAILN evfold 1', { adapter: 'mock', label: 'flaky' })
}
`

test('E15: a resumed-and-succeeded agent no longer folds with its previous attempt\'s error', async () => {
  const file = writeWf(WF_FLAKY)
  const first = await runWorkflow({ file, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(first.status, 'failed')
  assert.ok(foldEvents(runDir(first.runId)).agents.get(0).error)

  const second = await runWorkflow({ file, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(second.status, 'completed')
  const agent0 = foldEvents(runDir(first.runId)).agents.get(0)
  assert.equal(agent0.state, 'done')
  assert.equal(agent0.error, undefined, 'the stale error is cleared on the re-run transition')
  assert.equal(agent0.code, undefined)
  assert.ok(agent0.durationMs >= 0)
  assertMatrix(eventsOf(first.runId))
})

test('E15: foldEvents — transitions clear stale outcome fields, annotations never overwrite state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fold-'))
  const write = (recs) => fs.writeFileSync(path.join(dir, 'events.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  write([
    { t: 1, type: 'agent', index: 0, state: 'failed', label: 'a', error: 'boom', code: 'stalled', retryable: true, durationMs: 5, resultPreview: 'old' },
    { t: 2, type: 'agent', index: 0, state: 'queued', label: 'a' },
    { t: 3, type: 'agent', index: 0, state: 'running', label: 'a' },
    { t: 4, type: 'agent', index: 0, state: 'progress', tool: 'grep', outputTokens: 7, lastOutputAt: 3 },
    { t: 5, type: 'agent', index: 0, state: 'steered', delivery: 'queued' },
    { t: 6, type: 'agent', index: 1, state: 'invented-by-a-newer-engine' },
    { t: 7, type: 'fanout', path: [], kind: 'parallel', count: 1 },
  ])
  const snap = foldEvents(dir)
  const a = snap.agents.get(0)
  assert.equal(a.state, 'running', 'progress/steered are annotations, not transitions')
  assert.equal(a.error, undefined)
  assert.equal(a.code, undefined)
  assert.equal(a.retryable, undefined)
  assert.equal(a.durationMs, undefined)
  assert.equal(a.resultPreview, undefined)
  assert.equal(a.tool, 'grep')          // the annotation's own fields still merge
  assert.equal(a.lastOutputAt, 3)
  assert.equal(a.label, 'a')            // identity fields survive terse events
  // an unknown state from a newer engine is recorded verbatim, never guessed at
  assert.equal(snap.agents.get(1).state, 'invented-by-a-newer-engine')
})

// ── coverage guard ──────────────────────────────────────────────────────────

test('field matrix: this suite exercised every agent state in the §8 vocabulary', () => {
  assert.deepEqual([...seenStates].sort(), ['cached', 'cancelled', 'done', 'failed', 'progress', 'queued', 'running', 'steered'])
})
