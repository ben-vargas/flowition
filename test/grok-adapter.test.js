// grok adapter: argv construction, prompt-file delivery (never argv/stdin),
// the two-flag yolo pair, --rules on every turn, native schema alongside the
// streaming format, bin override, and the identity effort map.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getAdapter } from '../src/adapters/index.js'

const grok = getAdapter('grok')
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flo-grok-'))

// every turn starts with the streaming format and the maximal valid yolo pair
// (--yolo is a clap alias of --always-approve — combining them exits 2)
const BASE = ['--output-format', 'streaming-messages-json', '--always-approve',
  '--permission-mode', 'bypassPermissions']

test('grok fresh turn: streaming-messages-json, yolo pair, prompt via 0600 scratch file', () => {
  const dir = scratch()
  const b = grok.build({
    spec: { model: 'grok-4', effort: 'xhigh', system: 'be terse', cwd: '/tmp/work' },
    prompt: 'do the thing', mode: 'fresh', sessionId: null, scratch: dir,
  })
  const pf = b.tempFiles[0]
  assert.deepEqual(b.argv, [...BASE,
    '--model', 'grok-4', '--reasoning-effort', 'xhigh', '--rules', 'be terse',
    '--prompt-file', pf])
  assert.equal(b.stdin, null)
  assert.equal(b.keepOpen, false)
  assert.deepEqual(b.tempFiles, [pf])
  // the prompt file lives in scratch, holds exactly the prompt, and is private;
  // the .md suffix matters — grok treats .json prompt files as ACP content blocks
  assert.equal(path.dirname(pf), dir)
  assert.match(path.basename(pf), /^prompt-.*\.md$/)
  assert.equal(fs.readFileSync(pf, 'utf8'), 'do the thing')
  assert.equal(fs.statSync(pf).mode & 0o777, 0o600)

  // no options → just the base flags and the prompt file
  const bare = grok.build({ spec: {}, prompt: 'x', mode: 'fresh', sessionId: null, scratch: dir })
  assert.deepEqual(bare.argv, [...BASE, '--prompt-file', bare.tempFiles[0]])
})

test('grok never starts the TUI or leaks the prompt: --prompt-file last, no -p, no positional, no --yolo', () => {
  const dir = scratch()
  const b = grok.build({
    spec: { model: 'grok-4', effort: 'low', system: 's', cwd: '/w', schema: { type: 'object' } },
    prompt: 'secret prompt text', mode: 'fresh', sessionId: null, scratch: dir,
  })
  assert.equal(b.argv.at(-2), '--prompt-file') // headless trigger, always present, always last
  assert.ok(!b.argv.includes('-p'))
  assert.ok(!b.argv.includes('--yolo'))
  assert.ok(!b.argv.includes('--session-id'))
  assert.ok(!b.argv.includes('-s'))
  assert.ok(!b.argv.includes('--system-prompt-override'))
  assert.ok(!b.argv.includes('--cwd'))
  // the prompt appears in NO argv element — only the scratch path does
  for (const a of b.argv) assert.ok(!a.includes('secret prompt text'), a)
})

test('grok resume turn: --resume <sid>, --rules still present, fresh prompt file per turn', () => {
  const dir = scratch()
  const sid = '0198b1c2-1234-7abc-8def-0123456789ab'
  const b = grok.build({
    spec: { model: 'grok-4', system: 'be terse' },
    prompt: 'follow up', mode: 'resume', sessionId: sid, scratch: dir,
  })
  assert.deepEqual(b.argv, [...BASE, '--resume', sid,
    '--model', 'grok-4', '--rules', 'be terse', '--prompt-file', b.tempFiles[0]])
  // the resume turn's file carries only the follow-up text (grok rebuilds the
  // system prompt per invocation — the session does not accumulate --rules)
  assert.equal(fs.readFileSync(b.tempFiles[0], 'utf8'), 'follow up')
})

test('grok schema turn: --json-schema AND the explicit streaming format coexist', () => {
  // --json-schema only forces json output when the format is still the default;
  // the explicit streaming-messages-json must survive on argv or schema turns
  // would silently lose streaming — pin our own build fn against that regression
  const dir = scratch()
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  const b = grok.build({ spec: { schema }, prompt: 'x', mode: 'fresh', sessionId: null, scratch: dir })
  assert.deepEqual(b.argv, [...BASE, '--json-schema', JSON.stringify(schema),
    '--prompt-file', b.tempFiles[0]])
  const i = b.argv.indexOf('--output-format')
  assert.equal(b.argv[i + 1], 'streaming-messages-json')
})

test('grok caps: turn-steer, resume, native schema, provider session ids, model pass-through', () => {
  assert.deepEqual(grok.caps, { steer: 'turn', resume: true, schema: 'native', selfSession: false, acceptsModel: true })
  assert.equal(grok.protocol, 'claude-stream')
  assert.equal(grok.userMessage, undefined) // turn steer — no stdin injection
})

test('FLOWITION_GROK_BIN overrides the grok executable', () => {
  const prior = process.env.FLOWITION_GROK_BIN
  delete process.env.FLOWITION_GROK_BIN
  try {
    assert.equal(grok.bin(), 'grok')
    process.env.FLOWITION_GROK_BIN = '/opt/grok'
    assert.equal(grok.bin(), '/opt/grok')
  } finally {
    if (prior === undefined) delete process.env.FLOWITION_GROK_BIN
    else process.env.FLOWITION_GROK_BIN = prior
  }
})

test('grok maps every flowition effort to itself — grok accepts the whole vocabulary', () => {
  for (const e of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(grok.mapEffort(e), e)
  }
  const dir = scratch()
  const b = grok.build({ spec: { effort: 'xhigh' }, prompt: 'x', mode: 'fresh', sessionId: null, scratch: dir })
  assert.equal(b.argv[b.argv.indexOf('--reasoning-effort') + 1], 'xhigh')
})

test('grok omits --cwd — spawn cwd is enough, and a relative spec.cwd must not double-resolve', () => {
  // grok 1.0.3 resolves --cwd against process cwd, so passing 'packages/app'
  // after AgentJob already spawn()s there would look for packages/app/packages/app
  const dir = scratch()
  const b = grok.build({
    spec: { cwd: 'packages/app' },
    prompt: 'x', mode: 'fresh', sessionId: null, scratch: dir,
  })
  assert.ok(!b.argv.includes('--cwd'))
  assert.ok(!b.argv.includes('packages/app'))
  assert.deepEqual(b.argv, [...BASE, '--prompt-file', b.tempFiles[0]])
})
