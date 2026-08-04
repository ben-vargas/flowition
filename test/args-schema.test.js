import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.FLOWITION_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-test-'))

const { runWorkflow } = await import('../src/engine.js')
const { runDir, readJsonl } = await import('../src/util.js')

const fx = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name)

test('argsSchema: valid args pass and the toolkit receives them verbatim', async () => {
  const out = await runWorkflow({ file: fx('args-schema.workflow.js'), args: { target: 'world' }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result.echoed, 'world')
  assert.deepEqual(out.result.args, { target: 'world' })
})

test('argsSchema: a valid run resumes cleanly (schema re-validated on resume)', async () => {
  const first = await runWorkflow({ file: fx('args-schema.workflow.js'), args: { target: 'again' }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(first.status, 'completed')
  const again = await runWorkflow({ file: fx('args-schema.workflow.js'), args: { target: 'again' }, defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.deepEqual(again.result, first.result)
})

test('argsSchema: invalid args fail the run before any agent starts', async () => {
  await assert.rejects(
    runWorkflow({ file: fx('args-schema.workflow.js'), args: { wrong: true }, defaults: { adapter: 'mock' }, quiet: true, runId: 'argsbad1' }),
    /meta\.argsSchema[\s\S]*missing required property "target"/,
  )
  const journal = readJsonl(path.join(runDir('argsbad1'), 'journal.jsonl'))
  // no agent was ever admitted — the failure precedes all work
  assert.ok(!journal.some((e) => e.type === 'started'))
  const end = journal.find((e) => e.type === 'end')
  assert.equal(end.status, 'failed')
  assert.match(end.error, /missing required property "target"/)
  assert.match(end.error, /unexpected property "wrong"/)
  const events = readJsonl(path.join(runDir('argsbad1'), 'events.jsonl'))
  assert.ok(!events.some((e) => e.type === 'agent'))
  const result = JSON.parse(fs.readFileSync(path.join(runDir('argsbad1'), 'result.json'), 'utf8'))
  assert.equal(result.status, 'failed')
})

test('argsSchema: absent args fail when the schema requires an object', async () => {
  await assert.rejects(
    runWorkflow({ file: fx('args-schema.workflow.js'), defaults: { adapter: 'mock' }, quiet: true }),
    /expected type object, got undefined/,
  )
})

// Shared assertion: an admission-time schema failure must leave the SAME
// terminal artifacts as any other admission failure — a terminal `end` record,
// a failed result.json, and zero admitted agents — never a bare crash.
function assertTerminalAdmissionFailure(runId, errorRe) {
  const journal = readJsonl(path.join(runDir(runId), 'journal.jsonl'))
  assert.ok(!journal.some((e) => e.type === 'started'), 'no agent was admitted')
  const end = journal.find((e) => e.type === 'end')
  assert.ok(end, 'terminal end record exists')
  assert.equal(end.status, 'failed')
  assert.match(end.error, errorRe)
  const events = readJsonl(path.join(runDir(runId), 'events.jsonl'))
  assert.ok(!events.some((e) => e.type === 'agent'), 'no agent events')
  const result = JSON.parse(fs.readFileSync(path.join(runDir(runId), 'result.json'), 'utf8'))
  assert.equal(result.status, 'failed')
  assert.match(result.error, errorRe)
}

test('argsSchema: an unsupported schema keyword is rejected loudly before any work', async () => {
  await assert.rejects(
    runWorkflow({ file: fx('args-schema-unsupported.workflow.js'), args: { target: 'x1' }, defaults: { adapter: 'mock' }, quiet: true, runId: 'argsbad2' }),
    /unsupported schema keyword "pattern"/,
  )
  assertTerminalAdmissionFailure('argsbad2', /unsupported schema keyword "pattern"/)
})

test('argsSchema: a non-object schema is rejected, not silently accepted', async () => {
  await assert.rejects(
    runWorkflow({ file: fx('args-schema-not-object.workflow.js'), args: {}, defaults: { adapter: 'mock' }, quiet: true }),
    /meta\.argsSchema must be a JSON Schema object/,
  )
})

test('argsSchema: a malformed schema shape (non-array anyOf) is rejected loudly, not a crash', async () => {
  await assert.rejects(
    runWorkflow({ file: fx('args-schema-malformed.workflow.js'), args: {}, defaults: { adapter: 'mock' }, quiet: true, runId: 'argsbad3' }),
    /malformed "anyOf"/,
  )
  assertTerminalAdmissionFailure('argsbad3', /malformed "anyOf"/)
})

test('argsSchema: a throwing meta.argsSchema GETTER still produces terminal run artifacts', async () => {
  // The property READ is inside the exception boundary too — a getter that
  // detonates on access is just another way the schema can fail.
  await assert.rejects(
    runWorkflow({ file: fx('args-schema-throwing-getter.workflow.js'), args: {}, defaults: { adapter: 'mock' }, quiet: true, runId: 'argsbad5' }),
    /meta\.argsSchema is not a valid schema:[\s\S]*boom from meta getter/,
  )
  assertTerminalAdmissionFailure('argsbad5', /boom from meta getter/)
})

test('argsSchema: a validator THROW still produces terminal run artifacts', async () => {
  // The fixture's schema detonates mid-walk (a throwing getter) — modeling any
  // validator crash the structural checks did not anticipate. The thrown error
  // must be finalized exactly like returned validation errors, never escape
  // the admission gate as a bare crash without terminal artifacts.
  await assert.rejects(
    runWorkflow({ file: fx('args-schema-throwing.workflow.js'), args: {}, defaults: { adapter: 'mock' }, quiet: true, runId: 'argsbad4' }),
    /meta\.argsSchema is not a valid schema:[\s\S]*boom from schema getter/,
  )
  assertTerminalAdmissionFailure('argsbad4', /boom from schema getter/)
})
