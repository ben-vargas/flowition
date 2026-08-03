// W2 — engine transcript/mail change-set (DESIGN §8: E8, E9, E10, E12, E14, E16).
//
// The through-line is §11.2's "id joins hold across event/journal/transcript": a
// steering message is written to three files by three different code paths, and a
// viewer can only render one steering history if all three carry the SAME id. Every
// mail test below asserts that join, not just field presence.
//
// E11 lives in test/protocols-ids.test.js (parser-level); E1–E7/E15 in
// test/engine-events.test.js. E12/E14/E16 land here rather than in the W1 suite
// because they are engine-log and CLI surfaces this unit owns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// short prefix: run-dir control.sock paths must stay under the ~104-byte sun_path cap
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ml-'))
process.env.FLOWITION_HOME = HOME

const { runWorkflow } = await import('../src/engine.js')
const { controlRequest } = await import('../src/control.js')
const { AgentJob } = await import('../src/agent-proc.js')
const { Journal, wfMailKey } = await import('../src/journal.js')
const { Transcript } = await import('../src/transcript.js')
const { main } = await import('../src/cli.js')
const { runDir, runsDir, readJsonl, ensureDir } = await import('../src/util.js')

const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ml-wf-'))
let wfSeq = 0
const writeWf = (src) => {
  const file = path.join(wfDir, `wf${wfSeq++}.workflow.mjs`)
  fs.writeFileSync(file, src)
  return file
}
const eventsOf = (runId) => readJsonl(path.join(runDir(runId), 'events.jsonl'))
const journalOf = (runId) => readJsonl(path.join(runDir(runId), 'journal.jsonl'))
const scriptOf = (runId, index) => readJsonl(path.join(runDir(runId), 'agents', `${index}.jsonl`))
const sockOf = (runId) => path.join(runDir(runId), 'control.sock')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

// The one assertion this whole suite exists for: one message, three files, one id.
function assertMailJoin(runId, { index, text, origin }) {
  const mailEv = eventsOf(runId).find((e) => e.type === 'mail' && e.dir === 'in' && e.message === text)
  assert.ok(mailEv, `no mail event for ${JSON.stringify(text)}`)
  assert.match(String(mailEv.mailId), UUID, 'the mail event carries the journal uuid')
  assert.ok(mailEv.delivery, 'the mail event carries the delivery verdict')

  const steered = eventsOf(runId).find((e) => e.type === 'agent' && e.state === 'steered' && e.mailId === mailEv.mailId)
  assert.ok(steered, 'a steered agent event shares the id')
  assert.equal(steered.index, index)
  assert.equal(steered.delivery, mailEv.delivery)
  // the §11.2 matrix fields — the control socket and sendTo() both emit outside the
  // target agent's ALS context, so these come from the admission-time capture
  for (const f of ['index', 'label', 'adapter', 'delivery', 'phase', 'phaseIndex', 'mailId']) {
    assert.ok(f in steered, `steered event is missing "${f}"`)
  }

  const rec = journalOf(runId).find((e) => e.type === 'mail' && e.id === mailEv.mailId)
  assert.ok(rec, 'the journal record shares the id')
  assert.equal(rec.text, text)
  assert.equal(rec.origin, origin)

  const mailIn = scriptOf(runId, index).find((r) => r.kind === 'mail-in' && r.id === mailEv.mailId)
  assert.ok(mailIn, 'the transcript record shares the id')
  assert.equal(mailIn.text, text)
  return { mailEv, steered, rec }
}

// ── E8: operator mail + agent→orchestrator post ──────────────────────────────

const WF_WAIT = `export const meta = { name: 'waiter', description: 'operator mail correlation' }
export default async function ({ agent, phase }) {
  phase('steering')
  return agent('WAIT_MAIL', { adapter: 'mock', label: 'waiter' })
}
`

test('E8: an operator steer joins event↔journal↔transcript by one id, and `post` writes the mail-out kind', async () => {
  const runId = 'flo_ml_operator'
  const p = runWorkflow({ file: writeWf(WF_WAIT), defaults: { adapter: 'mock' }, runId, quiet: true })
  await until(() => eventsOf(runId).find((e) => e.type === 'agent' && e.state === 'running'))

  // G14: `post` is how an agent reports upward. The index arrives over the wire as a
  // STRING (the CLI's FLOWITION_AGENT_INDEX default), which used to land in the event
  // verbatim — a MailView.agent that joins to no agent.
  assert.ok((await controlRequest(sockOf(runId), { cmd: 'post', agent: '0', message: 'halfway there' })).ok)
  const sent = await controlRequest(sockOf(runId), { cmd: 'send', agent: 'waiter', message: 'use the other file' })
  assert.equal(sent.delivery, 'live')

  const out = await p
  assert.equal(out.result, 'mail:use the other file')

  const { steered } = assertMailJoin(runId, { index: 0, text: 'use the other file', origin: 'operator' })
  assert.equal(steered.phase, 'steering')      // captured at admission, not at send time
  assert.equal(steered.phaseIndex, 0)
  assert.equal(steered.label, 'waiter')

  // the post: a string index is coerced to a real integer, and the transcript finally
  // shows the report the transcript header has documented since day one
  const post = eventsOf(runId).find((e) => e.type === 'mail' && e.dir === 'out')
  assert.equal(post.agent, 0)
  assert.equal(typeof post.agent, 'number')
  assert.equal(post.message, 'halfway there')
  const mailOut = scriptOf(runId, 0).filter((r) => r.kind === 'mail-out')
  assert.deepEqual(mailOut.map((r) => r.text), ['halfway there'])
  // and it is ordered against the rest of the conversation, not stranded in events.jsonl
  const kinds = scriptOf(runId, 0).map((r) => r.kind)
  assert.ok(kinds.indexOf('mail-out') < kinds.indexOf('mail-in'), kinds.join(','))
})

test('E8: a post naming no live agent still reaches the event stream, with a null index', async () => {
  const runId = 'flo_ml_post_null'
  const p = runWorkflow({ file: writeWf(WF_WAIT), defaults: { adapter: 'mock' }, runId, quiet: true })
  await until(() => eventsOf(runId).find((e) => e.type === 'agent' && e.state === 'running'))
  for (const agent of [undefined, 'not-a-number', 1.5, 99]) {
    assert.ok((await controlRequest(sockOf(runId), { cmd: 'post', agent, message: `m-${agent}` })).ok)
  }
  await controlRequest(sockOf(runId), { cmd: 'send', agent: 0, message: 'go' })
  await p

  const posts = eventsOf(runId).filter((e) => e.type === 'mail' && e.dir === 'out')
  assert.deepEqual(posts.map((e) => e.agent), [null, null, null, 99])
  // index 99 is a legal integer but not a live agent — no transcript to write to, and
  // no crash for asking
  assert.equal(scriptOf(runId, 0).filter((r) => r.kind === 'mail-out').length, 0)
})

// ── E8: workflow-origin steering (sendTo + the spawn handle) ─────────────────

const WF_WFMAIL = `export const meta = { name: 'wfmail', description: 'workflow steering correlation' }
export default async function ({ spawn, sendTo }) {
  // queued BEFORE the job exists — flushed by the engine's onJob hook on admission
  const h = spawn('WAIT_MAIL', { adapter: 'mock', label: 'handled' })
  h.send('from the handle')
  const t = spawn('WAIT_MAIL', { adapter: 'mock', label: 'targeted' })
  for (let i = 0; i < 400; i++) {
    if (sendTo('targeted', 'from sendTo') !== false) break
    await new Promise((r) => setTimeout(r, 10))
  }
  return [await h.done, await t.done]
}
`

test('E8: workflow-origin steers emit the same steered/mail pair as operator ones, and keep their replay identity', async () => {
  const runId = 'flo_ml_workflow'
  const out = await runWorkflow({ file: writeWf(WF_WFMAIL), defaults: { adapter: 'mock' }, runId, quiet: true })
  assert.equal(out.status, 'completed')
  assert.deepEqual(out.result, ['mail:from the handle', 'mail:from sendTo'])

  const evs = eventsOf(runId)
  const indexOf = (label) => evs.find((e) => e.type === 'agent' && e.label === label && e.state === 'running').index
  const handle = assertMailJoin(runId, { index: indexOf('handled'), text: 'from the handle', origin: 'workflow' })
  const target = assertMailJoin(runId, { index: indexOf('targeted'), text: 'from sendTo', origin: 'workflow' })
  assert.notEqual(handle.mailEv.mailId, target.mailEv.mailId)

  // the out-param must not have disturbed send()'s replay identity: sender branch,
  // call site and per-(sender,callsite) ordinal are still journaled
  for (const { rec } of [handle, target]) {
    assert.equal(rec.seq, 1)
    assert.match(String(rec.sender), /^[0-9a-f]{64}$/)
    assert.match(String(rec.callsite), /wf\d+\.workflow\.mjs:\d+:\d+$/)
  }
  assert.notEqual(handle.rec.callsite, target.rec.callsite, 'each call site is its own replay identity')
})

// ── E8: the out-param never changes a decision ──────────────────────────────

function bareJob(dir, over = {}) {
  return new AgentJob({
    adapter: { name: 'mock', protocol: 'direct', caps: { steer: 'turn', resume: true, schema: 'prompt', selfSession: false } },
    spec: {}, prompt: 'p', index: 0, key: 'k', label: null, runId: 'r',
    scratch: dir, transcript: new Transcript(dir, 0), journal: new Journal(dir),
    ...over,
  })
}

test('E8: a send that journals nothing reports no id — suppression and drops are untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ml-out-'))

  // (1) settled agent: dropped, no journal record, no id
  const settled = bareJob(dir)
  settled.settled = true
  const dropOut = {}
  assert.equal(settled.send('too late', 'operator', null, null, dropOut), 'dropped')
  assert.equal(dropOut.mailId, undefined)
  assert.equal(readJsonl(settled.journal.file).filter((e) => e.type === 'mail').length, 0)

  // (2) crash-window replay suppression: the continued session already has this
  // message. The out-param must not tempt anything into journaling it anyway.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ml-out2-'))
  const delivered = new Map([[wfMailKey('already sent', 1, 'branch-x', 'f.js:1:1'), 1]])
  const job = bareJob(dir2, { deliveredWorkflowMail: delivered })
  const replayOut = {}
  assert.equal(job.send('already sent', 'workflow', 'branch-x', 'f.js:1:1', replayOut), 'replayed')
  assert.equal(replayOut.mailId, undefined)
  assert.equal(readJsonl(job.journal.file).filter((e) => e.type === 'mail').length, 0)

  // (3) the same job's NEXT send is a genuine one and does get an id — proving the
  // suppression above was the ordinal machinery, not a broken send path
  const liveOut = {}
  assert.equal(job.send('already sent', 'workflow', 'branch-x', 'f.js:1:1', liveOut), 'queued')
  assert.match(String(liveOut.mailId), UUID)
  const recs = readJsonl(job.journal.file).filter((e) => e.type === 'mail')
  assert.deepEqual(recs.map((e) => e.id), [liveOut.mailId])
  assert.equal(recs[0].seq, 2)

  // and send() still works with no out-param at all (every legacy call site)
  assert.equal(job.send('plain', 'operator'), 'queued')
})

// ── E9: attempt records ─────────────────────────────────────────────────────

const WF_FLAKY = `export const meta = { name: 'attempts', description: 'attempt records' }
export default async function ({ agent }) {
  return agent('FAILN w2attempts 1\\nECHO recovered', { adapter: 'mock', label: 'flaky' })
}
`

test('E9: a resumed index opens a machine-readable attempt record, and meta numbers every attempt', async () => {
  const file = writeWf(WF_FLAKY)
  const first = await runWorkflow({ file, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(first.status, 'failed')
  const runId = first.runId

  // attempt 1: no boundary record — there is nothing before it to delimit
  const one = scriptOf(runId, 0)
  assert.equal(one.filter((r) => r.kind === 'attempt').length, 0)
  assert.deepEqual(one.filter((r) => r.kind === 'meta').map((r) => r.attempt), [1])

  const second = await runWorkflow({ file, defaults: { adapter: 'mock' }, resumeId: runId, quiet: true })
  assert.equal(second.status, 'completed')

  const recs = scriptOf(runId, 0)
  const attempts = recs.filter((r) => r.kind === 'attempt')
  assert.deepEqual(attempts.map((r) => r.n), [2])
  assert.deepEqual(recs.filter((r) => r.kind === 'meta').map((r) => r.attempt), [1, 2])

  // the record OPENS the segment: it precedes both the English sentinel (kept for old
  // CLIs tailing the file) and the new attempt's meta, so splitting on either the
  // record or the legacy string yields the same segments
  const kinds = recs.map((r) => r.kind)
  const at = kinds.indexOf('attempt')
  const sentinel = recs.findIndex((r) => r.kind === 'status' && r.text === '— resumed run: new attempt below —')
  assert.ok(at > 0 && at < sentinel, `attempt at ${at}, sentinel at ${sentinel}`)
  assert.ok(sentinel < recs.map((r) => r.kind).lastIndexOf('meta'))
  // ...and everything from attempt 1 is still on disk above it
  assert.ok(recs.slice(0, at).some((r) => r.kind === 'status' && /^failed:/.test(r.text ?? '')))

  // n comes from the journal's result-record history, which `results` (last-wins) hides
  const prior = Journal.load(runDir(runId))
  const key = journalOf(runId).find((e) => e.type === 'started').key
  assert.equal(prior.attemptCounts.get(key), 2)
  assert.equal(prior.attemptCounts.get('never-seen'), undefined)
})

// ── E10: the prompt cap is honest ───────────────────────────────────────────

test('E10: an over-long prompt is capped at 32 KiB with an explicit marker, not silently sliced', async () => {
  const big = 'ECHO capped\n' + 'x'.repeat(40_000)
  const file = writeWf(`export const meta = { name: 'bigprompt', description: 'prompt cap' }
const BIG = 'ECHO capped\\n' + 'x'.repeat(40000)
export default async function ({ agent }) {
  await agent(BIG, { adapter: 'mock', label: 'big' })
  return agent('ECHO small', { adapter: 'mock', label: 'small' })
}
`)
  const out = await runWorkflow({ file, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')

  const meta = scriptOf(out.runId, 0).find((r) => r.kind === 'meta')
  const dropped = big.length - 32768
  assert.equal(meta.prompt, big.slice(0, 32768) + `… [+${dropped} chars]`)
  assert.equal(meta.prompt.endsWith(`… [+${dropped} chars]`), true)
  // the old cap was a silent 4,000-char slice: a truncated prompt read as a short one
  assert.ok(meta.prompt.length > 4000)
  assert.match(meta.prompt, /… \[\+\d+ chars\]$/)

  // a prompt under the cap is byte-for-byte verbatim — no marker, no surprise
  const small = scriptOf(out.runId, 1).find((r) => r.kind === 'meta')
  assert.equal(small.prompt, 'ECHO small')
})

// ── E12: engine logs are structured; workflow logs stay bare ────────────────

const WF_LOGS = `export const meta = { name: 'logs', description: 'log structure' }
export default async function ({ spawn, log }) {
  log('workflow speaking')
  const h = spawn('ECHO hi', { adapter: 'mock', label: 'h' })
  h.send('never lands on a resumed cache hit')
  return h.done
}
`

test('E12: engine log sites carry source/level (and index where agent-scoped); workflow log() stays bare', async () => {
  const file = writeWf(WF_LOGS)
  const first = await runWorkflow({ file, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(first.status, 'completed')

  // a workflow's own log is deliberately unstructured — readers fold it as workflow/info
  const wfLog = eventsOf(first.runId).find((e) => e.type === 'log' && e.message === 'workflow speaking')
  assert.equal(wfLog.source, undefined)
  assert.equal(wfLog.level, undefined)

  // resume: the agent replays from cache, so the handle's queued send can never
  // deliver — the engine says so, and now says WHO said it
  const again = await runWorkflow({ file, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(again.status, 'completed')
  const drop = eventsOf(first.runId).find((e) => e.type === 'log' && /queued message\(s\) dropped/.test(e.message))
  assert.deepEqual([drop.source, drop.level], ['engine', 'warn'])
})

const WF_SLOW = `export const meta = { name: 'slowlog', description: 'abort log' }
export default async function ({ agent }) {
  return agent('SLEEP 8000\\nECHO never', { adapter: 'mock', label: 'slow' })
}
`

test('E12: the abort log is engine/warn — distinguishable from anything the workflow printed', async () => {
  const runId = 'flo_ml_abortlog'
  const p = runWorkflow({ file: writeWf(WF_SLOW), defaults: { adapter: 'mock' }, runId, quiet: true })
  await until(() => eventsOf(runId).find((e) => e.type === 'agent' && e.state === 'running'))
  await controlRequest(sockOf(runId), { cmd: 'cancel' })
  const out = await p
  assert.equal(out.status, 'interrupted')

  const log = eventsOf(runId).find((e) => e.type === 'log' && /^aborting run:/.test(e.message))
  assert.deepEqual([log.source, log.level], ['engine', 'warn'])
  assert.match(log.message, /cancel requested via control socket/)
  assert.equal('index' in log, false, 'a run-scoped log must not claim an agent')
})

test('E12: the journal-repair log is engine/warn and run-scoped', async () => {
  const file = writeWf(`export const meta = { name: 'repairlog' }
export default async ({ agent }) => agent('ECHO one', { adapter: 'mock' })
`)
  const first = await runWorkflow({ file, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(first.status, 'completed')
  // a crash mid-append leaves a half-written final line; the resume repairs it and
  // must SAY SO as the engine, not as the workflow — a viewer lanes them differently
  fs.appendFileSync(path.join(runDir(first.runId), 'journal.jsonl'), '{"type":"result","key":"torn-part')
  const again = await runWorkflow({ file, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(again.status, 'completed')

  const repair = eventsOf(first.runId).find((e) => e.type === 'log' && /torn final record/.test(e.message))
  assert.ok(repair, 'the repair is announced')
  assert.equal(repair.source, 'engine')
  assert.equal(repair.level, 'warn')
  // the repair is a property of the JOURNAL, not of any one agent
  assert.equal('index' in repair, false)
})

test('E12: the retry log is engine/warn and carries the agent index', async () => {
  // FAILRETRY throws a RETRYABLE error on the first execute, so the engine re-runs the
  // same job in place (the retry branch) — the one E12 site that is agent-scoped and
  // reachable only from a failed-then-recovered attempt.
  const file = writeWf(`export const meta = { name: 'retrylog' }
export default async ({ agent }) => {
  await agent('ECHO first', { adapter: 'mock', label: 'a0' })
  return agent('FAILRETRY rl1 1', { adapter: 'mock', label: 'a1' })
}
`)
  const out = await runWorkflow({ file, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed', 'the retry succeeded, so the agent never fails')
  assert.equal(out.result, 'recovered:rl1:2', 'the SECOND execute produced the result')

  const retry = eventsOf(out.runId).find((e) => e.type === 'log' && /retrying after/.test(e.message))
  assert.ok(retry, 'the swallowed first attempt surfaces as a log')
  assert.equal(retry.source, 'engine')
  assert.equal(retry.level, 'warn')
  assert.equal(retry.index, 1, 'the SECOND agent retried — not index 0, and not absent')
  assert.match(retry.message, /mock retryable failure 1\/1/)
  // and the retry is invisible in the outcome: one completed result record, no failure
  const results = journalOf(out.runId).filter((e) => e.type === 'result')
  assert.deepEqual(results.map((e) => e.status), ['completed', 'completed'])
})

// ── E14 / E16: the CLI surfaces ─────────────────────────────────────────────

// console.error writes through process.stderr.write, so one stub captures both the
// engine's event printer and the CLI's own lines.
async function cli(argv) {
  const outLines = []
  const errChunks = []
  const origLog = console.log
  const origWrite = process.stderr.write
  console.log = (...a) => { outLines.push(a.map(String).join(' ')) }
  process.stderr.write = (c) => { errChunks.push(String(c)); return true }
  let code
  try { code = await main(argv) } finally {
    console.log = origLog
    process.stderr.write = origWrite
  }
  return { code, stdout: outLines.join('\n'), stderr: errChunks.join('') }
}

const WF_TINY = `export const meta = { name: 'tiny', description: 'cli surface' }
export default async function ({ agent }) {
  return agent('ECHO tiny', { adapter: 'mock', label: 't' })
}
`

test('E16: the foreground CLI allocates and prints the run id before the run starts', async () => {
  const file = writeWf(WF_TINY)
  const fresh = await cli(['run', file, '--adapter', 'mock'])
  assert.equal(fresh.code, 0)
  const printed = fresh.stderr.match(/^run (\S+)$/m)
  assert.ok(printed, `no run-id line in stderr:\n${fresh.stderr}`)
  assert.match(printed[1], /^flo_[0-9a-f]{8}$/)
  // ...and it is the id the run actually used — the property §4.3's deep link needs
  assert.match(fresh.stdout, new RegExp(`^\\nrun ${printed[1]}: completed$`, 'm'))
  assert.ok(fs.existsSync(path.join(runDir(printed[1]), 'result.json')))
  // the announcement precedes the engine's own run event, so a slow preflight cannot
  // delay the deep link
  assert.ok(fresh.stderr.indexOf(`run ${printed[1]}`) < fresh.stderr.indexOf('▶ run'))

  // an explicit --run-id is honoured verbatim, not replaced by a fresh one
  const named = await cli(['run', file, '--adapter', 'mock', '--run-id', 'w2-named-run'])
  assert.equal(named.code, 0)
  assert.match(named.stderr, /^run w2-named-run$/m)
  assert.match(named.stdout, /^\nrun w2-named-run: completed$/m)

  // --json stays machine-clean: nothing extra on stdout, no id line at all
  const json = await cli(['run', file, '--adapter', 'mock', '--run-id', 'w2-json-run', '--json'])
  assert.equal(json.code, 0)
  assert.equal(JSON.parse(json.stdout.trim()).runId, 'w2-json-run')
  assert.equal(/^run w2-json-run$/m.test(json.stderr), false)
})

test('E14: `flowition runs` lists every run dir — custom --run-id runs and bare dirs included', async () => {
  // a run whose id the operator chose (invisible under the old flo_ prefix filter)
  await runWorkflow({ file: writeWf(WF_TINY), defaults: { adapter: 'mock' }, runId: 'w2-audit-2026', quiet: true })
  // the state detachRun leaves between ensureDir and the child's first append
  ensureDir(runDir('w2-bare-dir'), 0o700)
  // ...and things that are NOT runs
  fs.writeFileSync(path.join(runsDir(), 'stray-file'), 'x')
  ensureDir(path.join(runsDir(), '.hidden-dir'), 0o700)

  const listed = await cli(['runs', '--json'])
  assert.equal(listed.code, 0)
  const rows = JSON.parse(listed.stdout.trim())
  const byId = new Map(rows.map((r) => [r.runId, r]))

  assert.ok(byId.has('w2-audit-2026'), 'a custom --run-id run is a run')
  assert.equal(byId.get('w2-audit-2026').state, 'completed')
  assert.equal(byId.get('w2-audit-2026').file, path.basename(byId.get('w2-audit-2026').file))
  assert.ok(byId.has('w2-bare-dir'), 'a run in its startup window is a run')
  assert.equal(byId.get('w2-bare-dir').state, 'unknown')
  assert.equal(byId.get('w2-bare-dir').createdAt, 0)
  assert.ok(byId.has('flo_ml_operator'), 'and the prefixed ids still list')

  // runDir()-invalid names and non-directories are not runs
  assert.equal(byId.has('stray-file'), false)
  assert.equal(byId.has('.hidden-dir'), false)

  // the human rendering survives a meta-less row
  const human = await cli(['runs'])
  assert.match(human.stdout, /^w2-bare-dir\s+unknown\s+\?/m)
})

test('E14: MCP flowition_runs uses the same unfiltered listing', async () => {
  const bin = fileURLToPath(new URL('../bin/flowition.js', import.meta.url))
  const child = spawn(process.execPath, [bin, 'mcp'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, FLOWITION_HOME: HOME },
  })
  try {
    let buf = ''
    const lines = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) lines.push(JSON.parse(line))
      }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'flowition_runs', arguments: {} } }) + '\n')
    const res = await until(() => lines.find((l) => l.id === 1), 15000)
    const rows = JSON.parse(res.result.content[0].text)
    const ids = new Set(rows.map((r) => r.runId))
    assert.ok(ids.has('w2-audit-2026'))
    assert.ok(ids.has('w2-bare-dir'))
    assert.ok(ids.has('flo_ml_operator'))
    assert.equal(ids.has('stray-file'), false)
    assert.equal(ids.has('.hidden-dir'), false)
    // a bare dir resolves rather than throwing the whole listing
    assert.equal(rows.find((r) => r.runId === 'w2-bare-dir').state, 'unknown')
  } finally {
    child.kill()
  }
})
