import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-cli-'))
const env = { ...process.env, FLOWITION_HOME: HOME }
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bin = path.join(root, 'bin', 'flowition.js')
const fx = (n) => path.join(root, 'test', 'fixtures', n)

const run = (args, opts = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env, timeout: 30000, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout, stderr }),
    )
  })

test('cli: run --json executes a workflow end to end', async () => {
  const r = await run(['run', fx('basic.workflow.js'), '--args', '{"x":2}', '--adapter', 'mock', '--json'])
  assert.equal(r.code, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(out.status, 'completed')
  assert.equal(out.result.single, 'hello')
  assert.deepEqual(out.result.args, { x: 2 })
})

test('cli: detached run + status + result --wait + runs + tail', async () => {
  const r = await run(['run', fx('basic.workflow.js'), '--adapter', 'mock', '--detach', '--json'])
  assert.equal(r.code, 0, r.stderr)
  const { runId } = JSON.parse(r.stdout.trim())
  assert.match(runId, /^flo_/)
  const res = await run(['result', runId, '--wait', '20'])
  assert.equal(res.code, 0, res.stdout + res.stderr)
  const final = JSON.parse(res.stdout)
  assert.equal(final.status, 'completed')
  assert.equal(final.result.single, 'hello')

  const st = await run(['status', runId, '--json'])
  const snap = JSON.parse(st.stdout)
  assert.equal(snap.state, 'completed')
  assert.ok(snap.agents.length >= 8)
  assert.ok(snap.agents.every((a) => a.state === 'done'))

  const ls = await run(['runs', '--json'])
  assert.ok(JSON.parse(ls.stdout).some((row) => row.runId === runId))

  const tail = await run(['tail', runId, '--agent', String(snap.agents[0].index)])
  assert.match(tail.stdout, /agent \[/)
})

test('cli: guide prints the authoring contract', async () => {
  const r = await run(['guide'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /workflow authoring guide/)
  assert.match(r.stdout, /spawn\(prompt, opts\)/)
})

test('mcp: initialize, tools/list, flowition_run + flowition_result round trip', async () => {
  const child = spawn(process.execPath, [bin, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const responses = []
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) responses.push(JSON.parse(line))
    }
  })
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
  const waitFor = (id, ms = 30000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        const r = responses.find((x) => x.id === id)
        if (r) { clearInterval(iv); resolve(r) }
        else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('mcp timeout waiting for id ' + id)) }
      }, 25)
    })

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  const init = await waitFor(1)
  assert.equal(init.result.serverInfo.name, 'flowition')

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = await waitFor(2)
  assert.ok(tools.result.tools.some((t) => t.name === 'flowition_run'))

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flowition_run', arguments: { file: fx('basic.workflow.js'), adapter: 'mock' } } })
  const started = await waitFor(3)
  const { runId } = JSON.parse(started.result.content[0].text)
  assert.match(runId, /^flo_/)

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'flowition_result', arguments: { runId, waitSeconds: 20 } } })
  const result = await waitFor(4)
  const final = JSON.parse(result.result.content[0].text)
  assert.equal(final.status, 'completed')
  assert.equal(final.result.single, 'hello')

  child.kill()
})
