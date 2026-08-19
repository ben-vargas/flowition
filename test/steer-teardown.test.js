// Issue #3: a live mid-turn steer must not deadlock teardown. The claude CLI
// emits ONE `result` per TURN — a user message injected mid-turn is coalesced
// into the running turn and never gets a result of its own — so per-message
// outstanding accounting left stdin open forever after a consumed steer while
// the CLI (correctly) waited for EOF. These tests drive the REAL AgentJob
// process-turn machinery against scripted fake CLIs (test/fixtures/fake-claude.js,
// test/fixtures/fake-amp.js) that reproduce the empirically verified stream
// behaviors — no real agent CLI, no API keys.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentJob } from '../src/agent-proc.js'
import { getAdapter } from '../src/adapters/index.js'

const fx = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name)
process.env.FLOWITION_CLAUDE_BIN = fx('fake-claude.js')

const SHIP = { type: 'object', properties: { ship: { type: 'boolean' } }, required: ['ship'] }
const HUNG = Symbol('hung')

const settle = (p) => p.then((r) => ({ ok: r }), (err) => ({ err }))
const within = (p, ms) => Promise.race([p, new Promise((resolve) => {
  const t = setTimeout(() => resolve(HUNG), ms)
  t.unref?.()
})])

async function until(fn, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    let v = null
    try { v = await fn() } catch { /* not ready */ }
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('until(): timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// The fake CLIs read their scenario from FAKE_* env vars (inherited via spawn)
async function withKnobs(vars, fn) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = String(v)
  try { return await fn() } finally { for (const k of Object.keys(vars)) delete process.env[k] }
}

const mkJob = ({ spec = {}, adapter = getAdapter('claude') } = {}) => {
  const transcript = []
  const journal = []
  const job = new AgentJob({
    adapter, spec, prompt: 'review the branch', index: 0, key: 'k0', label: 'steer-teardown',
    runId: 'flo_steertest', scratch: os.tmpdir(),
    transcript: { write: (kind, data) => transcript.push({ kind, ...data }) },
    journal: { append: (e) => journal.push(e) },
    priorSessionId: null, pendingMail: [], controlSock: '', binPath: '',
  })
  return { job, transcript, journal }
}

// Await execute() with a hang guard: a regression here manifests as a promise
// that never settles with a live child underneath — kill it so the suite fails
// loudly instead of leaking a process past the test.
async function finish(job, done, ms = 15000) {
  const r = await within(done, ms)
  if (r === HUNG) { job.cancel(); await done }
  return r
}

test('claude: schema turn with no steer completes and closes down cleanly', { timeout: 30_000 }, () =>
  withKnobs({ FAKE_TURN_MS: 200 }, async () => {
    const { job, journal } = mkJob({ spec: { schema: SHIP } })
    const done = settle(job.execute())
    const r = await finish(job, done)
    assert.notEqual(r, HUNG, 'execute() hung on an unsteered schema turn')
    assert.ok(r.ok, r.err?.message)
    assert.deepEqual(r.ok.structured, { ship: true })
    assert.equal(journal.find((e) => e.type === 'session')?.sessionId, 'fake-session-1')
  }))

test('claude: a live steer consumed mid-turn ends with ONE terminal result — no teardown hang (issue #3)', { timeout: 30_000 }, () =>
  withKnobs({ FAKE_TURN_MS: 2000 }, async () => {
    const { job, transcript, journal } = mkJob({ spec: { schema: SHIP } })
    const done = settle(job.execute())
    await until(() => journal.some((e) => e.type === 'session'))
    const child = job.child
    assert.equal(job.send('operator note: perf thresholds are flaky'), 'live')
    const r = await finish(job, done)
    assert.notEqual(r, HUNG, 'execute() hung after its terminal result — stdin never closed on the coalesced steer (issue #3)')
    assert.ok(r.ok, r.err?.message)
    assert.deepEqual(r.ok.structured, { ship: true })
    // the single result came from the turn that consumed the steer, with no
    // follow-up turn spun up to chase a second result that will never come
    assert.match(r.ok.text, /^turn:1 resumed:false steers:1/)
    assert.ok(!transcript.some((e) => e.kind === 'status' && /follow-up turn/.test(e.text)))
    // the steer is delivered, not dropped or stranded
    const mail = journal.find((e) => e.type === 'mail')
    assert.ok(journal.some((e) => e.type === 'mail-done' && e.id === mail.id && !e.dropped))
    // the child exited (stdin EOF reached it) and was reaped
    await until(() => child.exitCode != null || child.signalCode != null)
    assert.equal(job.child, null)
  }))

test('claude: a steer landing after the terminal result queues and rides a --resume follow-up turn', { timeout: 30_000 }, () =>
  withKnobs({ FAKE_TURN_MS: 100, FAKE_LINGER_MS: 1500 }, async () => {
    const { job, transcript, journal } = mkJob()
    const done = settle(job.execute())
    // the result parse closes stdin while the fake lingers before exiting —
    // exactly the post-result window a late steer can land in
    await until(() => job.child && job.child.stdin.writableEnded)
    assert.equal(job.send('late-steer'), 'queued')
    const r = await finish(job, done)
    assert.notEqual(r, HUNG, 'execute() hung delivering a post-result steer')
    assert.ok(r.ok, r.err?.message)
    // the follow-up turn resumed the session and carried the queued message
    assert.match(r.ok.text, /resumed:true/)
    assert.match(r.ok.text, /late-steer/)
    assert.ok(transcript.some((e) => e.kind === 'status' && /delivering 1 queued message/.test(e.text)))
    const mail = journal.find((e) => e.type === 'mail')
    assert.ok(journal.some((e) => e.type === 'mail-done' && e.id === mail.id && !e.dropped))
  }))

// PR #5 review (Codex bot P1 on src/agent-proc.js:436): a steer accepted AFTER
// the child generated its terminal result but BEFORE the parent parsed that
// stdout line is counted into liveSeqAtResult, outstanding zeroes, endStdin
// fires, and the success path journals mail-done — the bot read that as a
// silently lost steer. Probed against the real CLI (2026-08-18, claude
// 2.1.235, stream-json in/out): NOT lost — claude drains user messages
// buffered on stdin before EOF, answering each as its own turn with its own
// result, then exits 0 (in-the-wild match: flo_3a015a87 agent 0). The second
// result arrives before 'close' and overwrites turnResult, so the steer's
// answer wins (last-answer-wins, same as amp multi-turn) and mail-done is
// accurate. This test pins that implicit drain-at-EOF CLI contract: if a
// future claude CLI starts DISCARDING buffered input at EOF, update
// fake-claude.js to match — and the engine then needs a real requeue for
// raced steers instead of mail-done. The fake HOLDS the raced message until
// stdin EOF, so passing requires the engine to close stdin promptly on the
// result-1 parse: under the pre-fix per-result accounting outstanding stays
// above zero, endStdin never fires, turn 2 never runs, and the small stallMs
// below bounds that failure to seconds instead of the hang guard.
test('claude: a steer raced past an already-generated terminal result is drained at EOF as its own turn — its result wins (pins CLI drain-at-EOF contract, PR #5 review)', { timeout: 30_000 }, () =>
  withKnobs({ FAKE_TURN_MS: 200, FAKE_RACE_STEER: 1 }, async () => {
    const { job, transcript, journal } = mkJob({ spec: { stallMs: 3000 } })
    const done = settle(job.execute())
    await until(() => journal.some((e) => e.type === 'session'))
    const child = job.child
    // accepted live before result 1 is parsed: liveSeq counts it, result 1
    // (generated without it) snapshots liveSeqAtResult, outstanding zeroes,
    // endStdin fires — exactly the window the review flagged
    assert.equal(job.send('raced steer'), 'live')
    const r = await finish(job, done)
    assert.notEqual(r, HUNG, 'execute() hung draining a raced steer at EOF')
    assert.ok(r.ok, r.err?.message)
    // result 1 reached the transcript WITHOUT reflecting the steer (steers:0,
    // the original prompt), and BOTH results were parsed (one usage-cum
    // journal record each) — the pin requires a result that did not reflect
    // the message followed by one that did, not any single steer-reflecting
    // result
    assert.ok(transcript.some((e) => e.kind === 'text' && /^turn:1 resumed:false steers:0 msg:review the branch/.test(e.text)))
    assert.equal(journal.filter((e) => e.type === 'usage-cum').length, 2)
    // the FINAL answer is turn 2's — the drained steer's own result arrived
    // before 'close' and overwrote result 1, with no follow-up spawn or requeue
    assert.match(r.ok.text, /^turn:2 resumed:false steers:0 msg:raced steer/)
    assert.ok(!transcript.some((e) => e.kind === 'status' && /follow-up turn|requeued/.test(e.text)))
    assert.equal(job.mailQueue.length, 0)
    // the steer's mail is journaled delivered — not dropped, not stranded
    const mail = journal.find((e) => e.type === 'mail')
    assert.ok(journal.some((e) => e.type === 'mail-done' && e.id === mail.id && !e.dropped))
    // the child exited cleanly at EOF and was reaped
    await until(() => child.exitCode != null || child.signalCode != null)
    assert.equal(child.exitCode, 0)
    assert.equal(job.child, null)
  }))

test('claude: true early death with an unanswered injection still refuses as truncated', { timeout: 30_000 }, () =>
  withKnobs({ FAKE_TURN_MS: 2000, FAKE_DIE_MID_TURN: 1 }, async () => {
    const { job, journal } = mkJob({ spec: { schema: SHIP } })
    const done = settle(job.execute())
    await until(() => journal.some((e) => e.type === 'session'))
    assert.equal(job.send('doomed steer'), 'live')
    const r = await finish(job, done)
    assert.notEqual(r, HUNG)
    assert.equal(r.err?.code, 'truncated')
    assert.match(r.err.message, /unanswered/)
    // the failed turn requeued the steer for a future attempt, undelivered
    assert.ok(job.mailQueue.some((m) => m.text === 'doomed steer'))
    assert.ok(!journal.some((e) => e.type === 'mail-done'))
  }))

test('claude: an error result with a consumed steer surfaces provider_error — never a hang, mail requeued', { timeout: 30_000 }, () =>
  withKnobs({ FAKE_TURN_MS: 2000, FAKE_ERROR_RESULT: 1 }, async () => {
    const { job, journal } = mkJob()
    const done = settle(job.execute())
    await until(() => journal.some((e) => e.type === 'session'))
    assert.equal(job.send('steer into failure'), 'live')
    const r = await finish(job, done)
    assert.notEqual(r, HUNG, 'execute() hung on an error result — stdin must close when the turn is over either way')
    assert.equal(r.err?.code, 'provider_error')
    assert.ok(job.mailQueue.some((m) => m.text === 'steer into failure'))
    assert.ok(!journal.some((e) => e.type === 'mail-done'))
  }))

// amp (claude-stream-eof) does NOT share claude's coalescing: a message sent
// without `steer: true` (userMessage never sets it) while the agent is busy is
// queued and run as its OWN turn with its own end_turn, and amp exits only once
// the assistant is done AND stdin is closed (owner's manual appendix) — so the
// per-message turn-end accounting must stay exactly as it is.
const ampUserMessage = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
const mkFakeAmp = (builds) => ({
  name: 'amp',
  protocol: 'claude-stream-eof',
  bin: () => fx('fake-amp.js'),
  caps: { steer: 'live', resume: true, schema: 'prompt', selfSession: false, acceptsModel: true },
  build({ mode, prompt }) {
    builds.push(mode)
    return { argv: [], stdin: ampUserMessage(prompt) + '\n', keepOpen: true, tempFiles: [] }
  },
  userMessage: ampUserMessage,
})

test('amp: a mid-turn message queues as its own turn — per-message accounting closes stdin after the second end_turn', { timeout: 30_000 }, () =>
  withKnobs({ FAKE_TURN_MS: 1500 }, async () => {
    const builds = []
    const { job, journal } = mkJob({ adapter: mkFakeAmp(builds) })
    const done = settle(job.execute())
    await until(() => journal.some((e) => e.type === 'session'))
    assert.equal(job.send('queued steer'), 'live')
    const r = await finish(job, done)
    assert.notEqual(r, HUNG, 'execute() hung on amp turn-per-message accounting')
    assert.ok(r.ok, r.err?.message)
    // the injected message ran as turn 2 in the SAME process; no follow-up spawn
    assert.match(r.ok.text, /^turn:2 steers:0 msg:queued steer/)
    assert.deepEqual(builds, ['fresh'])
    const mail = journal.find((e) => e.type === 'mail')
    assert.ok(journal.some((e) => e.type === 'mail-done' && e.id === mail.id && !e.dropped))
  }))

test('amp: a process that exits with a valid result post-dating an unanswered injection is accepted, message requeued', { timeout: 30_000 }, () =>
  withKnobs({ FAKE_TURN_MS: 1500, FAKE_AMP_COALESCE: 1 }, async () => {
    // hypothetical coalescing regression: the steer is consumed into turn 1
    // (single end_turn) and the process exits after its result — the finished
    // work must stand, with the steer redelivered via a follow-up turn instead
    // of the whole turn being refused as truncated and re-run
    const builds = []
    const { job, transcript, journal } = mkJob({ adapter: mkFakeAmp(builds) })
    const done = settle(job.execute())
    await until(() => journal.some((e) => e.type === 'session'))
    assert.equal(job.send('lost steer'), 'live')
    const r = await finish(job, done)
    assert.notEqual(r, HUNG)
    assert.ok(r.ok, r.err?.message)
    assert.ok(transcript.some((e) => e.kind === 'status' && /result accepted, message\(s\) requeued/.test(e.text)))
    // the follow-up turn resumed the session and redelivered the message
    assert.deepEqual(builds, ['fresh', 'resume'])
    assert.match(r.ok.text, /Message\(s\) from the orchestrator/)
    assert.match(r.ok.text, /lost steer/)
    const mail = journal.find((e) => e.type === 'mail')
    assert.equal(journal.filter((e) => e.type === 'mail-done' && e.id === mail.id && !e.dropped).length, 1)
  }))
