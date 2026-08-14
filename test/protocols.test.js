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

  const cursor = makeParser('cursor-jsonl')
  cursor.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
  assert.equal(cursor.sawTerminal, false)
  cursor.push({ type: 'result', subtype: 'success', is_error: false, result: 'hi', usage: {} })
  assert.equal(cursor.sawTerminal, true)
  assert.equal(cursor.terminalRequired, true) // truncated stream must be refused even on exit 0
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
    'cursor-jsonl',
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

  const cursor = makeParser('cursor-jsonl')
  assert.deepEqual(cursor.push({ type: 'assistant', message: { content: null } }), [])
  assert.deepEqual(cursor.push({ type: 'assistant', message: { content: [null, {}] } }), [])
  assert.deepEqual(cursor.push({ type: 'thinking' }), [])
  assert.deepEqual(cursor.push({ type: 'tool_call', subtype: 'started' }), [{ k: 'tool', name: 'tool', input: '{}' }])
  assert.deepEqual(cursor.push({ type: 'tool_call', subtype: 'completed' }), [{ k: 'tool-result', output: '', isError: false }])
})

test('cursor maps init/text/thinking/result and prefers the last assistant text', () => {
  const parser = makeParser('cursor-jsonl')
  const sid = '2404ad0f-aaaa-bbbb-cccc-1234567890ab'
  assert.deepEqual(parser.push({
    type: 'system', subtype: 'init', apiKeySource: 'env', cwd: '/tmp', session_id: sid, model: 'GPT-5.4 Mini Medium', permissionMode: 'default',
  }), [{ k: 'session', id: sid, model: 'GPT-5.4 Mini Medium' }])
  // the user event is cursor echoing the prompt — emitted as nothing
  assert.deepEqual(parser.push({
    type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] }, session_id: sid,
  }), [])
  // thinking deltas pass through per delta; the completed marker carries no text
  assert.deepEqual(parser.push({ type: 'thinking', subtype: 'delta', text: '**Planning**\n', session_id: sid }), [{ k: 'reasoning', text: '**Planning**\n' }])
  assert.deepEqual(parser.push({ type: 'thinking', subtype: 'completed', session_id: sid }), [])
  assert.deepEqual(parser.push({
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first message' }] }, session_id: sid,
  }), [{ k: 'text', text: 'first message' }])
  assert.deepEqual(parser.push({
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }] }, session_id: sid,
  }), [{ k: 'text', text: '{"ok":true}' }])
  // result.result concatenates every assistant text with no separator — the LAST
  // assistant message is the real final answer (the JSON payload in schema mode);
  // usage keys are camelCase and cache reads/writes count as input
  assert.deepEqual(parser.push({
    type: 'result', subtype: 'success', duration_ms: 16558, is_error: false,
    result: 'first message{"ok":true}', session_id: sid,
    usage: { inputTokens: 11953, outputTokens: 231, cacheReadTokens: 45568, cacheWriteTokens: 7 },
  }), [
    { k: 'usage', input: 11953 + 45568 + 7, output: 231 },
    { k: 'result', text: '{"ok":true}', isError: false },
  ])
  assert.equal(parser.sawTerminal, true)
})

test('cursor result falls back to m.result and maps error subtypes', () => {
  // a turn with no assistant event falls back to the result field
  const bare = makeParser('cursor-jsonl')
  assert.deepEqual(bare.push({ type: 'result', subtype: 'success', is_error: false, result: 'fallback', usage: {} }).at(-1), { k: 'result', text: 'fallback', isError: false })

  // is_error and a non-success subtype each mark the result as an error
  const err = makeParser('cursor-jsonl')
  assert.equal(err.push({ type: 'result', subtype: 'success', is_error: true, result: 'x', usage: {} }).at(-1).isError, true)
  const subErr = makeParser('cursor-jsonl')
  assert.equal(subErr.push({ type: 'result', subtype: 'error_during_execution', is_error: false, result: 'x', usage: {} }).at(-1).isError, true)

  // a malformed result with an ABSENT or null subtype is an error too — only an
  // explicit success may be cached as success
  const noSub = makeParser('cursor-jsonl')
  assert.equal(noSub.push({ type: 'result', is_error: false, result: 'x', usage: {} }).at(-1).isError, true)
  const nullSub = makeParser('cursor-jsonl')
  assert.equal(nullSub.push({ type: 'result', subtype: null, is_error: false, result: 'x', usage: {} }).at(-1).isError, true)
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

test('grok streaming-messages-json rides claude-stream: init, blocks, wire-id pairing, result', () => {
  // doc-derived grok wire lines — Anthropic Messages stream-json, snake_case usage
  const p = makeParser('claude-stream')
  const sid = '0198b1c2-1234-7abc-8def-0123456789ab'
  assert.deepEqual(p.push({ type: 'system', subtype: 'init', session_id: sid, model: 'grok-4', uuid: 'line-1' }),
    [{ k: 'session', id: sid, model: 'grok-4' }])
  assert.deepEqual(p.push({
    type: 'assistant', uuid: 'line-2',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan it' },
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 'toolu_g1', name: 'bash', input: { command: 'ls' } },
      ],
    },
  }), [
    { k: 'reasoning', text: 'plan it' },
    { k: 'text', text: 'working' },
    { k: 'tool', name: 'bash', input: '{"command":"ls"}', id: 'toolu_g1' },
  ])
  // tool_result pairs by the wire tool_use_id, never by order
  assert.deepEqual(p.push({
    type: 'user', uuid: 'line-3',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_g1', content: 'a.txt', is_error: false }] },
  }), [{ k: 'tool-result', output: 'a.txt', isError: false, toolUseId: 'toolu_g1' }])
  assert.equal(p.sawTerminal, false)
  assert.deepEqual(p.push({
    type: 'result', subtype: 'success', is_error: false, result: 'done', uuid: 'line-4',
    usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 },
    total_cost_usd: 0.12,
    structured_output: { ok: true },
  }), [
    { k: 'usage', input: 35, output: 7, cost: 0.12 },
    { k: 'result', text: 'done', structured: { ok: true }, isError: false },
  ])
  assert.equal(p.sawTerminal, true)
})

test('grok error subtypes, contentless schema turns, and unknown blocks are handled', () => {
  // schema-retry exhaustion is an error result, not a success with no payload
  const err = makeParser('claude-stream')
  const errOut = err.push({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, usage: {} })
  assert.equal(errOut.at(-1).isError, true)
  assert.equal(err.sawTerminal, true)

  // a contentless schema turn (init then result only) still captures the session —
  // capture must not depend on an assistant frame ever arriving
  const bare = makeParser('claude-stream')
  assert.deepEqual(bare.push({ type: 'system', subtype: 'init', session_id: 'sid-schema', model: 'grok-4' }),
    [{ k: 'session', id: 'sid-schema', model: 'grok-4' }])
  const bareOut = bare.push({ type: 'result', subtype: 'success', result: '{"ok":true}', structured_output: { ok: true }, usage: {} })
  assert.deepEqual(bareOut.at(-1), { k: 'result', text: '{"ok":true}', structured: { ok: true }, isError: false })

  // inline backend web-search blocks and stray uuid fields are ignored silently —
  // accepted v1 transcript-fidelity limitation, never a throw or a bogus event
  const odd = makeParser('claude-stream')
  assert.deepEqual(odd.push({
    type: 'assistant', uuid: 'x',
    message: {
      role: 'assistant',
      content: [
        { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'q' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] },
        { type: 'text', text: 'searched' },
      ],
    },
  }), [{ k: 'text', text: 'searched' }])
  assert.doesNotThrow(() => odd.push({ type: 'system', subtype: 'compact_boundary', uuid: 'y' }))

  // a stream truncated before result stays non-terminal (terminalRequired refusal)
  const cut = makeParser('claude-stream')
  cut.push({ type: 'system', subtype: 'init', session_id: 'sid-cut' })
  cut.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } })
  assert.equal(cut.sawTerminal, false)
  assert.equal(cut.terminalRequired, true)
  assert.deepEqual(cut.finish(), [])
})
