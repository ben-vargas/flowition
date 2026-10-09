// Pure helpers: parsing flowition's --json output, formatting, rendering results and
// badges, and deciding what changed between two polls. No `$` here, so the tests
// exercise them directly.
import type {
  FlowitionCockpitDetail as Detail,
  FlowitionCockpitLane as Lane,
  FlowitionCockpitLogEntry as LogEntry,
  FlowitionCockpitPathSeg as PathSeg,
  FlowitionCockpitTimeline as Timeline,
  FlowitionCockpitEvent as ThreadEvent,
  FlowitionCockpitRun as Run,
  FlowitionCockpitWorker as Worker,
} from '../types'

const LIVE = new Set(['running', 'starting', 'resuming'])

export const isLive = (state: string): boolean => LIVE.has(state)

/**
 * Run states that are final for an attempt. Anything else (live, `unknown` while a
 * detached launch has not written its journal yet) may still be heading somewhere.
 */
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'stale', 'corrupt', 'corrupt-result'])

export const isTerminal = (state: string): boolean => TERMINAL.has(state)

/** An agent that can still be steered or cancelled. */
export const isActive = (state: string): boolean => isLive(state) || state === 'queued'

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const obj = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})

/**
 * `flowition runs --json`: newest first, as the CLI sorts it. Output cut short (at
 * $.process.run's 4 MiB cap, a very long history) keeps every complete row before the
 * cut: the newest runs, which are the ones the pane shows.
 */
export function parseRuns(stdout: string): Run[] {
  let rows: unknown
  try {
    rows = JSON.parse(stdout)
  } catch {
    const cut = stdout.lastIndexOf('},{')
    rows = cut > 0 ? JSON.parse(`${stdout.slice(0, cut + 1)}]`) : []
  }
  if (!Array.isArray(rows)) return []
  const out: Run[] = []
  for (const raw of rows) {
    const r = obj(raw)
    const runId = str(r.runId)
    if (!runId) continue
    out.push({ runId, state: str(r.state) ?? 'unknown', file: str(r.file) ?? '?', createdAt: num(r.createdAt) ?? 0 })
  }
  return out
}

/** How many of the newest runs a history too long for one read keeps (with every unfinished one). */
export const RUNS_KEPT = 2000

/**
 * Filters `flowition runs --json` on stdin down to every unfinished run plus the newest
 * RUNS_KEPT (argv[1]): line 1 is the full count, line 2 the rows. Run by node, which the
 * CLI itself needs, when a listing is too long for $.process.run's 4 MiB stdout.
 */
export const RUNS_FILTER_JS = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>{s+=d});process.stdin.on('end',()=>{const rows=JSON.parse(s);const done=new Set(${JSON.stringify([...TERMINAL])});const n=Number(process.argv[1]);process.stdout.write(rows.length+'\\n'+JSON.stringify(rows.filter((r,i)=>i<n||!done.has(r&&r.state)))+'\\n')})`

/** The filter's output: the rows it kept and how many there were in all. */
export function parseFilteredRuns(stdout: string): { runs: Run[]; total: number | null } {
  const nl = stdout.indexOf('\n')
  const total = Number(stdout.slice(0, nl))
  return { runs: parseRuns(stdout.slice(nl + 1)), total: nl > 0 && Number.isInteger(total) ? total : null }
}

const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** What the run list says it leaves out, or null when it shows every run. */
export function listNoteOf(shown: number, total: number | null): string | null {
  if (total === null) return 'The run history is too long to list in full: older runs are not shown.'
  return total > shown ? `Showing every unfinished run and the newest ${grouped(RUNS_KEPT)} of ${grouped(total)} runs.` : null
}

function toWorker(raw: unknown, kind: 'agent' | 'step'): Worker {
  const a = obj(raw)
  const usage = obj(a.usage)
  const index = num(a.index)
  return {
    id: kind === 'agent' ? `a:${index ?? '?'}` : `s:${str(a.key) ?? str(a.name) ?? '?'}`,
    kind,
    index: kind === 'agent' ? index : null,
    label: str(kind === 'agent' ? a.label : a.name) ?? (kind === 'agent' ? `agent ${index ?? '?'}` : 'step'),
    adapter: kind === 'agent' ? str(a.adapter) : null,
    model: kind === 'agent' ? str(a.model) : null,
    effort: str(a.effort),
    state: str(a.state) ?? 'unknown',
    durationMs: num(a.durationMs),
    // `t` moves on every progress event; only a finished worker's is needed (the run's
    // duration), so a live one carries none and its polls compare equal.
    lastAt: isActive(str(a.state) ?? '') ? null : num(a.t),
    lastOutputAt: num(a.lastOutputAt),
    tool: str(a.tool),
    outputTokens: num(a.outputTokens) ?? num(usage.output),
    cost: num(usage.cost),
    error: str(a.error),
    phase: str(a.phase),
    phaseIndex: num(a.phaseIndex),
  }
}

/** `flowition status <id> --json`, trimmed to what the pane draws. */
export function parseStatus(stdout: string, fetchedAt: number): Detail {
  const d = obj(JSON.parse(stdout))
  const runId = str(d.runId) ?? '?'
  const agents = Array.isArray(d.agents) ? d.agents.map((a) => toWorker(a, 'agent')) : []
  agents.sort((x, y) => (x.index ?? 0) - (y.index ?? 0))
  const steps = Array.isArray(d.steps) ? d.steps.map((s) => toWorker(s, 'step')) : []
  const questions = Array.isArray(d.questions)
    ? d.questions.flatMap((q) => {
        const o = obj(q)
        const qid = str(o.qid)
        return qid ? [{ qid, question: str(o.question) ?? '' }] : []
      })
    : []
  const result = obj(d.result)
  const costs = agents.map((a) => a.cost).filter((c): c is number => c !== null)
  return {
    runId,
    state: str(d.state) ?? 'unknown',
    phases: Array.isArray(d.phases) ? d.phases.filter((p): p is string => typeof p === 'string') : [],
    workers: [...agents, ...steps],
    questions,
    spentOutputTokens: num(obj(d.live).spentOutputTokens),
    cost: costs.length ? costs.reduce((s, c) => s + c, 0) : null,
    resultMarkdown: result.status === 'completed' && result.result !== undefined ? toMarkdown(result.result) : null,
    error: str(result.error),
    fetchedAt,
  }
}

const TOO_LARGE = (runId: string) =>
  `_The result is too large for the pane to read (its status is over 4 MiB). Open the run in the viewer, or run \`flowition result ${runId}\`._`

/**
 * `flowition status --json` as polled: parsed whole, or, when the output was cut at
 * $.process.run's 4 MiB cap (a huge result) or does not parse, the run's state read off
 * the head of the output (`{"runId":…,"state":…` comes first), the rest kept from the
 * last good poll, so the poll still sees the run end.
 */
export function readStatus(stdout: string, isTruncated: boolean, prev: Detail | undefined, runId: string, now: number): Detail {
  if (!isTruncated) {
    try {
      return parseStatus(stdout, now)
    } catch {
      // read the head below
    }
  }
  const state = /^\{"runId":"[^"]*","state":"([a-z-]+)"/.exec(stdout)?.[1] ?? prev?.state ?? 'unknown'
  const base = prev ?? placeholder(runId, now)
  return { ...base, runId, state, fetchedAt: now, resultMarkdown: isLive(state) ? null : TOO_LARGE(runId) }
}

/** A detail standing in for a run this session launched, before its first poll. */
export const placeholder = (runId: string, fetchedAt: number): Detail => ({
  runId,
  state: 'starting',
  phases: [],
  workers: [],
  questions: [],
  spentOutputTokens: null,
  cost: null,
  resultMarkdown: null,
  error: null,
  fetchedAt,
})

export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Two polls of one run that would draw the same, `fetchedAt` aside. */
export const sameDetail = (a: Detail, b: Detail): boolean => sameJson({ ...a, fetchedAt: 0 }, { ...b, fetchedAt: 0 })

export const hasEnded = (prev: Detail | undefined, next: Detail): boolean =>
  prev !== undefined && !isTerminal(prev.state) && isTerminal(next.state)

/**
 * Whether a run armed with "Tell Claude when done" should wake Claude now: whenever a
 * poll finds it ended, however it got there (it ended between polls, a reload cleared
 * what the pane knew, or it was armed just as it ended). Firing disarms it. A run whose
 * state is not final (`unknown` before a detached launch writes its journal, or a status
 * that could not be read) stays armed.
 */
export const shouldWake = (_prev: Detail | undefined, next: Detail, isArmed: boolean): boolean => isArmed && isTerminal(next.state)

/** Toasts owed between two polls of one run: it ended, or it asked something new. */
export function transitions(prev: Detail | undefined, next: Detail): string[] {
  const out: string[] = []
  const asked = new Set(prev?.questions.map((q) => q.qid) ?? [])
  for (const q of next.questions) {
    if (!asked.has(q.qid)) out.push(`${next.runId} asks: ${q.question}`)
  }
  if (hasEnded(prev, next)) out.push(`${next.runId} ${next.state}${next.error ? `: ${next.error}` : ''}`)
  return out
}

/** Did this shell command launch or resume a flowition run? */
export const isFlowitionLaunch = (command: string): boolean =>
  /(^|[\s;&|(/])(flo|flowition)(\.js)?\s+(run|resume)\b/.test(command)

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

/** The runId a launch printed: detached text, --json, or the foreground `run <id>` line. */
export function extractRunId(text: string): string | null {
  const patterns = [/started detached run (\S+)/, /"runId"\s*:\s*"([^"]+)"/, /^run (\S+)$/m]
  for (const p of patterns) {
    const id = p.exec(text)?.[1]
    if (id && RUN_ID.test(id)) return id
  }
  return null
}

/** `http://host/#/?t=…` → `http://host/#/run/<id>?t=…`, the viewer's run route. */
export function deepLink(base: string, runId: string): string {
  return base.includes('#/?') ? base.replace('#/?', `#/run/${encodeURIComponent(runId)}?`) : base
}

/** `review-r2.workflow.mjs` → `review-r2`: what a person calls the run. */
export const titleOf = (file: string): string => file.replace(/(\.workflow)?\.(m?js|cjs|ts)$/, '') || file

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtAge(now: number, t: number): string {
  if (!t) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

export const fmtCost = (c: number): string => (c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`)

/** How long the run took (or has taken): from its creation to its last agent event. */
export function runDuration(run: Run | undefined, d: Detail | undefined, now: number): number | null {
  if (!run?.createdAt) return null
  if (d && isLive(d.state)) return now - run.createdAt
  const last = Math.max(0, ...(d?.workers.map((w) => w.lastAt ?? 0) ?? []))
  return last > run.createdAt ? last - run.createdAt : null
}

/** The status line: live runs and waiting questions, or nothing when all is quiet. */
export function statusLine(runs: Run[], details: Record<string, Detail>): string | undefined {
  const live = runs.filter((r) => isLive(r.state))
  if (live.length === 0) return undefined
  const questions = live.reduce((n, r) => n + (details[r.runId]?.questions.length ?? 0), 0)
  const parts = [`flo · ${live.length} running`]
  if (questions) parts.push(`${questions} question${questions === 1 ? '' : 's'} waiting`)
  return parts.join(' · ')
}

export type Tone = 'success' | 'error' | 'warning' | 'suggestion' | 'inactive'

/** Theme color for a run or worker state. */
export function stateColor(state: string): Tone {
  if (state === 'completed' || state === 'done' || state === 'cached') return 'success'
  if (state === 'failed' || state === 'corrupt' || state === 'corrupt-result' || state === 'cancelled') return 'error'
  if (state === 'interrupted' || state === 'stale' || state === 'unknown') return 'warning'
  if (isLive(state)) return 'suggestion'
  return 'inactive'
}

// Mid-tone hues that read on light and dark backgrounds alike.
const HEX: Record<Tone, string> = {
  success: '#2f9e5f',
  error: '#d64545',
  warning: '#c98a0b',
  suggestion: '#3b7ddd',
  inactive: '#8a8f98',
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"`

/** A tinted pill with the state's name: the desktop's badge. */
export function badgeSvg(state: string): { source: string; width: number; height: number } {
  const hex = HEX[stateColor(state)]
  const width = Math.round(22 + state.length * 6.4)
  const height = 20
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="9.5" fill="${hex}" fill-opacity="0.14" stroke="${hex}" stroke-opacity="0.35"/>` +
    `<circle cx="10" cy="10" r="3" fill="${hex}"/>` +
    `<text x="17" y="14" ${FONT} font-size="11" font-weight="600" fill="${hex}">${xml(state)}</text></svg>`
  return { source, width, height }
}

const GROUPS: { tone: Tone; states: string[] }[] = [
  { tone: 'success', states: ['done', 'cached'] },
  { tone: 'suggestion', states: ['running'] },
  { tone: 'error', states: ['failed', 'cancelled'] },
  { tone: 'inactive', states: [] },
]

/** Counts of workers per tone, in bar order; anything unlisted counts as inactive. */
export function progress(workers: Worker[]): { tone: Tone; count: number }[] {
  return GROUPS.map((g, i) => ({
    tone: g.tone,
    count: workers.filter((w) => (i === GROUPS.length - 1 ? !GROUPS.some((o) => o.states.includes(w.state)) : g.states.includes(w.state))).length,
  }))
}

/**
 * A segmented progress bar over the run's workers: the desktop's header bar. The
 * markup is far wider than any pane and stretches (`preserveAspectRatio="none"`), so
 * an Svg drawn with no `width` takes its slot's full width, which is all the room.
 */
export function progressSvg(workers: Worker[]): string {
  const vw = 1000
  const height = 6
  const total = workers.length || 1
  let x = 0
  const parts = progress(workers)
    .filter((p) => p.count > 0)
    .map((p) => {
      const w = (p.count / total) * vw
      const rect = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" fill="${HEX[p.tone]}"/>`
      x += w
      return rect
    })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${height}" viewBox="0 0 ${vw} ${height}" preserveAspectRatio="none">` +
    `<rect width="${vw}" height="${height}" fill="${HEX.inactive}" fill-opacity="0.25"/>${parts.join('')}</svg>`
  )
}

// ---- results as Markdown ---------------------------------------------------------

const MAX_MARKDOWN = 20_000
const TITLE_KEYS = ['headline', 'title', 'name', 'label', 'id']
const LINK_KEYS = ['url', 'href', 'link']
const isPrimitive = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const esc = (s: string): string => s.replace(/([\\*_`[\]])/g, '\\$1')
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function inline(v: unknown): string {
  if (typeof v === 'string') return esc(oneLine(v))
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number' || typeof v === 'boolean') return `\`${String(v)}\``
  if (Array.isArray(v) && v.every(isPrimitive)) return v.map(inline).join(', ')
  const json = JSON.stringify(v)
  return `\`${json.length > 160 ? `${json.slice(0, 159)}…` : json}\``
}

/** One object as a list item: its title (linked when it has a URL), facts, then prose. */
function item(o: Record<string, unknown>): string {
  const titleKey = TITLE_KEYS.find((k) => typeof o[k] === 'string')
  const linkKey = LINK_KEYS.find((k) => typeof o[k] === 'string' && /^https?:\/\//.test(o[k] as string))
  const title = titleKey ? esc(oneLine(o[titleKey] as string)) : null
  const link = linkKey ? (o[linkKey] as string).replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : '%20')) : null
  const head = title ? (link ? `**[${title}](${link})**` : `**${title}**`) : link ? `<${link}>` : ''
  const rest = Object.entries(o).filter(([k]) => k !== titleKey && k !== linkKey)
  const facts = rest.filter(([, v]) => !(typeof v === 'string' && v.length > 60) && isPrimitive(v))
  const prose = rest.filter(([, v]) => typeof v === 'string' && v.length > 60)
  const nested = rest.filter(([, v]) => !isPrimitive(v))
  const lines = [head || inline(facts.shift()?.[1])]
  if (facts.length) lines.push(`_${facts.map(([k, v]) => `${esc(k)}: ${inline(v)}`).join(' · ')}_`)
  for (const [, v] of prose) lines.push(esc(oneLine(v as string)))
  for (const [k, v] of nested) lines.push(`${esc(k)}: ${inline(v)}`)
  return `- ${lines.join('  \n  ')}`
}

function block(v: unknown, depth: number): string {
  if (typeof v === 'string') return v
  if (isPrimitive(v)) return inline(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '_none_'
    return v.map((x) => (isRecord(x) ? item(x) : `- ${inline(x)}`)).join('\n')
  }
  const entries = Object.entries(v as Record<string, unknown>)
  if (depth >= 2) return entries.map(([k, x]) => `- **${esc(k)}:** ${inline(x)}`).join('\n')
  const scalar = entries.filter(([, x]) => isPrimitive(x) && !(typeof x === 'string' && x.includes('\n')))
  const scalarKeys = new Set(scalar.map(([k]) => k))
  const complex = entries.filter(([k]) => !scalarKeys.has(k))
  const out: string[] = []
  if (scalar.length) out.push(scalar.map(([k, x]) => `- **${esc(k)}:** ${inline(x)}`).join('\n'))
  for (const [k, x] of complex) out.push(`${'#'.repeat(depth + 3)} ${esc(k)}\n\n${block(x, depth + 1)}`)
  return out.join('\n\n')
}

/** A workflow's JSON result as readable Markdown: headings per key, linked list items. */
export function toMarkdown(value: unknown): string {
  const md = block(value, 0)
  return md.length > MAX_MARKDOWN ? `${md.slice(0, MAX_MARKDOWN)}\n\n_…cut here; open the run in the viewer for the rest._` : md
}

// ---- agent transcripts -----------------------------------------------------------

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s)

const SUMMARY_KEYS = ['command', 'cmd', 'query', 'url', 'file_path', 'path', 'pattern', 'description', 'prompt']

/** A tool call's input in one line: the field a person would name it by. */
export function summarizeInput(input: unknown): string {
  let v: unknown = input
  if (typeof input === 'string') {
    try {
      v = JSON.parse(input)
    } catch {
      return oneLine(input).slice(0, 160)
    }
  }
  if (isRecord(v)) {
    for (const k of SUMMARY_KEYS) {
      const x = v[k]
      if (typeof x === 'string' && x) return oneLine(x).slice(0, 160)
      if (Array.isArray(x) && x.length && x.every((y) => typeof y === 'string')) return oneLine(x.join(' ')).slice(0, 160)
    }
    const first = Object.values(v).find((x) => typeof x === 'string' && x)
    if (typeof first === 'string') return oneLine(first).slice(0, 160)
  }
  if (typeof v === 'string') return oneLine(v).slice(0, 160)
  return oneLine(JSON.stringify(v) ?? '').slice(0, 160)
}

function pretty(input: unknown): string {
  if (typeof input === 'string') {
    try {
      return JSON.stringify(JSON.parse(input), null, 2)
    } catch {
      return input
    }
  }
  return JSON.stringify(input, null, 2) ?? ''
}

/** Transcript JSONL (whole lines) → drawable events, numbered from `seq`. */
export function parseTranscript(text: string, seq: number): ThreadEvent[] {
  const out: ThreadEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r: unknown
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(r)) continue
    const kind = str(r.kind) ?? 'raw'
    const text = typeof r.text === 'string' ? r.text : kind === 'meta' && typeof r.prompt === 'string' ? r.prompt : null
    out.push({
      seq: seq++,
      t: num(r.t) ?? 0,
      kind,
      text: text === null ? null : clip(text, 6000),
      name: str(r.name),
      summary: kind === 'tool' ? summarizeInput(r.input) : null,
      input: kind === 'tool' && r.input !== undefined ? clip(pretty(r.input), 1500) : null,
      output: r.output === undefined ? null : clip(typeof r.output === 'string' ? r.output : JSON.stringify(r.output) ?? '', 2000),
      isError: r.isError === true,
      toolId: str(r.id),
      toolUseId: str(r.toolUseId),
      redacted: r.redacted === true,
      attempt: num(r.attempt) ?? num(r.n),
    })
  }
  return out
}

const utf8 = new TextEncoder()
export const byteLength = (s: string): number => utf8.encode(s).length

/**
 * One read of a transcript's bytes [offset, size): the whole lines it holds, and the
 * byte offset just past the last of them. A window that starts mid-line (a fresh read
 * of a large file) drops its first, partial line.
 */
export function sliceLines(chunk: string, offset: number, size: number, isAligned: boolean): { body: string; consumed: number } {
  const last = chunk.lastIndexOf('\n')
  if (last < 0) return { body: '', consumed: offset }
  const trailing = chunk.slice(last + 1)
  let body = chunk.slice(0, last + 1)
  if (!isAligned) body = body.slice(body.indexOf('\n') + 1)
  return { body, consumed: size - byteLength(trailing) }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const startOfDay = (t: number): number => new Date(t).setHours(0, 0, 0, 0)

/** `Today`, `Yesterday`, `Wed, Oct 1`, or `Mon, Dec 29, 2025` in another year: local time. */
export function dayLabel(t: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const d = new Date(t)
  const label = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${d.getFullYear()}`
}

/** Runs (newest first) under consecutive day headings. */
export function groupByDay<T extends { createdAt: number }>(runs: T[], now: number): { label: string; runs: T[] }[] {
  const out: { label: string; runs: T[] }[] = []
  for (const r of runs) {
    const label = dayLabel(r.createdAt, now)
    const last = out[out.length - 1]
    if (last && last.label === label) last.runs.push(r)
    else out.push({ label, runs: [r] })
  }
  return out
}

/** `14:05`, local time. */
export function fmtTime(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtClock(t: number): string {
  const d = new Date(t)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

/** How a message reaches a running agent of this adapter. */
export const steerHint = (adapter: string | null): string =>
  adapter === 'claude' || adapter === 'amp' || adapter === 'mock'
    ? 'Delivered live, into the turn it is running.'
    : 'Queued: it runs as an extra turn after the current one, and the reply to that turn becomes this agent’s result.'

// ---- timeline and phases ---------------------------------------------------------

const ENDED = new Set(['done', 'cached', 'failed', 'cancelled'])
const MAX_ENTRIES = 300

const toSeg = (raw: unknown): PathSeg => {
  const o = obj(raw)
  return { kind: str(o.kind) ?? '?', ordinal: num(o.ordinal), count: num(o.count), stages: num(o.stages), i: num(o.i), s: num(o.s) }
}
const RUN_ENDED = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export const emptyTimeline = (runId: string): Timeline => ({
  runId,
  consumed: 0,
  total: 0,
  startedAt: null,
  endedAt: null,
  declaredPhases: [],
  phases: [],
  lanes: [],
  workflowFile: null,
  entries: [],
  isEntriesCut: false,
  currentPhase: null,
})

/** `events.jsonl` text (whole lines) folded into a fresh timeline. */
export const parseTimeline = (text: string, runId: string, consumed: number): Timeline => ({ ...foldTimeline(emptyTimeline(runId), text), consumed })

/**
 * More of a run's `events.jsonl` (whole lines) folded into what `prev` already holds, so
 * the file can be read in pieces: from its start, a bounded chunk at a time, and later
 * only what it grew by. Progress lines are skipped. A lane's times are only ever its own
 * events' times; a resumed lane starts over at its new `queued`. `consumed` is the
 * caller's to advance.
 */
export function foldTimeline(prev: Timeline, text: string): Timeline {
  const out: Timeline = { ...prev, declaredPhases: [...prev.declaredPhases], phases: [...prev.phases], entries: [...prev.entries], lanes: [] }
  const lanes = new Map<string, Lane>(prev.lanes.map((l) => [l.id, { ...l }]))
  const entry = (t: number, kind: LogEntry['kind'], text: string, agent: number | null = null, tone: LogEntry['tone'] = null) =>
    out.entries.push({ t, kind, text: clip(text, 2000), agent, tone })
  const agentName = (i: number | null) => (i === null ? 'an agent' : (lanes.get(`a:${i}`)?.label ?? `agent ${i}`))
  for (const line of text.split('\n')) {
    if (!line.trim() || line.includes('"state":"progress"')) continue
    let r: unknown
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(r)) continue
    const t = num(r.t)
    if (t === null) continue
    const state = str(r.state) ?? ''
    if (r.type === 'run') {
      if (out.startedAt === null) out.startedAt = t
      if (Array.isArray(r.phases)) out.declaredPhases = r.phases.map((p) => str(obj(p).title) ?? '').filter(Boolean)
      out.workflowFile = str(r.workflowFile) ?? out.workflowFile
      if (RUN_ENDED.has(state)) out.endedAt = t
      else if (state === 'started' || state === 'resumed') out.endedAt = null
      if (state) entry(t, 'run', `run ${state}${str(r.error) ? `: ${str(r.error)}` : ''}`, null, RUN_ENDED.has(state) ? stateColor(state) : 'suggestion')
    } else if (r.type === 'phase') {
      const index = num(r.phaseIndex) ?? out.phases.length
      const title = str(r.title) ?? `phase ${index + 1}`
      if (!out.phases.some((p) => p.index === index)) out.phases.push({ index, title, t })
      out.currentPhase = { index, title }
      entry(t, 'phase', `phase ${index + 1}: ${title}`)
    } else if (r.type === 'log') {
      entry(t, 'log', str(r.message) ?? '', null, str(r.level) === 'warn' ? 'warning' : str(r.level) === 'error' ? 'error' : null)
    } else if (r.type === 'mail') {
      const agent = num(r.agent)
      const inbound = r.dir === 'in'
      entry(t, inbound ? 'mail-in' : 'mail-out', inbound ? `→ ${agentName(agent)}: ${str(r.message) ?? ''}${str(r.delivery) ? ` (${str(r.delivery)})` : ''}` : `${agentName(agent)}: ${str(r.message) ?? ''}`, agent, inbound ? 'suggestion' : 'success')
    } else if (r.type === 'question') {
      entry(t, 'question', `${str(r.qid) ?? '?'}: ${str(r.question) ?? ''}`, null, 'warning')
    } else if (r.type === 'answer') {
      entry(t, 'answer', `${str(r.qid) ?? '?'} answered: ${str(r.value) ?? ''}`)
    } else if (r.type === 'agent' || r.type === 'step') {
      const kind = r.type
      const index = num(r.index)
      const id = kind === 'agent' ? `a:${index ?? '?'}` : `s:${str(r.key) ?? str(r.name) ?? '?'}`
      const lane: Lane = lanes.get(id) ?? {
        id,
        kind,
        index: kind === 'agent' ? index : null,
        label: str(kind === 'agent' ? r.label : r.name) ?? (kind === 'agent' ? `agent ${index ?? '?'}` : 'step'),
        adapter: str(r.adapter),
        state: 'queued',
        phaseIndex: null,
        queuedAt: null,
        startedAt: null,
        endedAt: null,
        lastSeenAt: t,
        path: Array.isArray(r.path) ? r.path.map(toSeg) : [],
        cost: 0,
        outputTokens: 0,
        lastPaidAt: null,
      }
      lanes.set(id, lane)
      lane.lastSeenAt = Math.max(lane.lastSeenAt, t)
      if (num(r.phaseIndex) !== null) lane.phaseIndex = num(r.phaseIndex)
      if (state === 'queued') Object.assign(lane, { state, queuedAt: t, startedAt: null, endedAt: null })
      else if (state === 'running') Object.assign(lane, { state, startedAt: t, endedAt: null })
      else if (state === 'cached') {
        // A resume replaying a finished result: its bar stays where the work ran. One
        // with no earlier span here (seeded from another run) is a mark at the replay.
        if (lane.endedAt === null || lane.startedAt === null) Object.assign(lane, { queuedAt: null, startedAt: t, endedAt: t })
        lane.state = state
      } else if (ENDED.has(state)) Object.assign(lane, { state, endedAt: t })
      // Every attempt ends in one done/failed/cancelled event carrying that attempt's own
      // usage (status --json folds only the last), so the sum is the agent's lifetime spend.
      if (state === 'done' || state === 'failed' || state === 'cancelled') {
        const usage = obj(r.usage)
        lane.cost += num(usage.cost) ?? 0
        lane.outputTokens += num(usage.output) ?? 0
        lane.lastPaidAt = t
      }
      if (kind === 'agent' && (state === 'running' || ENDED.has(state))) {
        const took = num(r.durationMs)
        const error = str(r.error)
        const text = state === 'running' ? `${lane.label} started` : `${lane.label} ${state}${took !== null ? ` in ${fmtDuration(took)}` : ''}${error ? `: ${error}` : ''}`
        entry(t, 'agent', text, index, state === 'running' ? 'inactive' : stateColor(state))
      }
    }
  }
  if (out.entries.length > MAX_ENTRIES) {
    out.entries = out.entries.slice(-MAX_ENTRIES)
    out.isEntriesCut = true
  }
  out.lanes = [...lanes.values()].sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'agent' ? -1 : 1) : a.kind === 'agent' ? (a.index ?? 0) - (b.index ?? 0) : (a.startedAt ?? 0) - (b.startedAt ?? 0),
  )
  return out
}

/** Where a lane's bar runs, in ms: an open bar reaches `now` only while the run is live. */
export function laneSpan(lane: Lane, now: number, isRunLive: boolean): { waitFrom: number | null; from: number | null; to: number | null } {
  const open = isRunLive ? now : lane.lastSeenAt
  const from = lane.startedAt
  const to = lane.endedAt ?? (from !== null ? open : null)
  const waitFrom = lane.queuedAt
  return { waitFrom, from, to: to !== null && from !== null ? Math.max(to, from) : to }
}

/** The chart's window: the run's start (or first lane) to its end (or now, while live). */
export function timelineWindow(tl: Timeline, now: number, isRunLive: boolean): { start: number; end: number } {
  const times = tl.lanes.flatMap((l) => [l.queuedAt, l.startedAt, l.endedAt, l.lastSeenAt]).filter((x): x is number => x !== null)
  const start = Math.min(tl.startedAt ?? Infinity, ...times)
  const end = isRunLive ? now : Math.max(tl.endedAt ?? 0, ...times)
  return Number.isFinite(start) && end > start ? { start, end } : { start: Number.isFinite(start) ? start : now, end: (Number.isFinite(start) ? start : now) + 1000 }
}

/** A lane's bar for the desktop: hatched queue wait, then the run in its state's colour. */
export function laneSvg(lane: Lane, start: number, end: number, now: number, isRunLive: boolean): string {
  const vw = 1000
  const h = 12
  const x = (t: number) => Math.max(0, Math.min(vw, ((t - start) / (end - start)) * vw))
  const span = laneSpan(lane, now, isRunLive)
  const hex = HEX[stateColor(lane.state)]
  const parts: string[] = []
  // A segment at least `min` wide, kept inside the chart: one at the run's last instant
  // (a closing step) would otherwise be drawn past the right edge.
  const seg = (from: number, to: number, min: number) => {
    const w = Math.max(min, x(to) - x(from))
    return { a: Math.min(x(from), vw - w), w }
  }
  if (span.waitFrom !== null && span.from !== null && span.from > span.waitFrom) {
    const { a, w } = seg(span.waitFrom, span.from, 0.5)
    parts.push(`<rect x="${a.toFixed(1)}" y="2" width="${w.toFixed(1)}" height="${h - 4}" fill="url(#hatch)"/>`)
  }
  if (span.from !== null && span.to !== null) {
    const { a, w } = seg(span.from, span.to, 3)
    parts.push(`<rect x="${a.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${h}" fill="${hex}"/>`)
  } else if (span.waitFrom !== null) {
    // Still queued: the wait so far, to now while the run lives.
    const { a, w } = seg(span.waitFrom, isRunLive ? now : lane.lastSeenAt, 0.5)
    parts.push(`<rect x="${a.toFixed(1)}" y="2" width="${w.toFixed(1)}" height="${h - 4}" fill="url(#hatch)"/>`)
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${h}" viewBox="0 0 ${vw} ${h}" preserveAspectRatio="none">` +
    `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${HEX.inactive}" fill-opacity="0.15"/><rect width="2" height="6" fill="${HEX.inactive}" fill-opacity="0.6"/></pattern></defs>` +
    `<rect width="${vw}" height="${h}" fill="${HEX.inactive}" fill-opacity="0.08"/>${parts.join('')}</svg>`
  )
}

/** A lane's bar for the terminal, `width` cells: spaces, `░` queue wait, `█` the run. */
export function laneText(lane: Lane, start: number, end: number, width: number, now: number, isRunLive: boolean): { lead: string; wait: string; run: string } {
  const cell = (t: number) => Math.max(0, Math.min(width, Math.round(((t - start) / (end - start)) * width)))
  const span = laneSpan(lane, now, isRunLive)
  const waitFrom = span.waitFrom !== null ? cell(span.waitFrom) : null
  const from = span.from !== null ? cell(span.from) : null
  const to = span.to !== null ? cell(span.to) : null
  const leadEnd = waitFrom ?? from ?? 0
  const waitEnd = from ?? (waitFrom !== null ? cell(isRunLive ? now : lane.lastSeenAt) : leadEnd)
  const run = from !== null && to !== null ? Math.max(1, to - from) : 0
  const wait = Math.max(0, waitEnd - leadEnd)
  // Kept to `width` cells: a bar at the run's last instant gives up lead, not the bar.
  const lead = Math.max(0, Math.min(leadEnd, width - wait - run))
  return { lead: ' '.repeat(lead), wait: '░'.repeat(wait), run: '█'.repeat(run) }
}

export type PhaseGroup = {
  index: number | null
  title: string
  isDeclared: boolean
  isReached: boolean
  state: 'pending' | 'running' | 'done' | 'failed' | 'interrupted'
  workers: Worker[]
  startedAt: number | null
  endedAt: number | null
  cost: number | null
}

/**
 * Declared phases in order, then any observed beyond them, each with its workers
 * (joined on `phaseIndex`), then a group for the workers outside every phase.
 */
export function phaseGroups(tl: Timeline | null, workers: Worker[], observed: string[]): PhaseGroup[] {
  const titles = new Map<number, { title: string; isDeclared: boolean; isReached: boolean }>()
  ;(tl?.declaredPhases ?? []).forEach((title, i) => titles.set(i, { title, isDeclared: true, isReached: false }))
  const seen = tl?.phases.length ? tl.phases : observed.map((title, index) => ({ index, title, t: 0 }))
  for (const p of seen) titles.set(p.index, { title: p.title, isDeclared: titles.get(p.index)?.isDeclared ?? false, isReached: true })
  const lanes = new Map((tl?.lanes ?? []).map((l) => [l.id, l]))
  const group = (index: number | null, title: string, isDeclared: boolean, isReached: boolean, ws: Worker[]): PhaseGroup => {
    const spans = ws.map((w) => lanes.get(w.id)).filter((l): l is Lane => l !== undefined)
    const starts = spans.map((l) => l.startedAt ?? l.queuedAt).filter((x): x is number => x !== null)
    const ends = spans.map((l) => l.endedAt)
    const costs = ws.map((w) => w.cost).filter((c): c is number => c !== null)
    const state: PhaseGroup['state'] = ws.some((w) => w.state === 'failed' || w.state === 'cancelled')
      ? 'failed'
      : ws.some((w) => w.state === 'interrupted')
        ? 'interrupted'
        : ws.some((w) => isActive(w.state))
          ? 'running'
          : ws.length || isReached
            ? 'done'
            : 'pending'
    return {
      index,
      title,
      isDeclared,
      isReached: isReached || ws.length > 0,
      state,
      workers: ws,
      startedAt: starts.length ? Math.min(...starts) : null,
      endedAt: ends.length && ends.every((x) => x !== null) ? Math.max(...(ends as number[])) : null,
      cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    }
  }
  const out = [...titles.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, p]) => group(index, p.title, p.isDeclared, p.isReached, workers.filter((w) => w.phaseIndex === index)))
  const loose = workers.filter((w) => w.phaseIndex === null || !titles.has(w.phaseIndex))
  if (loose.length) out.push(group(null, out.length ? 'Outside any phase' : 'All work', false, true, loose))
  return out
}

// ---- structure: the run's fan-outs, from each lane's path -----------------------

export type StructureNode =
  | { type: 'lane'; lane: Lane; stage: number | null }
  | { type: 'fanout'; key: string; kind: string; ordinal: number; count: number | null; stages: number | null; items: { i: number; children: StructureNode[] }[] }

const firstAt = (n: StructureNode): number =>
  n.type === 'lane'
    ? (n.lane.queuedAt ?? n.lane.startedAt ?? n.lane.lastSeenAt)
    : Math.min(...n.items.flatMap((it) => it.children.map(firstAt)), Infinity)

/**
 * The tree the lanes' paths describe: top-level lanes and fan-outs in the order they
 * began; a fan-out's items in index order, each holding its lanes (by pipeline stage)
 * and any fan-outs nested inside it.
 */
export function buildStructure(lanes: Lane[]): StructureNode[] {
  const root: StructureNode[] = []
  for (const lane of lanes) {
    let list = root
    let stage: number | null = null
    let prefix = ''
    for (let k = 0; k < lane.path.length; k++) {
      const seg = lane.path[k]!
      if (seg.kind === 'parallel' || seg.kind === 'pipeline') {
        prefix += `/${seg.kind}#${seg.ordinal ?? 0}`
        let fan = list.find((n): n is Extract<StructureNode, { type: 'fanout' }> => n.type === 'fanout' && n.key === prefix)
        if (!fan) {
          fan = { type: 'fanout', key: prefix, kind: seg.kind, ordinal: seg.ordinal ?? 0, count: seg.count, stages: seg.stages, items: [] }
          list.push(fan)
        }
        const next = lane.path[k + 1]
        const i = next?.kind === 'item' ? (next.i ?? 0) : 0
        if (next?.kind === 'item') k++
        prefix += `/item${i}`
        let item = fan.items.find((it) => it.i === i)
        if (!item) {
          item = { i, children: [] }
          fan.items.push(item)
          fan.items.sort((a, b) => a.i - b.i)
        }
        list = item.children
      } else if (seg.kind === 'stage') {
        // Each stage runs in a context of its own (fan-out ordinals restart at 0), so
        // a fan-out nested in stage 1 is not the same container as one in stage 0.
        stage = seg.s
        prefix += `/stage${seg.s ?? 0}`
      }
    }
    list.push({ type: 'lane', lane, stage })
  }
  const order = (nodes: StructureNode[]) => {
    nodes.sort((a, b) =>
      a.type === 'lane' && b.type === 'lane' && a.stage !== null && b.stage !== null ? a.stage - b.stage : firstAt(a) - firstAt(b),
    )
    for (const n of nodes) if (n.type === 'fanout') for (const it of n.items) order(it.children)
  }
  order(root)
  return root
}

// ---- the run list: filters, search, repeated runs folded --------------------------

export type ListFilter = 'all' | 'live' | 'attention' | 'completed'

/** Run states a person should look at (`corrupt-result`: a malformed result.json). */
const NEEDS_ATTENTION = new Set(['failed', 'interrupted', 'stale', 'corrupt', 'corrupt-result', 'cancelled'])

/** Runs the filter and the search keep: by state, and by run id or workflow name. */
export function filterRuns(runs: Run[], filter: ListFilter, query: string, details: Record<string, Detail>): Run[] {
  const q = query.trim().toLowerCase()
  return runs.filter((r) => {
    // A question only waits on a live run: an ended run's unanswered one is abandoned.
    const asks = isLive(r.state) && (details[r.runId]?.questions.length ?? 0) > 0
    const keep =
      filter === 'all' ||
      (filter === 'live' && isLive(r.state)) ||
      (filter === 'completed' && r.state === 'completed') ||
      (filter === 'attention' && (asks || NEEDS_ATTENTION.has(r.state)))
    return keep && (!q || r.runId.toLowerCase().includes(q) || r.file.toLowerCase().includes(q))
  })
}

/** Back-to-back runs of one workflow folded together (two or more), else one run each. */
export function foldRepeats(runs: Run[]): ({ type: 'run'; run: Run } | { type: 'group'; key: string; runs: Run[] })[] {
  const out: ({ type: 'run'; run: Run } | { type: 'group'; key: string; runs: Run[] })[] = []
  let i = 0
  while (i < runs.length) {
    let j = i + 1
    while (j < runs.length && runs[j]!.file === runs[i]!.file) j++
    const span = runs.slice(i, j)
    out.push(span.length > 1 ? { type: 'group', key: `${span[0]!.file}:${span[0]!.runId}`, runs: span } : { type: 'run', run: span[0]! })
    i = j
  }
  return out
}

/** `4 completed · 1 failed`: a folded group's states, most common first. */
export function stateTally(runs: Run[]): string {
  const counts = new Map<string, number>()
  for (const r of runs) counts.set(r.state, (counts.get(r.state) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([state, n]) => `${n} ${state}`)
    .join(' · ')
}

/** The newest workflow files under ~/.flowition/workflows/<project>/, for the new-run form. */
export const WORKFLOW_FILE = /\.(workflow\.)?(mjs|js)$/

// ---- reading events.jsonl in bounded chunks ---------------------------------------

/** Runs a command by argv: `$.process.run` in the pane, a fake over bytes in tests. */
export type RunCommand = (argv: string[]) => Promise<{ exitCode: number; stdout: string; isStdoutTruncated: boolean }>

const READ = 'tail -c +"$1" "$2" | head -c "$3"'
// The byte length of the line starting at $1, newline included (LC_ALL=C: bytes, not
// characters); one more than what is left when the line has no newline yet.
const LINE_BYTES = "tail -c +\"$1\" \"$2\" | LC_ALL=C awk 'NR==1{print length($0)+1; exit}'"

/**
 * Folds what `events.jsonl` holds past `tl.consumed` into `tl`, at most `maxChunks` reads
 * of `chunk` bytes, so no read meets $.process.run's 4 MiB cap. Every read starts on a
 * line boundary and folds through its last newline, so the decoded text it measures is
 * whole UTF-8 and `consumed` stays an exact byte offset. A line longer than a chunk has
 * its byte length measured raw (awk, under LC_ALL=C), then is read whole when it is at
 * most `maxLine` bytes, or stepped over with a note in the log when it is longer.
 */
export async function catchUpTimeline(tl: Timeline, size: number, file: string, run: RunCommand, chunk = 2 << 20, maxChunks = 8, maxLine = 3.5 * (1 << 20)): Promise<Timeline> {
  let out = tl
  for (let k = 0; k < maxChunks && out.consumed < size; k++) {
    const len = Math.min(chunk, size - out.consumed)
    const ran = await run(['/bin/sh', '-c', READ, 'sh', String(out.consumed + 1), file, String(len)])
    if (ran.exitCode !== 0 || ran.isStdoutTruncated) break
    const last = ran.stdout.lastIndexOf('\n')
    if (last >= 0) {
      const body = ran.stdout.slice(0, last + 1)
      out = { ...foldTimeline(out, body), consumed: out.consumed + byteLength(body) }
      continue
    }
    if (len < chunk) break // the last line is still being written
    const measured = await run(['/bin/sh', '-c', LINE_BYTES, 'sh', String(out.consumed + 1), file])
    const n = Number(measured.stdout.trim())
    if (measured.exitCode !== 0 || !Number.isSafeInteger(n) || n <= 0 || out.consumed + n > size) break
    if (n <= maxLine) {
      const whole = await run(['/bin/sh', '-c', READ, 'sh', String(out.consumed + 1), file, String(n)])
      if (whole.exitCode !== 0 || whole.isStdoutTruncated || !whole.stdout.endsWith('\n')) break
      out = { ...foldTimeline(out, whole.stdout), consumed: out.consumed + n }
    } else {
      const t = out.entries[out.entries.length - 1]?.t ?? out.startedAt ?? 0
      const note: LogEntry = { t, kind: 'log', text: `(an event of ${fmtTokens(n)} bytes was too large for the pane to read)`, agent: null, tone: 'warning' }
      out = { ...out, entries: [...out.entries, note].slice(-MAX_ENTRIES), consumed: out.consumed + n }
    }
  }
  return { ...out, total: size }
}

// ---- reconciling cached details with the run list ---------------------------------

/**
 * Runs whose cached detail disagrees with the run list: something happened to them
 * between polls (a resume elsewhere, a crash) that the pane did not see, so they are
 * polled again rather than shown from the stale cache.
 */
export const staleDetailIds = (list: Run[], details: Record<string, Detail>): string[] =>
  list.filter((r) => details[r.runId] !== undefined && details[r.runId]!.state !== r.state).map((r) => r.runId)

/** The states that end a paid attempt: each one's event carries that attempt's usage. */
const PAID = new Set(['done', 'failed', 'cancelled'])

/**
 * Workers with their spend over every attempt. The timeline's lanes hold every paid
 * attempt it has read; to that is added what status reports and the timeline has not
 * read yet (its reads lag or fail):
 * - a live attempt's tokens, while the run is live and status has output from it: after
 *   the open attempt the lane read started, or after anything the lane read at all
 *   (a resumed attempt it has not seen start). status --json keeps an earlier attempt's
 *   count until new progress arrives, which is why its output time decides.
 * - a paid attempt's final usage when its terminal event is not the last one the lane
 *   read (`lastPaidAt`, the identity of a terminal event: timestamps are milliseconds,
 *   so a terminal can share its running event's). A `cached` replay is no attempt:
 *   status keeps the replayed result's usage on it, which was counted when it was paid.
 */
export function lifetimeWorkers(workers: Worker[], lanes: Lane[], isRunLive: boolean): Worker[] {
  const byId = new Map(lanes.map((l) => [l.id, l]))
  return workers.map((w) => {
    const lane = byId.get(w.id)
    if (!lane || typeof lane.cost !== 'number') return w
    const lastPaidAt = lane.lastPaidAt ?? null
    const isLaneOpen = isActive(lane.state) && lane.endedAt === null && lane.startedAt !== null
    const isCurrent =
      isRunLive &&
      isActive(w.state) &&
      w.lastOutputAt !== null &&
      (isLaneOpen ? w.lastOutputAt >= (lane.startedAt ?? Infinity) : w.lastOutputAt > lane.lastSeenAt)
    const isUnread = PAID.has(w.state) && w.lastAt !== null && (lastPaidAt === null || w.lastAt > lastPaidAt)
    const tokens = lane.outputTokens + (isCurrent || isUnread ? (w.outputTokens ?? 0) : 0)
    const cost = lane.cost + (isUnread ? (w.cost ?? 0) : 0)
    return { ...w, cost: cost || null, outputTokens: tokens || null }
  })
}

/** Work an ended run left running or queued was abandoned: it shows as interrupted. */
export const shownState = (state: string, isRunLive: boolean): string => (!isRunLive && isActive(state) ? 'interrupted' : state)

/**
 * Each tool call's result, paired in transcript order within an attempt: a result goes
 * to the earliest still-open call with its id. A resumed attempt restarts the adapters'
 * synthesized ids (pi's `t1-tool1` recurs), so an attempt boundary (`attempt`, or a new
 * `meta`) closes every open call rather than letting a later result match an earlier
 * attempt's call. Returns results by the call's `seq`, and the results so paired.
 */
export function pairToolResults(events: ThreadEvent[]): { byCall: Map<number, ThreadEvent>; paired: Set<number> } {
  const byCall = new Map<number, ThreadEvent>()
  const paired = new Set<number>()
  let open = new Map<string, number[]>()
  for (const ev of events) {
    if (ev.kind === 'attempt' || ev.kind === 'meta') open = new Map()
    else if (ev.kind === 'tool' && ev.toolId) open.set(ev.toolId, [...(open.get(ev.toolId) ?? []), ev.seq])
    else if (ev.kind === 'tool-result' && ev.toolUseId) {
      const waiting = open.get(ev.toolUseId)
      const call = waiting?.shift()
      if (call !== undefined) {
        byCall.set(call, ev)
        paired.add(ev.seq)
      }
    }
  }
  return { byCall, paired }
}
