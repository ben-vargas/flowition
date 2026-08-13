// RunDetail assembly: incremental event fold + incremental lossy journal join +
// deriveRunState. This module deliberately imports the state classifier rather than
// duplicating any heartbeat, marker, lock, or socket-probe rules.
import fs from 'node:fs'
import path from 'node:path'
import { deriveRunState } from '../run-state.js'
import { runDir } from '../util.js'
import {
  createFoldState,
  deriveCaps,
  fold,
  materializeFold,
  semverGte,
  TOOL_IDS_VERSION,
} from './fold.js'
import { JournalView, readCompleteJsonl, resultForAgent } from './journal-view.js'
import { MAX_JSONL_LINE_BYTES } from './pages.js'

export const INLINE_VALUE_BYTES = 1024 * 1024
export const RESULT_PREVIEW_BYTES = 64 * 1024
export const RESULT_EVENT_BYTES = 64 * 1024
export const DETAIL_TAIL_RECORDS = 200
export const SNAPSHOT_CACHE_MAX_ENTRIES = 32
const LIVE_STATE_TTL_MS = 2000
const QUIESCENT_STATE_TTL_MS = 30_000
const SETTLED_STATES = new Set(['completed', 'failed', 'interrupted'])
const QUIESCENT_STATES = new Set(['stale', 'unknown', 'corrupt-result'])
// Every shipped CLI adapter except the deterministic mock normalizes tool calls to
// paired transcript ids (native where available, synthesized where necessary). Keep
// this viewer-local: src/viewer/** may not import the adapter layer (§11.2).
const TOOL_ID_ADAPTERS = new Set(['claude', 'amp', 'codex', 'cursor', 'droid', 'grok', 'opencode', 'pi'])

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const fileIdentity = (s) => s ? `${s.dev}:${s.ino}` : null
const usage = (v) => v && typeof v === 'object'
  ? { input: Number(v.input) || 0, output: Number(v.output) || 0, cost: Number(v.cost) || 0 }
  : null
const addUsage = (into, value) => {
  if (!value) return
  into.input += value.input
  into.output += value.output
  into.cost += value.cost
}

function serialized(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

function previewBytes(text, max = RESULT_PREVIEW_BYTES) {
  const buf = Buffer.from(text)
  return buf.subarray(0, Math.min(max, buf.length)).toString('utf8')
}

function fallbackCreatedAt(dir, journalStat = null) {
  try { return journalStat?.birthtimeMs || fs.statSync(dir).birthtimeMs || null } catch { return null }
}

function fallbackName(file) {
  if (!file) return null
  const base = path.basename(file)
  const ext = path.extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

function eventStat(file) {
  try { return fs.statSync(file) } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

function joinJournal(projected, journal) {
  const byKey = new Map(projected.agents.filter((a) => a.key != null).map((a) => [a.key, a]))
  for (const [key, records] of journal.results) {
    const agent = byKey.get(key)
      ?? projected.agents.find((a) => a.index === journal.indexByKey.get(key))
    if (!agent || records.length === 0) continue
    const lifetime = { input: 0, output: 0, cost: 0 }
    for (const rec of records) addUsage(lifetime, usage(rec.usage))
    const last = records[records.length - 1]
    const attempt = usage(last.usage)
    agent.attempts = records.length
    agent.usage = lifetime
    agent.attemptUsage = attempt
    if (Number.isFinite(last.durationMs)) agent.durationMs = last.durationMs
    if (own(last, 'result')) {
      const text = serialized(last.result)
      agent.resultBytes = Buffer.byteLength(text)
      agent.resultTruncated = agent.resultBytes > RESULT_EVENT_BYTES
      agent.resultPreview = previewBytes(text, 200)
    }
  }
  for (const [key, sessionId] of journal.sessions) {
    const agent = byKey.get(key) ?? projected.agents.find((a) => a.index === journal.indexByKey.get(key))
    if (agent) agent.sessionId = sessionId
  }
  for (const [key, cum] of journal.usageCum) {
    const agent = byKey.get(key) ?? projected.agents.find((a) => a.index === journal.indexByKey.get(key))
    if (agent) agent.liveTokens = { input: Number(cum?.input) || 0, output: Number(cum?.output) || 0 }
  }
  // The zero-reset-aware lifetime-to-date counter (§6.2 `AgentView.cumTokens`). The LAST
  // cum value above is the live counter and is only the current attempt's total whenever
  // the adapter restarts it; this is the chain, and it is what token burn is read from.
  for (const [key, spend] of journal.usageCumSpend) {
    const agent = byKey.get(key) ?? projected.agents.find((a) => a.index === journal.indexByKey.get(key))
    if (agent) agent.cumTokens = { input: spend.input, output: spend.output }
  }

  for (const q of projected.questions) {
    if (!q.answered && journal.answers.has(q.qid)) {
      q.answered = true
      q.answer = journal.answers.get(q.qid)
      q.abandoned = false
    }
  }

  // E8 exact correlation first.
  const allMail = projected.attemptScopes.flatMap((scope) => scope.mail)
  for (const mail of allMail) {
    if (mail.mailId == null) continue
    const rec = journal.mailById.get(mail.mailId)
    if (!rec) continue
    mail.origin = rec.origin ?? 'operator'
    mail.callsite = rec.callsite ?? null
    const done = journal.mailDoneById.get(mail.mailId)
    if (done?.dropped) mail.delivery = 'dropped'
    else if (done?.skipped) mail.delivery = 'skipped'
  }
  for (const agent of projected.agents) {
    for (const steer of agent.steers) {
      if (steer.mailId == null) continue
      const rec = journal.mailById.get(steer.mailId)
      if (rec) steer.origin = rec.origin === 'workflow' ? 'workflow' : 'operator'
    }
  }

  // Legacy two-hop correlation: key -> index through started/result, then
  // (index,text,|dt|<=5s). A key that never acquired an index stays run-scoped.
  const candidates = journal.mail.filter((m) => m.id == null || !allMail.some((e) => e.mailId === m.id))
  for (const rec of candidates) {
    const index = journal.indexByKey.get(rec.key)
    if (!Number.isInteger(index)) continue
    let best = null
    let distance = Infinity
    for (const mail of allMail) {
      if (mail.mailId != null || mail.agent !== index || mail.message !== String(rec.text ?? '')) continue
      const d = Math.abs((mail.at ?? 0) - (rec.t ?? 0))
      if (d <= 5000 && d < distance) { best = mail; distance = d }
    }
    if (best) {
      best.origin = rec.origin ?? 'operator'
      best.callsite = rec.callsite ?? null
      best.approximate = true
    }
  }
}

function summarizeAgents(agents) {
  const counts = { total: agents.length, done: 0, failed: 0, running: 0, cached: 0 }
  for (const a of agents) {
    if (a.state === 'done') counts.done++
    else if (a.state === 'failed' || a.state === 'cancelled') counts.failed++
    else if (a.state === 'running' || a.state === 'queued') counts.running++
    if (a.state === 'cached' || a.cached) counts.cached++
  }
  return counts
}

export class SnapshotStore {
  constructor({
    deriveState = deriveRunState,
    now = () => Date.now(),
    maxEntries = SNAPSHOT_CACHE_MAX_ENTRIES,
  } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer')
    }
    this.deriveState = deriveState
    this.now = now
    this.maxEntries = maxEntries
    this.cache = new Map()
  }

  clear(dir = null) {
    if (dir == null) this.cache.clear()
    else this.cache.delete(dir)
  }

  async get(runIdOrDir, { includeArgs = false, stateInfo = null } = {}) {
    const dir = path.isAbsolute(runIdOrDir) ? runIdOrDir : runDir(runIdOrDir)
    const runId = path.basename(dir)
    let dirStat
    try { dirStat = fs.statSync(dir) } catch (err) {
      if (err?.code === 'ENOENT') {
        this.cache.delete(dir)
        const gone = new Error(`run "${runId}" not found`)
        gone.code = 'ENOENT'
        throw gone
      }
      throw err
    }
    if (!dirStat.isDirectory()) {
      this.cache.delete(dir)
      const gone = new Error(`run "${runId}" not found`)
      gone.code = 'ENOENT'
      throw gone
    }

    let entry = this.cache.get(dir)
    if (!entry || entry.dirIdentity !== fileIdentity(dirStat)) {
      entry = {
        dirIdentity: fileIdentity(dirStat),
        raw: null,
        eventIdentity: null,
        eventSize: 0,
        eventMtimeMs: null,
        metaCreatedAt: null,
        stateCache: null,
        journal: new JournalView(path.join(dir, 'journal.jsonl')),
      }
      this.cache.set(dir, entry)
      while (this.cache.size > this.maxEntries) {
        this.cache.delete(this.cache.keys().next().value)
      }
    } else {
      // Map iteration order is the eviction order. Refresh a hit so the least recently
      // requested run, rather than the oldest inserted run, is discarded.
      this.cache.delete(dir)
      this.cache.set(dir, entry)
    }

    const journal = entry.journal.update()
    const eventsFile = path.join(dir, 'events.jsonl')
    const es = eventStat(eventsFile)
    const eid = fileIdentity(es)
    const metaCreatedAt = Number.isFinite(journal.meta?.createdAt) ? journal.meta.createdAt : null
    const reset = entry.raw && (
      eid !== entry.eventIdentity
      || (es?.size ?? 0) < (entry.raw.lastOffset ?? 0)
      || ((es?.size ?? 0) === entry.eventSize && es?.mtimeMs !== entry.eventMtimeMs)
      || entry.metaCreatedAt !== metaCreatedAt
    )
    if (!entry.raw || reset) {
      entry.raw = createFoldState({ createdAt: metaCreatedAt })
      entry.eventSize = 0
    }
    if (es && es.size > entry.raw.lastOffset) {
      const delta = readCompleteJsonl(eventsFile, entry.raw.lastOffset, { maxLineBytes: MAX_JSONL_LINE_BYTES })
      fold(entry.raw, delta.records)
      // `records` intentionally excludes corrupt and over-cap complete lines, but the
      // byte cursor must still cross them. Otherwise every snapshot and SSE reconnect
      // replays the same skipped line forever.
      entry.raw.lastOffset = Math.max(entry.raw.lastOffset, delta.offset)
      const skipped = delta.corruptLines + delta.oversizeLines
      if (skipped) {
        entry.raw.unknownEvents += skipped
        if (delta.corruptLines) {
          entry.raw.unknownEventTypes['corrupt-line'] =
            (entry.raw.unknownEventTypes['corrupt-line'] ?? 0) + delta.corruptLines
        }
        if (delta.oversizeLines) {
          entry.raw.unknownEventTypes['oversize-line'] =
            (entry.raw.unknownEventTypes['oversize-line'] ?? 0) + delta.oversizeLines
        }
      }
    } else if (!es) {
      entry.raw = createFoldState({ createdAt: metaCreatedAt })
    }
    entry.eventIdentity = eid
    entry.eventSize = es?.size ?? 0
    entry.eventMtimeMs = es?.mtimeMs ?? null
    entry.metaCreatedAt = metaCreatedAt

    let derived = stateInfo
    if (!derived) {
      const eventSignature = `${eid}:${es?.size ?? 0}:${es?.mtimeMs ?? 0}`
      const signal = fs.existsSync(path.join(dir, '.resuming')) || fs.existsSync(path.join(dir, 'run.lock'))
      const cached = entry.stateCache
      const age = cached ? this.now() - cached.checkedAt : Infinity
      const valid = cached && cached.eventSignature === eventSignature && !signal && (
        SETTLED_STATES.has(cached.value.state)
        || (QUIESCENT_STATES.has(cached.value.state) ? age < QUIESCENT_STATE_TTL_MS : age < LIVE_STATE_TTL_MS)
      )
      if (valid) derived = cached.value
      else {
        derived = await this.deriveState(dir)
        entry.stateCache = { value: derived, checkedAt: this.now(), eventSignature }
      }
    }
    const caps = deriveCaps(entry.raw.run)
    const projected = materializeFold(entry.raw, derived.state, caps)
    joinJournal(projected, journal)
    // Journal answers can change the post-pass count without an events record (old runs).
    projected.openQuestions = projected.questions.filter((q) => !q.answered && !q.abandoned).length

    const meta = journal.meta
    const run = projected.run
    const workflowFile = meta?.workflowFile ?? run?.workflowFile ?? run?.file ?? null
    const createdAt = meta?.createdAt ?? fallbackCreatedAt(dir, entry.journal.fileIdentity ? eventStat(path.join(dir, 'journal.jsonl')) : null)
    const allResults = [...journal.results.values()]
    const hasSpend = allResults.some((records) => records.some((r) => r.usage))
    const detail = {
      runId,
      name: run?.name ?? fallbackName(workflowFile),
      workflowFile,
      state: derived.state,
      liveDetail: derived.detail ?? null,
      createdAt,
      startedAt: run?.startedAt ?? null,
      endedAt: run?.endedAt ?? null,
      agents: projected.agents,
      adapters: [...new Set(projected.agents.map((a) => a.adapter).filter(Boolean))],
      spend: hasSpend ? { ...journal.spend } : null,
      budgetTotal: run?.budgetTotal ?? meta?.budgetTotal ?? null,
      openQuestions: projected.openQuestions,
      resumeCount: projected.resumeCount,
      hasRunLog: fs.existsSync(path.join(dir, 'run.log')),
      defaults: meta?.defaults ?? run?.defaults ?? null,
      hasArgs: Boolean(meta && own(meta, 'args')),
      // §7.3: the resume modal must "show graphDynamic when set". It is a journal meta
      // field (src/engine.js:832) and the only place the viewer can learn it. Additive and
      // tri-state on purpose: `null` for a run journalled before the field existed (§6.5),
      // which the modal renders as "not recorded" rather than as a static graph.
      graphDynamic: meta && own(meta, 'graphDynamic') ? Boolean(meta.graphDynamic) : null,
      engine: run?.engine ?? null,
      concurrency: Number.isInteger(run?.concurrency) ? run.concurrency : null,
      declaredPhases: Array.isArray(run?.phases) ? run.phases : null,
      phases: projected.phases,
      steps: projected.steps,
      questions: projected.questions,
      mail: projected.mail.slice(-DETAIL_TAIL_RECORDS),
      mailTotal: projected.mail.length,
      logs: projected.logs.slice(-DETAIL_TAIL_RECORDS),
      logTotal: projected.logs.length,
      structure: projected.structure,
      saturation: projected.saturation,
      offsets: { events: entry.raw.lastOffset ?? 0, journal: journal.offset },
      caps,
      attemptSpans: projected.attemptSpans,
      attemptScopes: projected.attemptScopes.map((scope) => ({
        phases: scope.phases,
        mail: scope.mail.slice(-DETAIL_TAIL_RECORDS),
        mailTotal: scope.mail.length,
        logs: scope.logs.slice(-DETAIL_TAIL_RECORDS),
        logTotal: scope.logs.length,
      })),
      unknownEvents: projected.unknownEvents,
    }
    detail.agentCounts = summarizeAgents(detail.agents)

    // E11 is independent of E9. The version establishes that this engine can emit ids;
    // the adapter establishes whether this particular transcript uses the pairing
    // protocol. Runs routinely mix adapters, so this verdict must stay per-agent.
    const toolIdsShipped = semverGte(run?.engine, TOOL_IDS_VERSION)
    for (const agent of detail.agents) {
      agent.toolIds = toolIdsShipped && TOOL_ID_ADAPTERS.has(agent.adapter)
    }

    if (includeArgs && detail.hasArgs) {
      const text = serialized(meta.args)
      if (Buffer.byteLength(text) <= INLINE_VALUE_BYTES) detail.args = meta.args
      else detail.argsTruncated = true
    }
    return detail
  }
}

const defaultSnapshots = new SnapshotStore()
export const getRunDetail = (runId, options) => defaultSnapshots.get(runId, options)

export async function readRunResult(runIdOrDir, { deriveState = deriveRunState } = {}) {
  const dir = path.isAbsolute(runIdOrDir) ? runIdOrDir : runDir(runIdOrDir)
  const runId = path.basename(dir)
  const file = path.join(dir, 'result.json')
  let bytes
  try { bytes = fs.readFileSync(file) } catch (err) {
    if (err?.code !== 'ENOENT') throw err
    const state = await deriveState(dir)
    return { pending: true, state: state.state }
  }
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { return { corrupt: true } }
  const out = { runId: parsed.runId ?? runId, status: parsed.status, resultBytes: bytes.length }
  if (own(parsed, 'error')) out.error = parsed.error
  if (own(parsed, 'result')) {
    if (bytes.length <= INLINE_VALUE_BYTES) out.result = parsed.result
    else {
      out.resultTruncated = true
      out.preview = previewBytes(serialized(parsed.result))
    }
  }
  return out
}

export function readAgentResult(runIdOrDir, index, { journalView = null } = {}) {
  const dir = path.isAbsolute(runIdOrDir) ? runIdOrDir : runDir(runIdOrDir)
  const view = journalView ?? new JournalView(path.join(dir, 'journal.jsonl'))
  const journal = view instanceof JournalView ? view.update() : view
  const rec = resultForAgent(journal, index)
  if (!rec) return null
  const text = serialized(rec.result)
  const resultBytes = Buffer.byteLength(text)
  const out = { agent: index, status: rec.status, resultBytes }
  if (resultBytes <= INLINE_VALUE_BYTES) out.result = rec.result
  else {
    out.resultTruncated = true
    out.preview = previewBytes(text)
  }
  return out
}

export function openResultReadStream(runIdOrDir) {
  const dir = path.isAbsolute(runIdOrDir) ? runIdOrDir : runDir(runIdOrDir)
  const file = path.join(dir, 'result.json')
  const fd = fs.openSync(file, 'r')
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) {
      const error = new Error('result is not a regular file')
      error.code = 'ENOENT'
      throw error
    }
    const stream = fs.createReadStream(file, { fd, autoClose: true })
    return {
      stat,
      stream,
      close: () => stream.destroy(),
    }
  } catch (error) {
    try { fs.closeSync(fd) } catch { /* already closed */ }
    throw error
  }
}
