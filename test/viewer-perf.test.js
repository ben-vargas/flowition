// W13 real-server performance owners for the §10 budgets that cannot be measured in
// jsdom. Timing values are always printed; correctness and the documented local/CI
// thresholds are asserted independently.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  MiB,
  generateEventsRun,
  generateGapRun,
  generateRunHome,
  generateTranscriptRun,
} from '../scripts/perf-fixtures.mjs'

const HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'flo-perf-'))
process.env.FLOWITION_HOME = HOME
const { startViewer } = await import('../src/viewer/index.js')

const MEASURED_PATHS = [
  'src/viewer',
  'viewer/src/features/transcript',
  'viewer/src/state',
  'viewer/e2e/viewer.spec.ts',
  'viewer/dist',
  'scripts/perf-fixtures.mjs',
  'test/viewer-perf.test.js',
]

function measuredSourceFingerprint(root = process.cwd()) {
  const files = []
  const visit = (relative) => {
    const absolute = path.join(root, relative)
    if (!fs.statSync(absolute).isDirectory()) { files.push(relative); return }
    for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name))
  }
  for (const relative of MEASURED_PATHS) visit(relative)
  const hash = crypto.createHash('sha256')
  for (const relative of files.sort()) {
    hash.update(relative)
    hash.update('\0')
    hash.update(fs.readFileSync(path.join(root, relative)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

test('MEASUREMENTS.md is bound to the measured source tree', () => {
  const measurements = fs.readFileSync(path.join(process.cwd(), 'docs', 'frontend', 'MEASUREMENTS.md'), 'utf8')
  const recorded = measurements.match(/^Measured-source SHA-256: `([a-f0-9]{64})`$/m)?.[1]
  assert.ok(recorded, 'MEASUREMENTS.md must record its measured-source SHA-256')
  assert.equal(
    recorded,
    measuredSourceFingerprint(),
    'performance-owning source changed — regenerate MEASUREMENTS.md before claiming green budgets',
  )
})

/**
 * The SERVER's own cost for one request, isolated from the client that asked for it.
 *
 * `startViewer` returns its `http.Server`, and the viewer under test runs in this process,
 * so `request` → response `finish` is the handler's wall time with no loopback round trip,
 * no client-side `JSON.parse` of a 72 KB body, and none of this file's own bookkeeping in
 * it. §10's P2 budget is a "server cost" number; this is the quantity it names.
 *
 * One slot, not a map: the P2 case issues its requests strictly one at a time, and `take()`
 * empties the slot — so a reading can never be attributed to a request that did not produce
 * it. A missed sample reads `null` and the caller asserts on that rather than silently
 * reusing the previous one.
 */
function probeHandler(viewer) {
  let last = null
  viewer.server.on('request', (req, res) => {
    const at = performance.now()
    res.once('finish', () => { last = performance.now() - at })
  })
  return { take() { const ms = last; last = null; return ms } }
}

function request(viewer, target, probe = null) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const req = http.get({
      host: '127.0.0.1',
      port: viewer.port,
      path: target,
      headers: {
        host: `127.0.0.1:${viewer.port}`,
        authorization: `Bearer ${viewer.token}`,
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* caller asserts the response */ }
        resolve({
          status: res.statusCode,
          text,
          json,
          elapsed: performance.now() - started,
          // Server-side handler time when a probe is attached; `null` otherwise.
          handlerMs: probe ? probe.take() : null,
        })
      })
    })
    req.once('error', reject)
  })
}

function replayGap(viewer, run, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    let buffer = ''
    let records = 0
    let duplicate = null
    const offsets = new Set()
    const timeout = setTimeout(() => {
      req.destroy()
      reject(new Error(`P8 timed out after ${records}/${run.records} records`))
    }, timeoutMs)
    const finish = () => {
      clearTimeout(timeout)
      req.destroy()
      resolve({
        elapsed: performance.now() - started,
        records,
        duplicate,
      })
    }
    const cursor = encodeURIComponent(`v1;e=${run.start}`)
    const req = http.get({
      host: '127.0.0.1',
      port: viewer.port,
      path: `/api/runs/${run.runId}/stream?token=${encodeURIComponent(viewer.token)}&streams=events&cursor=${cursor}`,
      headers: { host: `127.0.0.1:${viewer.port}` },
    })
    req.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    req.once('response', (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timeout)
        reject(new Error(`P8 SSE answered ${res.statusCode}`))
        return
      }
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        for (;;) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary === -1) break
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (!block.includes('event: batch')) continue
          const data = block.split('\n').find((part) => part.startsWith('data: '))?.slice(6)
          if (!data) continue
          for (const entry of JSON.parse(data).f ?? []) {
            if (entry.s !== 'e' || entry.o <= run.start) continue
            if (offsets.has(entry.o)) duplicate = entry.o
            offsets.add(entry.o)
            records++
          }
          if (records >= run.records) finish()
        }
      })
    })
  })
}

test('P2 measured over real HTTP against 5,000 generated runs with 10% stale', { timeout: 60_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'flo-p2-'))
  process.env.FLOWITION_HOME = home
  t.after(() => {
    process.env.FLOWITION_HOME = HOME
    fs.rmSync(home, { recursive: true, force: true })
  })

  const fixture = generateRunHome(home, { count: 5_000, staleRatio: 0.1 })
  assert.equal(fixture.count, 5_000)
  assert.equal(fixture.stale, 500)
  assert.equal(fixture.settled, 4_500)

  const viewer = await startViewer({ port: 0, primary: false })
  viewer.unref()
  t.after(() => viewer.close())
  const probe = probeHandler(viewer)

  const cold = await request(viewer, '/api/runs?limit=200', probe)
  assert.equal(cold.status, 200, cold.text)
  assert.equal(cold.json.totalOnDisk, 5_000)

  // §10's P2 budget is "run list SERVER COST at 5,000 runs … steady state ≤ 120 ms/request".
  // Three words in that line decide how it is measured here, and an earlier revision of this
  // test honoured none of them: it burst up to 25 requests and asserted the MINIMUM, so 24
  // over-budget responses could hide behind one fast sample. That is a strictly weaker
  // contract than the document's, and it is the finding this rewrite answers.
  //
  //  • **per request** — every steady-state sample is asserted, not the best of them.
  //  • **server cost** — what is timed is the server's own handler, from the `request` event
  //    to the response's `finish`, measured IN PROCESS. The client's `JSON.parse` of a 72 KB
  //    body, the loopback round trip and this test's own bookkeeping are not the viewer's
  //    list path and are not what the budget is about; measured here they added ~8 ms of
  //    pure noise to every sample.
  //  • **steady state** — the cold request above and the warm-ups below are excluded by the
  //    budget's own wording, not by convenience.
  //
  // Why not `process.cpuUsage()`, the obvious answer to "this file runs concurrently with
  // the rest of the suite, so wall clock measures the machine": it is process-wide and sums
  // ALL threads, so a parallel GC lands on top of a 45 ms handler as a 77 ms reading while
  // the handler itself never slowed down. It over-counts exactly when the gate is tightest,
  // which would make this test flaky for a reason that is not a regression. The handler
  // window is narrow enough that scheduling noise from the concurrent suite stays inside
  // the documented 120 ms local budget; both numbers are printed on every run so a drift
  // toward the ceiling is visible before it is a failure. The prior 80 ms threshold was
  // measured only in an artificial within-TTL burst. At the shipped cadence, artifact-
  // refresh polls reached 82.3 ms on the reference machine, so retaining 80 would reject
  // the production path the corrected test was introduced to measure. The corrected path
  // reached 99.7 ms while this file ran with the full root suite; 120 ms retains a 20%
  // local concurrency margin rather than replacing one timing-edge failure with another.
  const budget = process.env.CI ? 360 : 120
  const STEADY = 5
  const RUN_LIST_POLL_MS = 5_000
  // The cold request populated the tiered cache; these pay off the rest of the first-call
  // cost — V8 tier-up on the summary/fold path, the one-time allocations of the JSON writer.
  // They are issued and correctness-checked; only their timings are discarded, and nothing
  // about the assertion below is retried. The measured samples below are separated by the
  // shipped RunRail cadence. This intentionally crosses the 6 s artifact TTL on alternating
  // samples, so the gate includes the refresh cost an operator actually experiences instead
  // of measuring an artificial burst that the product never issues. SummaryStore's unit test
  // separately owns exact stat counts and the immediate marker/lock bypass.
  for (let i = 0; i < 3; i++) {
    const warmup = await request(viewer, '/api/runs?limit=200', probe)
    assert.equal(warmup.status, 200, warmup.text)
    assert.equal(warmup.json.totalOnDisk, 5_000)
  }
  // ...and one more warm-up on the far side of the artifact TTL. The burst above never
  // crosses it, so the FIRST TTL-crossing refresh — the only genuinely cold one, paying
  // first-touch artifact stats across all 5,000 run dirs — was landing in measured
  // sample 1 wearing a steady-state label it had not earned. CI's slower shared runners
  // made the mislabelling visible: 785.6/66.6/104.5/65.6/109.9 ms — every actually-steady
  // sample deep inside budget, the cold refresh alone above it. Steady-state refresh cost
  // is still measured: the sampling cadence below crosses the TTL on alternating samples.
  // (6_000 = summaries.js ARTIFACT_TTL_MS; +500 keeps timer jitter from landing short.)
  await new Promise((resolve) => setTimeout(resolve, 6_500))
  const refreshWarmup = await request(viewer, '/api/runs?limit=200', probe)
  assert.equal(refreshWarmup.status, 200, refreshWarmup.text)
  assert.equal(refreshWarmup.json.totalOnDisk, 5_000)
  const samples = []
  for (let i = 0; i < STEADY; i++) {
    await new Promise((resolve) => setTimeout(resolve, RUN_LIST_POLL_MS))
    const warm = await request(viewer, '/api/runs?limit=200', probe)
    assert.equal(warm.status, 200, warm.text)
    assert.equal(warm.json.totalOnDisk, 5_000)
    assert.ok(warm.handlerMs != null, 'the handler probe missed a request')
    samples.push(warm)
  }
  const handler = samples.map((s) => s.handlerMs)
  const wall = samples.map((s) => s.elapsed)
  console.log(
    `P2 server handler ×${STEADY}: ${handler.map((n) => n.toFixed(1)).join('/')} ms`
    + ` (client-observed round trip ${wall.map((n) => n.toFixed(1)).join('/')} ms)`
    + ` at the shipped ${RUN_LIST_POLL_MS / 1000} s poll cadence`
    + ` for 5,000 runs (500 stale; budget ${budget} ms/request)`,
  )
  for (const [i, ms] of handler.entries()) {
    assert.ok(
      ms <= budget,
      `P2 steady-state request ${i + 1}/${STEADY} took ${ms.toFixed(1)} ms in the handler`
      + ` > ${budget} ms — §10 budgets EVERY steady-state request, not the fastest one`,
    )
  }
})

test('P1/P3/P7/P8/P10 measured against generated production-format fixtures', { timeout: 45_000 }, async (t) => {
  t.after(() => fs.rmSync(HOME, { recursive: true, force: true }))
  const home = generateRunHome(HOME, { count: 200 })
  const events = generateEventsRun(HOME, { targetBytes: 10 * MiB })
  const huge = generateTranscriptRun(HOME, {
    runId: 'perf_transcript_500mb',
    targetBytes: 500 * MiB,
    sparsePrefixBytes: 498 * MiB,
    tailBytes: 2 * MiB,
  })
  const gap = generateGapRun(HOME, { records: 100_000 })
  assert.equal(home.count, 200)
  assert.ok(events.bytes >= 9.9 * MiB && events.bytes <= 10.1 * MiB)
  assert.equal(huge.bytes, 500 * MiB)
  assert.equal(gap.records, 100_000)
  assert.ok(gap.bytes <= 32 * MiB)

  const viewer = await startViewer({ port: 0, primary: false })
  viewer.unref()
  t.after(() => viewer.close())

  // P1 — warm list request. Browser first-commit time is measured in Playwright.
  const coldList = await request(viewer, '/api/runs?limit=200')
  assert.equal(coldList.status, 200, coldList.text)
  const warmList = await request(viewer, '/api/runs?limit=200')
  assert.equal(warmList.status, 200, warmList.text)
  assert.equal(warmList.json.totalOnDisk, 203)
  const p1Budget = process.env.CI ? 450 : 150
  console.log(`P1 server warm: ${warmList.elapsed.toFixed(1)} ms (budget ${p1Budget} ms)`)
  assert.ok(warmList.elapsed <= p1Budget)

  // P3 — the first detail request performs the cold 10 MiB fold; one appended record is
  // then a true cache delta, not a second whole-file fold.
  const coldFold = await request(viewer, `/api/runs/${events.runId}`)
  assert.equal(coldFold.status, 200, coldFold.text)
  assert.equal(coldFold.json.agents.length, 1)
  fs.appendFileSync(events.events, JSON.stringify({
    t: Date.now(),
    type: 'log',
    message: 'P3 delta',
  }) + '\n')
  const deltaFold = await request(viewer, `/api/runs/${events.runId}`)
  assert.equal(deltaFold.status, 200, deltaFold.text)
  assert.ok(deltaFold.json.logs.some((entry) => entry.message === 'P3 delta'))
  const coldBudget = process.env.CI ? 1_200 : 400
  const deltaBudget = process.env.CI ? 60 : 20
  console.log(`P3 fold: ${coldFold.elapsed.toFixed(1)} ms cold; ${deltaFold.elapsed.toFixed(1)} ms delta`)
  assert.ok(coldFold.elapsed <= coldBudget)
  assert.ok(deltaFold.elapsed <= deltaBudget)

  // P7 supporting server bound — the file really is 500 MiB (sparse historical prefix +
  // real 2 MiB JSONL tail). The product metric is NOT claimed here: Playwright owns dense
  // 100 MiB route-change → first rendered row in viewer/e2e/viewer.spec.ts.
  const tail = await request(
    viewer,
    `/api/runs/${huge.runId}/agents/0/page?from=tail&maxBytes=${2 * MiB}`,
  )
  assert.equal(tail.status, 200, tail.text)
  assert.equal(tail.json.size, 500 * MiB)
  assert.ok(tail.json.start >= 498 * MiB)
  assert.ok(tail.json.items.length > 1_000)
  const p7Budget = process.env.CI ? 3_000 : 1_000
  console.log(`P7 supporting 500 MiB tail HTTP: ${tail.elapsed.toFixed(1)} ms; ${tail.json.items.length} rows`)
  assert.ok(tail.elapsed <= p7Budget)

  // P8 — replay the actual SSE gap and prove every composite-cursor offset is unique.
  const catchup = await replayGap(viewer, gap)
  assert.equal(catchup.records, 100_000)
  assert.equal(catchup.duplicate, null)
  const p8Budget = process.env.CI ? 6_000 : 2_000
  console.log(`P8 catch-up: ${catchup.elapsed.toFixed(1)} ms for ${catchup.records} records; zero duplicates`)
  assert.ok(catchup.elapsed <= p8Budget)

  // P10 — bytes on disk, measured from the committed artifact the package ships.
  const dist = path.join(process.cwd(), 'viewer', 'dist')
  const jsGzip = gzipSync(fs.readFileSync(path.join(dist, 'app.js'))).byteLength
  const fonts = fs.readdirSync(path.join(dist, 'fonts'))
    .filter((name) => name.endsWith('.woff2'))
    .reduce((total, name) => total + fs.statSync(path.join(dist, 'fonts', name)).size, 0)
  console.log(`P10 bundle: ${(jsGzip / 1024).toFixed(1)} KiB gzip JS; ${(fonts / 1024).toFixed(1)} KiB fonts`)
  assert.ok(jsGzip <= 250 * 1024)
  assert.ok(fonts <= 300 * 1024)
})
