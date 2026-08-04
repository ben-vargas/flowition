import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runWorkflow, WorkflowError } from './engine.js'
import { Journal } from './journal.js'
import { foldEvents, renderEvent } from './events.js'
import { controlRequest } from './control.js'
import { getAdapter, listAdapters } from './adapters/index.js'
import { home, runDir, ensureDir, readJsonl, shortId, fmtDuration } from './util.js'
import { deriveRunState, listRunIds } from './run-state.js'
import { removeRun, pruneRuns, purgeTrash, RetentionError, TRASH_TTL_DAYS } from './retention.js'
import { installResumeMarker, RunLockError } from './run-lock.js'
import { GUIDE } from './guide.js'
import { ByteTail, drainTail } from './viewer/tail.js'

const booleanFlags = new Set(['json', 'detach', 'follow', 'wait', 'quiet', 'purge', 'idle-shutdown', 'open', 'print-url', 'no-viewer', 'stop'])
const valueFlags = new Set(['args', 'args-file', 'adapter', 'model', 'effort', 'cwd', 'concurrency', 'budget', 'resume', 'run-id', 'agent', 'run', 'older-than', 'port', 'idle-timeout'])
// `--control` is the one optional-value flag (DESIGN §4.2): bare enables every
// capability, `--control=send,cancel` a subset. It never consumes the next argv token,
// so `flowition viewer --control` cannot swallow a following option.
const optionalValueFlags = new Set(['control'])
const isOption = (value) => value?.startsWith('--') || /^-[A-Za-z]/.test(value)

function parseFlags(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
      const inline = eq === -1 ? undefined : a.slice(eq + 1)
      if (optionalValueFlags.has(name)) {
        // An optional-value flag never consumes the next token, so the space form
        // `--control answer` would parse as bare `--control` (= every capability) and
        // drop `answer` on the floor: an operator asking for one capability would be
        // handed all five, silently, on the write surface §7.2 exists to gate. Every
        // OTHER value flag here takes the space form, so that typing is the natural
        // mistake — and its error direction is always MORE privilege. Refuse it.
        const next = inline === undefined ? argv[i + 1] : undefined
        if (next !== undefined && !isOption(next)) {
          throw new WorkflowError(`option --${name} takes its value with '=' — write --${name}=${next}, not --${name} ${next} (bare --${name} enables every capability)`)
        }
        flags[name] = inline === undefined ? true : inline
        continue
      }
      if (booleanFlags.has(name)) {
        if (inline !== undefined) throw new WorkflowError(`option --${name} takes no value`)
        flags[name] = true
        continue
      }
      if (!valueFlags.has(name)) throw new WorkflowError(`unknown option --${name}`)
      if (inline !== undefined) {
        if (inline === '') throw new WorkflowError(`option --${name} requires a value`)
        flags[name] = inline
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || isOption(next)) throw new WorkflowError(`option --${name} requires a value`)
      flags[name] = next
      i++
    } else if (a === '-f') flags.follow = true
    else if (a === '-a') {
      const next = argv[i + 1]
      if (next === undefined || isOption(next)) throw new WorkflowError('option -a requires a value')
      flags.agent = next
      i++
    }
    else positional.push(a)
  }
  return { flags, positional }
}

const sock = (id) => path.join(runDir(id), 'control.sock')

// runDir() is the validation choke point but throws a plain Error; user-typed
// ids re-surface it as WorkflowError so bin/flowition.js prints clean, not a stack.
function checkRunId(id) {
  try { runDir(id) } catch (err) { throw new WorkflowError(err.message) }
  return id
}

// Args are stored verbatim (field omitted when none were given). Journals from
// before that change (no graphDynamic field) always wrote args:null for "none" —
// don't resurrect that null as an explicitly-passed value.
const metaArgs = (meta) => ('graphDynamic' in meta ? ('args' in meta ? meta.args : undefined) : meta.args ?? undefined)

async function ctl(id, req) {
  try {
    return await controlRequest(sock(id), req)
  } catch {
    return { error: `run ${id} is not live (no control socket) — it may have finished; try \`flowition status ${id}\`` }
  }
}

// One notion of run state everywhere: the CLI shares deriveRunState with MCP.
const runState = (id) => deriveRunState(runDir(id))

// Retention refusals are preconditions, not crashes — print them like every other
// user-facing precondition (bin/flowition.js prints WorkflowError without a stack).
async function retention(fn) {
  try { return await fn() } catch (err) {
    if (err instanceof RetentionError) throw new WorkflowError(err.message)
    throw err
  }
}

function integerOption(value, name, min) {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) throw new WorkflowError(`${name} must be an integer >= ${min}`)
  return n
}

function parseArgs(flags) {
  let args
  if (flags.args != null) {
    try { args = JSON.parse(flags.args) }
    catch (err) { throw new WorkflowError(`invalid --args JSON: ${err.message}`) }
  }
  if (flags['args-file'] != null) {
    let src
    try { src = fs.readFileSync(flags['args-file'], 'utf8') }
    catch (err) { throw new WorkflowError(`cannot read --args-file ${flags['args-file']}: ${err.message}`) }
    try { args = JSON.parse(src) }
    catch (err) { throw new WorkflowError(`invalid JSON in --args-file ${flags['args-file']}: ${err.message}`) }
  }
  return args
}

function collectRunOpts(flags) {
  return {
    args: parseArgs(flags),
    defaults: {
      adapter: flags.adapter ?? 'claude',
      model: flags.model,
      effort: flags.effort,
      cwd: flags.cwd ? path.resolve(flags.cwd) : process.cwd(),
    },
    concurrency: flags.concurrency != null ? integerOption(flags.concurrency, '--concurrency', 1) : undefined,
    budgetTotal: flags.budget != null ? integerOption(flags.budget, '--budget', 0) : undefined,
    quiet: !!flags.quiet || !!flags.json,
  }
}

function detachRun(file, rawArgv, resumeId) {
  const runId = resumeId ?? shortId('flo')
  if (resumeId) {
    let meta = null
    try { meta = Journal.load(runDir(resumeId)).meta } catch (err) { throw new WorkflowError(`cannot resume ${resumeId}: ${err.message}`) }
    if (!meta) throw new WorkflowError(`no journal for run ${resumeId}`)
    // Deliberately NO ensureDir on the resume path (§7.3.3): a recursive create here
    // would resurrect `runs/<id>` in the window after retention renamed it into the
    // trash — the delete's rollback would then find the name taken, and this launch
    // would report launchAccepted for a run that no longer exists. Only a new run
    // creates its own directory; a resume must find one.
  } else {
    ensureDir(runDir(runId), 0o700)
  }
  let logFd
  try { logFd = fs.openSync(path.join(runDir(runId), 'run.log'), 'a') } catch (err) {
    // 'a' opens a file, never creates a directory — so ENOENT here means the run was
    // deleted out from under the launch. Refuse rather than recreate.
    if (resumeId && err?.code === 'ENOENT') throw new WorkflowError(`cannot resume ${runId}: the run directory disappeared — the run was deleted`)
    throw err
  }
  const binPath = fileURLToPath(new URL('../bin/flowition.js', import.meta.url))
  const argv = [binPath, 'run', file, ...rawArgv.filter((a) => a !== '--detach')]
  if (!resumeId) argv.push('--run-id', runId)
  argv.push('--quiet')
  if (resumeId) {
    // The shared handoff (§7.3): installing the marker is what makes this launch visible
    // to a concurrent delete, and it refuses if the run vanished mid-launch — accepting a
    // resume against a deleted run is the one outcome the protocol must never produce.
    try { installResumeMarker(runDir(runId)) } catch (err) {
      try { fs.closeSync(logFd) } catch { /* already closed */ }
      if (err instanceof RunLockError) throw new WorkflowError(`cannot resume ${runId}: ${err.message}`)
      throw err
    }
  }
  const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', logFd, logFd], env: process.env })
  child.unref()
  return runId
}

export async function main(argv) {
  const [cmd, ...rest] = argv
  const { flags, positional } = parseFlags(rest)

  switch (cmd) {
    case 'run': {
      const file = positional[0]
      if (!file) { console.error('usage: flowition run <file.workflow.js> [--args <json>] [--adapter a] [--model m] [--effort e] [--concurrency N] [--budget N] [--resume <runId>] [--detach] [--json]'); return 1 }
      if (flags['run-id'] != null) checkRunId(flags['run-id'])
      if (flags.resume != null) checkRunId(flags.resume)
      const opts = collectRunOpts(flags)
      if (flags.detach) {
        const runId = detachRun(file, rest.filter((a) => a !== file), flags.resume)
        const out = { runId, detached: true, status: 'started', watch: `flowition tail ${runId} -f`, statusCmd: `flowition status ${runId}` }
        console.log(flags.json ? JSON.stringify(out) : `started detached run ${runId}\n  status: flowition status ${runId}\n  follow: flowition tail ${runId} -f`)
        return 0
      }
      if (flags.resume) {
        // Restore the journaled defaults so unspecified flags don't silently
        // change agent keys; explicit conflicting overrides are rejected by the
        // engine's defaults check. (The detach path above skips this — the
        // detached child re-enters this command and merges here itself.)
        let meta = null
        try { meta = Journal.load(runDir(flags.resume)).meta } catch (err) { throw new WorkflowError(`cannot resume ${flags.resume}: ${err.message}`) }
        if (!meta) throw new WorkflowError(`no journal for run ${flags.resume}`)
        opts.defaults = {
          adapter: flags.adapter ?? meta.defaults?.adapter ?? 'claude',
          model: flags.model ?? meta.defaults?.model,
          effort: flags.effort ?? meta.defaults?.effort,
          cwd: flags.cwd ? path.resolve(flags.cwd) : meta.defaults?.cwd ?? process.cwd(),
        }
        if (flags.args == null && flags['args-file'] == null) opts.args = metaArgs(meta)
      }
      // E16: the foreground run id is allocated HERE, not inside the engine, so it is
      // knowable before the run starts — §4.3's deep link cannot be printed by
      // something that only learns the id at completion. A resume keeps the prior id.
      const runId = flags.resume ?? flags['run-id'] ?? shortId('flo')
      if (!opts.quiet) console.error(`run ${runId}`)   // stderr: --json parsers read stdout
      // §4.3: discovery/spawn runs CONCURRENTLY with the run — it is started here and not
      // awaited, so it never blocks run startup — but the promise is retained and settled
      // before this command returns. Fire-and-forget would lose the race on any run
      // shorter than the spawn: bin/flowition.js calls process.exit the moment main()
      // resolves, killing the viewer handshake before it has written viewer.json or
      // printed anything. The gate (TTY, no --detach/--json/--quiet, no --no-viewer) lives
      // in shouldAutoStart so there is one definition of it. Nothing is printed unless the
      // challenge probe proved a live viewer (parity #34), and a viewer failure is never
      // allowed to affect the run's outcome.
      const viewerLink = import('./viewer/index.js').then(async (viewer) => {
        if (!viewer.shouldAutoStart({ flags, isTTY: !!process.stderr.isTTY })) return
        const found = await viewer.autoStartViewer(runId)
        if (found) console.error(`view: ${found.url}`)
      }).catch(() => { /* the viewer is an observer; it never breaks a run */ })
      const outcome = await runWorkflow({ file, ...opts, resumeId: flags.resume, runId })
      // Awaited before the outcome is printed, so the link always precedes the result
      // block — the same order a long run produces. The wait is bounded by
      // AUTOSTART_TIMEOUT_MS (5 s) and only ever happens on a TTY-attended foreground run
      // whose workflow finished faster than its viewer could start.
      await viewerLink
      if (flags.json) console.log(JSON.stringify(outcome))
      else {
        console.log(`\nrun ${outcome.runId}: ${outcome.status}`)
        if (outcome.status === 'completed') console.log(typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result, null, 2))
        else console.log(outcome.error)
        if (outcome.status !== 'completed') console.log(`resume with: flowition resume ${outcome.runId}`)
      }
      return outcome.status === 'completed' ? 0 : 1
    }

    case 'resume': {
      const runId = positional[0]
      if (!runId) { console.error('usage: flowition resume <runId> [--json]'); return 1 }
      checkRunId(runId)
      for (const f of ['adapter', 'model', 'effort', 'cwd', 'args', 'args-file']) {
        if (flags[f] != null) throw new WorkflowError(`resume restores the journaled --${f}; overrides are not applied here — use \`flowition run <file> --resume ${runId} --${f} ...\` (validated by the engine) or omit the flag`)
      }
      const concurrency = flags.concurrency != null ? integerOption(flags.concurrency, '--concurrency', 1) : undefined
      const budgetTotal = flags.budget != null ? integerOption(flags.budget, '--budget', 0) : undefined
      let prior
      try { prior = Journal.load(runDir(runId)) } catch (err) { throw new WorkflowError(`cannot resume ${runId}: ${err.message}`) }
      if (!prior.meta) { console.error(`no journal for run ${runId}`); return 1 }
      const opts = {
        args: metaArgs(prior.meta),
        defaults: prior.meta.defaults ?? { adapter: 'claude' },
        quiet: !!flags.json,
        concurrency,
        budgetTotal,
      }
      const outcome = await runWorkflow({ file: prior.meta.workflowFile, ...opts, resumeId: runId })
      console.log(flags.json ? JSON.stringify(outcome) : `\nrun ${outcome.runId}: ${outcome.status}\n` + (outcome.status === 'completed' ? (typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result, null, 2)) : outcome.error))
      return outcome.status === 'completed' ? 0 : 1
    }

    case 'runs': {
      // E14: unfiltered — a run started with `--run-id my-audit` is a run
      const rows = (await Promise.all(listRunIds().map(async (id) => {
        // one corrupt journal must not take down the whole listing
        let meta = null
        let corrupt = false
        try { meta = Journal.load(runDir(id)).meta } catch { corrupt = true }
        const st = corrupt ? { state: 'corrupt' } : await runState(id)
        return { runId: id, state: st.state, file: meta ? path.basename(meta.workflowFile) : '?', createdAt: meta?.createdAt ?? 0 }
      }))).sort((a, b) => b.createdAt - a.createdAt)
      if (flags.json) console.log(JSON.stringify(rows))
      else for (const r of rows) console.log(`${r.runId}  ${r.state.padEnd(11)} ${r.file}  ${r.createdAt ? new Date(r.createdAt).toISOString() : ''}`)
      return 0
    }

    case 'status': {
      const id = positional[0]
      if (!id) { console.error('usage: flowition status <runId> [--json]'); return 1 }
      checkRunId(id)
      const snap = foldEvents(runDir(id))
      const st = await runState(id)
      const liveInfo = st.state === 'running' ? await ctl(id, { cmd: 'status' }) : null
      if (flags.json) {
        console.log(JSON.stringify({
          runId: id,
          state: st.state,
          result: st.result ?? null,
          phases: snap.phases,
          agents: [...snap.agents.values()],
          steps: [...snap.steps.values()],
          questions: [...snap.questions.values()].filter((q) => !q.answered),
          live: liveInfo?.ok ? liveInfo : null,
        }))
        return 0
      }
      console.log(`run ${id} — ${st.state}${snap.run?.name ? ` (${snap.run.name})` : ''}`)
      if (snap.phases.length) console.log(`phase: ${snap.phases[snap.phases.length - 1]}`)
      for (const a of [...snap.agents.values()].sort((x, y) => x.index - y.index)) {
        const who = [a.adapter, a.model].filter(Boolean).join(':')
        const dur = a.durationMs != null ? ` ${fmtDuration(a.durationMs)}` : ''
        console.log(`  [${a.index}] ${(a.label ?? '').padEnd(20)} ${who.padEnd(24)} ${a.state}${dur}${a.error ? ' — ' + a.error : ''}`)
      }
      for (const s of snap.steps.values()) {
        const dur = s.durationMs != null ? ` ${fmtDuration(s.durationMs)}` : ''
        console.log(`  ⚙ ${(s.name ?? '').padEnd(22)} ${'step'.padEnd(24)} ${s.state}${dur}${s.error ? ' — ' + s.error : ''}`)
      }
      for (const q of [...snap.questions.values()].filter((q) => !q.answered)) {
        console.log(`  ? ${q.qid}: ${q.question}   → flowition answer ${id} ${q.qid} "<text>"`)
      }
      if (liveInfo?.ok) {
        for (const a of liveInfo.agents) if (a.queuedMail) console.log(`  ✉ [${a.index}] ${a.queuedMail} queued message(s)`)
        console.log(`  spent: ${liveInfo.spentOutputTokens} output tokens`)
      }
      if (st.result && st.state === 'completed') console.log('result: ' + JSON.stringify(st.result.result).slice(0, 400))
      return 0
    }

    case 'tail': {
      const id = positional[0]
      if (!id) { console.error('usage: flowition tail <runId> [--agent N] [-f] [--json]'); return 1 }
      checkRunId(id)
      const file = flags.agent != null
        ? path.join(runDir(id), 'agents', `${flags.agent}.jsonl`)
        : path.join(runDir(id), 'events.jsonl')
      const render = (rec) => {
        if (flags.json) return JSON.stringify(rec)
        if (flags.agent != null) {
          if (rec.kind === 'text') return `┃ ${rec.text}`
          if (rec.kind === 'reasoning') return `· (thinking) ${String(rec.text).slice(0, 200)}`
          if (rec.kind === 'tool') return `⚒ ${rec.name} ${String(rec.input ?? '').slice(0, 160)}`
          if (rec.kind === 'tool-result') return `  ↳ ${String(rec.output ?? '').slice(0, 160)}`
          if (rec.kind === 'mail-in') return `✉ IN: ${rec.text}`
          if (rec.kind === 'status') return `― ${rec.text}`
          if (rec.kind === 'meta') return `▶ agent [${rec.index}] ${rec.adapter}${rec.model ? ':' + rec.model : ''}`
          return null
        }
        return renderEvent(rec)
      }
      const tail = new ByteTail()
      let dumping = null
      const dump = async () => {
        if (dumping) return dumping
        dumping = (async () => {
          let handle
          try {
            handle = await fs.promises.open(file, 'r')
            const stat = await handle.stat()
            tail.observe({ size: stat.size, dev: stat.dev, ino: stat.ino })
            if (stat.size === tail.readOffset) return
            await drainTail(handle, tail, {
              onLine: ({ bytes }) => {
                if (!bytes.toString('utf8').trim()) return
                try {
                  const out = render(JSON.parse(bytes.toString('utf8')))
                  if (out) console.log(out)
                } catch { /* corrupt complete line: observer stays lossy */ }
              },
            })
          } catch {
            return
          } finally {
            await handle?.close()
          }
        })()
        try { await dumping } finally { dumping = null }
      }
      await dump()
      if (flags.follow) {
        await new Promise(() => setInterval(() => { void dump() }, 400)) // ctrl-c to exit
      } else {
        const pending = tail.pendingBytes()
        if (!pending.length) return 0
        try {
          const out = render(JSON.parse(pending.toString('utf8')))
          if (out) console.log(out)
        } catch { /* torn line */ }
      }
      return 0
    }

    case 'send': {
      const [id, agent, ...msg] = positional
      if (!id || agent == null || !msg.length) { console.error('usage: flowition send <runId> <agentIndex|label> <message…>'); return 1 }
      checkRunId(id)
      const res = await ctl(id, { cmd: 'send', agent, message: msg.join(' ') })
      console.log(JSON.stringify(res))
      return res.ok ? 0 : 1
    }

    case 'answer': {
      const [id, qid, ...val] = positional
      if (!id || !qid || !val.length) { console.error('usage: flowition answer <runId> <questionId> <answer…>'); return 1 }
      checkRunId(id)
      const res = await ctl(id, { cmd: 'answer', qid, value: val.join(' ') })
      console.log(JSON.stringify(res))
      return res.ok ? 0 : 1
    }

    case 'cancel': {
      const id = positional[0]
      if (!id) { console.error('usage: flowition cancel <runId> [--agent N]'); return 1 }
      checkRunId(id)
      const res = await ctl(id, { cmd: 'cancel', agent: flags.agent })
      console.log(JSON.stringify(res))
      return res.ok ? 0 : 1
    }

    case 'post': {
      // agents call this to report progress upward: flowition post "message" (env supplies run/agent)
      const id = flags.run ?? process.env.FLOWITION_RUN_ID
      const agent = flags.agent ?? process.env.FLOWITION_AGENT_INDEX
      const msg = positional.join(' ')
      if (!id || !msg) { console.error('usage: flowition post [--run <runId>] [--agent N] <message…>  (env FLOWITION_RUN_ID/FLOWITION_AGENT_INDEX used as defaults)'); return 1 }
      checkRunId(id)
      const res = await ctl(id, { cmd: 'post', agent, message: msg })
      console.log(JSON.stringify(res))
      return res.ok ? 0 : 1
    }

    case 'result': {
      const id = positional[0]
      if (!id) { console.error('usage: flowition result <runId> [--wait [seconds]]'); return 1 }
      checkRunId(id)
      const waitSeconds = flags.wait
        ? positional[1] == null ? 3600 : integerOption(positional[1], '--wait', 0)
        : 0
      const deadline = Date.now() + waitSeconds * 1000
      for (;;) {
        const st = await runState(id)
        if (st.result) { console.log(JSON.stringify(st.result, null, flags.json ? 0 : 2)); return st.result.status === 'completed' ? 0 : 1 }
        if (st.state === 'stale' || st.state === 'corrupt-result') { console.error(`run ${id}: ${st.state}${st.error ? ' — ' + st.error : ''}`); return 1 }
        if (Date.now() >= deadline) { console.error(`run ${id}: ${st.state}, no result yet`); return 1 }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    case 'rm': {
      const id = positional[0]
      if (!id && !flags.purge) { console.error(`usage: flowition rm <runId> [--purge] [--json]   (moves the run to ${home()}/trash; purged after ${TRASH_TTL_DAYS} days — --purge empties the trash now)`); return 1 }
      const out = { removed: null, purged: [] }
      if (id) {
        checkRunId(id)
        // There is no audit-writer argument to pass, by design: retention.js calls the
        // shared 0600 writer itself (§7.3), so no caller — CLI or viewer — can reach the
        // destructive path without a record, and a delete that cannot be recorded fails
        // instead of happening.
        out.removed = await retention(() => removeRun(id))
      }
      // --purge is "empty the trash", not "skip the trash": the run just removed goes
      // through the same guarded rename first and is then purged with everything else.
      if (flags.purge) out.purged = purgeTrash({ olderThanMs: 0 }).purged
      if (flags.json) console.log(JSON.stringify(out))
      else {
        if (out.removed) console.log(`removed ${out.removed.runId} → ${out.removed.trashPath}`)
        if (flags.purge) console.log(`purged ${out.purged.length} trash entr${out.purged.length === 1 ? 'y' : 'ies'}`)
      }
      return 0
    }

    case 'prune': {
      const olderThanDays = flags['older-than'] != null ? integerOption(flags['older-than'], '--older-than', 0) : undefined
      if (olderThanDays == null && !flags.purge) { console.error(`usage: flowition prune [--older-than <days>] [--purge] [--json]   (trashes terminal runs older than <days>; purges trash entries older than ${TRASH_TTL_DAYS} days, or all of them with --purge)`); return 1 }
      const out = await retention(() => pruneRuns({ olderThanDays, ...(flags.purge ? { trashTtlDays: 0 } : {}) }))
      if (flags.json) console.log(JSON.stringify(out))
      else {
        for (const r of out.removed) console.log(`removed ${r.runId} → ${r.trashPath}`)
        for (const s of out.skipped) console.log(`skipped ${s.runId}: ${s.message}`)
        console.log(`${out.removed.length} run(s) trashed, ${out.purged.length} trash entr${out.purged.length === 1 ? 'y' : 'ies'} purged`)
      }
      return 0
    }

    case 'viewer': {
      // §4.2: `viewer` is flags-only. Silently ignoring a positional is how
      // `--control=send answer` reads as "answer was accepted" when it was discarded —
      // the same class of failure as the space form above, so refuse it here too.
      if (positional.length) throw new WorkflowError(`viewer takes no arguments (got "${positional[0]}") — capabilities are a '=' list: --control=send,answer`)
      // The server is a leaf: imported lazily so `flowition run` never pays for it.
      const viewer = await import('./viewer/index.js')
      const { parseCapabilities, CAPABILITIES } = await import('./viewer/auth.js')
      const port = flags.port != null ? integerOption(flags.port, '--port', 0) : undefined
      const idleTimeoutMinutes = flags['idle-timeout'] != null ? integerOption(flags['idle-timeout'], '--idle-timeout', 1) : undefined
      let capabilities
      try { capabilities = parseCapabilities(flags.control) } catch (err) { throw new WorkflowError(err.message) }

      // Reprinting or reusing an instance is only ever done on the evidence of the
      // §4.2.1 authenticated probe — never on an unauthenticated /healthz shape, which
      // any local user could mimic on the predictable port to harvest the token (Sol-2).
      //
      // `--open` is safe on the short-lived paths (`--print-url`, and a reuse, both of
      // which announce and exit while `bin/flowition.js` calls `process.exit`): the 0600
      // bootstrap file's deletion is delegated to a detached process, so it outlives this
      // command by exactly its grace period and no longer (§4.2, and the note on
      // `scheduleBootstrapCleanup`).
      const announce = (url, extra) => {
        if (flags.json) console.log(JSON.stringify({ url, ...extra }))
        else console.error(viewer.startupLine(url))
        if (flags.open) viewer.openInBrowser(url)
      }

      // §7.1.2: a token file other local users could read is burned, so it is revoked and
      // replaced rather than repaired — which invalidates every URL printed from it and stops
      // any viewer still serving it. Saying so is the difference between "my old link stopped
      // working" and a silent credential change. The notice never carries a token value.
      const onRotate = (info) => console.error(`viewer: ${info.reason} (${info.file} was mode ${info.mode}) — previously printed URLs no longer work`)

      if (flags.stop) {
        // --stop is an action, not a modifier: every other viewer flag starts or
        // describes an instance, so a combination would mean two things at once — the
        // same silent-ambiguity class as the `--control answer` space form above.
        const others = Object.keys(flags).filter((name) => name !== 'stop' && name !== 'json')
        if (others.length) throw new WorkflowError(`--stop stops the live viewer for this home and takes no other viewer flags (got --${others[0]})`)
        let result
        try {
          result = await viewer.stopViewer({ onRotate })
        } catch (err) {
          throw err instanceof WorkflowError ? err : new WorkflowError(err.message)
        }
        if (!result.stopped) {
          console.error(result.reason ?? 'no live flowition viewer for this home')
          return 1
        }
        if (flags.json) console.log(JSON.stringify({ stopped: true, pid: result.pid, port: result.port, home: home(), rendezvousRemoved: result.rendezvousRemoved }))
        else console.error(`viewer: stopped (pid ${result.pid}, port ${result.port})${result.rendezvousRemoved ? '' : ` — it exited without removing its rendezvous file; the stale record is harmless (discovery fails closed) but unexpected`}`)
        return 0
      }

      if (flags['print-url']) {
        // Discovery reads (and may create) `viewer.token` inside the home, so it is gated
        // by the same §4.1 platform + ownership assertion as starting a server — a foreign
        // home refuses here, it does not report "nothing is live". Preconditions print
        // clean, like every other viewer refusal below.
        let found
        try {
          found = await viewer.discoverViewer({ onRotate })
        } catch (err) {
          throw err instanceof WorkflowError ? err : new WorkflowError(err.message)
        }
        if (!found) {
          console.error('no live flowition viewer for this home — start one with `flowition viewer`')
          return 1
        }
        // The control token is ephemeral and in-memory (§7.1.2), so a reprinted URL is
        // read-only by construction even against a --control instance: restart the
        // viewer to mint a new one (§13.3).
        announce(viewer.viewerUrl({ port: found.port, token: found.token }), { port: found.port, home: home(), control: found.control })
        return 0
      }

      // An explicit --port means "bind this one"; otherwise a live instance for this home
      // is reused rather than starting a second server (§13.7). Discovery and binding run
      // inside the per-home startup lock (`startOrReuseViewer`), so two `flowition viewer`
      // commands racing cannot both read "no instance" and both bind.
      //
      // --control cannot be satisfied by reuse, and the capability list in viewer.json is
      // NOT evidence to the contrary. The control token is 32 bytes minted in the live
      // process's memory and never persisted (§7.1.2), so a reusing caller cannot know it:
      // reusing a control-capable instance would print a `t=`-only URL that silently
      // cannot mutate, and starting an implicit second server would overwrite the
      // rendezvous file and break one-viewer-per-home (§13.2/§13.7). Both are worse than
      // saying so. Restarting the viewer is also the documented way to rotate the control
      // token (§13.3), so the refusal points at exactly the right action.
      let finish
      const stopped = new Promise((resolve) => { finish = resolve })
      let started
      try {
        started = await viewer.startOrReuseViewer({
          onRotate,
          port,
          explicitPort: port != null,
          onReuseRefused: (found) => {
            if (!capabilities.length) return
            throw new WorkflowError(
              `a flowition viewer is already serving this home on port ${found.port}${found.pid ? ` (pid ${found.pid})` : ''}, and its control token exists only in that process's memory — `
              + `--control cannot attach to it.\n`
              + `  stop it and start again with control:  ${found.pid ? `kill ${found.pid} && ` : ''}flowition viewer --control${capabilities.length === CAPABILITIES.length ? '' : '=' + capabilities.join(',')}\n`
              + `  or run a second, separate instance:    flowition viewer --port <N> --control${capabilities.length === CAPABILITIES.length ? '' : '=' + capabilities.join(',')}`)
          },
          control: flags.control,
          idleShutdown: !!flags['idle-shutdown'],
          idleTimeoutMs: idleTimeoutMinutes != null ? idleTimeoutMinutes * 60_000 : undefined,
          accessLog: process.env.FLOWITION_VIEWER_LOG === '1' ? (line) => console.error(`viewer: ${line}`) : undefined,
          // http.js redacts the read and control tokens (and any `?token=`/`t=`/`c=`
          // query value) out of this diagnostic before handing it over — §7.1.7 forbids a
          // credential in any log line, and stderr is a log line.
          onInternalError: (err) => console.error(`viewer: internal error — ${err?.message ?? err}`),
          // §7.1.2/§7.4: the credential is a live invariant, so this instance stops serving
          // the moment its token file stops being the 0600 file it was started from. That is a
          // failure the operator has to see — the URL they are holding is dead — so it is
          // announced and the command exits non-zero.
          onCredentialRevoked: (why) => console.error(`viewer: ${why} — this instance has stopped serving; start the viewer again to mint a fresh token`),
          onShutdown: (reason) => finish(reason),
        })
      } catch (err) {
        // Every startup failure is a precondition (win32, foreign home, bad --control,
        // no free port, or the --control-cannot-attach refusal above) — print it clean,
        // not as a stack.
        throw err instanceof WorkflowError ? err : new WorkflowError(err.message)
      }

      if (started.reused) {
        announce(started.url, { port: started.port, home: home(), control: started.control, reused: true })
        return 0
      }
      const instance = started
      announce(instance.url, { port: instance.port, home: instance.home, control: instance.control })

      // SIGINT/SIGTERM close the server and exit; the library layer never calls
      // process.exit itself (parity #29).
      const stop = () => { instance.close().then(() => finish(), () => finish()) }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      // A revoked credential is a failure exit: the server is gone and the printed URL is
      // dead. An idle shutdown or a signal is a clean one.
      return (await stopped) === 'credential-revoked' ? 1 : 0
    }

    case 'doctor': {
      console.log(`flowition home: ${home()}`)
      for (const name of listAdapters()) {
        if (name === 'mock') continue
        const a = getAdapter(name)
        const bin = a.bin()
        const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 })
        const ok = res.status === 0
        console.log(`  ${name.padEnd(9)} ${ok ? 'ok  ' : 'MISSING'} ${bin}${ok ? ` (${(res.stdout || res.stderr || '').trim().split('\n')[0]})` : ''} — steer:${a.caps.steer} resume:${a.caps.resume} schema:${a.caps.schema}`)
        if (name === 'amp' && ok) {
          const { discoverAmpModes } = await import('./adapters/index.js')
          const modes = discoverAmpModes()
          const custom = modes.filter((m) => !m.builtin)
          console.log(`            modes: ${modes.filter((m) => m.builtin).map((m) => m.key).join('/')}${custom.length ? ' + ' + custom.map((m) => `${m.key} ("${m.label}")`).join(', ') : ''}`)
        }
      }
      return 0
    }

    case 'guide': {
      console.log(GUIDE)
      return 0
    }

    case 'mcp': {
      const { serveMcp } = await import('./mcp.js')
      await serveMcp()
      return 0
    }

    default:
      console.log(`flowition — deterministic multi-CLI agent workflow engine (short alias: flo)
commands:
  run <file> [--args json] [--adapter a] [--model m] [--effort e] [--concurrency N] [--budget N] [--resume id] [--detach] [--json]
  resume <runId>            continue an interrupted run (journal replay + provider-session resume)
  runs                      list runs
  status <runId> [--json]   fold the event stream into a snapshot
  tail <runId> [--agent N] [-f]   follow the run narrative or one agent's transcript
  send <runId> <agent> <msg…>     steer a live agent (live-inject or queued follow-up turn)
  answer <runId> <qid> <text…>    answer a workflow ask()
  cancel <runId> [--agent N]      cancel one agent or the whole run
  post [--run id] [--agent N] <msg…>  agent→orchestrator progress report (env-aware)
  result <runId> [--wait [s]]     print (or wait for) the final result
  rm <runId> [--purge]      move a run to the trash (recoverable for ${TRASH_TTL_DAYS} days; --purge empties the trash)
  prune [--older-than N]    trash terminal runs older than N days + purge aged trash
  viewer [--port N] [--control[=send,answer,cancel,resume,delete]] [--open] [--print-url] [--stop] [--json]
                            serve the local run viewer on 127.0.0.1 (read-only unless --control);
                            --stop stops this home's registered instance
  doctor                    check adapter CLIs
  guide                     print the workflow authoring guide (for agents)
  mcp                       serve flowition as an MCP stdio server`)
      return cmd ? 1 : 0
  }
}
