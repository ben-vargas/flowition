import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-cli-parse-test-'))
const env = { ...process.env, FLOWITION_HOME: HOME }
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bin = path.join(root, 'bin', 'flowition.js')
const fixture = path.join(root, 'test', 'fixtures', 'basic.workflow.js')

const run = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env, timeout: 30000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout, stderr }),
    )
  })

test('cli parser: boolean flags do not consume positionals', async () => {
  const status = await run(['status', '--json', 'flo_missing'])
  assert.equal(status.code, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).runId, 'flo_missing')

  const dir = path.join(HOME, 'runs', 'flo_complete')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'completed', result: 'ok' }))
  const result = await run(['result', '--wait', 'flo_complete', '--json'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).result, 'ok')
})

test('cli parser: value options reject missing values', async () => {
  for (const [args, message] of [
    [['run', fixture, '--adapter', '--json'], 'option --adapter requires a value'],
    [['tail', 'flo_missing', '--agent'], 'option --agent requires a value'],
    [['tail', 'flo_missing', '-a', '-f'], 'option -a requires a value'],
  ]) {
    const result = await run(args)
    assert.equal(result.code, 1)
    assert.match(result.stderr, new RegExp(`^flowition: ${message}`))
  }
})

test('cli parser: numeric options require bounded integers', async () => {
  for (const [args, message] of [
    [['run', fixture, '--concurrency', 'NaN'], '--concurrency must be an integer >= 1'],
    [['run', fixture, '--concurrency', '0'], '--concurrency must be an integer >= 1'],
    [['run', fixture, '--concurrency', '1.5'], '--concurrency must be an integer >= 1'],
    [['run', fixture, '--budget', 'Infinity'], '--budget must be an integer >= 0'],
    [['run', fixture, '--budget', '-1'], '--budget must be an integer >= 0'],
    [['result', 'flo_missing', '--wait', 'NaN'], '--wait must be an integer >= 0'],
    [['result', 'flo_missing', '--wait', '-1'], '--wait must be an integer >= 0'],
  ]) {
    const result = await run(args)
    assert.equal(result.code, 1)
    assert.equal(result.stderr.trim(), `flowition: ${message}`)
  }
})

test('cli parser: malformed args use clean errors', async () => {
  const inline = await run(['run', fixture, '--args', '{'])
  assert.equal(inline.code, 1)
  assert.match(inline.stderr, /^flowition: invalid --args JSON:/)
  assert.doesNotMatch(inline.stderr, /\n\s+at /)

  const argsFile = path.join(HOME, 'bad-args.json')
  fs.writeFileSync(argsFile, '{')
  const file = await run(['run', fixture, '--args-file', argsFile])
  assert.equal(file.code, 1)
  assert.match(file.stderr, /^flowition: invalid JSON in --args-file /)
  assert.doesNotMatch(file.stderr, /\n\s+at /)
})

test('cli: run ids with path separators or leading dots are rejected with a clean error', async () => {
  // a crafted id must never become a path component under the flowition home —
  // the engine's prep phase (scratch sweep, result.json unlink) would mutate
  // files outside it
  for (const args of [
    ['status', '../../etc'],
    ['run', fixture, '--run-id', '../x', '--adapter', 'mock'],
    ['run', fixture, '--resume', '../x'],
    ['resume', '../x'],
    ['tail', '../x'],
    ['send', '../x', '0', 'hi'],
    ['answer', '../x', 'q0', 'yes'],
    ['cancel', '../x'],
    ['result', '../x'],
    ['status', '.hidden'],
    ['status', 'a/b'],
  ]) {
    const result = await run(args)
    assert.equal(result.code, 1, args.join(' '))
    assert.match(result.stderr, /^flowition: invalid run id /, args.join(' '))
    assert.doesNotMatch(result.stderr, /\n\s+at /, args.join(' '))
  }
  // ordinary ids still pass validation
  const ok = await run(['status', '--json', 'flo_still_fine'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(JSON.parse(ok.stdout).runId, 'flo_still_fine')
})

test('cli parser: detached resume reports the existing run id (journal preflighted)', async () => {
  const id = 'flo_existing'
  const runs = path.join(HOME, 'runs')
  fs.mkdirSync(path.join(runs, id), { recursive: true })
  // detached resume preflights the journal in the parent — seed a minimal meta
  fs.writeFileSync(path.join(runs, id, 'journal.jsonl'),
    JSON.stringify({ t: 1, type: 'meta', runId: id, workflowFile: fixture, fileHash: 'x', graphHash: 'x', graphDynamic: false, seed: 'ab', createdAt: 1, keyVersion: 'k2', defaults: { adapter: 'mock' } }) + '\n')
  const before = fs.readdirSync(runs).sort()
  const result = await run(['run', '--resume', id, '--detach', '--json', fixture, '--adapter', 'mock'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).runId, id)
  assert.deepEqual(fs.readdirSync(runs).sort(), before)
})

test('cli tail: follow carries partial UTF-8 records between polls', async () => {
  const id = 'flo_partial'
  const dir = path.join(HOME, 'runs', id)
  const events = path.join(dir, 'events.jsonl')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(events, '')

  const child = spawn(process.execPath, [bin, 'tail', id, '--json', '-f'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  try {
    const record = { type: 'log', message: 'café' }
    const line = Buffer.from(JSON.stringify(record) + '\n')
    const split = line.indexOf(Buffer.from('é')) + 1
    fs.appendFileSync(events, line.subarray(0, split))
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(stdout, '')

    fs.appendFileSync(events, line.subarray(split))
    const started = Date.now()
    while (!stdout.includes('\n') && Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(stderr, '')
    assert.deepEqual(JSON.parse(stdout.trim()), record)
  } finally {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }
})
