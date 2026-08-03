// W13's one product-spine test (DESIGN §11.4).
//
// Nothing in this file substitutes a route, a control handler, or an engine writer. A
// real mock-adapter workflow owns a real run lock/control socket while the shipped viewer
// is driven over loopback HTTP and SSE.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'flo-e2e-'))
process.env.FLOWITION_HOME = HOME

const { runWorkflow } = await import('../src/engine.js')
const { startViewer } = await import('../src/viewer/index.js')

const RUNS = path.join(HOME, 'runs')
const TRASH = path.join(HOME, 'trash')
const ORIGIN = (viewer) => `http://127.0.0.1:${viewer.port}`

function writeWorkflow(name, source) {
  const dir = path.join(HOME, 'workflows')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')
  const file = path.join(dir, `${name}.workflow.js`)
  fs.writeFileSync(file, source)
  return file
}

function request(viewer, {
  method = 'GET',
  target = '/',
  body,
  control = false,
} = {}) {
  const encoded = body === undefined ? null : JSON.stringify(body)
  const headers = {
    host: `127.0.0.1:${viewer.port}`,
    authorization: `Bearer ${viewer.token}`,
    ...(control ? {
      origin: ORIGIN(viewer),
      'content-type': 'application/json',
      'x-flowition-control': viewer.controlToken,
    } : {}),
    ...(encoded == null ? {} : { 'content-length': String(Buffer.byteLength(encoded)) }),
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: viewer.port,
      method,
      path: target,
      headers,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* SSE/static responses are not JSON */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers })
      })
    })
    req.once('error', reject)
    if (encoded != null) req.end(encoded)
    else req.end()
  })
}

const read = (viewer, target) => request(viewer, { target })
const post = (viewer, target, body = {}) =>
  request(viewer, { method: 'POST', target, body, control: true })
const remove = (viewer, runId) =>
  request(viewer, { method: 'DELETE', target: `/api/runs/${runId}`, body: {}, control: true })

async function eventually(readValue, predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await readValue()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}; last value:\n${JSON.stringify(last, null, 2)}`)
}

function connectSse(viewer, runId, agent) {
  const frames = []
  let buffer = ''
  const req = http.get({
    host: '127.0.0.1',
    port: viewer.port,
    path: `/api/runs/${runId}/stream?token=${encodeURIComponent(viewer.token)}&streams=&agents=${agent}`,
    headers: { host: `127.0.0.1:${viewer.port}` },
  })
  const ready = new Promise((resolve, reject) => {
    req.once('error', reject)
    req.once('response', (res) => {
      assert.equal(res.statusCode, 200)
      assert.match(res.headers['content-type'], /^text\/event-stream/)
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        for (;;) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary === -1) break
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (!block || block.startsWith(':')) continue
          const frame = {}
          for (const line of block.split('\n')) {
            const colon = line.indexOf(':')
            if (colon === -1) continue
            const key = line.slice(0, colon)
            const value = line.slice(colon + 1).replace(/^ /, '')
            if (key === 'data') frame.data = (frame.data ?? '') + value
            else frame[key] = value
          }
          if (frame.data) frame.json = JSON.parse(frame.data)
          frames.push(frame)
        }
      })
      resolve(res)
    })
  })
  return {
    frames,
    ready,
    close: () => req.destroy(),
    async waitFor(predicate, label, timeoutMs = 8_000) {
      return eventually(() => Promise.resolve(frames), predicate, label, timeoutMs)
    },
  }
}

const batchRecords = (frames) =>
  frames.filter((frame) => frame.event === 'batch').flatMap((frame) => frame.json?.f ?? [])

test('viewer spine: observe → act → outcome over real HTTP, SSE, control, and trash', { timeout: 30_000 }, async (t) => {
  t.after(() => fs.rmSync(HOME, { recursive: true, force: true }))
  const spineFile = writeWorkflow('spine', `
export const meta = {
  name: 'viewer e2e spine',
  description: 'parallel, pipeline, phases, ask and workflow steering',
  phases: [{ title: 'Fan out' }, { title: 'Pipeline' }, { title: 'Approval' }],
}
export default async function ({ agent, spawn, parallel, pipeline, phase, ask, sendTo }) {
  phase('Fan out')
  const listener = spawn('SLEEP 450\\nWAIT_MAIL', { adapter: 'mock', label: 'listener' })
  const parallelResults = await parallel([1, 2, 3].map((n) => () =>
    agent(\`SLEEP 140\\nTOOL read-\${n}\\nECHO parallel-\${n}\`, {
      adapter: 'mock', label: \`parallel-\${n}\`,
    })))
  const delivery = sendTo('listener', 'steered by the workflow')
  const steeredResult = await listener.done
  phase('Pipeline')
  const pipelineResults = await pipeline(
    ['a', 'b'],
    (item) => agent(\`SLEEP 60\\nECHO stage-1-\${item}\`, { adapter: 'mock' }),
    (previous, item) => agent(\`SLEEP 60\\nECHO stage-2-\${previous}-\${item}\`, { adapter: 'mock' }),
  )
  phase('Approval')
  const answer = await ask('Ship the viewer?', { id: 'ship' })
  return { parallelResults, pipelineResults, delivery, steeredResult, answer }
}
`)
  const runId = 'flo_e2e_spine'
  const completion = runWorkflow({
    file: spineFile,
    runId,
    defaults: { adapter: 'mock', cwd: process.cwd() },
    concurrency: 2,
    quiet: true,
  })

  const viewer = await startViewer({ port: 0, primary: false, control: true })
  const readOnly = await startViewer({ port: 0, primary: false })
  viewer.unref()
  readOnly.unref()
  t.after(async () => {
    await Promise.allSettled([
      post(viewer, `/api/runs/${runId}/cancel`, {}),
      post(viewer, '/api/runs/flo_e2e_cancel/cancel', {}),
    ])
    await Promise.allSettled([viewer.close(), readOnly.close()])
  })

  const liveList = await eventually(
    async () => (await read(viewer, '/api/runs?limit=200')).json,
    (page) => page?.runs?.some((run) => run.runId === runId && run.state === 'running'),
    'the real run in the live listing',
  )
  assert.equal(liveList.runs.find((run) => run.runId === runId).openQuestions, 0)

  const firstSnapshot = await eventually(
    async () => (await read(viewer, `/api/runs/${runId}`)).json,
    (detail) =>
      detail?.phases?.some((phase) => phase.title === 'Fan out')
      && detail.agents?.some((agent) => agent.label === 'listener' && agent.state === 'running')
      && detail.agents?.some((agent) => agent.state === 'queued'),
    'snapshot structure with a phase and queued/running agents',
  )
  assert.ok(firstSnapshot.agents.every((agent) => Array.isArray(agent.path)))
  assert.ok(firstSnapshot.agents.some((agent) =>
    agent.path.some((part) => part.kind === 'parallel')))
  const queued = new Set(firstSnapshot.agents.filter((agent) => agent.state === 'queued').map((agent) => agent.index))

  const transcript = connectSse(viewer, runId, 0)
  await transcript.ready
  try {
    await transcript.waitFor(
      (frames) => batchRecords(frames).some((entry) =>
        entry.s === 'a0' && entry.r?.kind === 'status' && entry.r?.text === 'completed'),
      'the listener transcript to tail through completion',
    )
  } finally {
    transcript.close()
  }
  const transitioned = await eventually(
    async () => (await read(viewer, `/api/runs/${runId}`)).json,
    (detail) => detail?.agents?.some((agent) =>
      queued.has(agent.index) && agent.state !== 'queued'),
    'a queued agent to transition through running',
  )
  assert.ok(transitioned.phases.some((phase) => phase.title === 'Pipeline'))

  const refusedLiveDelete = await remove(viewer, runId)
  assert.equal(refusedLiveDelete.status, 409, refusedLiveDelete.text)
  assert.equal(refusedLiveDelete.json.error.code, 'conflict')

  const blocked = await eventually(
    async () => (await read(viewer, `/api/runs/${runId}`)).json,
    (detail) => detail?.openQuestions === 1 && detail.questions?.some((q) => q.qid === 'ship' && !q.answered),
    'the workflow ask() to become answerable',
  )
  assert.equal(blocked.state, 'running')
  const answered = await post(viewer, `/api/runs/${runId}/answer`, { qid: 'ship', value: 'yes' })
  assert.equal(answered.status, 200, answered.text)

  const outcome = await completion
  assert.equal(outcome.status, 'completed')
  assert.deepEqual(outcome.result, {
    parallelResults: ['parallel-1', 'parallel-2', 'parallel-3'],
    pipelineResults: ['stage-2-stage-1-a-a', 'stage-2-stage-1-b-b'],
    delivery: 'live',
    steeredResult: 'mail:steered by the workflow',
    answer: 'yes',
  })
  const servedResult = await read(viewer, `/api/runs/${runId}/result`)
  assert.equal(servedResult.status, 200, servedResult.text)
  assert.deepEqual(servedResult.json.result, outcome.result)
  await eventually(
    async () => (await read(viewer, '/api/runs?limit=200')).json,
    (page) => page?.runs?.some((run) => run.runId === runId && run.state === 'completed'),
    'the completed run in the listing',
  )

  const deleted = await remove(viewer, runId)
  assert.equal(deleted.status, 200, deleted.text)
  assert.match(deleted.json.trashEntry, new RegExp(`^${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`))
  assert.ok(fs.existsSync(path.join(TRASH, deleted.json.trashEntry)))
  assert.ok(!fs.existsSync(path.join(RUNS, runId)))

  // Second pass: a pending ask is abandoned by cancellation, leaves no attention count,
  // and the read-only viewer refuses the complete mutation surface before dispatch.
  const cancelFile = writeWorkflow('cancel-pending-ask', `
export const meta = { name: 'cancel pending ask', description: 'W13 cancellation pass' }
export default async function ({ spawn, ask }) {
  const sleeper = spawn('SLEEP 60000\\nECHO never', { adapter: 'mock', label: 'sleeper' })
  const answer = await ask('This will be abandoned', { id: 'abandon-me' })
  return { answer, sleeper: await sleeper.done }
}
`)
  const cancelledRunId = 'flo_e2e_cancel'
  const cancelledCompletion = runWorkflow({
    file: cancelFile,
    runId: cancelledRunId,
    defaults: { adapter: 'mock', cwd: process.cwd() },
    quiet: true,
  })
  await eventually(
    async () => (await read(viewer, `/api/runs/${cancelledRunId}`)).json,
    (detail) => detail?.openQuestions === 1 && detail.agents?.some((agent) => agent.state === 'running'),
    'the second pass pending ask',
  )

  const readOnlyMutations = [
    ['POST', `/api/runs/${cancelledRunId}/send`, { agent: 0, message: 'no' }],
    ['POST', `/api/runs/${cancelledRunId}/answer`, { qid: 'abandon-me', value: 'no' }],
    ['POST', `/api/runs/${cancelledRunId}/cancel`, {}],
    ['POST', `/api/runs/${cancelledRunId}/resume`, {}],
    ['DELETE', `/api/runs/${cancelledRunId}`, {}],
  ]
  for (const [method, target, body] of readOnlyMutations) {
    const reply = await request(readOnly, { method, target, body, control: true })
    assert.equal(reply.status, 403, `${method} ${target}: ${reply.text}`)
    assert.equal(reply.json.error.code, 'forbidden')
  }

  const cancel = await post(viewer, `/api/runs/${cancelledRunId}/cancel`, {})
  assert.equal(cancel.status, 200, cancel.text)
  assert.equal(cancel.json.scope, 'run')
  assert.equal((await cancelledCompletion).status, 'interrupted')
  const abandoned = await eventually(
    async () => (await read(viewer, `/api/runs/${cancelledRunId}`)).json,
    (detail) =>
      detail?.openQuestions === 0
      && detail.questions?.some((question) => question.qid === 'abandon-me' && question.abandoned),
    'cancelled ask() to become abandoned',
  )
  assert.equal(abandoned.state, 'interrupted')
  const terminalList = await eventually(
    async () => (await read(viewer, '/api/runs?limit=200')).json,
    (page) => page?.runs?.some((run) =>
      run.runId === cancelledRunId && run.state === 'interrupted' && run.openQuestions === 0),
    'cancelled run to leave the attention count',
  )
  assert.equal(terminalList.runs.find((run) => run.runId === cancelledRunId).openQuestions, 0)
})
