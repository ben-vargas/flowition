// The viewer process: startup, binding, the rendezvous file, instance discovery/reuse,
// auto-start, idle shutdown, and `--open` (DESIGN §4.1–§4.4).
//
// This module never imports the engine: it holds no run lock, never calls
// `runWorkflow`, and never executes a workflow module (§11.2 denylist, §7.4 "Viewer
// bug → executing a workflow"). The only engine-side import here is ../util.js.
//
// node: builtins + ../util.js only.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
// `home`/`runsDir` are deliberately NOT imported here: every path this module builds
// under the flowition home comes from `viewerHome()`/`viewerRunsDir()`, which assert
// §4.1's platform + ownership gate first (see auth.js's choke-point note).
import { runDir } from '../util.js'
import { loadOrCreateCredential, createCredentialGuard, inspectToken, tokenPath, mintControlToken, mintChallenge, verifyProof, parseCapabilities, CHALLENGE_HEADER, viewerHome, viewerRunsDir, assertViewerHome, assertViewerPlatform } from './auth.js'
import { attachRequestPipeline } from './http.js'
import { resolveDistRoot } from './static.js'
import { appendAudit } from './audit.js'
import * as routes from './routes.js'

export const DEFAULT_PORT = 4646
/** §4.2: a fixed port that is taken walks 4647–4655, then errors. */
export const PORT_WALK = 10
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15
const IDLE_CHECK_MS = 30_000
/** §4.2.1/§4.3: the challenge probe's budget. */
export const PROBE_TIMEOUT_MS = 500
/** §4.3 step 3: how long auto-start waits for a spawned viewer to come up. */
export const AUTOSTART_TIMEOUT_MS = 5000
const PROBE_MAX_BYTES = 64 * 1024

export const rendezvousPath = () => path.join(viewerHome(), 'viewer.json')
export const startupLockPath = () => path.join(viewerHome(), 'viewer.lock')
/** How long a caller waits for another process's discover→bind→publish to finish. */
export const LOCK_TIMEOUT_MS = 10_000
const LOCK_RETRY_MS = 25
/** How often a running server re-checks that its credential is still the one on disk. */
export const CREDENTIAL_CHECK_MS = 1000
/** How long a caller waits for a viewer whose credential was exposed to fail closed. */
export const REVOKE_WAIT_MS = 5000
const REVOKE_RETRY_MS = 50

/** Package version, read lazily — no JSON import assertions (Node 18.17 compat). */
export function viewerVersion() {
  try {
    const pkg = fileURLToPath(new URL('../../package.json', import.meta.url))
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * The §2.2 hash grammar, the one URL builder for everything the CLI prints. The token
 * rides in the **fragment**, which browsers never send over the network.
 */
export function viewerUrl({ port, token, controlToken, route = '/' }) {
  let url = `http://127.0.0.1:${port}/#${route}?t=${encodeURIComponent(token)}`
  if (controlToken) url += `&c=${encodeURIComponent(controlToken)}`
  return url
}

const collapseHome = (p) => {
  const h = os.homedir()
  return h && p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p
}

// §4.1's platform + ownership gate lives in auth.js, on the path accessor rather than at
// the call sites (see the choke-point note there): the only way this module can name a
// file under the flowition home is `viewerHome()`, which asserts first. Re-exported for
// the CLI and the tests; `assertOwnership` is kept as §4.1's name for it.
export { viewerHome, viewerRunsDir, assertViewerHome, assertViewerPlatform }
export { assertViewerHome as assertOwnership }

// ---- rendezvous file (§4.2) --------------------------------------------------------

export function writeRendezvous({ port, control }) {
  // `rendezvousPath()` asserts ownership and creates a missing home 0700 (§4.1).
  const file = rendezvousPath()
  const tmp = `${file}.${process.pid}.tmp`
  const body = JSON.stringify({ pid: process.pid, port, startedAt: Date.now(), control })
  fs.writeFileSync(tmp, body, { mode: 0o600 })
  try { fs.chmodSync(tmp, 0o600) } catch { /* non-posix fs */ }
  fs.renameSync(tmp, file)
}

/** Missing, unreadable, unparseable, or nonsensical → "no instance" (§4.2.1 step 1). */
export function readRendezvous() {
  // Resolved OUTSIDE the try: "this home is not yours" is a refusal that must reach the
  // caller, never a swallowed "no instance" that lets discovery carry on regardless.
  const file = rendezvousPath()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (!Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65535) return null
    return parsed
  } catch {
    return null
  }
}

function removeRendezvous(port) {
  // Only unlink our own record: a second instance on a custom port must not delete the
  // primary's rendezvous when it exits.
  const current = readRendezvous()
  if (current && current.pid === process.pid && current.port === port) {
    try { fs.unlinkSync(rendezvousPath()) } catch { /* already gone */ }
  }
}

// ---- the per-home startup lock (§13 Q2, Q7) ------------------------------------------

/**
 * Serialize discover → bind → publish, so "one viewer per home, prevented by the
 * port-reuse protocol" (§13 Q7) is actually true. Without it, two callers both read "no
 * instance" before either has bound, and both start — on adjacent ports, with the second
 * one's rendezvous record hiding the first.
 *
 * There are **two** races to close, and one lock file cannot close both:
 *
 * 1. *Across processes* — `$FLOWITION_HOME/viewer.lock`, published **atomically** inside
 *    the 0700 home and holding the owner's pid and a per-acquisition nonce. Staleness is
 *    decided by ownership, never by elapsed time: a lock whose pid is gone is reclaimed at
 *    once (the common case — a crashed starter), a lock whose pid is alive is waited for,
 *    and a lock with no readable owner is never reclaimed at all. Reclamation itself is
 *    serialized by a single-use claim on the dead lock's *inode identity*, because "read a
 *    dead pid, then unlink the name" lets the second contender delete the first
 *    contender's fresh lock — see `reclaimLockIfDead`.
 * 2. *Within one process* — `O_EXCL` cannot serialize two `startOrReuseViewer()` calls in
 *    the same process, because they would both be the same pid: the second `openSync`
 *    either succeeds against nothing or sees a lock it believes is its own. So each home
 *    also gets an in-process FIFO queue (`homeQueues`), and a call only reaches the file
 *    lock once the queue admits it. This is what makes
 *    `Promise.all([startOrReuseViewer(), startOrReuseViewer()])` produce one viewer and
 *    one reuse rather than two primaries on adjacent ports.
 *
 * **True nesting** — a call made inside the dynamic extent of a call that already holds
 * the lock — is the one case that must bypass both, or it would deadlock on its own
 * queue entry. It is detected with `AsyncLocalStorage`, which tracks the async context
 * that actually owns the lock; a concurrent sibling call has a different context and is
 * therefore queued, not waved through. (The previous revision keyed ownership on the file
 * path alone, so any concurrent call looked nested.)
 *
 * The critical section is never entered without ownership, and **a lock is never taken
 * from a live owner**. Unlinking the lock file does not stop the process holding it: an
 * earlier revision force-broke a live holder's lock on timeout and then entered, so two
 * processes ran discover → bind → publish concurrently — precisely the outcome the lock
 * exists to prevent, now with no lock at all. So on timeout this **fails loudly** and the
 * caller decides. Only a *demonstrably dead* owner is reclaimed (`kill(pid, 0)` says it is
 * gone), immediately and without waiting.
 *
 * **Publication is atomic, so there is no window in which a live owner looks ownerless.**
 * The previous revision created the lock with `open(…, 'wx')` and wrote the pid into it as
 * a second step, and it aged an unparseable lock out after 30 s. A creator descheduled
 * between those two steps therefore published an *empty* file — the one shape that made it
 * look like it had no owner — and could have its lock stolen while it was still on its way
 * into the critical section, which is the overlap the lock exists to prevent. Now the
 * metadata is written to a private temp file and `link(2)`ed into place: the lock name only
 * ever appears complete, exclusion and publication are the same indivisible step, and the
 * time bound is gone. A lock with no readable owner was therefore *not* written by any
 * viewer that is starting, so it is refused loudly (with the path to remove) rather than
 * aged out — the alternative is stealing from someone we cannot identify.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
const lockOwnership = new AsyncLocalStorage()
/** home lock path → tail of that home's FIFO queue. */
const homeQueues = new Map()

/** Take a place in this home's queue; resolves when it is our turn. */
function enterQueue(file) {
  const prev = homeQueues.get(file) ?? Promise.resolve()
  let leave
  const turn = new Promise((resolve) => { leave = resolve })
  const tail = prev.then(() => turn, () => turn)
  homeQueues.set(file, tail)
  return {
    ready: prev,
    leave: () => {
      leave()
      // Nobody queued behind us: drop the entry so the map does not grow forever.
      if (homeQueues.get(file) === tail) homeQueues.delete(file)
    },
  }
}

export async function withHomeLock(fn, { timeoutMs = LOCK_TIMEOUT_MS, retryMs = LOCK_RETRY_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), onDeadLock } = {}) {
  const file = startupLockPath()
  const owned = lockOwnership.getStore()
  // Genuinely nested: this call is running inside the section that already owns `file`.
  if (owned?.has(file)) return await fn()

  const queued = enterQueue(file)
  // Identifies *this* acquisition, so release only ever removes the exact file we
  // published — never a successor another process linked into the same name.
  const nonce = crypto.randomBytes(12).toString('hex')
  try {
    await queued.ready.catch(() => {})

    const deadline = now() + timeoutMs
    for (;;) {
      if (tryAcquireLock(file, nonce)) break
      // A demonstrably dead holder is reclaimed at once; every other path sleeps, so a peer
      // that keeps recreating the file cannot spin this loop hot.
      if (reclaimLockIfDead(file, onDeadLock) && tryAcquireLock(file, nonce)) break
      if (now() >= deadline) {
        // The holder is alive and has not finished inside the budget. Removing its lock
        // file would not stop it — it would only let us run concurrently with it, which is
        // the failure this lock exists to prevent. Fail loudly instead.
        throw new Error(lockTimeoutMessage(file, timeoutMs))
      }
      await sleep(retryMs)
    }

    const held = new Set(lockOwnership.getStore() ?? [])
    held.add(file)
    try {
      return await lockOwnership.run(held, fn)
    } finally {
      releaseLock(file, nonce)
    }
  } finally {
    queued.leave()
  }
}

/**
 * Two refusals, because they have different remedies: a live holder is something to wait
 * for, an unreadable lock is something for a human to delete. The second case can no
 * longer be produced by a viewer that is mid-start (publication is atomic), so it is never
 * reclaimed automatically — stealing from an owner we cannot identify is exactly the move
 * that lets two starters into the critical section at once.
 */
function lockTimeoutMessage(file, timeoutMs) {
  let identity = null
  try { identity = readLockIdentity(file) } catch { /* unreadable */ }
  const held = identity?.held
  if (Number.isInteger(held?.pid)) {
    // The third state, and the one worth naming precisely: the owner is gone, so the lock
    // *should* have been reclaimed, but a claim file left behind by a reclaimer that was
    // killed mid-reclaim blocks it — and claims are deliberately never auto-reclaimed.
    if (!processAlive(held.pid) && fs.existsSync(reclaimClaimPath(file, identity.ino))) {
      return `the viewer startup lock ${file} is owned by pid ${held.pid}, which is gone, but its reclamation claim ${reclaimClaimPath(file, identity.ino)} is still held after ${timeoutMs}ms — a reclaimer was killed mid-reclaim; remove both files if no viewer is starting`
    }
    // Our own pid is no longer assumed to be debris (see `reclaimLockIfDead`): it is either
    // another thread of this process or a starter whose pid we have since inherited, and the
    // message has to name both rather than the one that happens to be likelier.
    const who = held.pid === process.pid
      ? `another thread of this process (or a dead starter whose pid ${held.pid} this process now has)`
      : `another process (pid ${held.pid})`
    return `${who} is starting a viewer for this flowition home and has held ${file} for ${timeoutMs}ms — wait for it to finish, or remove that file if no viewer is starting`
  }
  return `the viewer startup lock ${file} names no owner this process can read, and is never reclaimed automatically — a starting viewer publishes that file atomically, so this one was not written by one; remove that file if no viewer is starting`
}

/**
 * Publish the lock **atomically**: metadata first, into a private temp name, then one
 * `link(2)` that both takes the lock and makes it complete. `link` fails `EEXIST` when the
 * name is taken, so it is the exclusion primitive too — there is no moment at which the
 * lock exists without naming its owner, and therefore no window in which a live starter
 * looks ownerless to a contender.
 */
function tryAcquireLock(file, nonce) {
  viewerHome()   // asserts ownership; creates the home 0700 if it went missing
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, nonce, startedAt: Date.now() }), { mode: 0o600 })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch { /* non-posix fs */ }
  try {
    fs.linkSync(tmp, file)
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
  }
}

/** Only our own lock is released — a successor in the same name is not ours to unlink. */
function releaseLock(file, nonce) {
  let held
  // Gone, or clobbered by something we did not write: not ours to remove either way.
  try { held = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
  if (held?.nonce !== nonce) return
  try { fs.unlinkSync(file) } catch { /* already gone */ }
}

/**
 * Read the lock and identify the exact *inode* behind the name, not just its contents.
 * `unlink` names a path, so a decision taken about "the lock" and acted on later can land
 * on a different file that has since taken the same name — which is the whole hazard below.
 *
 * @returns {{ino: string, raw: string, held: object|null}|null} null when the name is gone
 */
function readLockIdentity(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  try {
    const st = fs.fstatSync(fd)
    const raw = fs.readFileSync(fd, 'utf8')
    let held = null
    try { held = JSON.parse(raw) } catch { /* unreadable: refused, never reclaimed */ }
    // dev+ino alone are not enough: inode numbers are recycled, so a successor lock can be
    // handed the number this one just freed. The content hash carries the owner's 12 random
    // nonce bytes, which a successor cannot reproduce.
    const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
    return { ino: `${st.dev}-${st.ino}-${digest}`, raw, held }
  } finally {
    fs.closeSync(fd)
  }
}

/** The single-use claim that serializes the reclamation of one specific dead lock. */
const reclaimClaimPath = (file, ino) => `${file}.dead.${ino}`

/**
 * Reclaim a lock whose owner is demonstrably gone — **without ever unlinking a file on the
 * strength of an earlier read**.
 *
 * The bug this replaces: read the lock, see a dead pid, `unlink` the name. Every contender
 * reads the same dead pid, so every contender unlinks — and the second unlink removes the
 * lock the *first* contender has already published and is holding. Two processes then run
 * discover → bind → publish concurrently, two primaries bind, and the second's
 * `viewer.json` hides the first. Forty contenders against one dead-owner lock reproduced it
 * on the first round.
 *
 * The fix is a **claim file named after the dead lock's identity**, created `O_EXCL`:
 *
 *  - `link(2)`/`O_EXCL` makes exactly one contender the reclaimer *of that identity*, so at
 *    most one process is ever in a position to remove that inode;
 *  - a contender whose read is stale computes the identity of the lock it *saw*, so its
 *    claim can never authorize removing a successor — and it re-verifies inode + bytes
 *    inside the claim before unlinking anyway;
 *  - the claim is **never reclaimed on a timer or on liveness**, because a reclaimable
 *    reclamation claim is just the original race one level down. A reclaimer killed
 *    mid-reclaim therefore leaves a claim behind, the lock stops being reclaimable, and
 *    contenders time out with both paths to remove (`lockTimeoutMessage`) — a loud stall a
 *    human resolves, chosen over a silent double-primary.
 *
 * @param {() => void} [onDeadLock] a synchronous seam invoked once this call has decided the
 *   lock is dead and before it acts on that decision — the window the old code was wrong
 *   in. Blocking here lets a test make the interleaving deterministic instead of hoping a
 *   process herd lands in a microsecond gap. Test-only, like `loadOrCreateToken`'s `onWait`.
 * @returns {boolean} true when the lock is gone and acquisition should be retried at once
 */
function reclaimLockIfDead(file, onDeadLock) {
  let identity
  try {
    identity = readLockIdentity(file)
  } catch {
    return false                                      // unreadable: never stolen (see above)
  }
  if (!identity) return true                          // vanished — retry immediately
  const { held } = identity
  // No identifiable owner: same refusal as an unreadable file. A viewer that is starting
  // always has its pid in there before the name exists at all.
  if (!Number.isInteger(held?.pid)) return false
  // **A live pid is a live owner — including our own.** The previous revision exempted
  // `process.pid` on the theory that the in-process FIFO queue excludes every sibling
  // caller, so an own-pid lock had to be debris. That theory is false under
  // `worker_threads`: workers share `process.pid` but get their own module registry, hence
  // their own `homeQueues` and their own `lockOwnership` storage. Worker A holding the lock
  // is, to worker B, an own-pid lock with no queue entry — and B reclaimed it and entered
  // the critical section alongside A. A deterministic two-worker probe reproduced the
  // overlap.
  //
  // The only proof of ownership this process accepts is the `AsyncLocalStorage` context in
  // `withHomeLock`, which is per-thread and per-async-context and short-circuits *before*
  // the acquisition loop ever reaches here (`owned?.has(file)` → run `fn` directly). So by
  // construction a lock reaching this line is not proven ours, and liveness is the whole
  // test. The cost is the pid-reuse case (our pid equals that of a crashed starter): that
  // now times out loudly with the path to remove, which is the documented trade the rest of
  // this file already makes — a loud stall over a silent double-primary.
  if (processAlive(held.pid)) return false                               // a real starter: wait

  // Everything above is now a statement about the past. The identity captured with it is
  // what makes acting on it safe.
  onDeadLock?.()

  const claim = reclaimClaimPath(file, identity.ino)
  try {
    fs.closeSync(fs.openSync(claim, 'wx', 0o600))
  } catch {
    // EEXIST: another contender owns this dead lock's reclamation. Anything else (a home
    // that went away, a read-only mount) is not ours to work around.
    return false
  }
  try {
    // Inside the claim, and only now, confirm the name still resolves to the very inode and
    // bytes the decision was made about. Belt and braces: the claim already excludes every
    // other reclaimer of this identity, and only a reclaimer can make the name change.
    let current
    try {
      current = readLockIdentity(file)
    } catch {
      return false
    }
    if (!current) return true                         // someone (a human) already removed it
    if (current.ino !== identity.ino) return false    // a successor holds the name — not ours
    fs.unlinkSync(file)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return true
    return false
  } finally {
    // Retire the claim so the *next* generation of this lock is reclaimable. Safe in either
    // order: the identity it names is dead for good, and no future lock can reproduce it.
    try { fs.unlinkSync(claim) } catch { /* already gone */ }
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but not ours to signal. Inside a 0700 same-user home that should be
    // impossible; treat it as alive regardless, because stealing would be worse.
    return err.code === 'EPERM'
  }
}

// ---- the credential, coordinated with the listeners serving it (§7.1.2, §7.4) --------
//
// The finding: rotating an exposed `viewer.token` changed only the file. A viewer already
// running kept the original value in memory and kept answering 200 to it, so the leaked
// credential stayed live on the old port while `startOrReuseViewer` bound a second listener
// and replaced `viewer.json` — which hid the vulnerable one rather than revoking it.
//
// Rotation and revocation are therefore one operation, and it has two halves:
//
//   * **The listener's half** (`startViewer`): the credential is a live invariant. Every
//     `/api` request and a 1 s timer re-check it against disk, and any divergence — a
//     different value, a different inode, a mode that discloses it, a missing file — stops
//     authentication instantly and then closes the server (fail closed, refuse-before-close).
//   * **The rotator's half** (here): nothing mints a replacement until every listener that
//     could still be serving the old value is *provably* gone. `loadOrCreateCredential`
//     refuses to rotate without this clearance (see `exposedRefusal` in auth.js), so the
//     unsafe path is not reachable by forgetting to call something.
//
// Clearance never signals another user's process, and never takes anything on trust:
//   - listeners in *this* process are stopped and awaited — `close()` removes the rendezvous
//     record last, so the record's disappearance is proof the socket is closed;
//   - a listener in *another* process is waited for, because its own half fails it closed
//     within a second or two and its exit removes the record;
//   - a listener that does not go away inside the budget is a loud refusal naming its pid,
//     not a silent rotation behind its back (§4.2.1's "do not shadow a live instance").

/** home path → the live `startViewer` instances this process holds for that home. */
const liveInstances = new Map()

function registerInstance(homeKey, handle) {
  const set = liveInstances.get(homeKey) ?? new Set()
  set.add(handle)
  liveInstances.set(homeKey, set)
}

function unregisterInstance(homeKey, handle) {
  const set = liveInstances.get(homeKey)
  if (!set) return
  set.delete(handle)
  if (!set.size) liveInstances.delete(homeKey)
}

/**
 * Read `viewer.token` — and, when it has been exposed, revoke it end to end first.
 *
 * @param {{onRotate?: (info: object) => void, revokeWaitMs?: number, revokeRetryMs?: number,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number}} [opts]
 * @returns {Promise<{token: string, dev: number, ino: number, file: string}>}
 */
export async function establishCredential({
  onRotate,
  revokeWaitMs = REVOKE_WAIT_MS,
  revokeRetryMs = REVOKE_RETRY_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  // `inspectToken` never throws, so a foreign/unreadable home falls straight through to
  // `loadOrCreateCredential` below, which raises §4.1's precise refusal.
  if (inspectToken().kind === 'exposed') await clearExposedCredential({ revokeWaitMs, revokeRetryMs, sleep, now })
  // The clearance predicate is re-evaluated on every round of the rotation loop, not just
  // once here: a listener that appears mid-rotation must stop the next round dead.
  return loadOrCreateCredential({ onRotate, clearRotation: () => listenerStillServing() === null })
}

/**
 * The invariant a rotation needs: no listener for this home can still be serving the old
 * value. Synchronous, because `loadOrCreateCredential` is.
 *
 * A live pid in the rendezvous file is the whole test — that process owns the listening
 * socket, so a pid that is gone cannot be serving anything. A pid that is alive is taken at
 * its word (never signalled, never probed: an authenticated probe would need the very
 * credential that has just been condemned).
 *
 * @returns {object|null} the record that blocks a rotation, or null when nothing does
 */
function listenerStillServing() {
  if (liveInstances.get(viewerHome())?.size) return { pid: process.pid, port: null, inProcess: true }
  const record = readRendezvous()
  if (!record) return null
  if (!Number.isInteger(record.pid) || !processAlive(record.pid)) return null
  return record
}

async function clearExposedCredential({ revokeWaitMs, revokeRetryMs, sleep, now }) {
  const homeKey = viewerHome()
  const file = tokenPath()
  const reason = 'the viewer token file was exposed to other local users, so this instance\'s credential was revoked'
  const deadline = now() + revokeWaitMs
  for (;;) {
    // Ours first, and unconditionally: an instance this process holds is serving the exposed
    // value whether or not it is the one `viewer.json` names (a §13.7 secondary is not in
    // that file at all, and would otherwise survive the rotation still authenticating it).
    const mine = [...(liveInstances.get(homeKey) ?? [])]
    if (mine.length) {
      for (const handle of mine) {
        handle.revoke(reason)      // stops authenticating NOW, before the socket goes down
        await handle.close()       // resolves once the listener is closed and the record gone
      }
      continue
    }
    const blocking = listenerStillServing()
    if (!blocking) return
    if (now() >= deadline) {
      throw new Error(
        `${file} exposes the viewer token to other local users, so it must be rotated — but a viewer for this home is still running (pid ${blocking.pid}`
        + `${Number.isInteger(blocking.port) ? `, port ${blocking.port}` : ''}) and would keep serving the exposed credential from memory after a rotation. `
        + `It did not stop within ${revokeWaitMs}ms. Stop it and start the viewer again: kill ${blocking.pid} && flowition viewer`)
    }
    await sleep(revokeRetryMs)
  }
}

// ---- discovery & reuse (§4.2.1) ----------------------------------------------------

/**
 * The authenticated challenge probe. An unauthenticated `/healthz` shape authenticates
 * NOTHING (another local user can bind the predictable port and mimic the JSON), so the
 * probe sends a caller-chosen challenge and demands `hmacSHA256(token, challenge)` back.
 * The token itself is never transmitted — an impersonating listener learns nothing.
 *
 * @returns {Promise<{version: string|null}|null>} null when the listener is not ours
 */
export function challengeProbe(port, token, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const challenge = mintChallenge()
    let settled = false
    /** @type {import('node:http').ClientRequest|null} */
    let req = null
    /** @type {NodeJS.Timeout|null} */
    let deadline = null
    const done = (value) => {
      if (settled) return
      settled = true
      if (deadline) { clearTimeout(deadline); deadline = null }
      // Tear the socket down on every exit path, not just the failing ones: an abandoned
      // probe must not leave a connection open to a listener that may not be ours.
      try { req?.destroy() } catch { /* already gone */ }
      resolve(value)
    }
    // §4.2.1's 500 ms is a **wall-clock budget**, not a socket-inactivity timer. `timeout`
    // below only fires after `timeoutMs` of total silence, so a listener that trickles one
    // byte every 40 ms keeps resetting it and the probe runs as long as the peer likes —
    // hanging discovery, `--print-url`, auto-start and the startup lock's critical section
    // (a local denial of service, §7.4 "Impersonate the viewer"). This timer is absolute:
    // it starts before the request and is only cleared when the probe settles.
    deadline = setTimeout(() => done(null), timeoutMs)
    req = http.request({
      host: '127.0.0.1',
      port,
      path: '/healthz',
      method: 'GET',
      // Explicit Host so the probe satisfies the server's own allowlist regardless of
      // how node would format an IPv6 default.
      headers: { host: `127.0.0.1:${port}`, accept: 'application/json', [CHALLENGE_HEADER]: challenge },
      // Kept as a second, narrower bound (connect/inactivity), subordinate to the absolute
      // deadline above.
      timeout: timeoutMs,
      // A one-shot request with no keep-alive: the probe must not leave a pooled socket
      // open to a listener that may not even be ours.
      agent: false,
    }, (res) => {
      let body = ''
      let bytes = 0
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > PROBE_MAX_BYTES) { done(null); return }
        body += chunk
      })
      res.on('end', () => {
        if (res.statusCode !== 200) return done(null)
        let parsed
        try { parsed = JSON.parse(body) } catch { return done(null) }
        if (!parsed || parsed.app !== 'flowition-viewer') return done(null)
        // The previous revision's shape (app + homeHash, no proof) lands here and is
        // refused — that fixture is the Sol-2 regression test.
        if (!verifyProof(token, challenge, parsed.proof)) return done(null)
        done({ version: typeof parsed.version === 'string' ? parsed.version : null })
      })
      res.on('error', () => done(null))
    })
    req.on('error', () => done(null))
    req.on('timeout', () => done(null))
    req.end()
  })
}

/**
 * Find a live viewer for this home, proven to be ours (§4.2.1). Returns null when there
 * is no instance or when the listener on the recorded port fails the proof — in which
 * case **nothing token-bearing may be printed**.
 */
export async function discoverViewer({ timeoutMs = PROBE_TIMEOUT_MS, ...credentialOpts } = {}) {
  const record = readRendezvous()
  if (!record) return null
  // Reading the credential is where an exposed token file is discovered, and revoking it is
  // part of reading it (`establishCredential`): the instance this record names is failed
  // closed and confirmed gone *before* a replacement is minted, so discovery can never leave
  // a leaked token live on a port it has stopped pointing at.
  const { token } = await establishCredential(credentialOpts)
  // Re-read: a revocation may have stopped the instance this record named, in which case
  // there is now no instance at all — probing the port it used to hold would at best waste
  // the budget and at worst reach whatever bound it next.
  const current = readRendezvous()
  if (!current) return null
  const probed = await challengeProbe(current.port, token, timeoutMs)
  if (!probed) return null
  return {
    port: current.port,
    token,
    pid: Number.isInteger(current.pid) ? current.pid : null,
    control: Array.isArray(current.control) ? current.control : [],
    version: probed.version,
    reused: true,
  }
}

/**
 * Stop the live viewer registered for this home. Discovery-first: the pid in
 * `viewer.json` is only trusted after `discoverViewer`'s §4.2.1 challenge proof has
 * shown the recorded port is held by our live instance — a stale record naming a
 * recycled pid must never translate into a signal at whatever innocent process holds
 * that pid today, so an unproven record reports "nothing live", it does not kill.
 *
 * SIGTERM, because that is the sanctioned stop: it lands in the CLI's signal handler,
 * which closes the server, removes the rendezvous, and exits 0 (parity #29/#31).
 * `stopped: true` is a SETTLED fact — the process has exited — not a request receipt.
 * `rendezvousRemoved` rides along so a shutdown that died before its cleanup is
 * reported rather than discovered later as a mystery stale record.
 * Never calls `process.exit`; never signals a pid it cannot prove is the viewer.
 */
export async function stopViewer({ timeoutMs = 5_000, ...credentialOpts } = {}) {
  const found = await discoverViewer(credentialOpts)
  if (!found) return { stopped: false, reason: 'no live flowition viewer for this home' }
  if (!found.pid) {
    return { stopped: false, port: found.port, reason: `the live instance on port ${found.port} recorded no pid — stop it from its own terminal (Ctrl-C)` }
  }
  try {
    process.kill(found.pid, 'SIGTERM')
  } catch (err) {
    if (err.code === 'ESRCH') {
      return { stopped: false, pid: found.pid, port: found.port, reason: `viewer pid ${found.pid} exited between the liveness proof and the signal` }
    }
    throw err
  }
  const deadline = Date.now() + timeoutMs
  let alive = true
  while (Date.now() < deadline) {
    try { process.kill(found.pid, 0) } catch { alive = false }
    if (!alive && !fs.existsSync(rendezvousPath())) {
      return { stopped: true, pid: found.pid, port: found.port, rendezvousRemoved: true }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!alive) {
    // Dead but its record lingers: report it. Discovery fails closed on stale records
    // (the challenge proof cannot pass against nothing), so this is residue, not risk.
    return { stopped: true, pid: found.pid, port: found.port, rendezvousRemoved: false }
  }
  return { stopped: false, pid: found.pid, port: found.port, reason: `viewer pid ${found.pid} did not exit within ${timeoutMs}ms — it may be mid-request; retry, or kill ${found.pid}` }
}

// ---- idle shutdown (§4.4) ----------------------------------------------------------

/**
 * Activity bookkeeping. `sseClients` is incremented by the stream layer (W5);
 * `noteRunState` is called by the read layer (W6) as it derives run states, so the
 * viewer stays alive for a run that is genuinely producing output.
 *
 * critique N11: a "running" verdict alone is not activity. A SIGSTOPped engine, or a
 * reused-pid lock holder, would otherwise pin the viewer alive forever — so the run's
 * `events.jsonl` mtime must have advanced inside the idle window too.
 */
export function createActivity() {
  const liveRuns = new Map()
  return {
    sseClients: 0,
    liveRuns,
    noteRunState(runId, state) {
      if (state === 'running' || state === 'starting') {
        if (!liveRuns.has(runId)) liveRuns.set(runId, { mtimeMs: -1, advancedAt: Date.now() })
      } else {
        liveRuns.delete(runId)
      }
    },
  }
}

export function isActive(activity, idleWindowMs, now = Date.now()) {
  if (activity.sseClients > 0) return true
  for (const [runId, seen] of activity.liveRuns) {
    let mtimeMs
    try {
      mtimeMs = fs.statSync(path.join(runDir(runId), 'events.jsonl')).mtimeMs
    } catch {
      activity.liveRuns.delete(runId)
      continue
    }
    if (mtimeMs > seen.mtimeMs) { seen.mtimeMs = mtimeMs; seen.advancedAt = now }
    if (now - seen.advancedAt < idleWindowMs) return true
  }
  return false
}

// ---- startViewer -------------------------------------------------------------------

/**
 * Start the viewer. Never calls `process.exit` (parity #29) and never installs signal
 * handlers — the CLI owns both.
 *
 * @param {object} [opts]
 * @param {number} [opts.port] 0 binds an ephemeral port and skips the collision walk
 * @param {boolean|string|string[]} [opts.control] §7.2 capability opt-in
 * @param {boolean} [opts.idleShutdown]
 * @param {number} [opts.idleTimeoutMs]
 * @param {string} [opts.distRoot] override the SPA asset root (tests, dev)
 * @param {boolean} [opts.primary=true] whether this instance owns `viewer.json`. An
 *   **explicit secondary** (`--port N` against a home that already has a proven live
 *   viewer — the §13.7 escape hatch) passes `false`: it neither publishes the rendezvous
 *   nor removes it on close, so the primary stays discoverable for its whole life. There
 *   is exactly one rendezvous per home (§13.2) and it must describe the primary.
 * @param {(reason: 'idle'|'credential-revoked') => void} [opts.onShutdown] called after an
 *   idle close, and after a close forced by the credential being revoked
 * @param {(why: string) => void} [opts.onCredentialRevoked] called with the reason this
 *   instance stopped authenticating (§7.1.2) — never with a token value
 * @param {number} [opts.credentialCheckMs] how often the token file is re-verified
 * @returns {Promise<{url: string, port: number, home: string, control: string[], token: string, controlToken: string|null, primary: boolean, activity: object, close: () => Promise<void>}>}
 */
export async function startViewer(opts = {}) {
  // §4.1's gate, stated at the entry point it was written for. Every other path into the
  // home reaches the same assertion through `viewerHome()` (auth.js), so this call is a
  // clear early failure rather than the only thing standing between a foreign home and
  // the server.
  assertViewerHome()

  const capabilities = parseCapabilities(opts.control)
  // The credential comes with the inode it was read from, and the guard holds this instance
  // to both for its whole life: §7.1.2's "0600 file another local user cannot read" is the
  // boundary the entire read surface sits behind, so it is re-proven per request rather than
  // assumed from startup (see the credential section above).
  const credential = await establishCredential({ onRotate: opts.onRotate, revokeWaitMs: opts.revokeWaitMs })
  const token = credential.token
  const guard = createCredentialGuard(credential)
  const controlToken = capabilities.length ? mintControlToken() : null
  const activity = opts.activity ?? createActivity()
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MINUTES * 60_000
  const homeKey = viewerHome()

  const ctx = {
    token,
    // The request pipeline consults this before it compares a bearer token, so a revoked
    // instance answers 401 to every credential — the leaked one included (http.js).
    credential: guard,
    controlToken,
    capabilities,
    version: opts.version ?? viewerVersion(),
    home: viewerHome(),
    distRoot: opts.distRoot ?? resolveDistRoot(),
    routes,
    handlers: opts.handlers,
    accessLog: opts.accessLog,
    onInternalError: opts.onInternalError,
    activity,
    // The one audit sink (§7.3), handed to the routes rather than reimplemented by them:
    // W6's `args-read` line and W7's resume/delete/cancel lines go through this, the
    // same 0600 writer `flowition rm`/`prune` already use via src/retention.js.
    audit: appendAudit,
    port: 0, // filled in after bind; the host/origin allowlists read it live
  }

  const server = http.createServer({
    // §7.1.3/§7.1.4: node's default is to answer an HTTP/1.1 request that lacks a Host
    // header with its own bare 400 — before the request listener runs, and without the
    // CSP or any other security header. Turning the check off routes that request into
    // the pipeline's Host gate instead, which refuses it as `403 forbidden` in the §5.2
    // envelope with the full header set, like every other disallowed Host.
    requireHostHeader: false,
  })
  // Every node request path — request, checkContinue, checkExpectation, connect, upgrade,
  // clientError — goes through the one pipeline. Node answers each of the last five itself,
  // from the raw socket, with no envelope and none of §7.1.4's headers, unless it is
  // listened for; owning all of them is what makes "headers on every response" true.
  attachRequestPipeline(server, ctx)
  // Keep-alive sockets would make close() hang; track them so shutdown is prompt.
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  // These bound how long a client may take to SEND a request, not how long a response
  // may last — so a slowloris client is cut off while §5.6's long-lived SSE responses
  // are untouched (`server.timeout`, the socket-inactivity timer, stays 0 for them).
  server.headersTimeout = 30_000
  server.requestTimeout = 60_000

  // ---- teardown is built BEFORE the listener exists ---------------------------------
  //
  // The previous revision bound the port, published the rendezvous, and only then defined
  // `close()`. A failure in between (an unwritable `viewer.json` — EISDIR, EACCES, a full
  // disk) rejected the returned promise while the socket stayed bound and accepting: an
  // embedder held a hidden server it had no handle to, a retry walked to the next port,
  // and the requested port stayed occupied for the life of the process. So the close path
  // is constructed first and every post-bind step runs inside a try/catch that tears the
  // listener down before rethrowing. `close()` is safe to call at any point in startup:
  // nothing it touches is assumed to have happened.
  let closing = null
  let idleTimer = null
  let credentialTimer = null
  let published = false
  let boundPort = 0
  // What `clearExposedCredential` above holds this instance by: revoke marks the credential
  // dead and starts the close, close resolves once the socket is down and the record is gone.
  const handle = { revoke: (why) => revokeAndClose(why), close: () => close() }
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      if (idleTimer) clearInterval(idleTimer)
      if (credentialTimer) clearInterval(credentialTimer)
      for (const socket of sockets) socket.destroy()
      if (server.listening) await new Promise((resolve) => server.close(() => resolve()))
      // The listener is down BEFORE the rendezvous record goes, and that order is
      // load-bearing: a peer clearing an exposed credential waits for this record to
      // disappear as its proof that nothing is serving the old token any more
      // (`clearExposedCredential`). Removing the record first would make that proof a lie.
      // Only a record we actually wrote is ours to remove (§13.2) — a startup that failed
      // before publishing must not delete the live primary's. A home that has become
      // unreadable under us must not strand the listener either: shutting the socket down
      // matters more than tidying the file, which is why this runs last and swallows.
      if (published) { try { removeRendezvous(boundPort) } catch { /* stale record, no listener */ } }
      unregisterInstance(homeKey, handle)
    })()
    return closing
  }

  /**
   * Fail closed, in that order: the guard stops authenticating the instant the divergence is
   * seen, and only then does the listener come down. A close-then-refuse ordering would leave
   * a window in which the revoked credential still opened the read surface.
   */
  let revoking = null
  const revokeAndClose = (why) => {
    if (revoking) return revoking
    guard.revoke(why)
    revoking = close().catch(() => {}).then(() => {
      opts.onCredentialRevoked?.(why)
      opts.onShutdown?.('credential-revoked')
    })
    return revoking
  }

  /**
   * Stop the listener from holding the event loop open. An embedder (or a test fixture)
   * that wants the process to exit when its own work is done calls this: the server keeps
   * serving for as long as something else keeps the loop alive, and an in-flight request
   * is itself a ref'd handle, so nothing in progress is cut short. `close()` is still the
   * way to actually shut down.
   */
  const unref = () => {
    server.unref()
    for (const socket of sockets) socket.unref()
    return instance
  }

  const primary = opts.primary !== false
  let instance
  try {
    boundPort = await bind(server, resolvePort(opts.port))
    ctx.port = boundPort
    // Registered before the rendezvous is published and while the token is still known to be
    // good: from here on, anything in this process that needs to revoke this home's credential
    // can find this listener and stop it, whether or not it is the one `viewer.json` names.
    registerInstance(homeKey, handle)
    // §13.2: one rendezvous per home, describing the primary. A secondary publishes
    // nothing and, by never having written the file, removes nothing on close either.
    if (primary) {
      writeRendezvous({ port: boundPort, control: capabilities })
      published = true
    }

    // The credential watch runs for every instance, `--idle-shutdown` or not: it is not a
    // convenience, it is what makes revocation take effect on an idle server nobody is
    // currently talking to (the request-time check in http.js covers the rest). unref'd, so
    // like the idle timer it never holds the process open (parity #30).
    credentialTimer = setInterval(() => {
      const why = guard.check()
      if (why) revokeAndClose(why)
    }, opts.credentialCheckMs ?? CREDENTIAL_CHECK_MS)
    credentialTimer.unref()

    if (opts.idleShutdown) {
      let lastActiveAt = Date.now()
      idleTimer = setInterval(() => {
        const now = Date.now()
        if (isActive(activity, idleTimeoutMs, now)) { lastActiveAt = now; return }
        if (now - lastActiveAt < idleTimeoutMs) return
        close().then(() => opts.onShutdown?.('idle'), () => opts.onShutdown?.('idle'))
      }, opts.idleCheckMs ?? IDLE_CHECK_MS)
      idleTimer.unref()   // parity #30 — the timer must never hold the process open
    }

    instance = {
      url: viewerUrl({ port: boundPort, token, controlToken }),
      port: boundPort,
      home: viewerHome(),
      runsDir: viewerRunsDir(),
      control: capabilities,
      token,
      controlToken,
      primary,
      activity,
      server,
      close,
      unref,
      // Exposed for the tests and for an embedder that wants to know why its viewer stopped
      // serving; `revoke` is the same fail-closed path the watch and a peer's rotation use.
      credential: guard,
      revoke: (why) => revokeAndClose(why),
    }
  } catch (err) {
    // Destroys tracked sockets and closes the listener; then the caller sees the real
    // failure, with no server left behind and the requested port free again.
    await close().catch(() => {})
    throw err
  }
  return instance
}

/**
 * The CLI's entry point: **discover-then-start, serialized per home** (§4.2.1, §13.7).
 *
 * Discovery and binding are one critical section. Reading `viewer.json`, probing it and
 * binding a port are three steps, and two `flowition viewer` commands interleaving them
 * is exactly how a home ends up with two live servers on adjacent ports and a rendezvous
 * record that hides one of them. Holding the per-home lock across all three makes the
 * second caller see the first's published record and reuse it.
 *
 * `explicitPort` is the §13.7 escape hatch: "bind this port" is never satisfied by reuse,
 * but if a proven primary exists the new instance starts as a **secondary** and leaves
 * `viewer.json` alone.
 *
 * @param {object} opts everything `startViewer` takes, plus:
 * @param {boolean} [opts.explicitPort] the port came from `--port`, so never reuse
 * @param {(found: object) => void} [opts.onReuseRefused] called instead of reusing, to let
 *   the caller refuse (the `--control` case: a control token cannot be inherited)
 * @returns {Promise<{reused: boolean}>} a reuse record, or a started instance
 */
export async function startOrReuseViewer(opts = {}) {
  const { explicitPort = false, onReuseRefused, probeTimeoutMs, ...rest } = opts
  return withHomeLock(async () => {
    // Discovery is also where an exposed token file is revoked end to end, so the credential
    // options travel with it — inside the lock, so no second caller can bind against the
    // credential this one is in the middle of replacing.
    const found = await discoverViewer({ timeoutMs: probeTimeoutMs, onRotate: rest.onRotate, revokeWaitMs: rest.revokeWaitMs })
    if (found && !explicitPort) {
      onReuseRefused?.(found)   // may throw — the caller's refusal, inside the lock
      return { ...found, reused: true, url: viewerUrl({ port: found.port, token: found.token }) }
    }
    // A proven live primary + an explicit port = the deliberate second instance.
    const instance = await startViewer({ ...rest, primary: !found })
    return { ...instance, reused: false }
  })
}

function resolvePort(explicit) {
  if (explicit !== undefined && explicit !== null) return Number(explicit)
  const fromEnv = process.env.FLOWITION_VIEWER_PORT
  if (fromEnv) {
    const n = Number(fromEnv)
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`FLOWITION_VIEWER_PORT must be a port number, got "${fromEnv}"`)
    return n
  }
  return DEFAULT_PORT
}

/** §4.2: `--port 0` binds ephemeral and skips the walk; a fixed port walks +9. */
async function bind(server, first) {
  const candidates = first === 0 ? [0] : Array.from({ length: PORT_WALK }, (_, i) => first + i)
  let lastError
  for (const candidate of candidates) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => { server.removeListener('listening', onListening); reject(err) }
        const onListening = () => { server.removeListener('error', onError); resolve() }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(candidate, '127.0.0.1')
      })
      return server.address().port
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err
      lastError = err
    }
  }
  throw new Error(`no free port for the viewer in ${candidates[0]}–${candidates[candidates.length - 1]} (${lastError?.code ?? 'EADDRINUSE'})`)
}

// ---- auto-start on `flowition run` (§4.3) -------------------------------------------

/**
 * §4.3: auto-start only for foreground, human-attended runs. MCP and detached paths
 * never reach it — a background process must not spawn a server nobody asked for, and a
 * `--json` consumer must not get a URL on stderr it did not request.
 */
export function shouldAutoStart({ flags = {}, env = process.env, isTTY = false } = {}) {
  if (process.platform === 'win32') return false
  if (env.FLOWITION_NO_VIEWER === '1') return false
  if (flags['no-viewer']) return false
  if (flags.detach || flags.json || flags.quiet) return false
  return !!isTTY
}

/**
 * Discover or spawn a viewer and return the verified deep link — or null.
 *
 * The contract that matters (parity #34): this returns a URL only after a valid
 * challenge proof. If the viewer never came up, the caller prints nothing. A dead or
 * impersonated URL is never printed.
 */
export async function autoStartViewer(runId, {
  spawnFn = spawn,
  timeoutMs = AUTOSTART_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  pollIntervalMs = 150,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const route = runId ? `/run/${runId}` : '/'

  // Reuse a live instance — including a read-only one: starting a second server for the
  // same home would be worse, and the SPA shows its "controls locked" chip (§7.2).
  const existing = await discoverViewer({ timeoutMs: probeTimeoutMs })
  if (existing) return { ...existing, url: viewerUrl({ port: existing.port, token: existing.token, route }) }

  // Never a literal `node` (critique N6) and never `--control` (Sol-1): an auto-started
  // viewer is read-only until the operator opts in.
  const binPath = fileURLToPath(new URL('../../bin/flowition.js', import.meta.url))
  let child
  try {
    child = spawnFn(process.execPath, [binPath, 'viewer', '--idle-shutdown'], { detached: true, stdio: 'ignore', env: process.env })
  } catch {
    return null
  }
  child?.on?.('error', () => { /* the poll below reports the failure as "never came up" */ })
  child?.unref?.()

  const deadline = now() + timeoutMs
  for (;;) {
    const found = await discoverViewer({ timeoutMs: probeTimeoutMs })
    if (found) return { ...found, reused: false, url: viewerUrl({ port: found.port, token: found.token, route }) }
    if (now() >= deadline) return null
    await sleep(pollIntervalMs)
  }
}

// ---- --open (§4.2) -----------------------------------------------------------------

/**
 * Write the 0600 bootstrap file that hops to the tokenized URL. The point is that the
 * opener's argv carries a **file path**, never the URL: `ps` during `--open` must not
 * reveal the token (§7.4 "Steal token from process args/logs").
 */
export function writeOpenBootstrap(url) {
  const file = path.join(viewerHome(), `open-${crypto.randomBytes(8).toString('hex')}.html`)
  const attr = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = `<!doctype html><meta charset="utf-8"><title>flowition viewer</title>`
    + `<meta http-equiv="refresh" content="0;url=${attr}">`
    + `<script>location.replace(${JSON.stringify(url)})</script>`
  fs.writeFileSync(file, body, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* non-posix fs */ }
  return file
}

/**
 * Spawn the platform opener on the bootstrap file. Never blocks; failure only warns.
 * The file is unlinked ~10s later — see `scheduleBootstrapCleanup` for who does it.
 *
 * @returns {string} the bootstrap file path
 */
export function openInBrowser(url, { spawnFn = spawn, warn = (m) => process.stderr.write(m + '\n'), unlinkAfterMs = 10_000 } = {}) {
  const file = writeOpenBootstrap(url)
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawnFn(opener, [file], { detached: true, stdio: 'ignore' })
    child?.on?.('error', (err) => warn(`viewer: could not open a browser (${err.message}) — open ${file} manually`))
    child?.unref?.()
  } catch (err) {
    warn(`viewer: could not open a browser (${err.message}) — open ${file} manually`)
  }
  scheduleBootstrapCleanup(file, { spawnFn, warn, unlinkAfterMs })
  return file
}

/**
 * Delete the bootstrap file, from a process that is **not this one**.
 *
 * The grace period exists because the opener hands the path to a browser that reads it
 * moments later; deleting immediately would just break `--open`. But the callers that
 * most need `--open` — `--print-url --open`, and the reuse path — announce and return, and
 * `bin/flowition.js` then calls `process.exit()`. An `unref()`d in-process timer (the
 * previous revision) therefore never fired for them, and a 0600 file containing the read
 * token was left in the home indefinitely. A `process.on('exit')` unlink would be worse:
 * it fires milliseconds after the opener was spawned, so the browser would find nothing.
 *
 * So the deletion is delegated to a detached process that survives our exit — including a
 * `process.exit()`, a SIGINT to the foreground viewer (a new process group is exactly what
 * `detached` buys), or a crash. Its argv carries only the random file path and a delay,
 * never the URL or a token (§7.4).
 *
 * **Nothing about the deleter is resolved through `PATH`.** The previous revision spawned
 * `/bin/sh` by absolute path but had it run `sleep` and `rm`, which the shell looks up in
 * the inherited `PATH`: under a `PATH` that does not contain them (a stripped cron/systemd
 * environment, a `PATH=/definitely-missing` shell) the deleter exited immediately having
 * deleted nothing, and the 0600 file carrying the read *and* control tokens stayed in the
 * home indefinitely — silently, since the shell had already been spawned successfully and
 * the caller had exited. So the deleter is now `process.execPath` — the absolute path to
 * the node binary already running — evaluating a fixed program that needs no external
 * command at all. `NODE_OPTIONS` is dropped from its environment so an inherited
 * `--require` cannot break or outlive it.
 *
 * If it cannot be spawned at all, the file is removed **now** — a lost `--open` beats a
 * credential-bearing file with no deleter.
 */
// Deliberately mode-agnostic: `node -e` may evaluate as CJS or ESM, so this uses only
// globals (`process`, `setTimeout`) plus `import()`, which works in both. No `require`.
const CLEANUP_PROGRAM =
  'const [f, ms] = process.argv.slice(1)\n'
  + 'setTimeout(async () => { try { (await import("node:fs")).unlinkSync(f) } catch {} }, Number(ms))\n'

function scheduleBootstrapCleanup(file, { spawnFn = spawn, warn = () => {}, unlinkAfterMs = 10_000 } = {}) {
  const delayMs = Math.max(0, Math.round(unlinkAfterMs))
  const remove = () => { try { fs.unlinkSync(file) } catch { /* already gone */ } }
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  try {
    const child = spawnFn(process.execPath, ['-e', CLEANUP_PROGRAM, file, String(delayMs)], { detached: true, stdio: 'ignore', env })
    child?.on?.('error', (err) => {
      warn(`viewer: could not schedule cleanup of ${file} (${err.message}) — removing it now`)
      remove()
    })
    child?.unref?.()
  } catch (err) {
    warn(`viewer: could not schedule cleanup of ${file} (${err.message}) — removing it now`)
    remove()
  }
}

/** The §2.2 startup line, e.g. `viewer: http://…/#/?t=…  (reading ~/.flowition/runs)`. */
export const startupLine = (url) => `viewer: ${url}  (reading ${collapseHome(viewerRunsDir())})`
