import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runWorkflow, WorkflowError } from './engine.js'
import { Journal } from './journal.js'
import { foldEvents, renderEvent } from './events.js'
import { controlRequest } from './control.js'
import { getAdapter, listAdapters } from './adapters/index.js'
import { home, runsDir, runDir, ensureDir, readJsonl, shortId, fmtDuration } from './util.js'
import { deriveRunState } from './run-state.js'
import { GUIDE } from './guide.js'

const booleanFlags = new Set(['json', 'detach', 'follow', 'wait', 'quiet'])
const valueFlags = new Set(['args', 'args-file', 'adapter', 'model', 'effort', 'cwd', 'concurrency', 'budget', 'resume', 'run-id', 'agent', 'run'])
const isOption = (value) => value?.startsWith('--') || /^-[A-Za-z]/.test(value)

function parseFlags(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (booleanFlags.has(name)) { flags[name] = true; continue }
      if (!valueFlags.has(name)) throw new WorkflowError(`unknown option --${name}`)
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
  }
  ensureDir(runDir(runId), 0o700)
  const logFd = fs.openSync(path.join(runDir(runId), 'run.log'), 'a')
  const binPath = fileURLToPath(new URL('../bin/flowition.js', import.meta.url))
  const argv = [binPath, 'run', file, ...rawArgv.filter((a) => a !== '--detach')]
  if (!resumeId) argv.push('--run-id', runId)
  argv.push('--quiet')
  if (resumeId) {
    const marker = path.join(runDir(runId), '.resuming')
    const tmp = `${marker}.${process.pid}.tmp`
    fs.writeFileSync(tmp, String(Date.now()))
    fs.renameSync(tmp, marker)
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
      const outcome = await runWorkflow({ file, ...opts, resumeId: flags.resume, runId: flags['run-id'] })
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
      let ids = []
      try { ids = fs.readdirSync(runsDir()).filter((d) => d.startsWith('flo_')) } catch { /* none */ }
      const rows = (await Promise.all(ids.map(async (id) => {
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
      let readOffset = 0
      let pending = Buffer.alloc(0)
      const dump = () => {
        let fd
        try {
          fd = fs.openSync(file, 'r')
          const size = fs.fstatSync(fd).size
          if (size < readOffset) {
            readOffset = 0
            pending = Buffer.alloc(0)
          }
          if (size === readOffset) return
          const chunk = Buffer.allocUnsafe(size - readOffset)
          const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, readOffset)
          readOffset += bytesRead
          pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
        } catch {
          return
        } finally {
          if (fd != null) fs.closeSync(fd)
        }
        const end = pending.lastIndexOf(0x0a)
        if (end === -1) return
        const complete = pending.subarray(0, end + 1).toString('utf8')
        pending = Buffer.from(pending.subarray(end + 1))
        for (const line of complete.split('\n')) {
          if (!line.trim()) continue
          try {
            const out = render(JSON.parse(line))
            if (out) console.log(out)
          } catch { /* torn line */ }
        }
      }
      dump()
      if (flags.follow) {
        await new Promise(() => setInterval(dump, 400)) // ctrl-c to exit
      } else if (pending.length) {
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
  doctor                    check adapter CLIs
  guide                     print the workflow authoring guide (for agents)
  mcp                       serve flowition as an MCP stdio server`)
      return cmd ? 1 : 0
  }
}
