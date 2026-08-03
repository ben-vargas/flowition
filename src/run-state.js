import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { controlRequest } from './control.js'
import { runsDir, runDir } from './util.js'

const STALE_MS = 15_000
const CONTROL_TIMEOUT_MS = 300
const RESUME_LAUNCH_MS = 30_000
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted'])

// Mirrors the engine's pidAlive: signal 0 probes existence, and EPERM means the
// pid exists but belongs to another user — alive either way.
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

// The pid of a live engine holding run.lock, or null. The lock is written
// exclusively by an engine that owns the run and released only after
// result.json reflects ITS outcome — so a held lock with a live pid means any
// terminal result.json on disk is a previous attempt's. Unlike the control
// socket, this signal does not depend on the engine's event loop (synchronous
// preflight — a big module-graph scan — can block it past the probe timeout).
// Accepted residual: a stale lock whose dead writer's pid was reused can
// transiently misreport 'running' for a dead run — bounded, because the next
// resume attempt's reclaim clears it (the engine's acquireRunLock already
// disambiguates pid reuse via ps start times).
function liveLockPid(runDirPath) {
  let holder = null
  try { holder = JSON.parse(fs.readFileSync(path.join(runDirPath, 'run.lock'), 'utf8')) } catch { return null }
  return holder?.pid != null && pidAlive(holder.pid) ? holder.pid : null
}

// A restore that could neither link nor rename its claim back leaves the claim
// file behind (litter beats losing the launch marker). Those leaked claims must
// still protect the launch window: any young .resuming.claim.* in the dir
// counts as starting; aged ones are swept like the aged marker itself.
function youngClaimIsStarting(runDirPath) {
  let names
  try { names = fs.readdirSync(runDirPath) } catch { return false }
  let young = false
  for (const name of names) {
    if (!name.startsWith('.resuming.claim.')) continue
    const file = path.join(runDirPath, name)
    let ageMs
    try { ageMs = Math.max(0, Date.now() - fs.statSync(file).mtimeMs) } catch { continue }
    if (ageMs < RESUME_LAUNCH_MS) young = true
    else { try { fs.unlinkSync(file) } catch { /* gone */ } }
  }
  return young
}

// Put a claimed marker back. EEXIST means a newer marker already filled the
// slot — the claim is redundant and deleted. Any other link failure falls back
// to a rename restore; if even that fails the claim is LEFT in place for
// youngClaimIsStarting to honor rather than destroying the launch marker.
function restoreClaim(claim, markerPath) {
  try { fs.linkSync(claim, markerPath) } catch (err) {
    if (err?.code !== 'EEXIST') {
      try { fs.renameSync(claim, markerPath) } catch { /* leave the claim */ }
      return
    }
  }
  try { fs.unlinkSync(claim) } catch { /* gone */ }
}

function resumeIsStarting(runDirPath) {
  const markerPath = path.join(runDirPath, '.resuming')
  // Sweeping an aged marker is not atomic with the answer: a concurrent
  // launcher can install a FRESH marker between the claim-rename and the
  // return, and answering "not starting" then would let the reader trust the
  // old terminal result while a live launch marker sits on disk. So after an
  // aged-claim deletion the marker path is re-examined once — a bounded loop,
  // not unbounded recursion — and a fresh marker found on the recheck wins.
  for (let pass = 0; pass < 2; pass++) {
    let markerAt = NaN
    let readFailed = false
    try {
      markerAt = Number(fs.readFileSync(markerPath, 'utf8'))
    } catch (err) {
      if (err?.code === 'ENOENT') return youngClaimIsStarting(runDirPath)
      readFailed = true
    }

    let markerStat
    try { markerStat = fs.statSync(markerPath) } catch (err) {
      if (err?.code === 'ENOENT') return youngClaimIsStarting(runDirPath)
      return readFailed ? false : true
    }
    if (!markerStat.isFile()) return false

    const now = Date.now()
    const markerAgeMs = now - markerAt
    if (Number.isFinite(markerAt) && markerAt > 0 && markerAgeMs >= 0 && markerAgeMs < RESUME_LAUNCH_MS) return true

    const mtimeAgeMs = Math.max(0, now - markerStat.mtimeMs)
    if (mtimeAgeMs < RESUME_LAUNCH_MS) return true

    const claim = `${markerPath}.claim.${process.pid}.${crypto.randomUUID()}`
    try { fs.renameSync(markerPath, claim) } catch { return youngClaimIsStarting(runDirPath) }

    let claimAgeMs
    try { claimAgeMs = Math.max(0, Date.now() - fs.statSync(claim).mtimeMs) } catch {
      restoreClaim(claim, markerPath)
      return true
    }
    if (claimAgeMs < RESUME_LAUNCH_MS) {
      restoreClaim(claim, markerPath)
      return true
    }
    try { fs.unlinkSync(claim) } catch { /* gone */ }
    // aged claim swept — loop back and re-examine the marker path
  }
  return false
}

export async function deriveRunState(runDirPath) {
  if (resumeIsStarting(runDirPath)) {
    try {
      const { id, ...live } = await controlRequest(path.join(runDirPath, 'control.sock'), { cmd: 'status' }, CONTROL_TIMEOUT_MS)
      if (live.ok) return { state: 'running', result: null, live }
    } catch { /* still launching */ }
    // A failed duplicate launch against a dead run stays starting for up to 30s.
    return { state: 'starting', result: null }
  }

  const resultPath = path.join(runDirPath, 'result.json')
  let result
  let resultError = null
  try {
    result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    if (!result || typeof result !== 'object' || Array.isArray(result) || !TERMINAL_STATUSES.has(result.status)) {
      resultError = 'result.json has no valid status'
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') resultError = String(err?.message ?? err)
  }

  if (result !== undefined || resultError) {
    const sockPath = path.join(runDirPath, 'control.sock')
    if (fs.existsSync(sockPath)) {
      try {
        const { id, ...live } = await controlRequest(sockPath, { cmd: 'status' }, CONTROL_TIMEOUT_MS)
        if (live.ok) return { state: 'running', result: null, live }
      } catch { /* not live */ }
    }
    // The socket probe is the richer check but rides the engine's event loop; a
    // held run.lock proves ownership even while that loop is blocked, so the
    // terminal (or corrupt) file must not be trusted while the lock is held.
    const lockPid = liveLockPid(runDirPath)
    if (lockPid != null) return { state: 'running', result: null, live: null, detail: `run.lock held by live pid ${lockPid} — an engine owns the run; the terminal result.json is a previous attempt's` }
    if (resultError) return { state: 'corrupt-result', result: null, error: resultError }
    return { state: result.status, result }
  }

  let heartbeatAt = null
  let heartbeatError = null
  try {
    heartbeatAt = Number(fs.readFileSync(path.join(runDirPath, '.heartbeat'), 'utf8'))
    if (!Number.isFinite(heartbeatAt) || heartbeatAt <= 0) {
      heartbeatAt = null
      heartbeatError = 'invalid heartbeat'
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') heartbeatError = String(err?.message ?? err)
  }

  let live = null
  try {
    const { id, ...status } = await controlRequest(path.join(runDirPath, 'control.sock'), { cmd: 'status' }, CONTROL_TIMEOUT_MS)
    if (status.ok) live = status
  } catch { /* not live */ }

  const heartbeatAgeMs = heartbeatAt == null ? null : Math.max(0, Date.now() - heartbeatAt)
  const detail = {
    result: null,
    heartbeatAt,
    heartbeatAgeMs,
    live,
    ...(heartbeatError ? { heartbeatError } : {}),
  }
  if (live || (heartbeatAgeMs != null && heartbeatAgeMs <= STALE_MS)) return { state: 'running', ...detail }
  // The same event-loop-independent ownership signal as the terminal branch,
  // applied BEFORE the stale/unknown classification: an engine that has not
  // produced a result yet — blocked in synchronous preflight past the probe
  // timeout, or not yet at its first heartbeat — still HOLDS run.lock.
  const lockPid = liveLockPid(runDirPath)
  if (lockPid != null) return { state: 'running', ...detail, detail: `run.lock held by live pid ${lockPid} — an engine owns the run and has not produced a result yet` }
  if (heartbeatAt != null || heartbeatError) return { state: 'stale', ...detail }
  // No lock held, no socket answering, no heartbeat, no result — but a journal
  // exists: an attempt started and died before its first heartbeat. Classify
  // stale (crashed) so waiters resolve instead of pending forever; a bare dir
  // with no journal (no attempt ever ran) stays unknown.
  try { if (fs.statSync(path.join(runDirPath, 'journal.jsonl')).isFile()) return { state: 'stale', ...detail } } catch { /* no journal */ }
  return { state: 'unknown', ...detail }
}

// Every run on disk, unfiltered (DESIGN §8 E14 / §5.4.2 step 1). The old
// `startsWith('flo_')` filter hid every run started with an explicit `--run-id` —
// a run you named yourself was invisible to `flowition runs`. The only test now is
// "is it a directory whose name is a legal run id": a dir with no journal or events
// yet is a REAL run in its startup window (`detachRun` creates it before the child's
// first append) and lists with whatever state deriveRunState gives it (`unknown`).
export function listRunIds() {
  let ents = []
  try { ents = fs.readdirSync(runsDir(), { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of ents) {
    if (!e.isDirectory()) continue
    try { runDir(e.name) } catch { continue }
    out.push(e.name)
  }
  return out
}
