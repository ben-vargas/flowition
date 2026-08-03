// Per-run control channel: a unix socket at <runDir>/control.sock speaking JSONL
// request/response. Powers `flowition send/answer/cancel/post/status` against a live run —
// including from inside the run's own agents (they get FLOWITION_CONTROL_SOCK in env).
import net from 'node:net'
import fs from 'node:fs'
import { LineSplitter } from './util.js'

const PROBE_TIMEOUT_MS = 250
const IDLE_TIMEOUT_MS = 30_000

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

function statSocket(sockPath) {
  try { return fs.lstatSync(sockPath) } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

function probeSocket(sockPath) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath)
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      conn.destroy()
      const err = new Error(`control socket probe timed out: ${sockPath}`)
      err.code = 'ETIMEDOUT'
      reject(err)
    }, PROBE_TIMEOUT_MS)
    conn.once('connect', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      conn.destroy()
      resolve()
    })
    conn.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function clearStaleSocket(sockPath) {
  // Claim-by-rename instead of check-then-unlink: renaming is atomic, and a unix
  // socket stays reachable through its renamed path (same inode), so we can probe
  // the exact file we claimed. A live server's socket is renamed back; only a
  // socket that refuses connections on the claimed path is discarded.
  if (!statSocket(sockPath)) return
  const claim = `${sockPath}.claim.${process.pid}`
  try { fs.renameSync(sockPath, claim) } catch { return /* vanished or raced — listen() will surface any conflict */ }
  let live = false
  try { await probeSocket(claim); live = true } catch { /* stale or unreachable */ }
  if (live) {
    // restore without clobbering: link fails with EEXIST if a newer listener
    // bound meanwhile; then the live server keeps answering at the claim path
    let restored = false
    try { fs.linkSync(claim, sockPath); restored = true } catch { /* newer listener owns the path */ }
    if (restored) { try { fs.unlinkSync(claim) } catch { /* gone */ } }
    throw new Error(`run already active: ${sockPath}`)
  }
  try { fs.unlinkSync(claim) } catch { /* gone */ }
}

export function serveControl(sockPath, handle) {
  const clients = new Set()
  let owner = null
  let closing = false
  let closePromise
  const server = net.createServer((conn) => {
    if (closing) {
      conn.destroy()
      return
    }
    clients.add(conn)
    const splitter = new LineSplitter()
    conn.setEncoding('utf8')
    conn.setTimeout(IDLE_TIMEOUT_MS, () => conn.destroy())
    conn.on('data', (chunk) =>
      splitter.push(chunk, async (line) => {
        let req
        try { req = JSON.parse(line) } catch { return }
        let res
        try { res = await handle(req) } catch (err) { res = { error: String(err?.message ?? err) } }
        try { conn.write(JSON.stringify({ id: req.id, ...res }) + '\n') } catch { /* client gone */ }
      }),
    )
    conn.on('error', () => {})
    conn.on('close', () => clients.delete(conn))
  })
  // post-listen server errors: report with context (ready's once-handlers own pre-listen)
  server.on('error', (err) => {
    if (!closing && server.listening) process.stderr.write(`flowition: control socket error (${sockPath}): ${err.message}\n`)
  })
  const ready = (async () => {
    await clearStaleSocket(sockPath)
    if (closing) throw new Error('control server closed')
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        server.off('error', onError)
        server.off('listening', onListening)
      }
      const onError = (err) => { cleanup(); reject(err) }
      const onListening = () => { cleanup(); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      try { server.listen(sockPath) } catch (err) { cleanup(); reject(err) }
    })
    owner = statSocket(sockPath)
    if (!owner) {
      server.close()
      throw new Error(`control socket disappeared after listen: ${sockPath}`)
    }
    if (closing) {
      close()
      throw new Error('control server closed')
    }
  })()

  function unlinkOwned() {
    const current = statSocket(sockPath)
    if (!owner || !current || !sameFile(owner, current)) return
    try { fs.unlinkSync(sockPath) } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
  }

  function close() {
    if (closePromise) return closePromise
    closing = true
    // Unlink NOW, synchronously, while this call still owns the path. Deferring the
    // unlink to the server's async close callback loses ownership: a successor bind in
    // this same process (a resume immediately after a completed run) can create a new
    // socket at this path before the callback runs, and on filesystems that recycle
    // inode numbers (Linux ext4 — unlike APFS, which allocates monotonically) the freed
    // inode lands on the successor's file, so the dev/ino identity guard blesses
    // deleting the successor's LIVE socket. First contact with Linux CI found exactly
    // that: "control socket disappeared after listen" across every run→resume test.
    // The bound server keeps serving established connections after the unlink; new
    // connects failing is the point of closing. Cross-process claims are unaffected —
    // the §claim-by-rename protocol never depended on this unlink's timing.
    unlinkOwned()
    owner = null
    for (const conn of clients) conn.destroy()
    closePromise = new Promise((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
    })
    return closePromise
  }

  return {
    ready,
    close,
  }
}

export function controlRequest(sockPath, req, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath)
    const timer = setTimeout(() => { conn.destroy(); reject(new Error('control request timed out')) }, timeoutMs)
    const splitter = new LineSplitter()
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, ...req }) + '\n'))
    conn.on('data', (chunk) =>
      splitter.push(chunk, (line) => {
        clearTimeout(timer)
        conn.end()
        try { resolve(JSON.parse(line)) } catch (err) { reject(err) }
      }),
    )
    conn.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}
