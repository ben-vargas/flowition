// Chained positional resume keys — deterministic and concurrency-invariant.
// Every parallel()/pipeline() call derives a branch node from a per-branch fan-out
// counter; every item gets its own sub-branch; every agent() chains off its branch
// with a local agent counter + content hash. The same workflow file replays to the
// same key sequence regardless of completion-order interleaving.
import { AsyncLocalStorage } from 'node:async_hooks'
import { sha256, canonical } from './util.js'

export const KEY_VERSION = 'k2' // k2: added `mode` to keyed spec fields
const als = new AsyncLocalStorage()

function seedState(branchKey, runSeed) {
  return parseInt(sha256(branchKey + '\0' + runSeed).slice(0, 8), 16) >>> 0
}

// `path` (DESIGN §8 E2) and `phase` (E1) are OBSERVATIONAL ONLY: makeCtx receives no
// parent context, so both are handed in / copied at the fan-out construction sites in
// the engine. Neither is an input to agentKey/deriveBranch — resume keys must stay
// byte-identical (pinned by test/engine-events.test.js).
export function makeCtx(branchKey, runSeed, path = []) {
  return { branch: branchKey, runSeed, agentIndex: 0, fanoutIndex: 0, questionIndex: 0, rngState: seedState(branchKey, runSeed), nowCount: 0, path, phase: null }
}

export const rootCtx = (runSeed) => makeCtx(sha256(KEY_VERSION + '\0root'), runSeed, [])
export const currentCtx = () => als.getStore()
export const withCtx = (ctx, fn) => als.run(ctx, fn)

export function deriveBranch(parentBranch, kind, index) {
  return sha256(KEY_VERSION + '\0' + parentBranch + '\0branch\0' + kind + '\0' + index)
}

export function agentKey(ctx, prompt, keyedFields) {
  const idx = ctx.agentIndex++
  return sha256(KEY_VERSION + '\0' + ctx.branch + '\0agent\0' + idx + '\0' + prompt + '\0' + canonical(keyedFields))
}

export const explicitKey = (k) => sha256(KEY_VERSION + '\0explicit\0' + k)

// mulberry32 over per-branch state — stable across resume, distinct per branch.
export function nextRandom(ctx) {
  ctx.rngState = (ctx.rngState + 0x6d2b79f5) >>> 0
  let t = ctx.rngState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
