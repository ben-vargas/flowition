#!/usr/bin/env node
// Scripted stand-in for the claude CLI in `-p --input-format stream-json
// --output-format stream-json` mode, reproducing the empirically verified
// behavior behind issue #3 (forensics: flo_746b2999 agent 9, flo_3a015a87
// agent 0): ONE terminal `result` event per TURN — a user message arriving
// while the turn is running is coalesced into it and never gets a result of
// its own — and, because --input-format stream-json keeps the session open,
// the process exits only at stdin EOF. Knobs (env):
//   FAKE_TURN_MS       turn duration in ms (default 300)
//   FAKE_LINGER_MS     delay between stdin EOF and exit (default 0)
//   FAKE_DIE_MID_TURN  exit(1) with NO result the moment a steer lands mid-turn
//   FAKE_ERROR_RESULT  emit the terminal result with is_error: true
const TURN_MS = Number(process.env.FAKE_TURN_MS || 300)
const LINGER_MS = Number(process.env.FAKE_LINGER_MS || 0)
const args = process.argv.slice(2)
const resumed = args.includes('--resume')
const schema = args.includes('--json-schema')

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
out({ type: 'system', subtype: 'init', session_id: 'fake-session-1', model: 'fake-claude' })

let turn = 0
let running = false
let steers = []

function runTurn(text) {
  running = true
  turn++
  steers = []
  setTimeout(() => {
    const summary = `turn:${turn} resumed:${resumed} steers:${steers.length} msg:${text.replace(/\n/g, ' ').slice(0, 120)}`
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: summary }] }, session_id: 'fake-session-1' })
    if (schema) {
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'StructuredOutput', input: { ship: true } }] }, session_id: 'fake-session-1' })
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Structured output provided successfully' }] } })
    }
    out({
      type: 'result',
      subtype: process.env.FAKE_ERROR_RESULT ? 'error_during_execution' : 'success',
      is_error: !!process.env.FAKE_ERROR_RESULT,
      result: summary,
      ...(schema && !process.env.FAKE_ERROR_RESULT ? { structured_output: { ship: true } } : {}),
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01,
    })
    running = false
    // now idle: wait for the next user message or stdin EOF, like the real CLI
  }, TURN_MS)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.type !== 'user') continue
    const text = m.message?.content?.[0]?.text ?? ''
    if (running) {
      // mid-turn steer: coalesced into the running turn, no result of its own
      if (process.env.FAKE_DIE_MID_TURN) process.exit(1)
      steers.push(text)
    } else runTurn(text)
  }
})
process.stdin.on('end', () => { setTimeout(() => process.exit(0), LINGER_MS) })
