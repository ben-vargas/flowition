// DESIGN §3.7's acceptance evidence, as a gate instead of a claim.
//
// §3.7: "The human reviewer approves the comps; W8/W11 acceptance then includes a
// side-by-side of built screens against the approved comps at those viewports." Two
// artifacts carry that: `docs/frontend/comps/built/*.png` (photographs of the real product,
// produced by `capture-built.mjs` against a REAL engine run and the COMMITTED `viewer/dist`)
// and `docs/frontend/comps/approvals.json` (the reviewer's ledger).
//
// This file exists because the first artifact rotted silently. W8b round 4 changed the
// stale attention card in `src/`, rebuilt `viewer/dist`, and left the captures alone — so
// the "side-by-side" was against a screenshot of copy that no longer existed anywhere, and
// every test stayed green because no test read the PNGs.
//
// A PNG cannot be reproduced byte-for-byte in a test (Chrome version, font rasterization
// and the fixture's own clock all move it), so the freshness check is over the INPUTS:
//   • `dist` — the exact bundle `startViewer` served to headless Chrome. Change the UI and
//     rebuild, and the captures no longer depict what ships. THIS IS THE ONE THAT BITES.
//   • `script` — the capture procedure itself: the fixture workflows, the viewport list,
//     the theme handoff. Change how the evidence is made and the old evidence is not it.
//   • each PNG's own hash, so a capture cannot be replaced by hand without the manifest.
//
// If this test fails, the fix is two commands (Chrome and Node >= 22 required):
//     npm --prefix viewer run build
//     node docs/frontend/comps/capture-built.mjs
// and commit `viewer/dist` and `docs/frontend/comps/built/` together.
//
// What it deliberately does NOT do is assert that a composition is approved. Approval is
// the human reviewer's act; a test that synthesized it would turn §3.7's gate into a
// formality, and a test that asserted it before the ruling exists would simply be red. What
// it CAN close — and what review round 5 found open — is every way the ledger could let the
// gate stay false quietly:
//
//   • `deferred` is gone as a status. It was the hatch: three of §3.7's eight compositions
//     were recorded as "not comped, not ours" against an invented owner (W8c) that appears
//     nowhere in DESIGN's delivery plan. All eight are now comped and owned by W8.
//   • `frame` must name a frame that ACTUALLY EXISTS in the comp file — asserted by finding
//     its <h2> caption verbatim. A ledger entry can no longer describe a composition nobody
//     drew; `frame: null` is now a test failure rather than a shrug.
//   • `owner` must be a unit from DESIGN §12's work-unit table. Inventing a lane to defer
//     work to is now mechanically impossible.
//   • `entryGate` must tell the truth: it may read PASSED only when every composition is
//     approved, and must otherwise state the exact number outstanding. So the gate's status
//     is a committed, checked fact rather than something a later round can assert in prose.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File, treeSha256 } from '../docs/frontend/comps/lib/fingerprint.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPS = path.join(ROOT, 'docs', 'frontend', 'comps')
const BUILT = path.join(COMPS, 'built')

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/**
 * §3.7's required evidence: **every composition whose screen is BUILT**, at both required
 * viewports, in both themes (§9.9).
 *
 * Round 1's review of W11 found this list naming Home alone while W11's four cockpit ledger
 * entries carried empty `builtCaptures` — so the capture test was green precisely because it
 * asked for nothing the unit had to produce. The rule is now structural instead: the list is
 * derived from the ledger below (`REQUIRED_STATES`), so a composition cannot be built
 * without its side-by-side evidence, and a lane cannot narrow the gate by editing an array.
 */
const BUILT_STATES = {
  'attention-heavy Home': 'home',
  'live cockpit with running Gantt': 'cockpit-live',
  'failed/stale cockpit': 'cockpit-stale',
}
const REQUIRED = Object.values(BUILT_STATES).flatMap((screen) => (
  [1440, 800].flatMap((w) => ['light', 'dark'].map((t) => `${screen}-built-${t}-${w}.png`))
))

const REBUILD = 'Regenerate:  npm --prefix viewer run build && node docs/frontend/comps/capture-built.mjs'

test('§3.7: the built-screen captures exist at both required viewports, in both themes', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  assert.deepEqual(
    manifest.captures.map((c) => c.file).sort(),
    [...REQUIRED].sort(),
    'the manifest must describe exactly the §3.7 captures for every BUILT composition — '
    + `${Object.keys(BUILT_STATES).join(', ')} — at 1440 and 800, light and dark`,
  )
  for (const capture of manifest.captures) {
    const file = path.join(BUILT, capture.file)
    assert.ok(fs.existsSync(file), `${capture.file} is missing. ${REBUILD}`)
    const bytes = fs.readFileSync(file)
    assert.ok(bytes.length > 1024, `${capture.file} is empty or truncated`)
    // A real PNG, not a placeholder or a text file with the right extension.
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${capture.file} is not a PNG`)
    assert.equal(
      sha256File(file), capture.sha256,
      `${capture.file} does not match the manifest — it was replaced by hand. ${REBUILD}`,
    )
  }
  // Both viewports §3.7 names, both themes §9.9 ships.
  assert.deepEqual([...new Set(manifest.captures.map((c) => c.viewport))].sort((a, b) => a - b), [800, 1440])
  assert.deepEqual([...new Set(manifest.captures.map((c) => c.theme))].sort(), ['dark', 'light'])
})

test('§3.7: the captures depict the viewer/dist that actually ships (§4.6)', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  // The same fingerprint the capture script recorded, recomputed from the committed tree.
  // `viewer/src/dist-freshness.test.ts` separately proves that tree is what the current
  // source builds, so the two together pin the captures to the current SOURCE.
  assert.equal(
    treeSha256(path.join(ROOT, 'viewer', 'dist')), manifest.dist,
    'the committed viewer/dist has changed since these captures were taken, so they are no '
    + `longer side-by-side evidence for §3.7 — they show a UI that no longer ships. ${REBUILD}`,
  )
})

/**
 * §3.7's cockpit grid and §2.4's shared Gantt axis, AS A REAL BROWSER RESOLVED THEM.
 *
 * These are the two findings review round 1 raised that no test in the repo could have
 * caught. The viewer suite runs in jsdom, which computes no layout: its "one axis" assertion
 * compared unresolved `grid-template-columns` DECLARATIONS and passed while live
 * measurement showed the lanes' track 2px narrower than the ruler's, because a 2px
 * selection border on `.lane` ate the grid column every bar is positioned against. The
 * composition failed the same way — 280px rail + 1160px main instead of 280/840/320 —
 * because the third column was never rendered and nothing measured it.
 *
 * `capture-built.mjs` now records `getBoundingClientRect()` for all of it, on the same page
 * and the same committed `dist` the PNGs are photographs of. Those numbers are asserted
 * here. The manifest is pinned to the dist fingerprint by the test above, so a UI change
 * that breaks the grid cannot leave a stale measurement standing.
 */
test('§3.7: the cockpit grid is 280 / 840 / 320 at 1440 and two 44px handles at 800', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  const measured = manifest.captures.filter((c) => c.layout)
  assert.equal(measured.length, 8,
    'every cockpit capture must carry a browser layout measurement. ' + REBUILD)

  for (const capture of measured) {
    const { grid } = capture.layout
    const where = capture.file
    if (capture.viewport >= 900) {
      // §3.7 verbatim: run rail 280 │ main 840 (min 640) │ inbox rail 320.
      assert.equal(grid.runRail?.w, 280, `${where}: run rail is ${grid.runRail?.w}px, not 280`)
      assert.equal(grid.main?.w, 840,
        `${where}: the main column is ${grid.main?.w}px, not 840 — §3.7's third column is `
        + 'missing, so the cockpit is a two-column screen')
      assert.equal(grid.inbox?.w, 320, `${where}: the inbox rail is ${grid.inbox?.w}px, not 320`)
      // …and they are adjacent, in that order, filling the viewport.
      assert.equal(grid.runRail.x, 0, `${where}: the run rail does not start at x=0`)
      assert.equal(grid.main.x, 280, `${where}: the main column does not follow the run rail`)
      assert.equal(grid.inbox.x, 1120, `${where}: the inbox rail does not follow the main column`)
    } else {
      // The comps' `cockpit-live-800` annotation 14, as ruled on: BOTH rails are 44px
      // drawer handles. One handle is the failure round 1 measured.
      assert.deepEqual(grid.handles, [44, 44],
        `${where}: ${grid.handles.length} drawer handle(s) at ${capture.viewport}px `
        + `(${grid.handles.join(', ')}) — §3.3 collapses BOTH rails below 900px`)
      assert.equal(grid.inbox, null, `${where}: the inbox rail is not a drawer below 900px`)
    }
  }
})

test('§2.4: the ruler, the saturation strip and the lanes are on ONE axis, measured', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  for (const capture of manifest.captures.filter((c) => c.layout)) {
    const { axis } = capture.layout
    const where = capture.file
    const boxes = Object.entries(axis)
      .filter(([key, value]) => value && !key.endsWith('X'))
    assert.ok(boxes.length >= 3,
      `${where}: only ${boxes.length} time-coordinate box(es) measured — the Gantt did not render`)

    // Every time-coordinate box: same left edge, same width. Percentages are measured
    // against these boxes, so a pixel of difference IS a time offset.
    const [, first] = boxes[0]
    for (const [name, box] of boxes) {
      assert.ok(Math.abs(box.x - first.x) < 0.05,
        `${where}: ${name} starts at x=${box.x}, the axis starts at x=${first.x}`)
      assert.ok(Math.abs(box.w - first.w) < 0.05,
        `${where}: ${name} is ${box.w}px wide, the axis is ${first.w}px — a border on a box `
        + 'the bars are positioned inside shrinks the grid column and offsets its time scale')
    }

    // …and the same time coordinate lands on the same pixel in both of the layers that
    // draw one: the ruler's ticks and the lanes' gridlines.
    assert.ok(axis.tickX.length > 0, `${where}: the ruler drew no ticks`)
    assert.deepEqual(axis.gridX, axis.tickX,
      `${where}: the ruler's ticks and the lanes' gridlines are at different x positions, so `
      + 'the two layers disagree about where a moment in the run is')
  }
})

/**
 * §3.7's side-by-side is a claim about WHAT IS ON THE SCREEN — and until round 2 nothing
 * tested that. The captures were checked for existence, hashes and geometry, so a cockpit
 * photographed against a world with no `ask()` and no mail passed every gate while its inbox
 * read "nothing open" where the approved `inboxRail()` composition has ONE OPEN QUESTION,
 * one answered question collapsed to its value, TWO agent reports (`mail dir:out`) and THREE
 * steering records (`dir:in`) (review round 2, B4).
 *
 * The capture script now seeds that world through the real control socket and reads the
 * landmarks back out of the rendered DOM; these assertions are what make the seeding a
 * requirement rather than a courtesy.
 */
const LIVE_INBOX = {
  headerCount: '1 open',
  openQuestions: 1,
  answeredQuestions: 1,
  questionsCount: '1 / 2',
  reportsCount: '2',
  steersCount: '3',
}

test('§3.7: the live cockpit capture depicts the APPROVED composition, not an empty inbox', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  const live = manifest.captures.filter((c) => c.screen === 'cockpit-live')
  assert.equal(live.length, 4, 'the live cockpit is captured at both viewports, both themes')

  for (const capture of live) {
    const marks = capture.layout?.landmarks
    const where = capture.file
    assert.ok(marks, `${where}: no landmark measurement. ${REBUILD}`)
    // The run is the one the comp is drawn of: live, over its soft ceiling, Timeline first.
    assert.equal(marks.stateChip, 'running', `${where}: the live comp's run is not running`)
    assert.equal(marks.budgetOvershoot, true,
      `${where}: no hatched overshoot zone — the live comp's whole subject is a run past its `
      + 'soft ceiling')
    assert.equal(marks.activeTab, 'Timeline', `${where}: Timeline is §3.7's default tab`)
    assert.ok(marks.lanes >= 4, `${where}: the Gantt drew ${marks.lanes} lanes`)

    if (capture.viewport >= 900) {
      // §2.4's three registers, in order, with the comp's own counts.
      assert.equal(marks.inboxOpen, true, `${where}: the inbox rail is not rendered`)
      assert.deepEqual(marks.registers, ['questions', 'agent reports', 'steering history'],
        `${where}: the inbox's registers are ${JSON.stringify(marks.registers)}`)
      assert.equal(marks.inboxHeaderCount, LIVE_INBOX.headerCount,
        `${where}: the inbox header reads "${marks.inboxHeaderCount}" — the approved `
        + 'composition has one OPEN question with the operator waiting on it')
      assert.equal(marks.openQuestions, LIVE_INBOX.openQuestions, `${where}: open questions`)
      assert.equal(marks.answeredQuestions, LIVE_INBOX.answeredQuestions,
        `${where}: the answered question, collapsed to its E7 answer value, is missing`)
      assert.equal(marks.questionsCount, LIVE_INBOX.questionsCount, `${where}: questions count`)
      assert.equal(marks.reportsCount, LIVE_INBOX.reportsCount,
        `${where}: ${marks.reportsCount} agent reports — the comp has two (mail dir:out)`)
      assert.equal(marks.steersCount, LIVE_INBOX.steersCount,
        `${where}: ${marks.steersCount} steering records — the comp has three (mail dir:in)`)
      // Every steer states a delivery verdict; a steer with none is the one thing §2.4 says
      // the register exists to show.
      assert.equal(marks.deliveryVerdicts.length, Number(LIVE_INBOX.steersCount),
        `${where}: ${marks.deliveryVerdicts.length} delivery verdicts for `
        + `${marks.steersCount} steers`)
      // §12 gives W12 the composer, and W12 has landed: the open question carries a REAL
      // one. The capture viewer is started with `--control=answer,resume,cancel`
      // (capture-built.mjs), so the composer must be ENABLED here — a locked composer in
      // this photograph would mean the §7.2 gate is reading the session wrong.
      assert.equal(marks.composer, 'enabled',
        `${where}: the open question's answer composer is ${marks.composer}`)
      // …and the capabilities that viewer did NOT enable (send, delete) are visible as
      // DISABLED controls rather than as absences — §7.2's "never hidden, never enabled" —
      // with the header chip saying so once for the whole screen.
      assert.equal(marks.controlsChip, 'controls partly locked',
        `${where}: the header chip reads ${JSON.stringify(marks.controlsChip)}`)
      const labels = marks.lifecycleActions.map((a) => a.label)
      for (const label of ['Cancel run', 'Delete', 'Result']) {
        assert.ok(labels.some((l) => l?.startsWith(label)),
          `${where}: the header action "${label}" is missing — controls are never hidden`)
      }
      const del = marks.lifecycleActions.find((a) => a.label?.startsWith('Delete'))
      assert.equal(del.disabled, true,
        `${where}: Delete is enabled on a viewer started without --control=delete`)
    } else {
      // The comps' annotation 14: a closed 44px handle that KEEPS the open-question count.
      assert.equal(marks.inboxOpen, false, `${where}: the rail is a drawer below 900px`)
      assert.equal(marks.handleBadge, '1',
        `${where}: the inbox handle's open-question badge reads ${JSON.stringify(marks.handleBadge)}`)
    }
  }
})

test('§3.7: the stale cockpit capture depicts a dead run with its agents\' last word', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  for (const capture of manifest.captures.filter((c) => c.screen === 'cockpit-stale')) {
    const marks = capture.layout?.landmarks
    const where = capture.file
    assert.ok(marks, `${where}: no landmark measurement. ${REBUILD}`)
    assert.equal(marks.stateChip, 'stale', `${where}: the stale comp's run is not stale`)
    assert.equal(marks.budgetOvershoot, false, `${where}: this run set no budget`)
    if (capture.viewport >= 900) {
      // The rail is open because the run HAS something in it — the report its first agent
      // sent before the engine died. That is also why §3.7's 280/840/320 holds here.
      assert.equal(marks.inboxOpen, true, `${where}: the inbox rail is not rendered`)
      assert.equal(marks.reportsCount, '1',
        `${where}: ${marks.reportsCount} agent reports — the dead run's own last word`)
      assert.equal(marks.openQuestions, 0, `${where}: a dead run has no open questions`)
    }
  }
})

/**
 * The comps' `cockpit-stale-800` annotation 18: the resume card is promoted ABOVE the tabs
 * at 800 — "the one place the narrow layout reorders rather than reflows, which the rest of
 * the comp set deliberately avoids". Round 1 found it promoted at EVERY viewport, which is a
 * different composition from the one the operator ruled on.
 */
test('§3.7: the stale run\'s resume card is promoted above the tabs only below 900px', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  for (const capture of manifest.captures.filter((c) => c.screen === 'cockpit-stale')) {
    const expected = capture.viewport >= 900 ? ['tabs', 'resume-card'] : ['resume-card', 'tabs']
    assert.deepEqual(capture.layout.order, expected,
      `${capture.file}: the resume card and the tab row are in the order `
      + `${JSON.stringify(capture.layout.order)}; at ${capture.viewport}px the ruled `
      + `composition is ${JSON.stringify(expected)}`)
  }
})

/**
 * §2.4 / review round 3 B1: the stale composition must not photograph a run whose last
 * attempt is still drawn as running.
 *
 * The header of this same screen says the time of death was never recorded, and the lineage
 * strip used to contradict it two rows below — a blue segment measured from `startedAt`
 * through `now`, tooltipped `→ now`, on a run the server had already called stale. jsdom can
 * assert the DOM; only the capture can prove the SHIPPED photograph does not carry the
 * false state, which is what round 3 found still committed.
 */
test('§2.4: the stale capture draws its last attempt as stale with an unknown end (B1)', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  const stale = manifest.captures.filter((c) => c.screen === 'cockpit-stale')
  assert.ok(stale.length, 'no stale cockpit captures in the manifest')
  for (const capture of stale) {
    const segments = capture.layout?.landmarks?.lineage
    const where = capture.file
    assert.ok(Array.isArray(segments) && segments.length,
      `${where}: no lineage landmark was measured. ${REBUILD}`)
    const last = segments[segments.length - 1]
    assert.match(last.cls, /\bstale\b/, `${where}: the last attempt is not drawn stale`)
    assert.doesNotMatch(last.cls, /\brunning\b/,
      `${where}: the last attempt of a STALE run is drawn as running — the same screen's `
      + 'header says no death time was recorded')
    assert.match(last.cls, /\bunknown-end\b/,
      `${where}: the last attempt claims a measured duration it cannot have`)
    assert.doesNotMatch(last.title, /→ now/,
      `${where}: the lineage tooltip reads "→ now" on a run that is not running`)
    assert.match(last.title, /time of death not recorded/,
      `${where}: the lineage does not state that the end is unrecorded`)
  }
})

/** The live composition is the control: there, a running last attempt IS the truth. */
test('§2.4: the live capture still draws its last attempt as running', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  for (const capture of manifest.captures.filter((c) => c.screen === 'cockpit-live')) {
    const segments = capture.layout?.landmarks?.lineage
    assert.ok(Array.isArray(segments) && segments.length,
      `${capture.file}: no lineage landmark was measured. ${REBUILD}`)
    const last = segments[segments.length - 1]
    assert.match(last.cls, /\brunning\b/,
      `${capture.file}: a live run's current attempt must read as running`)
    assert.doesNotMatch(last.cls, /\bunknown-end\b/,
      `${capture.file}: a live attempt's elapsed span is known — it is the header's clock`)
  }
})

/**
 * §13 Q4's disclosure exists on the shipped screen, and is CLOSED in the photograph: the
 * args request is made on a click and never on load, so a capture that showed the value
 * would be evidence of the defect rather than of the feature.
 */
test('§13 Q4: the live capture carries a closed "show args" disclosure', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  for (const capture of manifest.captures.filter((c) => c.screen === 'cockpit-live')) {
    const marks = capture.layout?.landmarks
    assert.equal(marks?.argsDisclosure, 'show args',
      `${capture.file}: no "show args" disclosure on a run launched with --args. ${REBUILD}`)
    assert.equal(marks?.argsPanelOpen, false,
      `${capture.file}: the args panel is open in a capture nobody clicked — args must be `
      + 'read on demand only (§5.6.5)')
  }
})

test('§3.7: the captures were taken by the capture script as it stands now', () => {
  const manifest = readJson(path.join(BUILT, 'captures.json'))
  assert.equal(
    sha256File(path.join(COMPS, 'capture-built.mjs')), manifest.script,
    'capture-built.mjs has changed since these captures were taken — the fixture world, the '
    + `viewports or the theme handoff may no longer be what the PNGs show. ${REBUILD}`,
  )
})

/** §3.7's four canonical states, verbatim. */
const STATES = [
  'attention-heavy Home',
  'live cockpit with running Gantt',
  'failed/stale cockpit',
  'two-panel transcript compare',
]
/** DESIGN §12's work-unit table. A comp cannot be owned by a lane that does not exist. */
const UNITS = new Set(['W8', 'W10', 'W11'])

test('§3.7: every state × viewport is comped, and each entry names a frame that exists', () => {
  const ledger = readJson(path.join(COMPS, 'approvals.json'))
  const html = new Map()
  const read = (file) => {
    if (!html.has(file)) html.set(file, fs.readFileSync(path.join(COMPS, file), 'utf8'))
    return html.get(file)
  }

  const seen = new Set()
  for (const entry of ledger.compositions) {
    assert.ok(STATES.includes(entry.state), `unknown §3.7 state: ${entry.state}`)
    assert.ok([1440, 800].includes(entry.viewport), `unknown §3.7 viewport: ${entry.viewport}`)
    // `deferred` is deliberately not a legal status — see the header note.
    assert.ok(['approved', 'pending'].includes(entry.status), `${entry.id}: bad status ${entry.status}`)
    assert.ok(UNITS.has(entry.owner),
      `${entry.id}: owner "${entry.owner}" is not a unit in DESIGN §12's delivery plan`)
    assert.ok(UNITS.has(entry.builtBy),
      `${entry.id}: builtBy "${entry.builtBy}" is not a unit in DESIGN §12's delivery plan`)
    assert.ok(fs.existsSync(path.join(COMPS, entry.comp)), `${entry.id}: comp ${entry.comp} is missing`)

    // THE COMPOSITION EXISTS. Not "is described in the ledger" — the frame's own caption is
    // in the comp file, so a ledger row cannot stand in for a drawing nobody made. This is
    // the assertion that replaces the `deferred` status: there is no longer any way to have
    // an entry for a composition that was never comped.
    assert.ok(typeof entry.frame === 'string' && entry.frame.length > 0,
      `${entry.id}: no frame named — §3.7 requires a comp, not a ledger row`)
    assert.ok(read(entry.comp).includes(`<h2>${entry.frame}</h2>`),
      `${entry.id}: ${entry.comp} has no frame captioned "${entry.frame}". `
      + 'Regenerate:  node docs/frontend/comps/generate.mjs')

    if (entry.status === 'approved') {
      // A ruling is attributable or it is not a ruling.
      assert.ok(entry.decidedBy, `${entry.id}: approved with no decidedBy`)
      assert.ok(entry.decidedIn, `${entry.id}: approved with no decidedIn`)
    } else {
      assert.ok(!entry.decidedBy, `${entry.id}: pending but carries a decidedBy`)
      assert.ok(Array.isArray(entry.decide) && entry.decide.length > 0,
        `${entry.id}: pending with nothing stated to rule on`)
      assert.ok(entry.howToApprove, `${entry.id}: pending with no route to a decision`)
      assert.ok(entry.blocks, `${entry.id}: pending without naming what it blocks`)
      assert.ok(entry.why, `${entry.id}: pending without stating why it is not yet ruled on`)
    }
    // Every capture an entry claims must exist, and every §3.7 pair appears exactly once.
    for (const rel of entry.builtCaptures ?? []) {
      assert.ok(fs.existsSync(path.join(COMPS, rel)), `${entry.id}: claims a missing capture ${rel}`)
    }

    // §3.7: "W8/W11 acceptance then includes A SIDE-BY-SIDE of built screens against the
    // approved comps at those viewports." A composition whose screen is BUILT therefore
    // carries the record of that comparison — what matched, and every difference with the
    // reason it is a difference. Round 1 shipped captures with no comparison recorded
    // anywhere, and the one that mattered (an empty inbox against an inbox with the
    // operator's whole work queue in it) went unnoticed for a round (review round 2, B4).
    //
    // Scoped to the compositions W11 built: W8's Home comparison predates this field and is
    // recorded in prose (`built/README.md`, "What differs from the comp, and why"), and a
    // test may not retroactively invalidate another lane's completed acceptance. Every
    // W11-built entry carries the structured record.
    if (entry.builtBy === 'W11' && (entry.builtCaptures ?? []).length > 0) {
      const sxs = entry.sideBySide
      assert.ok(sxs, `${entry.id}: has built captures and no sideBySide record — §3.7's `
        + 'acceptance is the comparison, not the screenshot')
      assert.ok(sxs.comparedIn && sxs.comparedBy && sxs.method,
        `${entry.id}: sideBySide must say when, by whom and how`)
      assert.ok(Array.isArray(sxs.matches) && sxs.matches.length > 0,
        `${entry.id}: sideBySide records no point of agreement`)
      assert.ok(Array.isArray(sxs.differences),
        `${entry.id}: sideBySide must list the differences — an empty array is a claim that `
        + 'there are none, and is allowed; a missing one is a comparison nobody did')
    }
    const pair = `${entry.state} @ ${entry.viewport}`
    assert.ok(!seen.has(pair), `duplicate ledger entry for ${pair}`)
    seen.add(pair)
  }
  for (const state of STATES) {
    for (const viewport of [1440, 800]) {
      assert.ok(seen.has(`${state} @ ${viewport}`),
        `§3.7 names "${state}" at ${viewport}px and the ledger does not mention it`)
    }
  }
})

/**
 * The HTML of one frame: from its `frame-wrap` to the next one. Frames are siblings in the
 * generated document, so this is exact rather than a heuristic.
 */
function frameHtml(html, caption) {
  const at = html.indexOf(`<h2>${caption}</h2>`)
  assert.ok(at > 0, `no frame captioned "${caption}"`)
  const start = html.lastIndexOf('<div class="frame-wrap"', at)
  const after = html.indexOf('<div class="frame-wrap"', at)
  return html.slice(start, after < 0 ? html.length : after)
}

const count = (haystack, needle) => haystack.split(needle).length - 1

/**
 * Split a frame into its transcript panes. Panes are siblings rooted at `class="col tp"`,
 * so slicing between successive markers gives each pane's OWN html — which is the whole
 * point: an assertion that counts strings across the frame reads the shared compare bar as
 * if it were pane content.
 */
function panes(frame) {
  const at = [...frame.matchAll(/<div class="col tp">/g)].map((m) => m.index)
  return at.map((start, i) => frame.slice(start, at[i + 1] ?? frame.length))
}

/**
 * §3.7 names "two-panel transcript compare" as a canonical state, and §2.5 spells out what
 * that means: "**Up to two panels side-by-side** (`?a=<m>` adds a compare panel)" — as
 * amended by the operator on 2026-07-30, scoped to **>=900px**, with the pair rendering as
 * a **stacked** pair below §3.3's 900px breakpoint. That amendment is the reason this test
 * expects a different layout per viewport rather than one layout everywhere; the amendment
 * itself is asserted below, so the expectation cannot be relaxed by editing this file alone.
 *
 * Round 5's ledger satisfied the gate test with a caption. The 1440 entry pointed at a
 * frame containing ONE transcript pane plus an "Open as 2nd panel" button, and the 800 one
 * at a tablist with one visible pane — a switcher. Both matched a string; neither was the
 * composition. So the required state is checked against the DRAWING.
 *
 * Round 6's replacement was still not enough, and review round 4 found both holes:
 *
 *   • It counted panel roots, headers and footers but never checked LAYOUT, so a vertical
 *     stack passed silently at a time when §2.5 said side-by-side at every viewport. Layout
 *     is now asserted from the panes container's `data-layout` AGAINST THE VIEWPORT, and the
 *     stylesheet is checked to make each layout real (two columns / one column and two
 *     rows), so the attribute cannot become a label for nothing.
 *   • Its "two distinct agents" check collected `aidx` labels from the WHOLE frame, and
 *     the compare bar names both agents by itself — so two identical panes would still have
 *     looked like agents 5 and 3. Identity is now read per pane.
 *
 * What did NOT change with the amendment, and is what this test mostly guards: the compare
 * is TWO WHOLE PANELS showing TWO DIFFERENT AGENTS at both viewports. A switcher is still a
 * failure; a stub second pane is still a failure. Only the axis moved.
 */
test('§3.7: the two-panel compare compositions render TWO panels, in the layout §2.5 specifies for their viewport', () => {
  const ledger = readJson(path.join(COMPS, 'approvals.json'))
  const entries = ledger.compositions.filter((c) => c.state === 'two-panel transcript compare')
  assert.equal(entries.length, 2, 'both required viewports must have an entry')

  const css = fs.readFileSync(path.join(COMPS, 'lib', 'css.mjs'), 'utf8')

  for (const entry of entries) {
    const html = frameHtml(fs.readFileSync(path.join(COMPS, entry.comp), 'utf8'), entry.frame)
    const where = `${entry.id} ("${entry.frame}")`
    const pair = panes(html)

    // Two transcript panel roots — the same class the single-panel frames use, so a stub
    // or a placeholder column cannot pass as one.
    assert.ok(pair.length >= 2,
      `${where}: renders ${pair.length} transcript panel(s); §2.5's compare is TWO`)

    // Two DIFFERENT agents, each read from ITS OWN pane. The compare bar names both agents,
    // so a frame-wide scan cannot tell a comparison from two copies of one panel.
    const identities = pair.map((pane, i) => {
      const m = /<span class="aidx">agent (\d+)<\/span>/.exec(pane)
      assert.ok(m, `${where}: pane ${i + 1} does not identify its agent inside its own header`)
      return m[1]
    })
    assert.equal(new Set(identities).size, identities.length,
      `${where}: panes show the same agent (${identities.join(', ')}) — that is one panel twice`)

    // Each pane is a whole panel: its own header row and its own footer.
    pair.forEach((pane, i) => {
      assert.ok(pane.includes('class="tp-head"'), `${where}: pane ${i + 1} is missing its header`)
      assert.ok(pane.includes('class="tp-foot"'), `${where}: pane ${i + 1} is missing its footer`)
    })

    // THE AXIS IS THE ONE §2.5 SPECIFIES FOR THIS VIEWPORT. Side-by-side at >=900px;
    // stacked below §3.3's 900px breakpoint, per the operator's 2026-07-30 amendment. A
    // lane may not swap one for the other — that is a spec change, not a layout note.
    const expected = entry.viewport >= 900 ? 'side-by-side' : 'stacked'
    const layout = /<div class="cmp-panes(?<cls>[^"]*)" data-layout="(?<mode>[^"]+)"/.exec(html)
    assert.ok(layout, `${where}: the pane container carries no data-layout — the composition is unstated`)
    assert.equal(layout.groups.mode, expected,
      `${where}: renders a "${layout.groups.mode}" pair at ${entry.viewport}px. §2.5 (as amended `
      + `2026-07-30) specifies "${expected}" there: side-by-side at >=900px, a stacked pair below `
      + '§3.3\'s 900px breakpoint. The other drawing may be kept as a labelled alternative, but '
      + 'the composition the gate rules on is the specified one until §2.5 is amended again.')
    // The class modifier and the attribute must agree, in both directions.
    assert.equal(/\bstack\b/.test(layout.groups.cls), expected === 'stacked',
      `${where}: data-layout="${expected}" and the stack class modifier disagree`)

    // …and the attribute has to mean something. The stylesheet must make each layout real,
    // so `data-layout` cannot become a label on the other one.
    const rule = /^\.cmp-panes\s*\{[^}]*\}/m.exec(css)
    assert.ok(rule, 'lib/css.mjs has no .cmp-panes rule')
    assert.match(rule[0], /grid-template-columns:\s*repeat\(2,/,
      '.cmp-panes must lay its two panes out in two columns — the attribute the test above '
      + 'reads is only as true as this rule')
    assert.match(rule[0], /--cmp-pane-min/,
      'the pair needs a per-pane minimum width, so a viewport too narrow for two panes '
      + 'scrolls horizontally instead of degrading into a switcher')
    if (expected === 'stacked') {
      const stackRule = /^\.cmp-panes\.stack\s*\{[^}]*\}/m.exec(css)
      assert.ok(stackRule, 'lib/css.mjs has no .cmp-panes.stack rule, so `data-layout="stacked"` '
        + 'is a label on a two-column grid')
      assert.match(stackRule[0], /grid-template-columns:\s*minmax\(0,\s*1fr\)/,
        'a stacked pair is ONE full-width column — otherwise it is still side by side')
      assert.match(stackRule[0], /grid-template-rows:\s*minmax\([^)]*\)\s*minmax\(/,
        'a stacked pair is TWO rows, both rendered. One row would be a switcher, which the '
        + 'amendment did not authorize')
      // The seam is load-bearing here: stacked, the two panes share a column, a width and an
      // edge, so a hairline between them lets one agent's rows read as the other's.
      assert.match(css, /\.cmp-panes\.stack\s*>\s*\.tp\s*\+\s*\.tp\s*\{[^}]*border-top:\s*2px[^}]*hairline-strong/,
        'the stacked pair needs a seam heavier than any rule inside a pane')
    }

    // …and the two idioms that stood in for the composition before are now failures.
    assert.ok(!/role="tablist"/.test(html),
      `${where}: a tablist shows one pane at a time — that is a switcher, not a comparison`)
    assert.ok(!/Open as 2nd panel/.test(html),
      `${where}: an "open a second panel" affordance is the state BEFORE the comparison`)
  }
})

/**
 * The test above expects a stacked pair below 900px. That expectation is only legitimate
 * because DESIGN §2.5 SAYS SO — the operator amended it on 2026-07-30 when ruling on the
 * §3.7 comp set, choosing the stacked drawing over the side-by-side one. Without this
 * check, a later lane could flip the comp back and edit one `expected` line to match, and
 * the spec and the comps would silently disagree again. So the amendment is asserted in
 * DESIGN itself: the comps are downstream of the spec, not the other way round.
 */
test('§2.5: the compare layout below 900px is amended in DESIGN, not just in the comps', () => {
  const design = fs.readFileSync(path.join(ROOT, 'docs', 'frontend', 'DESIGN.md'), 'utf8')
  const at = design.indexOf('### 2.5 Transcript panel')
  assert.ok(at > 0, 'DESIGN.md has no §2.5')
  const section = design.slice(at, design.indexOf('#### 2.5.1', at))

  // The original sentence stands — the amendment scopes it, it does not delete it.
  assert.match(section, /\*\*Up to two panels side-by-side\*\*/,
    '§2.5 must still specify a side-by-side pair; the amendment narrowed where it applies')
  assert.match(section, /OPERATOR AMENDMENT/,
    '§2.5\'s compare-layout amendment must be marked as an operator ruling, the way §16 marks '
    + 'its rulings — a spec change an implementation lane could have written is not a ruling')
  assert.match(section, /stacked pair/,
    '§2.5 must name the stacked pair as the below-900px composition')
  assert.match(section, /≥900px|>=900px/,
    '§2.5 must state the viewport above which side-by-side remains normative')
})

/**
 * §6.5 and the shipped Home agree that a stale run's time of death is usually UNKNOWN:
 * `endedAt` is written from a terminal `run` event and from nothing else (§6.2), and a run
 * is stale precisely because it wrote none. Review round 4 found the 800px stale cockpit
 * comp printing "died 26m ago" derived from the `run.lock` mtime — a file whose mtime dates
 * when the engine ACQUIRED the run. Approving that comp would have instructed W11 to
 * contradict both the live API and the screen W8 already shipped, so the claim is banned
 * from the comps rather than merely removed once.
 */
test('§6.5: no comp DRAWS a death time for a run that never recorded one', () => {
  // Scanned over the DRAWINGS, not the annotations. The annotation list at the foot of each
  // file records that the claim was made and withdrawn — that history is evidence, and a
  // check that forbade naming the old copy would delete the reason it is gone. What may not
  // survive is the claim inside a frame, where a reviewer reads it as the design.
  for (const file of ['home.html', 'cockpit.html', 'transcript.html', 'tokens.html']) {
    const full = fs.readFileSync(path.join(COMPS, file), 'utf8')
    const drawings = full.slice(0, full.indexOf('<div class="notes">') + 1 || full.length)
    for (const [re, why] of [
      [/died\s+\d+\s*[a-z]/i, 'draws a death time as a measured figure'],
      [/death time is the[^.<]*run\.lock/i, 'claims the run.lock mtime is a death time'],
    ]) {
      const hit = re.exec(drawings)
      assert.equal(hit?.[0], undefined,
        `${file} ${why} ("${hit?.[0]}"). A stale run has no endedAt (§6.2 — it is written from a `
        + 'terminal run event and from nothing else) and W6 exposes no lastSeenAt, so the comps '
        + 'must state the time of death as unknown. The built Home already does; a comp that did '
        + 'not would be instructing W11 to contradict the shipped screen.')
    }
  }
})

test('§3.7: the entry gate reports its own status honestly', () => {
  // The gate is a human act, so this test cannot assert that it passed. What it CAN assert
  // is that the repo does not claim it passed when it has not — the failure mode round 5
  // found, where prose and an invented owner made an unpassed gate look settled. `entryGate`
  // is the committed claim; this is the check on it.
  const ledger = readJson(path.join(COMPS, 'approvals.json'))
  const outstanding = ledger.compositions.filter((c) => c.status !== 'approved')
  assert.ok(typeof ledger.entryGate === 'string' && ledger.entryGate.length > 0,
    'approvals.json must carry an `entryGate` field stating whether §3.7\'s gate has passed')

  if (outstanding.length === 0) {
    assert.match(ledger.entryGate, /^PASSED\b/,
      'every composition is approved, so `entryGate` must read PASSED')
  } else {
    assert.match(ledger.entryGate, /^UNPASSED\b/,
      `${outstanding.length} composition(s) are unapproved (${outstanding.map((c) => c.id).join(', ')}), `
      + 'so `entryGate` must read UNPASSED. Approving a composition means editing its entry, '
      + 'not editing this sentence.')
    // …and the count in the sentence must be the real count, so it cannot silently rot as
    // rulings land one at a time.
    assert.match(ledger.entryGate, new RegExp(`\\b${outstanding.length} of ${ledger.compositions.length}\\b`),
      `\`entryGate\` must state the real tally — ${outstanding.length} of ${ledger.compositions.length} `
      + `are unapproved (${outstanding.map((c) => c.id).join(', ')})`)
  }
})

/**
 * The prose summary of the gate cannot disagree with the ledger (review round 3, M2).
 *
 * `built/README.md` carried two hand-written accounts of one machine-readable fact: a W11
 * section saying every cockpit composition matched its approved screen, and — four
 * paragraphs later — an "Approval status" section still declaring the gate UNPASSED with
 * four compositions pending and the W11 screens not yet built. Both were true once. The
 * summary is now GENERATED from `approvals.json` by `approvals-summary.mjs`, and this test
 * is the pin: the committed block must be exactly what the current ledger renders.
 */
test('§3.7: built/README.md\'s approval summary is the ledger, not a retelling of it', async () => {
  const { LEDGER, README, renderApprovalSummary, spliceReadme } =
    await import('../docs/frontend/comps/approvals-summary.mjs')
  const readme = fs.readFileSync(README, 'utf8')
  const expected = spliceReadme(readme, renderApprovalSummary(readJson(LEDGER)))
  assert.equal(readme, expected,
    'the approval summary in docs/frontend/comps/built/README.md no longer matches '
    + 'approvals.json. Regenerate it:\n'
    + '    node docs/frontend/comps/approvals-summary.mjs')

  // And nothing outside the generated block may state the gate's verdict — that is exactly
  // how the stale section survived: prose beside prose, neither one checked.
  const outside = readme.split('<!-- approvals:begin')[0] + readme.split('<!-- approvals:end -->')[1]
  assert.doesNotMatch(outside, /\bUNPASSED\b|gate is (PASSED|UNPASSED)/,
    'the gate\'s verdict is stated outside the generated block, where it can rot. State it '
    + 'in approvals.json\'s `entryGate` and let approvals-summary.mjs render it.')
})

test('§3.7: every committed capture belongs to a composition in the ledger', () => {
  const ledger = readJson(path.join(COMPS, 'approvals.json'))
  const claimed = new Set(ledger.compositions.flatMap((c) => c.builtCaptures ?? []))
  for (const file of REQUIRED) {
    assert.ok(claimed.has(`built/${file}`),
      `built/${file} is committed as acceptance evidence but no ledger entry claims it, so `
      + 'nothing says whether the composition it shows was ever approved')
  }
})
