// @vitest-environment jsdom
//
// §3.6's screen-reader clause, in the DOM — the half a `grep` for `aria-live` failed to find
// in the shipped build. Two levels are asserted here on purpose:
//
//   • the component's own contract (presence, politeness, throttled content updates), and
//   • that the TRANSCRIPT ROUTE actually mounts it. The shipped defect was not a broken
//     announcer, it was the absence of one, and only the composition test can catch that.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentView, RunDetail } from '../../api/types.js'
import { MockEventSource, MockEventSourceCtor } from '../../lib/mockEventSource.js'
import { MAX_ANNOUNCEMENT } from './frontier.js'
import { LiveFrontier } from './LiveFrontier.js'
import { TranscriptRoute, type TranscriptApi } from './Transcript.js'
import type { TimelineItem } from './types.js'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

beforeEach(() => {
  for (const [prop, value] of [['clientHeight', 600], ['offsetHeight', 600], ['offsetWidth', 800]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value })
  }
})

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    index: 3, key: 'k3', label: null, adapter: 'codex', model: 'gpt-test', effort: 'high',
    state: 'running', displayState: 'running', phaseIndex: null, phaseApproximate: false,
    path: null, promptPreview: 'prompt', resultPreview: null, error: null, errorCode: null,
    retryable: null, queuedAt: null, startedAt: 1, endedAt: null, waitMs: 0, stallMs: null,
    durationMs: 100, usage: { input: 1, output: 2, cost: 0 },
    attemptUsage: { input: 1, output: 2, cost: 0 }, liveTokens: null,
    cumTokens: { input: 1, output: 2 }, lastTool: null, lastOutputAt: 2, resultBytes: null,
    resultTruncated: false, toolIds: true, sessionId: 's3', attempts: 1, steers: [],
    cached: false,
    seededFrom: null,
    ...overrides,
  }
}

function detail(agents: AgentView[], overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: 'run-1', name: 'frontier fixture', workflowFile: '/tmp/w.js', state: 'running',
    liveDetail: null, createdAt: 1, startedAt: 1, endedAt: null,
    agentCounts: { total: agents.length, done: 0, failed: 0, running: agents.length, cached: 0 },
    adapters: ['codex'], spend: { input: 1, output: 2, cost: 0 }, budgetTotal: null,
    openQuestions: 0, resumeCount: 0, hasRunLog: false, defaults: null, hasArgs: false,
    engine: '0.1.2', concurrency: 2, declaredPhases: null, phases: [], agents,
    questions: [], mail: [], mailTotal: 0, logs: [], logTotal: 0, structure: null,
    saturation: [], offsets: { events: 0, journal: 0 },
    caps: {
      phaseAssociation: 'supported', structure: 'supported', queueEvents: 'supported',
      progress: 'supported', usageOnEvents: 'supported', mailIds: 'supported',
      attemptMarkers: 'supported',
    },
    attemptSpans: [{ state: 'started', t: 1 }],
    ...overrides,
  }
}

function dataApi(run: RunDetail, pages: Record<number, Record<string, unknown>[]>): TranscriptApi {
  return {
    runDetail: vi.fn(async () => run),
    agentPage: vi.fn(async (_runId, index) => {
      const records = pages[index] ?? []
      return {
        items: records.map((rec, i) => ({ o: (i + 1) * 100, rec })),
        start: 0,
        end: Math.max(0, records.length * 100),
        size: Math.max(0, records.length * 100),
        eof: true,
      }
    }),
    search: vi.fn(async () => ({ matches: [], truncated: false })),
  }
}

const tool = (name: string, id: string): TimelineItem => ({
  id, t: 1, o: 0, attempt: 1, kind: 'tool', card: 'generic', name, input: null,
  inputText: '', toolId: null, result: null, approximate: false, command: null, files: [],
})

const region = () => document.querySelector('[aria-live]') as HTMLElement | null

describe('§3.6 live region — the component', () => {
  it('is in the document before there is anything to announce, and is polite and atomic', () => {
    render(<LiveFrontier agent={agent()} live={false} latest={null} />)
    const live = region()!
    expect(live).toBeTruthy()
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.getAttribute('aria-atomic')).toBe('true')
    // A settled QUEUED agent has no outcome, so the region exists and says nothing —
    // which is the state assistive tech has to already be watching.
    expect(live.textContent).toBe('')
  })

  it('is visually hidden — this is a channel, not a second working indicator', () => {
    render(<LiveFrontier agent={agent()} live latest={tool('Bash', 'a')} />)
    expect(region()!.classList.contains('vh')).toBe(true)
  })

  it('announces the frontier immediately and summarizes, never dumping the stream', () => {
    render(<LiveFrontier agent={agent()} live latest={tool('Bash', 'a')} />)
    expect(region()!.textContent).toBe('agent 3: running Bash')
  })

  it('prefers the agent’s label over its index, as the rest of the UI does', () => {
    render(<LiveFrontier agent={agent({ label: 'builder' })} live latest={tool('Grep', 'a')} />)
    expect(region()!.textContent).toBe('builder: running Grep')
  })

  it('cuts a hostile label and tool name rather than reading them into the region', () => {
    // `label` is whatever string the workflow author passed to `agent({label})` and a tool's
    // `name` is the provider's own record. §3.6's region summarizes; it does not grow with
    // the data, and a 64 KiB label announced whole is the raw stream by another route.
    const huge = `sk-live-SECRET ${'z'.repeat(64 * 1024)}`
    render(
      <LiveFrontier agent={agent({ label: huge })} live latest={tool(huge, 'a')} />,
    )
    const said = region()!.textContent!
    expect(said.length).toBeLessThanOrEqual(MAX_ANNOUNCEMENT)
    // A label with nothing speakable in it still names the agent the operator can find.
    cleanup()
    render(<LiveFrontier agent={agent({ label: '\u200B\u200B' })} live latest={tool('Bash', 'a')} />)
    expect(region()!.textContent).toBe('agent 3: running Bash')
  })

  it('throttles a burst to one announcement per window and lands on the LAST one', async () => {
    vi.useFakeTimers()
    const view = render(<LiveFrontier agent={agent()} live latest={tool('Bash', 'a')} windowMs={5_000} />)
    expect(region()!.textContent).toBe('agent 3: running Bash')

    // Four more tools inside the window: the region must not move.
    for (const [name, id] of [['Read', 'b'], ['Grep', 'c'], ['Edit', 'd'], ['Write', 'e']] as const) {
      view.rerender(<LiveFrontier agent={agent()} live latest={tool(name, id)} windowMs={5_000} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(region()!.textContent).toBe('agent 3: running Bash')
    }

    // The window opens and exactly one of the four speaks — the newest.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(region()!.textContent).toBe('agent 3: running Write')
  })

  it('never speaks a status record’s text, however the secret arrives', async () => {
    // Status lines embed the provider's error string (src/engine.js:1073,
    // src/agent-proc.js:528) and 200 chars of a steer (src/agent-proc.js:143, 161, 245).
    // The region announces the CATEGORY, politely and throttled, and the secret never
    // appears in the accessibility tree at any point in the sequence.
    vi.useFakeTimers()
    const status = (text: string, id: string): TimelineItem =>
      ({ id, t: 1, o: 0, attempt: 1, kind: 'status', text })
    const secret = 'sk-live-SECRET-0xdeadbeef'
    const seen: string[] = []
    const record = () => { seen.push(region()!.textContent ?? '') }

    const view = render(
      <LiveFrontier
        agent={agent()} live
        latest={status(`error: 429 from provider, key ${secret}`, 'a')}
        windowMs={5_000}
      />,
    )
    const live = region()!
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('agent 3: provider error')
    record()

    // A second, different secret-bearing status inside the window: HELD, not spoken.
    view.rerender(
      <LiveFrontier
        agent={agent()} live
        latest={status(`mail dropped — agent already settled: steer ${secret}`, 'b')}
        windowMs={5_000}
      />,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(region()!.textContent).toBe('agent 3: provider error')
    record()

    // The window opens: one announcement, and it is the category of the newest line.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(region()!.textContent).toBe('agent 3: steer dropped')
    record()

    for (const text of seen) expect(text).not.toContain(secret)
    for (const text of seen) expect(text).not.toContain('sk-live')
    expect(document.body.textContent).not.toContain(secret)
  })

  it('announces a terminal state when the agent settles', async () => {
    vi.useFakeTimers()
    const view = render(<LiveFrontier agent={agent()} live latest={tool('Bash', 'a')} windowMs={5_000} />)
    expect(region()!.textContent).toBe('agent 3: running Bash')
    view.rerender(
      <LiveFrontier
        agent={agent({ state: 'failed', displayState: 'failed' })} live={false}
        latest={tool('Bash', 'a')} windowMs={5_000}
      />,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(region()!.textContent).toBe('agent 3: failed')
  })

  it('clears its pending timer on unmount rather than announcing into a dead tree', async () => {
    vi.useFakeTimers()
    const view = render(<LiveFrontier agent={agent()} live latest={tool('Bash', 'a')} windowMs={5_000} />)
    view.rerender(<LiveFrontier agent={agent()} live latest={tool('Read', 'b')} windowMs={5_000} />)
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(region()).toBeNull()
  })
})

describe('§3.6 live region — the transcript route mounts one', () => {
  it('renders exactly one aria-live=polite region per pane, announcing that pane’s frontier', async () => {
    // Real time still advances (the route's fetches must settle); only the 5 s window is
    // under the test's control.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const run = detail([agent(), agent({ index: 4, key: 'k4', label: 'second' })])
    render(
      <TranscriptRoute
        runId="run-1" agentIndex={3} compare={4}
        dataApi={dataApi(run, {
          3: [
            { t: 1, kind: 'meta', attempt: 1, prompt: 'alpha' },
            { t: 2, kind: 'tool', name: 'Bash', input: { command: 'ls' }, id: 'a' },
          ],
          4: [
            { t: 1, kind: 'meta', attempt: 1, prompt: 'beta' },
            { t: 2, kind: 'tool', name: 'Grep', input: { pattern: 'x' }, id: 'b' },
          ],
        })}
      />,
    )
    await screen.findByRole('heading', { name: 'agent 3' })
    await waitFor(() => {
      expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(2)
    })
    const read = () =>
      [...document.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent)
    // Before any record has arrived each pane says only that its agent is running — and the
    // tool that lands a moment later is HELD, because the window has not opened.
    expect(read()).toEqual(['agent 3: running', 'second: running'])
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
    expect(read()).toContain('agent 3: running Bash')
    expect(read()).toContain('second: running Grep')
  })

  it('announces the LIVE attempt while the operator reads an older one', async () => {
    // §3.6 asks for the transcript's LIVE frontier, and "live" is a property of the run — not
    // of what the operator happens to be reading. The shipped region was fed
    // `visibleItems.at(-1)`, which is filtered to the SELECTED attempt: open attempt 1 while
    // attempt 2 is running and the candidate stops changing, so the region announces attempt
    // 1's last activity and then goes silent on the only activity there is. That is the
    // sighted operator's spinner lying about which agent is working, for the one user who
    // cannot see the spinner.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    MockEventSource.reset()
    vi.stubGlobal('EventSource', MockEventSourceCtor)
    const run = detail([agent({ attempts: 2 })])
    render(
      <TranscriptRoute
        runId="run-1" agentIndex={3}
        dataApi={dataApi(run, {
          3: [
            { t: 1, kind: 'meta', attempt: 1, prompt: 'alpha' },
            { t: 2, kind: 'tool', name: 'Bash', input: { command: 'ls' }, id: 'a' },
            { t: 3, kind: 'attempt', n: 2 },
            { t: 4, kind: 'tool', name: 'Grep', input: { pattern: 'x' }, id: 'b' },
          ],
        })}
      />,
    )
    await screen.findByRole('heading', { name: 'agent 3' })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
    expect(region()!.textContent).toBe('agent 3: running Grep')

    // The operator opens attempt 1. The TRANSCRIPT follows the selection...
    const steps = document.querySelector('.attempt-steps') as HTMLElement
    fireEvent.click(within(steps).getByRole('button', { name: '1' }))
    await waitFor(() => expect(document.body.textContent).toContain('ls'))
    // ...and the live region does not: the frontier is still attempt 2's.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
    expect(region()!.textContent).toBe('agent 3: running Grep')

    // Now the running attempt does something new — a live agent frame, the way records
    // actually arrive (§5.6.3). The operator is still reading attempt 1.
    await act(async () => {
      MockEventSource.last.open()
      MockEventSource.last.batch(
        [{ s: 'a3', o: 500, r: { t: 5, kind: 'tool', name: 'Edit', input: { path: 'x.ts' }, id: 'c' } }],
        'v1;e=0;j=0;a3=500',
      )
      await vi.advanceTimersByTimeAsync(5_100)
    })
    expect(region()!.textContent).toBe('agent 3: running Edit')
    // The retained attempt-1 pane is unchanged — this fix moved the ANNOUNCEMENT, not the
    // transcript the operator asked to read.
    expect(document.body.textContent).toContain('ls')
  })

  it('keeps announcing after paging up evicts the live tail from the window', async () => {
    // The OTHER way the frontier stops being the run's. §9.3 bounds the retained window, and
    // paging up evicts from the NEWEST edge — `tailDetached`. From that moment the store
    // deliberately drops every live append (transcriptStore.ts `applyAppend`): the records do
    // not abut the retained span, and stitching them on would forge a contiguous window out
    // of two disjoint ones. A frontier read out of `snapshot.items` therefore FREEZES at the
    // instant of detachment and the region goes on announcing a tool that finished minutes
    // ago — with no attempt change involved, which is why the attempt test above cannot see
    // it. The store keeps the newest live record out of band for exactly this.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    MockEventSource.reset()
    vi.stubGlobal('EventSource', MockEventSourceCtor)
    const run = detail([agent()])

    // Offsets are chosen against the real §9.3 bound (8 MiB): the older page alone fits, the
    // two together do not, so `enforce('newest')` drops the tail chunk — the production path,
    // through the real store, with no test-only window size.
    const TAIL_START = 8_000_000
    const older = [
      { o: 4_000_000, rec: { t: 1, kind: 'meta', attempt: 1, prompt: 'alpha' } },
      { o: TAIL_START, rec: { t: 2, kind: 'tool', name: 'Bash', input: { command: 'ls' }, id: 'a' } },
    ]
    const tail = [
      { o: 8_200_000, rec: { t: 3, kind: 'tool', name: 'Grep', input: { pattern: 'x' }, id: 'b' } },
      { o: 8_500_000, rec: { t: 4, kind: 'tool', name: 'Read', input: { path: 'r.ts' }, id: 'c' } },
    ]
    const api: TranscriptApi = {
      runDetail: vi.fn(async () => run),
      agentPage: vi.fn(async (_runId, _index, options) => (
        options?.from === 'tail'
          ? { items: tail, start: TAIL_START, end: 8_500_000, size: 8_500_000, eof: true }
          : { items: older, start: 0, end: TAIL_START, size: 8_500_000, eof: false }
      )),
      search: vi.fn(async () => ({ matches: [], truncated: false })),
    }

    render(<TranscriptRoute runId="run-1" agentIndex={3} dataApi={api} />)
    await screen.findByRole('heading', { name: 'agent 3' })
    // Page up. `VirtualTimeline` asks for the older page whenever the body is within 80px of
    // its top — the operator's scroll, and in jsdom (`scrollTop` is 0 and unwritable by the
    // virtualizer) also the first metrics pass after mount. Either way it is the production
    // call, and the scroll below makes the intent explicit rather than relying on that.
    await act(async () => {
      fireEvent.scroll(document.querySelector('.tp-body')!)
      await vi.advanceTimersByTimeAsync(5_100)
    })
    // The window is now the historical page and the tail is gone — the pane says so.
    await screen.findByRole('button', { name: /live tail is outside this window/ })
    expect(document.body.textContent).toContain('ls')
    expect(document.body.textContent).not.toContain('r.ts')
    // The frontier is the newest record the STREAM has produced, and the tail page that was
    // fetched at mount carried it — `Read` at 8_500_000. Eviction took that record out of the
    // retained window, and it must NOT take it out of the announcement: no live frame has
    // arrived since the detach, so a frontier that only ever advanced from SSE would have
    // nothing to say and the region would regress to the historical window's `Bash`. That is
    // the §3.6 violation this assertion exists to catch — the announcement is independent of
    // the displayed window, including immediately after eviction and before any new frame.
    expect(region()!.textContent).toBe('agent 3: running Read')

    // The run keeps working. This frame lands past the retained span, so the window must NOT
    // take it — and §3.6's region must still say what the agent is doing.
    await act(async () => {
      MockEventSource.last.open()
      MockEventSource.last.batch(
        [{ s: 'a3', o: 9_000_000, r: { t: 5, kind: 'tool', name: 'Edit', input: { path: 'x.ts' }, id: 'd' } }],
        'v1;e=0;j=0;a3=9000000',
      )
      await vi.advanceTimersByTimeAsync(5_100)
    })
    expect(region()!.textContent).toBe('agent 3: running Edit')
    // The window the operator scrolled to is exactly where they left it: the historical page,
    // with neither the evicted tail nor the record that just arrived spliced into it.
    expect(document.body.textContent).toContain('ls')
    expect(document.body.textContent).not.toContain('x.ts')
    expect(document.body.textContent).not.toContain('r.ts')
    expect(screen.getByRole('button', { name: /live tail is outside this window/ })).toBeTruthy()
  })

  it('mounts the region on a SETTLED transcript too, so it is watched before it speaks', async () => {
    const run = detail(
      [agent({ state: 'done', displayState: 'done', endedAt: 9 })],
      { state: 'completed', endedAt: 9 },
    )
    render(
      <TranscriptRoute
        runId="run-1" agentIndex={3}
        dataApi={dataApi(run, { 3: [{ t: 1, kind: 'meta', attempt: 1, prompt: 'alpha' }] })}
      />,
    )
    await screen.findByRole('heading', { name: 'agent 3' })
    const live = document.querySelector('[aria-live="polite"]')!
    expect(live).toBeTruthy()
    expect(live.textContent).toBe('agent 3: done')
  })
})
