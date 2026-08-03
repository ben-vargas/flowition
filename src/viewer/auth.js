// Viewer credentials: the read token, the ephemeral control token, the healthz
// challenge proof, and the capability set (DESIGN §7.1.2, §4.2.1, §7.2).
//
// Threat model this file answers to (§7.4): loopback binding is necessary and NOT
// sufficient — any page in the user's browser can reach 127.0.0.1, and any other local
// user can open a TCP connection to it. The transcripts behind this server are exactly
// what the 0700 run directory exists to protect. So:
//   - the read token is a 0600 file another local user cannot read;
//   - comparisons are constant-time;
//   - the token never enters argv and never enters a log line (see redactSecrets);
//   - reuse of an existing instance is proven by HMAC over a caller-chosen challenge,
//     so the token is never transmitted during discovery (§4.2.1).
//
// node: builtins + ../util.js only (§11.2 denylist).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { home, runsDir, ensureDir } from '../util.js'

/** The five write capabilities `--control` can enable, in canonical order (§7.2). */
export const CAPABILITIES = ['send', 'answer', 'cancel', 'resume', 'delete']

// ---- the flowition home: the platform + ownership choke point (§4.1, §7.4) ---------
//
// **This is the only place in `src/viewer/**` that may import `home`/`runsDir` from
// ../util.js, and `viewerHome()` is the only way the rest of the server learns where the
// home is** (enforced by a test that greps the import lists — see test/viewer-reuse).
//
// §4.1's ownership check used to live at the top of `startViewer()` and nowhere else, so
// every *other* entry point that touches the home — discovery, reuse, `--print-url`, the
// startup lock, the token file — walked straight into a home owned by another user. That
// is a cross-user boundary, not a startup nicety: `viewer.token` is created there
// (§7.1.2) and `deriveRunState` mutates aged `.resuming` markers, which must only ever
// happen as the run owner (§4.1, RECON-flowition §6.3.9).
//
// Guarding the *path accessor* instead of the call sites is the point: a path that has
// not been asserted cannot be obtained, so a new entry point added later is guarded by
// construction rather than by remembering to call an assertion.
//
// It lives in auth.js because auth.js is the lowest viewer module (node: builtins +
// ../util.js, imported by everything, importing no viewer module — so no cycle), and
// because §4.1's own rationale for covering `home()` is that `viewer.token` lives there.

/**
 * §13.1: the engine's control-socket story on Windows is unresolved upstream, and a
 * half-working viewer is worse than a clear refusal.
 */
export function assertViewerPlatform() {
  if (process.platform === 'win32') {
    throw new Error('flowition viewer is not supported on Windows in v1 — the run control socket has no Windows implementation')
  }
}

/**
 * §4.1: `stat(home())` and `stat(runsDir())`. ENOENT creates the directory 0700 and
 * proceeds (a fresh install has neither — `ensureDir` only runs on the run path); any
 * other stat error refuses with that error; a directory owned by another uid refuses with
 * a clear message.
 */
export function assertViewerHome() {
  assertViewerPlatform()
  for (const dir of [home(), runsDir()]) {
    let stat
    try {
      stat = fs.statSync(dir)
    } catch (err) {
      if (err.code === 'ENOENT') { ensureDir(dir, 0o700); continue }
      throw new Error(`cannot use ${dir}: ${err.message}`)
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`${dir} is owned by uid ${stat.uid}, not you (uid ${process.getuid()}) — refusing to run the viewer against another user's flowition home`)
    }
  }
}

/** The asserted flowition home. Every viewer path under the home is built from this. */
export function viewerHome() {
  assertViewerHome()
  return home()
}

/** The asserted runs directory — same gate, same reason. */
export function viewerRunsDir() {
  assertViewerHome()
  return runsDir()
}

export const tokenPath = () => path.join(viewerHome(), 'viewer.token')

const TOKEN_BYTES = 32
/** 32 bytes base64url is exactly 43 unpadded characters. */
const TOKEN_CHARS = 43
const TOKEN_ALPHABET = /^[A-Za-z0-9_-]+$/

/**
 * §7.1.2 says what a read token *is*: "32 random bytes base64url". Anything else on disk
 * is not a credential, and accepting it is not leniency — it is the whole authentication
 * boundary. A `viewer.token` containing `x` would have the server answer
 * `Authorization: Bearer x` with 200, i.e. a one-character password on the surface that
 * serves every transcript the 0700 run directory exists to protect (§7.4).
 *
 * Canonical, not merely decodable: `Buffer.from(…, 'base64url')` silently ignores stray
 * characters and silently drops the unused trailing bits, so a whole family of strings
 * decodes to 32 bytes. The alphabet check plus the re-encode round-trip admit exactly one
 * spelling per token, which is also what makes the constant-time compare meaningful —
 * two spellings of "the same" secret would both authenticate but not be `===`.
 */
export function isCanonicalToken(value) {
  if (typeof value !== 'string' || value.length !== TOKEN_CHARS) return false
  if (!TOKEN_ALPHABET.test(value)) return false
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length === TOKEN_BYTES && bytes.toString('base64url') === value
}

const octal = (mode) => (mode & 0o777).toString(8).padStart(4, '0')

/**
 * The permission bits that make a token file a **disclosed** credential: any group bit,
 * any other bit. `0o077` and not `~0o600` on purpose — the owner-execute bit is noise, the
 * group/other bits are the boundary (§7.1.2, §7.4 "Another local user").
 */
const EXPOSED_BITS = 0o077

/** True when a mode grants group or other access of any kind. */
const isExposedMode = (mode) => (mode & EXPOSED_BITS) !== 0

/**
 * §7.1.2 does not merely ask for a 0600 token file, it *is* the boundary: "another local
 * user (0600 file they cannot read)" is the only thing standing between a loopback TCP
 * port and every transcript the 0700 run dir protects (§7.4).
 *
 * So the mode is **asserted, never merely attempted**. An earlier revision called a
 * `hardenMode()` that swallowed every `chmod` error and then returned the token anyway —
 * a token that is world-readable, or owned by someone else, or a symlink pointing at a
 * file an attacker controls, stayed in service while the server published transcripts
 * behind it. That is a fail-open credential check, and the only correct answer is to
 * refuse to start.
 *
 * **Repair is only for modes that cannot have disclosed anything.** `chmod 0600` on a file
 * that was 0644 is not a fix and must never be treated as one: the secret has already been
 * readable to every local user for as long as the file existed, so tightening the bits
 * afterwards revokes nothing (and a group/other-*writable* file may hold a value an
 * attacker chose). Owner-only modes are different in kind — 0000, 0400, 0200, 0700 never
 * granted anyone else a byte, so chmod to 0600 genuinely restores the invariant and the
 * value on disk is still the one this user minted. Exposed modes get rotation instead; see
 * `rotateExposedToken`.
 *
 * Everything here works on the **open descriptor**, not the path: `fstat`/`fchmod` name
 * the exact inode this process is about to read, so nothing can be swapped in between the
 * check and the read (and `openSync` follows symlinks, so a symlinked `viewer.token`
 * fails the `isFile()`/uid test on its *target*, which is what matters).
 *
 * @param {number} fd descriptor open on the file being validated
 * @param {string} file its path, for the message only
 * @returns {import('node:fs').Stats} the final `fstat`, so callers learn the exact inode
 */
function assertTokenFileSecure(fd, file) {
  // Non-POSIX: there are no uids or mode bits to assert. `assertViewerPlatform()` has
  // already refused win32, so this is unreachable in practice.
  if (typeof process.getuid !== 'function') return fs.fstatSync(fd)
  const refuse = (why) => new Error(
    `${file} cannot be used as a viewer token: ${why} — §7.1.2 requires a regular file owned by you with mode 0600. `
    + `Rotate it (stop any running viewer, \`rm ${file}\`) and start the viewer again`,
  )
  let st = fs.fstatSync(fd)
  if (!st.isFile()) throw refuse('it is not a regular file')
  if (st.uid !== process.getuid()) throw refuse(`it is owned by uid ${st.uid}, not you (uid ${process.getuid()})`)
  if ((st.mode & 0o777) === 0o600) return st
  // Reachable here only for a *freshly minted* inode (the read path routes exposed modes
  // to rotation before it ever gets this far), where an exposed mode means something is
  // actively wrong with the home — `openSync(…, 'wx', 0o600)` cannot produce one, since a
  // umask can only narrow the requested mode. Refuse rather than chmod-and-serve.
  if (isExposedMode(st.mode)) throw refuse(`its mode is ${octal(st.mode)}, which grants group or other access to the credential`)
  // Repair an owner-only mode left behind by a stray umask — and then *prove* the repair.
  // A chmod whose failure is discarded is indistinguishable from one that worked.
  try {
    fs.fchmodSync(fd, 0o600)
  } catch (err) {
    throw refuse(`its mode is ${octal(st.mode)} and chmod failed (${err.code ?? err.message})`)
  }
  st = fs.fstatSync(fd)
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600) {
    throw refuse(`its permissions could not be secured (still mode ${octal(st.mode)}, uid ${st.uid})`)
  }
  return st
}

/**
 * Open the token file for reading, repairing exactly one recoverable case: a file we own
 * that is unreadable to its own owner (mode 0, a stray umask), which no descriptor can be
 * obtained for and therefore no `fchmod` can fix. The path-level repair is gated on an
 * ownership check and retried once; anything else propagates.
 *
 * An owner-unreadable file is not automatically an *unread* one: 0060 and 0004 also deny
 * the owner while handing the credential to everyone else. Those must reach
 * `rotateExposedToken`, so they are reported rather than chmodded — chmod here would erase
 * the only evidence that the token had been exposed and then hand back a "repaired" file.
 *
 * @returns {{fd: number} | {absent: true} | {exposed: {mode: number, dev: number, ino: number}}}
 */
function openTokenFile(file, repaired = false) {
  try {
    return { fd: fs.openSync(file, 'r') }
  } catch (err) {
    if (err.code === 'ENOENT') return { absent: true }
    if (repaired || (err.code !== 'EACCES' && err.code !== 'EPERM')) throw err
    const st = fs.lstatSync(file)
    if (!st.isFile() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw err
    if (typeof process.getuid === 'function' && isExposedMode(st.mode)) {
      return { exposed: { mode: st.mode & 0o777, dev: st.dev, ino: st.ino } }
    }
    fs.chmodSync(file, 0o600)
    return openTokenFile(file, true)
  }
}

/**
 * Classify what is at the token path, without ever reading the bytes of a file that is not
 * fit to be a credential.
 *
 * Every verdict carries `dev`/`ino` from the same `fstat` that produced it. For `exposed`
 * that is what lets the rotation below unlink *that inode* and nothing else; for `ok` it is
 * the identity a running server pins its credential to, so a later replacement of the file
 * is detectable even if the replacement is valid in its own right (`createCredentialGuard`).
 *
 * @returns {{kind: 'absent'}
 *   | {kind: 'exposed', mode: number, dev: number, ino: number}
 *   | {kind: 'ok', raw: Buffer, dev: number, ino: number}}
 */
function inspectTokenFile(file) {
  const opened = openTokenFile(file)
  if (opened.absent) return { kind: 'absent' }
  if (opened.exposed) return { kind: 'exposed', ...opened.exposed }
  const fd = opened.fd
  try {
    if (typeof process.getuid === 'function') {
      const st = fs.fstatSync(fd)
      // Ownership and file-ness are decided *before* exposure: a foreign-owned file is not
      // ours to rotate, and §7.1.2's refusal for it is the more precise answer.
      if (st.isFile() && st.uid === process.getuid() && isExposedMode(st.mode)) {
        return { kind: 'exposed', mode: st.mode & 0o777, dev: st.dev, ino: st.ino }
      }
    }
    const st = assertTokenFileSecure(fd, file)
    return { kind: 'ok', raw: fs.readFileSync(fd), dev: st.dev, ino: st.ino }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The token file's **raw bytes**, or null when it is absent; throws on an exposed one.
 *
 * Deliberately not `trim()`ed. §7.1.2 defines the credential exactly — 32 random bytes
 * base64url — and a file with whitespace around one is not that file. An earlier revision
 * trimmed before validating, so a 45-byte ` <token>\n` passed `isCanonicalToken`
 * and was served as the credential even though the bytes on disk were not canonical; the
 * same trim also made the publish confirmation compare something other than what was
 * written. Raw bytes make "is this a credential?" and "is this what I just published?"
 * the same question they claim to be — and they make the zero-length test exact: only a
 * genuinely 0-byte file is a publication in progress.
 *
 * Used by `confirmPublished`, which is reading back an inode it created 0600 moments ago:
 * an exposed mode there is not a stale file to rotate but a live anomaly, so it raises.
 *
 * @returns {{raw: Buffer, dev: number, ino: number}|null}
 */
function readTokenFile(file) {
  const found = inspectTokenFile(file)
  if (found.kind === 'absent') return null
  if (found.kind === 'exposed') {
    throw new Error(`${file} cannot be used as a viewer token: its mode is ${octal(found.mode)}, which grants group or other access to the credential — §7.1.2 requires mode 0600. Stop any running viewer, \`rm ${file}\`, and start the viewer again to mint a fresh token`)
  }
  return { raw: found.raw, dev: found.dev, ino: found.ino }
}

/**
 * The same classification, but as data a **running** server can act on: never throws, and
 * the `ok` case is already checked against §7.1.2's definition of a credential.
 *
 * It exists because "is my credential still the one on disk?" is a question asked on a hot
 * path (every `/api` request) and by a timer, where a throw would become a 500 or an
 * unhandled rejection instead of a revocation. Everything unexpected therefore collapses
 * into `error`, which callers treat as **fail closed** — a credential this process cannot
 * verify is one it must not serve (§7.4).
 *
 * `tokenPath()` is deliberately inside the try: a home that became unreadable, or that
 * turned out to belong to another uid, is a revocation for a running server even though it
 * is a loud refusal at startup (where `loadOrCreateCredential` raises the precise error).
 *
 * @param {string} [file] the exact path to verify. A running server passes the path it
 *   resolved at startup rather than re-deriving it: `tokenPath()` reads `$FLOWITION_HOME`
 *   live, so a server that re-derived it would follow an embedder's later change of that
 *   variable to a different home and revoke itself over a file it never served.
 * @returns {{kind: 'absent'} | {kind: 'publishing'} | {kind: 'invalid'}
 *   | {kind: 'error', code: string} | {kind: 'exposed', mode: number, dev: number, ino: number}
 *   | {kind: 'ok', token: string, dev: number, ino: number}}
 */
export function inspectToken(file) {
  try {
    const found = inspectTokenFile(file ?? tokenPath())
    if (found.kind !== 'ok') return found
    if (!found.raw.length) return { kind: 'publishing' }
    const token = found.raw.toString('utf8')
    if (!isCanonicalToken(token)) return { kind: 'invalid' }
    return { kind: 'ok', token, dev: found.dev, ino: found.ino }
  } catch (err) {
    // The code only — an `err.message` here names the home, and these reasons reach an
    // HTTP body (§5.2: refusal messages carry no filesystem detail).
    return { kind: 'error', code: err?.code ?? 'unreadable' }
  }
}

/**
 * Revoke an exposed token file by **removing** it, so the loop above mints a fresh 0600
 * credential in its place.
 *
 * You cannot un-leak a credential by tightening its permissions. If `viewer.token` has any
 * group or other bit set, every local user has had the opportunity to read it for as long
 * as it has existed, and a `chmod 0600` afterwards changes nothing about that — the value
 * is burned. Serving it anyway would leave the entire §7.1.2 read surface (every
 * transcript the 0700 run dir protects) behind a credential the §7.4 "another local user"
 * adversary may already hold. A group/other-*writable* file is worse still: the value may
 * be one an attacker chose, which makes both the bearer check and the §4.2.1 challenge
 * proof theirs to compute. Rotation is the only response that restores the invariant.
 *
 * Two safeties around the `unlink`:
 *   - it names the **exact inode** that was condemned (`dev`+`ino`) and re-checks that it
 *     is still exposed. A peer racing the same rotation may already have replaced the file
 *     with a good 0600 token, and unlinking *that* would revoke a credential a live viewer
 *     is serving behind — the very failure this function exists to prevent, inverted.
 *   - a failed `unlink` **raises**. Falling through would return the exposed token, which
 *     is precisely the behaviour being fixed.
 *
 * The read loop's "wait out a zero-byte file, never reclaim it" rule does not extend here:
 * an exposed file is rotated whether or not it has content yet. `publishToken` cannot
 * produce one (it links a fully-written 0600 inode, and a umask only narrows `openSync`'s
 * mode), so an exposed zero-byte file is a foreign writer publishing a credential at the
 * wrong mode. Unlinking under it costs that writer a token nobody can discover — its
 * §4.2.1 proof then fails and a fresh instance binds. Degradation, not disclosure.
 *
 * @param {string} file
 * @param {{mode: number, dev: number, ino: number}} exposed
 * @returns {boolean} true when this call removed the file
 */
function rotateExposedToken(file, exposed) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return false   // a peer rotated it first
    throw err
  }
  // A symlink is the one case where `lstat` cannot match: `fstat` condemned the *target*,
  // so the ino guard would never fire and the loop would spin to its rotation limit.
  // Removing the name is the right repair anyway — `unlink` never touches the target, and a
  // `viewer.token` that points at a group-readable file elsewhere is not a credential store.
  if (!st.isSymbolicLink()) {
    if (st.dev !== exposed.dev || st.ino !== exposed.ino) return false
    if (!st.isFile() || !isExposedMode(st.mode)) return false
  }
  try {
    fs.unlinkSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw new Error(`${file} has mode ${octal(exposed.mode)}, which exposes the viewer token to other local users, and it could not be removed to rotate it (${err.code ?? err.message}) — tightening the mode would not revoke a credential that may already have been read, so delete the file yourself and start the viewer again`)
  }
  return true
}

/** A wedged home is a startup failure, not a rotation loop. */
const MAX_ROTATIONS = 3

/**
 * The refusal for an exposed token file that this call is **not cleared to rotate**.
 *
 * Rotating a token is not a private act: any viewer still running for this home is
 * authenticating with the value about to be destroyed, and it keeps authenticating it —
 * from its own memory — long after the file has changed underneath it. So a rotation that
 * happens without coordinating with that listener does not revoke the leaked credential at
 * all; it only mints a second one and hides the first behind a fresh `viewer.json`, leaving
 * the exposed token live on the old port. That is strictly worse than refusing.
 *
 * Hence `loadOrCreateCredential` never rotates on its own authority. The viewer entry points
 * in index.js pass a `clearRotation` predicate that first fails the running listener closed
 * and confirms it is gone (`establishCredential`); any other caller — including a future
 * entry point that forgets — lands here and is told what to do by hand.
 */
const exposedRefusal = (file, mode) => new Error(
  `${file} has mode ${octal(mode)}, which exposes the viewer token to other local users, so its value is burned and cannot be served — §7.1.2 requires mode 0600. `
  + `Replacing it is only safe once nothing is serving it: stop any running viewer for this home, \`rm ${file}\`, and start the viewer again to mint a fresh token`,
)

/**
 * `fs.writeSync` is allowed to write fewer bytes than it was given. Ignoring its return
 * value therefore publishes a *truncated* token on a short write — a shorter secret than
 * the one this process believes it published, so the two diverge and the on-disk one is
 * weaker than 32 bytes. Loop until every byte is out.
 *
 * @param {number} fd
 * @param {Buffer} buf
 * @param {{write?: (fd: number, buf: Buffer, off: number, len: number) => number}} [opts]
 *   the injectable write is for the forced-short-write test only
 */
export function writeFully(fd, buf, { write = fs.writeSync } = {}) {
  let off = 0
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off)
    // A zero/negative return would spin this loop forever; it means the descriptor is not
    // accepting the bytes, which is a failure to publish, not something to retry.
    if (!(n > 0)) throw new Error(`short write: ${off} of ${buf.length} bytes reached the file`)
    off += n
  }
}

const TOKEN_RETRY_MS = 10
/** Total budget before giving up entirely (a wedged home is a startup failure, not a hang). */
const TOKEN_DEADLINE_MS = 5000

/** A blocking sleep — this function is synchronous by design, and so is every caller. */
export const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/**
 * Read `$FLOWITION_HOME/viewer.token`, publishing one on first use (§7.1.2). All
 * concurrent callers must converge on ONE token: the token is the server's credential
 * *and* the shared secret behind the §4.2.1 challenge proof, so two callers walking away
 * with different values means a probe that cannot verify a genuine viewer — discovery
 * silently degrades to "not ours" and a starting caller binds a second port.
 *
 * **Publication is atomic and the published path is never observably empty.** A token is
 * written in full, 0600, into a unique temporary file and then moved into place with
 * `link()`, which fails `EEXIST` rather than overwriting — so the winner of a race is
 * decided by a single filesystem operation and the loser simply reads the winner's value.
 * There is no window in which `viewer.token` exists but is incomplete, which is what
 * makes the read path above trivially correct.
 *
 * A zero-byte `viewer.token` is therefore never something this code produced. It can only
 * be a foreign writer holding an `O_EXCL` descriptor open (the hardlink-less fallback
 * below, or an older build), so it is **waited out and never reclaimed on a timer**:
 * unlinking it would make that creator write through an unlinked descriptor and return a
 * token that exists nowhere on disk while we publish a different one — silent divergence,
 * exactly the failure this whole function exists to prevent. If it never fills in, the
 * call fails loudly with the path to delete.
 *
 * A **non-empty** file, by contrast, is checked against §7.1.2's definition of a token
 * (`isCanonicalToken`) and rejected if it is anything else. That is the difference between
 * "another process is publishing" and "this file is not a credential": the first is a
 * schedule to wait out, the second is a broken authentication boundary to refuse.
 *
 * An existing file whose mode grants group or other access is a **third** case, and the
 * only one that overwrites: its value is disclosed, so it is unlinked unread and replaced
 * (`rotateExposedToken`). Because that deliberately breaks the credential of any viewer
 * still running for this home, it happens **only when the caller has cleared the way** —
 * see `exposedRefusal` and `establishCredential` (index.js). Without clearance this call
 * refuses and changes nothing.
 *
 * @param {{retryMs?: number, deadlineMs?: number, onWait?: () => void,
 *   onRotate?: (info: {file: string, mode: string, reason: string}) => void,
 *   clearRotation?: (info: {file: string, mode: string}) => boolean}} [opts]
 *   timing seams for the concurrency tests; `onRotate` — a notification seam so a caller can
 *   tell the user their token was revoked (it never receives a token value); `clearRotation`
 *   — the caller's assertion that no listener is still serving the exposed value. It may
 *   throw a more specific refusal of its own, and anything other than `true` refuses.
 * @returns {{token: string, dev: number, ino: number, file: string}} the credential, the
 *   inode it came from — which is what makes a later replacement detectable — and the path it
 *   was resolved to, so a long-lived server re-verifies that file and not whatever
 *   `$FLOWITION_HOME` names later
 */
export function loadOrCreateCredential({
  retryMs = TOKEN_RETRY_MS,
  deadlineMs = TOKEN_DEADLINE_MS,
  onWait,
  onRotate,
  clearRotation,
  now = () => Date.now(),
  sleep = sleepSync,
} = {}) {
  // `tokenPath()` asserts platform + ownership and creates the home 0700 if it is
  // missing, so a token is never read from — nor minted into — a foreign home (§4.1).
  const file = tokenPath()
  const deadline = now() + deadlineMs
  let rotations = 0

  for (;;) {
    // Ownership, file-ness and mode are decided on the open descriptor before a byte is
    // read. Absent → 'absent'; exposed mode → 'exposed', bytes never read; otherwise the
    // raw bytes, with a genuinely 0-byte file coming back empty.
    const found = inspectTokenFile(file)

    if (found.kind === 'exposed') {
      // The disclosed value is never read, never returned, never served. Bound the retries:
      // if something keeps re-creating an exposed token, that is a broken home, not a race.
      if (++rotations > MAX_ROTATIONS) {
        throw new Error(`${file} keeps reappearing with group/other-accessible permissions (mode ${octal(found.mode)}) after ${MAX_ROTATIONS} rotations — something is re-creating it, so fix that and start the viewer again`)
      }
      // Destroying a credential a live listener is still authenticating requires clearance
      // from the caller, re-checked on every round of this loop (the state it asserts can
      // change between rounds). No clearance, or a clearance that says no: refuse, and leave
      // the file exactly as it is.
      if (clearRotation?.({ file, mode: octal(found.mode) }) !== true) throw exposedRefusal(file, found.mode)
      if (rotateExposedToken(file, found)) {
        onRotate?.({ file, mode: octal(found.mode), reason: 'the token file was readable or writable by other local users, so it was revoked and a new one minted' })
      }
      continue
    }

    const read = found.kind === 'absent' ? null : found
    const raw = read?.raw ?? null

    if (raw === null) {
      const minted = publishToken(file)
      if (minted) return minted
      // Someone else won the link. Loop round and read theirs — which, by construction,
      // is already complete on disk.
      continue
    }

    if (raw.length) {
      // Fail closed on anything that is not a §7.1.2 credential (a hand-written file, a
      // truncated one left by a crash mid-write, a token with whitespace around it, a
      // foreign format). It is deliberately NOT overwritten: a live viewer may be
      // authenticating against it, and replacing it would leave that instance unreachable
      // while this one publishes a different secret. The message never echoes the content
      // — a malformed token is still a secret.
      const value = raw.toString('utf8')
      if (!isCanonicalToken(value)) {
        throw new Error(`${file} is not a valid viewer token: expected ${TOKEN_CHARS} base64url characters (${TOKEN_BYTES} random bytes), found ${raw.length} byte(s) that are not exactly one — delete the file and try again`)
      }
      return { token: value, dev: read.dev, ino: read.ino, file }
    }

    // Present but zero bytes: a foreign creator mid-write. Wait; never reclaim.
    if (now() >= deadline) {
      throw new Error(`could not establish a viewer token: ${file} has been empty for ${deadlineMs}ms — no process is publishing it, so delete the file and try again`)
    }
    onWait?.()
    sleep(retryMs)
  }
}

/**
 * §7.1.2's read token as a bare string — the shape every caller that only needs the
 * credential uses. `loadOrCreateCredential` is the same call for callers that also need the
 * inode it came from (the server, which pins its credential to that identity).
 *
 * @returns {string} 32 random bytes, base64url
 */
export const loadOrCreateToken = (opts) => loadOrCreateCredential(opts).token

/**
 * Write a complete 0600 token to a unique temp file, then `link()` it into place.
 *
 * `link` is the no-overwrite publish: it either creates the name or fails `EEXIST`, and
 * because the inode is fully written and 0600 before it is ever named `viewer.token`, no
 * reader can see a partial token. `rename` would be wrong here — it silently replaces a
 * token other processes are already using.
 *
 * @returns {{token: string, dev: number, ino: number}|null} the credential, or null when
 *   another caller published first
 */
function publishToken(file) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    writeFully(fd, Buffer.from(token, 'utf8'))
    // 0600 is asserted on the inode *before* it is ever named `viewer.token`, so the
    // published name is never briefly world-readable.
    assertTokenFileSecure(fd, tmp)
  } finally { fs.closeSync(fd) }
  try {
    fs.linkSync(tmp, file)
    // The linked name is our own fully-written inode, so this cannot observe a peer's
    // token; it is the assertion that what we published is what we are about to return.
    return confirmPublished(file, token)
  } catch (err) {
    if (err.code === 'EEXIST') return null
    // Filesystems without hardlinks (some FUSE/network mounts). Fall back to an O_EXCL
    // create + immediate write: still atomic in who-wins terms, at the cost of a
    // microsecond-wide window where the published path is empty — which the read loop
    // above waits out rather than reclaiming.
    if (err.code === 'EPERM' || err.code === 'ENOSYS' || err.code === 'EOPNOTSUPP' || err.code === 'ENOTSUP') {
      return publishByExclusiveCreate(file, token)
    }
    throw err
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* already unlinked, or never created */ }
  }
}

function publishByExclusiveCreate(file, token) {
  let fd
  try {
    fd = fs.openSync(file, 'wx', 0o600)
  } catch (err) {
    if (err.code === 'EEXIST') return null
    throw err
  }
  try {
    writeFully(fd, Buffer.from(token, 'utf8'))
    assertTokenFileSecure(fd, file)
  } finally { fs.closeSync(fd) }
  return confirmPublished(file, token)
}

/**
 * Read back what was just published and refuse to return a token that is not on disk
 * **byte-for-byte** — the comparison is over raw bytes, not a trimmed string, so a file
 * that gained so much as a stray newline is caught rather than papered over. A caller that
 * walked away with a token the file does not hold would authenticate against nothing and,
 * worse, would compute §4.2.1 challenge proofs no other process could verify.
 */
function confirmPublished(file, token) {
  const onDisk = readTokenFile(file)
  const expected = Buffer.from(token, 'utf8')
  if (onDisk === null || !onDisk.raw.equals(expected)) {
    const found = onDisk === null ? 'the file is gone' : `${onDisk.raw.length} byte(s) on disk`
    throw new Error(`${file} does not hold the token this process just published (${found}) — delete the file and try again`)
  }
  return { token, dev: onDisk.dev, ino: onDisk.ino, file }
}

/** A fresh in-memory control token — never persisted, rotated by restarting (§7.1.2). */
export const mintControlToken = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url')

/**
 * Constant-time token comparison. Length is compared first because
 * `crypto.timingSafeEqual` throws on unequal lengths; the token length (43 chars for
 * 32 base64url bytes) is a public constant, so leaking it leaks nothing.
 */
export function tokenMatches(expected, presented) {
  if (typeof expected !== 'string' || !expected) return false
  if (typeof presented !== 'string' || !presented) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// ---- the credential as a LIVE invariant (§7.1.2, §7.4) ----------------------------
//
// The finding this answers: a token loaded at startup used to be authenticated for the whole
// life of the process. `viewer.token` becoming world-readable, or being rotated by another
// flowition command, therefore revoked nothing — the running listener kept answering 200 to
// the leaked value out of its own memory, while a replacement instance bound a second port
// and hid it behind a fresh `viewer.json`. §7.1.2 does not describe a startup check; it
// describes the boundary ("a 0600 file another local user cannot read") that the entire
// `/api` read surface sits behind, and a boundary that only holds at t=0 is not one.
//
// So the credential is re-established against disk on **every** `/api` request and by a
// timer, and any divergence is terminal for the instance: it stops authenticating and the
// server closes (index.js). Fail closed, in that order — refusing first and closing second
// means there is no window in which the leaked value is still served.

/**
 * A one-way gate over "the token file still holds the credential I was started with".
 *
 * Deliberately **uncached**: a positive answer with a TTL is a licence to serve a revoked
 * credential for the length of the TTL, which is exactly the defect being fixed. The cost is
 * an open + fstat + read of a 43-byte file per API request, which is the cheapest thing on
 * that path. A negative answer is sticky — once revoked, this instance never authenticates
 * again, whatever the file does next.
 *
 * The reasons are written for a human and carry **no path and no token value**: they reach an
 * HTTP body (§5.2) and the CLI's stderr (§7.1.7).
 *
 * @param {{token: string, dev: number, ino: number, file?: string}} credential from
 *   `loadOrCreateCredential` — `file` pins the path, see `inspectToken`
 * @param {{inspect?: () => object}} [opts] `inspect` is a seam for the tests
 * @returns {{check: () => string|null, revoke: (reason: string) => string, reason: () => string|null}}
 */
export function createCredentialGuard(credential, { inspect = () => inspectToken(credential.file) } = {}) {
  let revoked = null
  const revoke = (reason) => (revoked ??= reason)
  return {
    reason: () => revoked,
    revoke,
    check() {
      if (revoked) return revoked
      const found = inspect()
      switch (found.kind) {
        case 'absent': return revoke('the viewer token file was deleted')
        case 'exposed': return revoke(`the viewer token file's mode changed to ${octal(found.mode)}, which discloses the credential to other local users`)
        case 'invalid': return revoke('the viewer token file no longer holds a valid credential')
        case 'publishing': return revoke('the viewer token file was replaced while the viewer was running')
        case 'error': return revoke(`the viewer token file could not be verified (${found.code})`)
        default: break
      }
      // Identity first, then value. A replacement that happens to carry the same bytes is
      // still a different file — the §7.4 rotation path unlinks and re-links, so an inode
      // change is the signal that something else has taken over this credential's name.
      if (found.dev !== credential.dev || found.ino !== credential.ino) {
        return revoke('the viewer token file was replaced by a different file')
      }
      if (!tokenMatches(credential.token, found.token)) {
        return revoke('the viewer token file now holds a different credential')
      }
      return null
    },
  }
}

/**
 * Where a request may carry the read token (§7.1.2): `Authorization: Bearer` normally,
 * `?token=` **only** on the SSE route, because EventSource cannot set headers.
 */
export function requestToken(req, url, { allowQueryToken = false } = {}) {
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim())
    if (match) return match[1]
  }
  if (allowQueryToken) {
    const q = url.searchParams.get('token')
    if (q) return q
  }
  return null
}

// ---- healthz challenge proof (§4.2.1) --------------------------------------------

// A challenge is 32 random bytes base64url (43 chars). Accept a little slack for other
// encodings but refuse anything long enough to be a DoS or a smuggling vector.
const MAX_CHALLENGE_LEN = 512

export const CHALLENGE_HEADER = 'x-flowition-challenge'

/** A fresh challenge for a probe: 32 random bytes, base64url (§4.2.1 step 3). */
export const mintChallenge = () => crypto.randomBytes(TOKEN_BYTES).toString('base64url')

/**
 * `hmacSHA256(token, challenge)` in hex — the proof a genuine viewer returns. Knowing a
 * challenge and its proof does not reveal the token, and an impersonating listener that
 * never saw the token cannot fabricate one.
 */
export function challengeProof(token, challenge) {
  if (typeof challenge !== 'string' || !challenge || challenge.length > MAX_CHALLENGE_LEN) return null
  return crypto.createHmac('sha256', token).update(challenge).digest('hex')
}

/** Verify a probe response's `proof` against the token the caller read itself. */
export function verifyProof(token, challenge, proof) {
  const expected = challengeProof(token, challenge)
  if (!expected) return false
  return tokenMatches(expected, proof)
}

// ---- capabilities (§7.2) ---------------------------------------------------------

/**
 * Parse the `--control` flag value into a canonical capability list.
 * `undefined`/`false` → `[]` (read-only, the default). `true` (bare `--control`) → all
 * five. A `--control=send,cancel` list → that subset, deduped and canonically ordered.
 *
 * @throws {Error} on an unknown or empty capability list — a typo must not silently
 *   downgrade to read-only, nor silently enable everything.
 */
export function parseCapabilities(flag) {
  if (flag === undefined || flag === null || flag === false) return []
  if (flag === true) return [...CAPABILITIES]
  const raw = Array.isArray(flag) ? flag : String(flag).split(',')
  const wanted = raw.map((s) => String(s).trim()).filter(Boolean)
  if (!wanted.length) throw new Error(`--control needs at least one capability: ${CAPABILITIES.join(',')}`)
  for (const cap of wanted) {
    if (!CAPABILITIES.includes(cap)) throw new Error(`unknown --control capability "${cap}" — choose from ${CAPABILITIES.join(',')}`)
  }
  return CAPABILITIES.filter((cap) => wanted.includes(cap))
}

// ---- redaction (§7.1.2, §7.1.7) --------------------------------------------------

/**
 * Scrub credentials from any string that could reach a log line or an error body: the
 * literal tokens, and the SSE route's `?token=` query value (which the server itself
 * accepts and could therefore echo back inside a URL in an error message).
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text).replace(/([?&](?:token|t|c)=)[^&\s"']+/gi, '$1[redacted]')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]')
  }
  return out
}
