// Cross-run result seeding (--seed-from): an operator-authorized candidate cache
// from a settled source run. The acceptance cases follow the feature contract:
// derived-key hits seed and are durably materialized into the TARGET journal
// (usage null, source numbers on `seeded` provenance); keyed changes, explicit
// keys, steps, and steered source keys never seed; the target survives source
// deletion; a non-settled/corrupt/mismatched source refuses loudly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Short prefix on purpose: run dirs carry a control.sock, and macOS caps unix
// socket paths at 104 bytes — the usual verbose test prefix overflows it here.
process.env.FLOWITION_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-seed-'))

const { runWorkflow, WorkflowError } = await import('../src/engine.js')
const { loadSeedSource, SeedError } = await import('../src/seed.js')
const { runDir, runsDir, readJsonl, appendJsonl, ensureDir } = await import('../src/util.js')
const { Journal } = await import('../src/journal.js')
const { foldEvents } = await import('../src/events.js')
const { deriveRunState } = await import('../src/run-state.js')
const K = await import('../src/keys.js')
const { fold, materializeFold } = await import('../src/viewer/fold.js')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bin = path.join(root, 'bin', 'flowition.js')
const fx = (name) => path.join(root, 'test', 'fixtures', name)
const env = { ...process.env }

const newCounterFile = () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flo-seed-')), 'counters.json')
  fs.writeFileSync(f, '{}')
  return f
}
const counters = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const journalOf = (id) => readJsonl(path.join(runDir(id), 'journal.jsonl'))
const eventsOf = (id) => readJsonl(path.join(runDir(id), 'events.jsonl'))
const keyOfLabel = (id, label) => journalOf(id).find((e) => e.type === 'started' && e.label === label)?.key
const resultOfKey = (id, key) => journalOf(id).filter((e) => e.type === 'result' && e.key === key).at(-1)

const defaults = { adapter: 'mock' }

test('seed-from: derived hits seed with provenance; keyed/explicit/step shapes do not', async () => {
  const counterFile = newCounterFile()
  const args = { counterFile, model: 'm1' }

  const source = await runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true })
  assert.equal(source.status, 'completed')
  assert.deepEqual(counters(counterFile), { step: 1 })

  const target = await runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true, seedFrom: source.runId })
  assert.equal(target.status, 'completed')

  // agents replayed byte-identically; the step RE-RAN (steps never seed)
  assert.equal(target.result.stable, source.result.stable)
  assert.equal(target.result.tuned, source.result.tuned)
  assert.equal(target.result.pinned, source.result.pinned)
  assert.deepEqual(counters(counterFile), { step: 2 })
  assert.deepEqual(target.result.stepped, { ran: 2 })

  // target meta records the source provenance
  const meta = journalOf(target.runId).find((e) => e.type === 'meta')
  assert.equal(meta.seedFrom.runId, source.runId)
  assert.ok(meta.seedFrom.fileHash)
  assert.ok(meta.seedFrom.graphHash)

  // the two derived agents were materialized as seeded records: usage null
  // (zero target spend), source's numbers riding the provenance field
  const seeded = journalOf(target.runId).filter((e) => e.type === 'result' && e.seeded)
  assert.equal(seeded.length, 2)
  for (const rec of seeded) {
    assert.equal(rec.status, 'completed')
    assert.equal(rec.usage, null)
    assert.equal(rec.seeded.from, source.runId)
    assert.equal(rec.seeded.usage.output, 5) // the mock adapter's fixed per-turn usage
  }

  // the explicit-key agent executed for real: usage present, no provenance
  const pinned = resultOfKey(target.runId, K.explicitKey('pinned-key'))
  assert.equal(pinned.seeded, undefined)
  assert.equal(pinned.usage.output, 5)

  // budget accounting: seeded records contribute NOTHING to completed spend
  assert.equal(Journal.load(runDir(target.runId)).completedUsage.output, 5)

  // events + status fold carry the annotation
  const cachedEvents = eventsOf(target.runId).filter((e) => e.type === 'agent' && e.state === 'cached')
  assert.equal(cachedEvents.length, 2)
  for (const ev of cachedEvents) assert.equal(ev.seededFrom, source.runId)
  const snap = foldEvents(runDir(target.runId))
  const byLabel = new Map([...snap.agents.values()].map((a) => [a.label, a]))
  assert.equal(byLabel.get('stable').state, 'cached')
  assert.equal(byLabel.get('stable').seededFrom, source.runId)
  assert.equal(byLabel.get('tuned').seededFrom, source.runId)
  assert.equal(byLabel.get('pinned').state, 'done')
  assert.equal(byLabel.get('pinned').seededFrom, undefined)
})

test('seed-from: a changed keyed field derives a new key and misses', async () => {
  const counterFile = newCounterFile()
  const source = await runWorkflow({ file: fx('seed.workflow.js'), args: { counterFile, model: 'm1' }, defaults, quiet: true })

  const target = await runWorkflow({ file: fx('seed.workflow.js'), args: { counterFile, model: 'm2' }, defaults, quiet: true, seedFrom: source.runId })
  assert.equal(target.status, 'completed')

  const stable = resultOfKey(target.runId, keyOfLabel(source.runId, 'stable'))
  assert.equal(stable.seeded.from, source.runId)

  // same prompt, different model: new key, real execution
  const tuned = resultOfKey(target.runId, keyOfLabel(target.runId, 'tuned'))
  assert.equal(tuned.seeded, undefined)
  assert.equal(tuned.usage.output, 5)
  assert.notEqual(keyOfLabel(target.runId, 'tuned'), keyOfLabel(source.runId, 'tuned'))

  // tuned + pinned executed; only stable seeded
  assert.equal(Journal.load(runDir(target.runId)).completedUsage.output, 10)
})

test('seed-from: a source key that ever accepted steering mail is excluded', async () => {
  const counterFile = newCounterFile()
  const args = { counterFile, model: 'm1' }
  const source = await runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true })
  const stableKey = keyOfLabel(source.runId, 'stable')

  // journal-level simulation of an accepted steer: mailedKeys is computed from
  // `mail` records regardless of delivery, which is exactly the conservative rule
  appendJsonl(path.join(runDir(source.runId), 'journal.jsonl'), { t: Date.now(), type: 'mail', key: stableKey, id: 'steer-1', text: 'nudge', origin: 'operator' })

  const seed = await loadSeedSource(source.runId)
  assert.equal(seed.excludedSteered, 1)
  assert.equal(seed.results.has(stableKey), false)
  assert.equal(seed.results.has(keyOfLabel(source.runId, 'tuned')), true)

  const target = await runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true, seedFrom: source.runId })
  assert.equal(target.status, 'completed')
  const stable = resultOfKey(target.runId, stableKey)
  assert.equal(stable.seeded, undefined) // re-executed
  assert.equal(resultOfKey(target.runId, keyOfLabel(source.runId, 'tuned')).seeded.from, source.runId)
})

test('seed-from: target-side steering cannot invalidate a seed hit (the exclusion is source-side only)', async () => {
  const source = await runWorkflow({ file: fx('seed-steer.workflow.js'), args: { steer: false }, defaults, quiet: true })
  assert.equal(source.status, 'completed')

  const target = await runWorkflow({ file: fx('seed-steer.workflow.js'), args: { steer: true }, defaults, quiet: true, seedFrom: source.runId })
  assert.equal(target.status, 'completed')
  assert.equal(target.result.result, source.result.result, 'the seeded result stands despite the send')
  // the hit is materialized before the handle can deliver: the pre-await send
  // queues ('pending') and is dropped at settle; a post-settle send drops immediately
  assert.equal(target.result.delivery, 'pending')
  assert.equal(target.result.post, 'dropped')
  const rec = resultOfKey(target.runId, keyOfLabel(source.runId, 'steerable'))
  assert.equal(rec.seeded.from, source.runId)
  assert.equal(rec.usage, null)
  const warn = eventsOf(target.runId).find((e) => e.type === 'log' && e.level === 'warn' && /queued message\(s\) dropped/.test(e.message))
  assert.ok(warn, 'the dropped steering mail is surfaced, not silent')
  // nothing was ACCEPTED in the target either — the seeded key stays clean for further chaining
  assert.equal(journalOf(target.runId).some((e) => e.type === 'mail'), false)
})

test('seed-from: chained seeding names the immediate source but carries the original usage', async () => {
  const counterFile = newCounterFile()
  const args = { counterFile, model: 'm1' }
  const source = await runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true })
  const t1 = await runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true, seedFrom: source.runId })
  const t2 = await runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true, seedFrom: t1.runId })
  assert.equal(t2.status, 'completed')
  // agents replay byte-identically down the chain; the step re-ran each run
  assert.equal(t2.result.stable, source.result.stable)
  assert.equal(t2.result.tuned, source.result.tuned)
  assert.deepEqual(counters(counterFile), { step: 3 })

  const key = keyOfLabel(source.runId, 'stable')
  const original = resultOfKey(source.runId, key)
  assert.notEqual(original.usage, null)
  // provenance names the IMMEDIATE source; t1's record carries usage null, so
  // the loader's e.seeded?.usage fallback surfaces the ORIGINAL provider numbers
  assert.equal(resultOfKey(t1.runId, key).seeded.from, source.runId)
  const rec2 = resultOfKey(t2.runId, key)
  assert.equal(rec2.seeded.from, t1.runId)
  assert.deepEqual(rec2.seeded.usage, original.usage)
  assert.equal(rec2.usage, null, 'a chained hit still charges zero target spend')

  // both ancestors deleted: t2 replays from its own journal alone
  fs.rmSync(runDir(source.runId), { recursive: true, force: true })
  fs.rmSync(runDir(t1.runId), { recursive: true, force: true })
  const resumed = await runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true, resumeId: t2.runId })
  assert.equal(resumed.status, 'completed')
  assert.deepEqual(resumed.result, t2.result)
})

test('seed-from: a FAILED source seeds its completed results; target resumes after source deletion', async () => {
  const counter = `seedflaky-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const args = { counter }

  const source = await runWorkflow({ file: fx('seed-flaky.workflow.js'), args, defaults, quiet: true })
  assert.equal(source.status, 'failed')

  const target = await runWorkflow({ file: fx('seed-flaky.workflow.js'), args, defaults, quiet: true, seedFrom: source.runId })
  assert.equal(target.status, 'completed')
  assert.equal(target.result.stable, source.result?.stable ?? 'flaky-stable')
  // a seed hit writes no `started` record in the target (nothing started), so
  // the label→key lookup goes through the source journal
  const stableRec = resultOfKey(target.runId, keyOfLabel(source.runId, 'stable'))
  assert.equal(stableRec.seeded.from, source.runId)

  // the seed hit was materialized into the TARGET journal, so the source is disposable
  fs.rmSync(runDir(source.runId), { recursive: true, force: true })

  const resumed = await runWorkflow({ file: fx('seed-flaky.workflow.js'), args, defaults, quiet: true, resumeId: target.runId })
  assert.equal(resumed.status, 'completed')
  assert.deepEqual(resumed.result, target.result)

  // the resume replay keeps the provenance visible (event + fold)
  const replays = eventsOf(target.runId).filter((e) => e.type === 'agent' && e.state === 'cached' && e.seededFrom === source.runId)
  assert.ok(replays.length >= 2, 'fresh seed hit AND the resume replay both carry seededFrom')
  assert.deepEqual(replays.at(-1).seedUsage, { input: 10, output: 5, cost: 0 })
  const snap = foldEvents(runDir(target.runId))
  const stable = [...snap.agents.values()].find((a) => a.label === 'stable')
  assert.equal(stable.seededFrom, source.runId)
})

test('seed-from: loader refuses missing, corrupt, live, mismatched, and self sources', async (t) => {
  // missing run
  await assert.rejects(loadSeedSource('flo_does_not_exist'), (err) => err instanceof SeedError && /no journal found/.test(err.message))
  // malformed run id
  await assert.rejects(loadSeedSource('../escape'), SeedError)
  // self-seed
  await assert.rejects(loadSeedSource('flo_self', { targetRunId: 'flo_self' }), /cannot seed itself/)

  const mkRun = (id, records, { result } = {}) => {
    const dir = runDir(id)
    ensureDir(dir, 0o700)
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n')
    if (result) fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result))
    return dir
  }
  const meta = { t: 1, type: 'meta', runId: 'x', keyVersion: K.KEY_VERSION, fileHash: 'f', graphHash: 'g' }

  // interior corruption refuses loudly (readers never repair a journal they don't own)
  mkRun('flo_seed_corrupt', [meta, 'NOT JSON', { t: 2, type: 'end', status: 'completed' }], { result: { runId: 'flo_seed_corrupt', status: 'completed' } })
  await assert.rejects(loadSeedSource('flo_seed_corrupt'), /corrupt journal/)

  // key-version mismatch
  mkRun('flo_seed_oldkeys', [{ ...meta, keyVersion: 'k1' }, { t: 2, type: 'end', status: 'completed' }], { result: { runId: 'flo_seed_oldkeys', status: 'completed' } })
  await assert.rejects(loadSeedSource('flo_seed_oldkeys'), /resume-key version k1/)

  // live source: a fresh heartbeat and no result.json is a RUNNING run
  const liveDir = mkRun('flo_seed_live', [meta])
  fs.writeFileSync(path.join(liveDir, '.heartbeat'), String(Date.now()))
  await assert.rejects(loadSeedSource('flo_seed_live'), /the run is running/)

  // the same run gone quiet (stale heartbeat = crashed) IS seedable
  fs.writeFileSync(path.join(liveDir, '.heartbeat'), String(Date.now() - 60_000))
  const seed = await loadSeedSource('flo_seed_live')
  assert.equal(seed.results.size, 0)

  // a torn final record (crash mid-append) is tolerated: that result just doesn't seed
  mkRun('flo_seed_torn', [meta, { t: 2, type: 'end', status: 'completed' }], { result: { runId: 'flo_seed_torn', status: 'completed' } })
  fs.appendFileSync(path.join(runDir('flo_seed_torn'), 'journal.jsonl'), '{"type":"result","key":"torn')
  const torn = await loadSeedSource('flo_seed_torn')
  assert.equal(torn.results.size, 0)
})

test('seed-from: engine rejects seed+resume, self-seed, and seals admission failures terminally', async () => {
  const counterFile = newCounterFile()
  const args = { counterFile, model: 'm1' }
  const source = await runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true })

  // --seed-from + --resume refused, and the existing run's terminal state is untouched
  await assert.rejects(
    runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true, resumeId: source.runId, seedFrom: source.runId }),
    (err) => err instanceof WorkflowError && /fresh runs only/.test(err.message),
  )
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir(source.runId), 'result.json'), 'utf8')).status, 'completed')

  // a fresh run with a bad source is an ADMISSION failure: terminal artifacts exist
  await assert.rejects(
    runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true, runId: 'flo_seed_admit', seedFrom: 'flo_seed_nosuch' }),
    (err) => err instanceof WorkflowError && /no journal found/.test(err.message),
  )
  const sealed = JSON.parse(fs.readFileSync(path.join(runDir('flo_seed_admit'), 'result.json'), 'utf8'))
  assert.equal(sealed.status, 'failed')
  assert.match(sealed.error, /no journal found/)
  assert.equal(journalOf('flo_seed_admit').at(-1).type, 'end')
  // ...and the run lifecycle fully unwinds: lock released, control socket gone,
  // and the run reads as settled — nothing left that looks like a live writer
  assert.equal(fs.existsSync(path.join(runDir('flo_seed_admit'), 'run.lock')), false, 'admission failure releases the run lock')
  assert.equal(fs.existsSync(path.join(runDir('flo_seed_admit'), 'control.sock')), false, 'admission failure removes the control socket')
  assert.equal((await deriveRunState(runDir('flo_seed_admit'))).state, 'failed')

  // self-seed refused through the engine too
  await assert.rejects(
    runWorkflow({ file: fx('seed.workflow.js'), args, defaults, quiet: true, runId: 'flo_seed_self', seedFrom: 'flo_seed_self' }),
    /cannot seed itself/,
  )
})

test('seed-from: viewer fold sets seededFrom on cached and clears it on real execution', () => {
  const records = (events) => {
    let o = 0
    return events.map((rec) => ({ o: (o += Buffer.byteLength(JSON.stringify(rec)) + 1), rec }))
  }
  const seededOnly = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'cached', seededFrom: 'flo_src', seedUsage: { input: 10, output: 5 } },
  ]))
  assert.equal(seededOnly.agents[0].cached, true)
  assert.equal(seededOnly.agents[0].seededFrom, 'flo_src')
  // materialization (the SPA's view) carries the annotation through untouched
  assert.equal(materializeFold(seededOnly, 'completed').agents[0].seededFrom, 'flo_src')

  const reExecuted = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'cached', seededFrom: 'flo_src' },
    { t: 3, type: 'agent', index: 0, state: 'queued' },
    { t: 4, type: 'agent', index: 0, state: 'running' },
    { t: 5, type: 'agent', index: 0, state: 'done', durationMs: 3 },
  ]))
  assert.equal(reExecuted.agents[0].seededFrom, null, 'a real execution expires the annotation')
  assert.equal(reExecuted.agents[0].cached, false)

  // an ordinary same-run replay is cached WITHOUT provenance
  const plainCached = fold(null, records([
    { t: 1, type: 'run', state: 'started', engine: '0.2.0' },
    { t: 2, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'cached' },
  ]))
  assert.equal(plainCached.agents[0].seededFrom, null)
})

const cli = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env, timeout: 30000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout, stderr }),
    )
  })

test('seed-from: CLI rejects the resume combinations and pre-validates detached sources', async () => {
  const combo = await cli(['run', fx('basic.workflow.js'), '--resume', 'flo_a', '--seed-from', 'flo_b'])
  assert.notEqual(combo.code, 0)
  assert.match(combo.stderr, /--seed-from cannot be combined with --resume/)

  const onResume = await cli(['resume', 'flo_a', '--seed-from', 'flo_b'])
  assert.notEqual(onResume.code, 0)
  assert.match(onResume.stderr, /--seed-from applies to fresh runs only/)

  const badId = await cli(['run', fx('basic.workflow.js'), '--seed-from', '../escape'])
  assert.notEqual(badId.code, 0)
  assert.match(badId.stderr, /invalid run id/)

  // detached: the source is validated BEFORE any child is spawned or run dir created
  const before = new Set(fs.readdirSync(runsDir()))
  const detached = await cli(['run', fx('basic.workflow.js'), '--detach', '--seed-from', 'flo_seed_nosuch2'])
  assert.notEqual(detached.code, 0)
  assert.match(detached.stderr, /no journal found/)
  assert.deepEqual([...fs.readdirSync(runsDir())].filter((d) => !before.has(d)), [], 'no run artifacts for a refused detach')
})

test('seed-from: MCP flowition_run accepts and forwards seedFrom', async (t) => {
  const child = spawn(process.execPath, [bin, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const responses = []
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) responses.push(JSON.parse(line))
    }
  })
  const waitForId = (id, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const interval = setInterval(() => {
      const index = responses.findIndex((r) => r.id === id)
      if (index !== -1) { clearInterval(interval); resolve(responses.splice(index, 1)[0]) }
      else if (Date.now() - startedAt >= timeoutMs) { clearInterval(interval); reject(new Error('timed out waiting for MCP response')) }
    }, 10)
  })
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n')

  send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  const list = await waitForId(1)
  const runTool = list.result.tools.find((tool) => tool.name === 'flowition_run')
  assert.equal(runTool.inputSchema.properties.seedFrom.type, 'string')

  // an empty seedFrom is an invalid-params error, never silently ignored
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flowition_run', arguments: { file: fx('basic.workflow.js'), seedFrom: '' } } })
  const empty = await waitForId(2)
  assert.equal(empty.error?.code, -32602)

  // real invocation: the flag reaches the detached child's argv — its seed
  // admission fails on the missing source and seals the run terminally
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flowition_run', arguments: { file: fx('basic.workflow.js'), seedFrom: 'flo_seed_mcp_nosuch' } } })
  const started = await waitForId(3)
  const { runId } = JSON.parse(started.result.content[0].text)
  assert.ok(runId)
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'flowition_result', arguments: { runId, waitSeconds: 20 } } })
  const final = await waitForId(4, 25000)
  const res = JSON.parse(final.result.content[0].text)
  assert.equal(res.status, 'failed')
  assert.match(String(res.error), /no journal found/)
})
