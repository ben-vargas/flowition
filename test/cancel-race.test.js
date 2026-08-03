// H1 — the whole-run cancellation race across the SLEEP→WAIT_MAIL boundary.
//
// `AgentJob.cancel()` drains `mailWaiters` ONCE, synchronously. A direct adapter
// that is asleep at that instant has no waiter registered yet: it registers one on
// the very next tick, into a list nobody will ever drain again. The control socket
// has already returned `{ok:true, cancelled:'run'}` — so the API reported an
// outcome that never happened, and the agent (and therefore the run) stays live
// indefinitely.
//
// These tests drive a real cancel into exactly that window with the real modules
// (engine + control socket + the mock adapter's direct-turn path) and prove the
// agent settles. Every assertion is wrapped in a wall-clock bound: a regression
// here is a HANG, and a hung test that never fails is no test at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Short prefix on purpose: the run's unix control socket lives under this root and
// macOS caps sun_path at 104 bytes — a chatty prefix makes `listen` fail EINVAL.
process.env.FLOWITION_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-h1-'))

const { runWorkflow } = await import('../src/engine.js')
const { controlRequest } = await import('../src/control.js')
const { AgentJob } = await import('../src/agent-proc.js')
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

// Bound the wait so the failure mode is a FAILED test, not a wedged suite.
function withDeadline(promise, ms, what) {
  let timer = null
  const bomb = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still live after ${ms}ms — the cancel was reported successful but never took effect`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, bomb]).finally(() => clearTimeout(timer))
}

async function liveRun(label, file) {
  const p = runWorkflow({ file: fx(file), defaults: { adapter: 'mock' }, quiet: true })
  // swallow late rejections while we poll — the assertions below own the outcome
  p.catch(() => {})
  const runId = await until(async () => {
    const ids = fs.readdirSync(path.join(process.env.FLOWITION_HOME, 'runs')).filter((d) => fs.existsSync(sockOf(d)))
    for (const id of ids) {
      const st = await controlRequest(sockOf(id), { cmd: 'status' }).catch(() => null)
      if (st?.ok && st.agents.some((a) => a.label === label)) return id
    }
    return null
  })
  return { p, runId }
}

// ── AC1: whole-run cancel across the SLEEP→WAIT_MAIL boundary ────────────────

test('cancel race: whole-run cancel during SLEEP settles an agent that registers WAIT_MAIL afterwards', async () => {
  const { p, runId } = await liveRun('sleepwaiter', 'cancel-waitmail.workflow.js')
  // The agent is inside `SLEEP 60000` here: no waiter is registered yet, so
  // cancel()'s drain sweeps an empty list. The adapter reaches WAIT_MAIL on the
  // next 25ms sleep poll — strictly AFTER the drain.
  const res = await controlRequest(sockOf(runId), { cmd: 'cancel' })
  assert.ok(res.ok)
  assert.equal(res.cancelled, 'run')

  const out = await withDeadline(p, 15000, 'run after SLEEP→WAIT_MAIL cancel')
  assert.equal(out.status, 'interrupted')

  // The agent itself settled — not merely the workflow promise.
  const journal = readJsonl(path.join(runDir(runId), 'journal.jsonl'))
  const result = journal.find((e) => e.type === 'result' && e.key)
  assert.ok(result, 'the agent journaled a terminal result record')
  assert.equal(result.status, 'cancelled')
  assert.ok(journal.some((e) => e.type === 'end' && e.status === 'interrupted'), 'run journaled its end record')
  const events = readJsonl(path.join(runDir(runId), 'events.jsonl'))
  assert.ok(events.some((e) => e.type === 'agent' && e.state === 'cancelled' && e.label === 'sleepwaiter'))
})

test('cancel race: per-agent cancel during SLEEP settles an agent that registers WAIT_MAIL afterwards', async () => {
  const { p, runId } = await liveRun('sleepwaiter', 'cancel-waitmail.workflow.js')
  const res = await controlRequest(sockOf(runId), { cmd: 'cancel', agent: 'sleepwaiter' })
  assert.ok(res.ok)

  const out = await withDeadline(p, 15000, 'run after per-agent SLEEP→WAIT_MAIL cancel')
  assert.equal(out.status, 'failed') // a directly-awaited cancelled agent fails the workflow
  const journal = readJsonl(path.join(runDir(runId), 'journal.jsonl'))
  assert.ok(journal.some((e) => e.type === 'result' && e.status === 'cancelled'), 'cancelled result journaled')
})

// ── AC1 (unit level): the waiter list is CLOSED once cancelled ───────────────
// The engine tests above prove the observable behaviour; this pins the mechanism,
// so a future refactor that reintroduces late registration fails loudly here too.

test('cancel race: waitMail registered after cancel() resolves immediately instead of enqueueing', async () => {
  const events = []
  const journal = { append: (r) => events.push(r) }
  const transcript = { write: () => {} }
  let registered = null
  const adapter = {
    name: 'probe',
    caps: { steer: 'live', resume: true, schema: 'prompt', selfSession: false },
    direct: async ({ io }) => {
      // cancel lands while this turn is "asleep" — exactly the mock's SLEEP window
      job.cancel()
      registered = io.waitMail() // registration strictly after the drain
      return { text: 'mail:' + (await registered) }
    },
  }
  const job = new AgentJob({
    adapter, spec: {}, prompt: 'x', index: 0, key: 'k0', label: 'probe',
    runId: 'r', scratch: '/tmp', transcript, journal,
  })
  const err = await withDeadline(job.execute().then(() => null, (e) => e), 5000, 'direct turn after late waitMail')
  assert.ok(err, 'the turn rejected instead of hanging')
  assert.equal(err.code, 'cancelled')
  assert.equal(job.mailWaiters.length, 0, 'no waiter was left parked on the cancelled job')
  assert.equal(await registered, '__cancelled__')
})

test('cancel race: a queued message is not delivered into a cancelled turn', async () => {
  const transcript = { write: () => {} }
  const journal = { append: () => {} }
  let seen = null
  const adapter = {
    name: 'probe',
    caps: { steer: 'live', resume: true, schema: 'prompt', selfSession: false },
    direct: async ({ io }) => {
      job.cancel()
      seen = await io.waitMail()
      return { text: 'done' }
    },
  }
  const job = new AgentJob({
    adapter, spec: {}, prompt: 'x', index: 0, key: 'k0', label: 'probe',
    runId: 'r', scratch: '/tmp', transcript, journal,
    pendingMail: [{ id: 'm1', text: 'steer me' }],
  })
  await withDeadline(job.execute().catch(() => {}), 5000, 'cancelled turn with queued mail')
  assert.equal(seen, '__cancelled__', 'cancellation wins over the pending queue')
  assert.deepEqual(job.mailQueue.map((m) => m.text), ['steer me'], 'the undelivered message stays queued')
})
