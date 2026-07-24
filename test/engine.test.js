import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.FLOWITION_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-test-'))

const { runWorkflow } = await import('../src/engine.js')
const { controlRequest } = await import('../src/control.js')
const { runDir, readJsonl } = await import('../src/util.js')

const fx = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name)
const sockOf = (runId) => path.join(runDir(runId), 'control.sock')

async function until(fn, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    let v = null
    try { v = await fn() } catch { /* not ready */ }
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('until(): timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('basic: agent/parallel/pipeline/phase/log with deterministic toolkit', async () => {
  const out = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 1 }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result.single, 'hello')
  assert.deepEqual(out.result.par, ['p1', 'p2', 'p3'])
  assert.deepEqual(out.result.piped, ['s2-s1-a-a', 's2-s1-b-b'])
  assert.deepEqual(out.result.args, { x: 1 })
  assert.ok(out.result.tOk && out.result.rOk)
  // journal has meta + started/result entries
  const journal = readJsonl(path.join(runDir(out.runId), 'journal.jsonl'))
  assert.ok(journal.some((e) => e.type === 'meta'))
  assert.equal(journal.filter((e) => e.type === 'result' && e.status === 'completed').length, 8)

  // resuming the completed run replays every agent from the journal
  const again = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 1 }, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.deepEqual(again.result, out.result)
  const events = readJsonl(path.join(runDir(out.runId), 'events.jsonl'))
  assert.equal(events.filter((e) => e.type === 'agent' && e.state === 'cached').length, 8)
})

test('resume: completed agents replay, failed agent re-runs and recovers', async () => {
  const first = await runWorkflow({ file: fx('resume.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(first.status, 'failed')
  const second = await runWorkflow({ file: fx('resume.workflow.js'), defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(second.status, 'completed')
  // acounter stayed at 1 → the first agent was replayed, not re-executed
  assert.equal(second.result.a, 'recovered:acounter:1')
  assert.equal(second.result.b, 'recovered:bcounter:2')
})

test('resume: refuses when the workflow file changed', async () => {
  const first = await runWorkflow({ file: fx('resume.workflow.js'), defaults: { adapter: 'mock' }, quiet: true }).catch(() => null)
  const copy = fx('resume.workflow.js') + '.tmp.js'
  fs.copyFileSync(fx('resume.workflow.js'), copy)
  fs.appendFileSync(copy, '\n// changed\n')
  await assert.rejects(
    runWorkflow({ file: copy, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true }),
    /file has changed/,
  )
  fs.unlinkSync(copy)
})

test('steering: operator message reaches a live agent via the control socket', async () => {
  const p = runWorkflow({ file: fx('steer.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  const runId = await until(async () => {
    const ids = fs.readdirSync(path.join(process.env.FLOWITION_HOME, 'runs')).filter((d) => fs.existsSync(sockOf(d)))
    for (const id of ids) {
      const st = await controlRequest(sockOf(id), { cmd: 'status' }).catch(() => null)
      if (st?.ok && st.agents.some((a) => a.label === 'steerme')) return id
    }
    return null
  })
  const res = await controlRequest(sockOf(runId), { cmd: 'send', agent: 'steerme', message: 'hi-there' })
  assert.ok(res.ok)
  const out = await p
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'mail:hi-there')
})

test('steering: workflow code steers its own spawned agent', async () => {
  const out = await runWorkflow({ file: fx('self-steer.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'mail:from-workflow')
})

test('ask(): workflow blocks on an operator answer; answer replays on resume', async () => {
  const p = runWorkflow({ file: fx('ask.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  const runId = await until(async () => {
    const ids = fs.readdirSync(path.join(process.env.FLOWITION_HOME, 'runs')).filter((d) => fs.existsSync(sockOf(d)))
    for (const id of ids) {
      const st = await controlRequest(sockOf(id), { cmd: 'status' }).catch(() => null)
      if (st?.ok && st.questions.some((q) => q.qid === 'color')) return id
    }
    return null
  })
  const res = await controlRequest(sockOf(runId), { cmd: 'answer', qid: 'color', value: 'blue' })
  assert.ok(res.ok)
  const out = await p
  assert.equal(out.result, 'answer:blue')
  // resume: the journaled answer replays — completes without waiting
  const again = await runWorkflow({ file: fx('ask.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'answer:blue')
})

test('schema: invalid JSON triggers one corrective follow-up turn', async () => {
  const out = await runWorkflow({ file: fx('schema.workflow.js'), args: { counter: 'sr-' + Date.now() }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.deepEqual(out.result, { ok: true })
})

test('cancel: control-socket cancel interrupts the run', async () => {
  const p = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  const runId = await until(async () => {
    const ids = fs.readdirSync(path.join(process.env.FLOWITION_HOME, 'runs')).filter((d) => fs.existsSync(sockOf(d)))
    for (const id of ids) {
      const st = await controlRequest(sockOf(id), { cmd: 'status' }).catch(() => null)
      if (st?.ok && st.agents.some((a) => a.label === 'sleeper')) return id
    }
    return null
  })
  const res = await controlRequest(sockOf(runId), { cmd: 'cancel' })
  assert.ok(res.ok)
  const out = await p
  assert.equal(out.status, 'interrupted')
})
