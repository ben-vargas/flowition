// W4 — instance discovery, reuse, auto-start, and the credential-handling rules that
// make them safe (DESIGN §4.2, §4.2.1, §4.3, §4.4, §11.2 "viewer-reuse").
//
// The load-bearing test in this file is the spoofed-healthz fixture (Sol-2): another
// local user can bind the predictable port and mimic the readiness JSON. If discovery
// trusted that, it would print a token-bearing URL at an attacker's listener, which then
// serves JavaScript that reads the token out of `location.hash`. So the probe must
// refuse it AND must never have transmitted the token in the first place.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-reuse-'))
process.env.FLOWITION_HOME = HOME

const viewer = await import('../src/viewer/index.js')
const { loadOrCreateToken, tokenPath, parseCapabilities, challengeProof, sleepSync, CAPABILITIES, isCanonicalToken, writeFully, createCredentialGuard } = await import('../src/viewer/auth.js')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BIN = path.join(ROOT, 'bin', 'flowition.js')

const runCli = (args, env = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout, stderr }))
  })

const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8)

/** A listener that records every request it sees, so we can prove it saw no token. */
function fakeListener(handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: { ...req.headers } })
    handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      server.unref()   // same reason as `live.unref()` below
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

let live
before(async () => {
  live = await viewer.startViewer({ port: 0 })
  // Node 18's node:test finishes the root test from a `process.on('beforeExit')` hook,
  // which never fires while a listening server holds a ref'd handle on the event loop:
  // the file would print every passing test and then hang forever with no teardown and no
  // summary. `unref()` lets the loop drain once the last request settles; the `after` hook
  // below still closes the server.
  live.unref()
})
after(async () => { await live?.close() })

// There is exactly one rendezvous file per home (§13.2), so any auxiliary instance a
// test starts overwrites it and removes it on close. Point it back at `live` before each
// test rather than making every test clean up after itself.
beforeEach(() => { if (live) viewer.writeRendezvous({ port: live.port, control: [] }) })

// ---- the token file (§7.1.2) -------------------------------------------------------

test('the read token is a 0600 file, created once and reused', () => {
  assert.equal(mode(tokenPath()), '600')
  assert.equal(loadOrCreateToken(), live.token)
  assert.equal(loadOrCreateToken(), live.token)
  assert.equal(Buffer.from(live.token, 'base64url').length, 32)
})

// Every caller of loadOrCreateToken must converge on ONE value: the token is both the
// server's bearer credential and the shared secret behind the §4.2.1 challenge proof, so
// two callers walking away with different tokens means a genuine viewer that cannot prove
// itself — discovery reads "not ours" and a starting caller binds a second port.
test('the token is published atomically — never an empty or partial viewer.token', () => {
  // Publication is write-a-temp-file-then-link, so `viewer.token` exists only once it is
  // complete and 0600. That is what makes the read path trivially correct: a non-empty
  // file is always a whole token, and there is no window for a reader to see otherwise.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-publish-'))
  const saved = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  try {
    const token = loadOrCreateToken()
    const file = path.join(fresh, 'viewer.token')
    assert.equal(Buffer.from(token, 'base64url').length, 32)
    assert.equal(fs.readFileSync(file, 'utf8').trim(), token)
    assert.equal(mode(file), '600', 'the published inode is 0600 from birth — link() preserves it')
    // No temp debris is left behind. `runs/` is there because reaching the token file goes
    // through §4.1's home gate, which creates a missing home and runs dir 0700 (below).
    assert.deepEqual(fs.readdirSync(fresh).filter((f) => f !== 'viewer.token' && f !== 'runs'), [], 'the publish temp file is cleaned up')
    assert.equal(mode(path.join(fresh, 'runs')), '700')
    assert.equal(loadOrCreateToken(), token, 'and it is stable from then on')
  } finally {
    process.env.FLOWITION_HOME = saved
  }
})

test('a slow creator is waited for, not unlinked out from under', () => {
  // The dangerous schedule: another writer has created the file with O_EXCL and has NOT
  // yet written its token. Unlinking that zero-byte file makes the writer write through an
  // unlinked descriptor — its token exists nowhere on disk — while the unlinker publishes
  // a different one. Two callers, two tokens: a genuine viewer that cannot prove itself.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-race-'))
  const saved = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  try {
    const file = path.join(fresh, 'viewer.token')
    const fd = fs.openSync(file, 'wx', 0o600)          // the winner, mid-create
    const winner = 'w'.repeat(43)
    let waits = 0
    const token = loadOrCreateToken({
      retryMs: 0,
      onWait: () => { if (++waits === 3) { fs.writeSync(fd, winner); fs.closeSync(fd) } },
    })
    assert.equal(token, winner, 'the loser must return the winner\'s token')
    assert.equal(waits, 3, 'it waited rather than reclaiming')
    assert.equal(fs.readFileSync(file, 'utf8').trim(), winner, 'and only one token exists on disk')
  } finally {
    process.env.FLOWITION_HOME = saved
  }
})

test('an empty token file is never reclaimed on a timer — it fails loud instead', () => {
  // The rejected alternative was "unlink it once it has been empty for N ms", which is a
  // guess about scheduling dressed up as a fact: a process descheduled for longer than N
  // gets its file deleted mid-create and the two callers diverge silently. Since this code
  // can never itself publish an empty file, an empty one is a foreign writer — waited for,
  // and if it never fills in, reported with the path to delete. No silent divergence.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-empty-'))
  const saved = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  try {
    const file = path.join(fresh, 'viewer.token')
    fs.closeSync(fs.openSync(file, 'wx', 0o600))
    assert.throws(() => loadOrCreateToken({ retryMs: 1, deadlineMs: 40 }), /has been empty for 40ms.*delete the file/s)
    assert.equal(fs.readFileSync(file, 'utf8'), '', 'the file was neither reclaimed nor overwritten')
    // Remove the debris and the next call publishes normally.
    fs.unlinkSync(file)
    assert.equal(Buffer.from(loadOrCreateToken(), 'base64url').length, 32)
  } finally {
    process.env.FLOWITION_HOME = saved
  }
})

test('a viewer.token that is not a 32-byte base64url credential is refused, not used', async () => {
  // The finding: any non-empty file was accepted verbatim. A preseeded `viewer.token`
  // containing `x` therefore started a viewer whose entire authentication boundary was
  // `Authorization: Bearer x` — over every transcript the 0700 run dir exists to protect
  // (§7.1.2 "32 random bytes base64url", §7.4). Decodability is not enough either:
  // `Buffer.from(…, 'base64url')` drops stray characters and unused trailing bits, so a
  // family of strings "decodes to 32 bytes" without being a canonical token.
  const bad = [
    ['a single byte', 'x'],
    ['truncated mid-token', crypto.randomBytes(32).toString('base64url').slice(0, 20)],
    ['one character short', crypto.randomBytes(32).toString('base64url').slice(0, 42)],
    ['padded standard base64', crypto.randomBytes(32).toString('base64')],
    ['non-canonical trailing bits', 'z'.repeat(43)],
    ['right length, wrong alphabet', `${'a'.repeat(42)}+`],
    ['16 bytes, not 32', crypto.randomBytes(16).toString('base64url')],
    ['64 bytes, not 32', crypto.randomBytes(64).toString('base64url')],
    ['a JSON blob', '{"token":"nope"}'],
    // The whitespace family. These are the cases a `trim()` before validation swallowed:
    // the bytes on disk are not a §7.1.2 credential, but the trimmed string is, so the file
    // was accepted and served as the token — and the publish confirmation compared the
    // trimmed value rather than the bytes it claimed to verify. Only a genuinely 0-byte file
    // means "publication in progress"; whitespace does not.
    ['a token with a trailing newline', `${crypto.randomBytes(32).toString('base64url')}\n`],
    ['a token with leading whitespace', ` ${crypto.randomBytes(32).toString('base64url')}`],
    ['a token wrapped in whitespace', `\t${crypto.randomBytes(32).toString('base64url')} \n`],
    ['a token with an interior newline', `${crypto.randomBytes(32).toString('base64url')}\n\n`],
    ['whitespace only', '   \n'],
    ['a single newline', '\n'],
  ]
  for (const [what, body] of bad) {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-bad-'))
    const saved = process.env.FLOWITION_HOME
    process.env.FLOWITION_HOME = fresh
    const file = path.join(fresh, 'viewer.token')
    try {
      fs.writeFileSync(file, body, { mode: 0o600 })
      assert.throws(() => loadOrCreateToken({ deadlineMs: 50, retryMs: 1 }), (err) => {
        assert.match(err.message, /is not a valid viewer token/, what)
        assert.match(err.message, /delete the file and try again/, what)
        // Never echo the rejected content: a malformed token is still a secret. (Same
        // ≥8-character floor `redactSecrets` uses — a one-character "token" is a substring
        // of any English sentence, so the check would be vacuous below it.)
        if (body.length >= 8) assert.equal(err.message.includes(body), false, `${what}: the message echoed the token`)
        return true
      }, what)
      // Refused, never repaired: a live viewer may be authenticating against this file, and
      // overwriting it would strand that instance while we publish a different secret.
      assert.equal(fs.readFileSync(file, 'utf8'), body, `${what}: the file was rewritten`)
      // And the server itself fails closed rather than serving on a bogus credential.
      await assert.rejects(() => viewer.startViewer({ port: 0 }), /is not a valid viewer token/, what)
      assert.equal(fs.existsSync(path.join(fresh, 'viewer.json')), false, `${what}: a viewer bound anyway`)
    } finally {
      process.env.FLOWITION_HOME = saved
    }
  }
  // The canonical spelling of the same 32 bytes is, of course, accepted.
  assert.equal(isCanonicalToken(live.token), true)
  assert.equal(isCanonicalToken(Buffer.from(live.token, 'base64url').toString('base64url')), true)
})

test('a short write cannot publish a partial token', () => {
  // `fs.writeSync` may write fewer bytes than it was handed; the publish paths ignored its
  // return value, so a short write left a truncated — i.e. weaker and divergent — secret on
  // disk under a name that means "complete". The write loops instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-short-'))
  const file = path.join(dir, 'partial')
  const token = crypto.randomBytes(32).toString('base64url')
  const buf = Buffer.from(token, 'utf8')

  let calls = 0
  let fd = fs.openSync(file, 'wx', 0o600)
  try {
    // The pathological-but-legal kernel: one byte per call.
    writeFully(fd, buf, { write: (f, b, off) => { calls++; return fs.writeSync(f, b, off, 1) } })
  } finally { fs.closeSync(fd) }
  assert.equal(calls, buf.length, 'every byte needed its own call')
  assert.equal(fs.readFileSync(file, 'utf8'), token, 'and all of them landed')
  assert.equal(isCanonicalToken(fs.readFileSync(file, 'utf8')), true)

  // A descriptor that accepts nothing is a failure to publish, not an infinite loop.
  fd = fs.openSync(path.join(dir, 'stuck'), 'wx', 0o600)
  try {
    assert.throws(() => writeFully(fd, buf, { write: () => 0 }), /short write: 0 of 43 bytes/)
  } finally { fs.closeSync(fd) }

  // The real publish path produces a whole canonical token and hands back exactly what is
  // on disk — never a value the file does not hold.
  const saved = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = dir
  try {
    const published = loadOrCreateToken()
    assert.equal(isCanonicalToken(published), true)
    assert.equal(fs.readFileSync(path.join(dir, 'viewer.token'), 'utf8').trim(), published)
  } finally {
    process.env.FLOWITION_HOME = saved
  }
})

test('three racing processes converge on one token past any plausible grace window', async () => {
  // The forced schedule with no seams, and deliberately longer than any timer-based
  // reclaim would have tolerated: the creator holds an empty O_EXCL descriptor for 750ms.
  // Both competitors — one in-process, one a real subprocess — must return that creator's
  // token, and disk must hold exactly it.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-3proc-'))
  const saved = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const file = path.join(fresh, 'viewer.token')
  // A real §7.1.2 token, because a loaded token is now validated as canonical base64url for
  // 32 bytes — a stand-in like 'z'.repeat(43) decodes to 32 bytes but is not the canonical
  // spelling of any of them, and is refused.
  const winner = crypto.randomBytes(32).toString('base64url')
  const HOLD_MS = 750
  const creator = spawn(process.execPath, ['-e',
    `const fs = require('node:fs');`
    + `const fd = fs.openSync(${JSON.stringify(file)}, 'wx', 0o600);`
    + `setTimeout(() => { fs.writeSync(fd, ${JSON.stringify(winner)}); fs.closeSync(fd) }, ${HOLD_MS});`,
  ], { stdio: 'ignore' })
  // Attached now, not in `finally`: a ChildProcess emits 'exit' exactly once, so a listener
  // added after the process has already gone never fires — and the await never resolves.
  const creatorExited = new Promise((r) => creator.on('exit', r))
  const authUrl = pathToFileURL(path.join(ROOT, 'src', 'viewer', 'auth.js')).href
  let competitor
  let competitorExited = Promise.resolve()
  try {
    // Block (synchronously, like every caller of this function) until the creator's empty
    // file is visible, so the race window is entered deterministically.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try { if (fs.statSync(file).size === 0) break } catch { /* not created yet */ }
      sleepSync(5)
    }
    assert.equal(fs.statSync(file).size, 0, 'the creator holds an empty file open')

    // A second real process calling the same function concurrently.
    competitor = spawn(process.execPath, ['--input-type=module', '-e',
      `const { loadOrCreateToken } = await import(${JSON.stringify(authUrl)});`
      + `process.stdout.write(loadOrCreateToken())`,
    ], { env: { ...process.env, FLOWITION_HOME: fresh }, stdio: ['ignore', 'pipe', 'pipe'] })
    competitorExited = new Promise((r) => competitor.on('exit', r))
    let out = ''
    let err = ''
    competitor.stdout.setEncoding('utf8')
    competitor.stderr.setEncoding('utf8')
    competitor.stdout.on('data', (c) => { out += c })
    competitor.stderr.on('data', (c) => { err += c })

    assert.equal(loadOrCreateToken(), winner, 'the in-process caller returns the creator\'s token')
    assert.equal(await competitorExited, 0, err)
    assert.equal(out.trim(), winner, 'and so does the competing process')
    assert.equal(fs.readFileSync(file, 'utf8').trim(), winner, 'exactly one token was published')
    assert.deepEqual(fs.readdirSync(fresh).filter((f) => f.includes('.tmp')), [], 'no temp files left behind')
  } finally {
    process.env.FLOWITION_HOME = saved
    creator.kill()
    competitor?.kill()
    await Promise.all([creatorExited, competitorExited])
  }
})

test('a control token exists only with --control and is never persisted', async () => {
  assert.equal(live.controlToken, null, 'read-only by default (Sol-1)')
  const rw = await viewer.startViewer({ port: 0, control: true })
  try {
    assert.equal(typeof rw.controlToken, 'string')
    assert.notEqual(rw.controlToken, rw.token)
    // Nothing in the home may contain it — it lives in memory for the process lifetime.
    for (const entry of fs.readdirSync(HOME, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      assert.ok(!fs.readFileSync(path.join(HOME, entry.name), 'utf8').includes(rw.controlToken), `${entry.name} persisted the control token`)
    }
  } finally {
    await rw.close()
  }
})

// ---- rendezvous lifecycle (§4.2) ---------------------------------------------------

test('the rendezvous file records the bound port and capabilities, is 0600, and is removed on close', async () => {
  const instance = await viewer.startViewer({ port: 0, control: 'send,cancel' })
  const record = JSON.parse(fs.readFileSync(viewer.rendezvousPath(), 'utf8'))
  assert.equal(mode(viewer.rendezvousPath()), '600')
  assert.equal(record.pid, process.pid)
  assert.equal(record.port, instance.port)
  assert.ok(record.startedAt > 0)
  assert.deepEqual(record.control, ['send', 'cancel'])
  // It carries no token — it is a pointer, not a credential. Discovery reads the token
  // from viewer.token itself, which is why an impersonator cannot supply one.
  assert.ok(!JSON.stringify(record).includes(instance.token))
  assert.ok(!JSON.stringify(record).includes(instance.controlToken))

  await instance.close()
  assert.equal(fs.existsSync(viewer.rendezvousPath()), false, 'a clean shutdown unlinks it')
})

test('an explicit secondary neither overwrites nor removes the primary rendezvous', async () => {
  // §13.7's escape hatch: `--port N` against a home that already has a proven live viewer
  // starts a second, separate instance. There is exactly one rendezvous per home (§13.2)
  // and it describes the PRIMARY — a secondary that published its own record would hide a
  // still-running primary from every future `discoverViewer`, and unlinking it on its own
  // exit would leave the primary undiscoverable for the rest of its life.
  const before = fs.readFileSync(viewer.rendezvousPath(), 'utf8')
  const secondary = await viewer.startViewer({ port: 0, primary: false })
  try {
    assert.equal(secondary.primary, false)
    assert.notEqual(secondary.port, live.port, 'it really is a second live server')
    assert.equal(fs.readFileSync(viewer.rendezvousPath(), 'utf8'), before, 'the primary record is untouched')
    assert.equal(viewer.readRendezvous().port, live.port)
    // Both are answering, and discovery still resolves to the primary.
    assert.ok(await viewer.challengeProbe(secondary.port, live.token))
    assert.equal((await viewer.discoverViewer()).port, live.port)
  } finally {
    await secondary.close()
  }
  assert.equal(fs.readFileSync(viewer.rendezvousPath(), 'utf8'), before, 'and closing it does not remove the primary record')
  assert.equal((await viewer.discoverViewer()).port, live.port, 'the primary is still discoverable')
})

test('a missing, unparseable, or nonsensical rendezvous file means "no instance"', () => {
  const file = viewer.rendezvousPath()
  const saved = fs.readFileSync(file)
  try {
    for (const body of ['', '{', 'null', '[]', '{"port":0}', '{"port":"4646"}', '{"port":70000}', '{"pid":1}']) {
      fs.writeFileSync(file, body)
      assert.equal(viewer.readRendezvous(), null, JSON.stringify(body))
    }
    fs.unlinkSync(file)
    assert.equal(viewer.readRendezvous(), null)
  } finally {
    fs.writeFileSync(file, saved)
  }
})

// ---- the challenge proof (§4.2.1) --------------------------------------------------

test('healthz answers a challenge with hmacSHA256(token, challenge) and nothing else', async () => {
  const challenge = crypto.randomBytes(32).toString('base64url')
  const body = await new Promise((resolve) => {
    http.get({
      host: '127.0.0.1',
      port: live.port,
      path: '/healthz',
      headers: { host: `127.0.0.1:${live.port}`, 'x-flowition-challenge': challenge },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve(JSON.parse(data)))
    })
  })
  assert.equal(body.app, 'flowition-viewer')
  assert.equal(body.proof, challengeProof(live.token, challenge))
  // The proof commits to the challenge, so a replayed proof is useless for another one.
  assert.notEqual(body.proof, challengeProof(live.token, crypto.randomBytes(32).toString('base64url')))
  assert.ok(!JSON.stringify(body).includes(live.token))
})

test('challengeProbe round-trips against a real viewer and fails on a wrong token', async () => {
  assert.ok(await viewer.challengeProbe(live.port, live.token))
  assert.equal(await viewer.challengeProbe(live.port, 'not-the-token'), null)
  // Nothing listening at all.
  const dead = await viewer.challengeProbe(1, live.token, 200)
  assert.equal(dead, null)
})

test('discoverViewer reuses the instance the rendezvous file points at', async () => {
  const found = await viewer.discoverViewer()
  assert.ok(found)
  assert.equal(found.port, live.port)
  assert.equal(found.token, live.token)
  assert.deepEqual(found.control, [])
  assert.equal(viewer.viewerUrl({ port: found.port, token: found.token }), live.url)
})

// ---- the spoofed-healthz fixture (Sol-2) -------------------------------------------

test('a fake listener returning the app+homeHash shape is refused and never sees the token', async () => {
  // Exactly the previous revision's readiness payload: enough to look like a viewer,
  // with no proof of token knowledge.
  const spoof = await fakeListener((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ app: 'flowition-viewer', version: '0.1.2', homeHash: crypto.randomBytes(8).toString('hex') }))
  })
  const file = viewer.rendezvousPath()
  const saved = fs.readFileSync(file)
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, port: spoof.port, startedAt: Date.now(), control: CAPABILITIES }))

    assert.equal(await viewer.discoverViewer(), null, 'an unauthenticated healthz shape must never be reused')

    // ...and auto-start must not print anything on its evidence either. The spawn is
    // stubbed out, so "the viewer never came up" is the only possible outcome.
    const spawned = []
    const autoStarted = await viewer.autoStartViewer('flo_deadbeef', {
      spawnFn: (cmd, args) => { spawned.push([cmd, args]); return { on() {}, unref() {} } },
      timeoutMs: 250,
      probeTimeoutMs: 100,
      pollIntervalMs: 25,
    })
    assert.equal(autoStarted, null, 'nothing may be returned to print (parity #34)')

    // The probe must never have transmitted the token — an impersonator that could read
    // it has already won, so this is the whole point of the HMAC challenge.
    assert.ok(spoof.seen.length >= 1, 'the spoof was probed')
    for (const request of spoof.seen) {
      const wire = request.url + '\n' + JSON.stringify(request.headers)
      assert.ok(!wire.includes(live.token), `the token was sent to the spoof: ${wire}`)
      assert.ok(typeof request.headers['x-flowition-challenge'] === 'string')
      assert.equal(request.headers.authorization, undefined)
    }
    // The auto-start spawn never enables the write surface (Sol-1) and never uses a bare
    // `node` (critique N6).
    for (const [cmd, args] of spawned) {
      assert.equal(cmd, process.execPath)
      assert.deepEqual(args.slice(1), ['viewer', '--idle-shutdown'])
      assert.ok(!args.join(' ').includes('--control'))
      assert.ok(!args.join(' ').includes(live.token))
    }
  } finally {
    fs.writeFileSync(file, saved)
    await spoof.close()
  }
})

test('a listener that answers with a wrong or absent proof is refused', async () => {
  for (const payload of [
    { app: 'flowition-viewer', proof: 'deadbeef' },
    { app: 'flowition-viewer', proof: challengeProof('some-other-token', 'x') },
    { app: 'flowition-viewer', proof: 123 },
    { app: 'something-else', proof: 'x' },
    {},
  ]) {
    const spoof = await fakeListener((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
    try {
      assert.equal(await viewer.challengeProbe(spoof.port, live.token, 500), null, JSON.stringify(payload))
    } finally {
      await spoof.close()
    }
  }
  // Non-JSON, a non-200, and an oversize body are all "not ours".
  for (const respond of [
    (res) => { res.writeHead(200); res.end('<html>hi</html>') },
    (res) => { res.writeHead(500); res.end('{}') },
    (res) => { res.writeHead(200); res.end('x'.repeat(200_000)) },
  ]) {
    const spoof = await fakeListener((req, res) => respond(res))
    try {
      assert.equal(await viewer.challengeProbe(spoof.port, live.token, 500), null)
    } finally {
      await spoof.close()
    }
  }
})

test('the probe budget is wall-clock: a trickling listener cannot stall discovery', async () => {
  // §4.2.1's 500 ms is an absolute budget. A socket-inactivity timeout is not one: a
  // hostile or stale listener that dribbles one byte every 40 ms resets it forever, and
  // because discovery runs inside the startup lock's critical section (and inside
  // `--print-url` and auto-start), that is a local denial of service — no viewer for this
  // home can ever start again. §7.4 "Impersonate the viewer on the predictable port".
  const timers = new Set()
  const trickle = await fakeListener((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    // A prefix of a *valid* answer, so nothing about the payload is what refuses it.
    res.write('{"app":"flowition-viewer",')
    const pump = setInterval(() => { try { res.write(' ') } catch { clearInterval(pump) } }, 40)
    timers.add(pump)
    res.on('close', () => { clearInterval(pump); timers.delete(pump) })
  })
  try {
    const budgetMs = 200
    const startedAt = process.hrtime.bigint()
    // A watchdog, not a bare await: without an absolute deadline this probe never settles
    // at all, and a regression must fail the suite rather than wedge it. The slack is
    // generous for a loaded CI box but far below the unbounded runtime an inactivity-only
    // timer gives the same fixture.
    const probed = await Promise.race([
      viewer.challengeProbe(trickle.port, live.token, budgetMs),
      new Promise((resolve) => setTimeout(() => resolve('NEVER_SETTLED'), budgetMs * 5)),
    ])
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    assert.notEqual(probed, 'NEVER_SETTLED', `the probe must abandon on its own clock, still running after ${elapsedMs.toFixed(0)}ms`)
    assert.equal(probed, null, 'a listener that never completes its answer is not ours')
    assert.ok(elapsedMs < budgetMs * 3, `the probe must abandon on its own clock, took ${elapsedMs.toFixed(0)}ms`)
  } finally {
    for (const t of timers) clearInterval(t)
    await trickle.close()
  }
})

test('an accepted-but-silent listener is abandoned on the same clock', async () => {
  // The other half of the same hazard: a socket that accepts and then says nothing at all
  // (no headers, no bytes) — a stale rendezvous port picked up by an unrelated process.
  // The accepted socket is never read from, so it never even observes the probe's FIN —
  // exactly the shape of the hazard, and the reason teardown destroys it explicitly.
  const accepted = new Set()
  const silent = net.createServer((socket) => { accepted.add(socket); socket.on('close', () => accepted.delete(socket)) })
  silent.unref()
  await new Promise((r) => silent.listen(0, '127.0.0.1', r))
  const { port } = silent.address()
  try {
    const startedAt = process.hrtime.bigint()
    assert.equal(await viewer.challengeProbe(port, live.token, 200), null)
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    assert.ok(elapsedMs < 600, `took ${elapsedMs.toFixed(0)}ms`)
  } finally {
    for (const socket of accepted) socket.destroy()
    await new Promise((r) => silent.close(r))
  }
})

// ---- auto-start gating (§4.3) ------------------------------------------------------

test('auto-start happens only for foreground, human-attended runs', () => {
  const base = { flags: {}, env: {}, isTTY: true }
  assert.equal(viewer.shouldAutoStart(base), true)
  for (const flags of [{ detach: true }, { json: true }, { quiet: true }, { 'no-viewer': true }]) {
    assert.equal(viewer.shouldAutoStart({ ...base, flags }), false, JSON.stringify(flags))
  }
  assert.equal(viewer.shouldAutoStart({ ...base, isTTY: false }), false, 'no TTY = not human-attended (MCP, cron, CI)')
  assert.equal(viewer.shouldAutoStart({ ...base, env: { FLOWITION_NO_VIEWER: '1' } }), false)
  assert.equal(viewer.shouldAutoStart({ ...base, env: { FLOWITION_NO_VIEWER: '0' } }), true)
  assert.equal(viewer.shouldAutoStart(), false, 'defaults are conservative')
})

test('auto-start reuses a live instance and returns a run deep link', async () => {
  const spawned = []
  const found = await viewer.autoStartViewer('flo_abc123', {
    spawnFn: (cmd, args) => { spawned.push([cmd, args]); return { on() {}, unref() {} } },
  })
  assert.ok(found)
  assert.equal(found.reused, true)
  assert.equal(found.port, live.port)
  assert.equal(found.url, `http://127.0.0.1:${live.port}/#/run/flo_abc123?t=${live.token}`)
  assert.deepEqual(spawned, [], 'a verified instance must not be duplicated')
})

test('auto-start with no instance at all returns null rather than a dead URL', async () => {
  const file = viewer.rendezvousPath()
  const saved = fs.readFileSync(file)
  try {
    fs.unlinkSync(file)
    const found = await viewer.autoStartViewer('flo_abc123', {
      spawnFn: () => ({ on() {}, unref() {} }),
      timeoutMs: 200,
      probeTimeoutMs: 80,
      pollIntervalMs: 20,
    })
    assert.equal(found, null)
  } finally {
    fs.writeFileSync(file, saved)
  }
})

test('a short TTY-attended run still spawns a viewer and prints a verified deep link', async () => {
  // §4.3 end to end, on the case that fire-and-forget loses: the workflow finishes in
  // well under the time the spawned viewer needs to bind and answer a challenge, and
  // bin/flowition.js calls process.exit the instant main() resolves. Unless the auto-start
  // promise is awaited, this run exits having created no viewer.token, no viewer.json and
  // printed no link — which is what "auto-start on `flowition run`" is.
  // A short prefix on purpose: the run's control.sock path lives under this home and a
  // unix socket path is capped at ~104 bytes on darwin.
  const runHome = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-as-'))
  // `--port 0` semantics for the spawned child, so the test never squats the real 4646.
  const childEnv = { ...process.env, FLOWITION_HOME: runHome, FLOWITION_VIEWER_PORT: '0' }
  // stderr.isTTY cannot be forged from outside without a pty, so the harness sets it on
  // itself and then hands over to the real bin — including its process.exit path.
  const harness = path.join(runHome, 'tty-run.mjs')
  fs.writeFileSync(harness,
    `process.stderr.isTTY = true\n`
    + `process.argv = [process.argv[0], ${JSON.stringify(BIN)}, 'run', ${JSON.stringify(path.join(ROOT, 'test', 'fixtures', 'basic.workflow.js'))}, '--adapter', 'mock']\n`
    + `await import(${JSON.stringify(pathToFileURL(BIN).href)})\n`)

  let viewerPid = null
  try {
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [harness], { env: childEnv, timeout: 60_000 }, (err, stdout, stderr) =>
        resolve({ code: err?.code ?? 0, stdout, stderr }))
    })
    assert.equal(result.code, 0, result.stderr)

    const record = JSON.parse(fs.readFileSync(path.join(runHome, 'viewer.json'), 'utf8'))
    viewerPid = record.pid
    const token = fs.readFileSync(path.join(runHome, 'viewer.token'), 'utf8').trim()
    assert.equal(mode(path.join(runHome, 'viewer.token')), '600', 'a token created into a fresh home is 0600')

    // The deep link is the run's own id (E16: allocated by the CLI before the run starts),
    // on the port the child actually bound, with the token this home holds.
    const runId = /^run (\S+)$/m.exec(result.stderr)?.[1]
    assert.ok(runId, `no run id line in stderr:\n${result.stderr}`)
    assert.match(result.stderr, /^view: \S+$/m)
    const printed = /^view: (\S+)$/m.exec(result.stderr)[1]
    assert.equal(printed, `http://127.0.0.1:${record.port}/#/run/${runId}?t=${token}`)
    // parity #34 / Sol-2: the link was printed only because a challenge proof succeeded.
    // Re-prove it against the process that is still listening.
    const savedHome = process.env.FLOWITION_HOME
    process.env.FLOWITION_HOME = runHome
    try {
      assert.ok(await viewer.challengeProbe(record.port, token, 2000), 'the printed URL points at a real, proven viewer')
    } finally {
      process.env.FLOWITION_HOME = savedHome
    }
    // Auto-start never enables the write surface (Sol-1).
    assert.deepEqual(record.control, [])
    assert.ok(!printed.includes('&c='))
  } finally {
    if (viewerPid) { try { process.kill(viewerPid, 'SIGTERM') } catch { /* already gone */ } }
  }
})

// ---- --open (§4.2, §7.4 "token never in argv") -------------------------------------

test('--open passes a 0600 bootstrap file path, never the tokenized URL, in argv', async () => {
  const url = viewer.viewerUrl({ port: live.port, token: live.token, controlToken: 'ctl-token-value' })
  const calls = []
  const file = viewer.openInBrowser(url, {
    spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} } },
    unlinkAfterMs: 60,
  })

  assert.equal(mode(file), '600')
  assert.equal(path.dirname(file), HOME, 'the bootstrap lives in the 0700 home')
  assert.match(path.basename(file), /^open-[0-9a-f]{16}\.html$/)

  const html = fs.readFileSync(file, 'utf8')
  assert.match(html, /<meta http-equiv="refresh" content="0;url=/)
  assert.match(html, /location\.replace\(/)
  assert.ok(html.includes(live.token), 'the hop must carry the token — that is its purpose')

  // Two spawns: the opener, then the detached deleter that outlives this process.
  assert.equal(calls.length, 2)
  assert.equal(calls[0].cmd, process.platform === 'darwin' ? 'open' : 'xdg-open')
  assert.deepEqual(calls[0].args, [file])
  assert.equal(calls[1].cmd, process.execPath, 'cleanup is delegated by absolute path, never through PATH')
  assert.equal(calls[1].opts.detached, true, 'and to a new process group, so Ctrl-C does not kill it')
  assert.ok(calls[1].args.includes(file), 'the deleter is armed for exactly this file')
  // Nothing the deleter runs may be resolved through PATH — not the binary, and not a
  // helper command inside it (the `sleep`/`rm` regression).
  assert.equal(calls[1].args[0], '-e', 'the deleter runs a fixed program, not an external command')
  assert.ok(!('NODE_OPTIONS' in calls[1].opts.env), 'an inherited NODE_OPTIONS cannot break the deleter')
  // `ps` during --open must reveal nothing: no token, no URL, in any argument of either
  // process.
  for (const arg of calls.flatMap((c) => [c.cmd, ...c.args])) {
    assert.ok(!arg.includes(live.token), 'the token reached argv')
    assert.ok(!arg.includes('ctl-token-value'), 'the control token reached argv')
    assert.ok(!arg.includes('#/'), 'the URL reached argv')
  }
  fs.unlinkSync(file)   // nothing real was spawned here; clean up by hand
})

test('the detached deleter actually removes the bootstrap file', async () => {
  // The mechanism, spawned for real: the deleter waits out the grace period and unlinks.
  // The grace exists because the browser reads the file after the opener returns — the file
  // must still be there a moment later, and gone a moment after that.
  const url = viewer.viewerUrl({ port: live.port, token: live.token })
  const file = viewer.openInBrowser(url, {
    spawnFn: (cmd, args, opts) => (cmd === process.execPath ? spawn(cmd, args, opts) : { on() {}, unref() {} }),
    unlinkAfterMs: 1000,
  })
  assert.ok(fs.existsSync(file), 'the file survives long enough for a browser to read it')
  const deadline = Date.now() + 8000
  while (fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert.equal(fs.existsSync(file), false, 'and is then removed by the detached deleter')
})

test('the detached deleter removes the bootstrap file with NO usable PATH', async () => {
  // The regression: the deleter was `/bin/sh -c 'sleep …; rm …'`, and the shell resolves
  // `sleep` and `rm` through the inherited PATH. Under a PATH that has neither — a stripped
  // service environment, or this — the shell exited having deleted nothing, and a 0600 file
  // carrying the read and control tokens stayed in the home indefinitely. Spawned for real,
  // with a PATH that resolves nothing at all.
  const url = viewer.viewerUrl({ port: live.port, token: live.token, controlToken: 'ctl-token-value' })
  const file = viewer.openInBrowser(url, {
    spawnFn: (cmd, args, opts) => (cmd === process.execPath
      ? spawn(cmd, args, { ...opts, env: { ...opts.env, PATH: '/definitely-missing' } })
      : { on() {}, unref() {} }),
    unlinkAfterMs: 1000,
  })
  assert.ok(fs.existsSync(file), 'the file survives the grace period')
  const deadline = Date.now() + 15_000
  while (fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert.equal(fs.existsSync(file), false, 'a credential-bearing bootstrap file survived an empty PATH')
})

test('--open only warns when the opener is missing', () => {
  const warnings = []
  const file = viewer.openInBrowser('http://127.0.0.1:1/#/', {
    spawnFn: (cmd) => { throw new Error(`spawn ${cmd} ENOENT`) },
    warn: (m) => warnings.push(m),
    unlinkAfterMs: 10,
  })
  assert.match(warnings[0], /could not open a browser/)
  assert.ok(warnings[0].includes(file), 'the user is told where the bootstrap file is')
  // A cleanup that cannot be delegated fails CLOSED: the credential-bearing file is
  // removed at once rather than left with nobody to delete it.
  assert.match(warnings[1], /could not schedule cleanup/)
  assert.equal(fs.existsSync(file), false)
})

// ---- ports (§4.2, parity #28/#31) --------------------------------------------------

test('a taken fixed port walks forward; --port 0 skips the walk', async () => {
  const squatter = http.createServer(() => {})
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r))
  const taken = squatter.address().port
  let walked
  try {
    walked = await viewer.startViewer({ port: taken })
    assert.ok(walked.port > taken && walked.port < taken + viewer.PORT_WALK, `walked to ${walked.port} from ${taken}`)
    // The rendezvous always records the port actually bound, never the requested one.
    assert.equal(viewer.readRendezvous().port, walked.port)
  } finally {
    await walked?.close()
    await new Promise((r) => squatter.close(r))
    viewer.writeRendezvous({ port: live.port, control: [] })
  }

  const ephemeral = await viewer.startViewer({ port: 0 })
  try {
    assert.ok(ephemeral.port > 0 && ephemeral.port !== live.port)
  } finally {
    await ephemeral.close()
    viewer.writeRendezvous({ port: live.port, control: [] })
  }
})

// ---- idle shutdown (§4.4, parity #30) ----------------------------------------------

test('idle shutdown closes the server and clears the rendezvous; SSE clients hold it open', async () => {
  const shutdowns = []
  const idle = await viewer.startViewer({ port: 0, idleShutdown: true, idleTimeoutMs: 60, idleCheckMs: 20, onShutdown: (r) => shutdowns.push(r) })
  const deadline = Date.now() + 4000
  while (!shutdowns.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(shutdowns, ['idle'])
  assert.equal(fs.existsSync(viewer.rendezvousPath()), false)
  await idle.close()
  viewer.writeRendezvous({ port: live.port, control: [] })

  // A connected SSE client is activity, so the same timings must NOT shut down.
  const held = await viewer.startViewer({ port: 0, idleShutdown: true, idleTimeoutMs: 60, idleCheckMs: 20, onShutdown: () => shutdowns.push('held') })
  held.activity.sseClients = 1
  try {
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(shutdowns, ['idle'], 'a connected stream client keeps the viewer alive')
  } finally {
    await held.close()
    viewer.writeRendezvous({ port: live.port, control: [] })
  }
})

test('a "running" run counts as activity only while its events.jsonl keeps advancing', () => {
  // critique N11 — a SIGSTOPped engine or a reused-pid lock holder must not pin the
  // viewer alive forever on the strength of its derived state alone.
  const runId = 'flo_idle_probe'
  const dir = path.join(HOME, 'runs', runId)
  fs.mkdirSync(dir, { recursive: true })
  const events = path.join(dir, 'events.jsonl')
  fs.writeFileSync(events, '{"type":"run-start"}\n')

  const activity = viewer.createActivity()
  assert.equal(viewer.isActive(activity, 1000), false, 'nothing known = idle')

  activity.noteRunState(runId, 'running')
  const t0 = 1_000_000
  assert.equal(viewer.isActive(activity, 1000, t0), true, 'first observation gets a window of grace')
  assert.equal(viewer.isActive(activity, 1000, t0 + 500), true, 'still inside the window')
  assert.equal(viewer.isActive(activity, 1000, t0 + 2000), false, 'a static event log is not activity')

  fs.appendFileSync(events, '{"type":"log"}\n')
  assert.equal(viewer.isActive(activity, 1000, t0 + 3000), true, 'a growing event log is activity again')

  // A terminal verdict drops the run; a vanished dir prunes itself.
  activity.noteRunState(runId, 'completed')
  assert.equal(activity.liveRuns.size, 0)
  activity.noteRunState('flo_gone', 'running')
  assert.equal(viewer.isActive(activity, 1000, t0 + 4000), false)
  assert.equal(activity.liveRuns.size, 0)
})

// ---- capabilities (§7.2) -----------------------------------------------------------

test('--control parses bare, list, and invalid forms', () => {
  assert.deepEqual(parseCapabilities(undefined), [])
  assert.deepEqual(parseCapabilities(false), [])
  assert.deepEqual(parseCapabilities(true), CAPABILITIES)
  assert.deepEqual(parseCapabilities('send,answer'), ['send', 'answer'])
  assert.deepEqual(parseCapabilities('delete, send'), ['send', 'delete'], 'canonical order, whitespace tolerated')
  assert.deepEqual(parseCapabilities('send,send'), ['send'])
  // A typo must not silently downgrade to read-only nor silently enable everything.
  assert.throws(() => parseCapabilities('sned'), /unknown --control capability/)
  assert.throws(() => parseCapabilities(''), /at least one capability/)
  assert.throws(() => parseCapabilities(','), /at least one capability/)
})

// ---- the CLI surface (§4.2) --------------------------------------------------------

test('flowition viewer --print-url exits 1 without printing anything when nothing is live', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-print-url-'))
  const result = await runCli(['viewer', '--print-url'], { FLOWITION_HOME: home })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /no live flowition viewer/)
  // If a token file was created by the probe, its value must not have been printed.
  const file = path.join(home, 'viewer.token')
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, 'utf8').trim()
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token))
  }
})

test('flowition viewer --print-url reprints a verified instance; a second viewer reuses it', async () => {
  const printed = await runCli(['viewer', '--print-url', '--json'])
  assert.equal(printed.code, 0, printed.stderr)
  const payload = JSON.parse(printed.stdout)
  assert.equal(payload.port, live.port)
  assert.equal(payload.url, live.url)
  assert.deepEqual(payload.control, [])

  // A plain `flowition viewer` finds the live one and exits instead of binding 4647.
  const reused = await runCli(['viewer', '--json'])
  assert.equal(reused.code, 0, reused.stderr)
  const second = JSON.parse(reused.stdout)
  assert.equal(second.port, live.port)
  assert.equal(second.reused, true)
})

test('flowition viewer --control refuses to reuse or shadow a live instance', async () => {
  // The control token is 32 bytes minted in the live process's memory and never persisted
  // (§7.1.2). So the capability list in viewer.json is a record of what that process CAN
  // do, never possession of the credential that authorizes it. Reusing on its strength
  // would print a URL with no `c=` that silently cannot mutate; starting an implicit
  // second server would overwrite the rendezvous file and break one-viewer-per-home
  // (§13.2/§13.7). Both are refused, with the restart the user actually needs.
  const before = fs.readFileSync(viewer.rendezvousPath(), 'utf8')
  for (const flag of ['--control', '--control=send,cancel']) {
    const result = await runCli(['viewer', flag])
    assert.equal(result.code, 1, result.stderr)
    assert.equal(result.stdout, '', 'nothing token-bearing is printed')
    assert.match(result.stderr, /^flowition: a flowition viewer is already serving this home on port \d+/)
    assert.match(result.stderr, /control token exists only in that process's memory/)
    assert.match(result.stderr, /stop it and start again with control/)
    assert.match(result.stderr, /--port <N>/, 'the deliberate second-instance escape hatch is named')
    assert.ok(!result.stderr.includes(live.token), 'the read token is not printed either')
    assert.doesNotMatch(result.stderr, /\n\s+at /, 'preconditions print clean, never a stack')
  }
  // The live instance is untouched: same rendezvous record, same port, still answering.
  assert.equal(fs.readFileSync(viewer.rendezvousPath(), 'utf8'), before)
  assert.ok(await viewer.challengeProbe(live.port, live.token))

  // A read-only reuse is still exactly that — a reuse, not a second server.
  const reused = await runCli(['viewer', '--json'])
  assert.equal(JSON.parse(reused.stdout).port, live.port)
  assert.equal(fs.readFileSync(viewer.rendezvousPath(), 'utf8'), before)
})

// ---- concurrent startup (§13.7 "prevented per home by the port-reuse protocol") -----

/** A port that is free right now — so the test never squats the real 4646. */
const freePort = () => new Promise((resolve) => {
  const probe = http.createServer(() => {})
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

/** Spawn `flowition viewer --json` and resolve its first stdout line, parsed. */
function spawnViewerCli(args, env) {
  const child = spawn(process.execPath, [BIN, 'viewer', '--json', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((r) => child.on('exit', r))
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const announced = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      out += chunk
      const line = out.split('\n').find((l) => l.trim().startsWith('{'))
      if (line) { try { resolve(JSON.parse(line)) } catch { /* still arriving */ } }
    })
    child.stderr.on('data', (chunk) => { err += chunk })
    exited.then((code) => reject(new Error(`viewer exited ${code} before announcing\nstdout: ${out}\nstderr: ${err}`)))
  })
  return { child, exited, announced, stderr: () => err }
}

test('two concurrent in-process startOrReuseViewer calls converge on ONE instance', async () => {
  // The sibling of the subprocess race below, and the one an `O_EXCL` file lock cannot
  // close on its own: both callers are the same pid, so pid-keyed ownership makes the
  // second call look like a *nested* one and wave it straight past serialization. That
  // produced two primaries on adjacent ports, the second's rendezvous record hiding the
  // first. The per-home in-process queue is what makes this converge.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-race-lib-'))
  const home = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const started = []
  try {
    const results = await Promise.all([
      viewer.startOrReuseViewer({ port: 0 }),
      viewer.startOrReuseViewer({ port: 0 }),
    ])
    for (const r of results) if (!r.reused) { r.unref(); started.push(r) }

    assert.equal(started.length, 1, `exactly one caller may bind: ${JSON.stringify(results.map((r) => ({ port: r.port, reused: r.reused })))}`)
    assert.equal(results.filter((r) => r.reused).length, 1, 'the other must reuse it')
    assert.equal(results[0].port, results[1].port, 'both report the same port')
    assert.equal(results[0].url, results[1].url, 'and the same tokenized URL')
    // One rendezvous per home, naming the one that bound.
    assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'viewer.json'), 'utf8')).port, started[0].port)
    assert.equal(fs.existsSync(path.join(fresh, 'viewer.lock')), false, 'the startup lock is released, not leaked')
  } finally {
    for (const s of started) await s.close()
    process.env.FLOWITION_HOME = home
  }
})

test('a truly nested withHomeLock call does not deadlock on its own queue entry', async () => {
  // Serialization must distinguish "concurrent sibling" (queue it) from "nested inside the
  // section that already owns the lock" (let it through) — the latter would otherwise wait
  // forever for a queue slot its own caller is holding.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-nest-'))
  const home = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  try {
    const order = []
    const value = await viewer.withHomeLock(async () => {
      order.push('outer')
      assert.ok(fs.existsSync(path.join(fresh, 'viewer.lock')), 'the outer call owns the lock file')
      const inner = await viewer.withHomeLock(async () => { order.push('inner'); return 'ok' }, { timeoutMs: 250, retryMs: 10 })
      assert.ok(fs.existsSync(path.join(fresh, 'viewer.lock')), 'and still owns it after the nested call returns')
      return inner
    }, { timeoutMs: 250, retryMs: 10 })
    assert.equal(value, 'ok')
    assert.deepEqual(order, ['outer', 'inner'])
    assert.equal(fs.existsSync(path.join(fresh, 'viewer.lock')), false, 'released exactly once, by the outermost call')
  } finally {
    process.env.FLOWITION_HOME = home
  }
})

test('a lock is never taken from a live owner — the contender waits, or fails loudly', async () => {
  // The finding this test exists for: on timeout the previous revision unlinked the lock
  // file and entered the critical section anyway. Unlinking a name does not stop the
  // process holding it, so discover → bind → publish then ran in both processes at once —
  // the exact outcome the lock exists to prevent, now with no lock at all.
  //
  // The old test could not see that: it fabricated a lock file naming an unrelated sleeping
  // pid, so "the holder" was never inside `withHomeLock` and there was nothing to overlap
  // with. This one uses a real child process actually executing the critical section.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lock-'))
  const home = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const lock = path.join(fresh, 'viewer.lock')
  const release = path.join(fresh, 'release-the-holder')
  const holderSrc = `
    import fs from 'node:fs'
    const { withHomeLock } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'viewer', 'index.js')).href)})
    await withHomeLock(async () => {
      process.stdout.write('inside\\n')
      while (!fs.existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 20))
      process.stdout.write('leaving\\n')
    })
    process.stdout.write('released\\n')
  `
  try {
    const holder = spawn(process.execPath, ['--input-type=module', '-e', holderSrc], {
      env: { ...process.env, FLOWITION_HOME: fresh },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    holder.stdout.setEncoding('utf8')
    holder.stdout.on('data', (c) => { out += c })
    const exited = new Promise((r) => holder.on('exit', r))
    const until = async (pred, why) => {
      const deadline = Date.now() + 10_000
      while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      assert.ok(pred(), why)
    }
    try {
      await until(() => out.includes('inside'), 'the holder never entered its critical section')
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, holder.pid, 'the lock names the holder')

      // A contender must NOT enter while the holder is still in there. It waits, and when
      // its budget runs out it says so — it does not break the lock and proceed.
      let entered = false
      await assert.rejects(
        () => viewer.withHomeLock(async () => { entered = true }, { timeoutMs: 200, retryMs: 10 }),
        (err) => {
          assert.match(err.message, new RegExp(`another process \\(pid ${holder.pid}\\) is starting a viewer`))
          assert.match(err.message, /remove that file if no viewer is starting/)
          return true
        },
      )
      assert.equal(entered, false, 'the contender ran the critical section concurrently with a live holder')
      assert.equal(out.includes('leaving'), false, 'and it did so while the holder was still inside')
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, holder.pid, 'the live holder still owns its lock')

      // Once the holder leaves, the very same call succeeds.
      fs.writeFileSync(release, '')
      await until(() => out.includes('released'), 'the holder never released')
      assert.equal(await exited, 0)
      const ran = await viewer.withHomeLock(async () => {
        assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid, 'ownership is real')
        return 'entered'
      }, { timeoutMs: 2000, retryMs: 10 })
      assert.equal(ran, 'entered')
      assert.equal(fs.existsSync(lock), false, 'and the lock is released afterwards')
    } finally {
      holder.kill('SIGKILL')
      await exited
    }

    // A demonstrably dead owner is the one thing that IS reclaimed — immediately, with no
    // waiting at all, because that is the common case (a crashed starter).
    fs.writeFileSync(lock, JSON.stringify({ pid: 0x7fffffff, startedAt: Date.now() }), { mode: 0o600 })
    let sleeps = 0
    await viewer.withHomeLock(async () => {}, { timeoutMs: 10_000, retryMs: 5, sleep: async () => { sleeps++ } })
    assert.equal(sleeps, 0, 'a demonstrably dead owner is reclaimed immediately')
    assert.equal(fs.existsSync(lock), false)
  } finally {
    process.env.FLOWITION_HOME = home
  }
})

test('a lock with no readable owner is never stolen, however old it is', async () => {
  // The finding: the lock *name* was created first (`open(…, 'wx')`) and the owner's pid
  // written into it second, and an unparseable lock was aged out after 30 s. A creator
  // descheduled between those two steps published exactly the shapes below — and could have
  // its lock stolen while it was still on its way into the critical section, so two
  // processes ran discover → bind → publish at once. Publication is now one atomic
  // `link(2)` of a fully-written file, so a starting viewer cannot produce these shapes at
  // all; a file that has them was not written by one, and is refused rather than reclaimed.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lock-nosteal-'))
  const home = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const lock = path.join(fresh, 'viewer.lock')
  try {
    const shapes = [
      ['empty — the paused-creator shape', ''],
      ['torn json', '{"pid":'],
      ['not an object', '"nope"'],
      ['an object with no pid', '{"startedAt":1}'],
      ['a non-integer pid', '{"pid":"me"}'],
    ]
    for (const [what, body] of shapes) {
      fs.writeFileSync(lock, body, { mode: 0o600 })
      const ancient = new Date(Date.now() - 60 * 60_000)   // an hour old: far past any time bound
      fs.utimesSync(lock, ancient, ancient)
      let entered = false
      await assert.rejects(
        () => viewer.withHomeLock(async () => { entered = true }, { timeoutMs: 120, retryMs: 10 }),
        (err) => {
          assert.match(err.message, /names no owner this process can read/, what)
          assert.match(err.message, /remove that file if no viewer is starting/, what)
          return true
        },
        what,
      )
      assert.equal(entered, false, `${what}: the critical section was entered anyway`)
      assert.equal(fs.readFileSync(lock, 'utf8'), body, `${what}: the lock was stolen from an owner we cannot identify`)
    }
  } finally {
    process.env.FLOWITION_HOME = home
  }
})

test('a stale "the owner is dead" reading can never remove the successor lock', async () => {
  // THE finding, made deterministic. Reclamation used to be: read the lock, see a dead pid,
  // `unlink` the name. Both halves are fine; the gap between them is not. Two contenders read
  // the same dead pid, the first reclaims and publishes its own lock, and then the second —
  // still acting on its stale reading — unlinks *that*, links its own, and walks into the
  // critical section alongside a live holder. Two processes then run discover → bind →
  // publish at once: two primaries, and the second's viewer.json hiding the first.
  //
  // A process herd only lands in that window by luck (it is a few microseconds wide), so this
  // test does not gamble: the contender blocks *inside* the window on the `onDeadLock` seam
  // while this process reclaims the same lock and enters the section. Then it is released.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lock-stale-'))
  const home = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const lock = path.join(fresh, 'viewer.lock')
  const read = path.join(fresh, 'contender-has-read-the-dead-lock')
  const go = path.join(fresh, 'let-the-contender-act-on-it')
  const authUrl = pathToFileURL(path.join(ROOT, 'src', 'viewer', 'auth.js')).href
  const indexUrl = pathToFileURL(path.join(ROOT, 'src', 'viewer', 'index.js')).href
  const contenderSrc = `
    import fs from 'node:fs'
    const { withHomeLock } = await import(${JSON.stringify(indexUrl)})
    const { sleepSync } = await import(${JSON.stringify(authUrl)})
    let entered = false
    try {
      await withHomeLock(async () => { entered = true }, {
        timeoutMs: 400,
        retryMs: 10,
        // Frozen in the window: the dead-owner reading has been taken, nothing has been
        // acted on yet. Synchronous on purpose — this is the exact instant the old code
        // carried a decision across.
        onDeadLock: () => {
          if (fs.existsSync(${JSON.stringify(read)})) return   // only the first pass
          fs.writeFileSync(${JSON.stringify(read)}, '')
          while (!fs.existsSync(${JSON.stringify(go)})) sleepSync(5)
        },
      })
      process.stdout.write(entered ? 'ENTERED' : 'RETURNED-WITHOUT-ENTERING')
    } catch (err) {
      process.stdout.write(entered ? 'ENTERED' : 'REFUSED: ' + err.message)
    }
  `
  let contender
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: 0x7fffffff, nonce: crypto.randomBytes(12).toString('hex'), startedAt: Date.now() }), { mode: 0o600 })
    contender = spawn(process.execPath, ['--input-type=module', '-e', contenderSrc], {
      env: { ...process.env, FLOWITION_HOME: fresh },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    contender.stdout.setEncoding('utf8')
    contender.stderr.setEncoding('utf8')
    contender.stdout.on('data', (c) => { out += c })
    contender.stderr.on('data', (c) => { err += c })
    const exited = new Promise((r) => contender.on('exit', r))

    const deadline = Date.now() + 20_000
    while (!fs.existsSync(read) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    assert.ok(fs.existsSync(read), `the contender never reached the window: ${out} ${err}`)

    // Now reclaim the same lock ourselves and hold the section while the contender acts on
    // its stale reading.
    const seen = []
    await viewer.withHomeLock(async () => {
      const mine = JSON.parse(fs.readFileSync(lock, 'utf8'))
      assert.equal(mine.pid, process.pid, 'this process reclaimed the dead lock and published its own')
      fs.writeFileSync(go, '')
      // Outlast the contender's whole budget, sampling the lock the entire time. Any sample
      // that is missing or names someone else is the bug: our lock was taken from under us.
      const until = Date.now() + 700
      while (Date.now() < until) {
        let raw = null
        try { raw = fs.readFileSync(lock, 'utf8') } catch { /* recorded below */ }
        seen.push(raw)
        await new Promise((r) => setTimeout(r, 10))
      }
    }, { timeoutMs: 5000, retryMs: 10 })

    const stolen = seen.filter((raw) => {
      let parsed = null
      try { parsed = JSON.parse(raw) } catch { /* torn or missing */ }
      return parsed?.pid !== process.pid
    })
    assert.equal(stolen.length, 0, `the lock was removed or replaced while this process held it: ${JSON.stringify(stolen.slice(0, 3))}`)
    assert.ok(seen.length > 10, 'the hold was too short to prove anything')

    assert.equal(await exited, 0, err)
    assert.match(out, /^REFUSED: /, 'the contender must refuse, not enter alongside a live holder')
    assert.match(out, new RegExp(`another process \\(pid ${process.pid}\\) is starting a viewer`))
    assert.equal(out.includes('ENTERED'), false, 'two processes were inside the critical section at once')
    assert.equal(fs.existsSync(lock), false, 'the lock is released afterwards')
    assert.deepEqual(fs.readdirSync(fresh).filter((f) => f.includes('.dead.')), [], 'a reclamation claim was left behind')
  } finally {
    contender?.kill('SIGKILL')
    process.env.FLOWITION_HOME = home
  }
})

test('many processes contending for ONE dead-owner lock never overlap in the critical section', async () => {
  // The finding: reclamation was "read the lock, see a dead pid, unlink the name". Every
  // contender reads the same dead pid, so every contender unlinks — and the second unlink
  // removes the *fresh* lock the first contender has already published and is holding. Two
  // processes then run discover → bind → publish at once, two primaries bind, and the
  // second's viewer.json hides the first. With 40 contenders it reproduced on round one.
  //
  // The assertion is the invariant itself, measured rather than reasoned about: the maximum
  // number of processes simultaneously inside the critical section is exactly one. Each
  // worker proves its exclusivity twice over — a sentinel created with O_EXCL on the way in
  // (a worker that finds one already there was admitted alongside its owner), and a poll of
  // the lock file for the whole hold, since being inside means the lock names *you* until you
  // leave. The second check is the crash-proof one, and the one the deterministic test above
  // fails on when the naive reclaim is restored.
  //
  // A third of the herd are **corpses**: they take the lock and SIGKILL themselves inside it,
  // which is how the real thing happens (a starter crashes). Every corpse manufactures
  // another dead-owner lock for the whole surviving herd to contend over, so the reclaim path
  // is exercised many times over rather than once at startup.
  const WORKERS = 16
  const CORPSES = 8
  const CONTENDERS = WORKERS + CORPSES
  const CYCLES = 4
  const HOLD_MS = 12
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lock-herd-'))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lock-herd-sig-'))
  const home = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const lock = path.join(fresh, 'viewer.lock')
  const go = path.join(scratch, 'go')
  const sentinel = path.join(scratch, 'inside')
  const indexUrl = pathToFileURL(path.join(ROOT, 'src', 'viewer', 'index.js')).href
  /** @type {import('node:child_process').ChildProcess[]} */
  const kids = []
  try {
    // One lock, owned by a pid that cannot be running: every child must reclaim it, and
    // exactly one of them may end up holding the replacement.
    fs.writeFileSync(lock, JSON.stringify({ pid: 0x7fffffff, nonce: crypto.randomBytes(12).toString('hex'), startedAt: Date.now() }), { mode: 0o600 })

    const childSrc = (i, role) => `
      import fs from 'node:fs'
      const { withHomeLock } = await import(${JSON.stringify(indexUrl)})
      const lock = ${JSON.stringify(lock)}
      const sentinel = ${JSON.stringify(sentinel)}
      fs.writeFileSync(${JSON.stringify(path.join(scratch, 'ready'))} + '.' + ${i}, '')
      // All ${CONTENDERS} children hit the dead lock together, which is what makes the
      // read-then-unlink window wide enough to land in.
      while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 2))
      const opts = { timeoutMs: 60_000, retryMs: 5 }
      ${role === 'corpse' ? `
      // A crashed starter, the case reclamation exists for: die holding the lock, having
      // touched nothing else — so the sentinel invariant stays meaningful for the workers.
      await withHomeLock(async () => { process.kill(process.pid, 'SIGKILL') }, opts)
      process.stdout.write('SURVIVED-ITS-OWN-SIGKILL')
      ` : `
      let verdict = 'ok'
      for (let cycle = 0; cycle < ${CYCLES} && verdict === 'ok'; cycle++) {
        await withHomeLock(async () => {
          try {
            fs.closeSync(fs.openSync(sentinel, 'wx', 0o600))
          } catch (err) {
            // Someone else is inside. Do NOT remove their sentinel — the owner must still
            // find it there when it leaves.
            verdict = 'OVERLAP(' + err.code + ')'
            return
          }
          // Being inside means the lock names us for as long as we are here. A sample that
          // is missing, torn, or names someone else IS the bug: the lock was reclaimed out
          // from under a live holder, and whoever did it is in here too.
          const until = Date.now() + ${HOLD_MS}
          while (Date.now() < until) {
            let held = null
            try { held = JSON.parse(fs.readFileSync(lock, 'utf8')) } catch { /* below */ }
            if (held?.pid !== process.pid) {
              verdict = 'STOLEN(' + JSON.stringify(held) + ')'
              return
            }
            await new Promise((r) => setTimeout(r, 2))
          }
          fs.unlinkSync(sentinel)
        }, opts)
      }
      process.stdout.write(verdict)
      `}
    `
    const outs = []
    const exits = []
    const roles = []
    for (let i = 0; i < CONTENDERS; i++) {
      // Interleaved, so corpses keep appearing throughout rather than all at the front.
      const role = i % 3 === 2 ? 'corpse' : 'worker'
      roles.push(role)
      const kid = spawn(process.execPath, ['--input-type=module', '-e', childSrc(i, role)], {
        env: { ...process.env, FLOWITION_HOME: fresh },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      kids.push(kid)
      let out = ''
      let err = ''
      kid.stdout.setEncoding('utf8')
      kid.stderr.setEncoding('utf8')
      kid.stdout.on('data', (c) => { out += c })
      kid.stderr.on('data', (c) => { err += c })
      outs.push(() => ({ out, err }))
      exits.push(new Promise((r) => kid.on('exit', (code, signal) => r({ code, signal }))))
    }

    // Release them only once every child is loaded and polling.
    const ready = Date.now() + 60_000
    const readyCount = () => fs.readdirSync(scratch).filter((f) => f.startsWith('ready.')).length
    while (readyCount() < CONTENDERS && Date.now() < ready) await new Promise((r) => setTimeout(r, 10))
    assert.equal(readyCount(), CONTENDERS, 'not every contender loaded')
    fs.writeFileSync(go, '')

    const ends = await Promise.all(exits)
    const verdicts = outs.map((read, i) => ({ i, role: roles[i], ...ends[i], ...read() }))
    const describe = (v) => `#${v.i} ${v.role} exit=${v.code}/${v.signal} out=${JSON.stringify(v.out)} ${v.err.split('\n')[0]}`
    const workers = verdicts.filter((v) => v.role === 'worker')
    assert.equal(workers.length, WORKERS)
    assert.deepEqual(
      workers.filter((v) => v.code !== 0 || v.out !== 'ok').map(describe),
      [],
      'a worker either crashed, was admitted while another process was inside the critical section, or had its lock reclaimed while it held it',
    )
    // Every corpse really did die holding the lock — otherwise the reclaim path was never
    // exercised and this test proved nothing.
    assert.deepEqual(
      verdicts.filter((v) => v.role === 'corpse' && v.signal !== 'SIGKILL').map(describe),
      [],
      'a corpse did not die inside the critical section',
    )
    assert.equal(fs.existsSync(sentinel), false, 'the last holder left its sentinel behind')
    // A corpse may well have been the last thing to hold the lock, so a leftover here is
    // expected — and must name a dead pid and be reclaimable one final time.
    if (fs.existsSync(lock)) {
      const orphan = JSON.parse(fs.readFileSync(lock, 'utf8'))
      assert.ok(verdicts.some((v) => v.role === 'corpse'), `an unexplained lock survived: ${JSON.stringify(orphan)}`)
      let sleeps = 0
      await viewer.withHomeLock(async () => {}, { timeoutMs: 10_000, retryMs: 5, sleep: async () => { sleeps++ } })
      assert.equal(sleeps, 0, 'the last corpse\'s lock was not reclaimed immediately')
    }
    assert.equal(fs.existsSync(lock), false, 'the lock is released, not leaked')
    // Reclamation claims are single-use: the winner retires its own, so no debris blocks the
    // next generation of this lock. (A corpse dies inside the section, never mid-reclaim, so
    // there is nothing legitimate to leave behind here.)
    assert.deepEqual(fs.readdirSync(fresh).filter((f) => f.includes('.dead.')), [], 'a reclamation claim was left behind')
    assert.deepEqual(fs.readdirSync(fresh).filter((f) => f.endsWith('.tmp')), [], 'a publish temp file was left behind')
  } finally {
    for (const kid of kids) kid.kill('SIGKILL')
    process.env.FLOWITION_HOME = home
  }
})

test('a reclamation claim is never itself reclaimed — the stall is loud, not a second primary', async () => {
  // The deterministic half of the test above. Reclaiming a dead lock is serialized by an
  // O_EXCL claim named after that lock's inode identity, so at most one process is ever in a
  // position to unlink it — which is what stops contender #2 from deleting contender #1's
  // fresh lock. That claim must NOT be reclaimable on liveness or on a timer, or the same
  // race reappears one level down. The cost is this case: a reclaimer killed mid-reclaim
  // leaves a claim, and the lock stops being reclaimable. It must fail loudly (naming both
  // files) and never let anyone into the critical section.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lock-claim-'))
  const home = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const lock = path.join(fresh, 'viewer.lock')
  try {
    const body = JSON.stringify({ pid: 0x7fffffff, nonce: crypto.randomBytes(12).toString('hex'), startedAt: Date.now() })
    fs.writeFileSync(lock, body, { mode: 0o600 })
    // The claim name is derived from the lock's identity: dev, inode, and a digest of its
    // bytes (inode numbers get recycled; the owner's random nonce does not).
    const st = fs.statSync(lock)
    const digest = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)
    const claim = `${lock}.dead.${st.dev}-${st.ino}-${digest}`
    fs.writeFileSync(claim, '', { mode: 0o600 })

    let entered = false
    await assert.rejects(
      () => viewer.withHomeLock(async () => { entered = true }, { timeoutMs: 150, retryMs: 10 }),
      (err) => {
        assert.match(err.message, /which is gone, but its reclamation claim/)
        assert.match(err.message, /remove both files if no viewer is starting/)
        assert.ok(err.message.includes(claim), 'the message must name the claim to remove')
        return true
      },
    )
    assert.equal(entered, false, 'a blocked reclamation must not admit anyone')
    assert.equal(fs.readFileSync(lock, 'utf8'), body, 'and must not steal the lock either')

    // Clearing the claim by hand — the documented remedy — makes the very same call work.
    fs.unlinkSync(claim)
    assert.equal(await viewer.withHomeLock(async () => 'entered', { timeoutMs: 2000, retryMs: 10 }), 'entered')
    assert.equal(fs.existsSync(lock), false)
    assert.deepEqual(fs.readdirSync(fresh).filter((f) => f.includes('.dead.')), [], 'the claim is retired after a successful reclaim')
  } finally {
    process.env.FLOWITION_HOME = home
  }
})

test('the startup lock is never observable without its owner metadata', async () => {
  // The other half of the same finding: with a two-step publish there is a window in which
  // `viewer.lock` exists and names nobody. A real child hammers acquire/release while this
  // process reads the name as fast as it can; every read that succeeds must be a complete
  // record. (With the two-step publish the window is real but narrow — this catches it
  // probabilistically; the test above is the deterministic half.)
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lock-atomic-'))
  const home = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const lock = path.join(fresh, 'viewer.lock')
  const stop = path.join(fresh, 'stop')
  const churnSrc = `
    import fs from 'node:fs'
    const { withHomeLock } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'viewer', 'index.js')).href)})
    let n = 0
    while (!fs.existsSync(${JSON.stringify(stop)})) {
      await withHomeLock(async () => { n++ }, { timeoutMs: 10_000, retryMs: 1 })
    }
    process.stdout.write(String(n))
  `
  const churn = spawn(process.execPath, ['--input-type=module', '-e', churnSrc], {
    env: { ...process.env, FLOWITION_HOME: fresh },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  churn.stdout.setEncoding('utf8')
  churn.stdout.on('data', (c) => { out += c })
  const exited = new Promise((r) => churn.on('exit', r))
  try {
    const appeared = Date.now() + 10_000
    while (!fs.existsSync(lock) && Date.now() < appeared) await new Promise((r) => setTimeout(r, 1))
    assert.ok(Date.now() < appeared, 'the churning child never took the lock')

    let seen = 0
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      let raw
      try { raw = fs.readFileSync(lock, 'utf8') } catch { continue }   // between holders
      seen++
      let parsed = null
      try { parsed = JSON.parse(raw) } catch { /* asserted below */ }
      assert.ok(
        Number.isInteger(parsed?.pid),
        `viewer.lock was observable as ${JSON.stringify(raw)} — the name was published before its owner metadata`,
      )
    }
    assert.ok(seen > 0, 'never once caught the lock held — the hammer proved nothing')
  } finally {
    fs.writeFileSync(stop, '')
    const done = Date.now() + 10_000
    while (churn.exitCode === null && Date.now() < done) await new Promise((r) => setTimeout(r, 20))
    churn.kill('SIGKILL')
    await exited
    process.env.FLOWITION_HOME = home
  }
  assert.ok(Number(out) > 0, 'the child never completed an acquire/release cycle')
  assert.equal(fs.existsSync(lock), false, 'and the lock is released, not leaked')
})

test('two concurrent `flowition viewer` starts converge on ONE instance', async () => {
  // The race the per-home startup lock exists for: read viewer.json → probe → bind are
  // three steps, and two commands interleaving them both read "no instance" and both bind,
  // on adjacent ports, with the second one's rendezvous record hiding the first. Two real
  // subprocesses, started simultaneously against a fresh home.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-race-'))
  const base = await freePort()
  const env = { ...process.env, FLOWITION_HOME: fresh, FLOWITION_VIEWER_PORT: String(base) }
  const a = spawnViewerCli([], env)
  const b = spawnViewerCli([], env)
  try {
    const [first, second] = await Promise.all([a.announced, b.announced])

    assert.equal(first.port, second.port, `both must serve the same port, got ${first.port} and ${second.port}`)
    assert.ok(first.port >= base && first.port < base + viewer.PORT_WALK, `bound inside the walk: ${first.port}`)
    assert.equal(first.url, second.url, 'and print the same tokenized URL')
    // Exactly one bound; the other reused and exited.
    const reused = [first, second].filter((r) => r.reused === true)
    assert.equal(reused.length, 1, `exactly one caller must reuse: ${JSON.stringify([first, second])}`)
    // The rendezvous names the one that bound, and it is the only listener.
    const record = JSON.parse(fs.readFileSync(path.join(fresh, 'viewer.json'), 'utf8'))
    assert.equal(record.port, first.port)
    const owners = [a, b].filter((p) => p.child.pid === record.pid)
    assert.equal(owners.length, 1, 'the rendezvous pid is one of the two callers')
    assert.equal(owners[0].child.exitCode, null, 'the primary is still running')
    // Nothing is listening on the next port in the walk — no second server was started.
    const walked = await new Promise((resolve) => {
      const socket = net.connect(first.port + 1, '127.0.0.1')
      socket.on('connect', () => { socket.destroy(); resolve(true) })
      socket.on('error', () => resolve(false))
    })
    assert.equal(walked, false, `a second server was started on ${first.port + 1}`)
    // The startup lock is released, not leaked.
    assert.equal(fs.existsSync(path.join(fresh, 'viewer.lock')), false, 'the startup lock must not be left behind')
  } finally {
    a.child.kill('SIGTERM')
    b.child.kill('SIGTERM')
    await Promise.all([a.exited, b.exited])
  }
})

test('an explicit `--port` secondary leaves the primary rendezvous intact for its whole life', async () => {
  // The same contract as the library-level test, but through the CLI and across a real
  // process lifetime: start, run, and exit without ever touching viewer.json.
  const before = fs.readFileSync(viewer.rendezvousPath(), 'utf8')
  const secondary = spawnViewerCli(['--port', '0', '--control=send'], process.env)
  try {
    const announced = await secondary.announced
    assert.notEqual(announced.port, live.port)
    assert.deepEqual(announced.control, ['send'])
    assert.notEqual(announced.reused, true, 'an explicit --port is never satisfied by reuse')
    assert.equal(fs.readFileSync(viewer.rendezvousPath(), 'utf8'), before, 'the primary record is untouched')
    assert.ok(await viewer.challengeProbe(announced.port, live.token), 'the secondary is a real viewer')
  } finally {
    secondary.child.kill('SIGTERM')
    await secondary.exited
  }
  assert.equal(fs.readFileSync(viewer.rendezvousPath(), 'utf8'), before, 'and its exit does not remove the primary record')
  assert.equal((await viewer.discoverViewer()).port, live.port)
})

test('flowition viewer rejects a bad --control list with a clean error', async () => {
  const result = await runCli(['viewer', '--control=sned'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /^flowition: unknown --control capability "sned"/)
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'preconditions print clean, never a stack')
})

test('a fresh flowition home is created 0700 by the ownership check', async () => {
  const fresh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-fresh-')), 'nested', 'home')
  const savedHome = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  try {
    viewer.assertOwnership()
    assert.equal(mode(fresh), '700')
    assert.equal(mode(path.join(fresh, 'runs')), '700')
  } finally {
    process.env.FLOWITION_HOME = savedHome
  }
})

// ---- the ownership gate covers EVERY path into the home (§4.1, §7.4) ----------------
//
// The gate used to run inside `startViewer()` and nowhere else, so discovery, reuse,
// `--print-url` and the startup lock all read — and created — files inside another user's
// flowition home. `viewer.token` is created there (§7.1.2) and `deriveRunState` mutates
// aged `.resuming` markers, so this is a cross-user boundary, not a startup nicety.
//
// The uid is faked rather than the directory: `chown` needs privileges no test has, and
// what is under test is the comparison, not the kernel's.

/** Run `fn` with `process.getuid()` reporting a uid that owns nothing in `home`. */
async function asForeignUid(home, fn) {
  const savedHome = process.env.FLOWITION_HOME
  const realGetuid = process.getuid
  process.env.FLOWITION_HOME = home
  process.getuid = () => realGetuid.call(process) + 1
  try {
    return await fn()
  } finally {
    process.getuid = realGetuid
    process.env.FLOWITION_HOME = savedHome
  }
}

const FOREIGN = /is owned by uid \d+, not you \(uid \d+\) — refusing to run the viewer against another user's flowition home/

test('discoverViewer refuses a home owned by another user, and never touches its token', async (t) => {
  if (typeof process.getuid !== 'function') return t.skip('posix uids only')
  // A home that is otherwise perfectly reusable: a rendezvous record pointing at a REAL
  // live viewer. Without the gate this call succeeds, hands back a token-bearing URL for
  // someone else's home, and creates `viewer.token` there on the way.
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-foreign-discover-'))
  fs.writeFileSync(path.join(foreign, 'viewer.json'), JSON.stringify({ pid: process.pid, port: live.port, startedAt: Date.now(), control: [] }), { mode: 0o600 })
  await asForeignUid(foreign, async () => {
    await assert.rejects(() => viewer.discoverViewer(), FOREIGN)
  })
  assert.equal(fs.existsSync(path.join(foreign, 'viewer.token')), false, 'a token was created inside a foreign home')
  assert.equal(fs.existsSync(path.join(foreign, 'runs')), false, 'nothing was created inside a foreign home at all')
})

test('startOrReuseViewer refuses a home owned by another user before it locks or binds', async (t) => {
  if (typeof process.getuid !== 'function') return t.skip('posix uids only')
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-foreign-start-'))
  fs.writeFileSync(path.join(foreign, 'viewer.json'), JSON.stringify({ pid: process.pid, port: live.port, startedAt: Date.now(), control: [] }), { mode: 0o600 })
  await asForeignUid(foreign, async () => {
    await assert.rejects(() => viewer.startOrReuseViewer({ port: 0 }), FOREIGN)
    // The same refusal for a plain `startViewer`, and for the token and lock accessors —
    // every entrance to the home, not just the one §4.1 named.
    await assert.rejects(() => viewer.startViewer({ port: 0 }), FOREIGN)
    await assert.rejects(() => viewer.withHomeLock(async () => {}), FOREIGN)
    assert.throws(() => loadOrCreateToken(), FOREIGN)
    assert.throws(() => tokenPath(), FOREIGN)
    assert.throws(() => viewer.rendezvousPath(), FOREIGN)
    assert.throws(() => viewer.startupLockPath(), FOREIGN)
    assert.throws(() => viewer.writeOpenBootstrap('http://127.0.0.1:1/#/?t=x'), FOREIGN)
  })
  assert.equal(fs.existsSync(path.join(foreign, 'viewer.lock')), false, 'a lock was created inside a foreign home')
  assert.equal(fs.existsSync(path.join(foreign, 'viewer.token')), false, 'a token was created inside a foreign home')
  assert.deepEqual(fs.readdirSync(foreign), ['viewer.json'], 'nothing at all was written into a foreign home')
})

test('flowition viewer --print-url refuses a foreign home with a clean error and no URL', async (t) => {
  // Through the CLI, in a real subprocess, against a home that genuinely belongs to
  // another user — `/usr` is root-owned everywhere this viewer is supported (§13.1).
  if (typeof process.getuid !== 'function' || process.getuid() === 0) return t.skip('needs an unprivileged posix uid')
  for (const args of [['viewer', '--print-url'], ['viewer', '--print-url', '--json'], ['viewer']]) {
    const result = await runCli(args, { FLOWITION_HOME: '/usr' })
    assert.equal(result.code, 1, result.stderr)
    assert.equal(result.stdout, '', 'nothing is printed on stdout, token-bearing or otherwise')
    assert.match(result.stderr, /^flowition: \/usr is owned by uid 0, not you/)
    assert.doesNotMatch(result.stderr, /http:\/\//, 'no URL is printed for a home that is not ours')
    assert.doesNotMatch(result.stderr, /\n\s+at /, 'preconditions print clean, never a stack')
  }
})

test('only auth.js may reach `home`/`runsDir` directly — the gate cannot be bypassed', () => {
  // The structural half of the fix. The bug was not a missing call, it was that any new
  // entry point could name a file under the home without passing the gate. `viewerHome()`
  // is now the only accessor, so this test fails the moment a module reintroduces the
  // ungated one — including modules W5–W7 have not written yet.
  const dir = path.join(ROOT, 'src', 'viewer')
  const allowed = new Map([
    ['auth.js', 'defines the gate — the one place that may hold the ungated accessors'],
    // Shared with src/retention.js, i.e. with `flowition rm`/`prune`, which are CLI
    // operations subject to neither the viewer's platform scope nor its startup gate.
    ['audit.js', 'shared with the CLI retention path, not a viewer entry point'],
  ])
  const offenders = []
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    if (allowed.has(name)) continue
    const src = fs.readFileSync(path.join(dir, name), 'utf8')
    for (const [, names] of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/util\.js'/g)) {
      for (const binding of names.split(',').map((s) => s.trim().split(/\s+as\s+/)[0])) {
        if (binding === 'home' || binding === 'runsDir') offenders.push(`${name} imports ${binding}`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'use viewerHome()/viewerRunsDir() from ./auth.js instead')
})

// ---- startup that fails after binding (§4.1 lifecycle) -----------------------------

test('a startup that cannot publish its rendezvous leaves no listener behind', async () => {
  // `startViewer` binds, then publishes `viewer.json`. If publication fails the promise
  // rejects — and used to reject with the socket still bound and accepting: an embedded
  // caller held a server it had no handle to, and the requested port stayed occupied for
  // the life of the process, so a retry silently walked to the next one.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-rendezvous-fail-'))
  const savedHome = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const port = await freePort()
  try {
    // Publication fails at the rename: the rendezvous path is a directory.
    fs.mkdirSync(path.join(fresh, 'viewer.json'))
    await assert.rejects(() => viewer.startViewer({ port }), /EISDIR|ENOTDIR|ENOTEMPTY|EPERM|EACCES/)
    // The proof: the requested port is free again. (A leaked listener would make this
    // EADDRINUSE — and would have made the viewer's own retry walk to port+1.)
    const probe = http.createServer(() => {})
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', resolve)
    })
    await new Promise((r) => probe.close(r))
    // And a retry, once the cause is fixed, gets the port it asked for.
    fs.rmdirSync(path.join(fresh, 'viewer.json'))
    const retried = await viewer.startViewer({ port })
    try {
      assert.equal(retried.port, port, 'the retry bound the requested port, not the next one in the walk')
    } finally {
      await retried.close()
    }
  } finally {
    process.env.FLOWITION_HOME = savedHome
  }
})

// ---- --open through the CLI, after the command has exited (§4.2, §7.4) -------------

test('the --open bootstrap file does not outlive the command that created it', async () => {
  // `--print-url --open` announces and returns, and bin/flowition.js then calls
  // process.exit — so an in-process unlink timer (unref'd, by parity #30) never fires and
  // a 0600 file carrying the read token was left in the home forever. The unit test could
  // not see it: the test process stays alive, so the timer did fire there.
  //
  // A PATH shim stands in for the platform opener, so no browser is launched and the test
  // can also read back exactly what argv the opener saw.
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-opener-'))
  const log = path.join(shim, 'argv.log')
  for (const name of ['open', 'xdg-open']) {
    fs.writeFileSync(path.join(shim, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 })
  }
  const before = new Set(fs.readdirSync(HOME).filter((f) => f.startsWith('open-')))
  const result = await runCli(['viewer', '--print-url', '--open', '--json'], { PATH: `${shim}:${process.env.PATH}` })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).port, live.port)

  // The command has exited. Its bootstrap file is still here — that is the point of the
  // grace period, since the browser reads the file after the opener returns.
  const created = fs.readdirSync(HOME).filter((f) => f.startsWith('open-') && !before.has(f))
  assert.equal(created.length, 1, `exactly one bootstrap file: ${JSON.stringify(created)}`)
  const file = path.join(HOME, created[0])
  assert.equal(mode(file), '600')
  assert.ok(fs.readFileSync(file, 'utf8').includes(live.token), 'the hop carries the token — that is its purpose')

  // The opener saw the path and nothing else: `ps` during --open reveals no credential.
  // It is spawned detached, so it may land just after the command exits.
  const openerDeadline = Date.now() + 5000
  while (!fs.existsSync(log) && Date.now() < openerDeadline) await new Promise((r) => setTimeout(r, 50))
  assert.ok(fs.existsSync(log), 'the opener never ran')
  const argv = fs.readFileSync(log, 'utf8')
  assert.deepEqual(argv.trim().split('\n'), [file])
  assert.ok(!argv.includes(live.token))

  // And it is deleted, by a process that outlived the command. Nothing in this test
  // process is doing it.
  const deadline = Date.now() + 25_000
  while (fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  assert.equal(fs.existsSync(file), false, 'the 0600 bootstrap file outlived the command that created it')
})

test('the --open bootstrap file is deleted even when the command ran with no usable PATH', async () => {
  // End to end, through a real CLI process that then exits, with a PATH in which nothing
  // resolves. The opener itself cannot be found — that only warns (§4.2: "never block,
  // failure only warns") — but the deleter must still run, because it is `process.execPath`
  // evaluating a fixed program rather than a shell calling `sleep` and `rm`.
  const before = new Set(fs.readdirSync(HOME).filter((f) => f.startsWith('open-')))
  const result = await runCli(['viewer', '--print-url', '--open', '--json'], { PATH: '/definitely-missing' })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).port, live.port)

  const created = fs.readdirSync(HOME).filter((f) => f.startsWith('open-') && !before.has(f))
  assert.equal(created.length, 1, `exactly one bootstrap file: ${JSON.stringify(created)}`)
  const file = path.join(HOME, created[0])
  assert.ok(fs.readFileSync(file, 'utf8').includes(live.token), 'the file does carry the token')

  const deadline = Date.now() + 25_000
  while (fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  assert.equal(fs.existsSync(file), false, 'a token-bearing bootstrap file was left behind because PATH lacked sleep/rm')
})

test('a live lock held by another thread of this process is not reclaimed as own-pid debris', async () => {
  // The finding: `reclaimLockIfDead` exempted `process.pid` from the liveness test, on the
  // theory that the in-process FIFO queue already excludes every sibling caller, so an
  // own-pid lock could only be debris. `worker_threads` breaks that theory — workers share
  // `process.pid` but get their own module registry, so worker B has its own `homeQueues`
  // and its own `lockOwnership` and sees worker A's live lock as reclaimable debris. B then
  // reclaimed it and ran discover → bind → publish alongside A.
  //
  // This is the deterministic probe: this thread holds the lock (so the file genuinely names
  // `process.pid`), a worker thread contends, and it must time out without entering.
  const { Worker } = await import('node:worker_threads')
  const indexUrl = pathToFileURL(path.join(ROOT, 'src', 'viewer', 'index.js')).href
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-lock-thread-'))
  const home = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = fresh
  const lock = path.join(fresh, 'viewer.lock')

  const contend = (timeoutMs) => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      let entered = false
      import(workerData.indexUrl)
        .then(({ withHomeLock }) => withHomeLock(async () => { entered = true }, { timeoutMs: workerData.timeoutMs, retryMs: 10 }))
        .then(() => parentPort.postMessage({ entered, pid: process.pid, error: null }),
              (err) => parentPort.postMessage({ entered, pid: process.pid, error: String(err && err.message) }))
    `, {
      eval: true,
      workerData: { indexUrl, timeoutMs },
      env: { ...process.env, FLOWITION_HOME: fresh },
    })
    worker.once('message', (msg) => { worker.terminate(); resolve(msg) })
    worker.once('error', reject)
  })

  try {
    let contender = null
    await viewer.withHomeLock(async () => {
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid,
        'the probe is only meaningful if the lock really does name our own pid')
      contender = await contend(300)
      // Still ours, still intact: the worker must not have unlinked it either.
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid, 'the worker stole the live lock')
    }, { timeoutMs: 5000, retryMs: 10 })

    assert.equal(contender.pid, process.pid, 'a worker thread shares process.pid — that is the whole hazard')
    assert.equal(contender.entered, false, 'a worker thread entered the critical section alongside the lock holder')
    assert.match(contender.error, /is starting a viewer for this flowition home and has held/)
    assert.match(contender.error, /remove that file if no viewer is starting/)

    // And once this thread has left, the very same worker call succeeds — the refusal above
    // is about liveness, not a permanent inability to see the lock across threads.
    assert.equal(fs.existsSync(lock), false, 'the holder released its lock')
    const after = await contend(5000)
    assert.equal(after.error, null, after.error)
    assert.equal(after.entered, true, 'a worker must still be able to take an unheld lock')
  } finally {
    process.env.FLOWITION_HOME = home
  }
})

// ---- exposed token files are ROTATED, never repaired-and-reused (§7.1.2, §7.4) -------
//
// The principle, because an earlier revision of this file got it exactly wrong: **you
// cannot un-leak a credential by tightening its permissions.** If `viewer.token` has any
// group or other bit set, every local user has had the opportunity to read it for as long
// as it existed; `chmod 0600` afterwards revokes nothing, and a group/other-*writable*
// file may hold a value an attacker chose (which would make the bearer check and the
// §4.2.1 proof theirs to compute). Serving it would leave the whole §7.1.2 read surface
// behind a credential the §7.4 "another local user" adversary may already hold.
//
// So the rule is split by disclosure, not by convenience:
//   - group/other bits set  → REFUSE the value, unlink the file, mint a fresh 0600 token
//   - owner-only (0000, 0400, 0200, 0700) → chmod 0600 and keep the value; nobody else
//     ever had a byte of it, so the invariant is genuinely restored
//   - anything else wrong (foreign uid, not a regular file, chmod fails) → refuse to start

/** A helper shared by the rotation tests: a fresh home holding a token at `mode`. */
const seedToken = (mode, token) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-mode-'))
  fs.writeFileSync(path.join(dir, 'viewer.token'), token, { mode })
  fs.chmodSync(path.join(dir, 'viewer.token'), mode)
  return dir
}

const EXPOSED_MODES = [0o644, 0o660, 0o666, 0o604, 0o640, 0o060, 0o006, 0o602, 0o620]

test('a token file with group/other permission bits is rotated, not repaired and reused', () => {
  const saved = process.env.FLOWITION_HOME
  try {
    for (const loose of EXPOSED_MODES) {
      const leaked = crypto.randomBytes(32).toString('base64url')
      const dir = seedToken(loose, leaked)
      const file = path.join(dir, 'viewer.token')
      // 0060/0006 deny the owner, so only check the precondition where we can read it.
      if (loose & 0o400) assert.equal(fs.readFileSync(file, 'utf8'), leaked, 'the fixture must start out holding the leaked value')
      process.env.FLOWITION_HOME = dir

      const rotated = []
      // `clearRotation` is the caller's assertion that nothing is still serving the exposed
      // value — the fixture home has no listener at all, so it holds trivially here. The
      // tests below cover both halves of what it means when one *is* running.
      const served = loadOrCreateToken({ onRotate: (info) => rotated.push(info), clearRotation: () => true })
      const why = `mode ${loose.toString(8)}`

      // The whole point: the disclosed value is never handed back.
      assert.notEqual(served, leaked, `${why}: the exposed token was reused instead of rotated`)
      assert.equal(isCanonicalToken(served), true, `${why}: the replacement is not a §7.1.2 credential`)
      assert.equal(Buffer.from(served, 'base64url').length, 32, `${why}: replacement is not 32 bytes`)

      // …and it is gone from disk, replaced by the credential that was returned, 0600.
      assert.equal(mode(file), '600', `${why}: the replacement is not 0600`)
      assert.equal(fs.readFileSync(file, 'utf8'), served, `${why}: the file does not hold the served token`)
      assert.equal(fs.readFileSync(file, 'utf8').includes(leaked), false, `${why}: the leaked value survived on disk`)

      // Rotation is reported (so a caller can tell the user their token was revoked) and
      // the notification carries no credential — neither the old one nor the new one.
      assert.equal(rotated.length, 1, `${why}: rotation was silent`)
      assert.equal(rotated[0].file, file)
      assert.equal(rotated[0].mode, loose.toString(8).padStart(4, '0'))
      const note = JSON.stringify(rotated[0])
      assert.equal(note.includes(leaked), false, `${why}: the rotation notice echoed the old token`)
      assert.equal(note.includes(served), false, `${why}: the rotation notice echoed the new token`)

      // Stable from then on: the second call reads the freshly minted 0600 file.
      assert.equal(loadOrCreateToken(), served, `${why}: the rotated token is not stable`)
    }
  } finally {
    process.env.FLOWITION_HOME = saved
  }
})

test('an exposed token is never served — the viewer authenticates only the rotated one', async () => {
  const saved = process.env.FLOWITION_HOME
  const leaked = crypto.randomBytes(32).toString('base64url')
  const dir = seedToken(0o644, leaked)
  let instance
  try {
    process.env.FLOWITION_HOME = dir
    instance = await viewer.startViewer({ port: 0 })
    instance.unref()

    assert.notEqual(instance.token, leaked, 'the server came up holding the leaked credential')
    assert.equal(mode(path.join(dir, 'viewer.token')), '600')

    const status = (token) => new Promise((resolve) => {
      http.get({
        host: '127.0.0.1',
        port: instance.port,
        path: '/api/runs',
        headers: { host: `127.0.0.1:${instance.port}`, authorization: `Bearer ${token}` },
      }, (res) => { res.resume(); resolve(res.statusCode) })
    })

    // The complete read API is behind the token, so this is the assertion that matters:
    // the credential another local user may have read does not open it. The rotated one
    // does — auth runs before dispatch, so a 501 from a handler another unit still owns
    // (§11.2) is just as much a pass as a 200 and this stays green when it lands.
    assert.equal(await status(leaked), 401, 'the leaked token still authenticated against the read API')
    const ok = await status(instance.token)
    assert.ok(ok === 200 || ok === 501, `the rotated token does not authenticate (got ${ok})`)

    // And the leaked value is not what the §4.2.1 proof commits to either, so a peer that
    // only knows the old token cannot pass discovery.
    const challenge = crypto.randomBytes(32).toString('base64url')
    const body = await new Promise((resolve) => {
      http.get({
        host: '127.0.0.1',
        port: instance.port,
        path: '/healthz',
        headers: { host: `127.0.0.1:${instance.port}`, 'x-flowition-challenge': challenge },
      }, (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve(JSON.parse(data)))
      })
    })
    assert.equal(body.proof, challengeProof(instance.token, challenge))
    assert.notEqual(body.proof, challengeProof(leaked, challenge))
    assert.equal(JSON.stringify(body).includes(leaked), false, 'the readiness JSON echoed the leaked token')
  } finally {
    await instance?.close()
    process.env.FLOWITION_HOME = saved
  }
})

test('the token file must be a regular file this uid owns at 0600 — owner-only modes repaired, everything else refused', async () => {
  // The original finding: `hardenMode()` swallowed every chmod error and `loadOrCreateToken`
  // returned the credential regardless, so a token that could not be secured stayed in
  // service while the viewer served transcripts behind it. §7.1.2's "0600 file another local
  // user cannot read" is the boundary itself (§7.4 "Another local user"), so it is asserted,
  // not attempted: repair what could not have leaked, rotate what could, refuse the rest.
  const authUrl = pathToFileURL(path.join(ROOT, 'src', 'viewer', 'auth.js')).href
  const token = crypto.randomBytes(32).toString('base64url')
  const seeded = (mode) => seedToken(mode, token)
  const child = (dir, prelude) => new Promise((resolve) => {
    const src = `
      import fs from 'node:fs'
      ${prelude}
      const { loadOrCreateToken } = await import(${JSON.stringify(authUrl)})
      try { process.stdout.write('ACCEPTED:' + loadOrCreateToken({ clearRotation: () => true })) }
      catch (err) { process.stdout.write('REFUSED:' + err.message) }
    `
    execFile(process.execPath, ['--input-type=module', '-e', src],
      { env: { ...process.env, FLOWITION_HOME: dir }, timeout: 30_000 },
      (err, stdout, stderr) => resolve(stdout || `ERR:${stderr}`))
  })

  const saved = process.env.FLOWITION_HOME
  try {
    // 1. Owner-only modes could not have disclosed the token to anyone, so — and ONLY here
    // — the file is repaired in place and its value kept. 0000 and 0060 make the pair: both
    // deny the owner, but only the first denies everyone else, so only the first is repaired
    // (0060 is covered by the rotation test above).
    for (const ownerOnly of [0o000, 0o400, 0o200, 0o700, 0o500]) {
      const dir = seeded(ownerOnly)
      process.env.FLOWITION_HOME = dir
      const rotated = []
      assert.equal(loadOrCreateToken({ onRotate: (i) => rotated.push(i) }), token,
        `mode ${ownerOnly.toString(8)} discloses nothing and should be repaired, not rotated`)
      assert.equal(rotated.length, 0, `mode ${ownerOnly.toString(8)} was needlessly rotated`)
      assert.equal(mode(path.join(dir, 'viewer.token')), '600', `mode ${ownerOnly.toString(8)} was not actually tightened`)
    }

    // 2. A chmod that fails is a refusal, not a shrug. (`import fs from 'node:fs'` resolves
    // to the mutable CJS module object, so auth.js calls exactly this stub.) The mode is
    // owner-only, so this is the repair path — the exposed path never chmods at all.
    const unchmodable = await child(seeded(0o400), `
      fs.fchmodSync = () => { const e = new Error('read-only'); e.code = 'EPERM'; throw e }
      fs.chmodSync = () => { const e = new Error('read-only'); e.code = 'EPERM'; throw e }
    `)
    assert.match(unchmodable, /^REFUSED:/, `a token that cannot be chmodded was used anyway: ${unchmodable}`)
    assert.match(unchmodable, /cannot be used as a viewer token/)
    assert.match(unchmodable, /chmod failed \(EPERM\)/)
    assert.match(unchmodable, /Rotate it/, 'the refusal must say how to recover')
    assert.equal(unchmodable.includes(token), false, 'the refusal echoed the token')

    // 3. An exposed token whose rotation cannot complete is a refusal too — the one thing
    // that must never happen is falling back to serving it.
    const unremovable = await child(seeded(0o644), `
      fs.unlinkSync = (p) => { if (String(p).endsWith('viewer.token')) { const e = new Error('nope'); e.code = 'EPERM'; throw e } }
    `)
    assert.match(unremovable, /^REFUSED:/, `an exposed token that could not be removed was served: ${unremovable}`)
    assert.match(unremovable, /could not be removed to rotate it \(EPERM\)/)
    assert.match(unremovable, /tightening the mode would not revoke a credential/)
    assert.equal(unremovable.includes(token), false, 'the refusal echoed the token')

    // 4. A file owned by another uid is refused outright — never chmodded, never rotated
    // (it is not ours to delete), never used. (`fstatSync` is stubbed rather than
    // `process.getuid`, which the §4.1 home check also reads; this isolates the token
    // file's own ownership assertion.) Exposed *and* foreign still reports the ownership
    // problem, which is the more precise answer.
    for (const m of [0o600, 0o644]) {
      const foreign = await child(seeded(m), `
        const realFstat = fs.fstatSync
        fs.fstatSync = (...a) => { const st = realFstat(...a); return { ...st, uid: st.uid + 1, isFile: () => st.isFile() } }
      `)
      assert.match(foreign, /^REFUSED:/, `a foreign-owned token was used: ${foreign}`)
      assert.match(foreign, /is owned by uid \d+, not you \(uid \d+\)/)
      assert.match(foreign, /Rotate it/)
      assert.equal(foreign.includes(token), false, 'the refusal echoed the token')
    }

    // 5. Not a regular file at all.
    const asDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-dir-'))
    fs.mkdirSync(path.join(asDir, 'viewer.token'), { mode: 0o700 })
    process.env.FLOWITION_HOME = asDir
    assert.throws(() => loadOrCreateToken(), /is not a regular file|EISDIR/)

    // 6. A `viewer.token` symlinked at an exposed file: `openSync` follows the link, so the
    // condemned inode is the *target*. The name is removed (which never touches the target)
    // and a real token is minted in its place — the target's value is never served.
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-link-'))
    const target = path.join(linked, 'elsewhere')
    fs.writeFileSync(target, token, { mode: 0o644 })
    fs.chmodSync(target, 0o644)
    fs.symlinkSync(target, path.join(linked, 'viewer.token'))
    process.env.FLOWITION_HOME = linked
    const minted = loadOrCreateToken({ clearRotation: () => true })
    assert.notEqual(minted, token, 'the symlinked exposed token was served')
    assert.equal(fs.lstatSync(path.join(linked, 'viewer.token')).isSymbolicLink(), false, 'the symlink survived')
    assert.equal(mode(path.join(linked, 'viewer.token')), '600')
    assert.equal(fs.readFileSync(target, 'utf8'), token, 'unlinking the name must not touch the target file')
  } finally {
    process.env.FLOWITION_HOME = saved
  }
})

// ---- the credential is a LIVE invariant, and rotation revokes it (§7.1.2, §7.4) -------
//
// The finding this section pins: rotating an exposed `viewer.token` used to change only the
// file. A viewer already running kept the original value in memory and kept answering 200 to
// it, so `startOrReuseViewer` minted a replacement, published a new `viewer.json`, and left
// the leaked credential live on the old port — hiding the vulnerable listener rather than
// revoking it. "The exposed token is never served" was true of the *new* instance and false
// of the one that mattered.
//
// Two halves, tested separately and then together:
//   1. a running viewer re-proves its credential against disk on every request and on a
//      timer, and any divergence stops authentication and then closes the listener;
//   2. nothing mints a replacement until every listener that could still be serving the old
//      value is provably gone — in this process by stopping and awaiting it, in another by
//      waiting for it to fail closed, and otherwise by refusing loudly and touching nothing.

/** `GET /api/runs` with a bearer token → the status code, or the network error's code. */
const apiStatus = (port, token) => new Promise((resolve) => {
  const req = http.get({
    host: '127.0.0.1',
    port,
    path: '/api/runs',
    headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` },
    // A fresh connection every time. Node's global agent keeps sockets pooled, so a probe of
    // a port whose server has since closed would reuse a dead socket and report ECONNRESET
    // instead of the truth about what is (or is not) listening there now.
    agent: false,
  }, (res) => { res.resume(); resolve(res.statusCode) })
  req.on('error', (err) => resolve(err.code ?? 'ERROR'))
})

/** Auth runs before dispatch, so a 501 from a handler another unit owns is also a pass. */
const authenticated = (status) => status === 200 || status === 501

const waitFor = async (predicate, what, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${typeof what === 'function' ? what() : what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('a live viewer fails closed when its token file stops being the 0600 file it started from', async () => {
  const saved = process.env.FLOWITION_HOME
  // Every way the credential on disk can stop being the one this process is serving. The last
  // is the subtle one: identical bytes at a new inode is still someone else's file taking over
  // the name, which is exactly what a rotation looks like from the outside.
  const cases = [
    ['exposed to other local users', (file) => fs.chmodSync(file, 0o644), /mode changed to 0644/],
    ['deleted', (file) => fs.unlinkSync(file), /was deleted/],
    // Overwritten in place, so the inode is unchanged and the *value* is the only thing that
    // has moved — the case an identity-only check would miss.
    ['rewritten in place with a different credential', (file) => {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), { flag: 'r+' })
    }, /now holds a different credential/],
    ['unlinked and replaced by a valid credential', (file) => {
      fs.unlinkSync(file)
      fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 })
    }, /replaced by a different file/],
    ['rewritten with the same value at a new inode', (file) => {
      const value = fs.readFileSync(file, 'utf8')
      fs.unlinkSync(file)
      fs.writeFileSync(file, value, { mode: 0o600 })
    }, /replaced by a different file/],
  ]
  for (const [what, breakIt, expected] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-live-'))
    process.env.FLOWITION_HOME = dir
    let instance
    try {
      const revoked = []
      const shutdowns = []
      instance = await viewer.startViewer({
        port: 0,
        credentialCheckMs: 20,
        onCredentialRevoked: (why) => revoked.push(why),
        onShutdown: (reason) => shutdowns.push(reason),
      })
      instance.unref()
      assert.equal(authenticated(await apiStatus(instance.port, instance.token)), true, `${what}: precondition`)

      breakIt(path.join(dir, 'viewer.token'))

      // No sleep, and deliberately so: the credential is re-proven on the request itself, so
      // the very next request carrying the token this server was started with is already
      // refused. A timer-only design would serve it for up to one tick.
      assert.equal(await apiStatus(instance.port, instance.token), 401, `${what}: the original token still authenticated`)

      // …and the instance takes itself down, so an idle viewer nobody is talking to cannot sit
      // there holding a burned credential either.
      await waitFor(() => !instance.server.listening, `${what}: the listener to close itself`)
      assert.equal(fs.existsSync(path.join(dir, 'viewer.json')), false, `${what}: the rendezvous record outlived the listener`)
      assert.match(revoked[0] ?? '', expected, what)
      assert.deepEqual(shutdowns, ['credential-revoked'], what)
      assert.equal(revoked.join(' ').includes(instance.token), false, `${what}: the reason echoed the token`)
    } finally {
      await instance?.close()
      process.env.FLOWITION_HOME = saved
    }
  }
})

test('startOrReuseViewer revokes the listener that served an exposed token — it never shadows it', async () => {
  const saved = process.env.FLOWITION_HOME
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-shadow-'))
  process.env.FLOWITION_HOME = dir
  const file = path.join(dir, 'viewer.token')
  let first
  let second
  try {
    const revoked = []
    // The credential watch is set a minute out on purpose: this test must prove that
    // *discovery* revokes the live listener, not that a background poll happened to fire
    // first. Everything below is therefore attributable to `startOrReuseViewer` alone.
    first = await viewer.startViewer({ port: 0, credentialCheckMs: 60_000, onCredentialRevoked: (why) => revoked.push(why) })
    first.unref()
    const leaked = first.token
    assert.equal(authenticated(await apiStatus(first.port, leaked)), true, 'precondition: the viewer serves its token')

    // The exposure, and the attacker's read: from here on every local user has had this value.
    fs.chmodSync(file, 0o644)
    assert.equal(fs.readFileSync(file, 'utf8'), leaked, 'the fixture must reproduce the disclosure')

    const rotated = []
    second = await viewer.startOrReuseViewer({ port: 0, onRotate: (info) => rotated.push(info) })
    second.unref()

    // 1. The exposed credential is replaced, not reused, and the replacement is a real one.
    assert.equal(second.reused, false, 'an exposed credential must never be reused')
    assert.notEqual(second.token, leaked, 'the leaked value came back as the new credential')
    assert.equal(isCanonicalToken(second.token), true)
    assert.equal(mode(file), '600')
    assert.equal(fs.readFileSync(file, 'utf8'), second.token)
    assert.equal(rotated.length, 1, 'the rotation was silent')

    // 2. The listener that served the leaked value is GONE — the whole point. Not refusing
    //    while still bound, not hidden behind a fresh viewer.json: closed.
    assert.equal(first.server.listening, false, 'the viewer serving the exposed token was left running')
    assert.match(revoked[0] ?? '', /exposed to other local users/)
    const onOldPort = await apiStatus(first.port, leaked)
    // Its port may have been handed straight to the replacement, which refuses the leaked
    // token like any other stranger; otherwise nothing is listening there at all.
    assert.ok(onOldPort === 'ECONNREFUSED' || onOldPort === 401, `the leaked token got ${onOldPort} on the old port`)

    // 3. Exactly one listener remains, it is the one the rendezvous names, and the leaked
    //    token does not open it.
    assert.equal(second.server.listening, true)
    assert.equal(viewer.readRendezvous().port, second.port)
    assert.equal(viewer.readRendezvous().pid, process.pid)
    assert.equal(await apiStatus(second.port, leaked), 401, 'the replacement authenticated the leaked token')
    assert.equal(authenticated(await apiStatus(second.port, second.token)), true)

    // 4. And the §4.2.1 probe now proves the *new* credential only, so a peer still holding
    //    the leaked one cannot pass discovery against the surviving instance.
    const found = await viewer.discoverViewer()
    assert.equal(found.port, second.port)
    assert.equal(found.token, second.token)
  } finally {
    await first?.close()
    await second?.close()
    process.env.FLOWITION_HOME = saved
  }
})

test('an exposed token is never rotated behind a viewer still running in another process', async () => {
  // The fixture is the shape of "another `flowition viewer` is serving this home": an exposed
  // token plus a rendezvous record naming a live pid that this process holds no instance for.
  // Rotating here would revoke nothing (that process authenticates from its own memory) and
  // would hide it behind a second listener, so the only safe answers are "wait for it to fail
  // closed" and, when it does not, "refuse and change nothing".
  const saved = process.env.FLOWITION_HOME
  const leaked = crypto.randomBytes(32).toString('base64url')
  const dir = seedToken(0o644, leaked)
  const file = path.join(dir, 'viewer.token')
  const record = { pid: process.pid, port: 4646, startedAt: Date.now(), control: [] }
  try {
    process.env.FLOWITION_HOME = dir
    fs.writeFileSync(path.join(dir, 'viewer.json'), JSON.stringify(record), { mode: 0o600 })

    await assert.rejects(() => viewer.startOrReuseViewer({ port: 0, revokeWaitMs: 120 }), (err) => {
      assert.match(err.message, /still running \(pid \d+, port 4646\)/)
      assert.match(err.message, /would keep serving the exposed credential from memory/)
      assert.match(err.message, /did not stop within 120ms/)
      assert.match(err.message, /kill \d+ && flowition viewer/, 'the refusal must say how to recover')
      assert.equal(err.message.includes(leaked), false, 'the refusal echoed the token')
      return true
    })

    // Nothing was touched: the file is still the (exposed) one that process is serving, no
    // replacement was minted, and no second instance took over the rendezvous.
    assert.equal(fs.readFileSync(file, 'utf8'), leaked, 'the exposed token was rotated behind a live viewer')
    assert.equal(mode(file), '644', 'the mode was quietly repaired instead of refused')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'viewer.json'), 'utf8')), record)
    assert.equal(fs.existsSync(path.join(dir, 'viewer.lock')), false, 'the startup lock was left behind')

    // The same refusal reaches `--print-url`, which also reads the credential.
    await assert.rejects(() => viewer.discoverViewer({ revokeWaitMs: 60 }), /still running \(pid \d+, port 4646\)/)

    // Once that process is gone — here, once the record no longer names a live pid — the
    // rotation is safe and proceeds without any of the above.
    fs.writeFileSync(path.join(dir, 'viewer.json'), JSON.stringify({ ...record, pid: 0x7ffffffe }), { mode: 0o600 })
    const rotated = []
    const credential = await viewer.establishCredential({ onRotate: (info) => rotated.push(info) })
    assert.notEqual(credential.token, leaked)
    assert.equal(rotated.length, 1)
    assert.equal(mode(file), '600')
  } finally {
    process.env.FLOWITION_HOME = saved
  }
})

test('loadOrCreateCredential never rotates an exposed token on its own authority', () => {
  // Safety by construction rather than by remembering: the module that classifies the file
  // cannot know whether a listener is still serving it, so it refuses unless the caller —
  // `establishCredential`, which has just stopped and confirmed every such listener — says so.
  // A future entry point that forgets gets this refusal, not a silent shadow-rotation.
  const saved = process.env.FLOWITION_HOME
  const leaked = crypto.randomBytes(32).toString('base64url')
  const dir = seedToken(0o644, leaked)
  const file = path.join(dir, 'viewer.token')
  try {
    process.env.FLOWITION_HOME = dir
    assert.throws(() => loadOrCreateToken(), (err) => {
      assert.match(err.message, /has mode 0644, which exposes the viewer token to other local users/)
      assert.match(err.message, /stop any running viewer for this home/)
      assert.equal(err.message.includes(leaked), false, 'the refusal echoed the token')
      return true
    })
    assert.equal(fs.readFileSync(file, 'utf8'), leaked, 'the refusal must change nothing on disk')

    // The clearance is consulted, not assumed: a predicate that says no is the same refusal.
    let asked = 0
    assert.throws(() => loadOrCreateToken({ clearRotation: () => { asked++; return false } }), /exposes the viewer token/)
    assert.equal(asked, 1)
    assert.equal(fs.readFileSync(file, 'utf8'), leaked)
  } finally {
    process.env.FLOWITION_HOME = saved
  }
})

test('the credential guard fails closed on a token file it cannot verify, and stays closed', () => {
  // A credential this process cannot re-prove is one it must not serve (§7.4): an unreadable
  // home, an EIO, a file that turned out to belong to another uid. And revocation is one-way —
  // a file that goes back to looking healthy does not resurrect an instance whose credential
  // has already been through an unverifiable state.
  let verdict = { kind: 'error', code: 'EIO' }
  const credential = { token: 'a'.repeat(43), dev: 1, ino: 2 }
  const guard = createCredentialGuard(credential, { inspect: () => verdict })
  assert.match(guard.check(), /could not be verified \(EIO\)/)
  verdict = { kind: 'ok', ...credential }
  assert.match(guard.check(), /could not be verified \(EIO\)/, 'revocation must be sticky')
  assert.match(guard.reason(), /EIO/)

  // A healthy file, by contrast, is not a revocation — and `revoke` is what a peer clearing an
  // exposed credential uses to stop this instance authenticating before its socket comes down.
  const healthy = createCredentialGuard(credential, { inspect: () => ({ kind: 'ok', ...credential }) })
  assert.equal(healthy.check(), null)
  assert.equal(healthy.reason(), null)
  healthy.revoke('stopped by a peer')
  assert.equal(healthy.check(), 'stopped by a peer')
})

test('revocation holds across processes: a live viewer stops itself, the next command mints a fresh credential', async () => {
  // The end-to-end shape of the finding, with two real `flowition viewer` processes rather
  // than in-process instances: nothing here signals anybody, and no listener is stopped from
  // the outside. The viewer whose token file was opened up fails *itself* closed, and only
  // once it is gone does the next command replace the burned value.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-token-processes-'))
  const file = path.join(dir, 'viewer.token')
  const env = { ...process.env, FLOWITION_HOME: dir }
  const children = []
  const startCli = (...args) => {
    const child = spawn(process.execPath, [BIN, 'viewer', ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const out = { stderr: '', code: null }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { out.stderr += chunk })
    child.on('exit', (code) => { out.code = code ?? 0 })
    children.push(child)
    return out
  }
  // The §2.2 grammar keeps the token in the fragment, so this is where the CLI's own line
  // publishes it — the same string a user would paste.
  const urlToken = (stderr) => /[?&]t=([A-Za-z0-9_-]{43})/.exec(stderr)?.[1] ?? null

  try {
    const first = startCli('--port', '0')
    await waitFor(() => urlToken(first.stderr), () => `the first viewer to print its URL (${JSON.stringify(first.stderr)})`, 20_000)
    const leaked = urlToken(first.stderr)
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(first.stderr)[1])
    assert.equal(authenticated(await apiStatus(port, leaked)), true, 'precondition: it serves its token')
    assert.equal(fs.readFileSync(file, 'utf8'), leaked)

    fs.chmodSync(file, 0o644)   // every local user has now had the chance to read it

    await waitFor(() => first.code !== null, () => `the exposed viewer to exit (${JSON.stringify(first.stderr)})`, 20_000)
    assert.equal(first.code, 1, `a revoked viewer must exit non-zero: ${first.stderr}`)
    // The startup line legitimately carries the token (§2.2 — in the fragment), so the notice
    // is checked on its own line: that one must explain the revocation and name no credential.
    const notice = first.stderr.split('\n').find((line) => line.includes('has stopped serving')) ?? ''
    assert.match(notice, /mode changed to 0644/)
    assert.match(notice, /start the viewer again to mint a fresh token/)
    assert.equal(notice.includes(leaked), false, 'the revocation notice echoed the token')
    assert.equal(await apiStatus(port, leaked), 'ECONNREFUSED', 'the leaked token still reached a listener')
    assert.equal(fs.existsSync(path.join(dir, 'viewer.json')), false, 'the record outlived the listener')

    // Only now — with nothing serving the old value — is the rotation safe, and the next
    // command does it and says so.
    const second = startCli('--port', '0')
    await waitFor(() => urlToken(second.stderr), () => `the replacement viewer to print its URL (${JSON.stringify(second.stderr)})`, 20_000)
    assert.notEqual(urlToken(second.stderr), leaked, 'the replacement served the leaked credential')
    assert.match(second.stderr, /previously printed URLs no longer work/)
    assert.equal(mode(file), '600')
    assert.equal(fs.readFileSync(file, 'utf8'), urlToken(second.stderr))
  } finally {
    for (const child of children) { try { child.kill('SIGKILL') } catch { /* already gone */ } }
  }
})
