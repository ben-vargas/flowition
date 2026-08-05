// Cross-run result seeding (`flowition run --seed-from <runId>`).
//
// Loads a TERMINAL source run's journal READ-ONLY and exposes its completed
// agent results as a candidate cache for a fresh run of a (typically edited)
// workflow. Derived agent keys hash branch position + prompt + canonical keyed
// spec — no run id, no seed, no workflow file hash (src/keys.js) — so an
// unchanged agent call derives the identical key across runs and can reuse the
// source's completed result, while an edited call (the reason resume refused)
// derives a new key and simply misses.
//
// This is a WEAKER guarantee than same-run resume, on purpose: key equality
// identifies the same call shape, but cross-run reuse does not pin workflow or
// import bytes, args, the deterministic now()/random() streams, environment or
// world state, or steering inputs. Seeding is therefore operator-authorized
// cache reuse for research/pure-result agents, never a freshness or
// correctness guarantee — and the exclusions below keep everything
// session-shaped or side-effect-shaped out:
//
//   - agent results only, final last-wins status === 'completed';
//   - NOT step() results — step keys don't hash the callback, and a completed
//     step proves a side effect happened in the OLD world, not the new one;
//   - NOT ask() answers, provider sessions, usage baselines, or steering mail;
//   - NOT results whose key ever ACCEPTED steering mail (any origin): mail is
//     not keyed but shaped the answer, so key equality doesn't cover it.
//     The exclusion is SOURCE-side only: steering newly added in the TARGET
//     (a spawn().send() around a seeded call) cannot retroactively invalidate
//     the hit — the result is materialized before the handle can send, so the
//     mail is dropped with a warning, same as any same-run cache replay. To
//     force real execution of an edited-steering call, change its prompt/spec
//     or give it an explicit `key`;
//   - explicit `o.key` results never seed — an explicit key matches even a
//     completely rewritten call, so content/position identity is void. That
//     exclusion is structural rather than filtered here: explicit keys hash in
//     their own domain (keys.js explicitKey), so a derived target key can never
//     collide with one, and the engine skips the seed lookup entirely when the
//     target call passes `key`.
//
// The journal is loaded WITHOUT {repair: true}: readers must never mutate a
// journal they don't own. A torn final record (source crashed mid-append) is
// tolerated by the strict reader as an ignored tail — that result simply
// doesn't seed; interior corruption refuses loudly. There is deliberately NO
// file-hash equality check between source and target — the feature exists for
// changed workflows — but the source's hashes are returned so the engine can
// record them as provenance.
import { Journal } from './journal.js'
import { runDir } from './util.js'
import * as K from './keys.js'
import { deriveRunState } from './run-state.js'

export class SeedError extends Error {}

// States under which the source journal has no live writer. Beyond the
// engine-written terminal statuses (completed/failed/interrupted), 'stale'
// is a crashed run — dead by every liveness signal deriveRunState checks
// (lock pid, control socket, heartbeat) — whose completed result records are
// just as sealed. Everything else refuses: running/starting have a live or
// imminent writer, corrupt-result and unknown are states where something is
// wrong enough that a loud refusal beats a quiet import.
const SEEDABLE_STATES = new Set(['completed', 'failed', 'interrupted', 'stale'])

export async function loadSeedSource(sourceRunId, { targetRunId = null } = {}) {
  const srcId = String(sourceRunId)
  if (targetRunId != null && srcId === String(targetRunId)) {
    throw new SeedError(`--seed-from ${srcId}: a run cannot seed itself`)
  }
  let dir
  try { dir = runDir(srcId) } catch (err) {
    throw new SeedError(`--seed-from ${srcId}: ${String(err?.message ?? err)}`)
  }

  let state
  try { state = Journal.load(dir) } catch (err) {
    throw new SeedError(`cannot seed from ${srcId}: ${String(err?.message ?? err)}`)
  }
  if (!state.meta) throw new SeedError(`cannot seed from ${srcId}: no journal found (is the run id right?)`)
  if (state.meta.keyVersion !== K.KEY_VERSION) {
    throw new SeedError(`cannot seed from ${srcId}: it was recorded with resume-key version ${state.meta.keyVersion}, this flowition uses ${K.KEY_VERSION} — its keys cannot match`)
  }

  const { state: runState } = await deriveRunState(dir)
  if (!SEEDABLE_STATES.has(runState)) {
    throw new SeedError(`cannot seed from ${srcId}: the run is ${runState} — only a settled run (completed/failed/interrupted/stale) can seed`)
  }

  const results = new Map() // key -> {result, index, usage}
  let excludedSteered = 0
  for (const [key, e] of state.results) {
    if (e.status !== 'completed') continue
    if (state.mailedKeys.has(key)) { excludedSteered++; continue }
    results.set(key, {
      result: e.result,
      index: e.index ?? null,
      // A source record that was ITSELF seeded carries usage: null with the
      // original numbers on its provenance field — surface those, so chained
      // seeding keeps exposing the real cost of the work being reused.
      usage: e.usage ?? e.seeded?.usage ?? null,
    })
  }

  return {
    runId: srcId,
    fileHash: state.meta.fileHash ?? null,
    graphHash: state.meta.graphHash ?? null,
    results,
    excludedSteered,
  }
}
