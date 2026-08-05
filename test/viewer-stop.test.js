// `flowition viewer --stop` — the ergonomic form of `kill $(viewer.json pid)`, with the
// property the raw kill lacks: the pid is only ever signalled AFTER the §4.2.1 challenge
// proof has shown the recorded port is held by our live viewer. A stale rendezvous file
// naming a recycled pid must never translate into a signal at whatever innocent process
// holds that pid today.
//
// One viewer per home (§13.2/§13.7) means --stop is per-home like every other viewer
// command: it stops the registered instance for FLOWITION_HOME, and nothing else.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-stop-'))
process.env.FLOWITION_HOME = HOME

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BIN = path.join(ROOT, 'bin', 'flowition.js')
const rendezvous = (home) => path.join(home, 'viewer.json')

const runCli = (args, env = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout, stderr }))
  })

/** Every child this file spawns, so a FAILED test cannot leave a live viewer holding
 * the runner's event loop open — the hang mode this suite's first red run demonstrated. */
const children = new Set()
after(() => { for (const child of children) { try { child.kill('SIGKILL') } catch { /* gone */ } } })

/**
 * A real `flowition viewer` in its own process — --stop signals the recorded pid, so the
 * instance under test cannot live in this process (it would be signalling the test run).
 * Resolves once the startup line is printed, which is after the rendezvous is written.
 */
function spawnViewer(home) {
  // --port 0: hermetic. The default port is one well-known value per machine, and this
  // suite must not contend with a developer's real viewer (or a parallel test run).
  const child = spawn(process.execPath, [BIN, 'viewer', '--port', '0'], {
    env: { ...process.env, FLOWITION_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  let stderr = ''
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`viewer never announced:\n${stderr}`)), 15_000)
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (/viewer: http/.test(stderr)) { clearTimeout(timer); resolve() }
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`viewer exited early (${code}):\n${stderr}`)) })
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  return { child, ready, exited }
}

test('--stop with no live viewer reports so and exits 1', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-stop-empty-'))
  const res = await runCli(['viewer', '--stop'], { FLOWITION_HOME: home })
  assert.equal(res.code, 1)
  assert.match(res.stderr, /no live flowition viewer for this home/)
})

test('--stop refuses every other viewer flag — an action is not a modifier', async () => {
  for (const extra of [['--port', '4199'], ['--control'], ['--print-url'], ['--open']]) {
    const res = await runCli(['viewer', '--stop', ...extra])
    assert.notEqual(res.code, 0, `--stop ${extra.join(' ')} must be refused`)
    // The COMBINATION refusal specifically — "unknown option --stop" also mentions the
    // flag and is exactly the vacuous pass this regexp exists to reject.
    assert.match(res.stderr, /--stop stops the live viewer for this home and takes no other viewer flags/,
      `refusal for ${extra.join(' ')} is the combination refusal`)
  }
})

test('--stop stops the registered live viewer: process exits, rendezvous removed, exit 0', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-stop-live-'))
  const { ready, exited } = spawnViewer(home)
  await ready
  const record = JSON.parse(fs.readFileSync(rendezvous(home), 'utf8'))

  const res = await runCli(['viewer', '--stop'], { FLOWITION_HOME: home })
  assert.equal(res.code, 0, `--stop failed:\n${res.stderr}`)
  assert.match(res.stderr, /stopped/)
  assert.match(res.stderr, new RegExp(String(record.pid)))

  const gone = await exited
  // SIGTERM lands in the CLI's signal handler, which closes the server and resolves the
  // command — a CLEAN zero exit, not a signal death (parity #29/#31).
  assert.equal(gone.code, 0, `viewer should exit cleanly, got code=${gone.code} signal=${gone.signal}`)
  assert.equal(fs.existsSync(rendezvous(home)), false, 'clean shutdown removes viewer.json')
})

test('--stop --json reports the settled fact as JSON on stdout', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-stop-json-'))
  const { ready, exited } = spawnViewer(home)
  await ready
  const res = await runCli(['viewer', '--stop', '--json'], { FLOWITION_HOME: home })
  assert.equal(res.code, 0, `--stop --json failed:\n${res.stderr}`)
  const report = JSON.parse(res.stdout)
  assert.equal(report.stopped, true)
  assert.equal(typeof report.pid, 'number')
  assert.equal(typeof report.port, 'number')
  // §7.1.8 is opt-in: a local-only viewer's stop report carries no tailscale field,
  // and no serve-teardown reminder appears on stderr.
  assert.ok(!('tailscaleOrigin' in report))
  assert.ok(!res.stderr.includes('tailscale'))
  await exited
})

test('a stale rendezvous naming an innocent live pid is never signalled', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-viewer-stop-stale-'))
  // The innocent: a process that happens to hold the pid a dead viewer's record names.
  const innocent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  children.add(innocent)
  innocent.once('exit', () => children.delete(innocent))
  const innocentExited = new Promise((resolve) => innocent.once('exit', (code, signal) => resolve({ code, signal })))
  // A port with a listener that is NOT our viewer, so the record looks maximally alive
  // while still failing the challenge proof.
  const imposter = http.createServer((req, res) => { res.writeHead(200); res.end('{}') })
  await new Promise((resolve) => imposter.listen(0, '127.0.0.1', resolve))
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(rendezvous(home), JSON.stringify({
    pid: innocent.pid, port: imposter.address().port, startedAt: Date.now(), control: [],
  }), { mode: 0o600 })

  const res = await runCli(['viewer', '--stop'], { FLOWITION_HOME: home })
  assert.equal(res.code, 1, 'an unproven record is "no live viewer", not a kill target')
  assert.match(res.stderr, /no live flowition viewer/)

  // The innocent is still running — give a signal, if one were wrongly sent, time to land.
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(innocent.exitCode, null, 'the innocent pid must not have been signalled')
  innocent.kill('SIGKILL')
  await innocentExited
  await new Promise((resolve) => imposter.close(resolve))
})
