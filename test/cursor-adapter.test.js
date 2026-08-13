// cursor adapter: argv construction, stdin prompt delivery, system preamble,
// bin override, and the no-effort-flag policy (effort lives in the model id).
import test from 'node:test'
import assert from 'node:assert/strict'
import { getAdapter } from '../src/adapters/index.js'

const cursor = getAdapter('cursor')

test('cursor fresh turn: print mode, stream-json, --force, prompt on stdin', () => {
  const b = cursor.build({ spec: { model: 'gpt-5.4-mini-medium' }, prompt: 'do the thing', mode: 'fresh', sessionId: null })
  assert.deepEqual(b.argv, ['-p', '--output-format', 'stream-json', '--force', '--model', 'gpt-5.4-mini-medium'])
  assert.equal(b.stdin, 'do the thing')
  assert.equal(b.keepOpen, false)
  assert.deepEqual(b.tempFiles, [])
  // no model → no --model pair
  assert.deepEqual(cursor.build({ spec: {}, prompt: 'x', mode: 'fresh', sessionId: null }).argv,
    ['-p', '--output-format', 'stream-json', '--force'])
})

test('cursor resume turn: --resume <sid> before the output flags', () => {
  const b = cursor.build({ spec: { model: 'gpt-5.4-mini-medium' }, prompt: 'follow up', mode: 'resume', sessionId: 'sid-123' })
  assert.deepEqual(b.argv, ['-p', '--resume', 'sid-123', '--output-format', 'stream-json', '--force', '--model', 'gpt-5.4-mini-medium'])
  assert.equal(b.stdin, 'follow up')
})

test('cursor prepends spec.system on fresh turns only', () => {
  const spec = { system: 'be terse' }
  assert.equal(cursor.build({ spec, prompt: 'hi', mode: 'fresh', sessionId: null }).stdin,
    '[system instructions]\nbe terse\n[task]\nhi')
  // a resumed session already carries the preamble — never repeat it
  assert.equal(cursor.build({ spec, prompt: 'hi', mode: 'resume', sessionId: 's1' }).stdin, 'hi')
  assert.equal(cursor.build({ spec: {}, prompt: 'hi', mode: 'fresh', sessionId: null }).stdin, 'hi')
})

test('cursor caps: turn-steer, resume, schema-by-prompt, provider session ids, model pass-through', () => {
  assert.deepEqual(cursor.caps, { steer: 'turn', resume: true, schema: 'prompt', selfSession: false, acceptsModel: true })
  assert.equal(cursor.protocol, 'cursor-jsonl')
})

test('FLOWITION_CURSOR_BIN overrides the cursor-agent executable', () => {
  assert.equal(cursor.bin(), 'cursor-agent')
  process.env.FLOWITION_CURSOR_BIN = '/opt/cursor-agent'
  try { assert.equal(cursor.bin(), '/opt/cursor-agent') } finally { delete process.env.FLOWITION_CURSOR_BIN }
  assert.equal(cursor.bin(), 'cursor-agent')
})

test('cursor rejects spec.effort — effort is encoded in the model id', () => {
  assert.equal(cursor.validateSpec({ model: 'gpt-5.6-sol-xhigh' }), null)
  assert.equal(cursor.validateSpec({}), null)
  // cursor has no effort flag; silently dropping the option would misreport what
  // ran, so validateSpec fails the spec loudly with the encode-it-in-the-model hint
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    assert.match(cursor.validateSpec({ effort }), /no effort flag.*encode effort in the model id/, effort)
  }
  // bracket-override model ids pass through untouched
  const b = cursor.build({ spec: { model: 'claude-opus-4-8[context=1m,effort=high,fast=false]' }, prompt: 'x', mode: 'fresh', sessionId: null })
  assert.equal(b.argv.at(-1), 'claude-opus-4-8[context=1m,effort=high,fast=false]')
})
