// Lossy, read-only journal projection. Unlike Journal.load this reader never repairs
// user data and never rejects a whole snapshot because one observation line is bad.
import fs from 'node:fs'

export const MAX_JOURNAL_LINE_BYTES = 64 * 1024 * 1024
// `meta.args` is intentionally allowed to exceed the API's 1 MiB inline cap, so the
// first-line fast path must be able to classify that legitimate record. It remains
// hard-bounded at the journal reader's per-record ceiling.
const FIRST_LINE_LIMIT = MAX_JOURNAL_LINE_BYTES
const FIRST_LINE_PAGE_BYTES = 64 * 1024

const identity = (stat) => `${stat.dev}:${stat.ino}`
const addUsage = (into, value) => {
  if (!value || typeof value !== 'object') return
  into.input += Number(value.input) || 0
  into.output += Number(value.output) || 0
  into.cost += Number(value.cost) || 0
}

export function emptyJournalView() {
  return {
    meta: null,
    results: new Map(),
    resultByIndex: new Map(),
    sessions: new Map(),
    // key -> the LAST `usage-cum` cum value (the live counter, and the chain's `prev`).
    usageCum: new Map(),
    // key -> the chained sum of POSITIVE `usage-cum` deltas. Zero-reset aware by
    // construction: a `{0,0}` restart contributes a zero delta and the next report is
    // measured from zero, so a per-attempt counter's run-up adds to what it already
    // banked instead of replacing it. Same accounting as Journal.load's `cumTrack`
    // (src/journal.js:100–116) — the viewer must not disagree with the engine's budget.
    usageCumSpend: new Map(),
    answers: new Map(),
    started: new Map(),
    indexByKey: new Map(),
    mail: [],
    mailById: new Map(),
    mailDoneById: new Map(),
    spend: { input: 0, output: 0, cost: 0 },
    offset: 0,
    unknownRecords: 0,
    corruptLines: 0,
    oversizeLines: 0,
  }
}

/**
 * The summary fast path: only a complete, parseable first line is cacheable. A parsed
 * non-meta record permanently means `meta:null`; a torn or malformed line is retried.
 */
export function readFirstJournalMeta(file, { fsImpl = fs } = {}) {
  let fd
  try { fd = fsImpl.openSync(file, 'r') } catch (err) {
    if (err?.code === 'ENOENT') return { cacheable: true, meta: null, stat: null }
    throw err
  }
  try {
    const stat = fsImpl.fstatSync(fd)
    const chunks = []
    let offset = 0
    let line = null
    while (offset < stat.size && offset <= FIRST_LINE_LIMIT) {
      const length = Math.min(FIRST_LINE_PAGE_BYTES, stat.size - offset, FIRST_LINE_LIMIT + 1 - offset)
      const page = Buffer.allocUnsafe(length)
      const got = fsImpl.readSync(fd, page, 0, length, offset)
      if (!got) break
      const bytes = page.subarray(0, got)
      const nl = bytes.indexOf(0x0a)
      if (nl !== -1) {
        if (offset + nl > FIRST_LINE_LIMIT) return { cacheable: false, meta: null, stat }
        chunks.push(bytes.subarray(0, nl))
        line = Buffer.concat(chunks, offset + nl)
        break
      }
      chunks.push(bytes)
      offset += got
    }
    if (!line) return { cacheable: false, meta: null, stat }
    try {
      const rec = JSON.parse(line.toString('utf8').replace(/\r$/, ''))
      return { cacheable: true, meta: rec?.type === 'meta' ? rec : null, stat }
    } catch {
      return { cacheable: false, meta: null, stat }
    }
  } finally {
    fsImpl.closeSync(fd)
  }
}

export function readCompleteJsonl(file, from = 0, { maxLineBytes = MAX_JOURNAL_LINE_BYTES } = {}) {
  let stat
  try { stat = fs.statSync(file) } catch (err) {
    if (err?.code === 'ENOENT') return { records: [], offset: 0, stat: null, corruptLines: 0, oversizeLines: 0 }
    throw err
  }
  if (from < 0 || from > stat.size) from = 0
  const length = stat.size - from
  if (!length) return { records: [], offset: from, stat, corruptLines: 0, oversizeLines: 0 }
  const fd = fs.openSync(file, 'r')
  let bytes
  try {
    bytes = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const n = fs.readSync(fd, bytes, read, length - read, from + read)
      if (!n) break
      read += n
    }
    bytes = bytes.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }

  const records = []
  let start = 0
  let corruptLines = 0
  let oversizeLines = 0
  for (;;) {
    const nl = bytes.indexOf(0x0a, start)
    if (nl === -1) break
    const line = bytes.subarray(start, nl)
    const o = from + nl + 1
    if (line.length > maxLineBytes) oversizeLines++
    else if (line.length) {
      try {
        const rec = JSON.parse(line.toString('utf8').replace(/\r$/, ''))
        if (rec && typeof rec === 'object') records.push({ o, rec })
      } catch { corruptLines++ }
    }
    start = nl + 1
  }
  return { records, offset: from + start, stat, corruptLines, oversizeLines }
}

function consume(view, rec) {
  switch (rec.type) {
    case 'meta':
      view.meta = rec
      break
    case 'started':
      if (rec.key != null) {
        view.started.set(rec.key, rec)
        if (Number.isInteger(rec.index)) view.indexByKey.set(rec.key, rec.index)
      }
      break
    case 'session':
      if (rec.key != null) view.sessions.set(rec.key, rec.sessionId ?? null)
      break
    case 'usage-cum': {
      if (rec.key == null) break
      const cum = {
        input: Number(rec.cum?.input) || 0,
        output: Number(rec.cum?.output) || 0,
      }
      const prev = view.usageCum.get(rec.key)
      const spend = view.usageCumSpend.get(rec.key) ?? { input: 0, output: 0 }
      spend.input += Math.max(0, cum.input - (Number(prev?.input) || 0))
      spend.output += Math.max(0, cum.output - (Number(prev?.output) || 0))
      view.usageCumSpend.set(rec.key, spend)
      view.usageCum.set(rec.key, cum)
      break
    }
    case 'result': {
      if (rec.key == null) break
      let all = view.results.get(rec.key)
      if (!all) view.results.set(rec.key, (all = []))
      all.push(rec)
      if (Number.isInteger(rec.index)) {
        view.indexByKey.set(rec.key, rec.index)
        view.resultByIndex.set(rec.index, rec)
      }
      addUsage(view.spend, rec.usage)
      break
    }
    case 'answer':
      if (rec.qid != null) view.answers.set(String(rec.qid), rec.value)
      break
    case 'mail':
      view.mail.push(rec)
      if (rec.id != null) view.mailById.set(rec.id, rec)
      break
    case 'mail-done':
      if (rec.id != null) view.mailDoneById.set(rec.id, rec)
      break
    case 'end':
      view.end = rec
      break
    default:
      view.unknownRecords++
  }
}

export class JournalView {
  constructor(file, { maxLineBytes = MAX_JOURNAL_LINE_BYTES } = {}) {
    this.file = file
    this.maxLineBytes = maxLineBytes
    this.view = emptyJournalView()
    this.fileIdentity = null
    this.mtimeMs = null
    this.size = 0
  }

  reset() {
    this.view = emptyJournalView()
    this.fileIdentity = null
    this.mtimeMs = null
    this.size = 0
    return this.view
  }

  update() {
    let stat
    try { stat = fs.statSync(this.file) } catch (err) {
      if (err?.code === 'ENOENT') return this.reset()
      throw err
    }
    const id = identity(stat)
    const replaced = this.fileIdentity != null && this.fileIdentity !== id
    const shrunk = stat.size < this.view.offset
    const rewrittenSameSize = this.fileIdentity === id && stat.size === this.size
      && this.mtimeMs != null && stat.mtimeMs !== this.mtimeMs && stat.size > 0
    if (replaced || shrunk || rewrittenSameSize) this.reset()

    const delta = readCompleteJsonl(this.file, this.view.offset, { maxLineBytes: this.maxLineBytes })
    for (const { rec } of delta.records) consume(this.view, rec)
    this.view.offset = delta.offset
    this.view.corruptLines += delta.corruptLines
    this.view.oversizeLines += delta.oversizeLines
    this.fileIdentity = id
    this.mtimeMs = stat.mtimeMs
    this.size = stat.size
    return this.view
  }
}

export function resultForAgent(view, index) {
  if (view.resultByIndex.has(index)) return view.resultByIndex.get(index)
  let found = null
  for (const records of view.results.values()) {
    for (const rec of records) if (rec.index === index) found = rec
  }
  return found
}
