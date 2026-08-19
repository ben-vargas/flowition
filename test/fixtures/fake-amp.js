#!/usr/bin/env node
// Scripted stand-in for amp in `-x --stream-json --stream-json-input` mode.
// Default behavior matches amp's documented (owner's manual appendix) turn
// model, which does NOT share claude's coalescing: a user message sent without
// `steer: true` while the agent is busy is QUEUED and run as its own turn once
// the current one ends — each turn closes with its own stop_reason=end_turn —
// results only flush at stdin EOF, and the process exits once the assistant is
// done AND stdin is closed. Knobs (env):
//   FAKE_TURN_MS       turn duration in ms (default 200)
//   FAKE_AMP_COALESCE  hypothetical-regression mode: a mid-turn message is
//                      coalesced into the running turn (single end_turn), then
//                      the result flushes and the process exits unilaterally
const TURN_MS = Number(process.env.FAKE_TURN_MS || 200)
const COALESCE = !!process.env.FAKE_AMP_COALESCE

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
out({ type: 'system', subtype: 'init', session_id: 'fake-amp-1' })

let turn = 0
let running = false
let ended = false
let steers = []
const queue = []
const results = []

function maybeExit() {
  if (running || queue.length) return
  if (COALESCE) {
    // regression mode: flush and leave without waiting for stdin EOF
    for (const r of results.splice(0)) out(r)
    process.exit(0)
  }
  if (ended) {
    for (const r of results.splice(0)) out(r)
    process.exit(0)
  }
}

function runTurn(text) {
  running = true
  turn++
  steers = []
  setTimeout(() => {
    const summary = `turn:${turn} steers:${steers.length} msg:${text.replace(/\n/g, ' ').slice(0, 120)}`
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: summary }], stop_reason: 'end_turn' }, session_id: 'fake-amp-1' })
    results.push({ type: 'result', subtype: 'success', is_error: false, result: summary, usage: { input_tokens: 10, output_tokens: 5 } })
    running = false
    if (queue.length) runTurn(queue.shift())
    else maybeExit()
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
    if (!running) runTurn(text)
    else if (COALESCE) steers.push(text) // consumed into the running turn
    else queue.push(text) // amp's real model: queued as its own next turn
  }
})
process.stdin.on('end', () => { ended = true; maybeExit() })
