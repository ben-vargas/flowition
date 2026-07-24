import test from 'node:test'
import assert from 'node:assert/strict'
import { makeParser } from '../src/adapters/protocols.js'

test('sawTerminal tracks each protocol completion signal', () => {
  const claude = makeParser('claude-stream')
  assert.equal(claude.sawTerminal, false)
  claude.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
  assert.equal(claude.sawTerminal, false)
  claude.push({ type: 'result', result: 'hi' })
  assert.equal(claude.sawTerminal, true)

  const amp = makeParser('claude-stream-eof')
  amp.push({ type: 'assistant', message: { content: [], stop_reason: 'end_turn' } })
  assert.equal(amp.sawTerminal, true)
  const ampResult = makeParser('claude-stream-eof')
  ampResult.push({ type: 'result', result: 'done' })
  assert.equal(ampResult.sawTerminal, true)

  const codex = makeParser('codex-jsonl')
  codex.push({ type: 'turn.completed', usage: {} })
  assert.equal(codex.sawTerminal, true)
  const failedCodex = makeParser('codex-jsonl')
  failedCodex.push({ type: 'turn.failed', error: { message: 'nope' } })
  assert.equal(failedCodex.sawTerminal, true)

  const droid = makeParser('droid-jsonl')
  droid.push({ type: 'completion' })
  assert.equal(droid.sawTerminal, true)

  const pi = makeParser('pi-jsonl')
  pi.push({ type: 'message_end', message: { role: 'assistant', content: 'step', stopReason: 'toolUse' } })
  assert.equal(pi.sawTerminal, false) // intermediate tool-use step is not terminal
  pi.push({ type: 'message_end', message: { role: 'assistant', content: 'done', stopReason: 'stop' } })
  assert.equal(pi.sawTerminal, true)
  const pi2 = makeParser('pi-jsonl')
  pi2.push({ type: 'agent_end' })
  assert.equal(pi2.sawTerminal, true)

  const opencode = makeParser('opencode-jsonl')
  opencode.push({ type: 'text', part: { id: 'p1', text: 'done' } })
  opencode.finish()
  assert.equal(opencode.sawTerminal, false)
})

test('codex usage preserves cumulative totals and cached input subset', () => {
  const parser = makeParser('codex-jsonl')
  assert.deepEqual(parser.push({
    type: 'turn.completed',
    usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 30 },
  }), [{
    k: 'usage',
    input: 120,
    cachedInput: 80,
    output: 30,
    cumulative: true,
  }])
})

test('malformed JSON event shapes are skipped without throwing', () => {
  for (const protocol of [
    'claude-stream',
    'claude-stream-eof',
    'codex-jsonl',
    'droid-jsonl',
    'opencode-jsonl',
    'pi-jsonl',
  ]) {
    const parser = makeParser(protocol)
    for (const value of [null, [], 'event', 1, {}, { type: 'assistant' }]) {
      assert.doesNotThrow(() => parser.push(value), `${protocol}: ${JSON.stringify(value)}`)
    }
  }

  const claude = makeParser('claude-stream')
  assert.deepEqual(claude.push({ type: 'assistant', message: { content: null } }), [])
  assert.deepEqual(claude.push({ type: 'assistant', message: { content: {} } }), [])
  assert.deepEqual(claude.push({ type: 'assistant' }), [])
  assert.deepEqual(claude.push({ type: 'assistant', message: { content: [null, {}] } }), [])
  assert.doesNotThrow(() => claude.push({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [null, {}] }] },
  }))

  const pi = makeParser('pi-jsonl')
  assert.doesNotThrow(() => pi.push({
    type: 'message_end',
    message: { role: 'assistant', content: [null, {}] },
  }))
})

test('opencode emits text once and counts cache writes as input', () => {
  const parser = makeParser('opencode-jsonl')
  assert.deepEqual(parser.push({
    type: 'text',
    part: { id: 'p1', text: 'hello' },
  }), [{ k: 'text', text: 'hello' }])
  assert.deepEqual(parser.push({
    type: 'text',
    part: { id: 'p1', text: 'hello' },
  }), [])
  assert.deepEqual(parser.push({
    type: 'step_finish',
    part: {
      tokens: { input: 10, cache: { read: 20, write: 30 }, output: 4, reasoning: 5 },
      cost: 0.25,
    },
  }), [{ k: 'usage', input: 60, output: 9, cost: 0.25 }])
  assert.deepEqual(parser.finish(), [{ k: 'result', text: 'hello' }])
})
