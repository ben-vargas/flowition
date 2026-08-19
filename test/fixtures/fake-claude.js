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
//   FAKE_RACE_STEER    turn 1 completes only when a user message races in
//                      mid-turn: its result goes out unchanged (generated
//                      before the message existed), and the message is
//                      RETAINED unanswered until stdin EOF — only then does it
//                      run as its OWN drained turn before exit. This is the
//                      drain-at-EOF contract probed against the real CLI
//                      (2026-08-18, claude 2.1.235): user messages buffered on
//                      stdin before EOF are each answered with their own
//                      result before the process exits 0. Gating the drain on
//                      EOF makes the raced-steer test REQUIRE the engine to
//                      close stdin promptly once result 1 is parsed — under
//                      per-result accounting turn 2 never runs.
const TURN_MS = Number(process.env.FAKE_TURN_MS || 300)
const LINGER_MS = Number(process.env.FAKE_LINGER_MS || 0)
const RACE = !!process.env.FAKE_RACE_STEER
const args = process.argv.slice(2)
const resumed = args.includes('--resume')
const schema = args.includes('--json-schema')

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
out({ type: 'system', subtype: 'init', session_id: 'fake-session-1', model: 'fake-claude' })

let turn = 0
let running = false
let steers = []
let raced = [] // mid-turn messages the current result was generated WITHOUT (FAKE_RACE_STEER)
let ended = false
let currentText = ''

function runTurn(text) {
  running = true
  turn++
  steers = []
  currentText = text
  // Under FAKE_RACE_STEER turn 1's result is triggered by the raced message's
  // ARRIVAL (see the data handler), not a timer — deterministic ordering: the
  // parent has already written the steer when result 1 goes out.
  if (!(RACE && turn === 1)) setTimeout(finishTurn, TURN_MS)
}

function finishTurn() {
  const summary = `turn:${turn} resumed:${resumed} steers:${steers.length} msg:${currentText.replace(/\n/g, ' ').slice(0, 120)}`
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
  // Drain-at-EOF: a message buffered on stdin runs as its own turn only once
  // stdin has ENDED — until then it is held unanswered, so turn 2 happens only
  // if the parent actually closes stdin after parsing result 1. Otherwise
  // idle: wait for the next user message or stdin EOF.
  if (!ended) return
  if (raced.length) runTurn(raced.shift())
  else setTimeout(() => process.exit(0), LINGER_MS)
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
      if (RACE) {
        // raced steer: the running turn's result was generated before this
        // message existed — emit it unchanged NOW, then answer the message
        // as its own drained turn
        raced.push(text)
        finishTurn()
      } else steers.push(text)
    } else runTurn(text)
  }
})
process.stdin.on('end', () => {
  ended = true
  // finish a running turn first, like the real CLI; then drain buffered
  // messages, each as its own turn — finishTurn exits once nothing is left
  if (running) return
  if (raced.length) runTurn(raced.shift())
  else setTimeout(() => process.exit(0), LINGER_MS)
})
