// W2 — E11 (DESIGN §8): per-adapter tool-call ids and call↔result pairing.
//
// The property under test is NON-POSITIONAL pairing: when a provider runs tools in
// parallel, the results come back in whatever order they finish, and a viewer that
// pairs by emission order draws the wrong output under the wrong call. Protocols
// that carry an id must surface it; the two that don't (droid, pi) get a synthesized
// one so every transcript pairs the same way — honestly labelled as positional here,
// because that is all their wire format supports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { makeParser } from '../src/adapters/protocols.js'
import { AgentJob } from '../src/agent-proc.js'
import { Journal } from '../src/journal.js'
import { Transcript } from '../src/transcript.js'
import { readJsonl } from '../src/util.js'

const toolsOf = (evs) => evs.filter((e) => e.k === 'tool')
const resultsOf = (evs) => evs.filter((e) => e.k === 'tool-result')

// ── claude-stream / claude-stream-eof: the protocol's own ids ────────────────
//
// These are two DISTINCT factory paths (src/adapters/protocols.js:320,:321) —
// `claude-stream-eof` is amp's protocol (src/adapters/index.js:177) and constructs
// the parser with turnEnd:true, so it gets its own pairing fixture rather than
// riding on claude's. The turn-end synthesis is exactly the branch that could
// reorder or swallow a block, so the amp case asserts pairing ACROSS it.

test('E11 claude-stream: parallel tool_use pairs by id, not by position', () => {
  const parser = makeParser('claude-stream')
  // ONE assistant message issuing three tools at once — the shape that makes
  // positional pairing wrong in the first place
  const calls = parser.push({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'running three things' },
        { type: 'tool_use', id: 'toolu_A', name: 'Read', input: { file: 'a.txt' } },
        { type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { cmd: 'ls' } },
        { type: 'tool_use', id: 'toolu_C', name: 'Grep', input: { q: 'x' } },
      ],
    },
  })
  assert.deepEqual(toolsOf(calls).map((e) => [e.name, e.id]), [['Read', 'toolu_A'], ['Bash', 'toolu_B'], ['Grep', 'toolu_C']])
  assert.equal(toolsOf(calls)[0].input, JSON.stringify({ file: 'a.txt' }))

  // results arrive REVERSED, and one of them is an error: position says C↔A, the id
  // says C↔C. Only the id is right.
  const done = parser.push({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_C', content: 'no matches', is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu_B', content: [{ type: 'text', text: 'a.txt\n' }] },
        { type: 'tool_result', tool_use_id: 'toolu_A', content: 'hello' },
      ],
    },
  })
  assert.deepEqual(resultsOf(done).map((e) => [e.toolUseId, e.output, e.isError]), [
    ['toolu_C', 'no matches', true],
    ['toolu_B', 'a.txt\n', false],
    ['toolu_A', 'hello', false],
  ])
  // the join a viewer performs: every result finds its call, and the pairing is
  // exactly the inverse of emission order
  const byId = new Map(toolsOf(calls).map((e) => [e.id, e.name]))
  assert.deepEqual(resultsOf(done).map((e) => byId.get(e.toolUseId)), ['Grep', 'Bash', 'Read'])
})

test('E11 claude-stream: an id-less block still parses — the field is simply absent', () => {
  const parser = makeParser('claude-stream')
  const calls = parser.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } })
  assert.equal('id' in calls[0], false)
  const done = parser.push({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })
  assert.equal('toolUseId' in done[0], false)
  // a non-string id is not guessed at — it would collide with the synthesized namespace
  const numeric = parser.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 7, name: 'Read' }] } })
  assert.equal('id' in numeric[0], false)
})

test('E11 amp (claude-stream-eof): parallel tool_use pairs by id across the turn-end synthesis', () => {
  const parser = makeParser('claude-stream-eof')
  // amp runs its turn with stdin held open, so the wire looks like claude's but the
  // terminal event is synthesized from stop_reason — the extra branch this parser has.
  const calls = parser.push({
    type: 'assistant',
    message: {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'three at once' },
        { type: 'tool_use', id: 'toolu_amp_A', name: 'Read', input: { file: 'a.txt' } },
        { type: 'tool_use', id: 'toolu_amp_B', name: 'Bash', input: { cmd: 'ls' } },
        { type: 'tool_use', id: 'toolu_amp_C', name: 'Grep', input: { q: 'x' } },
      ],
    },
  })
  assert.deepEqual(toolsOf(calls).map((e) => [e.name, e.id]), [['Read', 'toolu_amp_A'], ['Bash', 'toolu_amp_B'], ['Grep', 'toolu_amp_C']])
  // a tool_use stop_reason is NOT the end of the turn — no terminal yet
  assert.equal(calls.some((e) => e.k === 'turn-end'), false)
  assert.equal(parser.sawTerminal, false)

  // results come back REVERSED (C finished first): position says C↔A, the id says C↔C
  const done = parser.push({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_amp_C', content: 'no matches', is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu_amp_B', content: [{ type: 'text', text: 'a.txt\n' }] },
        { type: 'tool_result', tool_use_id: 'toolu_amp_A', content: 'hello' },
      ],
    },
  })
  assert.deepEqual(resultsOf(done).map((e) => [e.toolUseId, e.output, e.isError]), [
    ['toolu_amp_C', 'no matches', true],
    ['toolu_amp_B', 'a.txt\n', false],
    ['toolu_amp_A', 'hello', false],
  ])
  const byId = new Map(toolsOf(calls).map((e) => [e.id, e.name]))
  assert.deepEqual(resultsOf(done).map((e) => byId.get(e.toolUseId)), ['Grep', 'Bash', 'Read'])

  // the closing turn may issue a LAST tool alongside end_turn: the id must survive the
  // branch that appends the synthetic terminal, and its late result still joins.
  const closing = parser.push({
    type: 'assistant',
    message: { stop_reason: 'end_turn', content: [{ type: 'tool_use', id: 'toolu_amp_D', name: 'Write', input: {} }] },
  })
  assert.equal(toolsOf(closing)[0].id, 'toolu_amp_D')
  assert.equal(closing.at(-1).k, 'turn-end', 'the terminal is appended after the blocks, not in place of them')
  assert.equal(parser.sawTerminal, true)
  assert.equal(parser.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_amp_D', content: 'wrote' }] } })[0].toolUseId, 'toolu_amp_D')

  // and amp's id-less blocks behave exactly as claude's — the field is simply absent
  const bare = makeParser('claude-stream-eof')
  assert.equal('id' in bare.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } })[0], false)
  assert.equal('toolUseId' in bare.push({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })[0], false)
})

// ── codex: one item carries both halves ─────────────────────────────────────

test('E11 codex: both halves of a completed command are synthesized from the item id', () => {
  const parser = makeParser('codex-jsonl')
  const out = parser.push({
    type: 'item.completed',
    item: { id: 'item_7', type: 'command_execution', command: 'ls -la', aggregated_output: 'a\nb\n', status: 'completed' },
  })
  assert.deepEqual(out, [
    { k: 'tool', name: 'shell', input: 'ls -la', id: 'item_7' },
    { k: 'tool-result', name: 'shell', output: 'a\nb\n', isError: false, toolUseId: 'item_7' },
  ])
  // the generic item branch carries the id too, so an unpaired call is still addressable
  const generic = parser.push({ type: 'item.completed', item: { id: 'item_8', type: 'file_change' } })
  assert.equal(generic[0].id, 'item_8')
  // and two interleaved items never share an id
  const other = parser.push({ type: 'item.completed', item: { id: 'item_9', type: 'command_execution', command: 'pwd', status: 'failed' } })
  assert.equal(other[1].toolUseId, 'item_9')
  assert.equal(other[1].isError, true)
})

// ── opencode: part.id ────────────────────────────────────────────────────────

test('E11 opencode: the part id joins the call to its result', () => {
  const parser = makeParser('opencode-jsonl')
  const out = parser.push({
    type: 'tool',
    part: { id: 'prt_1', tool: 'edit', state: { status: 'completed', input: { path: 'x' }, output: 'ok' } },
  })
  assert.equal(out[0].id, 'prt_1')
  assert.equal(out[1].toolUseId, 'prt_1')
  // a second tool part in the same stream keeps its own identity
  const two = parser.push({
    type: 'tool',
    part: { id: 'prt_2', tool: 'bash', state: { status: 'error', input: {}, output: 'boom' } },
  })
  assert.equal(two[0].id, 'prt_2')
  assert.equal(two[1].toolUseId, 'prt_2')
  assert.equal(two[1].isError, true)
})

// ── droid / pi: synthesized ids ──────────────────────────────────────────────

test('E11 droid: ids are synthesized and paired FIFO; a wire id wins when present', () => {
  const parser = makeParser('droid-jsonl', { idSeed: 't1' })
  const a = parser.push({ type: 'tool_use', name: 'Read', input: { f: 'a' } })
  const b = parser.push({ type: 'tool_use', name: 'Bash', input: { c: 'ls' } })
  assert.equal(a[0].id, 't1-tool1')
  assert.equal(b[0].id, 't1-tool2')
  assert.notEqual(a[0].id, b[0].id)
  // droid's tool_result carries neither id nor name — FIFO is the only signal there is
  assert.equal(parser.push({ type: 'tool_result', output: 'contents' })[0].toolUseId, 't1-tool1')
  assert.equal(parser.push({ type: 'tool_result', output: 'listing' })[0].toolUseId, 't1-tool2')
  // an unmatched result is not invented into a pair
  assert.equal('toolUseId' in parser.push({ type: 'tool_result', output: 'orphan' })[0], false)

  // when the wire DOES carry an id, it wins over synthesis
  const withIds = makeParser('droid-jsonl', { idSeed: 't1' })
  assert.equal(withIds.push({ type: 'tool_call', id: 'call_x', name: 'Read' })[0].id, 'call_x')
  assert.equal(withIds.push({ type: 'tool_result', tool_use_id: 'call_x', output: 'y' })[0].toolUseId, 'call_x')
})

test('E11 droid/pi: the idSeed namespaces synthesized ids per turn', () => {
  // A parser instance lives for exactly ONE turn, but the transcript spans all of an
  // agent's turns: without the seed, turn 2's "tool1" would collide with turn 1's and
  // a viewer joining by id would pair across an attempt boundary.
  const turn1 = makeParser('droid-jsonl', { idSeed: 't1' })
  const turn2 = makeParser('droid-jsonl', { idSeed: 't2' })
  assert.equal(turn1.push({ type: 'tool_use', name: 'Read' })[0].id, 't1-tool1')
  assert.equal(turn2.push({ type: 'tool_use', name: 'Read' })[0].id, 't2-tool1')
  // seedless (a direct makeParser call) still produces ids, just unnamespaced
  assert.equal(makeParser('droid-jsonl').push({ type: 'tool_use', name: 'Read' })[0].id, 'tool1')
})

test('E11 pi: interleaved tool executions pair by name before falling back to FIFO', () => {
  const parser = makeParser('pi-jsonl', { idSeed: 't1' })
  const read = parser.push({ type: 'tool_execution_start', toolName: 'Read', args: { f: 'a' } })
  const bash = parser.push({ type: 'tool_execution_start', toolName: 'Bash', args: { c: 'ls' } })
  assert.deepEqual([read[0].id, bash[0].id], ['t1-tool1', 't1-tool2'])
  // Bash finishes FIRST. pi's end event names the tool, so the pairing follows the
  // name rather than the order — the parallel case that positional pairing gets wrong.
  const bashDone = parser.push({ type: 'tool_execution_end', toolName: 'Bash', result: 'listing' })
  assert.equal(bashDone[0].toolUseId, 't1-tool2')
  const readDone = parser.push({ type: 'tool_execution_end', toolName: 'Read', result: 'contents' })
  assert.equal(readDone[0].toolUseId, 't1-tool1')

  // an explicit call id beats both heuristics
  const explicit = makeParser('pi-jsonl', { idSeed: 't1' })
  assert.equal(explicit.push({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'Read' })[0].id, 'c1')
  assert.equal(explicit.push({ type: 'tool_execution_end', toolCallId: 'c1', result: 'x' })[0].toolUseId, 'c1')
})

// ── the id reaches the transcript ────────────────────────────────────────────

test('E11: handleEvent stores ids on the transcript, and adapters without ids write what they always did', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-tool-ids-'))
  const transcript = new Transcript(dir, 0)
  const job = new AgentJob({
    adapter: { name: 'x', protocol: 'direct', caps: { steer: 'turn', resume: false, schema: 'prompt', selfSession: false } },
    spec: {}, prompt: 'p', index: 0, key: 'k', label: null, runId: 'r',
    scratch: dir, transcript, journal: new Journal(dir),
  })
  job.handleEvent({ k: 'tool', name: 'Read', input: '{}', id: 'toolu_A' })
  job.handleEvent({ k: 'tool', name: 'Bash', input: '{}' })              // id-less adapter
  job.handleEvent({ k: 'tool-result', output: 'ok', isError: false, toolUseId: 'toolu_A' })
  job.handleEvent({ k: 'tool-result', output: 'ok2', isError: false })

  const recs = readJsonl(transcript.file)
  assert.deepEqual(recs.map((r) => r.kind), ['tool', 'tool', 'tool-result', 'tool-result'])
  assert.equal(recs[0].id, 'toolu_A')
  assert.equal('id' in recs[1], false, 'an absent id must not be written as null')
  assert.equal(recs[2].toolUseId, 'toolu_A')
  assert.equal('toolUseId' in recs[3], false)
  // the last-tool telemetry E6 reports is unaffected
  assert.equal(job.lastTool, 'Bash')
})
