// The request pipeline (DESIGN §4.5, §5.1–§5.3, §5.8, §7.1):
//
//   host check → static | api split → auth → origin → route dispatch → error envelope
//
// Every stage is a refusal with a specific status code, and the whole matrix
// (Host × Origin × token × control-token × method × content-type) is pinned by
// test/viewer-http.test.js.
//
// The request BODY is read at the very end of that chain and only for a mutation whose
// every gate has already passed (§5.1 principle 4). Reading it up front would both
// reorder the refusals — an over-cap upload aimed at a rebound Host has to fail the Host
// check, not the size check — and let an unauthenticated caller make this process hold
// 256 KB of its bytes for the request timeout.
//
// The security headers of §7.1.4 go on **every** response, including refusals and
// static assets — a 403 that omits the CSP is still a page an attacker can frame. That
// includes responses no handler ever produced: `writeClientError` below is the server's
// `clientError` listener, because node otherwise answers its own parser failures from the
// raw socket with a bare status line.
//
// This module holds no route knowledge: `ctx.routes` is injected by index.js, which
// keeps the dependency direction one-way (routes.js → http.js, never back).
//
// node: builtins only.
import { requestToken, tokenMatches, redactSecrets } from './auth.js'
import { resolveAsset, contentTypeFor, cacheControlFor } from './static.js'
import { STATUS_CODES } from 'node:http'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

/**
 * §7.1.4 — on every response. Values are byte-for-byte the spec's.
 *
 * The one `style-src` hash admits a single byte string: the
 * `@layer { * { overscroll-behavior: contain } }` rule react-aria's `usePreventScroll`
 * prepends to `<head>` while a modal is open on iOS, and removes when it closes. It is
 * NOT a relaxation — no `'unsafe-inline'`, no nonce, no `'unsafe-hashes'` (so markup
 * `style=` attributes stay blocked), and every other inline stylesheet stays blocked.
 * The digest, the rule it covers, and why this site is hash-allowed while `usePress`'s
 * is prevented outright all live in `viewer/src/ui/preventScrollStyle.ts`;
 * test/viewer-http.test.js fails if the two drift apart.
 */
export const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
})

export const MAX_BODY_BYTES = 256 * 1024

/** A refusal carrying its §5.2 envelope code. */
export class HttpError extends Error {
  constructor(status, code, message, { runId, headers, ...extra } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.runId = runId
    this.headers = headers
    this.extra = extra
  }
}

/**
 * Refusing a request before reading its body leaves those bytes in the socket, where a
 * keep-alive connection would parse them as the next request (an HPE_INVALID_METHOD
 * 400 on a request the client never made). Every gate in this pipeline can refuse
 * before the body is read, so any response that leaves a declared body unconsumed
 * closes the connection instead.
 */
export function connectionHeaders(req) {
  const declaresBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined
  return declaresBody && !req.readableEnded ? { connection: 'close' } : {}
}

/** JSON out, always; `cache-control: no-store` on every API response (§5.7). */
export function sendJson(req, res, status, body, headers = {}) {
  if (res.writableEnded || res.headersSent) return
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(buf.length),
    ...connectionHeaders(req),
    ...headers,
  })
  if (req.method === 'HEAD') res.end()
  else res.end(buf)
}

/** The §5.2 error envelope. `runId` is included only when the route named one. */
export function sendError(req, res, status, code, message, { runId, headers, extra } = {}) {
  const error = { code, message }
  if (runId !== undefined) error.runId = runId
  sendJson(req, res, status, { error, ...(extra ?? {}) }, headers)
}

// ---- host / origin allowlists (§7.1.3, §7.1.5) -----------------------------------

/**
 * The names this server answers to. All three are loopback, so a rebound DNS name
 * (which carries the attacker's Host) never matches — that is the whole DNS-rebinding
 * defense (§7.1.3). There is no `--host` flag, so the set is closed. `--tailscale-origin`
 * (§7.1.8) extends it by exactly one explicit, validated entry — the Host that Tailscale
 * Serve preserves when proxying tailnet TLS traffic to this loopback listener — so the
 * set stays closed: a rebound name still matches nothing.
 */
export const allowedHosts = (port) => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]

export const hostAllowed = (host, port, tailscale = null) =>
  typeof host === 'string' && expectedOriginFor(host, port, tailscale) !== null

/**
 * The one canonical Host → expected-Origin mapping (§7.1.3 + §7.1.5 + §7.1.8). Every
 * loopback authority is an `http://` origin of itself; the configured Tailscale authority
 * is the `https://` origin the browser actually loaded from (Tailscale Serve terminates
 * TLS and preserves the Host, so the internal hop's scheme never reaches the browser).
 * DNS names are case-insensitive, so the tailscale comparison lowercases the incoming
 * Host; the loopback trio keeps its exact byte match, unchanged.
 *
 * @param {string} host the request's `Host` header
 * @param {number} port the bound loopback port
 * @param {{origin: string, host: string}|null} tailscale parsed `--tailscale-origin`, or null
 * @returns {string|null} the only Origin a browser on that authority can send, or null
 *   when the Host is not ours at all
 */
export const expectedOriginFor = (host, port, tailscale = null) => {
  if (typeof host !== 'string') return null
  if (allowedHosts(port).includes(host)) return `http://${host}`
  if (tailscale && host.toLowerCase() === tailscale.host) return tailscale.origin
  return null
}

/**
 * §7.1.5: the Origin must equal **the server's own origin** — which, for a browser, is
 * derived from the very authority it connected to. So it is compared against the
 * already-validated `Host`, not against the allowlist as a whole: a document loaded from
 * `http://localhost:<port>/` can only ever send `Origin: http://localhost:<port>` with
 * `Host: localhost:<port>`. Accepting `Origin: http://localhost:<port>` on a request
 * whose Host is `127.0.0.1:<port>` would accept a cross-origin request (the names
 * are distinct web origins even though they are one socket) and hand the CSRF
 * defense back to the attacker. The same rule covers the Tailscale authority: its only
 * legal Origin is the configured `https://` origin, never an `http://` reflection.
 *
 * @param {unknown} origin the request's `Origin` header
 * @param {string} host the request's `Host`, already through `hostAllowed`
 * @param {number} port the bound loopback port
 * @param {{origin: string, host: string}|null} tailscale parsed `--tailscale-origin`, or null
 */
export const originAllowed = (origin, host, port, tailscale = null) =>
  typeof origin === 'string' && origin === expectedOriginFor(host, port, tailscale)

// ---- tailscale serve integration (§7.1.8) -------------------------------------------

/**
 * Parse and validate a `--tailscale-origin` value into its canonical origin and the Host
 * header Tailscale Serve will preserve onto proxied requests.
 *
 * Deliberately Tailscale-specific, not a generic trusted-proxy escape hatch: the §7.1.8
 * security argument leans on Tailscale Serve's header contract (ipn/ipnlocal/serve.go —
 * it deletes the known client-supplied `Tailscale-*` identity/Funnel headers by name,
 * overwrites `X-Forwarded-Proto: https` at TLS termination, preserves the `.ts.net`
 * Host to a TCP-port backend, and marks public Funnel traffic with
 * `Tailscale-Funnel-Request: ?1`), so the flag only accepts an origin that proxy can
 * actually terminate: `https://`, a `*.ts.net` name, nothing else in the URL.
 *
 * @param {unknown} value the raw flag value
 * @returns {{origin: string, host: string}} `origin` is the canonical WHATWG origin
 *   (default port elided); `host` is the exact lowercased authority (`URL.host`) the
 *   proxied requests carry as their Host header
 */
export function parseTailscaleOrigin(value) {
  const refuse = (why) => {
    throw new Error(`--tailscale-origin ${why} — expected the HTTPS origin tailscale serve terminates, e.g. https://machine.tailnet-name.ts.net or https://machine.tailnet-name.ts.net:8443`)
  }
  if (typeof value !== 'string' || value === '' || value === 'true') refuse('requires a value')
  let url
  try { url = new URL(value) } catch { return refuse(`is not a valid URL (got "${value}")`) }
  if (url.protocol !== 'https:') refuse(`must be https:// (got "${url.protocol}//")`)
  if (url.username || url.password) refuse('must not carry credentials')
  if (url.pathname !== '/') refuse(`must not carry a path (got "${url.pathname}")`)
  if (url.search) refuse('must not carry a query')
  if (url.hash) refuse('must not carry a fragment')
  // The URL getters cannot see EMPTY components — "https://@host", a trailing "?" or
  // "#" — but an origin never contains those delimiters at all, so the raw string is
  // the authority on their absence. (Non-empty components were refused just above.)
  if (value.includes('@')) refuse('must not carry credentials')
  if (value.includes('?')) refuse('must not carry a query')
  if (value.includes('#')) refuse('must not carry a fragment')
  // The hostname is already lowercased by the URL parser. `.ts.net` is the contract —
  // see the function comment; a bare "ts.net" is nobody's machine.
  if (!url.hostname.endsWith('.ts.net') || url.hostname === 'ts.net') {
    refuse(`must name a *.ts.net host (got "${url.hostname}")`)
  }
  // WHATWG parsing tolerates spellings no MagicDNS name can have — empty labels
  // ("foo..ts.net", ".ts.net"), underscores, edge hyphens, labels past DNS's 63-octet
  // limit, names past its 253-octet limit, port 0. Serve never terminates such an
  // authority, so they are configuration mistakes; refuse them here, not at 3 AM.
  if (url.hostname.length > 253
    || url.hostname.split('.').some((label) => label.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) {
    refuse(`must name a valid DNS host (got "${url.hostname}")`)
  }
  if (url.port === '0') refuse('must not name port 0')
  return { origin: url.origin, host: url.host }
}

/** The header Tailscale Serve sets on public Funnel traffic and strips from clients. */
export const FUNNEL_HEADER = 'tailscale-funnel-request'

const JSON_CONTENT_TYPE = /^application\/json[ \t]*(;|$)/i
const isJsonContentType = (value) => typeof value === 'string' && JSON_CONTENT_TYPE.test(value.trim())

// ---- pipeline ---------------------------------------------------------------------

/**
 * Wire **every** way node can hand this server a request into the one pipeline.
 *
 * `server.on('request')` is only the common path. Node has four more, and each one
 * answers by itself — from inside `_http_server`, on the bare socket, with no §5.2
 * envelope and none of §7.1.4's headers — when nothing is listening:
 *
 * | node event         | when                              | node's own answer            |
 * |--------------------|-----------------------------------|------------------------------|
 * | `checkContinue`    | `Expect: 100-continue`            | writes `100 Continue` *before* any gate, then emits `request` |
 * | `checkExpectation` | any other `Expect:` value         | bare `417`, no envelope, no headers |
 * | `connect`          | `CONNECT`                         | socket destroyed — no `405` at all |
 * | `upgrade`          | `Upgrade:` + `Connection: upgrade`| socket destroyed — no response at all |
 * | `clientError`      | parser refusals                   | bare status line, no headers |
 *
 * All five are routed through `handle` here, so the Host allowlist, token auth, Origin
 * equality and the method gate decide these requests exactly as they decide a GET, and
 * every one of them answers in the §5.2 envelope with the full §7.1.4 header set. The
 * three that node cannot serve (unsupported `Expect`, `CONNECT`, `Upgrade`) carry an
 * `unsupported` refusal that fires at the dispatch boundary — *after* those gates, so a
 * hostile `Host` plus an unsupported `Expect` is still a 403, not a 417.
 *
 * @param {import('node:http').Server} server
 * @param {object} ctx
 */
export function attachRequestPipeline(server, ctx) {
  const handle = createRequestHandler(ctx)
  server.on('request', (req, res) => handle(req, res))
  // Gates first, `100 Continue` second: `drainBody` writes it, so it is sent only for a
  // mutation whose every gate has already passed. An unauthenticated or over-cap caller is
  // refused without ever being invited to send its body.
  server.on('checkContinue', (req, res) => handle(req, res, { pendingContinue: true }))
  server.on('checkExpectation', (req, res) => handle(req, res, { unsupported: EXPECTATION_FAILED }))
  server.on('connect', (req, socket) => handleOnSocket(handle, req, socket, { unsupported: TUNNEL_REFUSED }))
  server.on('upgrade', (req, socket) => handleOnSocket(handle, req, socket, { unsupported: UPGRADE_REFUSED }))
  server.on('clientError', writeClientError)
  return handle
}

/** §5.2 has no code for these three, so the malformed-request bucket carries them. */
const EXPECTATION_FAILED = [417, 'bad_request', 'unsupported Expect header']
const TUNNEL_REFUSED = [405, 'bad_request', 'CONNECT is not supported — the viewer is not a proxy']
const UPGRADE_REFUSED = [400, 'bad_request', 'protocol upgrades are not supported']

/**
 * `connect` and `upgrade` hand over a raw socket with no `ServerResponse`, so the pipeline
 * gets a minimal one. Both are always refusals (a tunnel or an upgrade never reaches a
 * handler), so writeHead + end is the whole surface it needs.
 */
function handleOnSocket(handle, req, socket, state) {
  if (!socket || socket.destroyed || !socket.writable) return
  socket.on('error', () => socket.destroy())
  handle(req, new SocketResponse(socket), state)
}

class SocketResponse extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
    this.headersSent = false
    this.writableEnded = false
    this.statusCode = 0
    this.head = ''
  }

  writeHead(status, headers = {}) {
    if (this.headersSent) return this
    this.headersSent = true
    this.statusCode = status
    // `connection: close` last and unconditional: the socket is detached from node's
    // keep-alive machinery, so it can only be a one-shot response.
    const merged = { ...headers, connection: 'close' }
    this.head = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n`
      + Object.entries(merged).map(([name, value]) => `${name}: ${value}\r\n`).join('')
      + '\r\n'
    return this
  }

  end(chunk) {
    if (this.writableEnded) return this
    this.writableEnded = true
    const body = chunk == null ? Buffer.alloc(0) : Buffer.from(chunk)
    try { this.socket.end(Buffer.concat([Buffer.from(this.head, 'latin1'), body])) } catch { this.socket.destroy() }
    this.emit('finish')
    return this
  }

  destroy() {
    this.writableEnded = true
    this.socket.destroy()
  }
}

/**
 * @param {object} ctx `{port, token, controlToken, capabilities, version, home, distRoot, routes, handlers?, accessLog?, onInternalError?}`
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, state?: object) => void}
 */
export function createRequestHandler(ctx) {
  const secrets = [ctx.token, ctx.controlToken].filter(Boolean)
  const redact = (text) => redactSecrets(text, secrets)

  return function handle(req, res, state = {}) {
    const startedAt = Date.now()
    if (ctx.accessLog) {
      // §7.1.7 — `method path-without-query status ms`, nothing else. The path is split
      // on '?' so the SSE route's `?token=` can never reach a log line, and no request
      // or response body is ever logged (§5.1 principle 4).
      const target = String(req.url ?? '').split('?')[0]
      res.on('finish', () => ctx.accessLog(`${req.method} ${target} ${res.statusCode} ${Date.now() - startedAt}ms`))
    }
    // NOTHING is read from the request body until the request's *shape* is authorized.
    // Host, URL, route, token, Origin, method and the mutation gates all run first, so an
    // unauthenticated or misdirected caller is refused on its headers alone and never
    // gets to make this process hold 256 KB of its bytes for the request timeout. A
    // refusal that leaves declared bytes unread would poison a keep-alive connection, so
    // `connectionHeaders` closes it instead of letting the parser read the leftovers as
    // the next request line.
    Promise.resolve()
      .then(() => handleRequest(ctx, req, res, state))
      .catch((err) => {
        if (res.headersSent || res.writableEnded) { res.destroy(); return }
        if (err instanceof HttpError) {
          sendError(req, res, err.status, err.code, redact(err.message), { runId: err.runId, headers: err.headers, extra: err.extra })
          return
        }
        // §5.2: 500 messages are generic; details never leak (they may contain paths
        // from the user's home, or fragments of transcript content). The diagnostic
        // handed to the host is redacted first: an unexpected throw whose message
        // happened to interpolate a token (or a `?token=` URL) must not put the
        // credential into the CLI's stderr, which is the one place §7.1.7 forbids it.
        ctx.onInternalError?.(safeDiagnostic(err, redact))
        sendError(req, res, 500, 'internal', 'internal error')
      })
  }
}

/**
 * A throw-alike whose message and stack have been through `redactSecrets`, so a host that
 * logs `err.message` (src/cli.js's `onInternalError`) cannot log a credential. The
 * original error is deliberately not attached — a `cause` chain would smuggle the
 * unredacted text straight back out.
 */
function safeDiagnostic(err, redact) {
  const safe = new Error(redact(err?.message ?? String(err)))
  safe.name = typeof err?.name === 'string' ? err.name : 'Error'
  safe.stack = typeof err?.stack === 'string' ? redact(err.stack) : safe.stack
  if (err?.code !== undefined) safe.code = err.code
  return safe
}

/**
 * Bounded body read: `null` when the request declares none, otherwise the raw bytes,
 * ≤256 KB (§5.1 principle 4). Never logged — bodies are steering text by definition.
 * Called only once a request has passed every gate.
 */
async function drainBody(req, res, state) {
  if (req.headers['content-length'] === undefined && req.headers['transfer-encoding'] === undefined) return null
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge()

  // The only place `100 Continue` is ever written: an `Expect: 100-continue` client is
  // invited to send its body only once every gate has passed and the declared length is
  // inside the cap (§5.1 principle 4). Node would have written it before the Host check.
  if (state?.pendingContinue) {
    state.pendingContinue = false
    if (typeof res.writeContinue === 'function') res.writeContinue()
  }

  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw tooLarge()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * The refusal for the node paths that can never be served (unsupported `Expect`,
 * `CONNECT`, `Upgrade`). Called at the dispatch boundary of every branch — deliberately
 * *after* Host, auth, Origin and method, so those gates keep their precedence.
 */
function assertServiceable(state) {
  if (!state?.unsupported) return
  const [status, code, message] = state.unsupported
  throw new HttpError(status, code, message)
}

async function handleRequest(ctx, req, res, state) {
  // 0. Funnel refusal (§7.1.8) — before even the Host gate, and only when this instance
  //    was started with `--tailscale-origin` (without the flag, behavior is unchanged).
  //    Tailscale Serve sets this header on PUBLIC Funnel traffic and strips any
  //    client-supplied value, so through the proxy it cannot be spoofed away or forged:
  //    its presence in any form means this listener has been exposed past the tailnet,
  //    which is never what the flag authorized. (A direct local caller can add the
  //    header to its own request; it only earns itself a 403.)
  if (ctx.tailscale && req.headers[FUNNEL_HEADER] !== undefined) {
    throw new HttpError(403, 'forbidden', 'funnel traffic is refused — the viewer serves the tailnet only, never the public internet')
  }

  // 1. Host allowlist — before anything else, including static, the body, and auth
  //    (§7.1.3). `requireHostHeader: false` on the server (index.js) is what lets an
  //    HTTP/1.1 request with NO Host reach this gate: node's canned 400 for that case
  //    carries none of §7.1.4's headers, and §7.1.3 wants a 403 for every Host that is
  //    not exactly ours — absent very much included.
  const host = req.headers.host
  if (!hostAllowed(host, ctx.port, ctx.tailscale)) {
    throw new HttpError(403, 'forbidden', ctx.tailscale
      ? `host not allowed — the viewer answers only on 127.0.0.1, localhost, [::1] or ${ctx.tailscale.host}`
      : 'host not allowed — the viewer answers only on 127.0.0.1, localhost or [::1]')
  }

  // 1b. HTTPS proxy provenance (§7.1.8): a request addressed to the Tailscale authority
  //     must have entered through Serve's TLS ingress. Serve overwrites
  //     `X-Forwarded-Proto: https` at TLS termination (Set replaces any client-supplied
  //     value), so this is exactly the architecture the flag promised — it catches an
  //     accidental plaintext or non-Tailscale proxy path, and keeps the new Host entry
  //     from becoming a bare-HTTP alias. It is provenance, not authentication: a local
  //     same-user process can forge it, and is out of scope (§7.4).
  //     The comparison is byte-exact: Serve writes the literal "https", so anything
  //     else — including a comma-joined value from a second proxy layer — fails closed.
  if (ctx.tailscale && typeof host === 'string' && host.toLowerCase() === ctx.tailscale.host) {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      throw new HttpError(403, 'forbidden', `requests for ${ctx.tailscale.host} must arrive via tailscale serve's TLS ingress (missing or non-https X-Forwarded-Proto)`)
    }
  }

  let url
  try {
    url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.port}`)
  } catch {
    throw new HttpError(400, 'bad_request', 'malformed request target')
  }

  // 2. static | api split. /healthz is the one unauthenticated route (§5.3).
  if (url.pathname === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'bad_request', 'method not allowed', { headers: { allow: 'GET, HEAD' } })
    }
    assertServiceable(state)
    return ctx.routes.healthz(ctx, req, res, url)
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return apiRequest(ctx, req, res, url, host, state)
  return staticRequest(ctx, req, res, url, state)
}

/** Percent-decode each segment exactly once, before any matching (§5.1 principle 1). */
function decodeSegments(pathname) {
  const out = []
  for (const raw of pathname.split('/')) {
    if (raw === '') continue
    let decoded
    try { decoded = decodeURIComponent(raw) } catch { throw new HttpError(400, 'bad_request', 'malformed request path') }
    if (decoded.includes('\0')) throw new HttpError(400, 'bad_request', 'malformed request path')
    out.push(decoded)
  }
  return out
}

async function apiRequest(ctx, req, res, url, host, state) {
  const segments = decodeSegments(url.pathname)
  const route = ctx.routes.resolveRoute(segments)

  // 3. Auth on the ENTIRE /api surface, reads included (§7.1.2). Before the 404 for an
  // unknown route: an unauthenticated caller must not be able to map the route table.
  //
  // The credential is re-proven against the token file HERE, before any comparison: a token
  // loaded at startup is not a boundary, it is a memory of one. If `viewer.token` has since
  // been replaced, deleted, or opened up to other local users, this instance's credential is
  // burned and **every** value must be refused — including the one it was started with, which
  // is precisely the value another local user may now hold (§7.4). index.js closes the
  // listener right behind this refusal; refusing first is what leaves no window.
  const revoked = ctx.credential?.check()
  if (revoked) {
    throw new HttpError(401, 'unauthorized', `this viewer no longer authenticates: ${revoked} — start the viewer again to mint a fresh token`)
  }
  const presented = requestToken(req, url, { allowQueryToken: route?.sse === true })
  if (!tokenMatches(ctx.token, presented)) {
    throw new HttpError(401, 'unauthorized', 'missing or invalid token — pass Authorization: Bearer <token>')
  }

  // 4. Origin. Absent is allowed on reads (a CLI or curl sends none); present must equal
  //    the origin of the authority the client actually connected to, which refuses a
  //    cross-origin fetch before it runs.
  const origin = req.headers.origin
  if (origin !== undefined && !originAllowed(origin, host, ctx.port, ctx.tailscale)) {
    throw new HttpError(403, 'forbidden', 'origin not allowed')
  }

  if (!route) throw new HttpError(404, 'not_found', 'no such API route')

  // 5. Method. HEAD is served by the GET handler (which suppresses the body).
  const method = req.method === 'HEAD' ? 'GET' : req.method
  const spec = route.methods[method]
  if (!spec) {
    const allow = Object.keys(route.methods)
    if (allow.includes('GET')) allow.splice(1, 0, 'HEAD')
    // §5.3 requires 405 here; §5.2's code union has no method-specific code, so the
    // malformed-request bucket carries it, with `Allow` doing the precise work.
    throw new HttpError(405, 'bad_request', `method not allowed — allowed: ${allow.join(', ')}`, {
      runId: route.runId,
      headers: { allow: allow.join(', ') },
    })
  }

  // 6. A request node itself cannot serve (`CONNECT`, an upgrade, an unsupported
  //    `Expect`) is refused here — past every gate above, so their codes keep precedence.
  assertServiceable(state)

  ctx.routes.validateRouteParams(route)

  let body
  if (spec.kind === 'mutate') {
    await gateMutation(ctx, req, origin, spec)
    // Only now — Origin present and exact, content-type JSON, the capability enabled and
    // the ephemeral control token proven — is this process willing to hold the caller's
    // bytes (§5.1 principle 4, §7.1.5), or to answer `100 Continue`.
    body = ctx.routes.validateMutationBody(spec.name, parseJsonBody(await drainBody(req, res, state), route.runId), route.runId)
  }

  return ctx.routes.dispatch(ctx, req, res, route, spec, { url, body })
}

/** §7.1.5 + §7.2: everything a mutation needs beyond the baseline read gates. */
async function gateMutation(ctx, req, origin, spec) {
  // An Origin is mandatory here, and `null` (a sandboxed/opaque origin) is a refusal,
  // not a wildcard.
  if (origin === undefined || origin === 'null') {
    throw new HttpError(403, 'forbidden', 'mutations require a same-origin Origin header')
  }
  // Forces a CORS preflight for any cross-origin attempt, which then fails because no
  // CORS headers exist anywhere. A `<form>` cannot produce this content type at all.
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new HttpError(400, 'bad_request', 'content-type must be application/json')
  }
  // Read-only by default (§7.2) — the DECISION that keeps every later token or
  // rendering defect from becoming a full-permission control-channel defect.
  if (!ctx.capabilities.length) {
    throw new HttpError(403, 'forbidden', 'viewer is read-only — restart with --control')
  }
  if (!ctx.capabilities.includes(spec.capability)) {
    throw new HttpError(403, 'forbidden', `the "${spec.capability}" capability is not enabled — restart with --control=${spec.capability}`)
  }
  // The ephemeral control token: only a URL printed by the `--control` invocation
  // itself carries it, so a shared or auto-started URL can never drive a mutation.
  if (!tokenMatches(ctx.controlToken, req.headers['x-flowition-control'])) {
    throw new HttpError(403, 'forbidden', 'missing or invalid control token')
  }
}

function parseJsonBody(rawBody, runId) {
  if (!rawBody || rawBody.length === 0) return {}
  try {
    return JSON.parse(rawBody.toString('utf8'))
  } catch {
    // Deliberately no excerpt of the body in the message — bodies are steering text.
    throw new HttpError(400, 'bad_request', 'body is not valid JSON', { runId })
  }
}

// The one case where bytes are deliberately left unread: an over-cap upload is refused
// rather than drained, so the connection must close instead of being kept alive with a
// partially-consumed body in it.
const tooLarge = () =>
  new HttpError(413, 'payload_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`, { headers: { connection: 'close' } })

// ---- parser-level refusals (§7.1.4 "headers on EVERY response") --------------------

/**
 * Node answers its own parser failures — bad framing, an invalid method or header token,
 * a header block over the cap, a request that never finished arriving — from inside
 * `_http_server` on the bare socket: a status line, `Connection: close`, no body, and
 * none of §7.1.4's headers. No request handler ever sees them, so the "headers on every
 * response" rule can only be kept by owning the `clientError` event (index.js installs
 * this). The response is the same §5.2 envelope every other refusal uses.
 *
 * Node routes each of these through `socketOnError`, which emits `clientError` and only
 * writes its own canned buffer when nothing is listening (lib/_http_server.js) — so
 * installing this replaces those responses rather than racing them.
 */
export function writeClientError(err, socket) {
  if (!socket || socket.destroyed || !socket.writable) return
  // A reset peer has nowhere to read a reply, and a response already on the wire must
  // not be corrupted by a second one (node applies the same two guards).
  if (err?.code === 'ECONNRESET' || socket._httpMessage?.headersSent) { socket.destroy(); return }
  const [status, code, message] = CLIENT_ERROR_RESPONSES[err?.code] ?? CLIENT_ERROR_RESPONSES.default
  const body = Buffer.from(JSON.stringify({ error: { code, message } }))
  const headers = {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
    connection: 'close',
  }
  const head = `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n`
    + Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')
    + '\r\n'
  socket.end(Buffer.concat([Buffer.from(head, 'latin1'), body]))
}

/**
 * §5.2's code union has no entry for "the bytes were not HTTP", so the malformed-request
 * bucket carries the framing failures and the size caps map onto `payload_too_large`.
 */
const CLIENT_ERROR_RESPONSES = {
  HPE_HEADER_OVERFLOW: [431, 'payload_too_large', 'request header fields too large'],
  HPE_CHUNK_EXTENSIONS_OVERFLOW: [413, 'payload_too_large', 'chunk extensions too large'],
  ERR_HTTP_REQUEST_TIMEOUT: [408, 'bad_request', 'the request did not finish arriving in time'],
  default: [400, 'bad_request', 'malformed request'],
}

// ---- static (§5.8) ----------------------------------------------------------------

function staticRequest(ctx, req, res, url, state) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'bad_request', 'method not allowed', { headers: { allow: 'GET, HEAD' } })
  }
  assertServiceable(state)
  const resolved = resolveAsset(ctx.distRoot, url.pathname)
  if (resolved.status) throw new HttpError(resolved.status, resolved.code, resolved.message)

  const relative = path.relative(ctx.distRoot, resolved.file)
  const headers = {
    ...SECURITY_HEADERS,
    'content-type': contentTypeFor(resolved.realPath),
    'cache-control': resolved.isIndex ? 'no-cache' : cacheControlFor(relative),
    'content-length': String(resolved.size),
    ...connectionHeaders(req),
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }
  res.writeHead(200, headers)
  const stream = fs.createReadStream(resolved.realPath)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
