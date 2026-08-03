// DESIGN §8 E13 / §7.3 — retention guards. This is the only destructive capability in
// flowition, so every guard is proven against real artifacts on disk: a real running
// mock run, a real detached resume racing a delete, real symlinks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-retention-'))
process.env.FLOWITION_HOME = HOME

const { removeRun, pruneRuns, purgeTrash, trashDir, RetentionError, TRASH_TTL_DAYS } = await import('../src/retention.js')
const { runWorkflow } = await import('../src/engine.js')
const { controlRequest } = await import('../src/control.js')
const { runDir, runsDir } = await import('../src/util.js')
const { main: cli } = await import('../src/cli.js')
const { installResumeMarker, resumeMarks, RunLockError } = await import('../src/run-lock.js')
const { serveControl } = await import('../src/control.js')
const { auditPath } = await import('../src/viewer/audit.js')

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bin = path.join(root, 'bin', 'flowition.js')
const fx = (name) => path.join(root, 'test', 'fixtures', name)
const sockOf = (runId) => path.join(runDir(runId), 'control.sock')
const DAY = 86_400_000

async function until(fn, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    let v = null
    try { v = await fn() } catch { /* not ready */ }
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('until(): timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

// A directory that looks like a finished run, without running one.
function seedRun(id, { artifacts = { 'journal.jsonl': '{"type":"meta"}\n', 'result.json': '{"status":"completed","result":"ok"}' } } = {}) {
  const dir = path.join(runsDir(), id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [name, body] of Object.entries(artifacts)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}

const refusal = (code, reason) => (err) => {
  assert.ok(err instanceof RetentionError, `expected RetentionError, got ${err}`)
  assert.equal(err.code, code, err.message)
  assert.equal(err.reason, reason, err.message)
  return true
}

const trashEntries = () => { try { return fs.readdirSync(trashDir()) } catch { return [] } }

// The CANONICAL audit trail: the file on disk, not an injected callback. `removeRun`
// takes no audit sink argument at all (§7.3 "Audit log"), so this is the only place a
// delete can be observed from — which is the point.
const auditLines = () => {
  let raw = ''
  try { raw = fs.readFileSync(auditPath(), 'utf8') } catch { return [] }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
// The lines a single operation appended, minus the timestamp.
const auditSince = (mark) => auditLines().slice(mark).map((l) => ({ op: l.op, runId: l.runId, outcome: l.outcome, ...(l.reason ? { reason: l.reason } : {}) }))
const auditMark = () => auditLines().length

// Run `fn` against a throwaway FLOWITION_HOME (used where the audit log itself must be
// broken, which would poison the shared home for every other test).
//
// The base is the CANONICAL tmpdir and `prefix` is a knob because a run's control socket
// lives at <runDir>/control.sock and `removeRun` derives state against the *realpath* of
// the run dir — on darwin that is `/private/var/...`, eight bytes longer than the `/var`
// spelling the engine binds through, and sun_path is capped at 104. A home under the
// default tmpdir with a long prefix silently pushes the probe past that cap (connect
// fails with ENAMETOOLONG, deriveRunState falls back to run.lock), so any test that needs
// the socket probe to actually connect asks for a short canonical home.
async function inFreshHome(fn, prefix = 'flowition-retention-home-') {
  const h = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix))
  const saved = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = h
  try { return await fn(h) } finally {
    process.env.FLOWITION_HOME = saved
    fs.rmSync(h, { recursive: true, force: true })
  }
}

// ─── trash + purge lifecycle ────────────────────────────────────────────────────

test('delete moves the run to trash intact and purges only after the TTL', async () => {
  const dir = seedRun('flo_trash_me')
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"type":"run"}\n')
  const now = Date.now()
  const mark = auditMark()
  const observed = []
  const out = await removeRun('flo_trash_me', { now, observe: (line) => observed.push({ ...line, runStillOnDisk: fs.existsSync(dir), persisted: auditLines().length }) })

  assert.equal(out.runId, 'flo_trash_me')
  assert.equal(out.trashedAt, now)
  assert.equal(out.trashPath, path.join(trashDir(), `flo_trash_me.${now}`))
  assert.ok(!fs.existsSync(dir), 'run dir gone from runs/')
  // contents survive verbatim — this is a move, not a delete
  assert.equal(fs.readFileSync(path.join(out.trashPath, 'result.json'), 'utf8'), '{"status":"completed","result":"ok"}')
  assert.ok(fs.existsSync(path.join(out.trashPath, 'events.jsonl')))
  // §7.3.5: the audit line is PERSISTED before the rename, so it survives the run
  assert.deepEqual(auditSince(mark), [{ op: 'delete', runId: 'flo_trash_me', outcome: 'ok' }])
  assert.deepEqual(observed, [{ op: 'delete', runId: 'flo_trash_me', outcome: 'ok', runStillOnDisk: true, persisted: mark + 1 }],
    'the observer sees the record only after it is on disk, and only while the run still is')
  if (process.platform !== 'win32') assert.equal(fs.statSync(trashDir()).mode & 0o777, 0o700)
  // a restored entry must not look like a live run
  assert.ok(!fs.existsSync(path.join(out.trashPath, 'run.lock')))

  // fresh entries survive the default 7-day purge
  purgeTrash({ now })
  assert.ok(fs.existsSync(out.trashPath), 'not purged before the TTL')
  // ...and are gone one tick past it
  const purged = purgeTrash({ now: now + TRASH_TTL_DAYS * DAY })
  assert.deepEqual(purged.purged.map((p) => p.runId), ['flo_trash_me'])
  assert.ok(!fs.existsSync(out.trashPath), 'purged after the TTL')
})

test('a delete that cannot be audited does not happen', async () => {
  // Sol-4: "the audit trail is the run itself" is false for delete. If the record
  // cannot be written, the destruction is not performed. Proven by breaking the real
  // sink (a directory where the log file goes → EISDIR on append), because there is no
  // audit argument to inject a broken writer through.
  await inFreshHome(async (h) => {
    const dir = seedRun('flo_audit_fail')
    fs.mkdirSync(path.join(h, 'viewer-audit.jsonl'))
    await assert.rejects(removeRun('flo_audit_fail'), refusal('internal', 'audit_failed'))
    assert.ok(fs.existsSync(path.join(dir, 'result.json')), 'run untouched')
    assert.deepEqual(trashEntries().filter((e) => e.startsWith('flo_audit_fail')), [])
    assert.ok(!fs.existsSync(path.join(dir, 'run.lock')), 'the delete lock is released')
    // a broken sink must not mask a refusal either — the refusal reason survives
    fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    await assert.rejects(removeRun('flo_audit_fail'), refusal('conflict', 'live'))
  })
})

test('the audit sink cannot be replaced or suppressed by any caller', async () => {
  // The reviewed defect: an `audit` option meant `removeRun(id, {audit: () => {}})`
  // trashed a run with no line in viewer-audit.jsonl. The sink is now internal, and the
  // only hook a caller gets is a read-only observer that cannot fail the write, cannot
  // stop it, and cannot stand in for it.
  const dir = seedRun('flo_unsuppressable')
  const mark = auditMark()
  // every historical spelling of "give me my own sink" — none of them is a sink now
  const out = await removeRun('flo_unsuppressable', {
    audit: () => {},                                    // ignored: not a parameter
    observe: () => { throw new Error('observers do not get a vote') },
  })
  assert.ok(!fs.existsSync(dir), 'the run was trashed')
  assert.ok(fs.existsSync(path.join(out.trashPath, 'journal.jsonl')))
  assert.deepEqual(auditSince(mark), [{ op: 'delete', runId: 'flo_unsuppressable', outcome: 'ok' }],
    'the delete is on disk in viewer-audit.jsonl regardless of what the caller passed')

  // ...and the same for the bulk path
  const pruned = seedRun('flo_unsuppressable_bulk')
  const t = (Date.now() - 40 * DAY) / 1000
  for (const name of fs.readdirSync(pruned)) fs.utimesSync(path.join(pruned, name), t, t)
  fs.utimesSync(pruned, t, t)
  const mark2 = auditMark()
  const res = await pruneRuns({ olderThanDays: 30, audit: () => {}, observe: () => { throw new Error('nope') } })
  assert.deepEqual(res.removed.map((r) => r.runId), ['flo_unsuppressable_bulk'])
  assert.deepEqual(auditSince(mark2), [{ op: 'delete', runId: 'flo_unsuppressable_bulk', outcome: 'ok' }])
})

test('purge only removes entries this module created', async () => {
  fs.mkdirSync(trashDir(), { recursive: true, mode: 0o700 })
  const foreignFile = path.join(trashDir(), 'notes.txt')
  const foreignDir = path.join(trashDir(), 'my-backup')
  fs.writeFileSync(foreignFile, 'keep me')
  fs.mkdirSync(foreignDir, { recursive: true })
  seedRun('flo_purge_all')
  const now = Date.now()
  const { trashPath } = await removeRun('flo_purge_all', { now })

  purgeTrash({ olderThanMs: 0, now })
  assert.ok(!fs.existsSync(trashPath), 'our entry purged')
  assert.equal(fs.readFileSync(foreignFile, 'utf8'), 'keep me')
  assert.ok(fs.existsSync(foreignDir), 'a foreign directory in trash/ is left alone')
  fs.rmSync(foreignDir, { recursive: true, force: true })
  fs.rmSync(foreignFile, { force: true })
})

// ─── id validation / traversal ──────────────────────────────────────────────────

test('traversal and malformed ids are refused by runDir() before any fs work', async () => {
  const victim = path.join(HOME, 'victim')
  fs.mkdirSync(victim, { recursive: true })
  fs.writeFileSync(path.join(victim, 'journal.jsonl'), 'precious\n')

  for (const id of ['../victim', '../../etc', 'a/b', '.hidden', '', '.', '..', 'runs/../victim', 'x\0y']) {
    await assert.rejects(removeRun(id), refusal('bad_request', 'invalid_run_id'), `id ${JSON.stringify(id)}`)
  }
  // absolute paths and separators can never reach the filesystem layer
  await assert.rejects(removeRun(path.join(HOME, 'victim')), refusal('bad_request', 'invalid_run_id'))
  assert.equal(fs.readFileSync(path.join(victim, 'journal.jsonl'), 'utf8'), 'precious\n')
  assert.deepEqual(trashEntries().filter((e) => e.startsWith('victim')), [])
})

test('a missing run is not_found, not a silent success', async () => {
  await assert.rejects(removeRun('flo_never_existed'), refusal('not_found', 'missing'))
})

// ─── symlink refusal + containment ──────────────────────────────────────────────

test('a symlinked run dir is refused outright and never followed', async () => {
  const outside = path.join(HOME, 'outside-run')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'journal.jsonl'), 'not yours\n')
  fs.mkdirSync(runsDir(), { recursive: true })
  fs.symlinkSync(outside, path.join(runsDir(), 'flo_escape'), 'dir')

  await assert.rejects(removeRun('flo_escape'), refusal('conflict', 'symlink'))
  // the target survives AND the link itself is untouched
  assert.equal(fs.readFileSync(path.join(outside, 'journal.jsonl'), 'utf8'), 'not yours\n')
  assert.ok(fs.lstatSync(path.join(runsDir(), 'flo_escape')).isSymbolicLink())
  assert.deepEqual(trashEntries().filter((e) => e.startsWith('flo_escape')), [])
})

test('a symlink to a sibling run inside runs/ is refused too', async () => {
  const real = seedRun('flo_sibling_real')
  fs.symlinkSync(real, path.join(runsDir(), 'flo_sibling_link'), 'dir')
  await assert.rejects(removeRun('flo_sibling_link'), refusal('conflict', 'symlink'))
  assert.ok(fs.existsSync(path.join(real, 'result.json')), 'the sibling run survives')
})

test('a regular file named like a run is refused', async () => {
  fs.mkdirSync(runsDir(), { recursive: true })
  fs.writeFileSync(path.join(runsDir(), 'flo_a_file'), 'x')
  await assert.rejects(removeRun('flo_a_file'), refusal('conflict', 'not_a_directory'))
  assert.ok(fs.existsSync(path.join(runsDir(), 'flo_a_file')))
})

test('containment holds through a symlinked ancestor (no false refusal)', async () => {
  // /var → /private/var on darwin already exercises this; construct it explicitly so
  // the guarantee is proven on every platform: a home reached through a symlink is a
  // legitimate home, and its runs must still be deletable.
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-retention-real-'))
  const linkHome = path.join(os.tmpdir(), `flowition-retention-link-${process.pid}`)
  fs.rmSync(linkHome, { recursive: true, force: true })
  fs.symlinkSync(realHome, linkHome, 'dir')
  const saved = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = linkHome
  try {
    const dir = seedRun('flo_via_link')
    const out = await removeRun('flo_via_link')
    assert.ok(!fs.existsSync(dir))
    assert.ok(fs.existsSync(path.join(out.trashPath, 'result.json')))
    // whatever the caller's path spelling, the deleted directory is inside the real root
    assert.equal(path.dirname(out.from), fs.realpathSync(path.join(realHome, 'runs')))
  } finally {
    process.env.FLOWITION_HOME = saved
    fs.rmSync(linkHome, { force: true })
    fs.rmSync(realHome, { recursive: true, force: true })
  }
})

test('containment: a run dir that resolves outside the runs root is refused (outside_runs_root)', async () => {
  // The guard the symlink tests above do NOT reach: they stop at `lstat().isSymbolicLink()`.
  // `outside_runs_root` fires only when the entry passes the lstat check as a REAL
  // directory and *then* resolves elsewhere — which on a normal filesystem takes a
  // TOCTOU. resolveRunDir does three ordered calls: lstat(runs/<id>) →
  // realpath(runs) → realpath(runs/<id>). Swapping the runs root for a symlink between
  // the last two makes the entry that was inspected and the entry that resolves two
  // different directories, exactly as a hostile local swap would. Only the *timing* of
  // the swap is injected (via fs.realpathSync); the filesystem state the guard judges,
  // and the guard itself, are the shipped ones.
  await inFreshHome(async (h) => {
    const dir = seedRun('flo_contain')                  // runs/flo_contain — a real directory
    const decoy = path.join(h, 'decoy')                 // ...and the data we must NOT delete
    fs.mkdirSync(path.join(decoy, 'flo_contain'), { recursive: true })
    fs.writeFileSync(path.join(decoy, 'flo_contain', 'journal.jsonl'), 'not yours\n')
    const runs = runsDir()
    const kept = path.join(h, 'runs.moved-aside')

    const realpathSync = fs.realpathSync
    let swapped = false
    const patched = (p, ...rest) => {
      const out = realpathSync(p, ...rest)
      // after the root has been resolved, before the entry is
      if (!swapped && typeof p === 'string' && path.resolve(p) === path.resolve(runs)) {
        swapped = true
        fs.renameSync(runs, kept)                       // the real runs/ moves aside, intact
        fs.symlinkSync(decoy, runs, 'dir')              // runs/ now points somewhere else
      }
      return out
    }
    patched.native = realpathSync.native
    const mark = auditMark()
    fs.realpathSync = patched
    try {
      await assert.rejects(removeRun('flo_contain'), refusal('conflict', 'outside_runs_root'))
    } finally {
      fs.realpathSync = realpathSync
    }
    assert.ok(swapped, 'the swap really happened inside resolveRunDir')

    // nothing was destroyed on either side of the swap
    assert.equal(fs.readFileSync(path.join(decoy, 'flo_contain', 'journal.jsonl'), 'utf8'), 'not yours\n')
    assert.equal(fs.readFileSync(path.join(kept, 'flo_contain', 'result.json'), 'utf8'), '{"status":"completed","result":"ok"}')
    assert.ok(fs.lstatSync(runs).isSymbolicLink(), 'the planted link itself is left alone, not followed and unlinked')
    assert.deepEqual(trashEntries(), [], 'nothing reached the trash')
    assert.ok(!fs.existsSync(path.join(kept, 'flo_contain', 'run.lock')), 'the run was never locked')
    assert.deepEqual(auditSince(mark), [{ op: 'delete', runId: 'flo_contain', outcome: 'refused', reason: 'outside_runs_root' }])

    // put the home back so inFreshHome's teardown is boring
    fs.unlinkSync(runs)
    fs.renameSync(kept, runs)
    assert.ok(fs.existsSync(path.join(dir, 'result.json')))
  })
})

test('a run directory swapped AFTER the last containment check is not trashed', async () => {
  // The reviewed defect: every guard in removeRun re-resolves `runs/<id>` by path, so a
  // local attacker who replaces that entry between the final containment check and the
  // rename gets the REPLACEMENT moved into the trash — bypassing the artifact
  // requirement, the containment check and the lock, all of which judged a directory
  // that is no longer there. `beforeCommit` is the shipped seam that puts the swap in
  // exactly that instant; the filesystem state and every guard are the shipped ones.
  await inFreshHome(async (h) => {
    const dir = seedRun('flo_swapped')                     // the real, locked, artifact-bearing run
    const aside = path.join(h, 'moved-aside')              // where the attacker parks it
    const mark = auditMark()

    await assert.rejects(
      removeRun('flo_swapped', {
        beforeCommit: () => {
          fs.renameSync(dir, aside)                        // the locked run leaves the name...
          fs.mkdirSync(dir, { recursive: true })           // ...and a stranger takes it
          fs.writeFileSync(path.join(dir, 'precious.txt'), 'not a run\n')
        },
      }),
      refusal('conflict', 'raced'),
    )

    // The replacement was NEVER destroyed: it is back at its own name, whole.
    assert.ok(fs.existsSync(dir), 'the replacement is back where it was')
    assert.equal(fs.readFileSync(path.join(dir, 'precious.txt'), 'utf8'), 'not a run\n')
    assert.deepEqual(fs.readdirSync(dir), ['precious.txt'], 'and nothing of ours was left inside it')
    assert.deepEqual(trashEntries(), [], 'nothing reached the trash')
    // The real run is untouched wherever the attacker put it.
    assert.equal(fs.readFileSync(path.join(aside, 'result.json'), 'utf8'), '{"status":"completed","result":"ok"}')
    // The audit says a delete was recorded and then undone — never a completed delete.
    assert.deepEqual(auditSince(mark), [
      { op: 'delete', runId: 'flo_swapped', outcome: 'ok' },
      { op: 'delete', runId: 'flo_swapped', outcome: 'rolled-back', reason: 'identity_changed' },
    ])
  })
})

test('a run directory swapped WHILE the lock is being taken is not trashed', async () => {
  // The narrower window of the same defect: the identity pin used to be taken only AFTER
  // acquireRunLock returned, so an entry replaced between the lock's creation and the pin
  // was pinned itself — and a replacement that is an artifact-bearing, terminal run then
  // passed every remaining identity, artifact, state and post-rename check on its own
  // merits and was successfully trashed, while the run whose lock we hold sat aside.
  // The pin is now taken before the lock, so the replacement is never the pinned subject.
  //
  // The swap is injected by intercepting the lock's own `writeFileSync` — the shipped
  // acquisition path (src/run-lock.js:67), no new seam in removeRun.
  await inFreshHome(async (h) => {
    const dir = seedRun('flo_lockswap')                    // the real, artifact-bearing run
    const aside = path.join(h, 'carried-away')             // where the attacker parks it
    const decoy = path.join(h, 'decoy')                    // a plausible run of its own
    fs.mkdirSync(decoy, { recursive: true })
    fs.writeFileSync(path.join(decoy, 'journal.jsonl'), '{"type":"meta"}\n')
    fs.writeFileSync(path.join(decoy, 'result.json'), '{"status":"completed","result":"not yours"}')

    const writeFileSync = fs.writeFileSync
    let swapped = false
    const patched = (p, ...rest) => {
      const out = writeFileSync(p, ...rest)
      // exactly between the lock's creation and the pin/identity check that follows it
      if (!swapped && typeof p === 'string' && p.endsWith(path.join('flo_lockswap', 'run.lock'))) {
        swapped = true
        fs.renameSync(dir, aside)                          // the locked run leaves the name...
        fs.renameSync(decoy, dir)                          // ...a terminal, artifact-bearing run takes it
      }
      return out
    }
    const mark = auditMark()
    fs.writeFileSync = patched
    try {
      await assert.rejects(removeRun('flo_lockswap'), refusal('conflict', 'raced'))
    } finally {
      fs.writeFileSync = writeFileSync
    }
    assert.ok(swapped, 'the swap really happened while the lock was being taken')

    // Both directories are intact: the replacement at the name...
    assert.equal(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'), '{"status":"completed","result":"not yours"}')
    assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), '{"type":"meta"}\n')
    // ...and the real run wherever the attacker put it.
    assert.equal(fs.readFileSync(path.join(aside, 'result.json'), 'utf8'), '{"status":"completed","result":"ok"}')
    assert.deepEqual(trashEntries(), [], 'nothing reached the trash')
    // Our lock travelled with the directory that was carried away — it can no longer be
    // reached by path, and there it only makes a later delete of that directory refuse.
    assert.ok(fs.existsSync(path.join(aside, 'run.lock')), 'the lock went with the directory it was taken in')
    assert.deepEqual(fs.readdirSync(dir).sort(), ['journal.jsonl', 'result.json'],
      'nothing of ours was left inside the replacement')
    // No delete was ever recorded — this refusal happens before the audited commit.
    assert.deepEqual(auditSince(mark), [{ op: 'delete', runId: 'flo_lockswap', outcome: 'refused', reason: 'raced' }])
  })
})

test('a run directory swapped immediately BEFORE the identity pin is not trashed', async () => {
  // The earliest window of the same defect, and the one the lock-creation test above
  // cannot reach: `resolveRunDir` finished — symlink refusal, containment, artifact-free
  // name validation all passed — and the pin had not yet captured an identity. Because
  // `pinDir` used to take whatever answered to `runs/<id>` when its descriptor opened, a
  // swap in that gap made the REPLACEMENT the pinned subject; a replacement that is
  // itself a terminal, artifact-bearing run then satisfied the artifact check, the lock,
  // the state derivation and the post-rename identity check on its own merits, and was
  // successfully moved into the trash while the validated run sat aside. `resolveRunDir`
  // now returns the identity it validated and `pinDir` must open that same object.
  //
  // The swap is injected by intercepting the pin's own `fs.openSync` (src/retention.js
  // `pinDir`) — the shipped acquisition path, no new seam in removeRun. Only the timing
  // is injected; the filesystem state and every guard are the shipped ones.
  await inFreshHome(async (h) => {
    const dir = seedRun('flo_pinswap')                     // the real, artifact-bearing run
    const realDir = fs.realpathSync(dir)                   // what pinDir is handed
    const aside = path.join(h, 'carried-away')             // where the attacker parks it
    const decoy = path.join(h, 'decoy')                    // a plausible terminal run of its own
    fs.mkdirSync(decoy, { recursive: true })
    fs.writeFileSync(path.join(decoy, 'journal.jsonl'), '{"type":"meta"}\n')
    fs.writeFileSync(path.join(decoy, 'result.json'), '{"status":"completed","result":"not yours"}')

    const openSync = fs.openSync
    let swapped = false
    const patched = (p, ...rest) => {
      // strictly between resolveRunDir's return and the descriptor that pins an identity
      if (!swapped && typeof p === 'string' && path.resolve(p) === realDir) {
        swapped = true
        fs.renameSync(dir, aside)                          // the validated run leaves the name...
        fs.renameSync(decoy, dir)                          // ...a terminal, artifact-bearing run takes it
      }
      return openSync(p, ...rest)
    }
    const mark = auditMark()
    fs.openSync = patched
    try {
      await assert.rejects(removeRun('flo_pinswap'), refusal('conflict', 'raced'))
    } finally {
      fs.openSync = openSync
    }
    assert.ok(swapped, 'the swap really happened before the pin opened its descriptor')

    // Both directories are intact: the replacement at the name...
    assert.equal(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'), '{"status":"completed","result":"not yours"}')
    assert.deepEqual(fs.readdirSync(dir).sort(), ['journal.jsonl', 'result.json'],
      'nothing of ours was left inside the replacement')
    // ...and the validated run wherever the attacker put it.
    assert.equal(fs.readFileSync(path.join(aside, 'result.json'), 'utf8'), '{"status":"completed","result":"ok"}')
    assert.deepEqual(trashEntries(), [], 'nothing reached the trash')
    // The refusal happens before the lock is ever taken, so neither directory holds one.
    assert.ok(!fs.existsSync(path.join(dir, 'run.lock')), 'the replacement was never locked')
    assert.ok(!fs.existsSync(path.join(aside, 'run.lock')), 'the validated run was never locked')
    // No delete was ever recorded — this refusal happens before the audited commit.
    assert.deepEqual(auditSince(mark), [{ op: 'delete', runId: 'flo_pinswap', outcome: 'refused', reason: 'raced' }])
  })
})

// ─── artifact requirement ───────────────────────────────────────────────────────

test('a validly-named directory with no run artifacts is refused', async () => {
  const bare = path.join(runsDir(), 'flo_bare')
  fs.mkdirSync(bare, { recursive: true })
  await assert.rejects(removeRun('flo_bare'), refusal('conflict', 'not_a_run'))
  assert.ok(fs.existsSync(bare))

  // sub-directories and unrelated files do not vouch for a run either
  fs.mkdirSync(path.join(bare, 'scratch'), { recursive: true })
  fs.writeFileSync(path.join(bare, 'notes.md'), '# my stuff')
  await assert.rejects(removeRun('flo_bare'), refusal('conflict', 'not_a_run'))
  assert.ok(fs.existsSync(path.join(bare, 'notes.md')))

  // a SYMLINK named like an artifact must not vouch for it (lstat, not stat)
  fs.symlinkSync(path.join(HOME, 'victim', 'journal.jsonl'), path.join(bare, 'journal.jsonl'))
  await assert.rejects(removeRun('flo_bare'), refusal('conflict', 'not_a_run'))
  assert.ok(fs.existsSync(bare))

  // one real artifact is enough — run.log alone counts (a run that died at startup)
  fs.rmSync(path.join(bare, 'journal.jsonl'))
  fs.writeFileSync(path.join(bare, 'run.log'), 'boot\n')
  const out = await removeRun('flo_bare')
  assert.ok(!fs.existsSync(bare))
  assert.ok(fs.existsSync(path.join(out.trashPath, 'notes.md')), 'the whole directory moves, not just artifacts')
})

// ─── refuse-live, against a real running mock run ───────────────────────────────

test('a live run is refused, and deletable the moment it is terminal', async () => {
  const runId = 'flo_live'
  const p = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock' }, runId, quiet: true })
  await until(async () => (await controlRequest(sockOf(runId), { cmd: 'status' }).catch(() => null))?.ok)

  const mark = auditMark()
  await assert.rejects(removeRun(runId), refusal('conflict', 'live'))
  assert.deepEqual(auditSince(mark), [{ op: 'delete', runId, outcome: 'refused', reason: 'live' }])
  assert.ok(fs.existsSync(runDir(runId)), 'the live run is untouched')
  assert.ok(fs.existsSync(path.join(runDir(runId), 'run.lock')), 'the engine still owns its lock')
  assert.deepEqual(trashEntries().filter((e) => e.startsWith(runId)), [])

  await controlRequest(sockOf(runId), { cmd: 'cancel' })
  assert.equal((await p).status, 'interrupted')

  const out = await removeRun(runId)
  assert.ok(!fs.existsSync(runDir(runId)))
  assert.ok(fs.existsSync(path.join(out.trashPath, 'journal.jsonl')))
})

test('the lock protocol is the ENGINE\'s: aged torn locks and pid reuse are reclaimed, not refused forever', async () => {
  // §7.3.3 says "reuse acquireRunLock" — and reuse is load-bearing, not stylistic. A run
  // the engine would happily resume must not be undeletable, or a crashed run with a torn
  // lock is stuck on disk forever with no way out but `rm -rf`.
  const torn = seedRun('flo_torn_lock')
  const lockPath = path.join(torn, 'run.lock')
  fs.writeFileSync(lockPath, '{"pid":')
  // young: indistinguishable from a lock caught between open and write (engine.js's
  // 2s rule) — both the engine and retention refuse.
  await assert.rejects(removeRun('flo_torn_lock'), refusal('conflict', 'locked'))
  assert.ok(fs.existsSync(torn))
  // aged past that window it is garbage the engine reclaims — so retention does too
  const t = (Date.now() - 5000) / 1000
  fs.utimesSync(lockPath, t, t)
  const out = await removeRun('flo_torn_lock')
  assert.ok(!fs.existsSync(torn), 'an aged torn lock no longer pins the run on disk')
  assert.ok(fs.existsSync(path.join(out.trashPath, 'result.json')))

  if (process.platform === 'win32') return   // no `ps` — pidStartedAfter stays conservative
  // pid reuse: the recorded pid is live (this very process) but the lock claims it was
  // written long before that process started. test/core-fixes.test.js:1735 proves the
  // engine resumes such a run; the same lock must let retention delete it.
  const reused = seedRun('flo_reused_pid')
  fs.writeFileSync(path.join(reused, 'run.lock'), JSON.stringify({ pid: process.pid, startedAt: 1 }))
  const out2 = await removeRun('flo_reused_pid')
  assert.ok(!fs.existsSync(reused), 'a dead holder whose pid was reused does not pin the run')
  assert.ok(fs.existsSync(path.join(out2.trashPath, 'journal.jsonl')))
})

test('a run.lock held by a live pid refuses the delete regardless of derived state', async () => {
  // The engine's ownership signal does not depend on its event loop (run-state.js:18–27):
  // a terminal result.json plus a held lock means an engine is mid-attempt. Delete must
  // trust the lock, not the file.
  const dir = seedRun('flo_locked')
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  await assert.rejects(removeRun('flo_locked'), refusal('conflict', 'live'))
  assert.ok(fs.existsSync(dir))

  // a lock body we cannot read is refused rather than guessed at
  fs.writeFileSync(path.join(dir, 'run.lock'), '{"pid":')
  await assert.rejects(removeRun('flo_locked'), refusal('conflict', 'locked'))
  assert.ok(fs.existsSync(dir))

  // a lock left by a dead process is reclaimed — a crashed run stays deletable
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: 0x7fffffff, startedAt: Date.now() }))
  const out = await removeRun('flo_locked')
  assert.ok(!fs.existsSync(dir))
  assert.ok(fs.existsSync(out.trashPath))
})

// ─── the resume-vs-delete race: delete loses ────────────────────────────────────

test('resume vs delete: a launching resume wins, both at the marker and at the lock', async () => {
  const runId = 'flo_race'
  // 1. produce a resumable (interrupted) run. `cwd` is journaled explicitly because the
  //    resuming CLI child fills it in from meta/process.cwd() and the engine refuses a
  //    resume whose defaults differ (src/engine.js:853).
  const p = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock', cwd: process.cwd() }, runId, quiet: true })
  await until(async () => (await controlRequest(sockOf(runId), { cmd: 'status' }).catch(() => null))?.ok)
  await controlRequest(sockOf(runId), { cmd: 'cancel' })
  assert.equal((await p).status, 'interrupted')
  assert.ok(!fs.existsSync(path.join(runDir(runId), 'run.lock')), 'lock released — the run is quiescent')

  // 2. launch a REAL detached resume through the CLI: it writes the .resuming marker
  //    (tmp+rename) and spawns the engine, exactly as the viewer's resume route will.
  await cli(['run', fx('cancel.workflow.js'), '--resume', runId, '--detach', '--json', '--adapter', 'mock'])

  // 3a. the marker window: deriveRunState says 'starting' before any lock exists
  assert.ok(fs.existsSync(path.join(runDir(runId), '.resuming')), 'launch marker written')
  await assert.rejects(removeRun(runId), refusal('conflict', 'live'))

  // 3b. the lock window: wait until the marker has been consumed (src/engine.js:871) so
  //     this attempt is refused on the child's ownership of the run, not on the marker
  const pid = await until(() => {
    if (fs.existsSync(path.join(runDir(runId), '.resuming'))) return null
    const holder = JSON.parse(fs.readFileSync(path.join(runDir(runId), 'run.lock'), 'utf8'))
    return holder.pid !== process.pid ? holder.pid : null
  })
  await assert.rejects(removeRun(runId), refusal('conflict', 'live'))

  // delete lost on both attempts: the run is intact and the resume owns it
  assert.ok(fs.existsSync(runDir(runId)))
  assert.ok(fs.existsSync(path.join(runDir(runId), 'journal.jsonl')))
  assert.deepEqual(trashEntries().filter((e) => e.startsWith(runId)), [])

  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  await until(() => { try { process.kill(pid, 0); return false } catch { return true } })
})

// Wait for a foreign engine to take ownership of the run, then kill it. Returns the pid.
async function reapResumer(runId, ms = 8000) {
  const pid = await until(() => {
    const holder = JSON.parse(fs.readFileSync(path.join(runDir(runId), 'run.lock'), 'utf8'))
    return holder.pid !== process.pid ? holder.pid : null
  }, ms).catch(() => null)
  if (pid != null) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    await until(() => { try { process.kill(pid, 0); return false } catch { return true } })
  }
  return pid
}

test('resume vs delete: a resume launched INSIDE the commit window still wins', async () => {
  // The window the sequential test above cannot reach: the delete has passed every
  // guard — artifacts, containment, the lock, the final deriveRunState — and is about to
  // rename. A launcher that installs `.resuming` here has already returned
  // launchAccepted, so the delete must not proceed. §7.3.3: delete loses.
  const runId = 'flo_rw'
  const p = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock', cwd: process.cwd() }, runId, quiet: true })
  await until(async () => (await controlRequest(sockOf(runId), { cmd: 'status' }).catch(() => null))?.ok)
  await controlRequest(sockOf(runId), { cmd: 'cancel' })
  assert.equal((await p).status, 'interrupted')

  const mark = auditMark()
  let accepted = false
  await assert.rejects(
    removeRun(runId, {
      // A REAL detached resume through the shipped launcher — same code path the
      // viewer's POST /resume uses — driven into the contested window deterministically.
      beforeCommit: async () => {
        await cli(['run', fx('cancel.workflow.js'), '--resume', runId, '--detach', '--json', '--adapter', 'mock'])
        accepted = true
      },
    }),
    refusal('conflict', 'live'),
  )

  assert.ok(accepted, 'the resume was accepted inside the window')
  // delete lost: the run is intact where it was, and nothing reached the trash
  assert.ok(fs.existsSync(runDir(runId)), 'the run is back in runs/')
  assert.equal(fs.readFileSync(path.join(runDir(runId), 'journal.jsonl'), 'utf8').length > 0, true)
  assert.deepEqual(trashEntries().filter((e) => e.startsWith(runId)), [], 'trash is empty')
  // ...and the audit tells the truth about it rather than claiming a delete happened
  assert.deepEqual(auditSince(mark), [
    { op: 'delete', runId, outcome: 'ok' },
    { op: 'delete', runId, outcome: 'rolled-back', reason: 'resume_raced' },
  ])
  // the resume genuinely proceeds — the delete released the lock instead of holding it
  const pid = await reapResumer(runId)
  assert.ok(pid != null, 'the resumed engine took ownership of the run')
  fs.rmSync(runDir(runId), { recursive: true, force: true })
})

test('resume vs delete: a resume running INSIDE the post-rename window cannot resurrect the run', async () => {
  // The interval the previous test could not control: the delete has renamed
  // `runs/<id>` into the trash and has not yet checked for a raced resume. A resume
  // accepted just before that rename is executing RIGHT HERE — and if it recreates
  // `runs/<id>` (a recursive ensureDir before it owns the run) the rollback finds the
  // name taken, the real journal is stranded in trash and a stub is left behind.
  // §7.3.3 requires the rename to be the single linearization point: the resume finds
  // no run directory and refuses, the delete rolls back, delete loses. Nobody wins by
  // destroying anything.
  const runId = 'flo_rwp'
  const p = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock', cwd: process.cwd() }, runId, quiet: true })
  await until(async () => (await controlRequest(sockOf(runId), { cmd: 'status' }).catch(() => null))?.ok)
  await controlRequest(sockOf(runId), { cmd: 'cancel' })
  assert.equal((await p).status, 'interrupted')
  const journalBefore = fs.readFileSync(path.join(runDir(runId), 'journal.jsonl'), 'utf8')

  const mark = auditMark()
  const attempts = []
  let recreated = null
  await assert.rejects(
    removeRun(runId, {
      // accepted launch: the shipped handoff marker, installed before the rename so it
      // travels into the trash entry with the run (this is what makes delete lose)
      beforeCommit: () => { installResumeMarker(runDir(runId)) },
      // the run directory is in the trash at this instant. Advance the REAL resume —
      // the engine's own entry point, and the shipped detached launcher — through it.
      afterCommit: async () => {
        attempts.push(await runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock', cwd: process.cwd() }, resumeId: runId, quiet: true })
          .then(() => null, (err) => String(err.message)))
        attempts.push(await cli(['run', fx('cancel.workflow.js'), '--resume', runId, '--detach', '--json', '--adapter', 'mock'])
          .then(() => null, (err) => String(err.message)))
        recreated = fs.existsSync(runDir(runId))
      },
    }),
    refusal('conflict', 'live'),
  )

  // both resume paths refused, and said why, instead of resurrecting the directory
  assert.equal(recreated, false, 'no resume path recreated runs/<id> while the run was in the trash')
  assert.deepEqual(attempts, [
    `run ${runId} does not exist — nothing to resume`,        // the engine's own entry point
    `no journal for run ${runId}`,                            // the detached launcher, refusing before it spawns
  ])
  // the delete rolled back cleanly: the original run is back, byte-for-byte, trash empty
  assert.ok(fs.existsSync(runDir(runId)), 'the run is restored at its original path')
  assert.equal(fs.readFileSync(path.join(runDir(runId), 'journal.jsonl'), 'utf8'), journalBefore)
  assert.ok(fs.existsSync(path.join(runDir(runId), 'result.json')), 'the whole directory came back, not a stub')
  assert.deepEqual(trashEntries().filter((e) => e.startsWith(runId)), [], 'trash is empty')
  assert.deepEqual(auditSince(mark), [
    { op: 'delete', runId, outcome: 'ok' },
    { op: 'delete', runId, outcome: 'rolled-back', reason: 'resume_raced' },
  ])
  fs.rmSync(runDir(runId), { recursive: true, force: true })
})

test('resume vs delete: a marker installed DURING the under-lock state check still wins', async () => {
  // The seam the two tests above cannot reach, and the one that was open: the marker
  // baseline used to be snapshotted AFTER the under-lock `deriveRunState()`.
  // `deriveRunState` reads the marker path first and then keeps working (control-socket
  // probe, lock read), so a `.resuming` installed in that tail was invisible to the
  // derivation AND already present in the baseline — the post-rename diff found nothing
  // new and the delete committed against an accepted handoff.
  //
  // Driven deterministically with the shipped modules only: a real control server at the
  // run's socket path calls the real `installResumeMarker()` from inside the second
  // probe — i.e. after that derivation has read the marker path. No stub, no seam in
  // removeRun. With the baseline taken before the derivation, this marker is an addition
  // and the delete must lose.
  //
  // Own short canonical home: the probe must genuinely connect (see inFreshHome).
  await inFreshHome(async () => {
    const runId = 'flo_rwm'
    const p = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock', cwd: process.cwd() }, runId, quiet: true })
    await until(async () => (await controlRequest(sockOf(runId), { cmd: 'status' }).catch(() => null))?.ok)
    await controlRequest(sockOf(runId), { cmd: 'cancel' })
    assert.equal((await p).status, 'interrupted')
    const journalBefore = fs.readFileSync(path.join(runDir(runId), 'journal.jsonl'), 'utf8')
    assert.ok(!fs.existsSync(path.join(runDir(runId), '.resuming')), 'no handoff in flight yet')

    // probe 1 is removeRun's pre-lock derivation; probe 2 is the derivation under the lock
    let probes = 0
    let installedAt = 0
    const server = serveControl(sockOf(runId), () => {
      if (++probes === 2) { installResumeMarker(runDir(runId)); installedAt = probes }
      return { ok: false }      // never claims to be a live engine — only the marker decides
    })
    await server.ready

    const mark = auditMark()
    try {
      await assert.rejects(removeRun(runId), refusal('conflict', 'live'))
    } finally {
      await server.close()
    }
    assert.equal(installedAt, 2, 'the handoff landed inside the derivation, not before it')

    // delete lost: the run is intact where it was, with the accepted handoff still on it
    assert.ok(fs.existsSync(runDir(runId)), 'the run is back in runs/')
    assert.equal(fs.readFileSync(path.join(runDir(runId), 'journal.jsonl'), 'utf8'), journalBefore)
    assert.ok(fs.existsSync(path.join(runDir(runId), 'result.json')), 'the whole directory came back, not a stub')
    assert.ok(fs.existsSync(path.join(runDir(runId), '.resuming')), 'the handoff marker survived with the run')
    assert.deepEqual(trashEntries().filter((e) => e.startsWith(runId)), [], 'trash is empty')
    assert.deepEqual(auditSince(mark), [
      { op: 'delete', runId, outcome: 'ok' },
      { op: 'delete', runId, outcome: 'rolled-back', reason: 'resume_raced' },
    ])

    // ...and the run the handoff was accepted against is genuinely resumable: a real
    // detached resume takes ownership of the intact directory.
    await cli(['run', fx('cancel.workflow.js'), '--resume', runId, '--detach', '--json', '--adapter', 'mock'])
    const pid = await reapResumer(runId)
    assert.ok(pid != null, 'the resumed engine took ownership of the run')
    assert.equal(fs.readFileSync(path.join(runDir(runId), 'journal.jsonl'), 'utf8').startsWith(journalBefore), true,
      'the resumed engine appended to the original journal — it owns the SAME run')
  }, 'flo-w3-race-')
})

test('the resume handoff refuses once the run is gone — launchAccepted is never a lie', async () => {
  // The other half of the same linearization (src/run-lock.js): a marker installed after
  // the delete's rename cannot resolve `runs/<id>` at all, so the launcher refuses
  // instead of reporting a resume of a run that no longer exists.
  assert.throws(
    () => installResumeMarker(path.join(runsDir(), 'flo_deleted_mid_launch')),
    (err) => err instanceof RunLockError && err.code === 'vanished',
  )
  // and on the happy path it installs a marker that both deriveRunState and the delete's
  // commit check can see
  const dir = seedRun('flo_handoff')
  const before = resumeMarks(dir)
  const marker = installResumeMarker(dir)
  assert.ok(fs.existsSync(marker))
  assert.equal(resumeMarks(dir).filter((m) => !before.includes(m)).length, 1)
  await assert.rejects(removeRun('flo_handoff'), refusal('conflict', 'live'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('two deletes of the same run race on the run lock; exactly one wins', async () => {
  const dir = seedRun('flo_double')
  const results = await Promise.allSettled([removeRun('flo_double'), removeRun('flo_double')])
  const ok = results.filter((r) => r.status === 'fulfilled')
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)))
  assert.ok(!fs.existsSync(dir))
  assert.equal(trashEntries().filter((e) => e.startsWith('flo_double')).length, 1)
})

// ─── prune ──────────────────────────────────────────────────────────────────────

const age = (dir, ms) => {
  const t = (Date.now() - ms) / 1000
  for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), t, t)
  fs.utimesSync(dir, t, t)   // after the files: touching them would bump the dir
}

test('prune trashes only terminal runs past the cutoff, then purges aged trash', async () => {
  const old = seedRun('flo_prune_old');            age(old, 40 * DAY)
  const recent = seedRun('flo_prune_recent')
  // journal but no result → 'stale', not terminal: an unfinished run is never pruned
  const unfinished = seedRun('flo_prune_unfinished', { artifacts: { 'journal.jsonl': '{"type":"meta"}\n' } })
  age(unfinished, 40 * DAY)

  const now = Date.now()
  const out = await pruneRuns({ olderThanDays: 30, now })
  assert.deepEqual(out.removed.map((r) => r.runId), ['flo_prune_old'])
  assert.deepEqual(out.skipped, [])
  assert.ok(!fs.existsSync(old))
  assert.ok(fs.existsSync(recent), 'a recent terminal run stays')
  assert.ok(fs.existsSync(unfinished), 'a non-terminal run stays whatever its age')

  // pruning is trash-first: the run is recoverable for the TTL like any other delete
  const entry = path.join(trashDir(), `flo_prune_old.${now}`)
  assert.ok(fs.existsSync(path.join(entry, 'result.json')))
  await pruneRuns({ now: now + TRASH_TTL_DAYS * DAY })
  assert.ok(!fs.existsSync(entry), 'aged trash purged with no --older-than given')
  assert.ok(fs.existsSync(recent), 'a bare prune touches no runs')
})

test('prune rejects a nonsense window before touching anything', async () => {
  const dir = seedRun('flo_prune_guard'); age(dir, 400 * DAY)
  for (const olderThanDays of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(pruneRuns({ olderThanDays }), (err) => err instanceof RetentionError && err.code === 'bad_request')
  }
  assert.ok(fs.existsSync(dir))
  await removeRun('flo_prune_guard')
})

// ─── CLI surface ────────────────────────────────────────────────────────────────

const CLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-retention-cli-'))
const runCliIn = (flowitionHome, args) => new Promise((resolve) => {
  execFile(process.execPath, [bin, ...args], { env: { ...process.env, FLOWITION_HOME: flowitionHome }, timeout: 30000 },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
})
const runCli = (args) => runCliIn(CLI_HOME, args)
const seedIn = (flowitionHome, id) => {
  const dir = path.join(flowitionHome, 'runs', id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'result.json'), '{"status":"completed","result":"ok"}')
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), '{"type":"meta"}\n')
  return dir
}
const cliRun = (id) => seedIn(CLI_HOME, id)
const auditIn = (flowitionHome) =>
  fs.readFileSync(path.join(flowitionHome, 'viewer-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('cli: rm moves a run to trash, --purge empties it', async () => {
  const dir = cliRun('flo_cli_rm')
  const r = await runCli(['rm', 'flo_cli_rm', '--json'])
  assert.equal(r.code, 0, r.stderr)
  const { removed } = JSON.parse(r.stdout)
  assert.equal(removed.runId, 'flo_cli_rm')
  assert.ok(!fs.existsSync(dir))
  assert.ok(fs.existsSync(removed.trashPath))

  const purge = await runCli(['rm', '--purge', '--json'])
  assert.equal(purge.code, 0, purge.stderr)
  assert.equal(JSON.parse(purge.stdout).purged.length, 1)
  assert.ok(!fs.existsSync(removed.trashPath))
})

test('cli: rm surfaces refusals as clean errors, never a stack', async () => {
  for (const [args, message] of [
    [['rm', '../victim'], /^flowition: invalid run id /],
    [['rm', 'flo_absent'], /^flowition: run flo_absent does not exist/],
  ]) {
    const r = await runCli(args)
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(r.stderr, message)
    assert.doesNotMatch(r.stderr, /\n\s+at /)
  }
  fs.mkdirSync(path.join(CLI_HOME, 'runs', 'flo_cli_bare'), { recursive: true })
  const bare = await runCli(['rm', 'flo_cli_bare'])
  assert.equal(bare.code, 1)
  assert.match(bare.stderr, /^flowition: run flo_cli_bare has no flowition run artifacts/)
  assert.ok(fs.existsSync(path.join(CLI_HOME, 'runs', 'flo_cli_bare')))

  const usage = await runCli(['rm'])
  assert.equal(usage.code, 1)
  assert.match(usage.stderr, /^usage: flowition rm/)
})

test('cli: prune --older-than trashes aged terminal runs', async () => {
  const old = cliRun('flo_cli_old')
  const fresh = cliRun('flo_cli_fresh')
  age(old, 10 * DAY)
  const r = await runCli(['prune', '--older-than', '5', '--json'])
  assert.equal(r.code, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(out.removed.map((x) => x.runId), ['flo_cli_old'])
  assert.ok(!fs.existsSync(old))
  assert.ok(fs.existsSync(fresh))

  const bad = await runCli(['prune', '--older-than', '-1'])
  assert.equal(bad.code, 1)
  assert.equal(bad.stderr.trim(), 'flowition: --older-than must be an integer >= 0')

  const usage = await runCli(['prune'])
  assert.equal(usage.code, 1)
  assert.match(usage.stderr, /^usage: flowition prune/)

  // --purge on prune empties the trash in the same pass
  const purge = await runCli(['prune', '--older-than', '5', '--purge', '--json'])
  assert.equal(purge.code, 0, purge.stderr)
  assert.equal(JSON.parse(purge.stdout).purged.length, 1)
})

// ─── the shipped audit trail (§7.3, Sol-4) ──────────────────────────────────────

test('cli: every rm and prune is persisted to the 0600 audit log, in order', async () => {
  // Not "an injected callback ran": the destructive commands users actually type must
  // leave a record in $FLOWITION_HOME/viewer-audit.jsonl, because delete destroys the
  // run that would otherwise be its own audit trail.
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-retention-audit-'))
  seedIn(h, 'flo_audit_a')
  const pruned = seedIn(h, 'flo_audit_b'); age(pruned, 10 * DAY)
  fs.mkdirSync(path.join(h, 'runs', 'flo_audit_bare'), { recursive: true })

  assert.equal((await runCliIn(h, ['rm', 'flo_audit_a'])).code, 0)
  assert.equal((await runCliIn(h, ['rm', 'flo_audit_bare'])).code, 1)      // refused
  assert.equal((await runCliIn(h, ['prune', '--older-than', '5'])).code, 0)

  const lines = auditIn(h)
  assert.deepEqual(lines.map((l) => [l.op, l.runId, l.outcome, l.reason ?? null]), [
    ['delete', 'flo_audit_a', 'ok', null],
    ['delete', 'flo_audit_bare', 'refused', 'not_a_run'],
    ['delete', 'flo_audit_b', 'ok', null],
  ])
  // append-only and in call order — later ops never rewrite earlier ones
  assert.ok(lines.every((l) => Number.isInteger(l.t)))
  assert.ok(lines[0].t <= lines[1].t && lines[1].t <= lines[2].t)
  // no message bodies, no transcript content — only the five documented keys
  assert.deepEqual(Object.keys(lines[0]).sort(), ['op', 'outcome', 'runId', 't'])
  assert.deepEqual(Object.keys(lines[1]).sort(), ['op', 'outcome', 'reason', 'runId', 't'])
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(h, 'viewer-audit.jsonl')).mode & 0o777, 0o600, 'audit log is 0600')
    assert.equal(auditPath(), path.join(process.env.FLOWITION_HOME, 'viewer-audit.jsonl'))
  }
  fs.rmSync(h, { recursive: true, force: true })
})

test('cli: a delete that cannot be recorded does not happen', async () => {
  // The fail-closed rule, proven on the shipped path rather than through an injected
  // throwing writer: an unwritable audit log stops `flowition rm` destroying anything.
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-retention-audit-fail-'))
  const dir = seedIn(h, 'flo_unrecordable')
  fs.mkdirSync(path.join(h, 'viewer-audit.jsonl'))   // append → EISDIR

  const r = await runCliIn(h, ['rm', 'flo_unrecordable'])
  assert.equal(r.code, 1, r.stdout)
  assert.match(r.stderr, /^flowition: cannot record the delete of flo_unrecordable in the audit log/)
  assert.doesNotMatch(r.stderr, /\n\s+at /)
  assert.equal(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'), '{"status":"completed","result":"ok"}')
  assert.deepEqual(fs.readdirSync(path.join(h, 'trash')), [], 'nothing reached the trash')
  assert.ok(!fs.existsSync(path.join(dir, 'run.lock')), 'the delete lock is released')

  // prune is the same operation in bulk and fails the same way
  age(dir, 10 * DAY)
  const p = await runCliIn(h, ['prune', '--older-than', '5', '--json'])
  assert.equal(p.code, 0, p.stderr)   // prune reports per-run skips rather than aborting
  const out = JSON.parse(p.stdout)
  assert.deepEqual(out.removed, [])
  assert.deepEqual(out.skipped.map((s) => [s.runId, s.reason]), [['flo_unrecordable', 'audit_failed']])
  assert.ok(fs.existsSync(path.join(dir, 'journal.jsonl')), 'the run survives prune too')
  fs.rmSync(h, { recursive: true, force: true })
})
