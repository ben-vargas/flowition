// W7 — the control bridge and the lifecycle routes (DESIGN §7.2–§7.4, §11.2
// "viewer-control").
//
// The rule this file is written to: **the control side is real**. Every send/answer/
// cancel test drives a genuine `serveControl` listener bound on a genuine unix socket in
// a genuine run directory, answering with the engine's own reply shapes
// (src/engine.js:674–730). A mocked bridge would assert that this file's own fake agrees
// with itself; what has to be true is that the shipped `controlRequest` client, the
// shipped socket server, the shipped HTTP pipeline and the shipped route table compose.
//
// Requests go through node:http rather than fetch for the same reason viewer-http does:
// `Host` and `Origin` are forbidden header names for fetch, and every mutation here has
// to carry both plus the ephemeral control token.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The home is REALPATH'd and its prefix is short, and the ids of socket-bearing runs are
// short too. `sun_path` is 104 bytes on macOS and `<home>/runs/<id>/control.sock` is what
// both the engine and this test bind — and `removeRun` resolves the run through
// `realpathSync`, which on macOS expands `/var` to `/private/var` and silently pushes a
// 97-byte path to 105. The failure mode is a `deriveRunState` that reports `stale` for a
// demonstrably live run, i.e. a delete guard that looks broken when the path is the
// problem. Resolving the base up front removes the expansion; the assertion in `liveRun`
// makes any remaining overrun a clear failure instead of a confusing one.
const HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'flo-ctl-'))
process.env.FLOWITION_HOME = HOME
/** macOS `sun_path`, the tightest of the platforms this runs on. */
const MAX_SOCKET_PATH = 103

const { startViewer } = await import('../src/viewer/index.js')
const { serveControl } = await import('../src/control.js')
const { RESUME_MARKER } = await import('../src/run-lock.js')
const { trashDir } = await import('../src/retention.js')
const { auditPath } = await import('../src/viewer/audit.js')
const {
  CONTROL_TIMEOUT_MS,
  RETRY_AFTER_MS,
  RESUMABLE_STATES,
  SEND_VERDICTS,
  controlCommand,
  controlStatus,
} = await import('../src/viewer/control-bridge.js')
const routes = await import('../src/viewer/routes.js')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RUNS = path.join(HOME, 'runs')
const DIST = path.join(HOME, 'dist')

// ---- harness ------------------------------------------------------------------------

function request(port, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  // content-length explicitly: node's client suppresses chunked framing on methods it
  // considers bodyless (DELETE among them), which would put unframed bytes on the wire.
  const withLength = body == null ? headers : { 'content-length': String(Buffer.byteLength(body)), ...headers }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: withLength }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json })
      })
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

/** Every gate §7.1.5/§7.2 puts in front of a mutation, satisfied. */
const mutate = (v) => ({
  host: `127.0.0.1:${v.port}`,
  authorization: `Bearer ${v.token}`,
  origin: `http://127.0.0.1:${v.port}`,
  'content-type': 'application/json',
  'x-flowition-control': v.controlToken,
})

const post = (v, target, body) => request(v.port, { method: 'POST', path: target, headers: mutate(v), body: JSON.stringify(body ?? {}) })
const del = (v, target) => request(v.port, { method: 'DELETE', path: target, headers: mutate(v), body: '{}' })

/**
 * A run directory that `deriveRunState` and `removeRun` both recognise. `state` picks
 * which artifacts exist, which is what makes the state derivation come out as asked.
 */
function seedRun(runId, { state = 'completed', meta = true, journal = true, events = true } = {}) {
  const dir = path.join(RUNS, runId)
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  if (journal) {
    const lines = []
    if (meta) lines.push(JSON.stringify({ type: 'meta', runId, workflowFile: path.join(ROOT, 'test', 'fixtures', 'basic.workflow.js'), createdAt: 1 }))
    else lines.push(JSON.stringify({ type: 'end', status: 'failed', error: 'control socket unavailable' }))
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.join('\n') + '\n')
  }
  if (events) fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ t: 1, type: 'run', state: 'started' }) + '\n')
  if (state === 'completed' || state === 'failed' || state === 'interrupted') {
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ runId, status: state, result: { ok: true } }))
  } else if (state === 'stale') {
    // No result, no socket, no lock, a heartbeat well past STALE_MS (15 s).
    fs.writeFileSync(path.join(dir, '.heartbeat'), String(Date.now() - 120_000))
  }
  return dir
}

/**
 * A REAL `serveControl` listener on the run's own socket, answering with the engine's
 * reply shapes. `handle` may be replaced per test; `calls` records what actually crossed
 * the socket, which is how the per-command timeouts and the request shapes are pinned.
 */
async function liveRun(runId, handle) {
  const dir = seedRun(runId, { state: 'running' })
  const sock = path.join(dir, 'control.sock')
  assert.ok(fs.realpathSync(dir).length + '/control.sock'.length <= MAX_SOCKET_PATH,
    `the control socket path for "${runId}" exceeds sun_path — shorten the run id or TMPDIR, this is not a bridge failure`)
  const calls = []
  const server = serveControl(sock, async (req) => {
    calls.push(req)
    return handle(req)
  })
  await server.ready
  return { dir, calls, close: () => server.close() }
}

const auditLines = () => {
  let raw
  try { raw = fs.readFileSync(auditPath(), 'utf8') } catch { return [] }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const auditFor = (runId) => auditLines().filter((l) => l.runId === runId)

/** The engine's own answers (src/engine.js:674–730), so nothing here is invented. */
const engineHandler = (req) => {
  switch (req.cmd) {
    case 'status': return { ok: true, runId: 'live', state: 'running', agents: [], questions: [], spentOutputTokens: 0 }
    case 'send':
      if (req.agent === 99) return { error: `no live agent "${req.agent}" (use \`flowition status\` for indices/labels)` }
      return { ok: true, delivery: req.agent === 1 ? 'queued' : 'live' }
    case 'answer':
      if (req.qid !== 'q0') return { error: `no pending question "${req.qid}"` }
      return { ok: true }
    case 'cancel':
      if (req.agent != null) {
        if (req.agent === 99) return { error: `no live agent "${req.agent}"` }
        return { ok: true, cancelled: req.agent }
      }
      return { ok: true, cancelled: 'run' }
    default: return { error: `unknown command "${req.cmd}"` }
  }
}

/** Records the resume launch instead of performing it (the §7.3 spawn seam). */
function recordingSpawn() {
  const spawns = []
  const fn = (command, argv, options) => {
    spawns.push({ command, argv, options })
    return { on: () => {}, unref: () => {} }
  }
  fn.spawns = spawns
  return fn
}

let rw            // all five capabilities
let spawnFn

before(async () => {
  fs.mkdirSync(DIST, { recursive: true })
  fs.writeFileSync(path.join(DIST, 'index.html'), '<!doctype html><title>flowition</title>')
  fs.mkdirSync(RUNS, { recursive: true })
  spawnFn = recordingSpawn()
  rw = await startViewer({
    port: 0,
    distRoot: DIST,
    control: true,
    // The ONLY seam: `ctx.spawnFn` is undefined in production, so `resume` spawns the
    // real CLI. Everything else here — pipeline, routes, bridge, sockets, retention — is
    // the shipped code path. The wrapper keeps `routes.resume` itself under test rather
    // than substituting a handler for it.
    handlers: { resume: (ctx, ...rest) => routes.HANDLERS.resume({ ...ctx, spawnFn }, ...rest) },
  })
  // node:test on Node 18 finishes the root test from `beforeExit`, which never fires
  // while a ref'd listener holds the loop open.
  rw.unref()
})

after(async () => { await rw?.close() })

// ---- §7.2 the mapping table ---------------------------------------------------------

test('§7.2 send: the mapping is exact and the delivery verdict is surfaced verbatim', async () => {
  const runId = 'r-send'
  const live = await liveRun(runId, engineHandler)
  try {
    const res = await post(rw, `/api/runs/${runId}/send`, { agent: 0, message: 'focus on the failing test' })
    assert.equal(res.status, 200, res.body)
    assert.deepEqual(res.json, { ok: true, runId, agent: 0, delivery: 'live' })

    // The request that crossed the socket is `{cmd:'send', agent, message}` — the engine's
    // vocabulary, not the HTTP body's.
    assert.deepEqual(live.calls.at(-1), { id: 1, cmd: 'send', agent: 0, message: 'focus on the failing test' })

    // Verbatim means verbatim: `queued` is not normalized into `live`, and a `dropped`
    // verdict is a 200 the UI renders amber, NOT an error the server invents.
    const queued = await post(rw, `/api/runs/${runId}/send`, { agent: 1, message: 'later' })
    assert.equal(queued.json.delivery, 'queued')

    // A label works too — `agent` is an index OR a non-empty string (§7.2, routes.js).
    const labelled = await post(rw, `/api/runs/${runId}/send`, { agent: 'reviewer', message: 'hi' })
    assert.equal(labelled.status, 200, labelled.body)
    assert.equal(live.calls.at(-1).agent, 'reviewer')

    // `{error}` from the engine → 409 carrying the engine's own message.
    const gone = await post(rw, `/api/runs/${runId}/send`, { agent: 99, message: 'hi' })
    assert.equal(gone.status, 409, gone.body)
    assert.equal(gone.json.error.code, 'conflict')
    assert.match(gone.json.error.message, /no live agent/)
    assert.equal(gone.json.error.runId, runId)
  } finally {
    await live.close()
  }
})

test('the send verdict vocabulary passes through, including one this build never heard of', async () => {
  // §6.5 runs in both directions: an older viewer against a newer engine must show the
  // operator what actually happened rather than blanking a word it cannot classify.
  const runId = 'r-verd'
  const seen = []
  const live = await liveRun(runId, (req) => ({ ok: true, delivery: seen.shift() }))
  try {
    for (const verdict of [...SEND_VERDICTS, 'teleported']) {
      seen.push(verdict)
      const res = await post(rw, `/api/runs/${runId}/send`, { agent: 0, message: 'x' })
      assert.equal(res.status, 200, res.body)
      assert.equal(res.json.delivery, verdict, verdict)
    }
    // A non-string verdict is dropped rather than forwarded into a status chip.
    seen.push({ weird: true })
    const odd = await post(rw, `/api/runs/${runId}/send`, { agent: 0, message: 'x' })
    assert.equal(odd.json.delivery, null)
  } finally {
    await live.close()
  }
})

test('§7.2 answer: 409 when another operator answered first', async () => {
  const runId = 'r-answer'
  const live = await liveRun(runId, engineHandler)
  try {
    const ok = await post(rw, `/api/runs/${runId}/answer`, { qid: 'q0', value: 'ship it' })
    assert.equal(ok.status, 200, ok.body)
    assert.deepEqual(ok.json, { ok: true, runId, qid: 'q0' })
    assert.deepEqual(live.calls.at(-1), { id: 1, cmd: 'answer', qid: 'q0', value: 'ship it' })

    // The value is never echoed back, and a non-string value survives the round trip.
    const structured = await post(rw, `/api/runs/${runId}/answer`, { qid: 'q0', value: { choice: 2 } })
    assert.equal(structured.status, 200)
    assert.ok(!structured.body.includes('choice'), 'the answer value must not be echoed')
    assert.deepEqual(live.calls.at(-1).value, { choice: 2 })

    const stale = await post(rw, `/api/runs/${runId}/answer`, { qid: 'q9', value: 'x' })
    assert.equal(stale.status, 409, stale.body)
    assert.equal(stale.json.error.code, 'conflict')
    assert.match(stale.json.error.message, /no pending question/)
  } finally {
    await live.close()
  }
})

test('§7.2 cancel: per-agent and whole-run are two different requests on the wire (N5)', async () => {
  const runId = 'r-cancel'
  const live = await liveRun(runId, engineHandler)
  try {
    const agent = await post(rw, `/api/runs/${runId}/cancel`, { agent: 3 })
    assert.equal(agent.status, 200, agent.body)
    assert.deepEqual(agent.json, { ok: true, runId, scope: 'agent', cancelled: 3 })
    assert.deepEqual(live.calls.at(-1), { id: 1, cmd: 'cancel', agent: 3 })

    const whole = await post(rw, `/api/runs/${runId}/cancel`, {})
    assert.equal(whole.status, 200, whole.body)
    assert.deepEqual(whole.json, { ok: true, runId, scope: 'run', cancelled: 'run' })
    // The whole-run request carries NO `agent` key at all. The engine reads `agent == null`
    // as a whole-run abort (src/engine.js:706), so a per-agent request that lost its value
    // in transit must not become a run kill.
    assert.deepEqual(live.calls.at(-1), { id: 1, cmd: 'cancel' })
    assert.equal('agent' in live.calls.at(-1), false)

    // `{agent: null}` never reaches the socket: routes.js refuses it at 400.
    const before = live.calls.length
    const nulled = await post(rw, `/api/runs/${runId}/cancel`, { agent: null })
    assert.equal(nulled.status, 400, nulled.body)
    assert.match(nulled.json.error.message, /omit the key entirely/)
    assert.equal(live.calls.length, before, 'a refused body must never reach the control socket')

    const missing = await post(rw, `/api/runs/${runId}/cancel`, { agent: 99 })
    assert.equal(missing.status, 409, missing.body)
  } finally {
    await live.close()
  }
})

test('§7.2 per-command timeouts: status 300 ms, send/answer/cancel 2000 ms', async () => {
  // The table is data, so it can be asserted as data (critique M13: inheriting
  // controlRequest's 5000 ms default would pin an HTTP connection to a blocked engine).
  assert.deepEqual({ ...CONTROL_TIMEOUT_MS }, { status: 300, send: 2000, answer: 2000, cancel: 2000 })

  // And the bridge actually passes it: a recording client proves the value reaching
  // `controlRequest`'s third argument, per command.
  const passed = []
  const requestFn = async (sock, req, timeoutMs) => { passed.push([req.cmd, timeoutMs]); return { id: 1, ok: true } }
  await controlStatus('r-timeouts', { requestFn })
  for (const cmd of ['send', 'answer', 'cancel']) await controlCommand('r-timeouts', { cmd }, { requestFn })
  assert.deepEqual(passed, [['status', 300], ['send', 2000], ['answer', 2000], ['cancel', 2000]])

  // A command with no pinned budget is a programmer error, not a silent 5 s inheritance.
  await assert.rejects(() => controlCommand('r-timeouts', { cmd: 'post' }, { requestFn }), /no pinned timeout/)
})

test('§7.2 per-command timeouts are enforced against a real socket that never replies', async () => {
  const runId = 'r-slow'
  // A real serveControl listener that accepts the connection and simply never answers —
  // the preflight-blocked engine M13 describes.
  const live = await liveRun(runId, () => new Promise(() => {}))
  try {
    const started = Date.now()
    const res = await post(rw, `/api/runs/${runId}/send`, { agent: 0, message: 'x' })
    const elapsed = Date.now() - started
    assert.equal(res.status, 503, res.body)
    assert.equal(res.json.error.code, 'run_not_live')
    assert.equal(res.json.retryAfterMs, RETRY_AFTER_MS)
    assert.ok(elapsed >= 1800, `send must wait its full 2000 ms budget, waited ${elapsed}ms`)
    assert.ok(elapsed < 4500, `send must not inherit controlRequest's 5000 ms default, waited ${elapsed}ms`)

    // The 300 ms status budget against the same silent listener.
    const statusStarted = Date.now()
    await assert.rejects(() => controlStatus(runId))
    assert.ok(Date.now() - statusStarted < 1500, 'status must use its own 300 ms budget')
  } finally {
    await live.close()
  }
})

test('run_not_live: an absent socket, a stale socket file, and a refused connection all map to 503', async () => {
  // A terminal run: the directory and its artifacts exist, the control socket does not.
  const absent = 'ctl-not-live'
  seedRun(absent, { state: 'completed' })
  for (const [target, body] of [
    [`/api/runs/${absent}/send`, { agent: 0, message: 'x' }],
    [`/api/runs/${absent}/answer`, { qid: 'q0', value: 'x' }],
    [`/api/runs/${absent}/cancel`, {}],
  ]) {
    const res = await post(rw, target, body)
    assert.equal(res.status, 503, `${target}: ${res.body}`)
    assert.equal(res.json.error.code, 'run_not_live')
    assert.equal(res.json.error.runId, absent)
    assert.match(res.json.error.message, /run is not live — it may have finished/)
    assert.equal(res.json.retryAfterMs, RETRY_AFTER_MS)
    // §5.2: no filesystem detail in a refusal body.
    assert.ok(!res.body.includes(HOME), res.body)
  }

  // A leftover socket with nothing listening — the engine killed -9, which never got to
  // unlink its own socket. That is a genuine ECONNREFUSED, which §7.2 maps to the same
  // retryable refusal rather than a 500.
  //
  // Reproducing it needs care: `serveControl.close()` unlinks the path it owns, and so
  // does node's own net server, so simply closing a listener leaves nothing behind. A
  // regular file written at the path is NOT the same thing (it raises ENOTSOCK — see the
  // negative assertion below). A hard link to the live socket keeps the socket INODE
  // alive after its owner unlinks its name, which is exactly the orphan a -9 leaves.
  const stale = 'r-stale'
  const dir = seedRun(stale, { state: 'interrupted' })
  const sock = path.join(dir, 'control.sock')
  const owned = path.join(dir, 'live.sock')
  const listener = serveControl(owned, () => ({ ok: true }))
  await listener.ready
  fs.linkSync(owned, sock)
  await new Promise((resolve) => { listener.close().then(resolve, resolve) })
  assert.ok(fs.existsSync(sock), 'the orphaned socket inode must survive its owner')
  const refused = await post(rw, `/api/runs/${stale}/cancel`, {})
  assert.equal(refused.status, 503, refused.body)
  assert.equal(refused.json.error.code, 'run_not_live')

  // The negative: a REGULAR FILE at the control path is not a dead run, it is something
  // that is not a control socket at all (ENOTSOCK). §7.2's failure column does not list
  // it, so it must not wear the retryable label — it leaves as a §5.2 generic 500.
  fs.unlinkSync(sock)
  fs.writeFileSync(sock, 'this is not a socket')
  const notASocket = await post(rw, `/api/runs/${stale}/cancel`, {})
  assert.equal(notASocket.status, 500, notASocket.body)
  assert.equal(notASocket.json.error.code, 'internal')
})

test('a run that does not exist is 404, not "it may have finished"', async () => {
  // §5.2 reserves 404 for an absent run and every read route already answers it; telling
  // an operator who typo'd an id that their run "may have finished" is unactionable.
  for (const [method, target, body] of [
    ['POST', '/api/runs/flo_nope/send', { agent: 0, message: 'x' }],
    ['POST', '/api/runs/flo_nope/answer', { qid: 'q', value: 1 }],
    ['POST', '/api/runs/flo_nope/cancel', {}],
    ['POST', '/api/runs/flo_nope/resume', {}],
    ['DELETE', '/api/runs/flo_nope', {}],
  ]) {
    const res = await request(rw.port, { method, path: target, headers: mutate(rw), body: JSON.stringify(body) })
    assert.equal(res.status, 404, `${method} ${target}: ${res.body}`)
    assert.equal(res.json.error.code, 'not_found')
  }
  // Refused, but attempted — and an attempted mutation is exactly what the §7.3 audit is
  // for. `delete`'s line is retention's own (`refused`/`missing`); the other four are the
  // bridge's, all carrying their §5.2 code as the reason. `cancel` and `resume` are the
  // fail-closed ops, so each of them logged its intent BEFORE the id was even resolved.
  assert.deepEqual(auditFor('flo_nope').map((l) => [l.op, l.outcome]), [
    ['send', 'refused'], ['answer', 'refused'],
    ['cancel', 'attempt'], ['cancel', 'refused'],
    ['resume', 'attempt'], ['resume', 'refused'],
    ['delete', 'refused'],
  ])
})

// ---- §7.2 the mapping table is EXACT: run_not_live is not a catch-all ----------------

test('§7.2/§5.2 run_not_live covers ENOENT, ECONNREFUSED and timeout — and nothing else', async () => {
  // §5.2 defines run_not_live as "control socket absent/refused (retryable)" and §7.2's
  // failure column names exactly three conditions. A permission failure or a corrupt
  // reply is neither absent nor refused: it is a fault the SPA must not re-poll, so it
  // has to leave the bridge as a generic 500 rather than wearing a retryable label.
  const mapped = []
  const throwing = (err) => async () => { throw err }
  for (const [label, err] of [
    ['ENOENT', Object.assign(new Error('connect ENOENT /x/control.sock'), { code: 'ENOENT' })],
    ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED /x/control.sock'), { code: 'ECONNREFUSED' })],
    ['timeout', new Error('control request timed out')],
  ]) {
    const caught = await controlCommand('r-map', { cmd: 'cancel' }, { requestFn: throwing(err) }).catch((e) => e)
    mapped.push([label, caught.status, caught.code])
  }
  assert.deepEqual(mapped, [['ENOENT', 503, 'run_not_live'], ['ECONNREFUSED', 503, 'run_not_live'], ['timeout', 503, 'run_not_live']])

  // The negative half. Each of these must come back OUT of the bridge unchanged — not as
  // an HttpError at all — so http.js renders §5.2's generic 500.
  for (const err of [
    Object.assign(new Error('connect EACCES /x/control.sock'), { code: 'EACCES' }),
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    new SyntaxError('Unexpected token o in JSON at position 1'),
  ]) {
    const caught = await controlCommand('r-map', { cmd: 'cancel' }, { requestFn: throwing(err) }).catch((e) => e)
    assert.equal(caught, err, `${err.code ?? err.name} must be re-thrown, not relabelled run_not_live`)
    assert.equal(caught.status, undefined, 'a re-thrown transport fault carries no HTTP status')
  }
})

test('a control socket that replies with garbage is a 500, not a retryable 503', async () => {
  // A real socket at the run's real control path, answering a real request with a line
  // that is not JSON — protocol corruption, or something that is not a flowition engine.
  const runId = 'r-garbage'
  const dir = seedRun(runId, { state: 'running' })
  const sock = path.join(dir, 'control.sock')
  const server = net.createServer((conn) => { conn.on('data', () => conn.write('not json at all\n')) })
  await new Promise((resolve) => server.listen(sock, resolve))
  try {
    const res = await post(rw, `/api/runs/${runId}/cancel`, {})
    assert.equal(res.status, 500, res.body)
    assert.deepEqual(res.json, { error: { code: 'internal', message: 'internal error' } })
    // §5.2: the generic 500 leaks nothing — no path, no parser text.
    assert.ok(!res.body.includes(HOME), res.body)
    // …and the attempt is still on the record (§7.3): the intent line precedes dispatch.
    assert.deepEqual(auditFor(runId).map((l) => [l.op, l.outcome]), [['cancel', 'attempt'], ['cancel', 'error']])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a control socket this process may not connect to is a 500, not a retryable 503', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs POSIX socket permissions and a non-root uid' : false }, async () => {
  const runId = 'r-eacces'
  const live = await liveRun(runId, engineHandler)
  try {
    fs.chmodSync(path.join(live.dir, 'control.sock'), 0o000)
    const res = await post(rw, `/api/runs/${runId}/cancel`, {})
    assert.equal(res.status, 500, res.body)
    assert.equal(res.json.error.code, 'internal')
  } finally {
    try { fs.chmodSync(path.join(live.dir, 'control.sock'), 0o600) } catch { /* already gone */ }
    await live.close()
  }
})

// ---- §7.3 resume --------------------------------------------------------------------

test('§7.3 resume: marker written, argv correct, detached, 202 launchAccepted', async () => {
  const runId = 'ctl-resume'
  const dir = seedRun(runId, { state: 'interrupted' })
  const before = spawnFn.spawns.length

  const res = await post(rw, `/api/runs/${runId}/resume`, {})
  assert.equal(res.status, 202, res.body)
  assert.deepEqual(res.json, { runId, launchAccepted: true, mode: 'resume', from: 'interrupted' })

  // The `.resuming` handoff marker is on disk — this is what a concurrent delete
  // linearizes against (src/run-lock.js), so a resume that skipped it would be a resume a
  // delete could not lose to.
  assert.ok(fs.existsSync(path.join(dir, RESUME_MARKER)), 'the resume marker must be installed')

  // The launch: `node <repo>/bin/flowition.js resume <id> --json`, detached, with run.log
  // on both output fds (src/mcp.js:47–55, §7.3).
  assert.equal(spawnFn.spawns.length, before + 1)
  const launch = spawnFn.spawns.at(-1)
  assert.equal(launch.command, process.execPath)
  assert.deepEqual(launch.argv.slice(1), ['resume', runId, '--json'])
  assert.equal(launch.argv[0], path.join(ROOT, 'bin', 'flowition.js'))
  assert.equal(launch.options.detached, true)
  assert.equal(launch.options.stdio[0], 'ignore')
  assert.equal(typeof launch.options.stdio[1], 'number')
  assert.equal(launch.options.stdio[1], launch.options.stdio[2], 'stdout and stderr share the run.log fd')
  assert.ok(fs.existsSync(path.join(dir, 'run.log')), 'run.log must be opened for append')
})

test('§7.3 resume: a completed run is allowed — the Replay case (Sol-12, parity #99)', async () => {
  // The engine deliberately supports resuming a completed run as a full cache replay
  // (test/engine.test.js:41–46); withholding it removes a real capability for no gain.
  assert.deepEqual([...RESUMABLE_STATES], ['completed', 'failed', 'interrupted', 'stale'])

  const runId = 'ctl-replay'
  seedRun(runId, { state: 'completed' })
  const res = await post(rw, `/api/runs/${runId}/resume`, {})
  assert.equal(res.status, 202, res.body)
  assert.equal(res.json.launchAccepted, true)
  assert.equal(res.json.mode, 'replay', 'the completed case is labelled Replay, with its own modal copy')
  assert.equal(res.json.from, 'completed')

  // …and every other resumable state.
  for (const state of ['failed', 'stale']) {
    const id = `ctl-resume-${state}`
    seedRun(id, { state })
    const ok = await post(rw, `/api/runs/${id}/resume`, {})
    assert.equal(ok.status, 202, `${state}: ${ok.body}`)
    assert.equal(ok.json.mode, 'resume')
  }
})

test('§7.3 resume: refused while live, and refused without a journal meta', async () => {
  const runId = 'r-rlive'
  const live = await liveRun(runId, engineHandler)
  try {
    // A live control socket makes deriveRunState say `running` → §7.2's 409.
    const res = await post(rw, `/api/runs/${runId}/resume`, {})
    assert.equal(res.status, 409, res.body)
    assert.equal(res.json.error.code, 'conflict')
    assert.match(res.json.error.message, /is running/)
  } finally {
    await live.close()
  }

  // A journal whose first record is an `end` (an early preflight failure — src/engine.js:739)
  // is frozen: the engine refuses meta-less journals (src/engine.js:789), so accepting the
  // launch here would report launchAccepted for a launch certain to die.
  const metaless = 'ctl-resume-metaless'
  seedRun(metaless, { state: 'failed', meta: false })
  const noMeta = await post(rw, `/api/runs/${metaless}/resume`, {})
  assert.equal(noMeta.status, 409, noMeta.body)
  assert.match(noMeta.json.error.message, /no journal meta/)

  // A bare directory derives `unknown` — not in the resumable set.
  const bare = 'ctl-resume-bare'
  fs.mkdirSync(path.join(RUNS, bare), { recursive: true })
  const unknown = await post(rw, `/api/runs/${bare}/resume`, {})
  assert.equal(unknown.status, 409, unknown.body)
  assert.match(unknown.json.error.message, /cannot be resumed/)
})

test('§7.4 resume never executes a workflow in the server process', async () => {
  // The structural claim, asserted structurally: nothing under src/viewer/** may name
  // `runWorkflow`, import engine.js, or import an adapter. test/zero-deps.test.js owns the
  // full sweep; this pins the one module that would be tempted.
  const source = fs.readFileSync(path.join(ROOT, 'src', 'viewer', 'control-bridge.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.ok(!/\brunWorkflow\b/.test(source))
  for (const denied of ['../engine.js', '../agent-proc.js', '../adapters/']) {
    assert.ok(!source.includes(denied), `control-bridge.js must not import ${denied}`)
  }
  // The only child process it can create is the CLI, spawned detached.
  assert.match(source, /detached: true/)
})

// ---- §7.3 delete --------------------------------------------------------------------

test('§7.3 delete: goes through retention.js — trash, not oblivion', async () => {
  const runId = 'ctl-delete'
  const dir = seedRun(runId, { state: 'completed' })

  const res = await del(rw, `/api/runs/${runId}`)
  assert.equal(res.status, 200, res.body)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.runId, runId)
  assert.equal(res.json.trashTtlDays, 7)
  assert.equal(typeof res.json.trashedAt, 'number')
  // The trash ENTRY, never an absolute path (§5.2 keeps filesystem layout out of bodies).
  assert.match(res.json.trashEntry, new RegExp(`^${runId}\\.\\d+`))
  assert.ok(!res.body.includes(HOME), res.body)

  assert.ok(!fs.existsSync(dir), 'the run must have left runs/')
  const trashed = path.join(trashDir(), res.json.trashEntry)
  assert.ok(fs.existsSync(path.join(trashed, 'journal.jsonl')), 'the run must be recoverable from the trash')
})

test('§7.3 delete: every retention guard is the route\'s answer, and its code is the §5.2 code', async () => {
  // The route contains no filesystem-deletion logic of its own, so each of these is
  // `removeRun`'s verdict arriving intact — refuse-live, symlink, artifact-less.
  const liveId = 'r-dlive'
  const live = await liveRun(liveId, engineHandler)
  try {
    const res = await del(rw, `/api/runs/${liveId}`)
    assert.equal(res.status, 409, res.body)
    assert.equal(res.json.error.code, 'conflict')
    assert.match(res.json.error.message, /is live/)
    assert.ok(fs.existsSync(live.dir), 'a refused delete must leave the run alone')
  } finally {
    await live.close()
  }

  // A symlink is refused outright, never followed.
  const target = seedRun('ctl-delete-target', { state: 'completed' })
  const linkId = 'ctl-delete-link'
  fs.symlinkSync(target, path.join(RUNS, linkId))
  const symlink = await del(rw, `/api/runs/${linkId}`)
  assert.equal(symlink.status, 409, symlink.body)
  assert.match(symlink.json.error.message, /symlink/)
  assert.ok(fs.existsSync(target), 'the symlink target must be untouched')

  // A validly-named directory with no flowition artifacts is not a run.
  const notARun = 'ctl-delete-not-a-run'
  fs.mkdirSync(path.join(RUNS, notARun), { recursive: true })
  fs.writeFileSync(path.join(RUNS, notARun, 'notes.txt'), 'the user put this here')
  const refused = await del(rw, `/api/runs/${notARun}`)
  assert.equal(refused.status, 409, refused.body)
  assert.match(refused.json.error.message, /no flowition run artifacts/)
  assert.ok(fs.existsSync(path.join(RUNS, notARun, 'notes.txt')), 'a refused delete must destroy nothing')

  // An id that cannot be a run id never becomes a path join (§5.1 principle 1).
  const traversal = await request(rw.port, { method: 'DELETE', path: '/api/runs/..%2F..%2Fetc', headers: mutate(rw), body: '{}' })
  assert.equal(traversal.status, 400, traversal.body)
  assert.equal(traversal.json.error.code, 'bad_request')
})

// ---- §7.3 the audit log -------------------------------------------------------------

test('§7.3 audit: every mutation writes a line, with no bodies and no values', async () => {
  const runId = 'r-audit'
  const live = await liveRun(runId, engineHandler)
  try {
    await post(rw, `/api/runs/${runId}/send`, { agent: 0, message: 'SECRET-STEER' })
    await post(rw, `/api/runs/${runId}/answer`, { qid: 'q0', value: 'SECRET-ANSWER' })
    await post(rw, `/api/runs/${runId}/cancel`, { agent: 2 })
    // …and a refusal, recorded with its §5.2 code rather than the engine's message.
    await post(rw, `/api/runs/${runId}/send`, { agent: 99, message: 'SECRET-REFUSED' })
  } finally {
    await live.close()
  }

  const lines = auditFor(runId)
  // `cancel` is in §7.3's op union and it destroys work, so it writes its intent BEFORE
  // the request crosses the socket and its outcome after. send/answer are not in that
  // union (their authoritative trace is the run's own steered/mail/answer stream, §7.2),
  // so they get the outcome line only.
  assert.deepEqual(lines.map((l) => [l.op, l.outcome]), [
    ['send', 'ok'], ['answer', 'ok'], ['cancel', 'attempt'], ['cancel', 'ok'], ['send', 'refused'],
  ])
  for (const line of lines) {
    assert.equal(typeof line.t, 'number')
    assert.equal(line.runId, runId)
  }
  assert.equal(lines.at(-1).reason, 'conflict')

  const raw = fs.readFileSync(auditPath(), 'utf8')
  for (const secret of ['SECRET-STEER', 'SECRET-ANSWER', 'SECRET-REFUSED', 'q0']) {
    assert.ok(!raw.includes(secret), `the audit log must not record "${secret}" — no bodies, no values`)
  }

  // The file is the 0600 one §7.3 specifies.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(auditPath()).mode & 0o777, 0o600)
  }
})

test('§7.3 audit: resume and delete are recorded, and the delete line survives the run', async () => {
  const resumeId = 'ctl-audit-resume'
  seedRun(resumeId, { state: 'failed' })
  await post(rw, `/api/runs/${resumeId}/resume`, {})
  // Intent BEFORE the spawn, outcome after (§7.3's "append the line *before* the
  // rename", generalised to the op that starts a full-permission process).
  assert.deepEqual(auditFor(resumeId).map((l) => [l.op, l.outcome]), [['resume', 'attempt'], ['resume', 'ok']])

  const refusedId = 'ctl-audit-resume-refused'
  seedRun(refusedId, { state: 'failed', meta: false })
  await post(rw, `/api/runs/${refusedId}/resume`, {})
  assert.deepEqual(auditFor(refusedId).map((l) => [l.op, l.outcome, l.reason]), [
    ['resume', 'attempt', undefined], ['resume', 'refused', 'conflict'],
  ])

  // Delete's line is `removeRun`'s own — written BEFORE the rename and therefore outliving
  // the run it records (§7.3, Sol-4). Exactly one line, because the route adds none.
  const deleteId = 'ctl-audit-delete'
  const dir = seedRun(deleteId, { state: 'completed' })
  const res = await del(rw, `/api/runs/${deleteId}`)
  assert.equal(res.status, 200, res.body)
  assert.deepEqual(auditFor(deleteId).map((l) => [l.op, l.outcome]), [['delete', 'ok']])
  assert.ok(!fs.existsSync(dir))
  assert.ok(fs.existsSync(auditPath()), 'the audit trail outlives the run it records')
})

// ---- §7.3/§7.4 the audit is a PRECONDITION, not a side effect -----------------------

const NEEDS_POSIX_PERMS = process.platform === 'win32' || process.getuid?.() === 0
  ? 'chmod 0400 does not deny the writer on this platform/uid — the sinkless test below covers the same criterion'
  : false

test('§7.3 an unwritable audit log stops the mutation: cancel dispatches nothing, resume spawns nothing', { skip: NEEDS_POSIX_PERMS }, async () => {
  // §7.4 books "mistaken/stolen control credential → irreversible destruction, EVIDENCE
  // LOSS" against the §7.3 audit file. That defense is worth nothing if the writer fails
  // open: a control channel that keeps cancelling runs and spawning resumes while its
  // evidence sink is silently broken IS the threat. So the two §7.3-union ops that this
  // module owns must fail CLOSED — and the proof has to be a real request over the real
  // pipeline against a real unwritable audit path, not an injected stub.
  //
  // The path is made unwritable the way an operator's filesystem would: the 0600 log is
  // chmod'd 0400, so `fs.openSync(file, 'a')` in src/viewer/audit.js raises EACCES. (The
  // repair chmod there runs AFTER the write, so it cannot rescue this.)
  const cancelId = 'r-ac'
  const resumeId = 'r-ar'
  const live = await liveRun(cancelId, engineHandler)
  seedRun(resumeId, { state: 'failed' })

  // Force the log into existence so there is a file to make read-only.
  await post(rw, `/api/runs/${cancelId}/send`, { agent: 0, message: 'x' })
  const auditBefore = fs.readFileSync(auditPath(), 'utf8')
  const callsBefore = live.calls.length
  const spawnsBefore = spawnFn.spawns.length

  fs.chmodSync(auditPath(), 0o400)
  try {
    const cancelled = await post(rw, `/api/runs/${cancelId}/cancel`, {})
    assert.equal(cancelled.status, 500, cancelled.body)
    assert.deepEqual(cancelled.json, { error: { code: 'internal', message: 'internal error' } },
      '§5.2: the refusal is the generic 500 envelope — the audit path and its errno never reach the client')
    assert.equal(live.calls.length, callsBefore,
      'THE ACCEPTANCE CRITERION: not one byte may reach the control socket when the cancel cannot be recorded')

    const resumed = await post(rw, `/api/runs/${resumeId}/resume`, {})
    assert.equal(resumed.status, 500, resumed.body)
    assert.equal(resumed.json.error.code, 'internal')
    assert.notEqual(resumed.status, 202, 'an unrecordable resume must never answer launchAccepted')
    assert.equal(spawnFn.spawns.length, spawnsBefore, 'THE ACCEPTANCE CRITERION: no detached CLI may be spawned')
    assert.ok(!fs.existsSync(path.join(RUNS, resumeId, RESUME_MARKER)),
      'the .resuming handoff must not be installed either — nothing on this path may run')
  } finally {
    fs.chmodSync(auditPath(), 0o600)
    await live.close()
  }

  // The log itself is untouched: a mutation that did not happen wrote no record, and no
  // record was lost or corrupted by the failed attempt.
  assert.equal(fs.readFileSync(auditPath(), 'utf8'), auditBefore)

  // Recovery: with the sink writable again, the same two requests go through — the
  // fail-closed path is a refusal, not a latched shutdown.
  const ok = await post(rw, `/api/runs/${resumeId}/resume`, {})
  assert.equal(ok.status, 202, ok.body)
  assert.deepEqual(auditFor(resumeId).map((l) => [l.op, l.outcome]), [['resume', 'attempt'], ['resume', 'ok']])
})

test('§7.3 a ctx with no audit sink refuses the fail-closed ops rather than running them unrecorded', async () => {
  // Belt to the previous test's braces: it needs POSIX permissions to bite, and this one
  // does not, so the acceptance criterion is enforced on every platform. The sink is
  // wired in src/viewer/index.js; a handler reached with no sink is a wiring bug, and the
  // op that destroys work must not be the one that discovers it by proceeding.
  const runId = 'r-ns'
  const live = await liveRun(runId, engineHandler)
  const sinkless = await startViewer({
    port: 0,
    distRoot: DIST,
    control: true,
    handlers: {
      cancel: (ctx, ...rest) => routes.HANDLERS.cancel({ ...ctx, audit: undefined }, ...rest),
      resume: (ctx, ...rest) => routes.HANDLERS.resume({ ...ctx, audit: undefined, spawnFn }, ...rest),
    },
  })
  sinkless.unref()
  const callsBefore = live.calls.length
  const spawnsBefore = spawnFn.spawns.length
  try {
    for (const target of [`/api/runs/${runId}/cancel`, `/api/runs/${runId}/resume`]) {
      const res = await post(sinkless, target, {})
      assert.equal(res.status, 500, `${target}: ${res.body}`)
      assert.equal(res.json.error.code, 'internal')
    }
    assert.equal(live.calls.length, callsBefore, 'no cancel may cross the socket unrecorded')
    assert.equal(spawnFn.spawns.length, spawnsBefore, 'no resume may spawn unrecorded')
  } finally {
    await sinkless.close()
    await live.close()
  }
})

// ---- §7.2 the opt-in, at the route level --------------------------------------------

test('§7.2 read-only by default: the mutation routes exist and answer 403', async () => {
  const ro = await startViewer({ port: 0, distRoot: DIST })
  ro.unref()
  try {
    const runId = 'ctl-readonly'
    const dir = seedRun(runId, { state: 'completed' })
    const headers = {
      host: `127.0.0.1:${ro.port}`,
      authorization: `Bearer ${ro.token}`,
      origin: `http://127.0.0.1:${ro.port}`,
      'content-type': 'application/json',
    }
    for (const [method, target] of [
      ['POST', `/api/runs/${runId}/send`],
      ['POST', `/api/runs/${runId}/answer`],
      ['POST', `/api/runs/${runId}/cancel`],
      ['POST', `/api/runs/${runId}/resume`],
      ['DELETE', `/api/runs/${runId}`],
    ]) {
      const res = await request(ro.port, { method, path: target, headers, body: '{}' })
      assert.equal(res.status, 403, `${method} ${target}: ${res.body}`)
      assert.equal(res.json.error.code, 'forbidden')
      assert.match(res.json.error.message, /read-only — restart with --control/)
    }
    // Nothing happened: the run is intact and no marker was installed.
    assert.ok(fs.existsSync(path.join(dir, 'journal.jsonl')))
    assert.ok(!fs.existsSync(path.join(dir, RESUME_MARKER)))
    assert.equal(auditFor(runId).length, 0, 'a refused-at-the-gate mutation writes no audit line')
  } finally {
    await ro.close()
  }
})
