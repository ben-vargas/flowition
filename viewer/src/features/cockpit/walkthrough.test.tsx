// @vitest-environment jsdom
//
// The §13 operator-question walkthroughs. Each block is one question from §2.1's table,
// asked the way an operator asks it, and answered by reading the built screen — not by
// reading a model. A cockpit that renders every component and still cannot answer Q5 has
// passed every other test in this directory and failed the one that matters.
//
//   Q2  Is my run stuck, or just quiet?
//   Q4  Which agent is burning the budget?
//   Q5  How parallel was this actually? Where did the time go?
//   Q6  What is the shape of this run?
//   Q7  Why did resume re-run that agent?

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Cockpit } from './Cockpit.js'
import { RunHeader, attemptSegments } from './RunHeader.js'
import { deriveHonesty } from './honesty.js'
import { IconSprite } from '../../ui/Icon.js'
import {
  LEGACY_RUN, LIVE_RUN, NESTED_RUN, NOW, RESUMED_RUNNING, SPAN_MS, STALE_RUN, T0, fixedApi,
} from './fixtures.js'
import type { RunDetail } from '../../api/types.js'
import { ApiError } from '../../api/client.js'
import { resetRouteForTests } from '../../app/router.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.location.hash = '#/'
  resetRouteForTests()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const open = async (detail: RunDetail = LIVE_RUN) => {
  render(
    <>
      <IconSprite />
      <Cockpit runId={detail.runId} storeApi={fixedApi(detail)} />
    </>,
  )
  await screen.findByRole('tablist')
}

const laneFor = (label: string): HTMLElement => {
  const lane = [...document.querySelectorAll<HTMLElement>('.lane')]
    .find((l) => l.textContent?.includes(label))
  if (!lane) throw new Error(`no lane for ${label}`)
  return lane
}

const pct = (value: string): number => Number.parseFloat(value)

// The Agents table's rows are BUTTONS in a list (round 5, B2) — `role="row"` is only legal
// inside a table/grid/treegrid, so the old markup exposed a role that no assistive
// technology could act on. Structure is asserted by ROLE in the accessibility block at the
// foot of this file; these read the rows as the operator sees them.
const bodyRows = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.at-row:not(.head)')]
const rowFor = (label: string) => bodyRows().find((r) => r.textContent?.includes(label))!
/** The row as a screen reader receives it: one control, named in full by `rowLabel`. */
const nameFor = (label: string) => rowFor(label).getAttribute('aria-label') ?? ''

describe('Q2 — is my run stuck, or just quiet?', () => {
  it('answers on three independent rungs, all on screen at once', async () => {
    await open()
    // 1. the server's own liveness verdict, verbatim
    expect(screen.getByText('run.lock held by live pid 51204')).toBeTruthy()
    // 2. the per-agent quiet tag, measured from a REAL provider-output timestamp
    const quiet = laneFor('review:tests').querySelector('.quiet-tag')!
    expect(quiet.textContent).toContain('quiet for 6m18s')
    // 3. the log lane, one keystroke away, with the engine's own stall line in it
    fireEvent.keyDown(window, { key: 'l' })
    expect(screen.getByLabelText('Log lane').textContent)
      .toContain('no provider output for 6m — stall threshold 10m')
  })

  it('warns amber, not red — nothing has failed', async () => {
    await open()
    const quiet = laneFor('review:tests').querySelector('.quiet-tag')!
    // §3.2's amber is the stale token; the failed token is reserved for a real failure.
    expect(quiet.classList.contains('quiet-tag')).toBe(true)
    expect(laneFor('review:tests').querySelector('.badge.err')).toBeNull()
    // …and the agent that DID fail carries the error code instead.
    expect(laneFor('review:routes').querySelector('.badge.err')!.textContent).toBe('spawn_failed')
  })

  it('says the threshold is a guess when the engine emitted none (M10)', async () => {
    // With no emitted `stallMs` the threshold is the engine's own 30m default, so the
    // warning line sits at 15m — the fallback is strictly MORE conservative, never less.
    await open({
      ...LIVE_RUN,
      startedAt: T0 - 2_000_000,
      agents: LIVE_RUN.agents.map((a) => (a.index === 5
        ? { ...a, stallMs: null, startedAt: T0 - 2_000_000, lastOutputAt: T0 - 1_000_000 }
        : a)),
    })
    expect(laneFor('review:tests').querySelector('.quiet-tag')!.textContent)
      .toContain('(stall threshold unknown)')
  })

  it('never claims an agent is quiet on a run that has stopped', async () => {
    await open(STALE_RUN)
    expect(document.querySelector('.quiet-tag')).toBeNull()
  })
})

describe('Q4 — which agent is burning the budget?', () => {
  /**
   * §2.1 Q4 names three components, and round 3 shipped one of them. The table had no
   * bars and opened in index order, so an operator asking "who is burning the budget"
   * got a list ordered by when agents happened to be created — and the walkthrough
   * clicked `cost` itself before looking, so it could not see either gap (round 4, B2).
   */
  it('answers with all three: the gauge, the bars, and a cost-ordered table', async () => {
    await open()
    // 1. the run's own overshoot, on output tokens (critique M19)
    expect(document.querySelector('.gauge-cell')!.textContent).toContain('110.3%')
    expect(document.querySelector('.gauge-bar .over')).not.toBeNull()

    // 2. the table is ALREADY the answer when it opens — no click, no header hunting
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const order = bodyRows().map((r) => r.querySelector('.c-label')!.textContent!.trim())
    expect(order[0]).toContain('review:tests')
    expect(order[1]).toContain('review:docs')
    expect(order[2]).toContain('review:auth')
    expect(bodyRows()[0]!.querySelector('.c-cost')!.textContent).toBe('$3.20')
    // …and the header says so, so the ordering is legible rather than a coincidence — in
    // words, at the control's own accessible name. `aria-sort` is a `columnheader`
    // property and did nothing on a plain button (round 5, B2).
    const cost = screen.getByRole('button', { name: /^cost — sorted descending/ })
    expect(cost.getAttribute('aria-label'))
      .toBe('cost — sorted descending; activate to sort ascending')
    expect(cost.className).toContain('sorted')

    // 3. per-agent token bars, proportional to lifetime output burn
    const share = (label: string) =>
      Number(rowFor(label).querySelector('.tokbar')!.getAttribute('data-share'))
    expect(share('review:tests')).toBe(1)                        // 118.6k — the scale
    expect(share('review:docs')).toBeCloseTo(71_400 / 118_600, 4)
    expect(share('survey:auth')).toBeCloseTo(38_100 / 118_600, 4)
    // Geometry, not just data: the fill is drawn at the share it claims.
    const fill = rowFor('review:docs').querySelector<HTMLElement>('.tokbar .fill')!
    expect(Number.parseFloat(fill.style.width)).toBeCloseTo((71_400 / 118_600) * 100, 1)
    expect(Number.parseFloat(
      rowFor('review:tests').querySelector<HTMLElement>('.tokbar .fill')!.style.width,
    )).toBe(100)
  })

  it('measures the bars in LIFETIME tokens, so a resumed agent is not shrunk (B3)', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    // agent 5's adapter restarted its counter on the current attempt; the live figure is
    // 28.6k. Reading that as the burn would have made `review:docs` the tallest bar and
    // pointed the operator at the wrong agent.
    expect(rowFor('review:tests').querySelector('.c-output')!.textContent).toContain('119k')
    const share = (label: string) =>
      Number(rowFor(label).querySelector('.tokbar')!.getAttribute('data-share'))
    expect(share('review:tests')).toBeGreaterThan(share('review:docs'))
  })

  it('gives the bar no independent voice — the number carries the meaning', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const cell = rowFor('review:docs').querySelector('.c-output')!
    // §3.6: never shape alone. The bar is hidden, and its reading reaches a screen reader
    // as WORDS in the row's own accessible name. Round 4 put those words in a hidden span
    // INSIDE the row button, where the button's `aria-label` replaced them — present in the
    // DOM, absent from the accessibility tree (round 5, B2).
    expect(cell.querySelector('.tokbar')!.getAttribute('aria-hidden')).toBe('true')
    expect(cell.querySelector('.vh')).toBeNull()
    expect(nameFor('review:docs')).toContain('71.4k — 60% of the busiest agent')
    expect(cell.textContent).toContain('71.4k')
    // An agent that reported nothing gets no bar at all, and no fabricated 0% (#53).
    expect(rowFor('verify:auth').querySelector('.tokbar')).toBeNull()
  })

  /**
   * Parity #53 in the ACCESSIBILITY TREE (round 6, B2).
   *
   * §2.4: "Fields that are absent are omitted, never rendered as `0`/`—` fabrications."
   * Round 5 obeyed that in the cells and broke it in the reading — the same absent cost was
   * a blank on screen and "cost not reported" out loud — and the previous walkthrough
   * blessed the broken half by asserting the announcement. So this asserts the CONTRACT
   * against a row where the two rules meet: agent 8 reported no usage, no cost, no tool and
   * no duration, and it HAS been counted zero attempts and zero steers.
   */
  it('omits absent fields from the reading and announces the counts it knows', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const name = nameFor('verify:auth')

    // Absent: not spoken at all — an announcement of absence is the `—` this parity item
    // forbids, in words. (`/\boutput\b/` and friends: nothing about the row may mention
    // them, with or without a "not reported" tail.)
    for (const absent of [/\boutput\b/, /\binput\b/, /\bcost\b/, /\blast tool\b/, /\bduration\b/, /\bwait\b/]) {
      expect(name).not.toMatch(absent)
    }
    expect(name).not.toContain('not reported')

    // Known: a count the client HAS is announced, zero included — "0 attempts" is what a
    // queued agent means, and round 5 read it out as "attempts not reported".
    expect(name).toContain('0 attempts')
    expect(name).toContain('0 steers')
    // …and the cells agree with the reading rather than blanking the same zeros.
    expect(rowFor('verify:auth').querySelector('.c-attempts')!.textContent).toBe('0')
    expect(rowFor('verify:auth').querySelector('.c-steers')!.textContent).toBe('0')
    expect(rowFor('verify:auth').querySelector('.c-attempts .absent')).toBeNull()

    // The facts it DID record are still there — omission is not silence about everything.
    expect(name).toContain('agent 8, verify:auth, state queued')
    expect(name).toContain('adapter opencode, model qwen3-coder')
    expect(name).toContain('phase Review')

    // An agent with no `phase()` around it and no model reported drops those phrases too,
    // rather than announcing a hole the table draws as a blank cell.
    cleanup()
    await open(LEGACY_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const legacy = nameFor('agent 1')
    expect(legacy).not.toMatch(/\bmodel\b/)
    expect(legacy).not.toMatch(/\bphase\b/)
    expect(legacy).toContain('1 attempt,')
  })

  /**
   * §3.6's screen-reader contract for this table, tested through the accessibility tree
   * rather than through `textContent` (round 5, B2). Every assertion here reads a COMPUTED
   * accessible name or role: the previous round's checks passed against markup that
   * announced "agent 5 review:tests" and nothing else, because a button's `aria-label`
   * replaces its subtree — so Q4's answer existed on screen and not in the reading.
   */
  it('answers Q4 through the accessibility tree, not only through the pixels', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))

    // The table is a LIST of one button per row — no invalid `row` outside a table/grid.
    expect(screen.queryAllByRole('row')).toHaveLength(0)
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0)
    const list = screen.getByRole('list', { name: 'Agents' })
    const rows = within(list).getAllByRole('button')
    expect(rows).toHaveLength(LIVE_RUN.agents.length)

    // The busiest agent's row NAMES its burn, its share, its cost and its state.
    const busiest = within(list).getByRole('button', { name: /^agent 5, review:tests/ })
    const name = busiest.getAttribute('aria-label')!
    expect(name).toContain('state running')
    expect(name).toContain('output 119k — 100% of the busiest agent (live)')
    expect(name).toContain('cost $3.20')
    expect(name).toContain('input 403k')
    expect(name).toContain('adapter claude, model opus-5, effort xhigh')
    expect(name).toContain('phase Review')
    expect(name).toContain('2 attempts')

    // A failed agent's code and message are in the reading, not only in the cell.
    const failed = nameFor('review:routes')
    expect(failed).toContain('state failed')
    expect(failed).toContain('error spawn_failed')
    expect(failed).toContain('command not found')

    // Sorting is exposed on the control that performs it, and it UPDATES when it changes.
    const dur = screen.getByRole('button', { name: /^dur — not sorted/ })
    fireEvent.click(dur)
    expect(screen.getByRole('button', { name: /^dur — sorted descending/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^cost — not sorted/ })).toBeTruthy()
  })

  it('shows a running agent\'s tokens LIVE, and marks them as live', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const row = bodyRows().find((r) => r.textContent?.includes('review:tests'))!
    const out = row.querySelector('.c-output')!
    expect(out.textContent).toContain('119k')
    expect(out.querySelector('.live-dot')!.getAttribute('title')).toBe('live from usage-cum')
    // A settled agent is NOT marked live — the mark means "this number is still moving".
    const settled = bodyRows().find((r) => r.textContent?.includes('survey:auth'))!
    expect(settled.querySelector('.c-output .live-dot')).toBeNull()
  })

  it('never invents a price for an agent whose journal carried none (#114)', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const row = bodyRows().find((r) => r.textContent?.includes('verify:auth'))!
    expect(row.querySelector('.c-cost')!.textContent!.trim()).not.toContain('$')
  })
})

describe('Q5 — how parallel was this actually, and where did the time go?', () => {
  it('draws queue wait and execution to scale, on the same axis as the ruler', async () => {
    await open()
    const bar = laneFor('review:client').querySelector<HTMLElement>('.bar')!
    // Agent 6 was queued at 2m14s and ran 3m08s later, for 2m26s.
    expect(pct(bar.style.left)).toBeCloseTo((134_000 / SPAN_MS) * 100, 1)
    expect(pct(bar.style.width)).toBeCloseTo((334_000 / SPAN_MS) * 100, 1)
    const wait = bar.querySelector<HTMLElement>('.wait')!
    expect(pct(wait.style.width)).toBeCloseTo((188 / 334) * 100, 1)

    // The ruler, the saturation strip and every lane share ONE grid template, which is
    // what makes "the same axis" a structural property rather than a coincidence.
    const templates = new Set(
      [...document.querySelectorAll('.ruler, .sat-wrap, .lane')]
        .map((el) => getComputedStyle(el).gridTemplateColumns),
    )
    expect(templates.size).toBe(1)
  })

  it('states the saturation conclusion in words, not only as a shape', async () => {
    await open()
    const sat = screen.getByLabelText('Concurrency saturation')
    expect(sat.textContent).toContain('--concurrency 2')
    expect(sat.textContent).toMatch(/at the ceiling for 13m\d+s of 14m2s/)
    expect(sat.textContent).toContain('up to 3 agents queued')
    expect(sat.textContent).toContain('raising')
    expect(sat.textContent).toContain('to 5 would have emptied the queue')
  })

  it('keeps queue depth on its own rail rather than stacking it on the ceiling', async () => {
    await open()
    const sat = screen.getByLabelText('Concurrency saturation')
    expect(sat.querySelector('.sat-plot .ceil')).not.toBeNull()
    expect(sat.querySelectorAll('.sat-rail .qd').length).toBeGreaterThan(0)
    // The rail is a sibling of the plot, so nothing can bury the ceiling rule.
    expect(sat.querySelector('.sat-plot .qd')).toBeNull()
  })

  it('zooms without rescaling the trace — the bars keep their percentages', async () => {
    await open()
    const before = laneFor('review:client').querySelector<HTMLElement>('.bar')!.style.width
    fireEvent.click(screen.getByRole('button', { name: '1s' }))
    await waitFor(() => {
      expect(document.querySelector('.tl-plot')!.classList.contains('fixed')).toBe(true)
    })
    const after = laneFor('review:client').querySelector<HTMLElement>('.bar')!.style.width
    expect(after).toBe(before)
    // Only the track's pixel width moved, and it moved for all three components at once.
    expect((document.querySelector('.tl-plot') as HTMLElement).style.getPropertyValue('--track-px'))
      .toBe(`${Math.round(SPAN_MS / 1000)}px`)
  })

  it('marks a cache hit as a mark, never as a duration it did not spend', async () => {
    await open()
    const lane = laneFor('survey:tests')
    expect(lane.querySelector('.bar.tick')).not.toBeNull()
    expect(lane.querySelector('.bar-meta')!.textContent).toContain('replay')
  })

  it('opens the transcript from a bar — the most-used path in the product', async () => {
    await open()
    fireEvent.click(laneFor('review:tests'))
    expect(window.location.hash).toBe('#/run/r_2f91c4a8/agent/5')
  })
})

describe('Q6 — what is the shape of this run?', () => {
  it('renders the container shape from the fanout paths, not a tree of names', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    const dag = document.querySelector('.dag')!
    expect(dag.textContent).toContain('parallel(3)')
    expect(dag.textContent).toContain('pipeline(5 × 2)')
    expect(dag.textContent).toContain('7 of 10 slots materialised')
    expect(dag.querySelectorAll('.pipe-row')).toHaveLength(5)
    expect(dag.querySelectorAll('.pipe-head .lbl')).toHaveLength(2)
  })

  it('gives every empty cell an honest, SPECIFIC reason', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    const dag = document.querySelector('.dag')!
    expect(dag.textContent).toContain('skipped — stage 0 failed')
    expect(dag.textContent).toContain('not created — stage 0 still running')
    // A dash would have collapsed a permanent outcome and a pending one into one glyph.
    expect([...dag.querySelectorAll('.achip.empty')].every((c) => c.textContent!.trim().length > 3))
      .toBe(true)
  })

  it('shows a declared-but-unreached phase as a dimmed pending node', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    const pending = document.querySelector('.node.pending')!
    expect(pending.textContent).toContain('Report')
    expect(pending.textContent).toContain('declared in meta.phases, not yet reached')
  })

  it('draws a nested fan-out INSIDE the stage that declared it', async () => {
    await open(NESTED_RUN)
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    const dag = document.querySelector('.dag')!
    // One top-level card, and the nested one is a DESCENDANT of it — not a sibling.
    const tops = [...dag.children].filter((c) => c.classList.contains('node'))
    expect(tops).toHaveLength(1)
    expect(tops[0]!.textContent).toContain('pipeline(2 × 2)')
    const nested = dag.querySelector('.node.nested')!
    expect(nested.textContent).toContain('parallel(2)')
    expect(tops[0]!.contains(nested)).toBe(true)

    // …and it sits in item 0 / stage 0's own grid cell, whose agents run inside it.
    // `:scope >` matters: the nested card has cells of its own.
    const cells = [...dag.querySelectorAll('.pipe-row')[0]!.querySelectorAll(':scope > .cell')]
    const stage0 = cells[0]!
    expect(stage0.contains(nested)).toBe(true)
    expect(nested.textContent).toContain('shard:a')
    expect(nested.textContent).toContain('shard:b')
    // The cell it lives in is NOT reported as empty — and the NEXT stage, which really has
    // not been created, still gets its specific reason from the nested fan's evidence.
    expect(stage0.querySelector('.achip.empty')).toBeNull()
    expect(cells[1]!.querySelector('.achip.empty')!.textContent)
      .toContain('not created — stage 0 still running')
    // The pipeline counts the nested cell as materialised.
    expect(dag.textContent).toContain('2 of 4 slots materialised')
  })

  it('rolls up state and cost on each container header', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    const heads = document.querySelectorAll('.node > .nhead')
    expect(heads[0]!.textContent).toContain('$1.25')
    expect(heads[1]!.textContent).toContain('mixed')
  })
})

describe('Q7 — why did resume re-run that agent?', () => {
  it('shows the run\'s attempt lineage, one segment per attempt, coloured by its fate', async () => {
    await open()
    const lineage = screen.getByLabelText('Run attempts')
    const segments = within(lineage).getAllByRole('radio')
    expect(segments).toHaveLength(2)
    expect(segments[0]!.className).toContain('interrupted')
    expect(segments[1]!.className).toContain('running')
    expect(document.querySelector('.lineage-row .cap')!.textContent)
      .toContain('2 attempts · resumed ×1')
  })

  it('is a SELECTOR over §6.4 step 1a\'s attempt scopes, with the resume timestamps on it', async () => {
    await open()
    const segments = within(screen.getByLabelText('Run attempts')).getAllByRole('radio')
    // Each segment names when that attempt started and how it ended — the resume timeline.
    expect(segments[0]!.getAttribute('aria-label')).toMatch(/attempt 1 of 2 · started .* · interrupted/)
    expect(segments[1]!.getAttribute('aria-label')).toMatch(/attempt 2 of 2 · resumed .* · running · current/)
    // It defaults to the CURRENT attempt — the run you came to look at.
    expect(segments[1]!.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('.lineage-row .cap')!.textContent)
      .toContain('showing attempt 2 (current)')
  })

  it('projects the SELECTED attempt\'s phases, logs and mail into the cockpit', async () => {
    await open()
    // The current scope: `Review` reached, the current tail, five mail records.
    fireEvent.keyDown(window, { key: 'l' })
    expect(screen.getByLabelText('Log lane').textContent).toContain('drafting the docs section…')
    expect(screen.getByLabelText('Inbox').textContent).toContain('Also check the SSE endpoint')

    // Step back to attempt 1. A resume re-executes from the top, so these are DIFFERENT
    // phase/log/mail records for the same run — unreachable without this control.
    const segments = within(screen.getByLabelText('Run attempts')).getAllByRole('radio')
    fireEvent.click(segments[0]!)
    await waitFor(() => {
      expect(screen.getByLabelText('Log lane').textContent)
        .toContain('first attempt interrupted — SIGINT')
    })
    expect(screen.getByLabelText('Log lane').textContent).not.toContain('drafting the docs section…')
    expect(screen.getByLabelText('Inbox').textContent).toContain('Start with the token handoff.')
    expect(screen.getByLabelText('Inbox').textContent).not.toContain('Also check the SSE endpoint')
    expect(document.querySelector('.lastlog')!.textContent).toContain('first attempt interrupted')

    // …and the phase tree is the earlier attempt's: it entered a `Bootstrap` phase the
    // resumed attempt never did. (`meta.phases` is declared once for the run and agents are
    // not scoped — §6.4 step 1a — so the OBSERVED phase events are the difference.)
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    fireEvent.click(screen.getByRole('button', { name: /Phases/ }))
    const titles = () => [...document.querySelectorAll('.phead .pn')].map((h) => h.textContent)
    expect(titles()).toContain('Bootstrap')

    // The way back is one click, and the cap says where you are.
    expect(document.querySelector('.lineage-row .cap')!.textContent).toContain('showing attempt 1')
    fireEvent.click(screen.getByRole('button', { name: /back to current/ }))
    await waitFor(() => {
      expect(document.querySelector('.lineage-row .cap')!.textContent).toContain('(current)')
    })
    expect(titles()).not.toContain('Bootstrap')
  })

  it('offers no selector on a run with a single attempt', async () => {
    await open(STALE_RUN)
    const lineage = screen.getByLabelText('Run attempts')
    expect(within(lineage).queryAllByRole('radio')).toHaveLength(0)
    expect(within(lineage).getAllByRole('listitem')).toHaveLength(1)
  })

  // Round 2 fixed only the attempt a RESUME closed. The trailing one still came out blue,
  // growing through `now`, on a run the server had already called stale — two rows under a
  // header that says the time of death was never recorded (review round 3, B1).
  it('never draws a stale run\'s last attempt as still running (B1)', async () => {
    await open(STALE_RUN)
    const [segment] = within(screen.getByLabelText('Run attempts')).getAllByRole('listitem')
    // The fate is the run's own — §2.4: each segment is coloured by its terminal fate.
    expect(segment!.className).toContain('stale')
    expect(segment!.className).not.toContain('running')
    // …drawn at a fixed width, because the duration is not a fact anything on disk carries.
    expect(segment!.className).toContain('unknown-end')
    expect(segment!.getAttribute('style')).toContain('44px')

    const title = segment!.getAttribute('title')!
    expect(title).not.toContain('→ now')
    expect(title).toContain('time of death not recorded')
    expect(title).toContain('duration is unknown')

    // And the strip agrees with the two cells beside it rather than contradicting them.
    expect(document.querySelector('.rhead-metrics')!.textContent).toContain('not recorded')
  })

  it('folds the trailing attempt from the RUN STATE, which the spans cannot supply', () => {
    const spans = STALE_RUN.attemptSpans!
    // The same span list, folded twice. It is identical in both calls — a `started` with
    // nothing after it — so anything that distinguishes them comes from `deriveRunState`,
    // which is the only reader of the `run.lock` (§6.2).
    const alive = attemptSegments(spans, NOW, STALE_RUN.createdAt,
      deriveHonesty({ ...STALE_RUN, state: 'running' }, { now: NOW }))
    expect(alive[0]!.state).toBe('running')
    expect(alive[0]!.unknownEnd).toBe(false)
    expect(alive[0]!.ms).toBe(NOW - spans[0]!.t)

    const dead = attemptSegments(spans, NOW, STALE_RUN.createdAt,
      deriveHonesty(STALE_RUN, { now: NOW }))
    expect(dead[0]!.state).toBe('stale')
    expect(dead[0]!.unknownEnd).toBe(true)
    expect(dead[0]!.endedAt).toBe(null)
    // Zero, not "now minus start": a width computed through `now` is the defect itself.
    expect(dead[0]!.ms).toBe(0)
  })

  it('shows the per-agent attempt count beside it', async () => {
    await open()
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    const row = bodyRows().find((r) => r.textContent?.includes('review:tests'))!
    const attempts = row.querySelector('.c-attempts')!
    expect(attempts.textContent).toBe('2')
    expect(attempts.getAttribute('title')).toBe('2 execution attempts')
    // …and a cached agent carries the replay badge that explains why it did NOT re-run.
    const cached = bodyRows().find((r) => r.textContent?.includes('survey:tests'))!
    expect(within(cached).getByText('replay')).toBeTruthy()
  })

  // Round 1 left the unterminated attempt OPEN: it drew across the attempt that replaced it,
  // in the running colour, labelled "→ now". Q7 asks what happened on each attempt and got a
  // false fate and a fabricated duration (review round 2, B7).
  it('closes a stale attempt at the resume instead of running it through now', async () => {
    // `started` → `resumed`, with no terminal event in between: the engine died.
    await open(RESUMED_RUNNING)
    const segments = within(screen.getByLabelText('Run attempts')).getAllByRole('radio')
    expect(segments).toHaveLength(2)

    // The dead attempt is STALE, not running, and it stops where the next one starts.
    expect(segments[0]!.className).toContain('stale')
    expect(segments[0]!.className).not.toContain('running')
    const label = segments[0]!.getAttribute('aria-label')!
    expect(label).not.toContain('→ now')
    expect(label).toContain('time of death not recorded')
    expect(label).toContain('this span ends at the resume')

    // The two segments do not overlap: attempt 1's width is the 10m it can be shown to have
    // been alive, and attempt 2 owns everything after the resume.
    const model = attemptSegments(RESUMED_RUNNING.attemptSpans!, NOW, RESUMED_RUNNING.createdAt)
    expect(model[0]!.endedAt).toBe(T0)
    expect(model[0]!.ms).toBe(600_000)
    expect(model[0]!.closedByResume).toBe(true)
    expect(model[1]!.startedAt).toBe(T0)
    expect(model[0]!.endedAt!).toBeLessThanOrEqual(model[1]!.startedAt)
    // …and only ONE segment is still running: the current one.
    expect(model.filter((s) => s.state === 'running')).toHaveLength(1)
  })

  it('renders a terminal-without-start attempt as a hatched stub (N14)', async () => {
    await open({
      ...LIVE_RUN,
      attemptSpans: [{ state: 'failed', t: T0 + 400 }],
      resumeCount: 0,
    })
    const segments = within(screen.getByLabelText('Run attempts')).getAllByRole('listitem')
    expect(segments).toHaveLength(1)
    expect(segments[0]!.className).toContain('stub')
    expect(segments[0]!.getAttribute('title')).toContain('never started')
  })
})

describe('the resume affordance actually resumes (§7.3)', () => {
  const header = (props: Record<string, unknown> = {}) => render(
    <>
      <IconSprite />
      <RunHeader
        detail={STALE_RUN} now={NOW} capabilities={['resume']}
        logOpen={false} onToggleLog={() => {}}
        {...props}
      />
    </>,
  )

  it('POSTs once armed, and reports "launch accepted" rather than "it is back"', async () => {
    const resumeFn = vi.fn(async () => ({
      runId: STALE_RUN.runId, launchAccepted: true, mode: 'resume' as const, from: 'stale' as const,
    }))
    const onRefresh = vi.fn()
    header({ resumeFn, onRefresh })
    fireEvent.click(screen.getByRole('button', { name: /^Resume$/ }))
    fireEvent.click(screen.getByRole('button', { name: /Resume audit-viewer-security\?/ }))
    await waitFor(() => expect(resumeFn).toHaveBeenCalledWith('r_77c1be92'))
    // The listing is what proves it took; the button re-polls rather than pretending.
    expect(onRefresh).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Resume/ }).getAttribute('title'))
        .toContain('Launch accepted')
    })
  })

  /**
   * The run rail switches runs WITHOUT remounting the cockpit (§2.2), so React reuses this
   * control across the change. Round 1's armed state survived it: a confirmation armed for
   * run A became a live launch button for run B, and the second click resumed a run the
   * operator never confirmed (review round 2, B8).
   */
  it('disarms when the rail switches runs between arming and confirming', async () => {
    const resumeFn = vi.fn(async () => ({
      runId: 'x', launchAccepted: true, mode: 'resume' as const, from: 'stale' as const,
    }))
    const other: RunDetail = { ...STALE_RUN, runId: 'r_other001', name: 'some-other-run' }
    const view = header({ resumeFn })
    fireEvent.click(screen.getByRole('button', { name: /^Resume$/ }))
    expect(screen.getByRole('button', { name: /Resume audit-viewer-security\?/ })).toBeTruthy()

    // The operator clicks a different run in the rail. Same component, different run.
    view.rerender(
      <>
        <IconSprite />
        <RunHeader
          detail={other} now={NOW} capabilities={['resume']}
          logOpen={false} onToggleLog={() => {}} resumeFn={resumeFn}
        />
      </>,
    )
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Keep it stopped/ })).toBeNull()
    })
    expect(screen.queryByRole('button', { name: /Resume audit-viewer-security\?/ })).toBeNull()
    // The one click that is now available only ARMS — against the run actually on screen.
    fireEvent.click(screen.getByRole('button', { name: /^Resume$/ }))
    expect(resumeFn).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Resume some-other-run\?/ })).toBeTruthy()
  })

  it('disarms when the session\'s capability set changes underneath it', async () => {
    const resumeFn = vi.fn(async () => ({
      runId: 'x', launchAccepted: true, mode: 'resume' as const, from: 'stale' as const,
    }))
    const view = header({ resumeFn })
    fireEvent.click(screen.getByRole('button', { name: /^Resume$/ }))
    expect(screen.getByRole('button', { name: /Keep it stopped/ })).toBeTruthy()
    view.rerender(
      <>
        <IconSprite />
        <RunHeader
          detail={STALE_RUN} now={NOW} capabilities={[]}
          logOpen={false} onToggleLog={() => {}} resumeFn={resumeFn}
        />
      </>,
    )
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Keep it stopped/ })).toBeNull()
    })
    expect(resumeFn).not.toHaveBeenCalled()
  })

  it('surfaces the server\'s refusal verbatim instead of swallowing it', async () => {
    const resumeFn = vi.fn(async () => { throw new ApiError(409, 'conflict', 'run is live') })
    header({ resumeFn })
    fireEvent.click(screen.getByRole('button', { name: /^Resume$/ }))
    fireEvent.click(screen.getByRole('button', { name: /Resume audit-viewer-security\?/ }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Resume/ }).getAttribute('title'))
        .toBe('run is live')
    })
  })
})
