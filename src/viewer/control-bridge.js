// The control bridge — the viewer's ENTIRE mutation surface (DESIGN §7.2–§7.4).
//
// Five operations, three shapes:
//
//   send / answer / cancel  → one `controlRequest` over the run's own unix control
//                             socket (`<runDir>/control.sock`), with the per-command
//                             timeouts §7.2 pins. The engine does the work; this file
//                             is a translator between HTTP and JSONL, nothing more.
//   resume                  → install the shared `.resuming` handoff marker and spawn
//                             `flowition resume <id> --json` DETACHED. Never in process.
//   delete                  → `removeRun()` from ../retention.js. Not one byte of
//                             filesystem-deletion logic lives here.
//
// Two rules are structural rather than stylistic:
//
//   1. **No workflow ever executes in the server process.** `runWorkflow` is not
//      importable from `src/viewer/**` (§11.2 denylist, enforced by
//      test/zero-deps.test.js), so a resume can only ever be a `spawn` of the CLI,
//      which re-runs the engine's own fileHash/graphHash/args preflight
//      (src/engine.js:790–804). The viewer adds nothing to that gate and bypasses
//      nothing — which is why a `202` here means **launch accepted and nothing more**
//      (Sol-12); the actual verdict arrives later as `sys`/`state` frames and events.
//   2. **Deletion is not reimplemented.** `removeRun` carries the symlink refusal, the
//      containment proof, the artifact requirement, the run-lock acquisition, the
//      resume-race rollback and its own unsubstitutable audit write. A second
//      "simplified" copy behind an HTTP route is exactly the defect §7.3 was written
//      to prevent, so this module maps its error codes and touches nothing else.
//
// Authorization is NOT this file's job and is deliberately not re-checked here: the
// capability gate, the ephemeral control token, the Origin equality and the JSON
// content-type all fire in http.js's `gateMutation` before dispatch, and the bodies
// arrive already validated by routes.js's `validateMutationBody` (§7.1.5, critique N5).
// Two policies would be one policy too many.
//
// node: builtins + ../control.js, ../run-state.js, ../run-lock.js, ../retention.js,
// ../util.js (§11.2 allowlist).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runDir } from '../util.js'
import { controlRequest } from '../control.js'
import { deriveRunState } from '../run-state.js'
import { installResumeMarker, RunLockError } from '../run-lock.js'
import { removeRun, RetentionError, TRASH_TTL_DAYS } from '../retention.js'
import { HttpError, sendJson } from './http.js'
import { readFirstJournalMeta } from './journal-view.js'

/**
 * §7.2 "Bridge timeouts" (critique M13), verbatim. `controlRequest`'s own default is
 * 5000 ms (src/control.js:156), which would pin one of this single-threaded server's
 * HTTP connections to a preflight-blocked engine for five seconds per click. Every call
 * therefore passes an explicit budget:
 *
 *   - `status` 300 ms — the same `CONTROL_TIMEOUT_MS` `deriveRunState` uses
 *     (src/run-state.js:7), so a liveness probe from the bridge costs exactly what a
 *     liveness probe from the read layer costs.
 *   - `send`/`answer`/`cancel` 2000 ms — a mutation is worth waiting a little for; the
 *     UI holds the button disabled for the duration, so a double-click cannot
 *     double-cancel.
 */
export const CONTROL_TIMEOUT_MS = Object.freeze({
  status: 300,
  send: 2000,
  answer: 2000,
  cancel: 2000,
})

/**
 * §7.2's retry hint on a `run_not_live`, in the response body (the §5.2 envelope has no
 * header channel for it).
 */
export const RETRY_AFTER_MS = 2000

/**
 * The delivery verdicts `job.send` can return (src/agent-proc.js:151–177) plus the
 * `pending` a spawn-handle send reports before admission (src/engine.js:1159).
 *
 * Exported as documentation and for the SPA's copy table — **not** as a filter. The
 * verdict is passed through to the client exactly as the engine spelled it, including a
 * value this build has never heard of: §6.5's degradation contract runs in both
 * directions, and an older viewer talking to a newer engine must show the operator what
 * actually happened rather than blanking a word it does not recognise.
 */
export const SEND_VERDICTS = Object.freeze(['live', 'queued', 'replayed', 'dropped', 'pending'])

/**
 * §7.3: the states a resume may be launched against. **`completed` is in the set on
 * purpose** (Sol-12, parity #99): the engine deliberately supports resuming a completed
 * run as a full cache replay — `test/engine.test.js:41–46` proves it — and the previous
 * revision's withholding of it removed a real capability for no safety gain. The UI
 * labels that case "Replay" with its own modal copy.
 */
export const RESUMABLE_STATES = Object.freeze(['completed', 'failed', 'interrupted', 'stale'])
const RESUMABLE = new Set(RESUMABLE_STATES)

const socketPath = (runId) => path.join(runDir(runId), 'control.sock')

/**
 * §5.2 `run_not_live` (503, retryable). The message is fixed text: the underlying error
 * names the socket path, and §5.2 keeps filesystem detail out of refusal bodies.
 */
const notLive = (runId) =>
  new HttpError(503, 'run_not_live', 'run is not live — it may have finished', { runId, retryAfterMs: RETRY_AFTER_MS })

/**
 * §7.2's failure column is an exact list — `ENOENT/ECONNREFUSED/timeout → 503
 * run_not_live` — and §5.2 defines the code as "control socket absent/refused
 * (retryable)". Nothing else belongs in it. A previous revision funnelled *every*
 * `controlRequest` rejection here on the theory that any socket failure is a liveness
 * failure; that was wrong in the direction that matters. `EACCES` (a socket this process
 * may not connect to — a permission defect that no amount of retrying fixes) and a reply
 * line that is not JSON (protocol corruption, or something other than a flowition engine
 * listening on that path) are not "the run finished". Labelling them retryable liveness
 * loss hides a real fault behind a 503 the SPA is designed to re-poll.
 *
 * Everything outside this set is re-thrown to http.js, which answers the §5.2 generic
 * `500 internal` and hands the redacted diagnostic to the host.
 *
 * The timeout arm has no errno to match on: the shipped client rejects with a bare
 * `new Error('control request timed out')` (src/control.js:158). Matching that sentinel
 * is exact for the one client this module uses, and the real-socket timeout test
 * (test/viewer-control.test.js, "per-command timeouts are enforced against a real socket
 * that never replies") drives the shipped client end-to-end, so the mapping cannot rot
 * silently if that string ever changes.
 */
const NOT_LIVE_ERRNOS = new Set(['ENOENT', 'ECONNREFUSED'])
const CONTROL_TIMEOUT_MESSAGE = 'control request timed out'

function isNotLive(err) {
  if (err?.code !== undefined) return NOT_LIVE_ERRNOS.has(err.code)
  return err?.message === CONTROL_TIMEOUT_MESSAGE
}

/**
 * §5.1 principle 1 has already proven the id is a safe child name; this proves the run
 * exists. Without it every mutation against a typo'd or deleted id would answer
 * `503 run_not_live` ("it may have finished") off the socket's ENOENT — advice that is
 * wrong and unactionable for a run that was never there. §5.2 reserves 404 for an absent
 * run and every read route already answers it, so the distinction the operator sees is
 * "no such run" vs "that run has no live engine".
 */
function requireRunDir(runId) {
  let stat
  try {
    stat = fs.statSync(runDir(runId))
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw new HttpError(404, 'not_found', 'run not found', { runId })
    throw err
  }
  if (!stat.isDirectory()) throw new HttpError(404, 'not_found', 'run not found', { runId })
  return runDir(runId)
}

/**
 * One request, one connection, one line — the shipped client's contract
 * (src/control.js:164–167 resolves on the first line and never pipelines).
 *
 * Mapping, per §7.2's failure column:
 *   - ENOENT / ECONNREFUSED / timeout → `503 run_not_live` + `retryAfterMs`
 *   - any other transport failure (EACCES, a non-JSON reply line, …) → re-thrown, so
 *     http.js answers the §5.2 generic `500 internal`. See `isNotLive`.
 *   - `{error}` from the engine   → `409 conflict`, carrying the engine's own message
 *     (that is where "no live agent 3" and "no pending question q1" come from — the
 *     bridge must not paraphrase them, since the engine knows why and this file does not)
 *   - anything that is not `{ok:true}` → `409 conflict`, fail closed
 *
 * @param {string} runId
 * @param {{cmd: string} & Record<string, unknown>} request
 * @param {{timeoutMs?: number, requestFn?: typeof controlRequest}} [opts] `requestFn` is
 *   a seam for the timeout tests; production always uses `controlRequest`.
 * @returns {Promise<Record<string, unknown>>} the reply minus its correlation `id`
 */
export async function controlCommand(runId, request, { timeoutMs, requestFn = controlRequest } = {}) {
  const budget = timeoutMs ?? CONTROL_TIMEOUT_MS[request.cmd]
  // A command with no pinned budget would silently inherit controlRequest's 5000 ms,
  // which is the exact defect M13 raised. Refuse in-process instead of shipping it.
  if (!budget) throw new Error(`control command "${request.cmd}" has no pinned timeout (§7.2)`)

  let reply
  try {
    reply = await requestFn(socketPath(runId), request, budget)
  } catch (err) {
    if (isNotLive(err)) throw notLive(runId)
    throw err
  }
  if (reply && typeof reply === 'object' && typeof reply.error === 'string') {
    throw new HttpError(409, 'conflict', reply.error, { runId })
  }
  if (!reply || typeof reply !== 'object' || reply.ok !== true) {
    throw new HttpError(409, 'conflict', 'the run refused the command', { runId })
  }
  const { id, ...rest } = reply
  return rest
}

/** `{cmd:'status'}` at its own 300 ms budget — the liveness half of the bridge. */
export const controlStatus = (runId, opts) => controlCommand(runId, { cmd: 'status' }, opts)

// ---- the audit log (§7.3) -----------------------------------------------------------

/**
 * §7.3's audit line for one mutation: `{t, op, runId, outcome}` and nothing else — no
 * message bodies, no answer values, no transcript content, no agent output.
 *
 * **Every** mutation is recorded, not only the two lifecycle ops. §7.3's op union names
 * `resume|delete|cancel|args-read` and §7.2 argues that send/answer need no audit
 * because "the audit trail is the run itself" (they appear as `steered`/`mail`/`answer`
 * events in the run's own stream) — but that argument is the very one Sol-4 refuted for
 * delete, and it fails for send/answer for exactly the same reason: once the run is
 * trashed, its stream is gone and with it every trace of who steered a full-permission
 * agent process. The record carries no content, so this is strictly more evidence at
 * zero disclosure cost.
 *
 * TWO WRITE DISCIPLINES, and which one an op gets is the whole point:
 *
 *   `auditIntent` — **before** the mutation, and it **fails closed**. §7.3 states the
 *     ordering for delete ("append an audit line *before* the rename") and the reason
 *     generalises to every op §7.3's union names: an audit written afterwards is an
 *     audit that a crash, a full disk or a 0400 log file turns into a mutation with no
 *     record. The threat §7.4 books this against is "mistaken/stolen control credential
 *     → irreversible destruction, **evidence loss**"; a control channel that keeps
 *     cancelling runs and spawning resumes while its evidence sink is silently broken is
 *     precisely that defect. So `cancel` and `resume` (and `delete`, inside `removeRun`)
 *     do not happen unless the intent line is on disk first.
 *   `auditOutcome` — **after**, best effort. By then the engine has acted; throwing would
 *     report a failure for something that demonstrably happened, and the intent line
 *     already proves the operation was attempted.
 *
 * `send`/`answer` get the outcome line only. They are not in §7.3's op union, they are
 * not irreversible, and their authoritative trace is the run's own `steered`/`mail`/
 * `answer` event stream (§7.2) — so an unwritable log costs a bonus record, not the
 * ability to steer a live run. `cancel` is in the union and kills work; `resume` starts a
 * full-permission process. Those two pay the availability cost.
 */
function auditIntent(ctx, op, runId) {
  // Not optional-chained: `ctx.audit` is the single sink index.js installs (§7.3) and
  // routes.js already calls it unguarded. A ctx without one is a wiring bug, and the
  // fail-closed op must refuse rather than proceed unrecorded.
  if (typeof ctx.audit !== 'function') throw new Error(`no audit sink — refusing to ${op} unrecorded (§7.3)`)
  // A plain throw, not an HttpError: §5.2 requires the generic `500 internal` envelope
  // here, and http.js produces it (and hands the host a redacted diagnostic) for anything
  // that is not an HttpError. The operator learns the mutation did not happen; the reason
  // (a path, an errno on the audit file) stays out of the body.
  ctx.audit({ op, runId, outcome: 'attempt' })
}

function auditOutcome(ctx, op, runId, outcome, reason) {
  try {
    ctx.audit?.({ op, runId, outcome, ...(reason ? { reason } : {}) })
  } catch { /* the mutation already happened; the intent line is the durable record */ }
}

/**
 * Run one mutation, recording its outcome either way. Refusals are audited with their
 * §5.2 code as the reason (`conflict`, `run_not_live`, …) — never with the engine's
 * message, which can quote an agent label the operator typed.
 *
 * `intent: true` puts a fail-closed record on disk before `run()` is ever called — for
 * `cancel`, that is before one byte reaches the control socket.
 */
async function audited(ctx, op, runId, run, { intent = false } = {}) {
  if (intent) auditIntent(ctx, op, runId)
  let out
  try {
    out = await run()
  } catch (err) {
    if (err instanceof HttpError) auditOutcome(ctx, op, runId, 'refused', err.code)
    else auditOutcome(ctx, op, runId, 'error')
    throw err
  }
  auditOutcome(ctx, op, runId, 'ok')
  return out
}

// ---- send / answer / cancel ---------------------------------------------------------

/**
 * `POST /api/runs/:id/send {agent, message}` → `{cmd:'send', agent, message}`.
 *
 * The engine answers `{ok:true, delivery}` and emits `steered` + `mail` events
 * (src/engine.js:686–693). The verdict is surfaced verbatim: the composer shows
 * `live`/`queued`/`replayed` as delivered and renders `dropped` amber with "agent
 * already settled" (§7.2), and it can only do that if the server stops paraphrasing.
 */
export async function send(ctx, req, res, url, { route, body }) {
  const runId = route.runId
  const reply = await audited(ctx, 'send', runId, () => {
    requireRunDir(runId)
    return controlCommand(runId, { cmd: 'send', agent: body.agent, message: body.message })
  })
  sendJson(req, res, 200, {
    ok: true,
    runId,
    agent: body.agent,
    // Verbatim, including a verdict this build does not know (§6.5). Non-strings are
    // dropped rather than forwarded — a client rendering `[object Object]` into a status
    // chip is a worse failure than an absent verdict.
    delivery: typeof reply.delivery === 'string' ? reply.delivery : null,
  })
}

/**
 * `POST /api/runs/:id/answer {qid, value}` → `{cmd:'answer', qid, value}`.
 *
 * "No pending question" is a 409 from `controlCommand`'s `{error}` mapping — §7.2's
 * reading of it is *another operator answered first*, so the SPA refreshes its question
 * list rather than treating it as a failure of this operator's input.
 *
 * The answered value is never echoed back and never audited: it is operator input headed
 * for a full-permission agent, journaled by the engine, and §7.3 keeps values out of the
 * audit file.
 */
export async function answer(ctx, req, res, url, { route, body }) {
  const runId = route.runId
  await audited(ctx, 'answer', runId, () => {
    requireRunDir(runId)
    return controlCommand(runId, { cmd: 'answer', qid: body.qid, value: body.value })
  })
  sendJson(req, res, 200, { ok: true, runId, qid: body.qid })
}

/**
 * `POST /api/runs/:id/cancel` — per-agent when `agent` is present, whole-run when the
 * key is **absent**.
 *
 * critique N5 is the whole design of this handler: the engine reads `agent == null` as
 * "cancel the entire run" (src/engine.js:706–713), so a client whose local state was
 * empty and which posted `{agent: null}` would kill the run. `validateMutationBody`
 * rejects that body with a 400 before dispatch, and this handler reinforces it
 * structurally by branching on key *presence* and building two different requests —
 * the whole-run request simply has no `agent` key to misread. `{agent: undefined}` is
 * never sent: `JSON.stringify` would drop it, but relying on that is one refactor away
 * from a cancelled run.
 */
export async function cancel(ctx, req, res, url, { route, body }) {
  const runId = route.runId
  const scope = Object.prototype.hasOwnProperty.call(body, 'agent') ? 'agent' : 'run'
  const request = scope === 'agent' ? { cmd: 'cancel', agent: body.agent } : { cmd: 'cancel' }
  // `intent: true` — §7.3's op union names cancel, and a cancel that reached the socket
  // with no record on disk is the evidence loss §7.4 books. The intent line is written
  // (and fsync'd, src/viewer/audit.js) before `requireRunDir`, let alone before
  // `controlCommand`; if the log cannot be written, nothing is dispatched.
  const reply = await audited(ctx, 'cancel', runId, () => {
    requireRunDir(runId)
    return controlCommand(runId, request)
  }, { intent: true })
  sendJson(req, res, 200, {
    ok: true,
    runId,
    scope,
    // `job.index` for an agent, the string 'run' for a whole-run abort.
    cancelled: reply.cancelled ?? null,
  })
}

// ---- resume (§7.3) ------------------------------------------------------------------

/** `bin/flowition.js`, resolved from this module rather than from `process.cwd()`. */
const binPath = () => fileURLToPath(new URL('../../bin/flowition.js', import.meta.url))

/**
 * `POST /api/runs/:id/resume` — reproduces `detachResume` (src/mcp.js:136–143) exactly,
 * with §7.3's preconditions in front of it.
 *
 * Order matters and is the order §7.3 states:
 *
 *  1. the id through `runDir()` (already done by `validateRouteParams`) and the run
 *     directory must exist;
 *  2. `deriveRunState` ∈ {completed, failed, interrupted, stale} — running/starting is
 *     the `409 conflict` §7.2's table names, and so is any other verdict (`unknown` has
 *     no journal to resume, `corrupt-result` needs a human);
 *  3. a loadable journal `meta`, read-only and lossy — the engine refuses a meta-less
 *     journal (src/engine.js:789) and the launchers refuse it too (src/cli.js:139), so
 *     accepting one here would report `launchAccepted` for a launch certain to die;
 *  4. `run.log` opened for append **before** the marker: `'a'` opens a file and never
 *     creates a directory, so ENOENT means the run was deleted out from under this
 *     request (src/cli.js:150–153) — and there is deliberately no `ensureDir` anywhere
 *     on this path, which would resurrect `runs/<id>` inside a delete's rollback window;
 *  5. `installResumeMarker` — the shared handoff (src/run-lock.js). It is what makes
 *     this launch visible to a concurrent delete, and it throws if the run vanished
 *     mid-launch, so "resume accepted AND run deleted" is unreachable;
 *  6. spawn detached with `run.log` on both output fds, and `unref`.
 *
 * The response is `202 {runId, launchAccepted: true}`: **the launch was accepted, and
 * nothing more** (Sol-12). Preflight success or refusal — the engine's fileHash/
 * graphHash/args integrity gate, which the viewer neither adds to nor bypasses — arrives
 * afterwards through `sys`/`state` frames and the event stream.
 */
export async function resume(ctx, req, res, url, { route }) {
  const runId = route.runId
  // Step 0, before every check below and long before the spawn: the fail-closed intent
  // line (§7.3). A resume starts a detached, full-permission process; if it cannot be
  // recorded, it does not launch. Everything from here on appends outcome lines only.
  auditIntent(ctx, 'resume', runId)

  const refuse = (status, code, message) => {
    auditOutcome(ctx, 'resume', runId, 'refused', code)
    throw new HttpError(status, code, message, { runId })
  }

  let dir
  try {
    dir = requireRunDir(runId)
  } catch (err) {
    if (err instanceof HttpError) refuse(err.status, err.code, err.message)
    auditOutcome(ctx, 'resume', runId, 'error')
    throw err
  }

  const state = await deriveRunState(dir)
  if (!RESUMABLE.has(state.state)) {
    refuse(409, 'conflict', state.state === 'running' || state.state === 'starting'
      ? `run ${runId} is ${state.state} — cancel it before resuming`
      : `run ${runId} is ${state.state} and cannot be resumed (resumable states: ${RESUMABLE_STATES.join(', ')})`)
  }

  // Lossy and read-only (§5.1 principle 2): `readFirstJournalMeta` reads the first
  // complete line and never repairs the file. `Journal.load` — which the CLI launchers
  // use — is the strict, repairing reader, and the viewer must never be the process that
  // mutates a user's journal.
  let meta = null
  try {
    meta = readFirstJournalMeta(path.join(dir, 'journal.jsonl')).meta
  } catch {
    meta = null
  }
  if (!meta) refuse(409, 'conflict', `run ${runId} has no journal meta record — there is nothing to resume`)

  let logFd
  try {
    logFd = fs.openSync(path.join(dir, 'run.log'), 'a')
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      refuse(410, 'gone', `run ${runId} disappeared — it was deleted`)
    }
    auditOutcome(ctx, 'resume', runId, 'error')
    throw err
  }

  try {
    installResumeMarker(dir)
  } catch (err) {
    try { fs.closeSync(logFd) } catch { /* already closed */ }
    if (err instanceof RunLockError) {
      // 'vanished' is the only code this call produces, and it means exactly one thing:
      // the run was deleted while the handoff was being installed.
      refuse(410, 'gone', `run ${runId} disappeared while the resume was being launched — it was deleted`)
    }
    auditOutcome(ctx, 'resume', runId, 'error')
    throw err
  }

  // `ctx.spawnFn` is the test seam (the launch is otherwise unobservable without
  // actually running a workflow); production leaves it undefined.
  const spawnFn = ctx.spawnFn ?? spawn
  try {
    const child = spawnFn(process.execPath, [binPath(), 'resume', runId, '--json'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    })
    // Deliberately NOT mcp.js's `child.on('error')` handler, which writes a failed
    // `result.json` into the run directory: on the resume path that would CLOBBER the
    // terminal result of the run being replayed, destroying the very artifact the
    // operator asked to re-run. A spawn that never starts instead leaves the `.resuming`
    // marker to expire on its own 30 s budget (src/run-state.js:9), after which the run
    // reverts to the state it already had — degradation, not data loss. The marker is
    // not unlinked either: the name is shared, and removing it could revoke a *different*
    // launcher's accepted handoff.
    child?.on?.('error', () => auditOutcome(ctx, 'resume', runId, 'error', 'spawn_failed'))
    child?.unref?.()
  } catch (err) {
    auditOutcome(ctx, 'resume', runId, 'error')
    throw err
  } finally {
    try { fs.closeSync(logFd) } catch { /* already closed */ }
  }

  auditOutcome(ctx, 'resume', runId, 'ok')
  sendJson(req, res, 202, {
    runId,
    launchAccepted: true,
    // Which modal the operator confirmed, echoed so the SPA can reconcile optimistic UI
    // without re-deriving state: a completed run is a Replay, everything else a recover.
    mode: state.state === 'completed' ? 'replay' : 'resume',
    from: state.state,
  })
}

// ---- delete (§7.3) ------------------------------------------------------------------

/**
 * §5.2 codes are what `RetentionError` already carries (`retention.js` sets `code` to a
 * §5.2 `ErrorCode` precisely so this route needs no translation table), so this maps
 * code → status and nothing else.
 */
const DELETE_STATUS = { bad_request: 400, not_found: 404, conflict: 409 }

/**
 * `DELETE /api/runs/:id` — `removeRun()` and nothing else.
 *
 * There is no pre-check here, on purpose. Every guard §7.3 lists (symlink refusal,
 * realpath containment, the artifact requirement, the run lock held across the whole
 * operation, the re-derive under the lock, the resume-race rollback) is inside
 * `removeRun`, where it runs under the lock and against a pinned inode. Anything this
 * handler checked first would be a check taken outside that lock: it could only produce
 * a *different* answer from the authoritative one, which is how a TOCTOU is born.
 *
 * The audit line is `removeRun`'s too — `appendAudit` is called internally and cannot be
 * substituted by any argument a caller passes (§7.3), so a second line written here
 * would double-count every delete and, worse, imply this route is where the guarantee
 * lives.
 *
 * `internal` is rethrown raw rather than wrapped: §5.2 requires a generic 500 message,
 * and retention's internal messages name the trash and runs directories. http.js's
 * handler produces `{error:{code:'internal', message:'internal error'}}` and hands the
 * redacted diagnostic to the host.
 */
export async function deleteRun(ctx, req, res, url, { route }) {
  const runId = route.runId
  let removed
  try {
    removed = await removeRun(runId)
  } catch (err) {
    if (err instanceof RetentionError && DELETE_STATUS[err.code]) {
      throw new HttpError(DELETE_STATUS[err.code], err.code, err.message, { runId })
    }
    throw err
  }
  sendJson(req, res, 200, {
    ok: true,
    runId: removed.runId,
    // The trash ENTRY name, never the absolute path: it is what `flowition rm --purge`
    // and a manual restore need, and it discloses no filesystem layout (§5.2).
    trashEntry: path.basename(removed.trashPath),
    trashedAt: removed.trashedAt,
    trashTtlDays: TRASH_TTL_DAYS,
  })
}

/** The §5.3 mutation handlers, keyed by the route names in routes.js. */
export const CONTROL_HANDLERS = { send, answer, cancel, resume, deleteRun }
