// The run-lifecycle mutation protocol (DESIGN §7.3): ONE exclusive run lock and ONE
// resume-marker handoff, shared by every process that can take ownership of a run —
// the engine (src/engine.js), the launchers (src/cli.js `--detach --resume`,
// src/mcp.js `flowition_resume`) and retention (src/retention.js `removeRun`).
//
// It lives in its own module because retention is imported by `src/viewer/**`, and the
// viewer must never pull `../engine.js` into its module graph (§7.4 "Viewer bug →
// executing a workflow", §11.2 denylist). A second, "byte-compatible" copy of the lock
// was the previous shape and it drifted immediately (fewer attempts, no pid-reuse
// check, aged-unreadable locks refused where the engine reclaims them) — two protocols
// that disagree about who owns a run are worse than one that is imperfect.
//
// This file imports node: builtins only.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

// Every caller maps this onto its own error type (WorkflowError / RetentionError);
// `code` is what they switch on so the messages stay presentational.
//   live       — a live engine holds the lock
//   acquiring  — an unreadable lock young enough to be mid-creation
//   contention — a reclaim raced another reclaimer
//   exhausted  — attempts ran out
//   vanished   — the run directory disappeared during a resume handoff
export class RunLockError extends Error {
  constructor(message, code) { super(message); this.name = 'RunLockError'; this.code = code }
}

// signal 0 probes existence; EPERM means the pid exists but belongs to another user —
// alive either way. (run-state.js keeps its own copy: it is read-only and must not
// depend on the mutation protocol.)
export const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

// pid liveness alone cannot distinguish a lock's writer from an unrelated
// process that inherited its pid after a crash (OS pid reuse): a process that
// STARTED after the lock was written cannot be the writer. 2s skew because the
// lock write is not atomic with process birth. Unverifiable start times (ps
// missing/failed, unparseable date) stay conservative — holder treated live.
const pidStartedAfter = (pid, lockStartedAt) => {
  try {
    const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
    if (ps.status !== 0) return false
    const born = Date.parse(ps.stdout.trim())
    return Number.isFinite(born) && born > lockStartedAt + 2000
  } catch { return false }
}

/**
 * Exclusive per-run lock: two engines on one run dir would interleave journal
 * writes and duplicate provider side effects, and a delete racing either would
 * destroy a run an engine owns. Stale locks (dead pid) are reclaimed via rename,
 * which is atomic — exactly one contender wins the claim; losers loop and find the
 * winner's fresh lock. (unlink-then-create would let two processes that both
 * observed the dead holder each remove the other's new lock.)
 *
 * @returns {{path: string, stillOurs: () => boolean, release: () => void}}
 * @throws {RunLockError} on every refusal; raw fs errors on unexpected IO failure.
 */
export function acquireRunLock(dir) {
  const lockPath = path.join(dir, 'run.lock')
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const body = JSON.stringify({ pid: process.pid, startedAt: Date.now() })
      fs.writeFileSync(lockPath, body, { flag: 'wx' })
      // Exact-bytes identity. Only the writer of these bytes can match them, so a
      // holder that reads its own body back knows the lock is still its own — which
      // is what retention needs to recognise its own lock reflected back by
      // deriveRunState (§7.3.3), and what makes release() safe.
      const ours = () => {
        try { return fs.readFileSync(lockPath, 'utf8') === body } catch { return false }
      }
      return {
        path: lockPath,
        stillOurs: ours,
        release() { if (ours()) { try { fs.unlinkSync(lockPath) } catch { /* already gone */ } } },
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let holder = null
      try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch { /* torn or vanished */ }
      if (holder?.pid != null && pidAlive(holder.pid)) {
        const reused = typeof holder.startedAt === 'number' && pidStartedAfter(holder.pid, holder.startedAt)
        if (!reused) throw new RunLockError(`run is already being executed by pid ${holder.pid} — refusing concurrent execution of the same run`, 'live')
        // pid reused by a newer process — the writer is dead; fall through to
        // the verified reclaim path below
      }
      if (holder?.pid == null) {
        // Unreadable body: could be a lock caught mid-creation, not a dead one.
        // Only a lock that has STAYED unreadable for seconds is genuinely stale.
        let ageMs = 0
        try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs } catch { continue /* vanished — retry */ }
        if (ageMs < 2000) throw new RunLockError('run lock is being acquired by another process — refusing concurrent execution of the same run', 'acquiring')
      }
      const claim = `${lockPath}.reclaim.${process.pid}.${attempt}.${crypto.randomUUID()}`
      try { fs.renameSync(lockPath, claim) } catch { continue /* another reclaimer won */ }
      // Verify the claim took the SAME dead lock we observed. A slow contender can
      // otherwise rename away a fresh live lock created after the winner's reclaim —
      // and an unreadable claim may be a fresh lock caught between open and write,
      // so only the exact observed-dead body (or aged unreadable garbage matching
      // an aged unreadable observation) may be discarded. Anything else is restored
      // atomically (link fails on EEXIST rather than clobbering) and we refuse.
      let claimed = null
      try { claimed = JSON.parse(fs.readFileSync(claim, 'utf8')) } catch { /* unreadable */ }
      let claimAge = 0
      try { claimAge = Date.now() - fs.statSync(claim).mtimeMs } catch { /* vanished */ }
      const observedDead = claimed != null && holder != null && claimed.pid === holder.pid && claimed.startedAt === holder.startedAt
      // unreadable-then AND unreadable-now AND the claimed inode itself is old —
      // a fresh lock caught mid-creation would be young
      const agedGarbage = claimed == null && holder == null && claimAge >= 2000
      if (!observedDead && !agedGarbage) {
        // We may have stolen a live lock. Restore it atomically (link never
        // clobbers); if the slot was re-taken, LEAVE the claim file rather than
        // destroy a lock we could not verify.
        let restored = false
        try { fs.linkSync(claim, lockPath); restored = true } catch { /* slot re-taken */ }
        if (restored) { try { fs.unlinkSync(claim) } catch { /* gone */ } }
        throw new RunLockError('run lock contention — another engine acquired the run', 'contention')
      }
      try { fs.unlinkSync(claim) } catch { /* gone */ }
    }
  }
  throw new RunLockError('could not acquire run lock', 'exhausted')
}

// ─── the resume handoff ─────────────────────────────────────────────────────────
//
// A detached resume cannot hold the run lock across the spawn (the CLI/viewer process
// exits, and §7.3 forbids the viewer holding one at all), so ownership is handed to the
// child through the `.resuming` marker: deriveRunState reports `starting` while it is
// young, and the child clears it once it owns the run (src/engine.js:871).
//
// The marker is the OTHER half of the resume-vs-delete exclusion, and the two halves
// linearize on one point — the delete's atomic rename of the run directory:
//
//   * a marker installed BEFORE that rename lands inside the directory that moves,
//     so the delete sees it in its post-rename audit and rolls back (delete loses);
//   * a marker installed AFTER it cannot resolve `runs/<id>` at all, so the verify
//     step below fails and the launcher refuses instead of accepting a resume against
//     a run that no longer exists (resume loses).
//
// There is no third ordering, so "resume accepted AND run deleted" cannot happen.
export const RESUME_MARKER = '.resuming'

/**
 * Install the detached-resume handoff marker, tmp+rename (§7.3), then prove the run
 * directory is still in place. Callers must treat a throw as "the resume was NOT
 * accepted".
 */
export function installResumeMarker(dir) {
  const marker = path.join(dir, RESUME_MARKER)
  // The tmp shares the marker's prefix so it counts as launch intent too: a delete
  // that renames the directory between the write and the rename still sees it.
  const tmp = `${marker}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, String(Date.now()))
  } catch (err) {
    throw new RunLockError(`cannot hand off the resume of this run: ${err?.message ?? err}`, 'vanished')
  }
  try {
    fs.renameSync(tmp, marker)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* gone with the dir */ }
    throw new RunLockError(`cannot hand off the resume of this run: ${err?.message ?? err}`, 'vanished')
  }
  // Path lookup, deliberately — not a handle to the file we wrote. It answers "does
  // `runs/<id>/.resuming` still resolve", i.e. was the run deleted out from under this
  // launch. A different inode is another launcher's marker, which is still a valid
  // handoff for this run.
  try {
    fs.statSync(marker)
  } catch (err) {
    throw new RunLockError(`the run directory disappeared while the resume was being launched (${err?.code ?? 'gone'}) — the run was deleted`, 'vanished')
  }
  return marker
}

/**
 * Fingerprint every resume-intent entry in a run directory (`.resuming`, its tmps, and
 * the `.resuming.claim.*` files run-state.js leaves behind). Identity includes the inode
 * and mtime, so a marker REPLACED under the same name still reads as a change.
 * removeRun compares the fingerprint taken under the lock with the one taken after the
 * rename; any addition means a resume slipped into the commit window.
 */
export function resumeMarks(dir) {
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.startsWith(RESUME_MARKER)) continue
    let st
    try { st = fs.lstatSync(path.join(dir, name)) } catch { continue }
    out.push(`${name}:${st.ino}:${st.mtimeMs}:${st.size}`)
  }
  return out.sort()
}
