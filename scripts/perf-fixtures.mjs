#!/usr/bin/env node
// Deterministic, dev-only W13 fixtures for DESIGN §10. The bytes use the same JSONL
// record shapes as the real EventSink, Journal, and Transcript writers; no production
// module imports this file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MiB = 1024 * 1024

const line = (record) => JSON.stringify(record) + '\n'
const pad = (n, width = 5) => String(n).padStart(width, '0')

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function writeRepeatedLines(file, targetBytes, makeLine) {
  const fd = fs.openSync(file, 'w')
  let bytes = 0
  let index = 0
  let records = 0
  try {
    const batch = []
    let batchBytes = 0
    while (bytes < targetBytes) {
      const record = Buffer.from(makeLine(index++))
      if (record.length === 0) break
      if (bytes + batchBytes + record.length > targetBytes && bytes + batchBytes > 0) break
      batch.push(record)
      batchBytes += record.length
      records++
      if (batchBytes >= MiB) {
        fs.writeSync(fd, Buffer.concat(batch))
        bytes += batchBytes
        batch.length = 0
        batchBytes = 0
      }
    }
    if (batchBytes) {
      fs.writeSync(fd, Buffer.concat(batch))
      bytes += batchBytes
    }
  } finally {
    fs.closeSync(fd)
  }
  return { bytes, records }
}

function meta(runId, createdAt, file = 'perf.workflow.mjs') {
  return {
    type: 'meta',
    runId,
    createdAt,
    workflowFile: path.join('/tmp', file),
    fileHash: 'perf-fixture',
    graphHash: 'perf-fixture',
    graphDynamic: false,
    args: null,
    defaults: { adapter: 'mock' },
  }
}

function seedBase(runsDir, runId, createdAt = Date.now()) {
  const dir = ensureDir(path.join(runsDir, runId))
  ensureDir(path.join(dir, 'agents'))
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), line(meta(runId, createdAt)))
  fs.writeFileSync(path.join(dir, 'events.jsonl'), line({
    t: createdAt,
    type: 'run',
    runId,
    state: 'started',
    file: 'perf.workflow.mjs',
    name: 'W13 performance fixture',
    engine: '0.1.2',
    concurrency: 8,
  }))
  return dir
}

/**
 * P1/P2: 90% settled and 10% stale — the expensive §5.4.2 mix.
 */
export function generateRunHome(root, {
  count = 5_000,
  staleRatio = 0.1,
  createdAt = 1_700_000_000_000,
} = {}) {
  const runsDir = ensureDir(path.join(root, 'runs'))
  const stale = Math.round(count * staleRatio)
  for (let i = 0; i < count; i++) {
    const runId = `perf_run_${pad(i)}`
    const dir = seedBase(runsDir, runId, createdAt - i)
    if (i < stale) {
      fs.writeFileSync(path.join(dir, '.heartbeat'), String(Date.now() - 120_000))
      continue
    }
    fs.appendFileSync(path.join(dir, 'journal.jsonl'), line({ type: 'end', status: 'completed' }))
    fs.appendFileSync(path.join(dir, 'events.jsonl'), line({
      t: createdAt + 1,
      type: 'run',
      runId,
      state: 'completed',
    }))
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
      runId,
      status: 'completed',
      result: { fixture: true },
    }))
  }
  return { root, runsDir, count, stale, settled: count - stale }
}

/**
 * P3: a 10 MiB events file with real foldable agent progress records.
 */
export function generateEventsRun(root, {
  targetBytes = 10 * MiB,
  runId = 'perf_events_10mb',
} = {}) {
  const runsDir = ensureDir(path.join(root, 'runs'))
  const dir = seedBase(runsDir, runId)
  const prefix = [
    line({ t: 1, type: 'phase', phaseIndex: 0, title: 'Load' }),
    line({ t: 2, type: 'agent', index: 0, key: 'perf-key', label: 'fixture', adapter: 'mock', state: 'queued', phase: 'Load', phaseIndex: 0, path: [] }),
    line({ t: 3, type: 'agent', index: 0, key: 'perf-key', label: 'fixture', adapter: 'mock', state: 'running', phase: 'Load', phaseIndex: 0, path: [], stallMs: 1_800_000 }),
  ].join('')
  fs.appendFileSync(path.join(dir, 'events.jsonl'), prefix)
  const current = fs.statSync(path.join(dir, 'events.jsonl')).size
  const generated = writeRepeatedLines(
    path.join(dir, 'events.bulk.jsonl'),
    Math.max(0, targetBytes - current - 512),
    (index) => line({
      t: index + 4,
      type: 'agent',
      index: 0,
      state: 'progress',
      tool: 'Read',
      outputTokens: index,
      lastOutputAt: index + 4,
      message: `fixture progress ${index}`,
    }),
  )
  const bulk = fs.readFileSync(path.join(dir, 'events.bulk.jsonl'))
  fs.appendFileSync(path.join(dir, 'events.jsonl'), bulk)
  fs.unlinkSync(path.join(dir, 'events.bulk.jsonl'))
  fs.appendFileSync(path.join(dir, 'events.jsonl'), line({
    t: generated.records + 5,
    type: 'agent',
    index: 0,
    key: 'perf-key',
    label: 'fixture',
    adapter: 'mock',
    state: 'done',
    durationMs: 1,
    outputTokens: generated.records,
    usage: { input: 0, output: generated.records, cost: 0 },
  }) + line({
    t: generated.records + 6,
    type: 'run',
    runId,
    state: 'completed',
  }))
  fs.appendFileSync(path.join(dir, 'journal.jsonl'),
    line({ type: 'started', key: 'perf-key', index: 0, label: 'fixture', adapter: 'mock' })
    + line({ type: 'result', key: 'perf-key', index: 0, status: 'completed', result: 'ok', usage: { input: 0, output: generated.records, cost: 0 }, durationMs: 1 })
    + line({ type: 'end', status: 'completed' }))
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    runId,
    status: 'completed',
    result: { records: generated.records },
  }))
  return {
    runId,
    dir,
    events: path.join(dir, 'events.jsonl'),
    bytes: fs.statSync(path.join(dir, 'events.jsonl')).size,
    records: generated.records + 6,
  }
}

/**
 * P6/P7: a large transcript. `sparsePrefixBytes` lets P7 make the file 500 MiB while
 * writing only the real 2 MiB tail window the server is allowed to read.
 */
export function generateTranscriptRun(root, {
  targetBytes = 100 * MiB,
  sparsePrefixBytes = 0,
  tailBytes = targetBytes,
  runId = 'perf_transcript_100mb',
} = {}) {
  const runsDir = ensureDir(path.join(root, 'runs'))
  const dir = seedBase(runsDir, runId)
  fs.appendFileSync(path.join(dir, 'events.jsonl'),
    line({ t: 2, type: 'agent', index: 0, key: 'transcript-key', label: 'writer', adapter: 'mock', state: 'queued', path: [] })
    + line({ t: 3, type: 'agent', index: 0, key: 'transcript-key', label: 'writer', adapter: 'mock', state: 'running', path: [], stallMs: 1_800_000 })
    + line({ t: 4, type: 'agent', index: 0, key: 'transcript-key', label: 'writer', adapter: 'mock', state: 'done', durationMs: 1, outputTokens: 1, usage: { input: 1, output: 1, cost: 0 } })
    + line({ t: 5, type: 'run', runId, state: 'completed' }))
  fs.appendFileSync(path.join(dir, 'journal.jsonl'),
    line({ type: 'started', key: 'transcript-key', index: 0, label: 'writer', adapter: 'mock' })
    + line({ type: 'result', key: 'transcript-key', index: 0, status: 'completed', result: 'ok', usage: { input: 1, output: 1, cost: 0 }, durationMs: 1 })
    + line({ type: 'end', status: 'completed' }))
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ runId, status: 'completed', result: 'ok' }))

  const transcript = path.join(dir, 'agents', '0.jsonl')
  const fd = fs.openSync(transcript, 'w')
  try {
    if (sparsePrefixBytes > 0) fs.ftruncateSync(fd, sparsePrefixBytes)
  } finally {
    fs.closeSync(fd)
  }
  const temp = path.join(dir, 'agents', '.tail.jsonl')
  const generated = writeRepeatedLines(temp, tailBytes, (index) => line({
    t: index,
    kind: 'tool',
    name: 'Read',
    input: JSON.stringify({ path: `src/fixture-${index}.js`, pad: 'x'.repeat(180) }),
    id: `tool-${index}`,
  }))
  fs.appendFileSync(transcript, fs.readFileSync(temp))
  fs.unlinkSync(temp)
  // Sparse P7 fixtures describe an exact logical file size. The generated tail ends on a
  // record boundary and can fall a few bytes short of its byte target; extend/truncate the
  // sparse file to the requested logical size so the API is genuinely tested at 500 MiB.
  if (sparsePrefixBytes > 0) fs.truncateSync(transcript, targetBytes)
  return {
    runId,
    dir,
    transcript,
    bytes: fs.statSync(transcript).size,
    records: generated.records,
  }
}

/** P8: an append-only 100k-record reconnect gap. */
export function generateGapRun(root, {
  records = 100_000,
  runId = 'perf_gap_100k',
} = {}) {
  const runsDir = ensureDir(path.join(root, 'runs'))
  const dir = seedBase(runsDir, runId)
  const events = path.join(dir, 'events.jsonl')
  const start = fs.statSync(events).size
  const temp = path.join(dir, '.gap.jsonl')
  const generated = writeRepeatedLines(temp, 32 * MiB, (index) =>
    index >= records ? '' : line({ t: index + 1, type: 'log', message: `gap record ${index}` }))
  const data = fs.readFileSync(temp)
  // writeRepeatedLines cannot stop on an empty record itself; retain exactly 100k lines.
  const endOfRecords = (() => {
    let at = 0
    for (let i = 0; i < records; i++) at = data.indexOf(0x0a, at) + 1
    return at
  })()
  fs.appendFileSync(events, data.subarray(0, endOfRecords))
  fs.unlinkSync(temp)
  return {
    runId,
    dir,
    events,
    start,
    end: fs.statSync(events).size,
    bytes: fs.statSync(events).size - start,
    records: Math.min(records, generated.records),
  }
}

export function generatePerfFixtures(root, options = {}) {
  ensureDir(root)
  const home = generateRunHome(root, { count: options.runs ?? 5_000 })
  const events = generateEventsRun(root, { targetBytes: options.eventBytes ?? 10 * MiB })
  const transcript = generateTranscriptRun(root, {
    targetBytes: options.transcriptBytes ?? 100 * MiB,
    tailBytes: options.transcriptBytes ?? 100 * MiB,
  })
  const gap = generateGapRun(root, { records: options.gapRecords ?? 100_000 })
  return { root, home, events, transcript, gap }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root') out.root = argv[++i]
    else if (arg === '--runs') out.runs = Number(argv[++i])
    else if (arg === '--events-mib') out.eventBytes = Number(argv[++i]) * MiB
    else if (arg === '--transcript-mib') out.transcriptBytes = Number(argv[++i]) * MiB
    else if (arg === '--gap-records') out.gapRecords = Number(argv[++i])
    else throw new Error(`unknown argument ${arg}`)
  }
  return out
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const options = parseArgs(process.argv.slice(2))
  const root = path.resolve(options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-perf-')))
  const result = generatePerfFixtures(root, options)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}
