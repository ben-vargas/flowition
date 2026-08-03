// The route table, its parameter validation, and the handlers W4 owns (DESIGN §5.3,
// §5.4.1, §7.2).
//
// Matching is done on **decoded path segments**, never on a regex over the raw target:
// a `%2F` inside a segment decodes to a separator, and matching after the decode is how
// `runs/a%2F..%2Fb` becomes a run id that `runDir()` refuses (400) instead of a path
// join. `:id` therefore always reaches the single validation choke point (§5.1
// principle 1) and `:n` must be a canonical non-negative integer.
//
// Handlers owned by later units answer 501 `not_implemented` for now. That code is NOT
// part of the shipped §5.2 ErrorCode union — it is transitional scaffolding, and the
// tests that assert it are the signal that W5/W7 must replace the remaining stubs.
//
// node: builtins + ../util.js only (§11.2 denylist).
import fs from 'node:fs'
import path from 'node:path'
import { runDir } from '../util.js'
import { HttpError, SECURITY_HEADERS, sendJson } from './http.js'
import { CHALLENGE_HEADER, challengeProof } from './auth.js'
import { listRuns } from './summaries.js'
import {
  getRunDetail,
  openResultReadStream,
  readAgentResult,
  readRunResult,
} from './snapshot.js'
import {
  parsePageBytes,
  parsePageOffset,
  readEventsPage,
  readTranscriptPage,
} from './pages.js'
import {
  parseSearchLimit,
  searchRun,
  SearchConflictError,
} from './search.js'
import { stream } from './stream.js'
import { CONTROL_HANDLERS } from './control-bridge.js'

/** `read` routes are GET/HEAD only; `mutate` routes carry the capability they need. */
const READ = (name) => ({ kind: 'read', name })
const MUTATE = (name, capability) => ({ kind: 'mutate', name, capability })

const CANONICAL_INT = /^(0|[1-9][0-9]*)$/

/**
 * Resolve decoded path segments to a route, or `null` for 404.
 *
 * @param {string[]} segments path segments with the leading `api` still present
 * @returns {{name: string, methods: Record<string, object>, runId?: string, agentIndex?: string, sse?: boolean}|null}
 */
export function resolveRoute(segments) {
  if (segments[0] !== 'api') return null
  const s = segments.slice(1)

  if (s.length === 1 && s[0] === 'session') return { name: 'session', methods: { GET: READ('session') } }
  if (s.length === 1 && s[0] === 'runs') return { name: 'runs', methods: { GET: READ('runs') } }

  if (s.length >= 2 && s[0] === 'runs') {
    const runId = s[1]
    if (s.length === 2) {
      return { name: 'runDetail', runId, methods: { GET: READ('runDetail'), DELETE: MUTATE('deleteRun', 'delete') } }
    }
    if (s.length === 3) {
      switch (s[2]) {
        case 'stream': return { name: 'stream', runId, sse: true, methods: { GET: READ('stream') } }
        case 'result': return { name: 'result', runId, methods: { GET: READ('result') } }
        case 'search': return { name: 'search', runId, methods: { GET: READ('search') } }
        case 'send': return { name: 'send', runId, methods: { POST: MUTATE('send', 'send') } }
        case 'answer': return { name: 'answer', runId, methods: { POST: MUTATE('answer', 'answer') } }
        case 'cancel': return { name: 'cancel', runId, methods: { POST: MUTATE('cancel', 'cancel') } }
        case 'resume': return { name: 'resume', runId, methods: { POST: MUTATE('resume', 'resume') } }
        default: return null
      }
    }
    if (s.length === 4 && s[2] === 'result' && s[3] === 'raw') return { name: 'resultRaw', runId, methods: { GET: READ('resultRaw') } }
    if (s.length === 4 && s[2] === 'events' && s[3] === 'page') return { name: 'eventsPage', runId, methods: { GET: READ('eventsPage') } }
    if (s.length === 5 && s[2] === 'agents') {
      const agentIndex = s[3]
      if (s[4] === 'page') return { name: 'agentPage', runId, agentIndex, methods: { GET: READ('agentPage') } }
      if (s[4] === 'result') return { name: 'agentResult', runId, agentIndex, methods: { GET: READ('agentResult') } }
      return null
    }
  }
  return null
}

/** §5.4.1: `:id` through `runDir()`, `:n` a canonical non-negative integer. */
export function validateRouteParams(route) {
  if (route.runId !== undefined) {
    try { runDir(route.runId) } catch (err) { throw new HttpError(400, 'bad_request', err.message) }
  }
  if (route.agentIndex !== undefined && !CANONICAL_INT.test(route.agentIndex)) {
    throw new HttpError(400, 'bad_request', `invalid agent index "${route.agentIndex}" — expected a canonical non-negative integer`, { runId: route.runId })
  }
}

// ---- body validation for the mutation routes (§7.1.5, critique N5) ---------------

const MAX_FIELD_CHARS = 32_768

const isCanonicalIndexValue = (v) =>
  (typeof v === 'number' && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)) ||
  (typeof v === 'string' && v.length > 0 && v.length <= 512)

/**
 * Validate a mutation body. Returns the normalized body; throws `HttpError(400)` on any
 * violation. The control bridge (W7) consumes the result and must not re-validate.
 */
export function validateMutationBody(name, body, runId) {
  const bad = (message) => { throw new HttpError(400, 'bad_request', message, { runId }) }
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) bad('body must be a JSON object')

  switch (name) {
    case 'send': {
      if (!isCanonicalIndexValue(body.agent)) bad('send requires "agent": a non-negative integer index or a non-empty label')
      if (typeof body.message !== 'string' || !body.message.length) bad('send requires a non-empty "message" string')
      if (body.message.length > MAX_FIELD_CHARS) bad(`"message" exceeds ${MAX_FIELD_CHARS} characters`)
      return { agent: body.agent, message: body.message }
    }
    case 'answer': {
      if (typeof body.qid !== 'string' || !body.qid.length || body.qid.length > 512) bad('answer requires a non-empty "qid" string')
      if (!('value' in body)) bad('answer requires a "value"')
      if (typeof body.value === 'string') {
        if (body.value.length > MAX_FIELD_CHARS) bad(`"value" exceeds ${MAX_FIELD_CHARS} characters`)
      } else if (JSON.stringify(body.value ?? null).length > MAX_FIELD_CHARS) {
        bad(`"value" exceeds ${MAX_FIELD_CHARS} characters`)
      }
      return { qid: body.qid, value: body.value }
    }
    case 'cancel': {
      // critique N5: the engine reads `agent == null` as "cancel the whole run"
      // (src/engine.js:711). A whole-run cancel therefore requires the key to be
      // ABSENT; a client that sends `{agent: null}` because its state was empty must
      // get a 400, never an accidental run kill.
      if ('agent' in body) {
        if (!isCanonicalIndexValue(body.agent)) bad('cancel "agent" must be a non-negative integer index or a non-empty label — omit the key entirely to cancel the whole run')
        return { agent: body.agent }
      }
      return {}
    }
    case 'resume':
    case 'deleteRun':
      return {}
    default:
      return body
  }
}

// ---- handlers ---------------------------------------------------------------------

/**
 * `GET /healthz` — the ONLY unauthenticated route (§5.3). Readiness data plus, when the
 * caller supplies a challenge, an HMAC proof of token knowledge (§4.2.1). It carries
 * nothing sensitive: no home path, no run ids, no port list. A viewer that answered
 * anything identifying here would let an unauthenticated local caller fingerprint the
 * user's home; a caller that trusted this response without a proof could be an
 * impersonator on the predictable port (Sol-2).
 */
export function healthz(ctx, req, res) {
  const body = { app: 'flowition-viewer', version: ctx.version }
  const challenge = req.headers[CHALLENGE_HEADER]
  // A revoked instance proves nothing (§7.1.2): its token is no longer the one on disk, and
  // answering a challenge with it would let a caller still holding that value "verify" a
  // listener that has stopped serving — reuse pointed at a credential nobody should hold. No
  // proof means the probe reads "not ours", which is the correct verdict for a dead credential.
  if (typeof challenge === 'string' && !ctx.credential?.check()) {
    const proof = challengeProof(ctx.token, challenge)
    if (proof) body.proof = proof
  }
  sendJson(req, res, 200, body)
}

/** `GET /api/session` — the SPA's bootstrap: which capabilities are live (§7.2). */
export function session(ctx, req, res) {
  sendJson(req, res, 200, {
    version: ctx.version,
    home: ctx.home,
    control: [...ctx.capabilities],
    readOnly: ctx.capabilities.length === 0,
  })
}

const asReadError = (err, runId) => {
  if (err instanceof HttpError) return err
  if (err instanceof SearchConflictError) {
    return new HttpError(409, 'conflict', err.message, { runId })
  }
  if (err instanceof RangeError || err?.code === 'bad_request') {
    return new HttpError(400, 'bad_request', err.message, { runId })
  }
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
    return new HttpError(404, 'not_found', `run resource not found`, { runId })
  }
  return err
}

const existingRunDir = (runId) => {
  const dir = runDir(runId)
  let stat
  try { stat = fs.statSync(dir) } catch (err) { throw asReadError(err, runId) }
  if (!stat.isDirectory()) throw new HttpError(404, 'not_found', 'run not found', { runId })
  return dir
}

export async function runs(ctx, req, res, url) {
  try {
    const page = await listRuns({
      limit: url.searchParams.get('limit') ?? undefined,
      cursor: url.searchParams.get('cursor'),
      state: url.searchParams.get('state'),
      q: url.searchParams.get('q'),
    })
    sendJson(req, res, 200, page)
  } catch (err) {
    throw asReadError(err)
  }
}

export async function runDetail(ctx, req, res, url, { route }) {
  const include = url.searchParams.get('include')
  if (include != null && include !== 'args') {
    throw new HttpError(400, 'bad_request', 'include must be "args" when present', { runId: route.runId })
  }
  try {
    const detail = await getRunDetail(route.runId, { includeArgs: include === 'args' })
    if (include === 'args') ctx.audit({ op: 'args-read', runId: route.runId, outcome: 'success' })
    sendJson(req, res, 200, detail)
  } catch (err) {
    throw asReadError(err, route.runId)
  }
}

export async function result(ctx, req, res, url, { route }) {
  try {
    existingRunDir(route.runId)
    sendJson(req, res, 200, await readRunResult(route.runId))
  } catch (err) {
    throw asReadError(err, route.runId)
  }
}

export function resultRaw(ctx, req, res, url, { route }) {
  const dir = existingRunDir(route.runId)
  let opened
  try { opened = openResultReadStream(dir) } catch (err) { throw asReadError(err, route.runId) }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json',
    'content-disposition': 'attachment',
    'cache-control': 'no-store',
    'content-length': String(opened.stat.size),
  })
  if (req.method === 'HEAD') {
    opened.close()
    res.end()
    return
  }
  const stream = opened.stream
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

export function eventsPage(ctx, req, res, url, { route }) {
  try {
    const dir = existingRunDir(route.runId)
    const options = { maxBytes: parsePageBytes(url.searchParams.get('maxBytes')) }
    options.from = parsePageOffset(url.searchParams.get('from'))
    const page = readEventsPage(path.join(dir, 'events.jsonl'), options)
    sendJson(req, res, 200, page)
  } catch (err) {
    throw asReadError(err, route.runId)
  }
}

export function agentPage(ctx, req, res, url, { route }) {
  try {
    const dir = existingRunDir(route.runId)
    const options = { maxBytes: parsePageBytes(url.searchParams.get('maxBytes')) }
    options.from = parsePageOffset(url.searchParams.get('from'))
    const page = readTranscriptPage(path.join(dir, 'agents', `${route.agentIndex}.jsonl`), options)
    sendJson(req, res, 200, page)
  } catch (err) {
    throw asReadError(err, route.runId)
  }
}

export function agentResult(ctx, req, res, url, { route }) {
  try {
    const dir = existingRunDir(route.runId)
    const value = readAgentResult(dir, Number(route.agentIndex))
    if (!value) throw new HttpError(404, 'not_found', 'agent result not found', { runId: route.runId })
    sendJson(req, res, 200, value)
  } catch (err) {
    throw asReadError(err, route.runId)
  }
}

export async function search(ctx, req, res, url, { route }) {
  try {
    const dir = existingRunDir(route.runId)
    const q = url.searchParams.get('q')
    const limit = parseSearchLimit(url.searchParams.get('limit'))
    const value = await searchRun(dir, q, { limit, connection: req.socket })
    sendJson(req, res, 200, value)
  } catch (err) {
    throw asReadError(err, route.runId)
  }
}

/** Owners of any remaining handler, so a 501 says who is missing rather than "todo". */
const STUB_OWNERS = {}

export const HANDLERS = {
  session,
  runs,
  runDetail,
  stream,
  result,
  resultRaw,
  search,
  eventsPage,
  agentPage,
  agentResult,
  // §7.2/§7.3 — the write surface. Every one of these is reached only after
  // `gateMutation` has proven Origin, content-type, the capability and the ephemeral
  // control token (http.js), and after `validateMutationBody` above has normalized the
  // body; the bridge re-checks none of it (control-bridge.js).
  ...CONTROL_HANDLERS,
}

/**
 * Dispatch a validated route. Any handler not yet implemented answers 501 — the request
 * pipeline (host/auth/origin/method/content-type/capability/control-token/params/body)
 * has already run in full, which is what W4 owns.
 */
export function dispatch(ctx, req, res, route, spec, context) {
  const handler = ctx.handlers?.[spec.name] ?? HANDLERS[spec.name]
  if (handler) return handler(ctx, req, res, context.url, { route, spec, ...context })
  const owner = STUB_OWNERS[spec.name] ?? 'a later unit'
  throw new HttpError(501, 'not_implemented', `${req.method} ${route.name} is not implemented yet (${owner})`, { runId: route.runId })
}
