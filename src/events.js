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
    case 'step': {
      if (ev.state === 'running') return `  ⚙ step ${ev.name} running…`
      if (ev.state === 'cached') return `  ✓ step ${ev.name} replayed from journal`
      if (ev.state === 'done') return `  ✓ step ${ev.name} done${ev.durationMs != null ? ' ' + fmtDuration(ev.durationMs) : ''}`
      if (ev.state === 'failed') return `  ✗ step ${ev.name} failed: ${ev.error}`
      return null
    }
    case 'question': return `? [${ev.qid}] ${ev.question}   (answer with: flowition answer ${ev.runId} ${ev.qid} "<text>")`
    case 'answer': return `✓ [${ev.qid}] answered`
    case 'mail': return `✉ agent ${ev.agent} ${ev.dir === 'out' ? 'reports' : 'received'}: ${truncate(ev.message, 200)}`
    default: return null
  }
}

// States that mean "this attempt is alive or succeeded". Entering one of them must
// drop the PREVIOUS attempt's failure/outcome fields (DESIGN §8 E15 / G11): the old
// fold only ever spread-merged, so `flowition status` showed a resumed-and-succeeded
// agent still carrying its old error — and old runs on disk fold correctly too.
const CLEARS_ERROR = new Set(['queued', 'running', 'cached', 'done'])
const STALE_ON_TRANSITION = ['error', 'code', 'errorCode', 'retryable', 'durationMs', 'resultPreview']
// Annotations, not transitions: they must not overwrite `state` (§6.4 step 3).
const ANNOTATIONS = new Set(['progress', 'steered'])

function foldAgent(prev, ev) {
  const base = { ...(prev || {}) }
  if (CLEARS_ERROR.has(ev.state)) for (const f of STALE_ON_TRANSITION) delete base[f]
  const merged = { ...base, ...ev }
  if (ANNOTATIONS.has(ev.state)) merged.state = prev?.state ?? ev.state
  return merged
}

// Fold events.jsonl into a status snapshot for `flowition status` / MCP.
export function foldEvents(dir) {
  const events = readJsonl(path.join(dir, 'events.jsonl'))
  const snap = { run: null, phases: [], agents: new Map(), steps: new Map(), questions: new Map(), logs: [] }
  for (const ev of events) {
    if (ev.type === 'run') snap.run = { ...(snap.run || {}), ...ev }
    else if (ev.type === 'phase') snap.phases.push(ev.title)
    else if (ev.type === 'agent') snap.agents.set(ev.index, foldAgent(snap.agents.get(ev.index), ev))
    // Steps share the agent fold: same state names, same stale-field clearing
    // on a live transition (a re-run step must drop its previous failure).
    else if (ev.type === 'step') snap.steps.set(ev.key, foldAgent(snap.steps.get(ev.key), ev))
    else if (ev.type === 'question') snap.questions.set(ev.qid, { ...ev, answered: false })
    else if (ev.type === 'answer' && snap.questions.has(ev.qid)) snap.questions.get(ev.qid).answered = true
    else if (ev.type === 'log') snap.logs.push(ev.message)
  }
  return snap
}
