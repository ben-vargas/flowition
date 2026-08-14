// Minimal MCP stdio server — lets any MCP-capable agent CLI drive flowition as a tool.
// Runs are started detached; callers poll flowition_status / flowition_result.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LineSplitter, runDir, ensureDir, shortId } from './util.js'
import { foldEvents } from './events.js'
import { controlRequest } from './control.js'
import { Journal } from './journal.js'
import { GUIDE } from './guide.js'
import { validate } from './schema.js'
import { deriveRunState, listRunIds } from './run-state.js'
import { installResumeMarker } from './run-lock.js'

const TOOLS = [
  {
    name: 'flowition_run',
    description: 'Start a flowition workflow (detached). Returns {runId}. Poll with flowition_status / flowition_result. Workflow files are plain-JS modules; call flowition_guide for the authoring contract.',
    inputSchema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', description: 'absolute path to a .workflow.js file' },
        args: { description: 'JSON args exposed to the workflow' },
        adapter: { type: 'string', description: 'default adapter: claude|codex|amp|droid|opencode|pi|cursor|grok' },
        model: { type: 'string' },
        effort: { type: 'string' },
        cwd: { type: 'string' },
        budget: { type: 'number', minimum: 0, description: 'output-token ceiling (non-negative integer)' },
        seedFrom: { type: 'string', minLength: 1, description: 'runId of a settled source run whose completed agent results seed this run as a cross-run cache (unchanged derived-key calls reuse them; edited calls run fresh)' },
      },
    },
  },
  { name: 'flowition_status', description: 'Snapshot of a run: phases, agents, pending questions, live steering info.', inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } } },
  { name: 'flowition_result', description: 'Final result of a run, optionally waiting for completion.', inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, waitSeconds: { type: 'number', minimum: 0, maximum: 3600 } } } },
  { name: 'flowition_send', description: 'Steer a live agent in a run (live-inject on claude/amp; queued follow-up turn elsewhere).', inputSchema: { type: 'object', required: ['runId', 'agent', 'message'], properties: { runId: { type: 'string' }, agent: { type: 'string' }, message: { type: 'string' } } } },
  { name: 'flowition_answer', description: 'Answer a pending workflow ask() question.', inputSchema: { type: 'object', required: ['runId', 'questionId', 'answer'], properties: { runId: { type: 'string' }, questionId: { type: 'string' }, answer: { type: 'string' } } } },
  { name: 'flowition_cancel', description: 'Cancel a whole run or a single agent.', inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, agent: { type: 'string' } } } },
  { name: 'flowition_resume', description: 'Resume an interrupted run (detached): completed agents replay from the journal, interrupted agents continue their provider sessions.', inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' } } } },
  { name: 'flowition_runs', description: 'List runs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'flowition_guide', description: 'The workflow authoring guide (DSL contract).', inputSchema: { type: 'object', properties: {} } },
]

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25']
const NEWEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]
const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

function launchDetached(runId, argv) {
  const logFd = fs.openSync(path.join(runDir(runId), 'run.log'), 'a')
  const binPath = fileURLToPath(new URL('../bin/flowition.js', import.meta.url))
  let child
  try {
    child = spawn(process.execPath, [binPath, ...argv], { detached: true, stdio: ['ignore', logFd, logFd], env: process.env })
  } finally {
    fs.closeSync(logFd)
  }
  child.on('error', (err) => {
    const result = { runId, status: 'failed', error: `failed to start detached run: ${err.message}` }
    // tmp+rename like the engine's finalize — a reader must never see a partial result.json
    try {
      const tmp = path.join(runDir(runId), `.result.json.${process.pid}.tmp`)
      fs.writeFileSync(tmp, JSON.stringify(result, null, 2))
      fs.renameSync(tmp, path.join(runDir(runId), 'result.json'))
    } catch { /* run dir unavailable */ }
  })
  child.unref()
}

function detach(argv) {
  const runId = shortId('flo')
  ensureDir(runDir(runId), 0o700)
  launchDetached(runId, [...argv, '--run-id', runId, '--quiet'])
  return runId
}

async function runSnapshot(runId) {
  const dir = runDir(runId)
  const snap = foldEvents(dir)
  const detail = await deriveRunState(dir)
  return {
    runId,
    ...detail,
    phases: snap.phases,
    agents: [...snap.agents.values()],
    steps: [...snap.steps.values()],
    questions: [...snap.questions.values()].filter((q) => !q.answered).map((q) => ({ qid: q.qid, question: q.question })),
  }
}

async function callTool(name, a) {
  switch (name) {
    case 'flowition_run': {
      const argv = ['run', a.file]
      if (a.args !== undefined) argv.push('--args', JSON.stringify(a.args))
      if (a.adapter) argv.push('--adapter', a.adapter)
      if (a.model) argv.push('--model', a.model)
      if (a.effort) argv.push('--effort', a.effort)
      if (a.cwd) argv.push('--cwd', a.cwd)
      if (a.budget != null) argv.push('--budget', String(a.budget))
      if (a.seedFrom !== undefined) argv.push('--seed-from', a.seedFrom)
      const runId = detach(argv)
      return { runId, note: 'detached; poll flowition_status / flowition_result' }
    }
    case 'flowition_resume': {
      let prior
      try { prior = Journal.load(runDir(a.runId)) } catch (err) { return { error: `cannot resume ${a.runId}: ${err.message}` } }
      if (!prior.meta) return { error: `no journal for ${a.runId}` }
      let runId2
      try { runId2 = detachResume(a.runId) } catch (err) { return { error: `cannot resume ${a.runId}: ${err.message}` } }
      return { runId: runId2 }
    }
    case 'flowition_status': return runSnapshot(a.runId)
    case 'flowition_result': {
      const deadline = Date.now() + (a.waitSeconds ?? 0) * 1000
      for (;;) {
        // deriveRunState (not a raw result.json read) so a crashed or corrupt run
        // resolves instead of reporting pending forever
        const st = await deriveRunState(runDir(a.runId))
        if (st.state === 'corrupt-result') return { error: `result.json is corrupt: ${st.error ?? 'unparseable'}` }
        if (st.result) return st.result
        if (st.state === 'stale') return { status: 'stale', error: 'engine heartbeat lost — the run likely crashed; try flowition_resume' }
        if (Date.now() >= deadline) return { status: 'pending', state: st.state, note: 'no result yet' }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    case 'flowition_send': return controlRequest(path.join(runDir(a.runId), 'control.sock'), { cmd: 'send', agent: a.agent, message: a.message }).catch((e) => ({ error: String(e.message) }))
    case 'flowition_answer': return controlRequest(path.join(runDir(a.runId), 'control.sock'), { cmd: 'answer', qid: a.questionId, value: a.answer }).catch((e) => ({ error: String(e.message) }))
    case 'flowition_cancel': return controlRequest(path.join(runDir(a.runId), 'control.sock'), { cmd: 'cancel', agent: a.agent }).catch((e) => ({ error: String(e.message) }))
    case 'flowition_runs': {
      // E14: same unfiltered listing as `flowition runs` — custom `--run-id` runs and
      // dirs still in their startup window are runs too
      const snapshots = await Promise.all(listRunIds().map((id) => runSnapshot(id)))
      return snapshots.map(({ agents, steps, phases, ...r }) => r)
    }
    case 'flowition_guide': return { guide: GUIDE }
    default: return { error: `unknown tool ${name}` }
  }
}

function detachResume(runId) {
  // Shared handoff protocol (§7.3, src/run-lock.js): the marker is what a concurrent
  // delete linearizes against, and installing it throws if the run was deleted out from
  // under this launch — so a resume is never reported as accepted for a run that is gone.
  installResumeMarker(runDir(runId))
  launchDetached(runId, ['resume', runId, '--json'])
  return runId
}

export function serveMcp() {
  const splitter = new LineSplitter()
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  const error = (id, code, message, data) => write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) =>
    splitter.push(chunk, async (line) => {
      let msg
      try { msg = JSON.parse(line) } catch {
        error(null, -32700, 'Parse error')
        return
      }
      const hasId = Object.prototype.hasOwnProperty.call(msg ?? {}, 'id')
      const validId = !hasId || msg.id === null || typeof msg.id === 'string' || (typeof msg.id === 'number' && Number.isFinite(msg.id))
      // JSON-RPC: params, when present, MUST be a structured value (object or array)
      const validParams = msg?.params === undefined || (typeof msg?.params === 'object' && msg?.params !== null)
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !validId || !validParams) {
        error(null, -32600, 'Invalid Request')
        return
      }
      const respond = (result) => {
        if (hasId) write({ jsonrpc: '2.0', id: msg.id, result })
      }
      if (msg.method === 'initialize') {
        if (msg.params !== undefined && (!msg.params || typeof msg.params !== 'object' || Array.isArray(msg.params))) {
          if (hasId) error(msg.id, -32602, 'Invalid params')
          return
        }
        const requested = msg.params?.protocolVersion
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : NEWEST_PROTOCOL_VERSION
        respond({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'flowition', version: '0.1.0' } })
      } else if (msg.method === 'ping') {
        respond({})
      } else if (msg.method === 'tools/list') {
        respond({ tools: TOOLS })
      } else if (msg.method === 'tools/call') {
        const params = msg.params
        const tool = params && typeof params === 'object' && !Array.isArray(params) ? TOOL_BY_NAME.get(params.name) : null
        if (!tool) {
          if (hasId) error(msg.id, -32602, 'Invalid params', { errors: ['unknown or missing tool name'] })
          return
        }
        const args = params.arguments === undefined ? {} : params.arguments
        const errors = validate(tool.inputSchema, args)
        if (tool.name === 'flowition_result' && args && typeof args === 'object' && args.waitSeconds !== undefined &&
            (!Number.isFinite(args.waitSeconds) || args.waitSeconds < 0 || args.waitSeconds > 3600)) {
          errors.push('$.waitSeconds: expected a finite number from 0 to 3600')
        }
        // mirror the CLI's integer constraint so a detached child can't die on
        // validation after MCP has already handed out a runId
        if (tool.name === 'flowition_run' && args && typeof args === 'object' && args.budget !== undefined &&
            (!Number.isInteger(args.budget) || args.budget < 0)) {
          errors.push('$.budget: expected an integer >= 0')
        }
        if (errors.length) {
          if (hasId) error(msg.id, -32602, 'Invalid params', { errors })
          return
        }
        try {
          const out = await callTool(tool.name, args)
          respond({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: !!out?.error })
        } catch (err) {
          respond({ content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true })
        }
      } else if (hasId) {
        error(msg.id, -32601, 'Method not found', { method: msg.method })
      }
      // notifications (no id) are ignored
    }),
  )
  return new Promise(() => {}) // serve until stdin closes / process killed
}
