// events.jsonl — the observability stream (one event per state change), separate
// from the resume journal. `flowition status` / `flowition tail` fold or follow this file.
import path from 'node:path'
import { appendJsonl, readJsonl, truncate, fmtDuration } from './util.js'

export class EventSink {
  constructor(dir, { quiet = false } = {}) {
    this.file = path.join(dir, 'events.jsonl')
    this.quiet = quiet
  }
  emit(ev) {
    appendJsonl(this.file, { t: Date.now(), ...ev })
    if (!this.quiet) this.print(ev)
  }
  print(ev) {
    const line = renderEvent(ev)
    if (line) process.stderr.write(line + '\n')
  }
}

export function renderEvent(ev) {
  switch (ev.type) {
    case 'run': return `▶ run ${ev.runId} — ${ev.state}${ev.error ? ': ' + ev.error : ''}`
    case 'phase': return `┌ ${ev.title}`
    case 'log': return `❯ ${ev.message}`
    case 'agent': {
      const id = `[${ev.index}]`
      const who = [ev.adapter, ev.model].filter(Boolean).join(':')
      const label = ev.label ? ` ${ev.label}` : ''
      if (ev.state === 'running') return `  · ${id}${label} (${who}) running…`
      if (ev.state === 'cached') return `  ✓ ${id}${label} replayed from journal`
      if (ev.state === 'done') return `  ✓ ${id}${label} done ${ev.durationMs != null ? fmtDuration(ev.durationMs) : ''}${ev.outputTokens ? ` ${ev.outputTokens} out-tok` : ''}`
      if (ev.state === 'failed') return `  ✗ ${id}${label} failed: ${ev.error}`
      if (ev.state === 'cancelled') return `  ⊘ ${id}${label} cancelled`
      if (ev.state === 'steered') return `  ✉ ${id}${label} received message (${ev.delivery})`
      return null
    }
    case 'question': return `? [${ev.qid}] ${ev.question}   (answer with: flowition answer ${ev.runId} ${ev.qid} "<text>")`
    case 'answer': return `✓ [${ev.qid}] answered`
    case 'mail': return `✉ agent ${ev.agent} ${ev.dir === 'out' ? 'reports' : 'received'}: ${truncate(ev.message, 200)}`
    default: return null
  }
}

// Fold events.jsonl into a status snapshot for `flowition status` / MCP.
export function foldEvents(dir) {
  const events = readJsonl(path.join(dir, 'events.jsonl'))
  const snap = { run: null, phases: [], agents: new Map(), questions: new Map(), logs: [] }
  for (const ev of events) {
    if (ev.type === 'run') snap.run = { ...(snap.run || {}), ...ev }
    else if (ev.type === 'phase') snap.phases.push(ev.title)
    else if (ev.type === 'agent') snap.agents.set(ev.index, { ...(snap.agents.get(ev.index) || {}), ...ev })
    else if (ev.type === 'question') snap.questions.set(ev.qid, { ...ev, answered: false })
    else if (ev.type === 'answer' && snap.questions.has(ev.qid)) snap.questions.get(ev.qid).answered = true
    else if (ev.type === 'log') snap.logs.push(ev.message)
  }
  return snap
}
