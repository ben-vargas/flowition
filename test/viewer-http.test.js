// W4 — the viewer request pipeline, as a security matrix (DESIGN §11.2 "viewer-http").
//
// Every assertion here is a refusal the threat model (§7.4) depends on. Requests go
// through node:http, never fetch/undici: `Host` and `Origin` are forbidden header names
// for fetch, so a fetch-based test would silently assert nothing about the two gates
// that stop DNS rebinding and CSRF.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-http-'))
process.env.FLOWITION_HOME = HOME

const { startViewer } = await import('../src/viewer/index.js')
const { SECURITY_HEADERS, MAX_BODY_BYTES } = await import('../src/viewer/http.js')
const { resolveRoute, validateMutationBody } = await import('../src/viewer/routes.js')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// ---- fixtures --------------------------------------------------------------------

const DIST = path.join(HOME, 'dist')
const SECRET = path.join(HOME, 'outside-secret.txt')

function seedDist() {
  fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(DIST, 'index.html'), '<!doctype html><title>flowition</title><script src="/assets/app.js"></script>')
  fs.writeFileSync(path.join(DIST, 'assets', 'app-abc123.js'), 'export const app = 1\n')
  fs.writeFileSync(path.join(DIST, 'boot-theme.js'), 'document.documentElement.dataset.theme = "dark"\n')
  fs.writeFileSync(SECRET, 'BEGIN OPENSSH PRIVATE KEY\n')
  // The symlink-escape case: normalizes and joins cleanly, caught only by realpath
  // containment (§5.8).
  fs.symlinkSync(SECRET, path.join(DIST, 'escape.js'))
}

const READ_RUN_ID = 'http-read-run'
const SEARCH_RUN_ID = 'http-search-conflict'

function seedReadRuns() {
  const root = path.join(HOME, 'runs')
  const dir = path.join(root, READ_RUN_ID)
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  const engine = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  fs.writeFileSync(path.join(dir, 'journal.jsonl'),
    JSON.stringify({ type: 'meta', runId: READ_RUN_ID, workflowFile: '/tmp/read.js', createdAt: 1, args: { secret: 'visible-by-audit' } }) + '\n'
    + JSON.stringify({ type: 'result', key: 'k', index: 0, status: 'completed', result: 'agent-result' }) + '\n')
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    JSON.stringify({ t: 2, type: 'run', state: 'started', engine, name: 'HTTP read run' }) + '\n'
    + JSON.stringify({ t: 3, type: 'agent', index: 0, key: 'k', adapter: 'mock', state: 'done' }) + '\n'
    + JSON.stringify({ t: 4, type: 'run', state: 'completed' }) + '\n')
  fs.writeFileSync(path.join(dir, 'agents', '0.jsonl'), JSON.stringify({ t: 3, kind: 'text', text: 'needle transcript' }) + '\n')
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ runId: READ_RUN_ID, status: 'completed', result: { ok: true } }))

  const searchDir = path.join(root, SEARCH_RUN_ID)
  fs.mkdirSync(searchDir, { recursive: true })
  const line = JSON.stringify({ type: 'log', message: 'x'.repeat(512 * 1024) }) + '\n'
  fs.writeFileSync(path.join(searchDir, 'events.jsonl'), line.repeat(8))
}

/** @type {{status:number, headers:Record<string,string>, body:string, json:any}} */
function request(port, { method = 'GET', path: target = '/', headers = {}, body, setHost = true } = {}) {
  // content-length is set explicitly for every body: node's client suppresses chunked
  // framing on methods it considers bodyless (DELETE among them), so `req.write` on a
  // DELETE without a declared length puts unframed bytes on the wire.
  const withLength = body == null ? headers : { 'content-length': String(Buffer.byteLength(body)), ...headers }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: withLength, setHost }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json })
      })
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

let ro   // read-only viewer (the default)
let rw   // viewer with all five capabilities
const auth = (v) => ({ host: `127.0.0.1:${v.port}`, authorization: `Bearer ${v.token}` })
const mutate = (v, extra = {}) => ({
  ...auth(v),
  origin: `http://127.0.0.1:${v.port}`,
  'content-type': 'application/json',
  'x-flowition-control': v.controlToken,
  ...extra,
})

before(async () => {
  seedDist()
  seedReadRuns()
  ro = await startViewer({ port: 0, distRoot: DIST })
  rw = await startViewer({ port: 0, distRoot: DIST, control: true })
  // Node 18's node:test finishes the root test from a `process.on('beforeExit')` hook,
  // which never fires while a listening server holds a ref'd handle on the event loop:
  // the file would print every passing test and then hang forever with no teardown and
  // no summary. `unref()` lets the loop drain once the last request settles — the
  // sockets are still fully functional while requests are in flight (a pending request
  // is itself a ref'd handle), and the `after` hook below still closes both servers.
  ro.unref()
  rw.unref()
})
after(async () => {
  await ro?.close()
  await rw?.close()
})

// ---- Host (§7.1.3 — DNS rebinding) ------------------------------------------------

test('Host: only the three loopback names with the bound port are answered', async () => {
  // A request with NO Host header is a disallowed Host like any other: §7.1.3 wants a 403,
  // and §7.1.4 wants the security headers on it. Node's default would answer its own bare
  // 400 before the handler ran (no envelope, no CSP), so the server disables
  // `requireHostHeader` and refuses it here.
  const noHost = await request(ro.port, { path: '/api/session', setHost: false, headers: { authorization: `Bearer ${ro.token}` } })
  assert.equal(noHost.status, 403)
  assert.equal(noHost.json.error.code, 'forbidden')
  assert.match(noHost.json.error.message, /host not allowed/)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(noHost.headers[name], value, name)
  assert.ok(!noHost.body.includes(ro.token))

  // Every spelling a rebinding attacker controls: their own name, a name that merely
  // contains ours, the wildcard address, and the right name on the wrong port.
  for (const host of ['127.0.0.1', 'localhost', '127.0.0.1:1', 'evil.example.com', 'evil.example.com:PORT', '0.0.0.0:PORT', 'flowition.viewer:PORT', '127.0.0.1.evil.example.com:PORT', 'localhost.evil.example.com:PORT']) {
    const value = host.replace('PORT', String(ro.port))
    const res = await request(ro.port, { path: '/api/session', headers: { host: value }, setHost: false })
    assert.equal(res.status, 403, `host "${value}" must be refused`)
    assert.equal(res.json.error.code, 'forbidden')
    // The host gate runs BEFORE auth, so a rebound page never even learns whether it
    // holds a valid token.
    assert.match(res.json.error.message, /host not allowed/)
  }

  for (const host of [`127.0.0.1:${ro.port}`, `localhost:${ro.port}`, `[::1]:${ro.port}`]) {
    const res = await request(ro.port, { path: '/api/session', headers: { host, authorization: `Bearer ${ro.token}` } })
    assert.equal(res.status, 200, `host "${host}" must be accepted`)
  }
})

// ---- token (§7.1.2) ---------------------------------------------------------------

test('token: the whole /api surface requires it, reads included', async () => {
  for (const headers of [
    {},                                                    // absent
    { authorization: 'Bearer ' },                          // empty
    { authorization: `Bearer ${'x'.repeat(43)}` },          // wrong, right length
    { authorization: `Bearer ${ro.token}extra` },           // wrong length
    { authorization: ro.token },                            // no scheme
    { authorization: `Basic ${Buffer.from(ro.token).toString('base64')}` },
  ]) {
    const res = await request(ro.port, { path: '/api/runs', headers: { host: `127.0.0.1:${ro.port}`, ...headers } })
    assert.equal(res.status, 401, JSON.stringify(headers))
    assert.equal(res.json.error.code, 'unauthorized')
  }
  const ok = await request(ro.port, { path: '/api/session', headers: auth(ro) })
  assert.equal(ok.status, 200)
})

test('token: ?token= is accepted only on the SSE route', async () => {
  const host = { host: `127.0.0.1:${ro.port}` }
  const onRead = await request(ro.port, { path: `/api/runs?token=${ro.token}`, headers: host })
  assert.equal(onRead.status, 401, 'a query token must not authenticate a normal read route')

  // EventSource cannot set headers, so the stream route — and only it — honors the
  // query form. The nonexistent run reaches the registered handler after auth.
  const onStream = await request(ro.port, { path: `/api/runs/flo_x/stream?token=${ro.token}`, headers: host })
  assert.equal(onStream.status, 404, onStream.body)

  const wrongOnStream = await request(ro.port, { path: '/api/runs/flo_x/stream?token=nope', headers: host })
  assert.equal(wrongOnStream.status, 401)
})

test('token: /healthz is the only unauthenticated route and leaks nothing', async () => {
  const res = await request(ro.port, { path: '/healthz', headers: { host: `127.0.0.1:${ro.port}` } })
  assert.equal(res.status, 200)
  assert.deepEqual(Object.keys(res.json).sort(), ['app', 'version'])
  assert.equal(res.json.app, 'flowition-viewer')
  assert.ok(!res.body.includes(ro.token))
  assert.ok(!res.body.includes(HOME), 'healthz must not disclose the flowition home')
})

test('token: a revoked credential refuses the whole /api surface, including the token it was started with', async () => {
  // §7.1.2 describes a boundary, not a startup check: if `viewer.token` stops being the 0600
  // file this process was started from, the value it holds in memory is exactly the one another
  // local user may now have, so it must stop opening the read surface. index.js closes the
  // listener right behind this; here the guard is marked directly and the server deliberately
  // left up, so what is under test is the pipeline gate itself and its precedence.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-revoked-'))
  const saved = process.env.FLOWITION_HOME
  process.env.FLOWITION_HOME = dir
  let v
  try {
    v = await startViewer({ port: 0, distRoot: DIST, control: true, credentialCheckMs: 60_000 })
    v.unref()
    assert.equal((await request(v.port, { path: '/api/session', headers: auth(v) })).status, 200, 'precondition')

    v.credential.revoke('the viewer token file was deleted')

    const read = await request(v.port, { path: '/api/session', headers: auth(v) })
    assert.equal(read.status, 401)
    assert.equal(read.json.error.code, 'unauthorized')
    assert.match(read.json.error.message, /no longer authenticates: the viewer token file was deleted/)
    assert.ok(!read.body.includes(v.token), 'the refusal echoed the credential')
    assert.ok(!read.body.includes(dir), 'the refusal disclosed a filesystem path')

    // The 404 for an unknown route and the mutation routes are behind it too — a revoked
    // instance does not even map its route table.
    for (const target of ['/api/nope', '/api/runs', `/api/runs/flo_x/stream?token=${v.token}`]) {
      assert.equal((await request(v.port, { path: target, headers: auth(v) })).status, 401, target)
    }
    const mutation = await request(v.port, { method: 'POST', path: '/api/runs/flo_x/cancel', headers: mutate(v), body: '{}' })
    assert.equal(mutation.status, 401, 'a mutation with every other gate satisfied must still fail closed')

    // Precedence is unchanged: the Host gate still decides first, so a rebound page learns
    // nothing about the credential's state either (§7.1.3).
    const rebound = await request(v.port, { path: '/api/session', headers: { host: 'evil.example.com', authorization: `Bearer ${v.token}` }, setHost: false })
    assert.equal(rebound.status, 403)
    assert.match(rebound.json.error.message, /host not allowed/)

    // /healthz stops proving token knowledge (§4.2.1): a peer that still holds this value must
    // not be able to "verify" a listener whose credential is dead and reuse it.
    const health = await request(v.port, { path: '/healthz', headers: { host: `127.0.0.1:${v.port}`, 'x-flowition-challenge': 'a'.repeat(43) } })
    assert.equal(health.status, 200)
    assert.equal(health.json.proof, undefined)

    // The SPA shell is not a secret and still serves, so the browser can render the
    // "paste a token" screen rather than a blank page.
    const asset = await request(v.port, { path: '/index.html', headers: { host: `127.0.0.1:${v.port}` } })
    assert.equal(asset.status, 200)
  } finally {
    await v?.close()
    process.env.FLOWITION_HOME = saved
  }
})

// ---- Origin (§7.1.5) --------------------------------------------------------------

test('Origin: a present-but-foreign origin is refused on reads; mutations require one', async () => {
  const bad = await request(ro.port, { path: '/api/session', headers: { ...auth(ro), origin: 'https://evil.example.com' } })
  assert.equal(bad.status, 403)
  assert.equal(bad.json.error.code, 'forbidden')

  const opaque = await request(ro.port, { path: '/api/session', headers: { ...auth(ro), origin: 'null' } })
  assert.equal(opaque.status, 403)

  // Absent is fine for a read — curl and the CLI send none.
  const absent = await request(ro.port, { path: '/api/session', headers: auth(ro) })
  assert.equal(absent.status, 200)
})

test('Origin: must equal the origin of the Host it arrived on, not merely an allowed name', async () => {
  // §7.1.5 says "an Origin header exactly equal to the server's own origin". A browser
  // derives that from the authority it connected to, so http://localhost:P and
  // http://127.0.0.1:P are two DIFFERENT origins even though they are one socket.
  // Accepting either against either Host would hand the CSRF check back to the attacker:
  // a page on http://localhost:P could then drive requests it sent with Host 127.0.0.1:P.
  const names = ['127.0.0.1', 'localhost', '[::1]']
  for (const hostName of names) {
    for (const originName of names) {
      const host = `${hostName}:${ro.port}`
      const origin = `http://${originName}:${ro.port}`
      const res = await request(ro.port, { path: '/api/session', headers: { host, authorization: `Bearer ${ro.token}`, origin }, setHost: false })
      if (hostName === originName) {
        assert.equal(res.status, 200, `Host ${host} + Origin ${origin} must be accepted`)
      } else {
        assert.equal(res.status, 403, `Host ${host} + Origin ${origin} is cross-origin and must be refused`)
        assert.equal(res.json.error.code, 'forbidden')
        assert.match(res.json.error.message, /origin not allowed/)
      }
    }
  }
  // Same name, right port on the Host, wrong port on the Origin: still cross-origin.
  const wrongPort = await request(ro.port, {
    path: '/api/session',
    headers: { host: `127.0.0.1:${ro.port}`, authorization: `Bearer ${ro.token}`, origin: `http://127.0.0.1:${ro.port + 1}` },
    setHost: false,
  })
  assert.equal(wrongPort.status, 403)
  // ...and the same pairing rule governs mutations, which require the header outright.
  for (const originName of names) {
    const res = await request(rw.port, {
      method: 'POST',
      path: '/api/runs/flo_x/cancel',
      headers: { ...mutate(rw), origin: `http://${originName}:${rw.port}` },
      body: '{}',
    })
    // W7's handler now runs: the pipeline passed and `flo_x` is simply not a run (404).
    if (originName === '127.0.0.1') assert.equal(res.status, 404, res.body)
    else assert.equal(res.status, 403, `mutation with Origin http://${originName}:${rw.port} on Host 127.0.0.1:${rw.port}`)
  }
})

test('Origin: a mutation with no Origin header at all is refused', async () => {
  const res = await request(rw.port, {
    method: 'POST',
    path: '/api/runs/flo_x/cancel',
    headers: { ...auth(rw), 'content-type': 'application/json', 'x-flowition-control': rw.controlToken },
    body: '{}',
  })
  assert.equal(res.status, 403)
  assert.match(res.json.error.message, /Origin/)
})

// ---- method (§5.3, parity #27) ----------------------------------------------------

test('method: non-GET/HEAD on a read route is 405 with Allow', async () => {
  for (const [method, target, allow] of [
    ['POST', '/api/runs', 'GET, HEAD'],
    ['PUT', '/api/session', 'GET, HEAD'],
    ['DELETE', '/api/runs/flo_x/result', 'GET, HEAD'],
    ['GET', '/api/runs/flo_x/send', 'POST'],
    ['POST', '/api/runs/flo_x', 'GET, HEAD, DELETE'],
  ]) {
    const res = await request(rw.port, { method, path: target, headers: mutate(rw) })
    assert.equal(res.status, 405, `${method} ${target}`)
    assert.equal(res.headers.allow, allow, `${method} ${target}`)
    assert.equal(res.json.error.code, 'bad_request')
  }
})

test('method: HEAD is served by the GET handler with no body', async () => {
  const res = await request(ro.port, { method: 'HEAD', path: '/api/session', headers: auth(ro) })
  assert.equal(res.status, 200)
  assert.equal(res.body, '')
  assert.ok(Number(res.headers['content-length']) > 0)
})

// ---- content-type + body limits (§7.1.5, §5.1) ------------------------------------

test('content-type: mutations demand application/json', async () => {
  for (const value of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain;application/json']) {
    const headers = mutate(rw)
    if (value === undefined) delete headers['content-type']
    else headers['content-type'] = value
    const res = await request(rw.port, { method: 'POST', path: '/api/runs/flo_x/cancel', headers, body: '{}' })
    assert.equal(res.status, 400, `content-type ${value}`)
    assert.match(res.json.error.message, /content-type/)
  }
  for (const value of ['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON']) {
    const res = await request(rw.port, { method: 'POST', path: '/api/runs/flo_x/cancel', headers: mutate(rw, { 'content-type': value }), body: '{}' })
    assert.notEqual(res.status, 400, `content-type ${value} must pass the gate`)
  }
})

test('body: over 256 KB is 413, malformed JSON is 400', async () => {
  const big = JSON.stringify({ agent: 0, message: 'x'.repeat(MAX_BODY_BYTES) })
  const res = await request(rw.port, { method: 'POST', path: '/api/runs/flo_x/send', headers: mutate(rw), body: big })
  assert.equal(res.status, 413)
  assert.equal(res.json.error.code, 'payload_too_large')

  const broken = await request(rw.port, { method: 'POST', path: '/api/runs/flo_x/cancel', headers: mutate(rw), body: '{' })
  assert.equal(broken.status, 400)
  // Bodies are steering text: the refusal must not echo any of it back.
  assert.ok(!broken.body.includes('{'.repeat(1)) || !broken.json.error.message.includes('{'))
})

test('body: every gate runs BEFORE a single byte of it is read', async () => {
  // §5.1 principle 4 bounds the body at 256 KB, but the bound is only half the story:
  // reading first means an unauthenticated or misdirected caller can make this process
  // hold its bytes, and it also reorders the refusals so the wrong one wins. Each case
  // below declares an over-cap body and must be refused on its HEADERS, never with 413.
  const big = JSON.stringify({ agent: 0, message: 'x'.repeat(MAX_BODY_BYTES) })
  const cases = [
    ['host first', rw.port, { ...mutate(rw), host: 'evil.example' }, 403, 'forbidden', /host not allowed/],
    ['then auth', rw.port, { ...mutate(rw), authorization: 'Bearer nope-not-the-token' }, 401, 'unauthorized', /token/],
    ['then origin', rw.port, { ...mutate(rw), origin: 'https://evil.example.com' }, 403, 'forbidden', /origin not allowed/],
    ['then content-type', rw.port, { ...mutate(rw), 'content-type': 'text/plain' }, 400, 'bad_request', /content-type/],
    ['then read-only', ro.port, { ...auth(ro), origin: `http://127.0.0.1:${ro.port}`, 'content-type': 'application/json' }, 403, 'forbidden', /read-only/],
    ['then the control token', rw.port, { ...mutate(rw), 'x-flowition-control': 'nope' }, 403, 'forbidden', /control token/],
  ]
  for (const [label, port, headers, status, code, message] of cases) {
    const res = await request(port, { method: 'POST', path: '/api/runs/flo_x/send', headers, setHost: false, body: big })
    assert.equal(res.status, status, `${label}: got ${res.status} ${res.body}`)
    assert.equal(res.json.error.code, code, label)
    assert.match(res.json.error.message, message, label)
    // A refusal that leaves declared bytes in the socket must not leave the connection
    // open for the parser to read them as the next request line.
    assert.equal(res.headers.connection, 'close', label)
  }
  // A route that does not exist is 404 before the body too, and an unauthenticated caller
  // still cannot map the route table by making us read one.
  const unknown = await request(rw.port, { method: 'POST', path: '/api/nope', headers: mutate(rw), body: big })
  assert.equal(unknown.status, 404)
  // Only once every gate has passed is the body read — and then the cap applies.
  const overCap = await request(rw.port, { method: 'POST', path: '/api/runs/flo_x/send', headers: mutate(rw), body: big })
  assert.equal(overCap.status, 413)
})

test('body: a message field over 32,768 chars is refused', async () => {
  const res = await request(rw.port, {
    method: 'POST',
    path: '/api/runs/flo_x/send',
    headers: mutate(rw),
    body: JSON.stringify({ agent: 0, message: 'x'.repeat(32_769) }),
  })
  assert.equal(res.status, 400)
  assert.match(res.json.error.message, /32768|32,768/)
})

// ---- the write surface (§7.2) -----------------------------------------------------

test('read-only default: every mutation route answers 403 with the restart hint', async () => {
  const cases = [
    ['POST', '/api/runs/flo_x/send', { agent: 0, message: 'hi' }],
    ['POST', '/api/runs/flo_x/answer', { qid: 'q0', value: 'yes' }],
    ['POST', '/api/runs/flo_x/cancel', {}],
    ['POST', '/api/runs/flo_x/resume', {}],
    ['DELETE', '/api/runs/flo_x', {}],
  ]
  for (const [method, target, body] of cases) {
    const res = await request(ro.port, {
      method,
      path: target,
      headers: { ...auth(ro), origin: `http://127.0.0.1:${ro.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(res.status, 403, `${method} ${target}`)
    assert.equal(res.json.error.code, 'forbidden')
    assert.equal(res.json.error.message, 'viewer is read-only — restart with --control')
  }
  const session = await request(ro.port, { path: '/api/session', headers: auth(ro) })
  assert.deepEqual(session.json.control, [])
  assert.equal(session.json.readOnly, true)
})

test('control token: a valid read token is not enough to mutate', async () => {
  for (const value of [undefined, '', 'nope', rw.token, `${rw.controlToken}x`]) {
    const headers = mutate(rw)
    if (value === undefined) delete headers['x-flowition-control']
    else headers['x-flowition-control'] = value
    const res = await request(rw.port, { method: 'POST', path: '/api/runs/flo_x/cancel', headers, body: '{}' })
    assert.equal(res.status, 403, `control token ${JSON.stringify(value)}`)
    assert.match(res.json.error.message, /control token/)
  }
  // With it, the pipeline is fully passed and W7's handler answers — 404 because the
  // run does not exist, which is a handler verdict, not a gate refusal.
  const passed = await request(rw.port, { method: 'POST', path: '/api/runs/flo_x/cancel', headers: mutate(rw), body: '{}' })
  assert.equal(passed.status, 404, passed.body)
})

test('capability subsets: an unlisted capability is 403 even with the control token', async () => {
  const partial = await startViewer({ port: 0, distRoot: DIST, control: 'send,answer' })
  try {
    const session = await request(partial.port, { path: '/api/session', headers: auth(partial) })
    assert.deepEqual(session.json.control, ['send', 'answer'])
    assert.equal(session.json.readOnly, false)

    const allowed = await request(partial.port, { method: 'POST', path: '/api/runs/flo_x/send', headers: mutate(partial), body: JSON.stringify({ agent: 0, message: 'hi' }) })
    assert.equal(allowed.status, 404, allowed.body)

    for (const [method, target] of [['POST', '/api/runs/flo_x/cancel'], ['POST', '/api/runs/flo_x/resume'], ['DELETE', '/api/runs/flo_x']]) {
      const res = await request(partial.port, { method, path: target, headers: mutate(partial), body: '{}' })
      assert.equal(res.status, 403, `${method} ${target}`)
      assert.match(res.json.error.message, /capability is not enabled/)
    }
  } finally {
    await partial.close()
  }
})

// ---- cancel body validation (critique N5) -----------------------------------------

test('cancel: only an absent agent key means "cancel the whole run"', async () => {
  // The engine reads `agent == null` as a whole-run cancel (src/engine.js:711). A client
  // that posts {agent: null} from empty state must be refused, not obeyed.
  for (const body of [{ agent: null }, { agent: -1 }, { agent: 1.5 }, { agent: '' }, { agent: {} }, { agent: [] }, { agent: true }, { agent: false }, { agent: 'x'.repeat(513) }]) {
    const res = await request(rw.port, { method: 'POST', path: '/api/runs/flo_x/cancel', headers: mutate(rw), body: JSON.stringify(body) })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.match(res.json.error.message, /omit the key entirely/)
  }
  for (const body of [{}, { agent: 0 }, { agent: 7 }, { agent: 'reviewer' }, { agent: '3' }]) {
    const res = await request(rw.port, { method: 'POST', path: '/api/runs/flo_x/cancel', headers: mutate(rw), body: JSON.stringify(body) })
    assert.equal(res.status, 404, JSON.stringify(body))
  }
  // and directly, so the rule is pinned independently of the HTTP layer
  assert.deepEqual(validateMutationBody('cancel', {}, 'flo_x'), {})
  assert.deepEqual(validateMutationBody('cancel', { agent: 2 }, 'flo_x'), { agent: 2 })
  assert.throws(() => validateMutationBody('cancel', { agent: null }, 'flo_x'), /omit the key entirely/)
  assert.throws(() => validateMutationBody('send', { agent: 0 }, 'flo_x'), /non-empty "message"/)
  assert.throws(() => validateMutationBody('answer', { qid: 'q0' }, 'flo_x'), /requires a "value"/)
})

// ---- ids and params (§5.1 principle 1, §5.4.1) ------------------------------------

test('ids: every runId flows through runDir(); :n must be a canonical integer', async () => {
  for (const target of [
    '/api/runs/%2e%2e%2f%2e%2e%2fetc',
    '/api/runs/.hidden',
    '/api/runs/a%2Fb',
    '/api/runs/x%20y/result',
    '/api/runs/-lead/result',
  ]) {
    const res = await request(ro.port, { path: target, headers: auth(ro) })
    assert.equal(res.status, 400, target)
    assert.equal(res.json.error.code, 'bad_request', target)
    assert.match(res.json.error.message, /invalid run id/, target)
  }
  // A NUL is refused before the id is even looked at.
  const nul = await request(ro.port, { path: '/api/runs/a%00b', headers: auth(ro) })
  assert.equal(nul.status, 400)
  assert.match(nul.json.error.message, /malformed request path/)
  // A dot segment — including its percent-encoded spelling, which the WHATWG URL parser
  // also treats as one — is collapsed before it reaches us, so the path resolves to a
  // route that does not exist. Never to a path join.
  for (const target of ['/api/runs/..', '/api/runs/%2e%2e', '/api/runs/flo_x/%2E%2E/%2E%2E']) {
    const dots = await request(ro.port, { path: target, headers: auth(ro) })
    assert.equal(dots.status, 404, target)
  }
  for (const n of ['03', '1e2', '-1', '1.0', '+1', 'x']) {
    const res = await request(ro.port, { path: `/api/runs/flo_x/agents/${encodeURIComponent(n)}/page`, headers: auth(ro) })
    assert.equal(res.status, 400, n)
    assert.equal(res.json.error.runId, 'flo_x')
  }
  const ok = await request(ro.port, { path: '/api/runs/flo_x/agents/0/page', headers: auth(ro) })
  assert.equal(ok.status, 404, ok.body)
})

test('unknown /api paths are 404 JSON, never static HTML', async () => {
  for (const target of ['/api', '/api/nope', '/api/runs/flo_x/nope', '/api/runs/flo_x/agents/0/nope', '/api/runs/flo_x/agents/0']) {
    const res = await request(ro.port, { path: target, headers: auth(ro) })
    assert.equal(res.status, 404, target)
    assert.equal(res.json.error.code, 'not_found', target)
    assert.match(res.headers['content-type'], /application\/json/)
  }
  // ...and unauthenticated callers cannot map the route table either.
  const anon = await request(ro.port, { path: '/api/nope', headers: { host: `127.0.0.1:${ro.port}` } })
  assert.equal(anon.status, 401)
})

test('resolveRoute is matched on decoded segments', () => {
  assert.equal(resolveRoute(['api', 'runs', 'flo_x', 'stream']).sse, true)
  assert.equal(resolveRoute(['api', 'runs', 'flo_x', 'agents', '3', 'page']).agentIndex, '3')
  assert.deepEqual(Object.keys(resolveRoute(['api', 'runs', 'flo_x']).methods), ['GET', 'DELETE'])
  assert.equal(resolveRoute(['api', 'runs', 'flo_x', 'agents', '3']), null)
  assert.equal(resolveRoute(['healthz']), null)
})

// ---- static serving (§5.8) --------------------------------------------------------

test('static: index.html for / and extension-less paths, assets by content type', async () => {
  const host = { host: `127.0.0.1:${ro.port}` }
  for (const target of ['/', '/settings', '/run/flo_x', '/index.html']) {
    const res = await request(ro.port, { path: target, headers: host })
    assert.equal(res.status, 200, target)
    assert.match(res.headers['content-type'], /text\/html/, target)
    assert.equal(res.headers['cache-control'], 'no-cache', target)
  }
  const asset = await request(ro.port, { path: '/assets/app-abc123.js', headers: host })
  assert.equal(asset.status, 200)
  assert.match(asset.headers['content-type'], /text\/javascript/)
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable')

  // An unhashed first-party file must stay revalidated or it can never be updated.
  const boot = await request(ro.port, { path: '/boot-theme.js', headers: host })
  assert.equal(boot.status, 200)
  assert.equal(boot.headers['cache-control'], 'no-cache')

  const missing = await request(ro.port, { path: '/assets/nope.css', headers: host })
  assert.equal(missing.status, 404)
})

test('static: traversal and symlink escape cannot leave the asset root', async () => {
  const host = { host: `127.0.0.1:${ro.port}` }
  const secret = fs.readFileSync(SECRET, 'utf8').trim()

  // Symlink escape — the only one that normalizes and joins cleanly.
  const symlinked = await request(ro.port, { path: '/escape.js', headers: host })
  assert.equal(symlinked.status, 403, symlinked.body)
  assert.equal(symlinked.json.error.code, 'forbidden')
  assert.ok(!symlinked.body.includes(secret))

  for (const target of [
    '/../outside-secret.txt',
    '/%2e%2e/outside-secret.txt',
    '/a/%2e%2e/%2e%2e/outside-secret.txt',
    '/%2e%2e%2f%2e%2e%2foutside-secret.txt',
    '/..%2f..%2foutside-secret.txt',
    '/%252e%252e%252foutside-secret.txt',
    `/${encodeURIComponent(SECRET)}`,
  ]) {
    const res = await request(ro.port, { path: target, headers: host });
    assert.ok(res.status === 403 || res.status === 404, `${target} → ${res.status}`)
    assert.ok(!res.body.includes(secret), `${target} leaked the secret`)
  }

  const nul = await request(ro.port, { path: '/index%00.html', headers: host })
  assert.equal(nul.status, 400)
})

test('static: non-GET/HEAD is 405', async () => {
  const res = await request(ro.port, { method: 'POST', path: '/', headers: { host: `127.0.0.1:${ro.port}` } })
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
})

// ---- headers on every response (§7.1.4) -------------------------------------------

test('security headers are present on every response, success and refusal alike', async () => {
  const responses = [
    await request(ro.port, { path: '/healthz', headers: { host: `127.0.0.1:${ro.port}` } }),           // 200 no-auth
    await request(ro.port, { path: '/api/session', headers: auth(ro) }),                               // 200 api
    await request(ro.port, { path: '/api/session', headers: { host: 'evil:1' } }),                     // 403 host
    await request(ro.port, { path: '/api/session', headers: { host: `127.0.0.1:${ro.port}` } }),       // 401
    await request(ro.port, { path: '/api/nope', headers: auth(ro) }),                                  // 404
    await request(ro.port, { path: '/', headers: { host: `127.0.0.1:${ro.port}` } }),                   // 200 static
    await request(ro.port, { path: '/escape.js', headers: { host: `127.0.0.1:${ro.port}` } }),          // 403 static
    await request(ro.port, { path: '/api/session', setHost: false }),                                   // 403 absent Host
    await request(ro.port, { method: 'POST', path: '/', headers: { host: `127.0.0.1:${ro.port}` } }),    // 405 static
  ]
  for (const res of responses) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(res.headers[name], value, `${name} on ${res.status}`)
    }
    assert.ok(!('access-control-allow-origin' in res.headers), 'no CORS headers anywhere')
  }
  // The CSP must be the buildable one from §7.1.4 — no 'unsafe-inline', no nonces.
  const csp = responses[0].headers['content-security-policy']
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.ok(!csp.includes('unsafe-inline'))
  assert.ok(!csp.includes('nonce-'))
  // 'unsafe-hashes' would extend the one hash below to `style=` attributes, which §7.1.4
  // bans outright. The hash is for `<style>` ELEMENTS and must stay that narrow.
  assert.ok(!csp.includes('unsafe-hashes'))

  // §7.1.4's single hash allowance: react-aria's `usePreventScroll` modal rule, and only
  // it. `viewer/src/ui/preventScrollStyle.ts` is the source of truth — its own vitest
  // checks that constant against the bytes a real modal injects on an iOS platform, so
  // this assertion is what carries that proof through to the policy actually served. A
  // react-aria bump that reformats the rule fails there; a policy that stops covering it
  // fails here. Read as text on purpose: the server may not import from viewer/src.
  const preventScroll = fs.readFileSync(
    path.join(ROOT, 'viewer/src/ui/preventScrollStyle.ts'), 'utf8')
  const declared = preventScroll.match(/PREVENT_SCROLL_STYLE_HASH = '(sha256-[^']+)'/)
  assert.ok(declared, 'viewer/src/ui/preventScrollStyle.ts must export the CSP hash')
  assert.ok(csp.includes(`style-src 'self' '${declared[1]}'`),
    `style-src must admit ${declared[1]} and nothing else — got: ${csp}`)
  assert.equal((csp.match(/sha256-/g) ?? []).length, 1,
    'exactly one hash source is authorized (§7.1.4)')
})

test('API responses are no-store', async () => {
  for (const target of ['/api/session', '/api/nope', '/healthz']) {
    const res = await request(ro.port, { path: target, headers: auth(ro) })
    assert.equal(res.headers['cache-control'], 'no-store', target)
  }
})

test('W6 read routes serve bounded data, audit args reads, and set download/no-store headers', async () => {
  const listed = await request(ro.port, { path: '/api/runs?limit=200&q=http-read', headers: auth(ro) })
  assert.equal(listed.status, 200, listed.body)
  assert.deepEqual(listed.json.runs.map((run) => run.runId), [READ_RUN_ID])

  const detail = await request(ro.port, { path: `/api/runs/${READ_RUN_ID}`, headers: auth(ro) })
  assert.equal(detail.status, 200, detail.body)
  assert.equal(detail.json.hasArgs, true)
  assert.equal('args' in detail.json, false)
  assert.equal(detail.headers['cache-control'], 'no-store')

  const withArgs = await request(ro.port, { path: `/api/runs/${READ_RUN_ID}?include=args`, headers: auth(ro) })
  assert.equal(withArgs.status, 200, withArgs.body)
  assert.deepEqual(withArgs.json.args, { secret: 'visible-by-audit' })
  const audit = fs.readFileSync(path.join(HOME, 'viewer-audit.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(audit.some((line) => line.op === 'args-read' && line.runId === READ_RUN_ID && line.outcome === 'success'))

  const result = await request(ro.port, { path: `/api/runs/${READ_RUN_ID}/result`, headers: auth(ro) })
  assert.deepEqual(result.json.result, { ok: true })
  const agentResult = await request(ro.port, { path: `/api/runs/${READ_RUN_ID}/agents/0/result`, headers: auth(ro) })
  assert.equal(agentResult.json.result, 'agent-result')
  const transcript = await request(ro.port, { path: `/api/runs/${READ_RUN_ID}/agents/0/page?from=0&maxBytes=1024`, headers: auth(ro) })
  assert.equal(transcript.json.items[0].rec.text, 'needle transcript')
  const events = await request(ro.port, { path: `/api/runs/${READ_RUN_ID}/events/page?from=0&maxBytes=4096`, headers: auth(ro) })
  assert.ok(events.json.items.length >= 3)
  const search = await request(ro.port, { path: `/api/runs/${READ_RUN_ID}/search?q=needle&limit=200`, headers: auth(ro) })
  assert.equal(search.json.matches[0].agent, 0)

  const rawResult = await request(ro.port, { path: `/api/runs/${READ_RUN_ID}/result/raw`, headers: auth(ro) })
  assert.equal(rawResult.status, 200)
  assert.equal(rawResult.headers['content-type'], 'application/json')
  assert.equal(rawResult.headers['content-disposition'], 'attachment')
  assert.equal(rawResult.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(rawResult.body).result, { ok: true })
})

test('W6 read routes map validation, missing pages, and search conflicts at HTTP level', async () => {
  for (const target of [
    '/api/runs?limit=201',
    `/api/runs/${READ_RUN_ID}?include=secrets`,
    `/api/runs/${READ_RUN_ID}/search?q=x`,
    `/api/runs/${READ_RUN_ID}/search?q=needle&limit=201`,
    `/api/runs/${READ_RUN_ID}/events/page?from=03`,
    `/api/runs/${READ_RUN_ID}/events/page?maxBytes=${8 * 1024 * 1024 + 1}`,
  ]) {
    const res = await request(ro.port, { path: target, headers: auth(ro) })
    assert.equal(res.status, 400, `${target}: ${res.body}`)
    assert.equal(res.json.error.code, 'bad_request', target)
    assert.equal(res.headers['cache-control'], 'no-store', target)
  }

  for (const target of [
    `/api/runs/${READ_RUN_ID}/agents/99/page`,
    `/api/runs/${READ_RUN_ID}/agents/99/result`,
    `/api/runs/missing-run/events/page`,
    `/api/runs/missing-run/result/raw`,
  ]) {
    const res = await request(ro.port, { path: target, headers: auth(ro) })
    assert.equal(res.status, 404, `${target}: ${res.body}`)
    assert.equal(res.json.error.code, 'not_found', target)
  }

  const target = `/api/runs/${SEARCH_RUN_ID}/search?q=absent`
  const wire = await raw(ro.port,
    `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\nAuthorization: Bearer ${ro.token}\r\nConnection: keep-alive\r\n\r\n`
    + `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\nAuthorization: Bearer ${ro.token}\r\nConnection: close\r\n\r\n`,
    500)
  const statuses = [...wire.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]))
  assert.deepEqual(statuses, [200, 409], wire.slice(0, 1000))
  assert.match(wire, /"code":"conflict"/)
})

// ---- logging (§7.1.7) -------------------------------------------------------------

test('access log lines carry method, path-without-query, status, ms — never a token', async () => {
  const lines = []
  const logged = await startViewer({ port: 0, distRoot: DIST, accessLog: (line) => lines.push(line) })
  try {
    await request(logged.port, { path: `/api/runs/flo_x/stream?token=${logged.token}&cursor=v1;e=1`, headers: { host: `127.0.0.1:${logged.port}` } })
    await request(logged.port, { path: '/api/session', headers: { host: `127.0.0.1:${logged.port}`, authorization: `Bearer ${logged.token}` } })
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(lines.length >= 2, lines.join('\n'))
    for (const line of lines) {
      assert.ok(!line.includes(logged.token), `token leaked into a log line: ${line}`)
      assert.ok(!line.includes('?'), `query string leaked into a log line: ${line}`)
      assert.match(line, /^(GET|HEAD|POST|PUT|DELETE) \/\S* \d{3} \d+ms$/, line)
    }
  } finally {
    await logged.close()
  }
})

test('a 500 never leaks internals, and refusals never echo the token', async () => {
  const boom = await startViewer({
    port: 0,
    distRoot: DIST,
    handlers: { session: () => { throw new Error(`secret path ${HOME}/viewer.token`) } },
    onInternalError: () => {},
  })
  try {
    const res = await request(boom.port, { path: '/api/session', headers: auth(boom) })
    assert.equal(res.status, 500)
    assert.deepEqual(res.json, { error: { code: 'internal', message: 'internal error' } })
    assert.ok(!res.body.includes(HOME))
  } finally {
    await boom.close()
  }
})

test('the internal-error diagnostic handed to the host carries no credential', async () => {
  // §7.1.7: the token never enters a log line. `onInternalError` IS a log line — the CLI
  // prints `err.message` to stderr — so an unexpected throw whose message happened to
  // interpolate the token, the control token, or a `?token=` URL must reach the host
  // redacted. The token is a bearer credential for the whole /api surface; a stack trace
  // in a scrollback buffer is a credible way to lose it.
  const seen = []
  const boom = await startViewer({
    port: 0,
    distRoot: DIST,
    control: true,
    onInternalError: (err) => seen.push(`${err?.message}\n${err?.stack}`),
    handlers: {
      session: (ctx) => {
        throw new Error(`upstream failed for /api/runs?token=${ctx.token}&c=${ctx.controlToken} (bearer ${ctx.token}, control ${ctx.controlToken})`)
      },
    },
  })
  try {
    const res = await request(boom.port, { path: '/api/session', headers: auth(boom) })
    assert.equal(res.status, 500)
    assert.equal(seen.length, 1)
    assert.ok(!seen[0].includes(boom.token), `the read token reached the host diagnostic: ${seen[0]}`)
    assert.ok(!seen[0].includes(boom.controlToken), `the control token reached the host diagnostic: ${seen[0]}`)
    assert.match(seen[0], /upstream failed/, 'the diagnostic is still useful')
    assert.match(seen[0], /\[redacted\]/)
  } finally {
    await boom.close()
  }
})

/**
 * A raw request, so the four node paths that never reach a handler can be exercised.
 * Resolves on close, or once the response has gone quiet — a keep-alive response would
 * otherwise hold the socket open for the server's whole keep-alive timeout.
 */
const raw = (port, bytes, idleMs = 60) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes))
  let data = ''
  let timer = null
  const done = () => { clearTimeout(timer); socket.destroy(); resolve(data) }
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    data += chunk
    clearTimeout(timer)
    timer = setTimeout(done, idleMs)
  })
  socket.on('close', () => { clearTimeout(timer); resolve(data) })
  socket.on('error', (err) => { clearTimeout(timer); reject(err) })
})

/** Split a raw response into its (possibly multiple) message heads plus the final body. */
function parseRaw(response) {
  const [head, ...rest] = response.split('\r\n\r\n')
  return { head, body: rest.join('\r\n\r\n'), status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]) }
}

const hasSecurityHeaders = (head) => Object.entries(SECURITY_HEADERS)
  .every(([name, value]) => head.toLowerCase().includes(`${name}: ${value.toLowerCase()}`))

test('parser-level refusals carry the §5.2 envelope and the security headers', async () => {
  // Bad framing, an invalid method, an oversize header block: node answers these itself,
  // on the raw socket, before any handler — with a bare status line and no CSP. §7.1.4
  // says "every response", so the server owns `clientError`.
  const raw = (bytes) => new Promise((resolve, reject) => {
    const socket = net.connect(ro.port, '127.0.0.1', () => socket.write(bytes))
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { data += chunk })
    socket.on('close', () => resolve(data))
    socket.on('error', reject)
  })

  for (const [label, bytes, status] of [
    ['invalid method', `BOGUS!! /api/session HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\n\r\n`, 400],
    ['invalid header token', `GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\nX-Bad\x01Name: 1\r\n\r\n`, 400],
    ['header block over the cap', `GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\nX-Big: ${'x'.repeat(80_000)}\r\n\r\n`, 431],
  ]) {
    const response = await raw(bytes)
    const [head, body] = response.split('\r\n\r\n')
    assert.match(head, new RegExp(`^HTTP/1\\.1 ${status} `), `${label}: ${head}`)
    assert.deepEqual(JSON.parse(body).error.code, status === 431 ? 'payload_too_large' : 'bad_request', label)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.ok(head.toLowerCase().includes(`${name}: ${value.toLowerCase()}`), `${label} is missing ${name}`)
    }
    assert.ok(!response.includes(ro.token), label)
  }
})

// ---- the node paths that never reach a request handler (§7.1.4 "every response") ----
//
// `request` and `clientError` are only two of node's five ways in. `checkExpectation`
// answers a bare 417 from `_http_server`, `connect` and `upgrade` destroy the socket with
// no response at all, and `checkContinue` writes `100 Continue` *before* any gate has run.
// Each of those is a request that bypasses the Host allowlist, token auth and the exact-
// status method matrix — so the server owns all five.

test('an unsupported Expect is refused through the pipeline, after Host and auth', async () => {
  // A hostile Host plus an unsupported Expect is a HOST failure: the gate order in §7.1.3
  // ("before routing") must not be reordered by which node event delivered the request.
  const hostile = parseRaw(await raw(ro.port, `GET /api/session HTTP/1.1\r\nHost: evil.example.com\r\nExpect: 200-ok\r\n\r\n`))
  assert.equal(hostile.status, 403, hostile.head)
  assert.equal(JSON.parse(hostile.body).error.code, 'forbidden')
  assert.match(JSON.parse(hostile.body).error.message, /host not allowed/)
  assert.ok(hasSecurityHeaders(hostile.head), hostile.head)

  // Right Host, no token: still 401 before anything is said about the Expect.
  const anon = parseRaw(await raw(ro.port, `GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\nExpect: 200-ok\r\n\r\n`))
  assert.equal(anon.status, 401, anon.head)
  assert.equal(JSON.parse(anon.body).error.code, 'unauthorized')
  assert.ok(hasSecurityHeaders(anon.head))

  // Authenticated: now the Expect itself is the refusal — 417 in the §5.2 envelope with
  // the full header set, not node's bare status line.
  const authed = parseRaw(await raw(ro.port, `GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\nAuthorization: Bearer ${ro.token}\r\nExpect: 200-ok\r\n\r\n`))
  assert.equal(authed.status, 417, authed.head)
  assert.equal(JSON.parse(authed.body).error.code, 'bad_request')
  assert.match(JSON.parse(authed.body).error.message, /Expect/)
  assert.ok(hasSecurityHeaders(authed.head), authed.head)
  assert.ok(!authed.head.includes(ro.token) && !authed.body.includes(ro.token))

  // A static route and /healthz take the same path.
  for (const target of ['/', '/healthz']) {
    const res = parseRaw(await raw(ro.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\nExpect: 200-ok\r\n\r\n`))
    assert.equal(res.status, 417, `${target}: ${res.head}`)
    assert.ok(hasSecurityHeaders(res.head), target)
  }
})

test('Expect: 100-continue gets its 100 only once every gate has passed', async () => {
  const body = JSON.stringify({ agent: 0, message: 'steer' })
  const post = (port, headers) => raw(port, `POST /api/runs/flo_abc/send HTTP/1.1\r\n${headers}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nExpect: 100-continue\r\n\r\n${body}`)

  // Read-only server: the mutation is 403, and the client is never invited to send.
  const refused = await post(ro.port, `Host: 127.0.0.1:${ro.port}\r\nAuthorization: Bearer ${ro.token}\r\nOrigin: http://127.0.0.1:${ro.port}\r\ncontent-type: application/json`)
  assert.ok(!refused.includes('100 Continue'), `a refused mutation must never be invited to send its body:\n${refused}`)
  assert.equal(parseRaw(refused).status, 403)
  assert.equal(JSON.parse(parseRaw(refused).body).error.code, 'forbidden')

  // Hostile Host: the Host gate still wins over node's own pre-gate 100 Continue.
  const rebound = await post(ro.port, `Host: evil.example.com\r\nAuthorization: Bearer ${ro.token}`)
  assert.ok(!rebound.includes('100 Continue'), rebound)
  assert.equal(parseRaw(rebound).status, 403)

  // Over the body cap: refused on the declared length, before the invitation.
  const huge = await raw(rw.port, `POST /api/runs/flo_abc/send HTTP/1.1\r\nHost: 127.0.0.1:${rw.port}\r\nAuthorization: Bearer ${rw.token}\r\nOrigin: http://127.0.0.1:${rw.port}\r\ncontent-type: application/json\r\nx-flowition-control: ${rw.controlToken}\r\ncontent-length: ${MAX_BODY_BYTES + 1}\r\nExpect: 100-continue\r\n\r\n`)
  assert.ok(!huge.includes('100 Continue'), huge)
  assert.equal(parseRaw(huge).status, 413)

  // Fully authorized: the 100 is written, the body is read, and the route answers.
  const allowed = await post(rw.port, `Host: 127.0.0.1:${rw.port}\r\nAuthorization: Bearer ${rw.token}\r\nOrigin: http://127.0.0.1:${rw.port}\r\ncontent-type: application/json\r\nx-flowition-control: ${rw.controlToken}`)
  assert.match(allowed, /^HTTP\/1\.1 100 Continue/, allowed)
  const final = parseRaw(allowed.split('\r\n\r\n').slice(1).join('\r\n\r\n'))
  assert.equal(final.status, 404, allowed)   // W7's handler ran; `flo_abc` is not a run
  assert.ok(hasSecurityHeaders(final.head), allowed)
})

test('CONNECT and Upgrade answer with the envelope instead of a destroyed socket', async () => {
  // Node destroys the socket for both when nothing listens: no 405, no headers, nothing.
  const tunnel = parseRaw(await raw(ro.port, `CONNECT /api/session HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\nAuthorization: Bearer ${ro.token}\r\n\r\n`))
  assert.equal(tunnel.status, 405, tunnel.head || '(socket closed with no response)')
  assert.equal(JSON.parse(tunnel.body).error.code, 'bad_request')
  assert.match(tunnel.head, /allow: GET, HEAD/i, tunnel.head)
  assert.ok(hasSecurityHeaders(tunnel.head), tunnel.head)

  // Host first here too: a rebound CONNECT never learns whether its token is valid.
  const hostile = parseRaw(await raw(ro.port, `CONNECT /api/session HTTP/1.1\r\nHost: evil.example.com\r\nAuthorization: Bearer ${ro.token}\r\n\r\n`))
  assert.equal(hostile.status, 403, hostile.head || '(socket closed with no response)')
  assert.match(JSON.parse(hostile.body).error.message, /host not allowed/)
  assert.ok(hasSecurityHeaders(hostile.head))

  // ...and unauthenticated CONNECT is 401, like every other /api request.
  const anon = parseRaw(await raw(ro.port, `CONNECT /api/runs HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\n\r\n`))
  assert.equal(anon.status, 401, anon.head || '(socket closed with no response)')

  // An upgrade attempt on a read route: refused, with headers, never dispatched.
  const upgrade = parseRaw(await raw(ro.port, `GET /api/session HTTP/1.1\r\nHost: 127.0.0.1:${ro.port}\r\nAuthorization: Bearer ${ro.token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`))
  assert.equal(upgrade.status, 400, upgrade.head || '(socket closed with no response)')
  assert.equal(JSON.parse(upgrade.body).error.code, 'bad_request')
  assert.match(JSON.parse(upgrade.body).error.message, /upgrade/i)
  assert.ok(hasSecurityHeaders(upgrade.head), upgrade.head)
  assert.ok(!upgrade.body.includes(ro.token))
})

// ---- the built SPA (§4.6 packaging, critique B1) -----------------------------------

test('viewer/dist is committed and shipped in package.json#files (§4.6)', () => {
  // §4.6 is a DECISION: `viewer/dist/**` is committed and added to the root files list, so
  // `npm i -g flowition` is zero-install-cost. Skipping this when dist is absent is how an
  // installed package ends up shipping a server with no SPA — the local half of the W14
  // rebuild-and-compare gate has to be a failure, not a skip.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('viewer/dist'), 'package.json#files must include viewer/dist')
  const dist = path.join(ROOT, 'viewer', 'dist')
  assert.ok(fs.statSync(dist).isDirectory(), 'viewer/dist must be committed')
  assert.ok(fs.existsSync(path.join(dist, 'index.html')))
  assert.ok(fs.existsSync(path.join(dist, 'boot-theme.js')), '§7.1.4 pins the theme bootstrap as a separate first-party file')
})

test('viewer/dist carries no inline script or style (CSP script-src self)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'viewer', 'dist', 'index.html'), 'utf8')
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script> in dist/index.html would be blocked by the CSP')
  assert.ok(!/<style[\s>]/i.test(html), 'inline <style> in dist/index.html would be blocked by the CSP')
  assert.ok(!/\sstyle=/i.test(html), 'a style= attribute in dist/index.html would be blocked by the CSP')
})

test('the committed viewer/dist is actually servable through the pipeline', async () => {
  // Not just "the files exist": the shipped assets go through §5.8's resolution, get the
  // §7.1.4 headers, and boot without a token (the SPA renders the paste-token screen).
  const shipped = await startViewer({ port: 0 })
  try {
    for (const [target, type] of [
      ['/', 'text/html; charset=utf-8'],
      ['/index.html', 'text/html; charset=utf-8'],
      ['/boot-theme.js', 'text/javascript; charset=utf-8'],
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/app.css', 'text/css; charset=utf-8'],
      ['/run/flo_abc', 'text/html; charset=utf-8'],   // a hash-router deep link
    ]) {
      const res = await request(shipped.port, { path: target, headers: { host: `127.0.0.1:${shipped.port}` } })
      assert.equal(res.status, 200, target)
      assert.equal(res.headers['content-type'], type, target)
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[name], value, `${target} ${name}`)
    }
  } finally {
    await shipped.close()
  }
})
