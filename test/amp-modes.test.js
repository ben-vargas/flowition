// amp agent-mode discovery + resolution (plugins dir parsed via FLOWITION_AMP_PLUGINS_DIR)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-amp-modes-'))
fs.writeFileSync(path.join(dir, 'fable-mode.ts'), [
  '// @amp-plugin updated automatically from https://example.com/fable-mode.ts',
  '// @amp-agent-mode {"key":"claude-fable-5","label":"Claude Fable 5"}',
  '// @amp-agent-mode {"key":"claude-fable-xhi","label":"Claude Fable xhi"}',
  'export default function () {}',
].join('\n'))
// hand-written plugin with no header annotation → registerAgentMode fallback
fs.writeFileSync(path.join(dir, 'custom.ts'), [
  'export default function (amp) {',
  "  amp.experimental.registerAgentMode({",
  "    key: 'my-mode',",
  "    label: 'My Mode',",
  "    description: 'x',",
  '  })',
  '}',
].join('\n'))
fs.writeFileSync(path.join(dir, 'label-first.ts'), [
  'export default function (amp) {',
  '  amp.experimental.registerAgentMode({',
  "    label: 'Label First',",
  "    description: 'property order is not significant',",
  "    key: 'label-first',",
  '  })',
  '}',
].join('\n'))
fs.writeFileSync(path.join(dir, 'regex-literal.ts'), [
  'export default function (amp) {',
  '  amp.experimental.registerAgentMode({',
  '    matcher: /}/,',
  "    key: 'regex-mode',",
  "    label: 'Regex Mode',",
  '  })',
  '}',
].join('\n'))
fs.writeFileSync(path.join(dir, 'keyword-regex.ts'), [
  'export default function (amp) {',
  '  amp.experimental.registerAgentMode({',
  '    setup:()=>{return /}/.test(x)},',
  "    key: 'late',",
  "    label: 'Late',",
  '  })',
  '}',
].join('\n'))
fs.writeFileSync(path.join(dir, 'backtick.ts'), [
  'export default function (amp) {',
  '  amp.experimental.registerAgentMode({',
  '    key: `backtick-mode`,',
  '    label: `Backtick Mode`,',
  '  })',
  '}',
].join('\n'))
fs.writeFileSync(path.join(dir, 'interpolated-template.ts'), [
  'export default function (amp, suffix) {',
  '  amp.experimental.registerAgentMode({',
  '    key: `dynamic-${suffix}`,',
  "    label: 'Dynamic Mode',",
  '  })',
  '  amp.experimental.registerAgentMode({',
  "    key: 'template-sibling',",
  "    label: 'Template Sibling',",
  '  })',
  '}',
].join('\n'))
process.env.FLOWITION_AMP_PLUGINS_DIR = dir
const { discoverAmpModes, resolveAmpMode, getAdapter } = await import('../src/adapters/index.js')

test('discovers builtins + annotated + registerAgentMode modes', () => {
  const modes = discoverAmpModes()
  const keys = modes.map((m) => m.key)
  assert.deepEqual(keys.slice(0, 4), ['low', 'medium', 'high', 'ultra'])
  assert.ok(keys.includes('claude-fable-5'))
  assert.ok(keys.includes('claude-fable-xhi'))
  assert.ok(keys.includes('my-mode'))
  assert.ok(keys.includes('label-first'))
  assert.equal(modes.find((m) => m.key === 'regex-mode')?.label, 'Regex Mode')
  assert.equal(modes.find((m) => m.key === 'late')?.label, 'Late')
  assert.equal(modes.find((m) => m.key === 'backtick-mode')?.label, 'Backtick Mode')
  assert.ok(!keys.includes('dynamic-${suffix}'))
  assert.ok(keys.includes('template-sibling'))
})

test('resolves by key and by label, case-insensitive', () => {
  assert.equal(resolveAmpMode('ultra'), 'ultra')
  assert.equal(resolveAmpMode('claude-fable-xhi'), 'claude-fable-xhi')
  assert.equal(resolveAmpMode('Claude Fable xhi'), 'claude-fable-xhi')
  assert.equal(resolveAmpMode('claude fable XHI'), 'claude-fable-xhi')
  assert.equal(resolveAmpMode('My Mode'), 'my-mode')
  assert.equal(resolveAmpMode('Label First'), 'label-first')
  assert.equal(resolveAmpMode('Regex Mode'), 'regex-mode')
  assert.equal(resolveAmpMode('Late'), 'late')
  assert.equal(resolveAmpMode('Backtick Mode'), 'backtick-mode')
  assert.equal(resolveAmpMode('Template Sibling'), 'template-sibling')
  assert.throws(() => resolveAmpMode('nope'), /unknown amp mode "nope"; available: low/)
})

test('amp adapter builds -m from model/mode and validates specs', () => {
  const amp = getAdapter('amp')
  const argvOf = (spec) => amp.build({ spec, prompt: 'hi', mode: 'fresh', sessionId: null }).argv
  let argv = argvOf({ model: 'Claude Fable 5' })
  assert.deepEqual(argv.slice(-2), ['-m', 'claude-fable-5'])
  argv = argvOf({ mode: 'my-mode', effort: 'xhigh' }) // explicit mode beats effort
  assert.deepEqual(argv.slice(-2), ['-m', 'my-mode'])
  argv = argvOf({ effort: 'xhigh' }) // effort → builtin mode fallback
  assert.deepEqual(argv.slice(-2), ['-m', 'ultra'])
  assert.equal(amp.validateSpec({ model: 'Claude Fable 5' }), null)
  assert.match(amp.validateSpec({ model: 'gpt-4' }), /unknown amp mode/)
})

test('amp adapter rejects out-of-vocabulary efforts at validateSpec time', () => {
  const amp = getAdapter('amp')
  // the effort table is closed — every accepted value maps to a builtin mode
  for (const e of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(amp.validateSpec({ effort: e }), null)
    assert.equal(typeof amp.mapEffort(e), 'string')
  }
  assert.equal(amp.validateSpec({}), null)
  // an unknown effort would map to undefined and blow up in spawn with
  // ERR_INVALID_ARG_TYPE — validateSpec turns it into a clean agent()-time
  // error listing the vocabulary
  assert.match(amp.validateSpec({ effort: 'turbo' }),
    /unknown effort "turbo".*accepted: none, minimal, low, medium, high, xhigh, max/)
  // effort is only consulted when no mode/model is given — an explicit mode
  // wins in build(), so a stray effort must not fail the spec
  assert.equal(amp.validateSpec({ mode: 'my-mode', effort: 'turbo' }), null)
  // prototype-chain names satisfy `in` (and a bare table index), so an
  // unguarded check would accept them and put a function/object into argv —
  // Object.hasOwn keeps them out of both validateSpec and mapEffort
  for (const e of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.match(amp.validateSpec({ effort: e }), /unknown effort/, `"${e}" must be rejected`)
    assert.equal(amp.mapEffort(e), undefined, `mapEffort("${e}") must not read the prototype`)
  }
})

test('amp/codex/opencode prepend spec.system on fresh turns only; claude keeps its native flag', () => {
  const spec = { system: 'be terse' }
  const preamble = '[system instructions]\nbe terse\n[task]\nhi'
  const scratch = fs.mkdtempSync(path.join(dir, 'scratch-'))

  // amp wraps the prompt in a stream-json user message
  const amp = getAdapter('amp')
  const ampFresh = JSON.parse(amp.build({ spec, prompt: 'hi', mode: 'fresh', sessionId: null }).stdin)
  assert.equal(ampFresh.message.content[0].text, preamble)
  const ampResume = JSON.parse(amp.build({ spec, prompt: 'hi', mode: 'resume', sessionId: 'T-1' }).stdin)
  assert.equal(ampResume.message.content[0].text, 'hi')

  // codex and opencode send the prompt raw on stdin
  const codex = getAdapter('codex')
  assert.equal(codex.build({ spec, prompt: 'hi', mode: 'fresh', sessionId: null, scratch }).stdin, preamble)
  assert.equal(codex.build({ spec, prompt: 'hi', mode: 'resume', sessionId: 't1', scratch }).stdin, 'hi')
  const opencode = getAdapter('opencode')
  assert.equal(opencode.build({ spec, prompt: 'hi', mode: 'fresh', sessionId: null }).stdin, preamble)
  assert.equal(opencode.build({ spec, prompt: 'hi', mode: 'resume', sessionId: 's1' }).stdin, 'hi')

  // claude has a real flag — no preamble, prompt untouched
  const claude = getAdapter('claude')
  const cb = claude.build({ spec, prompt: 'hi', mode: 'fresh', sessionId: null })
  assert.ok(cb.argv.includes('--append-system-prompt'))
  assert.equal(cb.argv[cb.argv.indexOf('--append-system-prompt') + 1], 'be terse')
  assert.equal(JSON.parse(cb.stdin).message.content[0].text, 'hi')

  // no system → no preamble anywhere
  assert.equal(codex.build({ spec: {}, prompt: 'hi', mode: 'fresh', sessionId: null, scratch }).stdin, 'hi')
})

test('codex and droid preserve supported efforts and expose secure temp files', () => {
  const scratch = fs.mkdtempSync(path.join(dir, 'scratch-'))
  const droid = getAdapter('droid')
  assert.equal(droid.mapEffort('none'), 'low')
  assert.equal(droid.mapEffort('minimal'), 'low')
  assert.equal(droid.mapEffort('xhigh'), 'xhigh')
  assert.equal(droid.mapEffort('max'), 'max')
  const droidBuild = droid.build({
    spec: { effort: 'max' },
    prompt: 'secret prompt',
    mode: 'fresh',
    sessionId: null,
    scratch,
  })
  assert.deepEqual(droidBuild.argv.slice(0, 4), ['exec', '-o', 'stream-json', '--skip-permissions-unsafe'])
  assert.ok(droidBuild.argv.includes('max'))
  assert.equal(droidBuild.tempFiles.length, 1)
  assert.equal(fs.statSync(droidBuild.tempFiles[0]).mode & 0o777, 0o600)

  const codex = getAdapter('codex')
  assert.equal(codex.mapEffort('minimal'), 'low')
  assert.equal(codex.mapEffort('max'), 'max')
  const codexBuild = codex.build({
    spec: { effort: 'max', schema: { type: 'object' } },
    prompt: 'hi',
    mode: 'fresh',
    sessionId: null,
    scratch,
  })
  assert.ok(codexBuild.argv.includes('model_reasoning_effort="max"'))
  assert.equal(codexBuild.tempFiles.length, 1)
  assert.equal(fs.statSync(codexBuild.tempFiles[0]).mode & 0o777, 0o600)
})
