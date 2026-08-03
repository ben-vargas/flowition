#!/usr/bin/env node
// Capture the BUILT Home AND COCKPIT screens for §3.7's side-by-side gate, and measure the
// compositions in the browser that renders them.
//
//   node docs/frontend/comps/capture-built.mjs
//
// §3.7: "W8/W11 acceptance then includes a side-by-side of built screens against the
// approved comps at those viewports." The comps are hand-authored HTML; these are
// photographs of the real product, so the comparison is only worth something if nothing
// here is faked. Accordingly:
//
//   • a throwaway FLOWITION_HOME is created, and REAL workflows are run into it by the
//     real engine on the mock adapter — no hand-written journals, no stubbed API;
//   • the attention-heavy world is produced the way an operator would produce it: one run
//     blocks on a real `ask()` and is left unanswered, one run is SIGKILLed mid-flight so
//     `deriveRunState` calls it stale off a dead `run.lock`, one run is left running under
//     a `--budget` ceiling it has already passed;
//   • `startViewer` serves the COMMITTED `viewer/dist` over loopback with the full §7.1.4
//     header set, and headless Chrome loads it through the §2.2 hash-grammar token handoff.
//     So every capture exercises the real read API, static pipeline, CSP and vendored fonts.
//
// Requires: Google Chrome, and Node >= 22 (this script uses the global WebSocket to speak
// CDP; the VIEWER itself is Node >= 18.17 — see viewer/src/toolchain.test.ts).
//
// Writes: docs/frontend/comps/built/home-built-{light,dark}-{1440,800}.png
//         docs/frontend/comps/built/cockpit-live-built-{light,dark}-{1440,800}.png
//         docs/frontend/comps/built/cockpit-stale-built-{light,dark}-{1440,800}.png
//         docs/frontend/comps/built/captures.json — the freshness manifest below.
//
// **Why this script also MEASURES.** Review round 1 rejected W11 on two findings a
// screenshot cannot settle and jsdom cannot see: the cockpit rendered a two-column screen
// where §3.7 specifies run rail 280 │ main 840 │ inbox 320, and the Gantt's ruler,
// saturation strip and lanes resolved to track boxes 2px apart because a border on the lane
// ate the grid column the percentages are measured against. jsdom computes no layout at all,
// so the DOM test that "proved" one axis was comparing unresolved CSS declarations.
//
// This is already the one place in the repo where the real product is laid out by a real
// browser. So it records, alongside each capture, the `getBoundingClientRect()` of the three
// grid columns, the two 44px drawer handles, and every time-coordinate box on the Gantt's
// shared axis — plus the absolute x of the ruler's ticks and the lanes' gridlines.
// `test/comps-captures.test.js` asserts those numbers. The measurement is pinned to the same
// `dist` fingerprint as the PNGs, so it cannot go stale without the test going red.
//
// **Why a manifest.** These PNGs are ACCEPTANCE EVIDENCE for §3.7's side-by-side, and
// evidence that silently ages is worse than none: round-4 changed the stale card in `src/`
// and the committed captures kept showing the copy it replaced, so the "side-by-side"
// compared the current comps against a screenshot of a UI that no longer existed. A PNG
// cannot be byte-reproduced in a test (Chrome version, font rasterization and the fixture's
// own clock all move), so the manifest records the INPUTS instead — the hash of the
// `viewer/dist` these captures were taken of, and of this script that took them — and
// `test/comps-captures.test.js` fails the moment either moves. Rebuild dist, re-run this,
// commit both.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File, treeSha256 } from './lib/fingerprint.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..', '..')
const OUT = path.join(here, 'built')
const MANIFEST = path.join(OUT, 'captures.json')
const CHROME = process.env.CHROME_BIN
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const VIEWPORTS = [
  { w: 1440, h: 1000 },
  { w: 800, h: 1180 },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- the fixture world ---------------------------------------------------------------

const WORKFLOWS = {
  // Blocks on a real ask(). Left unanswered → an ask card with the question text inline.
  'blocked.workflow.js': `
export const meta = { name: 'migrate-callsites', description: 'blocks on an operator answer' }
export default async function ({ agent, ask }) {
  await agent('ECHO scanned 41 call sites', { adapter: 'mock', label: 'scan' })
  const answer = await ask('Two call sites in src/cli.js pass a bare string where the new adapter API expects {path}. Rewrite both, or keep a compatibility shim for one release?', { id: 'rewrite' })
  return 'answered:' + answer
}
`,
  // Passes its budget ceiling WHILE an already-admitted agent is still working, which is
  // the only way a run is genuinely over budget and still running: src/engine.js:981
  // refuses ADMISSION over the ceiling, so the state exists exactly when the spend lands
  // after the last admission. Three echoes (5 output tokens each) against a ceiling of 12,
  // with the sleeper admitted first, is that state — and it is the state §2.4's "the
  // ceiling is advisory, never a hard cap" is about.
  //
  // It is ALSO the run the `cockpit-live` comp is drawn of, so its inbox must be the comp's
  // inbox: `page-cockpit.mjs`'s `inboxRail()` draws **one open question with an answer
  // composer, one answered question collapsed to its value, two agent reports (`mail
  // dir:out`) and three steering records (`dir:in`)**. Round 1 captured a run with no ask
  // and no mail, so the shipped photograph said "nothing open" where the approved
  // composition has the operator's whole work queue (review round 2, B4).
  //
  // The panel is deliberately NOT awaited before the first `ask()`: an inbox is only
  // interesting while agents are still working, and `await parallel(...)` on a 10-minute
  // sleeper would never reach the questions.
  'live.workflow.js': `
export const meta = { name: 'judge-panel-auth-refactor', description: 'a panel still deliberating' }
export default async function ({ agent, parallel, ask, sendTo }) {
  const panel = parallel([
    () => agent('SLEEP 600000', { adapter: 'mock', label: 'deliberate' }),
    () => agent('ECHO judged 1', { adapter: 'mock', label: 'judge1' }),
    () => agent('ECHO judged 2', { adapter: 'mock', label: 'judge2' }),
    () => agent('ECHO judged 3', { adapter: 'mock', label: 'judge3' }),
  ])
  panel.catch(() => {})
  const scope = await ask('Should the panel score the deprecated auth-legacy path at all, or judge only the code that ships?', { id: 'scope' })
  sendTo('deliberate', 'Operator ruling on scope: ' + scope)
  await ask('Two call sites in src/cli.js pass a bare string where the new adapter API expects {path}. Rewrite both, or keep a compatibility shim for one release?', { id: 'rewrite' })
  return 'done'
}
`,
  // SIGKILLed while its agents are in flight → run.lock with a dead pid → stale.
  'stale.workflow.js': `
export const meta = { name: 'audit-viewer-security', description: 'engine dies mid-flight' }
export default async function ({ agent, parallel }) {
  await agent('ECHO mapped the read surface', { adapter: 'mock', label: 'map' })
  await parallel([1, 2, 3].map((n) => () => agent('SLEEP 600000', { adapter: 'mock', label: 'probe' + n })))
  return 'done'
}
`,
  // Plain completed runs, so the table under the strip is not all incidents.
  'done.workflow.js': `
export const meta = { name: 'review-changes', description: 'a run that simply finished' }
export default async function ({ agent, pipeline, phase }) {
  phase('Review')
  await pipeline(['api', 'ui', 'docs'],
    (x) => agent('ECHO reviewed ' + x, { adapter: 'mock', label: 'review:' + x }),
    (prev) => agent('ECHO summarised ' + prev, { adapter: 'mock', label: 'summarise' }))
  phase('Report')
  return 'reviewed'
}
`,
  'flaky.workflow.js': `
export const meta = { name: 'find-flaky-tests', description: 'a run that failed' }
export default async function ({ agent }) {
  await agent('ECHO collected 214 tests', { adapter: 'mock', label: 'collect' })
  await agent('FAILN spawn 3', { adapter: 'mock', label: 'rerun' })
  return 'never'
}
`,
}

function flowition(home, args, { detached = false } = {}) {
  const env = { ...process.env, FLOWITION_HOME: home, NO_COLOR: '1' }
  const argv = [path.join(ROOT, 'bin', 'flowition.js'), ...args, '--no-viewer']
  if (detached) {
    return spawn(process.execPath, argv, { env, stdio: 'ignore' })
  }
  const done = spawnSync(process.execPath, argv, { env, encoding: 'utf8' })
  if (done.status !== 0) log(`  (exit ${done.status}) ${done.stderr?.trim().split('\n').pop()}`)
  return done
}

async function buildWorld(home, viewer) {
  const wfDir = path.join(home, 'workflows')
  fs.mkdirSync(wfDir, { recursive: true })
  for (const [name, source] of Object.entries(WORKFLOWS)) {
    fs.writeFileSync(path.join(wfDir, name), source.trimStart())
  }
  const wf = (name) => path.join(wfDir, name)

  // Settled runs first, so they sort BELOW the live ones (createdAt desc, §5.4.2 step 3).
  log('running the settled runs…')
  flowition(home, ['run', wf('done.workflow.js')])
  flowition(home, ['run', wf('flaky.workflow.js')])

  log('starting the run that will go stale…')
  const doomed = flowition(home, ['run', wf('stale.workflow.js')], { detached: true })
  await waitFor(viewer, 'the doomed run to start working',
    (runs) => named(runs, 'audit-viewer-security')?.agents.done >= 1, 30_000)
  // What the first agent reported before the engine went away. The stale cockpit's inbox is
  // the record of what the run managed to say, so the third column has content there too
  // (and §3.7's 280│840│320 grid is measured on a rail that is open for the same reason the
  // live one is — see `inboxDefaultOpen`).
  const doomedRun = named(await fetchRuns(viewer), 'audit-viewer-security')
  flowition(home, ['post', '--run', doomedRun.runId, '--agent', '0',
    'map: 14 read routes, 4 mutations, 1 SSE stream — token check is per-request'])
  doomed.kill('SIGKILL')

  log('starting the live over-budget run…')
  // The mock adapter emits usage {input:10, output:5} per turn; three judges spend 15
  // output tokens, so a ceiling of 12 is genuinely — provably — exceeded.
  //
  // `--args` gives the run a real `meta.args` (src/cli.js parses it, snapshot.js:312 turns
  // it into `hasArgs`), which is what §13 Q4's "show args" disclosure keys off. The value is
  // NOT expected in this photograph: the disclosure is closed until an operator clicks it,
  // and `comps-captures.test.js` asserts the capture shows the control and not the value.
  flowition(home, [
    'run', wf('live.workflow.js'), '--budget', '12', '--concurrency', '6',
    '--args', JSON.stringify({ pr: 4412, dimensions: ['correctness', 'security'], strict: true }),
  ], { detached: true })

  log('starting the run that blocks on ask()…')
  flowition(home, ['run', wf('blocked.workflow.js')], { detached: true })

  await waitFor(viewer, 'the ask() to open',
    (runs) => named(runs, 'migrate-callsites')?.openQuestions > 0, 60_000)

  // ---- the live run's INBOX, built the way an operator builds one -------------------
  // Every record below goes through the real control socket (`flowition answer|post|send`),
  // so what the capture shows is a real E7 answer value, real `mail dir:out` reports and
  // real steering with real delivery verdicts — not a seeded journal.
  const live0 = named(await fetchRuns(viewer), 'judge-panel-auth-refactor')
  await waitForDetail(viewer, live0.runId, 'the panel\'s scope question to open',
    (d) => d.questions?.some((q) => q.qid === 'scope' && !q.answered), 60_000)
  log('answering the panel\'s scope question (E7 answer value)…')
  flowition(home, ['answer', live0.runId, 'scope', 'judge only the code that ships'])

  // The workflow's own `sendTo()` fires on that answer — steering record 1, workflow origin,
  // with the journalled callsite (RECON-flowition §1.4). Then the second ask opens and STAYS
  // open: that is the comp's "1 open" question with its composer. Waited for BY QID, because
  // the listing's `openQuestions` count reads 1 both before the answer and after the next
  // ask, and a count cannot tell those two states apart.
  await waitForDetail(viewer, live0.runId, 'the panel\'s rewrite question to open',
    (d) => d.questions?.some((q) => q.qid === 'scope' && q.answered)
      && d.questions?.some((q) => q.qid === 'rewrite' && !q.answered), 60_000)

  log('posting the agents\' reports and steering the sleeper…')
  // Two agent reports (`mail dir:out`), each attributed to the agent that sent it.
  flowition(home, ['post', '--run', live0.runId, '--agent', '1',
    'judge1: the legacy path is unreachable from the router — scoring it would be noise'])
  flowition(home, ['post', '--run', live0.runId, '--agent', '2',
    'judge2: two call sites still construct the adapter arg as a bare string'])
  // Two operator steers into the live agent (`mail dir:in`), joining the workflow's own.
  flowition(home, ['send', live0.runId, 'deliberate', 'Weight the router evidence over the grep count.'])
  flowition(home, ['send', live0.runId, 'deliberate', 'Also check the SSE endpoint for token leakage.'])
  log('waiting out the 15s staleness window (src/run-state.js STALE_MS)…')
  await waitFor(viewer, 'the killed run to read as stale',
    (runs) => named(runs, 'audit-viewer-security')?.state === 'stale', 60_000)

  const runs = await fetchRuns(viewer)
  log(`world: ${runs.map((r) => `${r.name}=${r.state}${r.openQuestions ? '?' : ''}`).join(' ')}`)
  const live = named(runs, 'judge-panel-auth-refactor')
  if (live?.state !== 'running') throw new Error('the live run is not running')
  if (!(live.spend?.output > live.budgetTotal)) {
    throw new Error(`the live run is not over budget: ${JSON.stringify(live.spend)} vs ${live.budgetTotal}`)
  }

  // The approved `cockpit-live` composition, asserted from the REAL payload before any
  // photograph is taken: one open question, one answered, two `dir:out` reports, three
  // `dir:in` steers (`page-cockpit.mjs`'s `inboxRail()`). A capture of the wrong world is
  // not evidence, and round 1's was exactly that (review round 2, B4).
  const detail = await waitForDetail(viewer, live.runId, 'the comp\'s inbox composition',
    (d) => (d.questions ?? []).filter((q) => !q.answered).length === 1
      && (d.questions ?? []).filter((q) => q.answered).length === 1
      && (d.mail ?? []).filter((m) => m.dir === 'out').length === 2
      && (d.mail ?? []).filter((m) => m.dir === 'in').length === 3, 60_000)
  log(`live inbox: ${(detail.questions ?? []).length} questions, `
    + `${(detail.mail ?? []).filter((m) => m.dir === 'out').length} reports, `
    + `${(detail.mail ?? []).filter((m) => m.dir === 'in').length} steers`)
}

/** Poll the REAL read API — the same listing Home renders — rather than guessing at
 *  on-disk shapes. `fetchRuns` is how this script knows a fixture reached its state. */
async function fetchRuns(viewer) {
  const res = await fetch(`http://127.0.0.1:${viewer.port}/api/runs?limit=200`, {
    headers: { authorization: `Bearer ${viewer.token}`, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GET /api/runs -> ${res.status}`)
  return (await res.json()).runs
}

/** `GET /api/runs/:id` — the same §6.2 payload the cockpit renders. */
async function fetchDetail(viewer, runId) {
  const res = await fetch(`http://127.0.0.1:${viewer.port}/api/runs/${runId}`, {
    headers: { authorization: `Bearer ${viewer.token}`, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GET /api/runs/${runId} -> ${res.status}`)
  return res.json()
}

/** Poll the run's own detail — needed where the listing's counts cannot tell two asks apart. */
async function waitForDetail(viewer, runId, label, predicate, timeoutMs) {
  const until = Date.now() + timeoutMs
  let last = null
  while (Date.now() < until) {
    last = await fetchDetail(viewer, runId)
    if (predicate(last)) return last
    await sleep(400)
  }
  throw new Error(`timed out waiting for ${label}; questions were ${JSON.stringify(
    (last?.questions ?? []).map((q) => [q.qid, q.answered]))}`)
}

async function waitFor(viewer, label, predicate, timeoutMs) {
  const until = Date.now() + timeoutMs
  let last = []
  while (Date.now() < until) {
    last = await fetchRuns(viewer)
    if (predicate(last)) return last
    await sleep(400)
  }
  throw new Error(`timed out waiting for ${label}; saw ${JSON.stringify(
    last.map((r) => [r.name, r.state, r.openQuestions]))}`)
}

const named = (runs, name) => runs.find((r) => r.name === name)

// ---- headless Chrome over CDP ---------------------------------------------------------

async function withChrome(fn) {
  const port = 9400 + Math.floor(Math.random() * 400)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cdp-'))
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' })

  const listTargets = () => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => {
      let body = ''
      r.on('data', (c) => { body += c })
      r.on('end', () => { try { res(JSON.parse(body)) } catch (err) { rej(err) } })
    }).on('error', rej)
  })

  let targets = null
  for (let i = 0; i < 100 && !targets; i++) {
    try { targets = await listTargets() } catch { await sleep(200) }
  }
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) }
  }
  await new Promise((r) => { ws.onopen = r })
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })

  try {
    await fn(send)
  } finally {
    ws.close()
    chrome.kill()
    // Chrome keeps writing to its profile for a moment after SIGTERM; a racing rm is
    // ENOTEMPTY, and losing a temp dir must never fail a capture that already succeeded.
    await sleep(500)
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* it is a temp dir */ }
  }
}

async function capture(send, { url, w, h, theme, out }) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 2, mobile: false,
  })
  await send('Page.navigate', { url })
  await sleep(3_000)
  // The theme toggle is the product's own (`d`), driven through localStorage exactly as
  // /boot-theme.js reads it — no injected CSS, no override.
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('flowition.theme', ${JSON.stringify(theme)});
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};`,
  })
  await sleep(700)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  log(`wrote ${path.relative(ROOT, out)} (${w}×${h}, ${theme})`)
}

/**
 * The §3.7 composition and the §2.4 shared axis, as the browser resolved them.
 *
 * Everything here is read with `getBoundingClientRect()` in CSS pixels — the same unit
 * §3.7's "run rail 280 │ main 840 │ inbox 320" is written in. A lane is FOCUSED first, so a
 * selected lane's track is measured too: the selection edge is exactly the kind of thing
 * that used to shrink the grid column its bars are positioned against.
 */
const MEASURE = `(() => {
  const box = (el) => (el ? { x: +el.getBoundingClientRect().x.toFixed(3),
                             w: +el.getBoundingClientRect().width.toFixed(3) } : null)
  const xs = (sel) => [...document.querySelectorAll(sel)]
    .map((e) => +e.getBoundingClientRect().x.toFixed(3))
  const selected = document.querySelector('.lane.sel .lane-track')
  const unselected = [...document.querySelectorAll('.lane')]
    .find((l) => !l.classList.contains('sel'))
  return {
    viewport: window.innerWidth,
    grid: {
      runRail: box(document.querySelector('.rail')),
      main: box(document.querySelector('.cockpit > .col.main')),
      inbox: box(document.querySelector('.cockpit > .col.inbox')),
      handles: [...document.querySelectorAll('.rail.collapsed, .cockpit > .col.strip')]
        .map((e) => +e.getBoundingClientRect().width.toFixed(3)),
    },
    order: [...document.querySelectorAll('.resume-card, .tabs')]
      .map((e) => (e.classList.contains('tabs') ? 'tabs' : 'resume-card')),
    // §3.7's side-by-side is a claim about WHAT IS ON THE SCREEN, not only about how wide
    // its columns are. These are the landmarks of the approved compositions — the inbox's
    // three registers with their counts, the tab that is active, the state chip, the budget
    // gauge's overshoot zone — read out of the rendered DOM so comps-captures.test.js can
    // assert the photograph depicts the right screen (review round 2, B4).
    landmarks: (() => {
      const inbox = document.querySelector('.col.inbox, .col.inbox.drawer')
      const text = (el) => (el ? el.textContent.trim() : null)
      const groupCount = (label) => {
        const group = [...document.querySelectorAll('.inbox-group')]
          .find((g) => text(g.querySelector('.lbl')) === label)
        return group ? text(group.querySelector('.count')) : null
      }
      return {
        inboxOpen: inbox != null,
        inboxHeaderCount: text(document.querySelector('.col.inbox > .sect .count')),
        // Below 900px the rail is a closed 44px handle; the comps' annotation 14 keeps the
        // open-question count ON the handle, so the question a closed rail hides is still
        // answerable at a glance.
        handleBadge: text(document.querySelector('.col.strip .dotn')),
        openQuestions: document.querySelectorAll('.qitem:not(.answered)').length,
        answeredQuestions: document.querySelectorAll('.qitem.answered').length,
        // The three registers, in the order §2.4 lists them, with their own counts.
        registers: [...document.querySelectorAll('.inbox-group .sect .lbl')].map((e) => text(e)),
        questionsCount: groupCount('questions'),
        reportsCount: groupCount('agent reports'),
        steersCount: groupCount('steering history'),
        // §7.2's answer composer, as W12 ships it. Until W12 landed, W11 rendered a NOTE
        // where the composer belongs and this landmark looked for that sentence; now the
        // photograph has to show the control itself. The capture viewer runs with
        // --control=answer,resume,cancel, so the composer is live here and send/delete
        // are the capabilities whose controls must render LOCKED — which is the §7.2
        // "never hidden, never enabled" rule, photographed rather than asserted in jsdom.
        composer: (() => {
          const input = inbox?.querySelector('.qitem:not(.answered) .ans-inp')
          if (!input) return 'absent'
          return input.disabled ? 'locked' : 'enabled'
        })(),
        lockChips: [...document.querySelectorAll('.lock-chip')].map((e) => text(e)),
        controlsChip: text(document.querySelector('.ro-chip')),
        // §7.2's lifecycle controls, as the browser resolved them: present either way, and
        // each carrying its own enabled/disabled verdict. A capability the viewer was not
        // started with must produce a DISABLED button here, never a missing one.
        lifecycleActions: [...document.querySelectorAll('.rhead-actions .btn')].map((b) => ({
          label: text(b),
          disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true',
        })),
        deliveryVerdicts: [...document.querySelectorAll('.mf .verdict')].map((e) => text(e)),
        activeTab: text([...document.querySelectorAll('[role="tab"]')]
          .find((t) => t.getAttribute('aria-selected') === 'true')),
        stateChip: text(document.querySelector('.rhead-top .chip')),
        // The budget gauge's hatched overshoot zone — §2.4's "soft ceiling", the live comp's
        // whole subject.
        budgetOvershoot: document.querySelector('.gauge-bar .over') != null,
        lanes: document.querySelectorAll('.lane').length,
        quietTags: document.querySelectorAll('.quiet-tag').length,
        lastLog: text(document.querySelector('.lastlog .trunc')),
        // §2.4's lineage strip, per segment: the class carries the attempt's FATE and the
        // title is the sentence the operator reads. Round 3's B1 was invisible to jsdom's
        // component tests only because nothing read the shipped screen's strip — a stale
        // run's last attempt was blue, growing through the wall clock, tooltipped "to now".
        lineage: [...document.querySelectorAll('.lineage .seg-l')].map((e) => ({
          cls: e.className,
          title: e.getAttribute('title'),
          // The measured width, so "fixed 44px hatch" is a fact of the browser's layout and
          // not merely of the inline style we asked for.
          w: +e.getBoundingClientRect().width.toFixed(3),
        })),
        // §13 Q4's disclosure: present, and CLOSED (args are read on a click, never on load).
        argsDisclosure: text(document.querySelector('.rhead-args > .btn')),
        argsPanelOpen: document.querySelector('.rhead-args .args-panel') != null,
      }
    })(),
    axis: {
      ruler: box(document.querySelector('.ruler .rule-track')),
      saturation: box(document.querySelector('.sat-plot')),
      lane: box(unselected ? unselected.querySelector('.lane-track') : null),
      laneSelected: box(selected),
      gridlines: box(document.querySelector('.lanes .gridlines .gl-track')),
      tickX: xs('.ruler .tk'),
      gridX: xs('.lanes .gridlines .gl'),
    },
  }
})()`

async function measure(send) {
  // Select a lane FIRST and let React commit, so `.lane.sel`'s track is measured too — the
  // selection edge is exactly the kind of thing that used to shrink the grid column the
  // bars are positioned against. Driven through §2.7's `j`, which is the product's own
  // path and does not depend on the headless window holding OS focus.
  await send('Runtime.evaluate', {
    expression: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))`,
  })
  await sleep(400)
  const result = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })
  if (result?.exceptionDetails) {
    throw new Error(`layout measurement threw: ${JSON.stringify(result.exceptionDetails)}`)
  }
  return result.result.value
}

// ---- main -----------------------------------------------------------------------------

function log(msg) { process.stdout.write(`  ${msg}\n`) }

// A SHORT home path: every run binds `<home>/runs/<runId>/control.sock`, and a unix
// socket path over ~104 bytes is EINVAL on macOS — os.tmpdir() there is deep enough to
// trip it, which fails the run before its first event.
const TMP = process.platform === 'darwin' ? '/tmp' : os.tmpdir()
const home = fs.mkdtempSync(path.join(TMP, 'flo-comp-'))
process.env.FLOWITION_HOME = home
let viewer = null
try {
  log(`fixture home: ${home}`)
  const { startViewer } = await import(path.join(ROOT, 'src', 'viewer', 'index.js'))
  viewer = await startViewer({ port: 0, control: 'answer,resume,cancel', primary: false })
  log(`viewer on 127.0.0.1:${viewer.port}`)
  await buildWorld(home, viewer)

  fs.mkdirSync(OUT, { recursive: true })
  // The two cockpit compositions §3.7 names, resolved to the run ids this world produced.
  const runs = await fetchRuns(viewer)
  const deep = (name) => {
    const run = named(runs, name)
    if (!run) throw new Error(`the fixture world has no run named ${name}`)
    // §2.2's hash grammar: `…/#/run/<id>?t=<token>`.
    return `${viewer.url.split('#')[0]}#/run/${run.runId}?t=${viewer.token}`
  }
  const SCREENS = [
    { screen: 'home', url: viewer.url },
    { screen: 'cockpit-live', url: deep('judge-panel-auth-refactor') },
    { screen: 'cockpit-stale', url: deep('audit-viewer-security') },
  ]

  const shots = []
  await withChrome(async (send) => {
    await send('Page.enable')
    for (const { w, h } of VIEWPORTS) {
      for (const theme of ['light', 'dark']) {
        for (const { screen, url } of SCREENS) {
          const file = `${screen === 'home' ? 'home' : screen}-built-${theme}-${w}.png`
          await capture(send, { url, w, h, theme, out: path.join(OUT, file) })
          // Measured on the same page, AFTER the shot: selecting a lane is part of the
          // measurement and must not appear in the comp photograph.
          const layout = screen === 'home' ? null : await measure(send)
          shots.push({ file, screen, viewport: w, height: h, theme, ...(layout ? { layout } : {}) })
        }
      }
    }
  })

  // The freshness manifest (see the header note). `dist` is the fingerprint that matters:
  // it is what `startViewer` served to Chrome, so it is what these PNGs are pictures of.
  const manifest = {
    note: 'Generated by docs/frontend/comps/capture-built.mjs. Enforced by test/comps-captures.test.js — do not hand-edit.',
    dist: treeSha256(path.join(ROOT, 'viewer', 'dist')),
    script: sha256File(fileURLToPath(import.meta.url)),
    deviceScaleFactor: 2,
    captures: shots.map((s) => ({ ...s, sha256: sha256File(path.join(OUT, s.file)) })),
  }
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  log(`wrote ${path.relative(ROOT, MANIFEST)} (dist ${manifest.dist.slice(0, 12)}…)`)
} finally {
  await viewer?.close?.().catch(() => {})
  // Kill anything still running in the throwaway home, then remove it.
  try {
    for (const dir of fs.readdirSync(path.join(home, 'runs'))) {
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(home, 'runs', dir, 'run.lock'), 'utf8'))
        if (lock?.pid) process.kill(lock.pid, 'SIGKILL')
      } catch { /* no lock, or already dead */ }
    }
  } catch { /* no runs dir */ }
  fs.rmSync(home, { recursive: true, force: true })
}
