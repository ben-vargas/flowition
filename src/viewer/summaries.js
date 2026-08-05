// Cached, keyset-paginated run listing.
import fs from 'node:fs'
import path from 'node:path'
import { deriveRunState } from '../run-state.js'
import { runDir } from '../util.js'
import { viewerRunsDir } from './auth.js'
import { readCompleteJsonl, readFirstJournalMeta } from './journal-view.js'
import { MAX_JSONL_LINE_BYTES } from './pages.js'

const LIVE_TTL_MS = 2000
const ARTIFACT_TTL_MS = 6000
const QUIESCENT_TTL_MS = 30_000
const QUIESCENT_TTL_SPREAD = 0.25
const SETTLED = new Set(['completed', 'failed', 'interrupted'])
const QUIESCENT = new Set(['stale', 'unknown', 'corrupt-result'])
const RUN_STATES = new Set(['running', 'starting', 'completed', 'failed', 'interrupted', 'corrupt-result', 'stale', 'unknown'])
const CANONICAL_INT = /^(0|[1-9][0-9]*)$/

const statOrNull = (file, fsImpl = fs) => {
  try { return fsImpl.statSync(file) } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}
const sig = (s) => s ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}` : '-'
const identity = (s) => s ? `${s.dev}:${s.ino}` : null

// Quiescent runs are usually all classified during the same cold request, so a single
// fixed TTL makes every one of them expire on the same later request — 500 stale runs
// re-derive at once and that request alone blows the P2 budget while its neighbours
// coast. Spreading each run's TTL deterministically over ±25% of the 30 s base keeps
// the population's amortized probe rate at ~1/30 s per run (DESIGN §5.4.2/§10 P2)
// while making a synchronized expiry herd structurally impossible. The spread is a
// pure function of the run directory (FNV-1a), not Math.random(): the same run keeps
// the same deadline across requests and across restarts, and tests can compute it.
export function quiescentTtlMs(dir) {
  let h = 0x811c9dc5
  for (let i = 0; i < dir.length; i++) {
    h ^= dir.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const unit = (h >>> 0) / 0x1_0000_0000 // [0, 1)
  return Math.round(QUIESCENT_TTL_MS * (1 + QUIESCENT_TTL_SPREAD * (2 * unit - 1)))
}

export function encodeRunsCursor({ createdAt, runId }) {
  return Buffer.from(JSON.stringify({ createdAt, runId })).toString('base64url')
}

export function decodeRunsCursor(value) {
  if (value == null || value === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.runId !== 'string') throw new Error()
    if (parsed.createdAt !== null && !Number.isFinite(parsed.createdAt)) throw new Error()
    return { createdAt: parsed.createdAt, runId: parsed.runId }
  } catch {
    const err = new RangeError('cursor is not a valid runs cursor')
    err.code = 'bad_request'
    throw err
  }
}

export function parseRunsLimit(value) {
  if (value == null || value === '') return 50
  const text = String(value)
  if (!CANONICAL_INT.test(text)) throw new RangeError('limit must be a canonical non-negative integer')
  const n = Number(text)
  if (!Number.isSafeInteger(n) || n < 1 || n > 200) throw new RangeError('limit must be between 1 and 200')
  return n
}

function legalRunDirs(root, fsImpl = fs) {
  let entries
  try { entries = fsImpl.readdirSync(root, { withFileTypes: true }) } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try { runDir(entry.name) } catch { continue }
    out.push({ runId: entry.name, dir: path.join(root, entry.name) })
  }
  return out
}

function agentCounts(agents) {
  const out = { total: agents.size, done: 0, failed: 0, running: 0, cached: 0 }
  for (const a of agents.values()) {
    if (a.state === 'done') out.done++
    else if (a.state === 'failed' || a.state === 'cancelled') out.failed++
    else if (a.state === 'running' || a.state === 'queued') out.running++
    if (a.state === 'cached' || a.cached) out.cached++
  }
  return out
}

function emptySummaryFold() {
  return {
    run: null,
    agents: new Map(),
    questions: new Map(),
    journalAnswers: new Set(),
    spend: { input: 0, output: 0, cost: 0 },
    hasSpend: false,
    resumeCount: 0,
    events: { identity: null, offset: 0, size: 0, mtimeMs: null },
    journal: { identity: null, offset: 0, size: 0, mtimeMs: null },
  }
}

function resetEvents(folded) {
  folded.run = null
  folded.agents.clear()
  folded.questions.clear()
  folded.resumeCount = 0
  folded.events = { identity: null, offset: 0, size: 0, mtimeMs: null }
}

function resetJournal(folded) {
  folded.journalAnswers.clear()
  folded.spend = { input: 0, output: 0, cost: 0 }
  folded.hasSpend = false
  folded.journal = { identity: null, offset: 0, size: 0, mtimeMs: null }
}

function foldSummaryEvent(folded, ev) {
  if (ev?.type === 'run') {
    const prior = folded.run
    const run = { ...(prior ?? {}), ...ev }
    if (prior?.startedAt != null) run.startedAt = prior.startedAt
    else if (ev.state === 'started') run.startedAt = Number.isFinite(ev.t) ? ev.t : null
    if (ev.state === 'started' || ev.state === 'resumed') {
      run.endedAt = null
      if (ev.state === 'resumed') folded.resumeCount++
    } else if (ev.state === 'completed' || ev.state === 'failed' || ev.state === 'interrupted') {
      run.endedAt = Number.isFinite(ev.t) ? ev.t : null
    }
    folded.run = run
    return
  }
  if (ev?.type === 'agent' && Number.isInteger(ev.index) && ev.index >= 0) {
    if (ev.state === 'steered' || ev.state === 'progress') return
    const prior = folded.agents.get(ev.index) ?? { state: 'queued', adapter: 'unknown', cached: false }
    folded.agents.set(ev.index, {
      state: typeof ev.state === 'string' ? ev.state : prior.state,
      adapter: ev.adapter ?? prior.adapter,
      cached: ev.state === 'cached' || (ev.state == null && prior.cached),
    })
    return
  }
  if (ev?.type === 'question' && ev.qid != null) {
    const qid = String(ev.qid)
    if (!folded.questions.has(qid)) folded.questions.set(qid, false)
  } else if (ev?.type === 'answer' && ev.qid != null) {
    folded.questions.set(String(ev.qid), true)
  }
}

function foldSummaryJournal(folded, rec) {
  if (rec?.type === 'answer' && rec.qid != null) {
    folded.journalAnswers.add(String(rec.qid))
    return
  }
  if (rec?.type !== 'result' || !rec.usage || typeof rec.usage !== 'object') return
  folded.spend.input += Number(rec.usage.input) || 0
  folded.spend.output += Number(rec.usage.output) || 0
  folded.spend.cost += Number(rec.usage.cost) || 0
  folded.hasSpend = true
}

function channelReset(channel, stat) {
  const id = identity(stat)
  return channel.identity != null && (
    channel.identity !== id
    || stat.size < channel.offset
    || (stat.size === channel.size && channel.mtimeMs !== stat.mtimeMs && stat.size > 0)
  )
}

function updateSummaryFold(folded, eventsFile, journalFile, eventsStat, journalStat) {
  if (!eventsStat) resetEvents(folded)
  else {
    if (channelReset(folded.events, eventsStat)) resetEvents(folded)
    if (eventsStat.size > folded.events.offset) {
      const delta = readCompleteJsonl(eventsFile, folded.events.offset, { maxLineBytes: MAX_JSONL_LINE_BYTES })
      for (const { rec } of delta.records) foldSummaryEvent(folded, rec)
      folded.events.offset = delta.offset
    }
    folded.events = {
      identity: identity(eventsStat),
      offset: folded.events.offset,
      size: eventsStat.size,
      mtimeMs: eventsStat.mtimeMs,
    }
  }

  if (!journalStat) resetJournal(folded)
  else {
    if (channelReset(folded.journal, journalStat)) resetJournal(folded)
    if (journalStat.size > folded.journal.offset) {
      const delta = readCompleteJsonl(journalFile, folded.journal.offset)
      for (const { rec } of delta.records) foldSummaryJournal(folded, rec)
      folded.journal.offset = delta.offset
    }
    folded.journal = {
      identity: identity(journalStat),
      offset: folded.journal.offset,
      size: journalStat.size,
      mtimeMs: journalStat.mtimeMs,
    }
  }
  return folded
}

function fallbackName(file) {
  if (!file) return null
  const base = path.basename(file)
  const ext = path.extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

function compareRows(a, b) {
  const at = a.createdAt ?? 0
  const bt = b.createdAt ?? 0
  return bt - at || a.runId.localeCompare(b.runId)
}

function afterCursor(row, cursor) {
  const rowAt = row.createdAt ?? 0
  const cursorAt = cursor.createdAt ?? 0
  return rowAt < cursorAt || (rowAt === cursorAt && row.runId.localeCompare(cursor.runId) > 0)
}

export class SummaryStore {
  constructor({
    root = null,
    deriveState = deriveRunState,
    now = () => Date.now(),
    fsImpl = fs,
  } = {}) {
    this.root = root
    this.deriveState = deriveState
    this.now = now
    this.fs = fsImpl
    this.cache = new Map()
  }

  clear() {
    this.cache.clear()
  }

  async #state(entry, dir, eventSignature, signalPresent) {
    const now = this.now()
    const cached = entry.state
    let valid = cached && cached.eventSignature === eventSignature && !signalPresent
    if (valid && SETTLED.has(cached.value.state)) return cached.value
    if (valid && QUIESCENT.has(cached.value.state)) valid = now - cached.checkedAt < (entry.quiescentTtl ??= quiescentTtlMs(dir))
    else if (valid) valid = now - cached.checkedAt < LIVE_TTL_MS
    if (valid) return cached.value
    const value = await this.deriveState(dir)
    entry.state = { value, checkedAt: now, eventSignature }
    return value
  }

  #createdAt(entry, dir, journalStat, meta) {
    const dirStat = journalStat ? null : statOrNull(dir, this.fs)
    const key = journalStat
      ? `${path.join(dir, 'journal.jsonl')}:${identity(journalStat)}`
      : `${dir}:${identity(dirStat)}`
    if (entry.created?.key === key) return entry.created.value
    const value = Number.isFinite(meta?.createdAt)
      ? meta.createdAt
      : journalStat?.birthtimeMs || dirStat?.birthtimeMs || 0
    entry.created = { key, value }
    return value
  }

  async #one(runId, dir) {
    let entry = this.cache.get(dir)
    if (!entry) this.cache.set(dir, (entry = {}))
    entry.files ??= {
      events: path.join(dir, 'events.jsonl'),
      journal: path.join(dir, 'journal.jsonl'),
      marker: path.join(dir, '.resuming'),
      lock: path.join(dir, 'run.lock'),
      log: path.join(dir, 'run.log'),
    }
    const files = entry.files

    // Marker and lock checks are NEVER amortized: either is the engine's earliest legal
    // resume signal and must invalidate a settled verdict on this request. Events/journal
    // metadata can be: a legal writer holds the lock before its first journal read, so in
    // the signal-free interval those files cannot change through Flowition. A short TTL
    // still notices out-of-band edits without making every warm 5,000-run request pay an
    // additional 10,000 stats (P2).
    const marker = this.fs.existsSync(files.marker)
    const lock = this.fs.existsSync(files.lock)
    const signalPresent = marker || lock
    const cachedState = entry.state?.value?.state
    // A missing meta-cache entry also means the first journal line may have been torn;
    // keep statting that journal so completion is noticed on the very next pass.
    const mayAmortize = entry.meta != null
      && (SETTLED.has(cachedState) || QUIESCENT.has(cachedState))
    const now = this.now()
    let eventsStat
    let journalStat
    if (
      !signalPresent
      && mayAmortize
      && entry.artifacts
      && now - entry.artifacts.checkedAt < ARTIFACT_TTL_MS
    ) {
      eventsStat = entry.artifacts.events
      journalStat = entry.artifacts.journal
    } else {
      eventsStat = statOrNull(files.events, this.fs)
      journalStat = statOrNull(files.journal, this.fs)
      entry.artifacts = { events: eventsStat, journal: journalStat, checkedAt: now }
    }
    const eventSignature = sig(eventsStat)
    const stateInfo = await this.#state(entry, dir, eventSignature, signalPresent)
    const artifactSignature = `${eventSignature}:${sig(journalStat)}:${marker ? 1 : 0}:${lock ? 1 : 0}`

    // A warm list still pays the two immediate resume-signal checks above (plus artifact
    // stats when their TTL expires), but unchanged artifacts and the same cached liveness
    // verdict cannot change any field in the materialized row. Reusing it avoids rebuilding
    // 5,000 aggregate objects and adapter arrays on every steady-state request (DESIGN P2).
    if (
      entry.row?.artifactSignature === artifactSignature
      && entry.row.stateInfo === stateInfo
    ) return entry.row.value

    const journalIdentity = identity(journalStat)
    if (!entry.meta || entry.meta.identity !== journalIdentity) {
      const first = readFirstJournalMeta(files.journal)
      if (first.cacheable) entry.meta = { identity: journalIdentity, value: first.meta }
      else entry.meta = null
    }
    const meta = entry.meta?.value ?? null
    const createdAt = this.#createdAt(entry, dir, journalStat, meta)
    if (!entry.runLog || (!entry.runLog.value && entry.runLog.artifactSignature !== artifactSignature)) {
      entry.runLog = {
        value: this.fs.existsSync(files.log),
        artifactSignature,
      }
    }

    entry.folded ??= emptySummaryFold()
    const folded = updateSummaryFold(
      entry.folded,
      files.events,
      files.journal,
      eventsStat,
      journalStat,
    )
    const run = folded.run
    const workflowFile = meta?.workflowFile ?? run?.workflowFile ?? run?.file ?? null
    const adapters = []
    for (const agent of folded.agents.values()) {
      if (agent.adapter && !adapters.includes(agent.adapter)) adapters.push(agent.adapter)
    }
    const dead = SETTLED.has(stateInfo.state) || stateInfo.state === 'stale'
    let openQuestions = 0
    if (!dead) {
      for (const [qid, answered] of folded.questions) {
        if (!answered && !folded.journalAnswers.has(qid)) openQuestions++
      }
    }
    const value = {
      runId,
      name: run?.name ?? fallbackName(workflowFile),
      workflowFile,
      state: stateInfo.state,
      liveDetail: stateInfo.detail ?? null,
      createdAt,
      startedAt: run?.startedAt ?? null,
      endedAt: run?.endedAt ?? null,
      agents: agentCounts(folded.agents),
      adapters,
      spend: folded.hasSpend ? { ...folded.spend } : null,
      budgetTotal: run?.budgetTotal ?? meta?.budgetTotal ?? null,
      openQuestions,
      resumeCount: folded.resumeCount,
      hasRunLog: entry.runLog.value,
    }
    entry.row = { artifactSignature, stateInfo, value }
    return value
  }

  async list({ limit = 50, cursor = null, state = null, q = null } = {}) {
    limit = typeof limit === 'string' ? parseRunsLimit(limit) : limit
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError('limit must be between 1 and 200')
    cursor = typeof cursor === 'string' ? decodeRunsCursor(cursor) : cursor
    let states = null
    if (state != null && state !== '') {
      states = new Set((Array.isArray(state) ? state : String(state).split(',')).map((s) => String(s).trim()).filter(Boolean))
      if ([...states].some((s) => !RUN_STATES.has(s))) throw new RangeError('state contains an unknown run state')
    }
    const query = q == null ? null : String(q).toLocaleLowerCase()

    const root = this.root ?? viewerRunsDir()
    const dirs = legalRunDirs(root, this.fs)
    const alive = new Set(dirs.map((r) => r.dir))
    for (const dir of this.cache.keys()) {
      if (!alive.has(dir)) {
        this.cache.delete(dir)
      }
    }

    const rows = []
    // Sequential keeps socket probes bounded and deterministic. Warm settled/quiescent
    // rows do no asynchronous work.
    for (const item of dirs) {
      try { rows.push(await this.#one(item.runId, item.dir)) } catch (err) {
        if (err?.code !== 'ENOENT') throw err // vanished mid-pass: omit, next pass prunes
      }
    }
    rows.sort(compareRows)
    const filtered = rows.filter((row) => {
      if (states && !states.has(row.state)) return false
      if (query && !`${row.name ?? ''}\n${row.runId}`.toLocaleLowerCase().includes(query)) return false
      if (cursor && !afterCursor(row, cursor)) return false
      return true
    })
    const page = filtered.slice(0, limit)
    const more = filtered.length > limit
    const last = page[page.length - 1]
    return {
      runs: page,
      nextCursor: more && last ? encodeRunsCursor(last) : null,
      totalOnDisk: dirs.length,
    }
  }
}

const defaultSummaries = new SummaryStore()
export const listRuns = (options) => defaultSummaries.list(options)
export const clearSummaryCache = () => defaultSummaries.clear()
