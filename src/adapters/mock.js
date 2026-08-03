// Deterministic in-process adapter for tests. The "prompt" is a script of directives,
// one per line:
//   SESSION <id>        emit a session id
//   SLEEP <ms>          wait
//   ECHO <text>         final result = text
//   JSON <json>         final result text = json
//   WAIT_MAIL           block until a mail message arrives; result = "mail:<text>"
//   FAILN <name> <n>    fail while invocation count for <name> <= n (counters persist
//                       in $FLOWITION_HOME/mock-counters/ so resume tests cross processes)
//   FAILRETRY <name> <n> as FAILN, but the error is RETRYABLE — the engine re-executes
//                       the same job in place (src/engine.js retry branch) instead of
//                       failing the agent, which is the only way to script that path
//                       without a real process dying on a signal
//   BADJSON_ONCE <name> first invocation returns "not json", later ones return {"ok":true}
//   TOOL <name>         emit a tool + tool-result pair
//   NOSESSION           suppress the automatic opening session event, so the turn emits
//                       NOTHING until it returns — the only way to script a genuinely
//                       silent provider (DESIGN §8 E6: a silent agent emits no progress)
// A resume/follow-up turn invokes direct() with mode:'resume' and the follow-up prompt.
import fs from 'node:fs'
import path from 'node:path'
import { home, ensureDir } from '../util.js'

function bumpCounter(name) {
  // mkdir is atomic-exclusive, so concurrent processes can never observe the same
  // count (append-then-stat could); each invocation claims the next free slot.
  const dir = path.join(home(), 'mock-counters')
  ensureDir(dir)
  const base = path.join(dir, `counter-${encodeURIComponent(name)}`)
  for (let n = 1; ; n++) {
    try {
      fs.mkdirSync(`${base}-${n}`)
      return n
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
}

export default {
  name: 'mock',
  protocol: 'direct',
  bin: () => 'mock',
  caps: { steer: 'live', resume: true, schema: 'prompt', selfSession: false, acceptsModel: true },
  mapEffort: (e) => e,

  // io: { emit(event), waitMail(): Promise<string>, mode, sessionId }
  async direct({ prompt, io }) {
    const silent = /(^|\n)\s*NOSESSION\s*(\n|$)/.test(prompt)
    if (!silent) io.emit({ k: 'session', id: io.sessionId ?? 'mock-session-1' })
    // corrective follow-up turn from the schema-retry loop
    if (io.mode === 'resume' && prompt.includes('failed schema validation')) {
      io.emit({ k: 'usage', input: 5, output: 3 })
      return { text: '{"ok":true}' }
    }
    let result = ''
    let fallback = ''
    for (const raw of prompt.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const [cmd, ...rest] = line.split(' ')
      const arg = rest.join(' ')
      if (cmd === 'SLEEP') {
        const until = Date.now() + Number(arg)
        while (Date.now() < until && !io.isCancelled?.()) await new Promise((r) => setTimeout(r, 25))
      }
      else if (cmd === 'ECHO') result = arg
      else if (cmd === 'JSON') result = arg
      else if (cmd === 'SESSION') io.emit({ k: 'session', id: arg })
      else if (cmd === 'TOOL') {
        io.emit({ k: 'tool', name: arg || 'hammer', input: '{}' })
        io.emit({ k: 'tool-result', name: arg || 'hammer', output: 'ok' })
      } else if (cmd === 'WAIT_MAIL') {
        const mail = await io.waitMail()
        result = 'mail:' + mail
      } else if (cmd === 'FAILN') {
        const [name, n] = arg.split(' ')
        const count = bumpCounter(name)
        if (count <= Number(n)) throw Object.assign(new Error(`mock planned failure ${count}/${n}`), { retryable: false })
        result = `recovered:${name}:${count}`
      } else if (cmd === 'FAILRETRY') {
        const [name, n] = arg.split(' ')
        const count = bumpCounter(name)
        if (count <= Number(n)) throw Object.assign(new Error(`mock retryable failure ${count}/${n}`), { retryable: true })
        result = `recovered:${name}:${count}`
      } else if (cmd === 'BADJSON_ONCE') {
        const count = bumpCounter(arg)
        result = count <= 1 ? 'this is definitely not json' : '{"ok":true}'
      } else if (cmd === 'NOSESSION') {
        // handled above, before the script runs — never a fallback result
      } else if (cmd === 'CORRECT_WITH') {
        // used as follow-up prompt content marker in schema-retry tests — ignore
      } else {
        fallback = fallback || line
      }
    }
    result = result || fallback
    // A follow-up (resume) turn whose prompt is a corrective/steering message:
    if (io.mode === 'resume' && !result) result = 'resumed:' + prompt.slice(0, 40)
    io.emit({ k: 'usage', input: 10, output: 5 })
    return { text: result }
  },
}
