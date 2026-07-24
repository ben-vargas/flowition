import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { serveControl } from '../src/control.js'
import { deriveRunState } from '../src/run-state.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bin = path.join(root, 'bin', 'flowition.js')

function mcp() {
  const child = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const responses = []
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      responses.push(JSON.parse(line))
    }
  })
  const waitFor = (match, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const interval = setInterval(() => {
      const index = responses.findIndex(match)
      if (index !== -1) {
        clearInterval(interval)
        resolve(responses.splice(index, 1)[0])
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(interval)
        reject(new Error('timed out waiting for MCP response'))
      }
    }, 10)
  })
  return {
    child,
    send: (message) => child.stdin.write(typeof message === 'string' ? message + '\n' : JSON.stringify(message) + '\n'),
    waitForId: (id) => waitFor((response) => response.id === id),
    waitFor,
  }
}

test('mcp: protocol errors, ping, tools, and version negotiation', async (t) => {
  const server = mcp()
  t.after(() => server.child.kill())

  server.send('{')
  assert.deepEqual(await server.waitFor((response) => response.error?.code === -32700), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Parse error' },
  })

  server.send({ id: 0, method: 'ping' })
  assert.deepEqual(await server.waitFor((response) => response.error?.code === -32600), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'Invalid Request' },
  })

  server.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
  assert.deepEqual(await server.waitForId(1), { jsonrpc: '2.0', id: 1, result: {} })

  server.send({ jsonrpc: '2.0', id: 2, method: 'missing' })
  assert.equal((await server.waitForId(2)).error.code, -32601)

  server.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'missing', arguments: {} } })
  assert.equal((await server.waitForId(3)).error.code, -32602)

  server.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'flowition_result', arguments: { runId: 'flo_test', waitSeconds: 'forever' } } })
  assert.equal((await server.waitForId(4)).error.code, -32602)

  server.send({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.equal((await server.waitForId(5)).result.protocolVersion, '2025-06-18')

  server.send({ jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: '2099-01-01' } })
  assert.equal((await server.waitForId(6)).result.protocolVersion, '2025-11-25')
})

test('deriveRunState: terminal, heartbeat, stale, and corrupt states', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-run-state-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dir = (name) => {
    const value = path.join(base, name)
    fs.mkdirSync(value)
    return value
  }

  const terminal = dir('terminal')
  const result = { runId: 'flo_terminal', status: 'completed', result: 42 }
  fs.writeFileSync(path.join(terminal, 'result.json'), JSON.stringify(result))
  assert.deepEqual(await deriveRunState(terminal), { state: 'completed', result })

  const resumeMarker = path.join(terminal, '.resuming')
  fs.writeFileSync(resumeMarker, String(Date.now()))
  assert.deepEqual(await deriveRunState(terminal), { state: 'starting', result: null })

  const sockPath = path.join(terminal, 'control.sock')
  const live = { ok: true, runId: result.runId, state: 'running', agents: [] }
  const control = serveControl(sockPath, async () => live)
  t.after(() => control.close())
  await control.ready
  assert.deepEqual(await deriveRunState(terminal), { state: 'running', result: null, live })
  await control.close()

  const old = new Date(Date.now() - 30_001)
  fs.writeFileSync(resumeMarker, String(old.getTime()))
  fs.utimesSync(resumeMarker, old, old)
  assert.deepEqual(await deriveRunState(terminal), { state: 'completed', result })
  assert.equal(fs.existsSync(resumeMarker), false)

  const raced = dir('raced-marker')
  const racedResult = { runId: 'flo_raced', status: 'completed', result: 9 }
  const racedMarker = path.join(raced, '.resuming')
  fs.writeFileSync(path.join(raced, 'result.json'), JSON.stringify(racedResult))
  fs.writeFileSync(racedMarker, String(old.getTime()))
  fs.utimesSync(racedMarker, old, old)

  const statSync = fs.statSync
  let replaced = false
  try {
    fs.statSync = (...args) => {
      const stat = statSync(...args)
      if (!replaced && args[0] === racedMarker) {
        replaced = true
        const fresh = `${racedMarker}.fresh`
        fs.writeFileSync(fresh, String(Date.now()))
        fs.renameSync(fresh, racedMarker)
      }
      return stat
    }
    assert.deepEqual(await deriveRunState(raced), { state: 'starting', result: null })
  } finally {
    fs.statSync = statSync
  }
  assert.equal(replaced, true)
  assert.equal(fs.existsSync(racedMarker), true)
  assert.deepEqual(await deriveRunState(raced), { state: 'starting', result: null })
  assert.equal(fs.existsSync(racedMarker), true)
  assert.equal(fs.readdirSync(raced).some((name) => name.startsWith('.resuming.claim.')), false)

  const opaque = dir('opaque-marker')
  const opaqueResult = { runId: 'flo_opaque', status: 'completed', result: 11 }
  fs.writeFileSync(path.join(opaque, 'result.json'), JSON.stringify(opaqueResult))
  fs.mkdirSync(path.join(opaque, '.resuming'))
  assert.deepEqual(await deriveRunState(opaque), { state: 'completed', result: opaqueResult })

  const torn = dir('torn-marker')
  const tornResult = { runId: 'flo_torn', status: 'completed', result: 7 }
  const tornMarker = path.join(torn, '.resuming')
  fs.writeFileSync(path.join(torn, 'result.json'), JSON.stringify(tornResult))
  fs.writeFileSync(tornMarker, '')
  assert.deepEqual(await deriveRunState(torn), { state: 'starting', result: null })
  assert.equal(fs.existsSync(tornMarker), true)
  fs.utimesSync(tornMarker, old, old)
  assert.deepEqual(await deriveRunState(torn), { state: 'completed', result: tornResult })
  assert.equal(fs.existsSync(tornMarker), false)

  const fresh = dir('fresh')
  fs.writeFileSync(path.join(fresh, '.heartbeat'), String(Date.now()))
  assert.equal((await deriveRunState(fresh)).state, 'running')

  const stale = dir('stale')
  fs.writeFileSync(path.join(stale, '.heartbeat'), String(Date.now() - 16_000))
  assert.equal((await deriveRunState(stale)).state, 'stale')

  const resumingStale = dir('resuming-stale')
  fs.writeFileSync(path.join(resumingStale, '.heartbeat'), String(Date.now() - 16_000))
  const resumingStaleMarker = path.join(resumingStale, '.resuming')
  fs.writeFileSync(resumingStaleMarker, String(Date.now()))
  assert.deepEqual(await deriveRunState(resumingStale), { state: 'starting', result: null })

  fs.writeFileSync(resumingStaleMarker, String(old.getTime()))
  fs.utimesSync(resumingStaleMarker, old, old)
  assert.equal((await deriveRunState(resumingStale)).state, 'stale')
  assert.equal(fs.existsSync(resumingStaleMarker), false)

  const corrupt = dir('corrupt')
  fs.writeFileSync(path.join(corrupt, 'result.json'), '{')
  const corruptSockPath = path.join(corrupt, 'control.sock')
  const corruptLive = { ok: true, runId: 'flo_corrupt', state: 'running', agents: [] }
  const corruptControl = serveControl(corruptSockPath, async () => corruptLive)
  t.after(() => corruptControl.close())
  await corruptControl.ready
  assert.deepEqual(await deriveRunState(corrupt), { state: 'running', result: null, live: corruptLive })
  await corruptControl.close()
  const corruptState = await deriveRunState(corrupt)
  assert.equal(corruptState.state, 'corrupt-result')
  assert.equal(corruptState.result, null)

  const garbage = dir('garbage')
  fs.writeFileSync(path.join(garbage, 'result.json'), JSON.stringify({ status: 'garbage' }))
  assert.equal((await deriveRunState(garbage)).state, 'corrupt-result')

  const interrupted = dir('interrupted')
  const interruptedResult = { runId: 'flo_interrupted', status: 'interrupted', error: 'stopped' }
  fs.writeFileSync(path.join(interrupted, 'result.json'), JSON.stringify(interruptedResult))
  assert.deepEqual(await deriveRunState(interrupted), { state: 'interrupted', result: interruptedResult })
})

test('deriveRunState: a young-raced claim whose link restore fails is renamed back, not lost', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-claim-restore-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dir = path.join(base, 'run')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ runId: 'flo_cr', status: 'completed', result: 1 }))
  const marker = path.join(dir, '.resuming')
  const old = new Date(Date.now() - 30_001)
  fs.writeFileSync(marker, String(old.getTime()))
  fs.utimesSync(marker, old, old)

  // race: a fresh marker lands between the stat and the claim rename (so the
  // claim is young) — and the link restore fails for a non-EEXIST reason
  const statSync = fs.statSync
  const linkSync = fs.linkSync
  let raced = false
  try {
    fs.statSync = (...args) => {
      const stat = statSync(...args)
      if (!raced && args[0] === marker) {
        raced = true
        const fresh = `${marker}.fresh`
        fs.writeFileSync(fresh, String(Date.now()))
        fs.renameSync(fresh, marker)
      }
      return stat
    }
    fs.linkSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
    assert.deepEqual(await deriveRunState(dir), { state: 'starting', result: null })
  } finally {
    fs.statSync = statSync
    fs.linkSync = linkSync
  }
  assert.equal(raced, true)
  // the rename fallback restored the fresh marker instead of unlinking the claim
  assert.equal(fs.existsSync(marker), true)
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.resuming.claim.')), false)
  assert.deepEqual(await deriveRunState(dir), { state: 'starting', result: null })
})

test('deriveRunState: an unstattable claim beaten by a newer marker is deleted, not leaked', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-claim-eexist-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dir = path.join(base, 'run')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ runId: 'flo_ce', status: 'completed', result: 2 }))
  const marker = path.join(dir, '.resuming')
  const old = new Date(Date.now() - 30_001)
  fs.writeFileSync(marker, String(old.getTime()))
  fs.utimesSync(marker, old, old)

  const statSync = fs.statSync
  try {
    fs.statSync = (...args) => {
      if (String(args[0]).includes('.resuming.claim.')) {
        // by the time the claim proves unstattable, a newer marker has landed —
        // the link restore must hit EEXIST and drop the redundant claim
        fs.writeFileSync(marker, String(Date.now()))
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      }
      return statSync(...args)
    }
    assert.deepEqual(await deriveRunState(dir), { state: 'starting', result: null })
  } finally {
    fs.statSync = statSync
  }
  assert.equal(fs.existsSync(marker), true)
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.resuming.claim.')), false)
})

test('deriveRunState: a fresh marker installed while an aged claim is swept wins — starting, not the stale result', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-claim-recheck-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dir = path.join(base, 'run')
  fs.mkdirSync(dir)
  const result = { runId: 'flo_rc', status: 'completed', result: 4 }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result))
  const marker = path.join(dir, '.resuming')
  const old = new Date(Date.now() - 30_001)
  fs.writeFileSync(marker, String(old.getTime()))
  fs.utimesSync(marker, old, old)

  // interleave: a concurrent launcher installs a FRESH marker right after the
  // aged one is claimed away (driven from the stat on the claim path — the
  // first step after the claim-rename). Returning the old terminal result
  // here would have the reader trust it while a live launch marker sits on
  // disk; the bounded recheck must see the fresh marker and report starting.
  const statSync = fs.statSync
  let interleaved = false
  try {
    fs.statSync = (...args) => {
      if (!interleaved && String(args[0]).includes('.resuming.claim.')) {
        interleaved = true
        fs.writeFileSync(marker, String(Date.now()))
      }
      return statSync(...args)
    }
    assert.deepEqual(await deriveRunState(dir), { state: 'starting', result: null })
  } finally {
    fs.statSync = statSync
  }
  assert.equal(interleaved, true)
  // the aged claim was swept; the fresh marker stands and keeps protecting
  assert.equal(fs.existsSync(marker), true)
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.resuming.claim.')), false)
  assert.deepEqual(await deriveRunState(dir), { state: 'starting', result: null })
  // once the fresh marker ages out too, the terminal result is served again
  fs.writeFileSync(marker, String(old.getTime()))
  fs.utimesSync(marker, old, old)
  assert.deepEqual(await deriveRunState(dir), { state: 'completed', result })
  assert.equal(fs.existsSync(marker), false)
})

test('deriveRunState: a leaked young claim still protects the launch window; aged claims are swept', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-claim-leak-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dir = path.join(base, 'run')
  fs.mkdirSync(dir)
  const result = { runId: 'flo_cl', status: 'completed', result: 3 }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result))
  // no .resuming marker at all — only a leaked claim (a restore that could
  // neither link nor rename back) guards the window
  const claim = path.join(dir, '.resuming.claim.999.leaked')
  fs.writeFileSync(claim, String(Date.now()))
  assert.deepEqual(await deriveRunState(dir), { state: 'starting', result: null })
  assert.equal(fs.existsSync(claim), true)
  const old = new Date(Date.now() - 30_001)
  fs.utimesSync(claim, old, old)
  assert.deepEqual(await deriveRunState(dir), { state: 'completed', result })
  assert.equal(fs.existsSync(claim), false)
})

test('deriveRunState: a held run.lock with a live pid overrides a stale terminal result.json', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lock-held-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dir = path.join(base, 'run')
  fs.mkdirSync(dir)
  const result = { runId: 'flo_lockheld', status: 'completed', result: 5 }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result))
  // marker aged out, no socket answering (the engine's event loop may be
  // blocked in synchronous preflight past the probe timeout) — classification
  // would trust the terminal file, but a held lock with a live pid (THIS
  // process) means an engine owns the run and the file is a previous attempt's
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  const held = await deriveRunState(dir)
  assert.equal(held.state, 'running')
  assert.equal(held.result, null)
  assert.match(held.detail, /run\.lock held by live pid/)
  // a corrupt result.json under a held lock is equally the previous attempt's
  fs.writeFileSync(path.join(dir, 'result.json'), '{')
  assert.equal((await deriveRunState(dir)).state, 'running')
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result))
  // dead holder: no engine owns the run — the terminal state stands
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: deadPid, startedAt: Date.now() }))
  assert.deepEqual(await deriveRunState(dir), { state: 'completed', result })
  // torn/unreadable lock proves nothing — the terminal state stands
  fs.writeFileSync(path.join(dir, 'run.lock'), '{')
  assert.deepEqual(await deriveRunState(dir), { state: 'completed', result })
})

test('deriveRunState: the result-less branch honors run.lock and classifies early crashes', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lock-resultless-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const mkdir = (name) => {
    const value = path.join(base, name)
    fs.mkdirSync(value)
    return value
  }

  // live lock, no result/heartbeat/socket: an engine owns the run but is still
  // in preflight (e.g. blocked in the synchronous module-graph scan) — before
  // the fix this read 'unknown' and waiters pended forever
  const held = mkdir('held')
  fs.writeFileSync(path.join(held, 'run.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  const state = await deriveRunState(held)
  assert.equal(state.state, 'running')
  assert.match(state.detail, /run\.lock held by live pid/)
  // a stale heartbeat under a held lock is the same blocked-live engine
  fs.writeFileSync(path.join(held, '.heartbeat'), String(Date.now() - 16_000))
  assert.equal((await deriveRunState(held)).state, 'running')

  // dead lock holder + a journal, no heartbeat: an attempt started and died
  // before its first heartbeat — crashed (stale), not pending forever
  const crashed = mkdir('crashed')
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid
  fs.writeFileSync(path.join(crashed, 'run.lock'), JSON.stringify({ pid: deadPid, startedAt: Date.now() }))
  fs.writeFileSync(path.join(crashed, 'journal.jsonl'), JSON.stringify({ t: 1, type: 'meta', runId: 'flo_early' }) + '\n')
  assert.equal((await deriveRunState(crashed)).state, 'stale')

  // journal with no lock at all — same early-crash classification
  const orphan = mkdir('orphan')
  fs.writeFileSync(path.join(orphan, 'journal.jsonl'), JSON.stringify({ t: 1, type: 'meta', runId: 'flo_orphan' }) + '\n')
  assert.equal((await deriveRunState(orphan)).state, 'stale')

  // bare dir: no attempt ever ran — stays unknown
  assert.equal((await deriveRunState(mkdir('bare'))).state, 'unknown')
})

test('cli: detached resume preflights the journal before creating a run directory', async (t) => {
  const flowitionHome = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-detach-preflight-'))
  t.after(() => fs.rmSync(flowitionHome, { recursive: true, force: true }))
  const runId = 'flo_bogus'
  const workflow = path.join(root, 'test', 'fixtures', 'basic.workflow.js')
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [bin, 'run', workflow, '--resume', runId, '--detach'], {
      env: { ...process.env, FLOWITION_HOME: flowitionHome },
      timeout: 5000,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })

  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `flowition: no journal for run ${runId}\n`)
  assert.equal(fs.existsSync(path.join(flowitionHome, 'runs', runId)), false)
})
