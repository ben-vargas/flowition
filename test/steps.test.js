import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.FLOWITION_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-test-'))

const { runWorkflow } = await import('../src/engine.js')
const { runDir, readJsonl } = await import('../src/util.js')
const { foldEvents } = await import('../src/events.js')

const fx = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name)
const counters = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const newCounterFile = () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flo-steps-')), 'counters.json')
  fs.writeFileSync(f, '{}')
  return f
}

test('step(): completed steps replay on resume without re-executing, failed step re-runs', async () => {
  const counterFile = newCounterFile()
  const args = { counterFile }

  const first = await runWorkflow({ file: fx('steps.workflow.js'), args, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(first.status, 'failed')
  assert.match(first.error, /flaky boom/)
  // every callback ran exactly once, including the one that failed
  assert.deepEqual(counters(counterFile), { alpha: 1, void: 1, par1: 1, par2: 1, flaky: 1 })

  const journal1 = readJsonl(path.join(runDir(first.runId), 'journal.jsonl'))
  assert.equal(journal1.filter((e) => e.type === 'step-result' && e.status === 'completed').length, 4)
  assert.equal(journal1.filter((e) => e.type === 'step-result' && e.status === 'failed').length, 1)

  const second = await runWorkflow({ file: fx('steps.workflow.js'), args, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(second.status, 'completed')
  // completed steps did NOT re-run; the failed one did
  assert.deepEqual(counters(counterFile), { alpha: 1, void: 1, par1: 1, par2: 1, flaky: 2 })
  // replayed results are byte-identical to the first execution
  assert.deepEqual(second.result.a, { ran: 1 })
  assert.equal(second.result.v, null) // void callback normalizes to null
  assert.deepEqual(second.result.par, [{ n: 1, ran: 1 }, { n: 2, ran: 1 }])
  assert.equal(second.result.echoed, 'after-steps')
  assert.deepEqual(second.result.flaky, { n: 2 })

  // resume emitted cached events for exactly the four completed steps
  const events = readJsonl(path.join(runDir(first.runId), 'events.jsonl'))
  assert.equal(events.filter((e) => e.type === 'step' && e.state === 'cached').length, 4)

  // resuming the now-complete run replays ALL five steps with zero executions
  const third = await runWorkflow({ file: fx('steps.workflow.js'), args, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(third.status, 'completed')
  assert.deepEqual(third.result, second.result)
  assert.deepEqual(counters(counterFile), { alpha: 1, void: 1, par1: 1, par2: 1, flaky: 2 })
})

test('step(): steps are visible in the folded status snapshot', async () => {
  const counterFile = newCounterFile()
  const first = await runWorkflow({ file: fx('steps.workflow.js'), args: { counterFile }, defaults: { adapter: 'mock' }, quiet: true })
  const snap = foldEvents(runDir(first.runId))
  assert.equal(snap.steps.size, 5)
  const byName = new Map([...snap.steps.values()].map((s) => [s.name, s]))
  assert.equal(byName.get('alpha').state, 'done')
  assert.equal(byName.get('void-step').state, 'done')
  assert.equal(byName.get('flaky').state, 'failed')
  assert.match(byName.get('flaky').error, /flaky boom/)
  // a resumed run's re-run clears the stale failure from the fold
  await runWorkflow({ file: fx('steps.workflow.js'), args: { counterFile }, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  const snap2 = foldEvents(runDir(first.runId))
  const flaky2 = [...snap2.steps.values()].find((s) => s.name === 'flaky')
  assert.equal(flaky2.state, 'done')
  assert.equal(flaky2.error, undefined)
})

test('step(): does not shift agent resume keys (independent counters)', async () => {
  const counterFile = newCounterFile()
  const withSteps = await runWorkflow({ file: fx('steps.workflow.js'), args: { counterFile }, defaults: { adapter: 'mock' }, quiet: true })
  const control = await runWorkflow({ file: fx('steps-keys-control.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  const agentKeyOf = (id) => readJsonl(path.join(runDir(id), 'journal.jsonl')).find((e) => e.type === 'started')?.key
  // five steps precede the agent in one workflow and zero in the other — the
  // agent's key must be identical because steps use their own counter
  assert.equal(agentKeyOf(withSteps.runId), agentKeyOf(control.runId))
})

test('step(): non-JSON args fail loudly and never derive a key', async () => {
  const out = await runWorkflow({ file: fx('steps-bad.workflow.js'), args: { mode: 'bad-args' }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'failed')
  assert.match(out.error, /step "bad-args" args at fn is a function/)
  // the bad step never journaled anything — no start, no result
  const journal = readJsonl(path.join(runDir(out.runId), 'journal.jsonl'))
  assert.ok(!journal.some((e) => e.type === 'step-start' || e.type === 'step-result'))
})

test('step(): explicit undefined args are rejected — only the two-arg overload supplies null', async () => {
  const out = await runWorkflow({ file: fx('steps-bad.workflow.js'), args: { mode: 'undefined-args' }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'failed')
  assert.match(out.error, /step "undefined-args" args is undefined; not valid JSON/)
})

test('step(): sparse-array args are rejected before any key is derived', async () => {
  const out = await runWorkflow({ file: fx('steps-bad.workflow.js'), args: { mode: 'sparse-args' }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'failed')
  assert.match(out.error, /step "sparse-args" args at list\[0\] is an array hole/)
  const journal = readJsonl(path.join(runDir(out.runId), 'journal.jsonl'))
  assert.ok(!journal.some((e) => e.type === 'step-start'), 'no step-start — rejection precedes the key')
})

test('step(): a non-JSON result fails loudly and is never cached as a completion', async () => {
  const first = await runWorkflow({ file: fx('steps-bad.workflow.js'), args: { mode: 'bad-result' }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(first.status, 'failed')
  assert.match(first.error, /step "bad-result" result at oops is a non-finite number/)
  const journal = readJsonl(path.join(runDir(first.runId), 'journal.jsonl'))
  assert.equal(journal.filter((e) => e.type === 'step-result' && e.status === 'completed').length, 0)
  assert.equal(journal.filter((e) => e.type === 'step-result' && e.status === 'failed').length, 1)
  // resume re-runs the callback (still malformed) instead of replaying garbage
  const second = await runWorkflow({ file: fx('steps-bad.workflow.js'), args: { mode: 'bad-result' }, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(second.status, 'failed')
  const journal2 = readJsonl(path.join(runDir(first.runId), 'journal.jsonl'))
  assert.equal(journal2.filter((e) => e.type === 'step-result' && e.status === 'completed').length, 0)
  assert.equal(journal2.filter((e) => e.type === 'step-result' && e.status === 'failed').length, 2)
})

test('step(): a callback returning a function fails loudly', async () => {
  const out = await runWorkflow({ file: fx('steps-bad.workflow.js'), args: { mode: 'bad-result-fn' }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'failed')
  assert.match(out.error, /step "bad-result-fn" result is a function/)
})

test('step(): a throw in post-completion telemetry never invalidates the completed record', async () => {
  // Regression: the completed step-result must SEAL the outcome. If success
  // telemetry (events.emit) throws AFTER that record is journaled, no failed
  // record may follow it — journal replay is last-wins, so a trailing failed
  // record would re-run the already-performed side effect on resume.
  const { EventSink } = await import('../src/events.js')
  const counterFile = newCounterFile()
  const origEmit = EventSink.prototype.emit
  let detonations = 0
  EventSink.prototype.emit = function (ev) {
    if (ev.type === 'step' && ev.state === 'done') {
      detonations++
      throw new Error('telemetry disk full')
    }
    return origEmit.call(this, ev)
  }
  let first
  try {
    first = await runWorkflow({ file: fx('steps-telemetry.workflow.js'), args: { counterFile }, defaults: { adapter: 'mock' }, quiet: true })
  } finally {
    EventSink.prototype.emit = origEmit
  }
  assert.equal(detonations, 1)
  assert.equal(first.status, 'completed')
  assert.deepEqual(first.result, { ran: 1 })
  const journal = readJsonl(path.join(runDir(first.runId), 'journal.jsonl'))
  const results = journal.filter((e) => e.type === 'step-result')
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'completed')
  // resume replays the sealed completion — the side effect never re-runs
  const second = await runWorkflow({ file: fx('steps-telemetry.workflow.js'), args: { counterFile }, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(second.status, 'completed')
  assert.deepEqual(second.result, { ran: 1 })
  assert.deepEqual(counters(counterFile), { effect: 1 })
})

test('step(): step and agent keys are domain-separated even with identical inputs', async () => {
  // A step whose name/args structurally match an agent's prompt/keyed-fields at
  // the same branch-local ordinal must NEVER share that agent's resume key —
  // the hash inputs carry a literal 'step' / 'agent' discriminator at a fixed
  // offset (the branch is always a fixed-length sha256 hex).
  const K = await import('../src/keys.js')
  const branch = K.rootCtx('seed-x').branch
  const agentCtx = K.makeCtx(branch, 'seed-x')
  const stepCtx = K.makeCtx(branch, 'seed-x')
  const aKey = K.agentKey(agentCtx, 'same-text', { x: 1 })
  const sKey = K.stepKey(stepCtx, 'same-text', { x: 1 })
  assert.notEqual(aKey, sKey)
  // and neither counter advanced the other's domain
  assert.equal(agentCtx.agentIndex, 1)
  assert.equal(agentCtx.stepIndex, 0)
  assert.equal(stepCtx.stepIndex, 1)
  assert.equal(stepCtx.agentIndex, 0)
})

test('step(): a start-only record (crash window) re-runs the callback on resume', async () => {
  const counterFile = newCounterFile()
  const first = await runWorkflow({ file: fx('steps.workflow.js'), args: { counterFile }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(first.status, 'failed')
  // Simulate a crash after alpha's callback ran but before its completion was
  // journaled: strip alpha's step-result record, keeping its step-start.
  const jf = path.join(runDir(first.runId), 'journal.jsonl')
  const lines = fs.readFileSync(jf, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const alphaStart = lines.find((e) => e.type === 'step-start' && e.name === 'alpha')
  assert.ok(alphaStart)
  const kept = lines.filter((e) => !(e.type === 'step-result' && e.key === alphaStart.key))
  fs.writeFileSync(jf, kept.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const second = await runWorkflow({ file: fx('steps.workflow.js'), args: { counterFile }, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(second.status, 'completed')
  // alpha re-ran (start-only is ambiguous → re-run policy); the other completed
  // steps replayed
  assert.deepEqual(counters(counterFile), { alpha: 2, void: 1, par1: 1, par2: 1, flaky: 2 })
  assert.deepEqual(second.result.a, { ran: 2 })
})
