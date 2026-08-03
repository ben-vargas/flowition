// @vitest-environment jsdom
//
// §2.6 as a SCREEN. The tree's caps are proved in `tree.test.ts`; this file proves every
// branch of the route's contract renders the thing §2.6 names, and — the point of the
// exercise — that none of them renders a placeholder.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResultPayload, RunDetail } from '../../api/types.js'
import { MAX_STATUS_DISPLAY, ResultRoute, displayStatus } from './Result.js'
import { IconSprite } from '../../ui/Icon.js'
import { ControlProvider } from '../control/ControlProvider.js'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => {
  window.history.replaceState(null, '', '/#/run/run-1/result')
})

function detail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: 'run-1', name: 'result fixture', workflowFile: '/tmp/w.js', state: 'completed',
    liveDetail: null, createdAt: 1, startedAt: 1, endedAt: 9,
    agentCounts: { total: 1, done: 1, failed: 0, running: 0, cached: 0 },
    adapters: ['mock'], spend: { input: 1, output: 2, cost: 0 }, budgetTotal: null,
    openQuestions: 0, resumeCount: 0, hasRunLog: false, defaults: null, hasArgs: false,
    engine: '0.1.2', concurrency: 2, declaredPhases: null, phases: [], agents: [],
    questions: [], mail: [], mailTotal: 0, logs: [], logTotal: 0, structure: null,
    saturation: [], offsets: { events: 0, journal: 0 },
    caps: {
      phaseAssociation: 'supported', structure: 'supported', queueEvents: 'supported',
      progress: 'supported', usageOnEvents: 'supported', mailIds: 'supported',
      attemptMarkers: 'supported',
    },
    attemptSpans: [{ state: 'started', t: 1 }],
    graphDynamic: false,
    ...overrides,
  }
}

function api(payload: ResultPayload, run: RunDetail = detail()) {
  return {
    runResult: vi.fn(async () => payload),
    runDetail: vi.fn(async () => run),
  } as unknown as Parameters<typeof ResultRoute>[0]['dataApi']
}

/**
 * THE READY SIGNAL, and the only one this file may use.
 *
 * `<h1>Result</h1>` is NOT it. Result.tsx:229 renders that heading on first paint, while
 * everything worth asserting on — the frame, the error block, Resume, the value — is gated
 * behind the unresolved `runResult` promise (:234 paints a skeleton in the interim). So
 * `await findByRole('heading', …)` could be satisfied by a tree that contains nothing else,
 * and the synchronous `document.querySelector('.res-frame')` on the next line returned
 * `null`. That is why the suite failed about one run in five: whether the payload
 * microtask landed inside the heading's first poll depends on how the other 71 files are
 * being scheduled around it, which is precisely the configuration the release gate runs.
 *
 * The fix is not a retry — it is that the signal is now DERIVED FROM THE SAME STATE the
 * assertions read. `Body` renders `.res-frame` on every one of its branches (Result.tsx:283,
 * :303, :332, :358), so once it exists the payload has landed and the rest of the tree is
 * in the same commit. There is no window left in which the await can succeed and the query
 * can fail. A test that expects NO payload (the failed-read banner below) waits on its own
 * state instead and must not call this.
 */
async function settled(): Promise<HTMLElement> {
  await screen.findByRole('heading', { name: 'Result', level: 1 })
  return await waitFor(() => {
    const frame = document.querySelector<HTMLElement>('.res-frame')
    if (!frame) throw new Error('the result payload has not rendered a frame yet')
    return frame
  })
}

/** Renders the route and returns only once {@link settled} says the payload is on screen. */
const mount = async (
  payload: ResultPayload,
  { run = detail(), capabilities = ['resume'] as string[] | null, downloadFn = vi.fn(async () => ({ bytes: 1, filename: 'run-1.result.json' })) } = {},
) => {
  const view = render(
    <ControlProvider capabilities={capabilities}>
      <IconSprite />
      <ResultRoute
        runId="run-1" capabilities={capabilities} dataApi={api(payload, run)}
        downloadFn={downloadFn as never}
      />
    </ControlProvider>,
  )
  await settled()
  return { view, downloadFn }
}

describe('§2.6 result view', () => {
  it('renders a string result as safe markdown, with a raw toggle', async () => {
    await mount({ runId: 'run-1', status: 'completed', resultBytes: 42, result: '# shipped\n\nall **good**' })
    const value = document.querySelector('.res-value')!
    // Markdown, not a JSON dump: the heading became an <h1> inside the prose.
    expect(value.querySelector('.prose h1')?.textContent).toBe('shipped')
    expect(value.querySelector('.prose strong')?.textContent).toBe('good')
    expect(value.querySelector('pre')).toBeNull()

    fireEvent.click(within(value as HTMLElement).getByRole('button', { name: 'Raw' }))
    const raw = document.querySelector('.res-value pre')!
    expect(raw.textContent).toBe('# shipped\n\nall **good**')
    expect(document.querySelector('.res-value .prose')).toBeNull()
  })

  it('puts a hostile string result through §9.7’s hardened renderer, not into the DOM', async () => {
    await mount({ status: 'completed', result: 'hello <img src=x onerror="boom()"> there' })
    const value = document.querySelector('.res-value') as HTMLElement
    // §9.7/§16.2: raw HTML is DROPPED by the renderer, so there is no element and no
    // attribute — not an escaped one, none. Asserted by walking attributes rather than by
    // reading `innerHTML`, which `src/ui/no-innerhtml.test.ts` forbids anywhere under
    // `viewer/src` — including here, and rightly: its allowlist is empty on purpose.
    expect(value.querySelector('img')).toBeNull()
    const attrs = [...value.querySelectorAll('*')]
      .flatMap((node) => [...node.attributes].map((a) => a.name))
    expect(attrs.filter((name) => name.startsWith('on'))).toEqual([])
    // And the raw toggle still shows the operator the bytes the run actually produced,
    // as text, so nothing is hidden from them by the hardening.
    fireEvent.click(within(value).getByRole('button', { name: 'Raw' }))
    expect(document.querySelector('.res-value pre')!.textContent)
      .toBe('hello <img src=x onerror="boom()"> there')
    expect(document.querySelector('.res-value img')).toBeNull()
  })

  it('renders an object result as the §2.6 tree, collapsible, with copy-subtree', async () => {
    await mount({
      status: 'completed', resultBytes: 120,
      result: { shipped: true, files: ['a.ts', 'b.ts'], counts: { agents: 2 } },
    })
    const tree = document.querySelector('.res-value .jt')!
    expect(tree.getAttribute('role')).toBe('tree')
    expect(tree.textContent).toContain('shipped')
    expect(tree.textContent).toContain('a.ts')

    // Collapsing removes the children from the DOM entirely — not merely hides them.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse files' }))
    expect(document.querySelector('.res-value .jt')!.textContent).not.toContain('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Expand files' }))
    expect(document.querySelector('.res-value .jt')!.textContent).toContain('a.ts')

    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy files subtree' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('[\n  "a.ts",\n  "b.ts"\n]'))
  })

  it('flags the depth cap on the container it cut and keeps the raw download reachable', async () => {
    let deepValue: unknown = 'bottom'
    for (let i = 0; i < 40; i++) deepValue = { a: deepValue }
    const { downloadFn } = await mount({ status: 'completed', result: deepValue })
    // Open everything the tree has, then look for the cap marker.
    for (let i = 0; i < 40; i++) {
      const next = screen.queryAllByRole('button', { name: 'Expand a' })
      if (!next.length) break
      fireEvent.click(next[next.length - 1]!)
    }
    await waitFor(() => expect(document.querySelector('.jt .badge.warn')?.textContent).toBe('depth cap'))
    fireEvent.click(screen.getByRole('button', { name: /Download raw/ }))
    await waitFor(() => expect(downloadFn).toHaveBeenCalledWith('run-1'))
  })

  it('renders the bounded preview and the download when the value is over the 1 MiB cap', async () => {
    const { downloadFn } = await mount({
      status: 'completed', resultBytes: 4_194_304, resultTruncated: true,
      preview: '{"first":"64 KiB of it"',
    })
    expect(document.querySelector('.res-value pre')!.textContent).toBe('{"first":"64 KiB of it"')
    // It says it is a PREFIX, and does not pretend to be the value.
    expect(document.querySelector('.res-value')!.textContent).toContain('PREFIX')
    expect(document.querySelector('.res-value .jt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Download raw/ }))
    await waitFor(() => expect(downloadFn).toHaveBeenCalledWith('run-1'))
  })

  it('frames a failed run, shows its error prominently, and offers Resume', async () => {
    await mount(
      { status: 'failed', error: 'the workflow threw: boom' },
      { run: detail({ state: 'failed', endedAt: 9 }) },
    )
    expect(document.querySelector('.res-frame.failed')!.textContent).toContain('failed')
    const error = document.querySelector('.res-error')!
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('the workflow threw: boom')
    const resume = screen.getByRole('button', { name: 'Resume run' })
    expect(resume.getAttribute('aria-disabled')).toBe('false')
    // §7.2: it CONFIRMS, it does not resume.
    fireEvent.click(resume)
    await screen.findByRole('dialog')
  })

  it('frames an interrupted run without inventing the cause result.json does not record', async () => {
    // `interrupted` is written from `aborted` (src/engine.js:1331), and `abortRun` has TWO
    // callers: the SIGINT/SIGTERM handler and the control socket's whole-run `cancel`
    // (src/engine.js:709). An operator who pressed Cancel in the cockpit was being told
    // "its engine took a signal" — a cause the file does not carry and, here, a false one.
    await mount(
      { status: 'interrupted', error: 'run aborted' },
      { run: detail({ state: 'interrupted', endedAt: 9 }) },
    )
    const said = document.querySelector('.res-frame.failed')!.textContent!
    expect(said).toContain('interrupted')
    expect(said).toContain('stopped before returning a value')
    expect(said).not.toContain('took a signal')
    expect(said).not.toContain('workflow threw')
    // The cause the file DOES record is right below it, verbatim and unparaphrased.
    expect(document.querySelector('.res-error')!.textContent).toContain('run aborted')
  })

  it('says the same thing about a control-socket cancellation, because the file does', async () => {
    // The same `interrupted` word, a different cause, and no way for this screen to tell
    // them apart: `result.json` records the outcome and the message, never which caller
    // aborted the run. `cancel requested via control socket` is the engine's own text
    // (src/engine.js:709) — the screen shows it and names nothing itself.
    await mount(
      { status: 'interrupted', error: 'run aborted: cancel requested via control socket' },
      { run: detail({ state: 'interrupted', endedAt: 9 }) },
    )
    const said = document.querySelector('.res-frame.failed')!.textContent!
    expect(said).toContain('stopped before returning a value')
    expect(said).not.toContain('took a signal')
    expect(document.querySelector('.res-error')!.textContent)
      .toContain('cancel requested via control socket')
  })

  it('does not claim a throw for a failure that happened before the workflow ran', async () => {
    // `failed` is not proof the workflow threw. The engine writes it from the startup path
    // too — a control socket that will not bind (src/engine.js:737–740) and a workflow
    // module that will not load (src/engine.js:872) both `finalize({status: 'failed'})` with
    // the workflow function never entered. MCP/startup failures land here.
    await mount(
      { status: 'failed', error: 'control socket unavailable: mcp server "docs" exited during startup' },
      { run: detail({ state: 'failed', endedAt: 9 }) },
    )
    const said = document.querySelector('.res-frame.failed')!.textContent!
    expect(said).toContain('stopped before returning a value')
    expect(said).not.toContain('workflow threw')
    expect(said).not.toContain('took a signal')
    expect(document.querySelector('.res-error')!.textContent)
      .toContain('mcp server "docs" exited during startup')
    // Still §2.6's failed view: red rule, error prominent, Resume offered.
    expect(document.querySelector('.res-frame')!.classList.contains('failed')).toBe(true)
    expect(screen.getByRole('button', { name: 'Resume run' }).getAttribute('aria-disabled'))
      .toBe('false')
  })

  it('frames a cancelled run neutrally — not as a failure, not as a success', async () => {
    // This build's engine writes only `completed` and `failed` into result.json
    // (src/engine.js:743, 1322), so `cancelled` reaches this screen from an OLDER or a newer
    // one. §6.5 says such a file must degrade gracefully — and telling an operator who
    // stopped the run themselves that "the workflow threw" is not graceful, it is a cause
    // the screen invented. The COLOUR has to agree with the sentence: the shipped screen
    // painted the frame red while saying "nothing failed", and §3.2 gives `cancelled` an ink
    // mix (`--st-cancelled`), never the failure red.
    await mount(
      { status: 'cancelled', error: 'run aborted' },
      { run: detail({ state: 'interrupted', endedAt: 9 }) },
    )
    const frame = document.querySelector('.res-frame')!
    expect(frame.classList.contains('neutral')).toBe(true)
    expect(frame.classList.contains('failed')).toBe(false)
    expect(frame.classList.contains('ok')).toBe(false)
    const said = frame.textContent!
    expect(said).toContain('cancelled')
    expect(said).toContain('nothing failed')
    expect(said).not.toContain('The workflow threw')
    expect(said).not.toContain('took a signal')
    // ...and it still says nothing that implies a value came back.
    expect(said).not.toContain('The value below')
  })

  it('frames a status this build does not know neutrally, and claims nothing about it', async () => {
    // §5.4.5 forwards `result.json`'s `status` field verbatim, so the word is whatever engine
    // wrote the file. The shipped classification was binary — three known endings were red
    // and EVERYTHING ELSE was green — which turned every future status into a success and
    // told the operator "the value below is result.json as the engine wrote it" about a file
    // that carries only an error. §6.5: an unrecognized value is shown and claimed nothing
    // about.
    await mount(
      { status: 'aborted-by-fleet', error: 'the supervisor stopped this run' },
      { run: detail({ state: 'completed', endedAt: 9 }) },
    )
    const frame = document.querySelector('.res-frame')!
    expect(frame.classList.contains('neutral')).toBe(true)
    expect(frame.classList.contains('ok'), 'an unknown status must not be painted as success')
      .toBe(false)
    expect(frame.classList.contains('failed'), 'nor as a failure it did not earn').toBe(false)
    const said = frame.textContent!
    // The fact, and only the fact: the file says this word and this viewer does not know it.
    expect(said).toContain('aborted-by-fleet')
    expect(said).toContain('does not recognize')
    expect(said).not.toContain('The value below')
    expect(said).not.toContain('The workflow threw')
    expect(said).not.toContain('took a signal')
    // The error the file DOES carry is still shown — degrading neutrally is not degrading to
    // silence.
    expect(document.querySelector('.res-error')!.textContent)
      .toContain('the supervisor stopped this run')
  })

  it('bounds an unrecognized status for display and keeps the raw file one click away', async () => {
    // §5.4.5 forwards `result.json`'s `status` verbatim, so its LENGTH is the file's choice.
    // The header chip is `white-space: nowrap` with no shrink and the framing prose has no
    // break opportunity inside one long token, so an unbounded word rewrites the §3.3 layout
    // of a screen it is only a swatch on. `displayStatus` bounds and flattens it for display
    // ONLY: classification still reads the raw field, and **Download raw** still serves the
    // untouched file.
    const long = `aborted-by-the-fleet-supervisor-${'x'.repeat(400)}`
    const { downloadFn } = await mount(
      { status: `${long}‮\n​`, error: 'the supervisor stopped this run', result: 'partial output' },
      { run: detail({ state: 'completed', endedAt: 9 }) },
    )

    const chip = document.querySelector('.res-head .chip')!
    expect(chip.textContent!.length).toBeLessThanOrEqual(MAX_STATUS_DISPLAY)
    expect(chip.textContent).toBe(`${long.slice(0, MAX_STATUS_DISPLAY - 1)}…`)
    // The bidi override, the newline and the zero-width space never reach the DOM: each of
    // them reshapes the row around the chip rather than filling it.
    expect(document.body.textContent).not.toContain('‮')
    expect(document.body.textContent).not.toContain('​')
    expect(document.body.textContent).not.toContain('\n' + '​')

    // The prose is bounded by the same rule, and says the shortening happened.
    const frame = document.querySelector('.res-frame')!
    expect(frame.classList.contains('neutral')).toBe(true)
    expect(frame.textContent).toContain('does not recognize')
    expect(frame.textContent).toContain('shown shortened')
    expect(frame.textContent).not.toContain('x'.repeat(MAX_STATUS_DISPLAY + 1))

    // …and the file itself is untouched and reachable.
    fireEvent.click(screen.getByRole('button', { name: /Download raw/ }))
    await waitFor(() => expect(downloadFn).toHaveBeenCalledWith('run-1'))
  })

  it('normalizes only what it PAINTS — a known status is never clipped into another one', () => {
    for (const known of ['completed', 'failed', 'interrupted', 'cancelled']) {
      expect(displayStatus(known)).toBe(known)
    }
    // A word that merely STARTS with a known one keeps its own identity: the clip appends an
    // ellipsis, so no long status can collapse onto a shorter word this build acts on.
    expect(displayStatus(`failed${'-'.repeat(80)}`)).not.toBe('failed')
    expect(displayStatus(`failed${'-'.repeat(80)}`).length).toBe(MAX_STATUS_DISPLAY)
    // Nothing speakable left, or not a string at all: the neutral word, never an empty chip.
    expect(displayStatus('​​')).toBe('unknown')
    expect(displayStatus(undefined)).toBe('unknown')
    // A surrogate pair is never split in half by the clip.
    const astral = '\u{1F600}'.repeat(40)
    const clipped = displayStatus(astral)
    expect([...clipped].every((ch) => ch === '\u{1F600}' || ch === '…')).toBe(true)
  })

  it('offers Resume on an unknown status only when the server’s state says the run stopped', async () => {
    // The word in the file is not evidence — `deriveRunState` refuses it (src/run-state.js:10,
    // 132) — but the run-detail request beside it is. A neutral frame is not a reason to
    // withhold the action §2.6 puts on this screen.
    await mount(
      { status: 'aborted-by-fleet', error: 'boom' },
      { run: detail({ state: 'failed', endedAt: 9 }) },
    )
    expect(screen.getByRole('button', { name: 'Resume run' }).getAttribute('aria-disabled'))
      .toBe('false')
    cleanup()

    // A completed run is not an ending without a value; its replay lives in the cockpit
    // (§7.3), so the unknown-status screen does not grow a second one.
    await mount(
      { status: 'aborted-by-fleet', error: 'boom' },
      { run: detail({ state: 'completed', endedAt: 9 }) },
    )
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull()
  })

  it('keeps `completed` — and only `completed` — on the success frame', async () => {
    await mount({ status: 'completed', result: { ok: true } })
    const frame = document.querySelector('.res-frame')!
    expect(frame.classList.contains('ok')).toBe(true)
    expect(frame.textContent).toContain('The value below')
  })

  it('keeps Resume operable when the run-detail request fails beside a failed result', async () => {
    // §2.6 requires the failed/interrupted view to offer Resume, and the payload this route
    // already has states the run's terminal status. The run-detail request beside it is a
    // SEPARATE fetch — a 500, a deleted journal, an aborted poll — and its failure is not
    // evidence about the run. Treating it as "state unknown" made a definitively failed run
    // unresumable; `graphSource: 'unavailable'` in the modal is the same partial failure
    // already being handled honestly one line away.
    for (const status of ['failed', 'interrupted']) {
      const partial = {
        runResult: vi.fn(async () => ({ status, error: 'boom' } as ResultPayload)),
        runDetail: vi.fn(async () => { throw new Error('journal.jsonl vanished') }),
      } as unknown as Parameters<typeof ResultRoute>[0]['dataApi']
      render(
        <ControlProvider capabilities={['resume']}>
          <IconSprite />
          <ResultRoute runId="run-1" capabilities={['resume']} dataApi={partial} />
        </ControlProvider>,
      )
      await settled()
      const resume = screen.getByRole('button', { name: 'Resume run' })
      expect(resume.getAttribute('aria-disabled'), `${status} must stay resumable`).toBe('false')
      expect(resume.getAttribute('title')).toBeNull()

      fireEvent.click(resume)
      const dialog = await screen.findByRole('dialog')
      // And the modal says only what it knows: the snapshot was not read, so it makes no
      // claim about the module graph.
      expect(dialog.querySelector('[data-fact="graph-unreadable"]')).toBeTruthy()
      expect(dialog.querySelector('[data-fact="graph-static"]')).toBeNull()
      cleanup()
    }
  })

  it('does not invent a resumable state from a status the server would refuse', async () => {
    // `deriveRunState` accepts completed/failed/interrupted from result.json and nothing else
    // (src/run-state.js:10, 132). A `cancelled` file with no readable detail therefore has no
    // state this viewer can honestly claim, and the button says so rather than launching a
    // request the server is certain to reject.
    const partial = {
      runResult: vi.fn(async () => ({ status: 'cancelled', error: 'boom' } as ResultPayload)),
      runDetail: vi.fn(async () => { throw new Error('journal.jsonl vanished') }),
    } as unknown as Parameters<typeof ResultRoute>[0]['dataApi']
    render(
      <ControlProvider capabilities={['resume']}>
        <IconSprite />
        <ResultRoute runId="run-1" capabilities={['resume']} dataApi={partial} />
      </ControlProvider>,
    )
    await settled()
    const resume = screen.getByRole('button', { name: 'Resume run' })
    expect(resume.getAttribute('aria-disabled')).toBe('true')
    expect(resume.getAttribute('title')).toContain('cannot be resumed')
  })

  it('disables Resume with §7.2’s lock chip on a read-only viewer', async () => {
    await mount(
      { status: 'failed', error: 'boom' },
      { run: detail({ state: 'failed' }), capabilities: [] },
    )
    const resume = screen.getByRole('button', { name: 'Resume run' })
    expect(resume.getAttribute('aria-disabled')).toBe('true')
    const chip = document.getElementById(resume.getAttribute('aria-describedby')!)!
    expect(chip.textContent).toContain('locked')
    expect(chip.textContent).toContain('--control=resume')
  })

  it('says "no result yet" with the live state, and never invents one', async () => {
    await mount(
      { pending: true, state: 'running' },
      { run: detail({ state: 'running', endedAt: null }) },
    )
    const frame = document.querySelector('.res-frame.pending')!
    expect(frame.textContent).toContain('No result yet')
    expect(frame.querySelector('.chip')!.textContent).toContain('running')
    expect(document.querySelector('.res-value')).toBeNull()
  })

  it('tells a stale run that nothing on disk will ever produce a result', async () => {
    await mount({ pending: true, state: 'stale' }, { run: detail({ state: 'stale' }) })
    expect(document.querySelector('.res-frame.pending')!.textContent)
      .toContain('the engine that owned this run is gone')
  })

  it('refuses to render anything from a corrupt result and offers the bytes', async () => {
    const { downloadFn } = await mount({ corrupt: true })
    expect(document.querySelector('.res-frame.failed')!.textContent)
      .toContain('does not parse')
    fireEvent.click(screen.getByRole('button', { name: /Download the bytes/ }))
    await waitFor(() => expect(downloadFn).toHaveBeenCalledWith('run-1'))
  })

  it('admits an absent value rather than printing null (§6.5)', async () => {
    await mount({ status: 'cancelled' }, { run: detail({ state: 'interrupted' }) })
    const text = document.querySelector('.result-screen')!.textContent!
    expect(text).toContain('No value was recorded')
    expect(document.querySelector('.res-value .jt')).toBeNull()
  })

  it('renders an explicit null result as a value, because the workflow returned one', async () => {
    await mount({ status: 'completed', result: null })
    expect(document.querySelector('.res-value .jt')!.textContent).toContain('null')
    expect(document.querySelector('.result-screen')!.textContent)
      .not.toContain('No value was recorded')
  })

  it('surfaces a failed read with a retry instead of a blank screen', async () => {
    const failing = {
      runResult: vi.fn(async () => { throw new Error('nope') }),
      runDetail: vi.fn(async () => detail()),
    } as unknown as Parameters<typeof ResultRoute>[0]['dataApi']
    render(<ResultRoute runId="run-1" dataApi={failing} />)
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('nope')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('never renders the W12 placeholder on any branch', async () => {
    for (const payload of [
      { status: 'completed', result: 'x' },
      { pending: true, state: 'running' },
      { corrupt: true },
      { status: 'failed', error: 'boom' },
    ] as ResultPayload[]) {
      await mount(payload)
      expect(document.body.textContent).not.toContain('lands in W12')
      cleanup()
    }
  })
})

describe('this file’s own ready signal', () => {
  it('never waits on the heading outside settled()', () => {
    // The gate that keeps the 1-in-5 flake from walking back in. `<h1>Result</h1>` paints
    // before the payload does, so awaiting it proves nothing about the tree the next line
    // queries — and the failure it produces is a null-dereference in a file that passes in
    // isolation, which is the most expensive kind of red there is. `settled()` above is the
    // single sanctioned place that name may appear.
    const source = readFileSync(resolve(process.cwd(), 'src/features/result/Result.test.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')       // the prose above explains the trap; it is not one
      .replace(/^\s*\/\/.*$/gm, '')
    const waits = [...source.matchAll(/findByRole\(\s*'heading'/g)]
    expect(waits, 'wait on settled(), not on the heading').toHaveLength(1)
    // …and the one that remains is inside settled(), which is declared before the first test.
    expect(waits[0]!.index).toBeGreaterThan(source.indexOf('async function settled'))
    expect(waits[0]!.index).toBeLessThan(source.indexOf('describe('))
  })
})
