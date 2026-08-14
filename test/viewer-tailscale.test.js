// §7.1.8 — `--tailscale-origin`: the tailnet path through the viewer's gates.
//
// The contract under test: the viewer stays bound to 127.0.0.1 and Tailscale Serve is
// the only sanctioned way in from the tailnet. The flag extends the closed Host set by
// exactly one validated `*.ts.net` authority, maps it to its `https://` origin, refuses
// Funnel traffic outright, and demands TLS-ingress provenance (X-Forwarded-Proto) for
// the proxied authority. Without the flag, every assertion in viewer-http.test.js holds
// byte-for-byte — the regression tests here pin that.
//
// Like viewer-http.test.js, requests go through node:http, never fetch/undici: Host,
// Origin and X-Forwarded-Proto are exactly the headers a fetch-based test cannot set.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-tailscale-'))
process.env.FLOWITION_HOME = HOME

const viewer = await import('../src/viewer/index.js')
const { parseTailscaleOrigin, expectedOriginFor, FUNNEL_HEADER } = await import('../src/viewer/http.js')

// ---- fixtures --------------------------------------------------------------------

const DIST = path.join(HOME, 'dist')
fs.mkdirSync(DIST, { recursive: true })
fs.writeFileSync(path.join(DIST, 'index.html'), '<!doctype html><title>flowition</title>')

const TS_ORIGIN = 'https://mymac.tail1234.ts.net'
const TS_HOST = 'mymac.tail1234.ts.net'

/** A free fixed port: bind ephemeral, read the number, release it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
    probe.on('error', reject)
  })
}

function request(port, { method = 'GET', path: target = '/', headers = {}, body, setHost = true } = {}) {
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

let ts     // tailscale-enabled viewer with every capability
let plain  // default viewer — the no-flag regression fixture
/** Headers for a request that arrived through tailscale serve, as serve would set them. */
const viaServe = (extra = {}) => ({ host: TS_HOST, 'x-forwarded-proto': 'https', authorization: `Bearer ${ts.token}`, ...extra })
const tsMutate = (extra = {}) => viaServe({
  origin: TS_ORIGIN,
  'content-type': 'application/json',
  'x-flowition-control': ts.controlToken,
  ...extra,
})

before(async () => {
  ts = await viewer.startViewer({ port: await freePort(), tailscaleOrigin: TS_ORIGIN, control: true, distRoot: DIST })
  plain = await viewer.startViewer({ port: 0, distRoot: DIST })
  // See viewer-http.test.js: unref lets node:test's beforeExit-driven runner finish.
  ts.unref()
  plain.unref()
})
after(async () => {
  await ts?.close()
  await plain?.close()
})

// ---- parseTailscaleOrigin ----------------------------------------------------------

test('parseTailscaleOrigin: accepts exactly the https *.ts.net origins, canonicalized', () => {
  assert.deepEqual(parseTailscaleOrigin('https://mymac.tail1234.ts.net'), { origin: 'https://mymac.tail1234.ts.net', host: 'mymac.tail1234.ts.net' })
  // :443 is the default port — elided from both the canonical origin and the Host a
  // browser sends, so the gate and the browser agree.
  assert.deepEqual(parseTailscaleOrigin('https://mymac.tail1234.ts.net:443'), { origin: 'https://mymac.tail1234.ts.net', host: 'mymac.tail1234.ts.net' })
  // A nonstandard serve port stays in both.
  assert.deepEqual(parseTailscaleOrigin('https://mymac.tail1234.ts.net:8443'), { origin: 'https://mymac.tail1234.ts.net:8443', host: 'mymac.tail1234.ts.net:8443' })
  // DNS names are case-insensitive; the parser canonicalizes to lowercase.
  assert.deepEqual(parseTailscaleOrigin('https://MyMac.Tail1234.TS.NET'), { origin: 'https://mymac.tail1234.ts.net', host: 'mymac.tail1234.ts.net' })
  // A trailing slash is the same origin (URL.pathname === '/').
  assert.equal(parseTailscaleOrigin('https://mymac.tail1234.ts.net/').origin, 'https://mymac.tail1234.ts.net')
})

test('parseTailscaleOrigin: refuses everything that is not a tailscale serve origin', () => {
  for (const value of [
    'http://mymac.tail1234.ts.net',              // plaintext
    'https://example.com',                       // not tailscale — a generic proxy is not the contract
    'https://ts.net',                            // the bare suffix is nobody's machine
    'https://mymac.tail1234.ts.net.evil.com',    // suffix-lookalike
    'https://mymac.tail1234.ts.net/path',        // no path
    'https://mymac.tail1234.ts.net/?q=1',        // no query
    'https://mymac.tail1234.ts.net/#frag',       // no fragment
    'https://user:pw@mymac.tail1234.ts.net',     // no credentials
    'https://100.64.0.1',                        // no bare IPs
    'mymac.tail1234.ts.net',                     // scheme required
    'https://.ts.net',                           // empty label — no MagicDNS name has one
    'https://foo..ts.net',                       // ditto, mid-name
    'https://under_score.tail1234.ts.net',       // underscores are not DNS hostnames
    'https://-dash.tail1234.ts.net',             // labels never start or end with a hyphen
    'https://dash-.tail1234.ts.net',
    'https://mymac.tail1234.ts.net:0',           // port 0 is not a listenable authority
    'https://@mymac.tail1234.ts.net',            // EMPTY userinfo — invisible to url.username
    'https://mymac.tail1234.ts.net?',            // empty query delimiter — url.search is ''
    'https://mymac.tail1234.ts.net#',            // empty fragment delimiter — url.hash is ''
    `https://${'a'.repeat(64)}.ts.net`,          // a DNS label caps at 63 octets
    `https://${(`${'a'.repeat(63)}.`).repeat(4)}ts.net`,  // and a name at 253
    '', true, undefined, 42,                     // not even a string value
  ]) {
    assert.throws(() => parseTailscaleOrigin(value), /--tailscale-origin/, JSON.stringify(value))
  }
})

test('expectedOriginFor: one canonical host→origin map, loopback byte-exact, tailscale case-insensitive', () => {
  const tailscale = { origin: TS_ORIGIN, host: TS_HOST }
  assert.equal(expectedOriginFor('127.0.0.1:4646', 4646, tailscale), 'http://127.0.0.1:4646')
  assert.equal(expectedOriginFor(TS_HOST, 4646, tailscale), TS_ORIGIN)
  assert.equal(expectedOriginFor('MyMac.Tail1234.TS.NET', 4646, tailscale), TS_ORIGIN)
  assert.equal(expectedOriginFor(`${TS_HOST}:8443`, 4646, tailscale), null)   // wrong authority
  assert.equal(expectedOriginFor(TS_HOST, 4646, null), null)                  // flag off → closed trio only
  assert.equal(expectedOriginFor('LOCALHOST:4646', 4646, tailscale), null)    // loopback stays byte-exact
})

test('viewerUrl: the origin parameter swaps the authority, fragment credentials unchanged', () => {
  assert.equal(viewer.viewerUrl({ port: 1234, token: 'tok' }), 'http://127.0.0.1:1234/#/?t=tok')
  assert.equal(viewer.viewerUrl({ port: 1234, token: 'tok', origin: TS_ORIGIN }), `${TS_ORIGIN}/#/?t=tok`)
  assert.equal(viewer.viewerUrl({ port: 1234, token: 'tok', controlToken: 'ctl', origin: TS_ORIGIN }), `${TS_ORIGIN}/#/?t=tok&c=ctl`)
})

// ---- the tailnet request path (§7.1.8) ----------------------------------------------

test('tailscale host: accepted with TLS provenance, on reads, static and healthz', async () => {
  const api = await request(ts.port, { path: '/api/session', headers: viaServe(), setHost: false })
  assert.equal(api.status, 200)

  const index = await request(ts.port, { path: '/', headers: { host: TS_HOST, 'x-forwarded-proto': 'https' }, setHost: false })
  assert.equal(index.status, 200)
  assert.match(index.body, /flowition/)

  const health = await request(ts.port, { path: '/healthz', headers: { host: TS_HOST, 'x-forwarded-proto': 'https' }, setHost: false })
  assert.equal(health.status, 200)
})

test('tailscale host: the Host comparison is case-insensitive, the port part is not elective', async () => {
  const upper = await request(ts.port, { path: '/api/session', headers: viaServe({ host: 'MyMac.Tail1234.TS.NET' }), setHost: false })
  assert.equal(upper.status, 200)

  // The right name on the wrong authority (a port the origin does not carry) is not ours.
  const wrongPort = await request(ts.port, { path: '/api/session', headers: viaServe({ host: `${TS_HOST}:8443` }), setHost: false })
  assert.equal(wrongPort.status, 403)
  assert.match(wrongPort.json.error.message, /host not allowed/)
})

test('tailscale host: refused without https TLS provenance (X-Forwarded-Proto)', async () => {
  for (const headers of [
    viaServe({ 'x-forwarded-proto': undefined }),           // absent — a direct plaintext hit on the name
    viaServe({ 'x-forwarded-proto': 'http' }),              // a plaintext proxy hop
    viaServe({ 'x-forwarded-proto': 'https, http' }),       // a second, unstripped proxy layer
    viaServe({ 'x-forwarded-proto': 'HTTPS' }),             // byte-exact: serve writes the literal "https"
    // (` https` is not a case: RFC 9110 OWS around a field value is stripped by
    // node's HTTP parser before the value exists, so it arrives as `https`.)
  ]) {
    const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined))
    // The gate precedes routing, so it holds for static, API and SSE paths alike.
    for (const target of ['/api/session', '/', '/api/runs/some-run/stream']) {
      const res = await request(ts.port, { path: target, headers: clean, setHost: false })
      assert.equal(res.status, 403, `${JSON.stringify(clean['x-forwarded-proto'])} on ${target}`)
      assert.match(res.json.error.message, /TLS ingress/)
      assert.ok(!res.body.includes(ts.token))
    }
  }
  // Loopback requests never need provenance — the flag must not break local use.
  const local = await request(ts.port, { path: '/api/session', headers: { host: `127.0.0.1:${ts.port}`, authorization: `Bearer ${ts.token}` } })
  assert.equal(local.status, 200)
})

test('funnel traffic is refused on every path, before the Host gate', async () => {
  for (const [host, value] of [
    [TS_HOST, '?1'],                       // funnel as tailscale sends it
    [TS_HOST, ''],                         // any defined value counts, not just ?1
    [`127.0.0.1:${ts.port}`, '?1'],        // even on the loopback authority
  ]) {
    // Every routing family: health, static SPA, plain API, and the SSE route — the
    // gate precedes dispatch, and this pins that it stays there.
    for (const target of ['/healthz', '/', '/api/session', '/api/runs/some-run/stream']) {
      const res = await request(ts.port, {
        path: target,
        headers: { host, 'x-forwarded-proto': 'https', [FUNNEL_HEADER]: value },
        setHost: false,
      })
      assert.equal(res.status, 403, `${host} + funnel "${value}" on ${target}`)
      assert.match(res.json.error.message, /funnel/i)
    }
  }
  // Precedence: funnel + a hostile Host still answers the funnel refusal (both are 403
  // forbidden; the message proves which gate fired first).
  const both = await request(ts.port, { path: '/healthz', headers: { host: 'evil.example.com', [FUNNEL_HEADER]: '?1' }, setHost: false })
  assert.equal(both.status, 403)
  assert.match(both.json.error.message, /funnel/i)
})

test('origin: each authority admits exactly its own origin — no cross-pairs', async () => {
  const cases = [
    // [host, origin, expected status]
    [TS_HOST, TS_ORIGIN, 200],                              // the one legal tailnet pair
    [TS_HOST, `http://${TS_HOST}`, 403],                    // scheme reflection is not the origin
    [TS_HOST, `http://127.0.0.1:${ts.port}`, 403],          // loopback origin on the tailnet authority
    [TS_HOST, 'https://other.tail1234.ts.net', 403],        // another tailnet machine
    [`127.0.0.1:${ts.port}`, TS_ORIGIN, 403],               // tailnet origin on the loopback authority
    [`127.0.0.1:${ts.port}`, `http://127.0.0.1:${ts.port}`, 200],
  ]
  for (const [host, origin, expected] of cases) {
    const res = await request(ts.port, {
      path: '/api/session',
      headers: { host, origin, 'x-forwarded-proto': 'https', authorization: `Bearer ${ts.token}` },
      setHost: false,
    })
    assert.equal(res.status, expected, `Host ${host} × Origin ${origin}`)
    if (expected === 403) assert.match(res.json.error.message, /origin not allowed/)
  }
})

test('mutations pass the full gate chain from the tailnet origin', async () => {
  // Every §7.1.5/§7.2 gate satisfied over the proxied authority: the request reaches the
  // route (404 for the unknown run), it is not refused by host/origin/token/control.
  const ok = await request(ts.port, { method: 'POST', path: '/api/runs/flo_nope/cancel', headers: tsMutate(), body: '{}' })
  assert.equal(ok.status, 404, ok.body)

  // And the chain still refuses each missing piece, from the tailnet exactly as locally.
  const noOrigin = { ...tsMutate() }
  delete noOrigin.origin
  const rNoOrigin = await request(ts.port, { method: 'POST', path: '/api/runs/flo_nope/cancel', headers: noOrigin, body: '{}' })
  assert.equal(rNoOrigin.status, 403)
  assert.match(rNoOrigin.json.error.message, /Origin/)

  const badControl = await request(ts.port, { method: 'POST', path: '/api/runs/flo_nope/cancel', headers: tsMutate({ 'x-flowition-control': 'x'.repeat(43) }), body: '{}' })
  assert.equal(badControl.status, 403)
  assert.match(badControl.json.error.message, /control token/)
})

// ---- the no-flag regression (§7.1.8 "without the flag, nothing changes") -------------

test('without --tailscale-origin: the tailscale host is just another disallowed Host', async () => {
  const res = await request(plain.port, { path: '/api/session', headers: { host: TS_HOST, 'x-forwarded-proto': 'https', authorization: `Bearer ${plain.token}` }, setHost: false })
  assert.equal(res.status, 403)
  // The refusal names the loopback trio only — no tailscale wording leaks into the
  // default posture.
  assert.match(res.json.error.message, /host not allowed — the viewer answers only on 127\.0\.0\.1, localhost or \[::1\]$/)
})

test('without --tailscale-origin: a funnel header is inert', async () => {
  const res = await request(plain.port, { path: '/api/session', headers: { host: `127.0.0.1:${plain.port}`, authorization: `Bearer ${plain.token}`, [FUNNEL_HEADER]: '?1' } })
  assert.equal(res.status, 200)
})

test('the tailscale instance answers its own message with the extended host list', async () => {
  const res = await request(ts.port, { path: '/api/session', headers: { host: 'evil.example.com' }, setHost: false })
  assert.equal(res.status, 403)
  assert.match(res.json.error.message, new RegExp(TS_HOST.replace(/\./g, '\\.')))
})

// ---- startup rules (§7.1.8 fixed port, primary-only) --------------------------------

test('startViewer: --tailscale-origin demands an explicit nonzero port', async () => {
  await assert.rejects(() => viewer.startViewer({ tailscaleOrigin: TS_ORIGIN, distRoot: DIST }), /requires an explicit --port/)
  await assert.rejects(() => viewer.startViewer({ port: 0, tailscaleOrigin: TS_ORIGIN, distRoot: DIST }), /requires an explicit --port/)
})

test('startViewer: a malformed origin is a startup refusal, not a listener', async () => {
  await assert.rejects(() => viewer.startViewer({ port: 4646, tailscaleOrigin: 'https://example.com', distRoot: DIST }), /--tailscale-origin/)
})

test('startViewer: tailscale mode never walks ports — a collision is loud', async () => {
  const port = await freePort()
  const squatter = net.createServer()
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve))
  try {
    await assert.rejects(
      () => viewer.startViewer({ port, tailscaleOrigin: TS_ORIGIN, distRoot: DIST }),
      new RegExp(`${port}–${port}`),   // the candidate list was exactly [port]
    )
  } finally {
    await new Promise((resolve) => squatter.close(resolve))
  }
})

test('startViewer: tailscale mode refuses to run as a secondary', async () => {
  const port = await freePort()
  await assert.rejects(
    () => viewer.startViewer({ port, tailscaleOrigin: TS_ORIGIN, distRoot: DIST, primary: false }),
    /cannot start a secondary viewer/)
})

// ---- rendezvous & reuse policy (§7.1.8 matrix) --------------------------------------

test('the rendezvous record carries the canonical origin; discovery hands it back', async () => {
  // `plain` published after `ts` in before(), so point the record back at ts first.
  viewer.writeRendezvous({ port: ts.port, control: ts.control, tailscaleOrigin: ts.tailscaleOrigin })
  const record = viewer.readRendezvous()
  assert.equal(record.tailscaleOrigin, TS_ORIGIN)

  const found = await viewer.discoverViewer()
  assert.ok(found, 'the live tailscale instance must be discoverable')
  assert.equal(found.tailscaleOrigin, TS_ORIGIN)
  assert.equal(found.port, ts.port)
})

test('reuse: same policy and port reuses; the reuse record carries both URLs', async () => {
  viewer.writeRendezvous({ port: ts.port, control: ts.control, tailscaleOrigin: ts.tailscaleOrigin })
  const reused = await viewer.startOrReuseViewer({ port: ts.port, explicitPort: true, tailscaleOrigin: TS_ORIGIN })
  assert.equal(reused.reused, true)
  assert.equal(reused.port, ts.port)
  assert.equal(reused.url, `http://127.0.0.1:${ts.port}/#/?t=${encodeURIComponent(ts.token)}`)
  assert.equal(reused.tailscaleUrl, `${TS_ORIGIN}/#/?t=${encodeURIComponent(ts.token)}`)
  // Read-only by construction: a reused URL never carries the control token.
  assert.ok(!reused.tailscaleUrl.includes('&c='))
})

test('reuse: every policy mismatch is a loud refusal, never a shadow start', async () => {
  viewer.writeRendezvous({ port: ts.port, control: ts.control, tailscaleOrigin: ts.tailscaleOrigin })

  // Different origin against the live policy.
  await assert.rejects(
    () => viewer.startOrReuseViewer({ port: ts.port, explicitPort: true, tailscaleOrigin: 'https://other.tail1234.ts.net' }),
    /does not match the requested https:\/\/other\.tail1234\.ts\.net/)

  // Different port against the live policy.
  await assert.rejects(
    () => viewer.startOrReuseViewer({ port: ts.port + 1, explicitPort: true, tailscaleOrigin: TS_ORIGIN }),
    /does not match the requested/)

  // No flag against a tailscale instance: absence requests local-only policy.
  await assert.rejects(
    () => viewer.startOrReuseViewer({}),
    /was started with --tailscale-origin/)

  // Same, with an explicit port (the would-be §13.7 secondary): still refused.
  await assert.rejects(
    () => viewer.startOrReuseViewer({ port: ts.port + 1, explicitPort: true }),
    /was started with --tailscale-origin/)

  // A live LOCAL instance against a tailscale request: refused with the stop recipe.
  viewer.writeRendezvous({ port: ts.port, control: ts.control })   // strip the policy
  await assert.rejects(
    () => viewer.startOrReuseViewer({ port: ts.port, explicitPort: true, tailscaleOrigin: TS_ORIGIN }),
    /no tailscale origin/)
})

test('a corrupted recorded origin is never echoed — not in refusals, not in --print-url output', async () => {
  // viewer.json is a same-user 0600 file, but its `tailscaleOrigin` is still re-validated
  // at every output boundary: a value carrying userinfo and control characters must not
  // be reproduced into stderr, a suggested command, or `--print-url`'s stdout — and its
  // corruption must not cost the operator their local viewer.
  const CORRUPT = 'https://user:secret@evil.tail1234.ts.net/\u0007pwn'
  viewer.writeRendezvous({ port: ts.port, control: ts.control, tailscaleOrigin: CORRUPT })
  try {
    // Authenticated discovery still succeeds against the live instance.
    const found = await viewer.discoverViewer()
    assert.ok(found, 'discovery must survive a corrupt policy field')
    assert.equal(found.port, ts.port)

    // A tailscale caller: policy mismatch (corrupt ≠ canonical), described, not echoed.
    const tsErr = await viewer.startOrReuseViewer({ port: ts.port, explicitPort: true, tailscaleOrigin: TS_ORIGIN })
      .then(() => null, (err) => err)
    assert.ok(tsErr, 'a corrupt record must not satisfy a tailscale caller')
    assert.match(tsErr.message, /invalid tailscale origin recorded/)
    assert.ok(!tsErr.message.includes('user:secret') && !tsErr.message.includes('\u0007'), 'the corrupt bytes stay out of the refusal')

    // A plain caller: refused (the record claims tailnet exposure), again without the bytes.
    const plainErr = await viewer.startOrReuseViewer({}).then(() => null, (err) => err)
    assert.ok(plainErr, 'a corrupt tailscale record must not be reused by a local caller')
    assert.match(plainErr.message, /invalid tailscale origin/)
    assert.ok(!plainErr.message.includes('user:secret') && !plainErr.message.includes('\u0007'))

    // --print-url --json degrades to the local URL: no tailnet URL, no origin field, no bytes.
    const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flowition.js')
    const printed = await new Promise((resolve) => {
      execFile(process.execPath, [BIN, 'viewer', '--print-url', '--json'], { env: { ...process.env, FLOWITION_HOME: HOME }, timeout: 30_000 }, (err, stdout, stderr) =>
        resolve({ code: err?.code ?? 0, stdout, stderr }))
    })
    assert.equal(printed.code, 0, printed.stderr)
    const payload = JSON.parse(printed.stdout)
    assert.equal(payload.port, ts.port)
    assert.ok(payload.url.startsWith(`http://127.0.0.1:${ts.port}/#/?t=`))
    assert.ok(!('tailscaleUrl' in payload), 'no URL is built on a corrupt authority')
    assert.ok(!('tailscaleOrigin' in payload), 'the raw record never reaches stdout')
    assert.ok(!printed.stdout.includes('user:secret') && !printed.stderr.includes('user:secret'))
  } finally {
    viewer.writeRendezvous({ port: ts.port, control: ts.control, tailscaleOrigin: ts.tailscaleOrigin })
  }
})

test('reuse: a fresh start through startOrReuseViewer carries the policy end to end', async () => {
  // No live instance: remove the record so discovery finds nothing.
  try { fs.unlinkSync(viewer.rendezvousPath()) } catch { /* absent */ }
  const port = await freePort()
  const started = await viewer.startOrReuseViewer({ port, explicitPort: true, tailscaleOrigin: TS_ORIGIN, distRoot: DIST })
  try {
    assert.equal(started.reused, false)
    assert.equal(started.tailscaleOrigin, TS_ORIGIN)
    assert.equal(started.tailscaleUrl, `${TS_ORIGIN}/#/?t=${encodeURIComponent(started.token)}`)
    assert.equal(viewer.readRendezvous().tailscaleOrigin, TS_ORIGIN)
  } finally {
    await started.close()
    // Restore the shared fixture's record for any later test in this file.
    viewer.writeRendezvous({ port: ts.port, control: ts.control, tailscaleOrigin: ts.tailscaleOrigin })
  }
})

test('the fixed-port invariant holds at startOrReuseViewer too, not only startViewer', async () => {
  // Reuse-without-a-port against a live matching instance would satisfy the flag with
  // "whatever port the instance happens to hold" — a policy tailscale serve cannot
  // follow. The refusal fires before discovery, so it holds with or without a live match.
  viewer.writeRendezvous({ port: ts.port, control: ts.control, tailscaleOrigin: ts.tailscaleOrigin })
  for (const rest of [{}, { port: 0 }, { port: 0, explicitPort: true }]) {
    await assert.rejects(
      () => viewer.startOrReuseViewer({ ...rest, tailscaleOrigin: TS_ORIGIN }),
      /--tailscale-origin requires an explicit --port/, JSON.stringify(rest))
  }
})

test('a type-invalid recorded policy is corruption, not local-only — and is never echoed', async () => {
  // A record whose tailscaleOrigin field is PRESENT but does not hold a nonempty string
  // — a number, an object, "", an explicit null — is the same corruption class as a
  // malformed string (writeRendezvous never writes the key for a local-only instance):
  // it must not collapse into "local-only" (admitting reuse or an explicit-port
  // secondary), and its value must not be echoed.
  const record = () => JSON.parse(fs.readFileSync(viewer.rendezvousPath(), 'utf8'))
  viewer.writeRendezvous({ port: ts.port, control: ts.control, tailscaleOrigin: ts.tailscaleOrigin })
  const base = record()
  try {
    for (const bad of [42, { evilmarker: 'x' }, '', null, false, 0, []]) {
      fs.writeFileSync(viewer.rendezvousPath(), JSON.stringify({ ...base, tailscaleOrigin: bad }), { mode: 0o600 })

      // Discovery still proves the live instance, but the policy surfaces as invalid.
      const found = await viewer.discoverViewer()
      assert.ok(found, `discovery must survive tailscaleOrigin=${JSON.stringify(bad)}`)
      assert.equal(found.tailscaleOrigin, null)
      assert.equal(found.tailscalePolicyInvalid, true)

      // A plain caller is refused — this is NOT a local-only instance it may reuse.
      const plainErr = await viewer.startOrReuseViewer({}).then(() => null, (err) => err)
      assert.ok(plainErr, `tailscaleOrigin=${JSON.stringify(bad)} must refuse a plain caller`)
      assert.match(plainErr.message, /invalid tailscale origin/)
      assert.ok(!plainErr.message.includes('evilmarker'), 'the corrupt value stays out of the refusal')

      // Neither is it the instance a tailscale caller asked for.
      const tsErr = await viewer.startOrReuseViewer({ port: ts.port, explicitPort: true, tailscaleOrigin: TS_ORIGIN })
        .then(() => null, (err) => err)
      assert.ok(tsErr, `tailscaleOrigin=${JSON.stringify(bad)} must refuse a tailscale caller`)
      assert.match(tsErr.message, /invalid tailscale origin recorded/)
      assert.ok(!tsErr.message.includes('evilmarker'))
    }
  } finally {
    viewer.writeRendezvous({ port: ts.port, control: ts.control, tailscaleOrigin: ts.tailscaleOrigin })
  }
})

// ---- `viewer --stop` teardown guidance (§7.1.8) --------------------------------------
//
// --stop signals the recorded pid, so the instance under test cannot live in this
// process — same child-process pattern as viewer-stop.test.js.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BIN = path.join(ROOT, 'bin', 'flowition.js')

const runCli = (args, env = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout, stderr }))
  })

const children = new Set()
after(() => { for (const child of children) { try { child.kill('SIGKILL') } catch { /* gone */ } } })

/** A real tailscale-mode `flowition viewer` in its own process, in its own home. */
async function spawnTailscaleViewer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-ts-stop-'))
  const port = await freePort()
  const child = spawn(process.execPath, [BIN, 'viewer', '--port', String(port), '--tailscale-origin', TS_ORIGIN], {
    env: { ...process.env, FLOWITION_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  let stderr = ''
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`viewer never announced:\n${stderr}`)), 15_000)
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (/viewer: http/.test(stderr)) { clearTimeout(timer); resolve() }
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`viewer exited early (${code}):\n${stderr}`)) })
  })
  return { home, port, child, exited, stderrText: () => stderr }
}

test('a signal exit prints the serve-teardown reminder too — not only --stop', async () => {
  // Ctrl-C (and --idle-shutdown) leave exactly the same residue as --stop: a live serve
  // forward pointing at a freed, bindable fixed port. The reminder must not depend on
  // WHICH sanctioned exit the operator used.
  const { port, child, exited, stderrText } = await spawnTailscaleViewer()
  child.kill('SIGTERM')
  const gone = await exited
  // Handled SIGTERM is a clean exit (code 0). Linux GHA sometimes still reports
  // the signal (code=null signal=SIGTERM) even after the handler ran — that is
  // still a sanctioned signal exit. The reminder below is the contract.
  assert.ok(
    gone.code === 0 || gone.signal === 'SIGTERM',
    `viewer should exit 0 or via SIGTERM, got code=${gone.code} signal=${gone.signal}`,
  )
  assert.match(stderrText(), new RegExp(`tailscale serve forward to port ${port} is still active`))
  assert.ok(stderrText().includes(TS_ORIGIN))
})

test('--stop on a tailscale viewer reminds the operator the serve forward outlives it', async () => {
  const { home, port } = await spawnTailscaleViewer()
  const res = await runCli(['viewer', '--stop'], { FLOWITION_HOME: home })
  assert.equal(res.code, 0, `--stop failed:\n${res.stderr}`)
  assert.match(res.stderr, /stopped/)
  // The reminder names the port and the validated origin — the freed fixed port would
  // otherwise serve the tailnet name for whatever binds it next.
  assert.match(res.stderr, new RegExp(`tailscale serve forward to port ${port} is still active`))
  assert.ok(res.stderr.includes(TS_ORIGIN))
})

test('--stop --json carries the validated origin; a corrupt record is never echoed', async () => {
  // The JSON shape: origin present, validated, canonical.
  const first = await spawnTailscaleViewer()
  const jsonRes = await runCli(['viewer', '--stop', '--json'], { FLOWITION_HOME: first.home })
  assert.equal(jsonRes.code, 0, `--stop --json failed:\n${jsonRes.stderr}`)
  const report = JSON.parse(jsonRes.stdout)
  assert.equal(report.stopped, true)
  assert.equal(report.tailscaleOrigin, TS_ORIGIN)

  // Corruption: the record's policy field is rewritten under the live viewer. --stop
  // still stops it, but the corrupt bytes reach neither stderr nor stdout, and no
  // teardown command is suggested on a garbage authority.
  const second = await spawnTailscaleViewer()
  const rendezvous = path.join(second.home, 'viewer.json')
  const live = JSON.parse(fs.readFileSync(rendezvous, 'utf8'))
  fs.writeFileSync(rendezvous, JSON.stringify({ ...live, tailscaleOrigin: 'https://user:secret@evil.tail1234.ts.net' }), { mode: 0o600 })
  const res = await runCli(['viewer', '--stop', '--json'], { FLOWITION_HOME: second.home })
  assert.equal(res.code, 0, `--stop failed:\n${res.stderr}`)
  const corruptReport = JSON.parse(res.stdout)
  assert.equal(corruptReport.stopped, true)
  assert.ok(!('tailscaleOrigin' in corruptReport), 'a corrupt record never reaches stdout')
  assert.ok(!res.stdout.includes('user:secret') && !res.stderr.includes('user:secret'))
})
