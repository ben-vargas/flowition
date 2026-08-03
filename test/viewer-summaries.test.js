import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SummaryStore, decodeRunsCursor } from '../src/viewer/summaries.js'

const line = (rec) => JSON.stringify(rec) + '\n'

function seed(root, id, {
  createdAt = 1,
  workflowFile = `/tmp/${id}.js`,
  eventState = 'completed',
  journalFirst = { type: 'meta', runId: id, createdAt, workflowFile },
  bare = false,
} = {}) {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  if (!bare) {
    if (journalFirst) fs.writeFileSync(path.join(dir, 'journal.jsonl'), line(journalFirst))
    fs.writeFileSync(path.join(dir, 'events.jsonl'), line({
      t: createdAt + 1,
      type: 'run',
      runId: id,
      state: eventState === 'completed' ? 'started' : eventState,
      engine: '0.2.0',
      file: path.basename(workflowFile),
    }) + (eventState === 'completed' ? line({ t: createdAt + 2, type: 'run', runId: id, state: 'completed' }) : ''))
  }
  return dir
}

test('summary cache tiers, run.lock invalidation, meta identity, pruning, and custom/bare ids', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-sums-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const terminal = seed(root, 'named-run', { createdAt: 30 })
  seed(root, 'stale_one', { createdAt: 20, eventState: 'started' })
  seed(root, 'live.one', { createdAt: 10, eventState: 'started' })
  seed(root, 'bare_custom', { bare: true })
  fs.mkdirSync(path.join(root, '.invalid'))

  let now = 1000
  const calls = new Map()
  const deriveState = async (dir) => {
    const id = path.basename(dir)
    calls.set(id, (calls.get(id) ?? 0) + 1)
    if (id === 'named-run') return { state: fs.existsSync(path.join(dir, 'run.lock')) ? 'running' : 'completed' }
    if (id === 'stale_one') return { state: 'stale' }
    if (id === 'live.one') return { state: 'running' }
    return { state: 'unknown' }
  }
  const store = new SummaryStore({ root, deriveState, now: () => now })
  const cold = await store.list({ limit: 20 })
  assert.deepEqual(new Set(cold.runs.map((r) => r.runId)), new Set(['named-run', 'stale_one', 'live.one', 'bare_custom']))
  assert.equal(cold.runs[0].runId, 'bare_custom', 'a bare startup dir lists using its birthtime fallback')
  assert.equal(cold.totalOnDisk, 4)
  assert.deepEqual(Object.fromEntries(calls), { 'named-run': 1, stale_one: 1, 'live.one': 1, bare_custom: 1 })

  await store.list({ limit: 20 })
  assert.deepEqual(Object.fromEntries(calls), { 'named-run': 1, stale_one: 1, 'live.one': 1, bare_custom: 1 })
  now += 2001
  await store.list({ limit: 20 })
  assert.equal(calls.get('live.one'), 2, 'live tier re-derives at 2 seconds')
  assert.equal(calls.get('stale_one'), 1, 'quiescent tier remains cached')
  now += 28_000
  await store.list({ limit: 20 })
  assert.equal(calls.get('stale_one'), 2, 'quiescent tier re-derives at 30 seconds')
  assert.equal(calls.get('named-run'), 1, 'settled tier remains cached')

  fs.writeFileSync(path.join(terminal, 'run.lock'), '{}')
  const locked = await store.list({ limit: 20 })
  assert.equal(calls.get('named-run'), 2, 'run.lock invalidates a settled verdict immediately')
  assert.equal(locked.runs.find((r) => r.runId === 'named-run').state, 'running')
  fs.unlinkSync(path.join(terminal, 'run.lock'))

  // Atomic replacement guarantees a new inode even on filesystems that aggressively
  // reuse recently unlinked inode numbers.
  const replacement = path.join(terminal, 'journal.new')
  fs.writeFileSync(replacement, line({ type: 'meta', runId: 'named-run', createdAt: 30, workflowFile: '/tmp/recreated.js' }))
  fs.renameSync(replacement, path.join(terminal, 'journal.jsonl'))
  const recreated = await store.list({ limit: 20 })
  assert.equal(recreated.runs.find((r) => r.runId === 'named-run').workflowFile, '/tmp/recreated.js')

  fs.rmSync(path.join(root, 'live.one'), { recursive: true })
  const pruned = await store.list({ limit: 20 })
  assert.equal(pruned.totalOnDisk, 3)
  assert.ok(![...store.cache.keys()].some((p) => p.endsWith('live.one')))
})

test('end-first/torn meta handling and stable keyset pagination', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-page-sums-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const a = seed(root, 'a', {
    createdAt: 0,
    workflowFile: '/tmp/a.js',
    journalFirst: { t: 1, type: 'end', status: 'failed' },
  })
  seed(root, 'b', { createdAt: 20 })
  seed(root, 'c', { createdAt: 10 })
  const torn = path.join(root, 'torn')
  fs.mkdirSync(torn)
  fs.writeFileSync(path.join(torn, 'journal.jsonl'), JSON.stringify({ type: 'meta', runId: 'torn', createdAt: 40, workflowFile: '/tmp/torn.js' }))

  const store = new SummaryStore({ root, deriveState: async (dir) => ({ state: path.basename(dir) === 'b' ? 'running' : 'failed' }) })
  const first = await store.list({ limit: 2 })
  assert.equal(first.runs.length, 2)
  assert.ok(first.nextCursor)
  assert.deepEqual(decodeRunsCursor(first.nextCursor), {
    createdAt: first.runs[1].createdAt,
    runId: first.runs[1].runId,
  })

  // Directory mtime churn must not reorder the end-first run.
  const before = (await store.list({ limit: 20 })).runs.find((r) => r.runId === 'a').createdAt
  fs.writeFileSync(path.join(a, '.resuming'), '1')
  fs.unlinkSync(path.join(a, '.resuming'))
  const after = (await store.list({ limit: 20 })).runs.find((r) => r.runId === 'a').createdAt
  assert.equal(after, before)

  fs.appendFileSync(path.join(torn, 'journal.jsonl'), '\n')
  const retried = await store.list({ limit: 20 })
  assert.equal(retried.runs.find((r) => r.runId === 'torn').workflowFile, '/tmp/torn.js',
    'a complete formerly-torn first line is retried, not negatively cached')

  const second = await store.list({ limit: 2, cursor: first.nextCursor })
  assert.ok(second.runs.every((r) => !first.runs.some((p) => p.runId === r.runId)))
  const filtered = await store.list({ limit: 20, state: 'running', q: 'b' })
  assert.deepEqual(filtered.runs.map((r) => r.runId), ['b'])
})

test('run-list cache retains summary aggregates but no journal result values', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-light-sums-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = seed(root, 'result-heavy', { createdAt: 10 })
  const marker = 'FULL_RESULT_VALUE_MUST_NOT_BE_CACHED'
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), line({
    type: 'result',
    key: 'k',
    index: 0,
    status: 'completed',
    usage: { input: 3, output: 4, cost: 0.5 },
    result: { marker, payload: 'x'.repeat(64 * 1024) },
  }))
  const store = new SummaryStore({
    root,
    deriveState: async () => ({ state: 'completed' }),
  })
  const page = await store.list()
  assert.deepEqual(page.runs[0].spend, { input: 3, output: 4, cost: 0.5 })
  assert.equal('snapshots' in store, false)
  const cached = store.cache.get(dir)
  assert.ok(cached.folded)
  assert.equal(JSON.stringify({
    ...cached.folded,
    agents: [...cached.folded.agents],
    questions: [...cached.folded.questions],
    journalAnswers: [...cached.folded.journalAnswers],
  }).includes(marker), false)
})

test('5,000-run cache tier amortizes artifact stats and keeps signal probes immediate', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-view-5000-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const meta = line({ type: 'meta', createdAt: 1, workflowFile: '/tmp/perf.js' })
  const events = line({ t: 1, type: 'run', state: 'started', engine: '0.2.0', file: 'perf.js' })
  for (let i = 0; i < 5000; i++) {
    const dir = path.join(root, `run_${String(i).padStart(4, '0')}`)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), meta)
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events)
  }
  let metadataCalls = 0
  const fsImpl = {
    ...fs,
    statSync(...args) {
      metadataCalls++
      return fs.statSync(...args)
    },
    existsSync(...args) {
      metadataCalls++
      return fs.existsSync(...args)
    },
  }
  let now = 0
  let stateCalls = 0
  const store = new SummaryStore({
    root,
    fsImpl,
    now: () => now,
    deriveState: async (dir) => {
      stateCalls++
      return Number(path.basename(dir).slice(-4)) < 500
        ? { state: 'stale' }
        : { state: 'completed' }
    },
  })
  await store.list({ limit: 200 }) // cold cache fill
  metadataCalls = 0
  stateCalls = 0
  const page = await store.list({ limit: 200 })
  assert.equal(page.totalOnDisk, 5000)
  assert.equal(stateCalls, 0, 'quiescent rows do not re-probe inside the 30 second TTL')
  assert.ok(metadataCalls <= 5000 * 2,
    `P2 warm listing made ${metadataCalls} metadata calls (budget ${5000 * 2})`)

  metadataCalls = 0
  now += 6_001
  await store.list({ limit: 200 })
  assert.equal(metadataCalls, 5000 * 4,
    'the 6 second artifact TTL refreshes events/journal stats while keeping signal probes')
  assert.equal(stateCalls, 0, 'an artifact refresh does not bypass the 30 second quiescent TTL')

  now += 28_000
  await store.list({ limit: 200 })
  assert.equal(stateCalls, 500, 'only the 10% quiescent rows re-probe after 30 seconds')
})
