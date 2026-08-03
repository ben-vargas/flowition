// §6.2 `AgentView.cumTokens` — the zero-reset-aware lifetime-to-date token counter the
// cockpit's Q4 burn reading is built on (DESIGN §2.1 Q4, §6.4 J).
//
// `usage-cum` speaks two dialects (src/journal.js:5-8): the provider thread's cumulative
// totals, and the job's own per-attempt running totals whose counter restarts at {0,0}
// (src/agent-proc.js:42,482,520). The LAST record is therefore the lifetime figure in one
// dialect and the current attempt's figure in the other, so the snapshot chains positive
// deltas instead — exactly as Journal.load charges the budget (src/journal.js:100-116).
//
// Both dialects are pinned here, and the reset one FIRST: a suite that only ever fed a
// monotonic counter would pass against the reading this field exists to replace.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SnapshotStore } from '../src/viewer/snapshot.js'

const jsonl = (items) => items.map((r) => JSON.stringify(r)).join('\n') + '\n'
const ENGINE = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

function runDirWith(t, journal, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
    { t: 1, type: 'run', state: 'started', engine: ENGINE },
    { t: 2, type: 'agent', index: 0, key: 'k0', adapter: 'mock', state: 'running' },
  ]))
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), jsonl([
    { type: 'meta', createdAt: 1, workflowFile: '/tmp/tokens.js' },
    { type: 'started', key: 'k0', index: 0, adapter: 'mock' },
    ...journal,
  ]))
  return dir
}

const snapshot = (dir) => new SnapshotStore({
  deriveState: async () => ({ state: 'running' }),
}).get(dir)

test('cumTokens banks a per-attempt counter across its {0,0} restart', async (t) => {
  const dir = runDirWith(t, [
    // attempt 1 runs to 300/90 and settles
    { type: 'usage-cum', key: 'k0', cum: { input: 100, output: 40 } },
    { type: 'usage-cum', key: 'k0', cum: { input: 300, output: 90 } },
    { type: 'result', key: 'k0', index: 0, status: 'failed', usage: { input: 300, output: 90, cost: 0.5 }, durationMs: 10 },
    // attempt 2 starts: the adapter zeroes its own totals and runs back up to 50/25
    { type: 'usage-cum', key: 'k0', cum: { input: 0, output: 0 } },
    { type: 'usage-cum', key: 'k0', cum: { input: 50, output: 25 } },
  ], 'flo-tok-reset-')

  const agent = (await snapshot(dir)).agents[0]
  // The live counter is the RESTART, and reading it as the lifetime undercounts this
  // agent by 300/90 — everything the first attempt burned.
  assert.deepEqual(agent.liveTokens, { input: 50, output: 25 })
  assert.deepEqual(agent.usage, { input: 300, output: 90, cost: 0.5 })
  assert.deepEqual(agent.cumTokens, { input: 350, output: 115 })
  // The figure the UI reads: max(usage, cumTokens), componentwise.
  assert.equal(Math.max(agent.usage.output, agent.cumTokens.output), 115)
})

test('cumTokens counts a continued thread-cumulative report exactly once', async (t) => {
  const dir = runDirWith(t, [
    { type: 'usage-cum', key: 'k0', cum: { input: 40, output: 12 } },
    { type: 'result', key: 'k0', index: 0, status: 'failed', usage: { input: 40, output: 12, cost: 0.2 }, durationMs: 10 },
    // the resume continued the SAME provider thread, so its cum already contains the 12
    { type: 'usage-cum', key: 'k0', cum: { input: 55, output: 17 } },
  ], 'flo-tok-cont-')

  const agent = (await snapshot(dir)).agents[0]
  assert.deepEqual(agent.cumTokens, { input: 55, output: 17 })
  // 17, not 29: the settled record and the continued cum are the same tokens.
  assert.equal(Math.max(agent.usage.output, agent.cumTokens.output), 17)
})

test('cumTokens is absent when the key reported no usage-cum at all', async (t) => {
  const dir = runDirWith(t, [
    { type: 'result', key: 'k0', index: 0, status: 'completed', usage: { input: 7, output: 3, cost: 0.1 }, durationMs: 4 },
  ], 'flo-tok-none-')

  const agent = (await snapshot(dir)).agents[0]
  // Absent, not `{0,0}` — §2.3's "empty ≠ zero" reaches this field too, and a zeroed
  // chain would drag every such agent's lifetime figure down to the settled sum's floor.
  assert.equal(agent.cumTokens, null)
  assert.deepEqual(agent.usage, { input: 7, output: 3, cost: 0.1 })
})

test('cumTokens accumulates across incremental snapshot reads, not per read', async (t) => {
  const dir = runDirWith(t, [
    { type: 'usage-cum', key: 'k0', cum: { input: 100, output: 40 } },
  ], 'flo-tok-incr-')
  const store = new SnapshotStore({ deriveState: async () => ({ state: 'running' }) })

  const first = await store.get(dir)
  assert.deepEqual(first.agents[0].cumTokens, { input: 100, output: 40 })

  // The journal grows: a restart, then a fresh run-up. The store delta-reads from its
  // cached offset, so the chain has to survive being built in two passes.
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), jsonl([
    { type: 'usage-cum', key: 'k0', cum: { input: 0, output: 0 } },
    { type: 'usage-cum', key: 'k0', cum: { input: 70, output: 30 } },
  ]))
  const second = await store.get(dir)
  assert.deepEqual(second.agents[0].cumTokens, { input: 170, output: 70 })
  assert.deepEqual(second.agents[0].liveTokens, { input: 70, output: 30 })
})
