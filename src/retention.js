// Retention — the only destructive capability in flowition (DESIGN §8 E13, §7.3).
//
// Two callers share this module: the CLI (`flowition rm` / `flowition prune`) and the
// viewer's DELETE route (which contains NO filesystem deletion code of its own). It is
// deliberately import-clean: `src/viewer/**` may import this file, so this file must
// never reach into ../engine.js (that would put runWorkflow in the viewer's module
// graph — DESIGN §7.4 "Viewer bug → executing a workflow" and the §11.2 denylist).
// The run lock therefore comes from ./run-lock.js — the ONE implementation the engine
// and the resume launchers use too, so a delete and a resume genuinely contend for the
// same lock instead of for two lookalike protocols that drift apart (§7.3.3).
//
// Everything here is written to fail CLOSED. A false refusal is a bug report; a false
// accept deletes a user's data. Where a check could go either way it refuses.
import fs from 'node:fs'
import path from 'node:path'
import { home, runsDir, runDir, ensureDir } from './util.js'
import { deriveRunState, listRunIds } from './run-state.js'
import { acquireRunLock as acquireLock, resumeMarks, RunLockError } from './run-lock.js'
import { appendAudit } from './viewer/audit.js'

// Trash entries survive a week (§7.3.4): "irreversible" becomes "recoverable for a week".
export const TRASH_TTL_DAYS = 7
const DAY_MS = 86_400_000
// A directory only counts as a flowition run if it holds at least one of these.
// runDir() proves a string is a safe child name — it does NOT prove the directory is
// ours, and the one irreversible operation must not remove arbitrary directories a
// user happened to place under runs/ (§7.3.2).
const RUN_ARTIFACTS = ['journal.jsonl', 'events.jsonl', 'result.json', 'run.log']
const TERMINAL_STATES = new Set(['completed', 'failed', 'interrupted', 'corrupt-result'])
// Mirrors run-state.js's STALE_MS. A heartbeat younger than this means an engine was
// alive within the window even if it no longer holds the lock — refuse and let the
// operator retry in a few seconds.
const HEARTBEAT_LIVE_MS = 15_000
// Only names this module could have produced are ever purged (see trashTarget).
const TRASH_ENTRY = /^(?<id>[A-Za-z0-9][A-Za-z0-9._-]*)\.(?<stamp>\d+)(?:-(?<seq>\d+))?$/

// `code` is a §5.2 ErrorCode so the viewer's DELETE route can map it without a
// translation table; `reason` is the precise refusal for logs, tests and CLI text.
export class RetentionError extends Error {
  constructor(message, { code = 'conflict', reason, runId } = {}) {
    super(message)
    this.name = 'RetentionError'
    this.code = code
    this.reason = reason
    if (runId != null) this.runId = runId
  }
}

const refuse = (message, code, reason, runId) => { throw new RetentionError(message, { code, reason, runId }) }

export const trashDir = () => path.join(home(), 'trash')

function hasRunArtifact(dir) {
  for (const name of RUN_ARTIFACTS) {
    // lstat, not stat: a symlink planted under the name of an artifact must not be
    // able to vouch for a directory as a flowition run.
    try { if (fs.lstatSync(path.join(dir, name)).isFile()) return true } catch { /* absent */ }
  }
  return false
}

// Resolve a run id to the real directory it names, refusing everything that is not
// unambiguously a run directory sitting directly inside the runs root (§7.3.1–2).
//
// Returns the IDENTITY of what it validated, not just a path: `{dir, dev, ino}`. A path
// is a name, and a name can be made to answer for a different directory a microsecond
// after the last check that used it — so every caller is required to carry this identity
// forward and prove that the object it goes on to lock, inspect and rename is the very
// object validated here (see `pinDir`). Returning a bare string is what let a swap
// between this function's return and the identity pin substitute a stranger for the
// validated run.
function resolveRunDir(runId) {
  let dir
  try { dir = runDir(runId) } catch (err) { refuse(err.message, 'bad_request', 'invalid_run_id', runId) }

  let st
  try { st = fs.lstatSync(dir) } catch (err) {
    if (err?.code === 'ENOENT') refuse(`run ${runId} does not exist`, 'not_found', 'missing', runId)
    refuse(`cannot stat run ${runId}: ${err?.message ?? err}`, 'internal', 'stat_failed', runId)
  }
  // Refused OUTRIGHT, never followed: following it would delete whatever it points at.
  if (st.isSymbolicLink()) refuse(`run ${runId} is a symlink — refusing to delete`, 'conflict', 'symlink', runId)
  if (!st.isDirectory()) refuse(`run ${runId} is not a directory — refusing to delete`, 'conflict', 'not_a_directory', runId)

  let root
  try { root = fs.realpathSync(runsDir()) } catch (err) {
    if (err?.code === 'ENOENT') refuse(`run ${runId} does not exist`, 'not_found', 'missing', runId)
    refuse(`cannot resolve runs directory: ${err?.message ?? err}`, 'internal', 'realpath_failed', runId)
  }
  let real
  try { real = fs.realpathSync(dir) } catch (err) {
    if (err?.code === 'ENOENT') refuse(`run ${runId} does not exist`, 'not_found', 'missing', runId)
    refuse(`cannot resolve run ${runId}: ${err?.message ?? err}`, 'internal', 'realpath_failed', runId)
  }
  // Strict equality, not a prefix test. The entry itself is known not to be a symlink,
  // so a symlinked ANCESTOR resolves identically on both sides and this still holds;
  // anything else (a mount trick, a raced swap) is an escape and is refused.
  if (real !== path.join(root, runId)) {
    refuse(`run ${runId} resolves outside the runs directory — refusing to delete`, 'conflict', 'outside_runs_root', runId)
  }
  // The lstat above and the containment check just made are two reads of the same NAME.
  // Re-stat so the identity this function reports is one that was still at the name when
  // containment was decided — otherwise a swap during the realpath pair would hand back
  // the identity of a directory whose containment was never actually established.
  let after = null
  try { after = fs.lstatSync(dir) } catch { after = null }
  if (!after || after.isSymbolicLink() || !after.isDirectory() || after.dev !== st.dev || after.ino !== st.ino) {
    refuse(`run ${runId} changed on disk during delete — refusing`, 'conflict', 'raced', runId)
  }
  return { dir: real, dev: st.dev, ino: st.ino }
}

// The engine's lock, unmodified (src/run-lock.js) — same file, same body, same
// reclaim protocol, same 10 attempts, same pid-reuse disambiguation, same aged-garbage
// rule. A crashed run whose lock is torn, or whose dead holder's pid was reused, is
// resumable by the engine and must therefore be deletable too; the previous private
// copy refused both and left such runs stuck forever.
// Refusals are translated into §5.2 error codes for the viewer's DELETE route:
//   live       → an engine owns the run                  → 409 conflict
//   acquiring  → a lock is mid-creation                   → 409 conflict
//   contention → someone else reclaimed it first          → 409 conflict
function acquireRunLock(dir, runId) {
  try {
    return acquireLock(dir)
  } catch (err) {
    if (err instanceof RunLockError) {
      const reason = err.code === 'live' ? 'live' : 'locked'
      refuse(`run ${runId}: ${err.message}`, 'conflict', reason, runId)
    }
    refuse(`cannot lock run ${runId}: ${err?.message ?? err}`, 'internal', 'lock_failed', runId)
  }
}

// SPEC NOTE (§7.3.3): the re-derive after acquiring the lock necessarily observes OUR
// OWN run.lock, and deriveRunState reports a lock held by a live pid as 'running' — so
// a literal reading makes every delete refuse itself. Disambiguated structurally rather
// than by parsing deriveRunState's detail string:
//   - 'starting'                            → live (a resume launch marker is young)
//   - 'running' with a live control socket  → live
//   - 'running' with a fresh heartbeat      → live
//   - 'running' with neither                → the verdict came from run.lock ALONE.
//
// That last case is decided by `lockIsOurs`, and run.lock is deliberately NOT judged
// here: deriveRunState calls any live pid in a lock file live (run-state.js:24–27 says
// so explicitly), while acquireRunLock can tell a genuine holder from a dead one whose
// pid the OS reused, and from garbage that has stayed unreadable long enough to be
// stale. Judging the lock twice, with the weaker judge holding a veto, is what made
// crashed runs the engine can still resume undeletable. So:
//   - before the lock: pass `true` — defer the lock-only verdict to acquireRunLock;
//   - under the lock:  pass `lock.stillOurs()` — ours iff the bytes on disk are ours,
//                      and any surprise falls to the refusing side.
function isLive(state, lockIsOurs) {
  if (state.state === 'starting') return true
  if (state.state !== 'running') return false
  if (state.live) return true
  if (state.heartbeatAgeMs != null && state.heartbeatAgeMs <= HEARTBEAT_LIVE_MS) return true
  return !lockIsOurs
}

// ─── filesystem identity ────────────────────────────────────────────────────────
//
// Every path-based guard in this module re-resolves `runs/<id>`, so none of them can
// survive a swap of that entry: an attacker who replaces the directory AFTER the last
// containment check still gets the replacement renamed into the trash, and the real run
// is left aside holding our lock. Names are not identities.
//
// `pinDir` takes the identity of the directory we validated — dev+ino, which names
// the directory itself rather than whatever currently answers to its name — and, where
// the platform allows opening a directory, holds an fd on it for the whole operation.
// The open fd matters: it keeps the inode allocated, so the number cannot be recycled by
// a replacement created after the original is unlinked. Windows refuses to open a
// directory; there the identity comes from lstat and is unpinned, which still catches
// every swap that does not additionally win an inode-number lottery.
//
// `expect` is the identity `resolveRunDir` validated, and it is REQUIRED to match what
// the descriptor actually opened. Without it the pin was self-certifying: it took
// whatever answered to `runs/<id>` at open time as the subject, so a swap in the window
// between resolveRunDir returning and this open made the REPLACEMENT the pin — and a
// replacement that is itself a terminal, artifact-bearing run then satisfied every
// subsequent check (artifacts, state, post-rename identity) on its own merits and was
// trashed, while the validated run sat aside. Matching against `expect` makes the
// validated directory and the pinned directory provably the same object; anything else
// returns null and the caller refuses `raced`.
function pinDir(dir, expect) {
  let fd = null
  try { fd = fs.openSync(dir, 'r') } catch { fd = null }
  const close = () => { if (fd != null) { try { fs.closeSync(fd) } catch { /* fine */ } fd = null } }
  let st = null
  try { st = fd != null ? fs.fstatSync(fd) : fs.lstatSync(dir) } catch { st = null }
  if (!st?.isDirectory()) { close(); return null }
  // `openSync` follows a symlink at the final component, so a link swapped in could open
  // the validated directory and fstat as it. That case is refused a line later by the
  // caller's `isPinned` (lstat-based, so it sees the link and answers no) — this check is
  // about the object, not the path.
  if (st.dev !== expect.dev || st.ino !== expect.ino) { close(); return null }
  return { dev: st.dev, ino: st.ino, close }
}

// Is `p` the very directory `pin` names? lstat, never stat: a symlink swapped in must
// answer "no" rather than vouch for its target.
function isPinned(pin, p) {
  let st
  try { st = fs.lstatSync(p) } catch { return false }
  return st.isDirectory() && st.dev === pin.dev && st.ino === pin.ino
}

// Put a directory back where it came from. Used by both rollback paths; never destroys
// data — rmdir refuses a non-empty directory by definition, so the only thing it can
// clear out of the way is an empty stub some other process left at the source name.
function restoreFrom(target, dir) {
  try { fs.renameSync(target, dir); return true } catch { /* name taken? */ }
  try { fs.rmdirSync(dir) } catch { /* not empty, or not there */ }
  try { fs.renameSync(target, dir); return true } catch { return false }
}

function trashTarget(runId, stamp) {
  const dir = trashDir()
  ensureDir(dir, 0o700)
  // Older homes may have created it at 0755 before this mode existed.
  try { fs.chmodSync(dir, 0o700) } catch { /* non-posix fs */ }
  const base = path.join(dir, `${runId}.${stamp}`)
  for (let n = 0; n < 1000; n++) {
    const target = n === 0 ? base : `${base}-${n}`
    try { fs.lstatSync(target) } catch { return target }
  }
  refuse(`cannot allocate a trash slot for ${runId}`, 'internal', 'trash_full', runId)
}

/**
 * Move one run to the trash, or refuse. Every guard in DESIGN §7.3 lives here.
 *
 * The canonical audit sink is NOT a parameter (§7.3 "Audit log"): `appendAudit` is
 * called internally and cannot be substituted, so there is no argument any caller —
 * viewer route, CLI, test — can pass that trashes a run without a line landing in
 * `$FLOWITION_HOME/viewer-audit.jsonl`. `observe` is a read-only tap on the same
 * records for callers that want to react to them; it runs AFTER the persisted write
 * and its throw is swallowed, so an observer can neither replace the audit nor change
 * the outcome of a delete.
 *
 * @param {string} runId
 * @param {{now?: number, observe?: (line: {op: string, runId: string, outcome: string, reason?: string}) => void, beforeCommit?: () => any, afterCommit?: () => any}} [opts]
 *   `beforeCommit`/`afterCommit` are test seams: they run inside the lock, immediately
 *   before and immediately after the rename, so both halves of the resume-vs-delete
 *   race can be driven deterministically instead of hoped for.
 * @returns {Promise<{runId: string, from: string, trashPath: string, trashedAt: number}>}
 */
export async function removeRun(runId, { now = Date.now(), observe, beforeCommit, afterCommit } = {}) {
  // A refusal destroyed nothing, so a failing audit writer must not mask the real
  // refusal reason. The pre-rename 'ok' line is different: it is the record that
  // survives the run, so a delete that cannot be recorded does not happen (log0).
  let audited = false
  const log = (outcome, reason) => { try { log0(outcome, reason) } catch { /* see log0 */ } }
  const log0 = (outcome, reason) => {
    const line = { op: 'delete', runId: String(runId), outcome, ...(reason ? { reason } : {}) }
    audited = true
    const written = appendAudit(line)
    if (observe) { try { observe(line) } catch { /* an observer never affects a delete */ } }
    return written
  }
  let dir
  let pin = null
  try {
    const resolved = resolveRunDir(runId)
    dir = resolved.dir
    // Pin the identity FIRST — before the lock, and before any guard that decides whether
    // this directory may be destroyed (§7.3.1–3). Every guard in this function reads
    // `runs/<id>` by path, so unless the identity of the directory they judge is fixed up
    // front, they vouch for one directory while the rename destroys another: pinning only
    // after the lock left exactly that hole, since the entry can be swapped between the
    // lock's creation and the pin, and the replacement then passes every remaining check
    // on its own merits and is the thing that moves. From this line on, the pin — dev+ino,
    // with an fd held so the inode cannot be recycled by a replacement — is the subject of
    // every check, and the post-rename verification proves the pin is what actually moved.
    // "Checked directory" and "destroyed directory" are therefore the same object.
    //
    // The pin is required to BE the directory resolveRunDir validated (`resolved`), not
    // merely whatever answers to the name when the descriptor opens: a swap in the gap
    // between the resolve and this open would otherwise make the replacement the pinned
    // subject, and the validated run's symlink/containment/identity checks would have
    // vouched for a directory that is no longer the one being destroyed.
    pin = pinDir(dir, resolved)
    if (!pin) refuse(`run ${runId} changed on disk during delete — refusing`, 'conflict', 'raced', runId)
    if (!hasRunArtifact(dir) || !isPinned(pin, dir)) {
      refuse(`run ${runId} has no flowition run artifacts (${RUN_ARTIFACTS.join(', ')}) — refusing to delete`, 'conflict', 'not_a_run', runId)
    }
    // Cheap pre-check: refuse an obviously live run (socket answering, fresh heartbeat,
    // launch marker) before touching its lock at all. A lock-only verdict is left to
    // acquireRunLock below — see isLive.
    const pre = await deriveRunState(dir)
    if (!isPinned(pin, dir)) refuse(`run ${runId} changed on disk during delete — refusing`, 'conflict', 'raced', runId)
    if (isLive(pre, true)) {
      refuse(`run ${runId} is live — cancel it before deleting`, 'conflict', 'live', runId)
    }
  } catch (err) {
    pin?.close()
    if (err instanceof RetentionError) log('refused', err.reason)
    throw err
  }

  let lock
  try {
    lock = acquireRunLock(dir, runId)       // throws RetentionError; nothing to release
  } catch (err) {
    pin.close()
    throw err
  }
  let target
  try {
    // The lock excludes a concurrent engine only if it is a lock ON THE PINNED DIRECTORY.
    // It was created by path (`runs/<id>/run.lock`), so that holds iff the name still
    // resolves to the pinned directory AND the bytes at that path are still our own —
    // a swap during the acquisition puts our lock inside the directory that was carried
    // away, and one of these two answers no. Neither the run nor the replacement is
    // touched in that case; our lock file stays inside the directory the swap removed
    // from `runs/`, where its only effect is to make a later delete of that directory
    // refuse — the failing side this module is required to fail on.
    if (!isPinned(pin, dir) || !lock.stillOurs()) {
      refuse(`run ${runId} changed on disk during delete — refusing`, 'conflict', 'raced', runId)
    }
    // Re-validated UNDER the lock (§7.3.2): the pre-lock artifact check is a cheap
    // early refusal, not the guarantee. This is the one that holds.
    if (!hasRunArtifact(dir) || !isPinned(pin, dir)) {
      refuse(`run ${runId} has no flowition run artifacts (${RUN_ARTIFACTS.join(', ')}) — refusing to delete`, 'conflict', 'not_a_run', runId)
    }
    // The marker baseline is taken FIRST — strictly before the state check it guards.
    //
    // The two halves of the resume-vs-delete exclusion are the derivation below (a
    // marker already on disk reads as 'starting' → refuse) and the post-rename diff
    // against this baseline (a marker that appeared later travelled into the trash
    // entry → roll back). Between them they must leave NO uncovered instant, and a
    // baseline captured after the derivation does: `deriveRunState` reads the marker
    // path at its very start and then keeps going (control-socket probes, lock reads),
    // so a `.resuming` installed during that tail would be invisible to the derivation
    // AND already present in a later baseline — the diff would find nothing new and the
    // delete would commit against an accepted resume handoff. Ordering it first makes
    // the two windows overlap instead of leaving a seam:
    //   installed before this line   → also visible to the derivation → refused there
    //   installed after this line    → not in the baseline            → caught by the diff
    // (Removals are irrelevant: the diff is additive, so the derivation's own sweep of
    // an aged marker cannot cause a false rollback. A `.resuming.claim.*` that
    // run-state.js fails to restore does read as an addition — a false refusal, which
    // is the side this module is required to fail on.)
    const marksBefore = new Set(resumeMarks(dir))
    // Re-derive UNDER the lock: this is one half of the TOCTOU the pre-check cannot
    // close. A resume launched in between either holds the lock (acquire above failed)
    // or has written its .resuming marker (state 'starting' here) — either way delete
    // loses, which is the specified outcome.
    const state = await deriveRunState(dir)
    // The derivation read `runs/<id>` by path; the verdict is only about the directory we
    // are deleting if that name was still the pinned directory when the read finished.
    if (!isPinned(pin, dir)) refuse(`run ${runId} changed on disk during delete — refusing`, 'conflict', 'raced', runId)
    if (isLive(state, lock.stillOurs())) {
      refuse(`run ${runId} is live — cancel it before deleting`, 'conflict', 'live', runId)
    }
    // The OTHER half: a detached resume never holds the lock across its spawn (§7.3
    // forbids the launcher holding one), so between the baseline above and the rename
    // below a launcher can still install `.resuming` and report launchAccepted. The
    // rename is the one point both sides linearize on (see run-lock.js), so the delete
    // COMMITS and then verifies: a marker that appeared in the window moved into the
    // trash entry with the run, and finding one there means a resume was accepted
    // against this run — so the delete undoes itself and loses, per §7.3.3.
    //
    // Defense in depth: re-prove containment AND identity immediately before the
    // irreversible step, in case the entry was swapped while we derived state. This
    // narrows the window; it cannot close it (any path check is stale the instant it
    // returns), which is why the rename is verified against `pin` afterwards.
    const recheck = resolveRunDir(runId)
    if (recheck.dir !== dir || recheck.dev !== pin.dev || recheck.ino !== pin.ino || !isPinned(pin, dir)) {
      refuse(`run ${runId} changed on disk during delete — refusing`, 'conflict', 'raced', runId)
    }
    target = trashTarget(String(runId), now)
    if (beforeCommit) await beforeCommit({ runId: String(runId), dir, target })
    try { log0('ok') } catch (err) {
      refuse(`cannot record the delete of ${runId} in the audit log: ${err?.message ?? err}`, 'internal', 'audit_failed', runId)
    }
    try {
      // Atomic rename inside the flowition home — never a recursive copy+unlink, which
      // would have a half-deleted state. EXDEV (trash on another filesystem) refuses
      // rather than degrading to a non-atomic delete.
      fs.renameSync(dir, target)
    } catch (err) {
      log('error', err?.code ?? 'rename_failed')
      if (err?.code === 'EXDEV') {
        refuse(`cannot trash run ${runId}: ${trashDir()} is on a different filesystem than ${runsDir()}`, 'internal', 'cross_device', runId)
      }
      refuse(`cannot trash run ${runId}: ${err?.message ?? err}`, 'internal', 'rename_failed', runId)
    }
    if (afterCommit) await afterCommit({ runId: String(runId), dir, target })
    // THE authoritative check, and the reason `pin` exists: `renameSync` resolved
    // `runs/<id>` itself, so whatever occupied that name at that instant is what now sits
    // in the trash. If it is not the directory we locked, artifact-checked and contained,
    // then every one of those guards judged a different directory than the one that
    // moved — so undo the move and refuse. This runs BEFORE the resume-race diff, which
    // would otherwise be reading marks out of a stranger's directory.
    if (!isPinned(pin, target)) {
      const restored = restoreFrom(target, dir)
      // Nothing of ours is inside `target` — it is not our run — so its contents are
      // never touched, not even to strip a run.lock.
      log('rolled-back', 'identity_changed')
      if (!restored) {
        refuse(`run ${runId} was replaced on disk while the delete was committing and the replacement could NOT be put back — it is in ${target}`, 'internal', 'rollback_failed', runId)
      }
      refuse(`run ${runId} was replaced on disk while the delete was committing — the directory that moved was restored and the delete refused`, 'conflict', 'raced', runId)
    }
    const raced = resumeMarks(target).filter((m) => !marksBefore.has(m))
    if (raced.length) {
      const restored = restoreFrom(target, dir)
      // Release before refusing, not in the finally: the resume that just won is about
      // to ask for this same lock, and it must not find the loser still holding it.
      lock.release()
      log('rolled-back', 'resume_raced')
      if (!restored) {
        // Wildly unlikely (the source name was free microseconds ago) and the only
        // outcome that is neither "deleted" nor "intact" — so it is reported loudly,
        // with the path the run is recoverable from.
        try { fs.unlinkSync(path.join(target, 'run.lock')) } catch { /* fine */ }
        refuse(`a resume of ${runId} raced this delete and the run could NOT be restored — it is in ${target}`, 'internal', 'rollback_failed', runId)
      }
      refuse(`a resume of run ${runId} was launched while the delete was committing — the run was restored and the delete refused`, 'conflict', 'live', runId)
    }
  } catch (err) {
    // Exactly one line per delete: the rename/audit/rollback paths have already written
    // theirs, so only a refusal that has said nothing yet gets recorded here.
    if (err instanceof RetentionError && !audited) log('refused', err.reason)
    throw err
  } finally {
    // release() unlinks only if `runs/<id>/run.lock` still holds OUR exact bytes, so a
    // no-op once released above, once the dir has moved, and — importantly — when a
    // rolled-back swap has left a stranger's directory sitting at that name.
    lock.release()
    pin?.close()
  }
  // The lock travelled with the directory. Left in place, a manually restored trash
  // entry would report 'running' for as long as our pid stays alive.
  try { fs.unlinkSync(path.join(target, 'run.lock')) } catch { /* fine */ }
  return { runId: String(runId), from: dir, trashPath: target, trashedAt: now }
}

/**
 * Purge trash entries. Only entries this module could have created are ever removed —
 * anything else under trash/ is left untouched.
 *
 * @param {{olderThanMs?: number, now?: number}} [opts] `olderThanMs: 0` empties it.
 */
export function purgeTrash({ olderThanMs = TRASH_TTL_DAYS * DAY_MS, now = Date.now() } = {}) {
  const purged = []
  const dir = trashDir()
  let root
  try { root = fs.realpathSync(dir) } catch { return { purged } }
  let ents = []
  try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { return { purged } }
  for (const e of ents) {
    const m = TRASH_ENTRY.exec(e.name)
    if (!m) continue                       // foreign file — not ours to delete
    const p = path.join(root, e.name)
    let st
    try { st = fs.lstatSync(p) } catch { continue }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    // The stamp is authoritative (mtime moves when a user pokes at a trashed run);
    // an unparseable stamp cannot happen given the regex, so mtime is a pure fallback.
    const at = Number(m.groups.stamp)
    const trashedAt = Number.isFinite(at) && at > 0 ? at : st.mtimeMs
    if (now - trashedAt < olderThanMs) continue
    let real
    try { real = fs.realpathSync(p) } catch { continue }
    if (real !== p) continue               // escaped the trash root — leave it alone
    try { fs.rmSync(real, { recursive: true, force: true }) } catch { continue }
    purged.push({ entry: e.name, runId: m.groups.id, trashedAt })
  }
  return { purged }
}

// Newest artifact touch, used as "when did this run last do anything". mtimes, not
// journal contents: prune must not depend on parsing a possibly-corrupt journal.
function lastActivityMs(dir) {
  let newest = 0
  const bump = (p) => { try { newest = Math.max(newest, fs.lstatSync(p).mtimeMs) } catch { /* absent */ } }
  bump(dir)
  for (const name of RUN_ARTIFACTS) bump(path.join(dir, name))
  return newest
}

/**
 * Trash terminal runs older than `olderThanDays` and purge aged trash entries.
 * Pruned runs go to the TRASH, not to oblivion — a mistaken retention policy is
 * recoverable for `trashTtlDays` like every other delete.
 *
 * Each trashed run gets its own audit line, from the same unsubstitutable writer and
 * under the same fail-closed rule as a single `removeRun` — a bulk operation is not a
 * licence to destroy unrecorded runs.
 *
 * @param {{olderThanDays?: number, trashTtlDays?: number, now?: number, observe?: Function}} [opts]
 */
export async function pruneRuns({ olderThanDays, trashTtlDays = TRASH_TTL_DAYS, now = Date.now(), observe } = {}) {
  const removed = []
  const skipped = []
  if (olderThanDays != null) {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new RetentionError('olderThanDays must be a number >= 0', { code: 'bad_request', reason: 'invalid_older_than' })
    }
    const cutoff = now - olderThanDays * DAY_MS
    for (const id of listRunIds()) {
      let dir
      try { dir = runDir(id) } catch { continue }
      let state
      try { state = await deriveRunState(dir) } catch { continue }
      if (!TERMINAL_STATES.has(state.state)) continue
      if (lastActivityMs(dir) > cutoff) continue
      try { removed.push(await removeRun(id, { observe, now })) } catch (err) {
        if (err instanceof RetentionError) skipped.push({ runId: id, code: err.code, reason: err.reason, message: err.message })
        else throw err
      }
    }
  }
  const { purged } = purgeTrash({ olderThanMs: trashTtlDays * DAY_MS, now })
  return { removed, skipped, purged }
}
