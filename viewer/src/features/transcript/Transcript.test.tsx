// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentView, RunDetail } from '../../api/types.js'
import { TranscriptRoute, type TranscriptApi } from './Transcript.js'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 800,
  })
})

function agent(index: number, overrides: Partial<AgentView> = {}): AgentView {
  return {
    index,
    key: `key-${index}`,
    label: `worker ${index}`,
    adapter: 'codex',
    model: 'gpt-test',
    effort: 'high',
    state: 'running',
    displayState: 'running',
    phaseIndex: null,
    phaseApproximate: false,
    path: null,
    promptPreview: 'prompt',
    resultPreview: null,
    error: null,
    errorCode: null,
    retryable: null,
    queuedAt: null,
    startedAt: 1,
    endedAt: null,
    waitMs: 0,
    stallMs: null,
    durationMs: 100,
    usage: { input: 10, output: 20, cost: 0.01 },
    attemptUsage: { input: 10, output: 20, cost: 0.01 },
    liveTokens: null,
    cumTokens: { input: 10, output: 20 },
    lastTool: null,
    lastOutputAt: 2,
    resultBytes: null,
    resultTruncated: false,
    toolIds: true,
    sessionId: `session-${index}`,
    attempts: 1,
    steers: [],
    cached: false,
    seededFrom: null,
    ...overrides,
  }
}

function detail(agents: AgentView[], overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: 'run-1',
    name: 'Transcript fixture',
    workflowFile: '/tmp/workflow.js',
    state: 'running',
    liveDetail: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    agentCounts: { total: agents.length, done: 0, failed: 0, running: agents.length, cached: 0 },
    adapters: ['codex'],
    spend: { input: 20, output: 40, cost: 0.02 },
    budgetTotal: null,
    openQuestions: 0,
    resumeCount: 0,
    hasRunLog: false,
    defaults: null,
    hasArgs: false,
    engine: '0.1.2',
    concurrency: 2,
    declaredPhases: null,
    phases: [],
    agents,
    questions: [],
    mail: [],
    mailTotal: 0,
    logs: [],
    logTotal: 0,
    structure: null,
    saturation: [],
    offsets: { events: 0, journal: 0 },
    caps: {
      phaseAssociation: 'supported',
      structure: 'supported',
      queueEvents: 'supported',
      progress: 'supported',
      usageOnEvents: 'supported',
      mailIds: 'supported',
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

// This integration renders two virtual transcripts plus the full cockpit. In the complete
// suite, Node 18 GHA has measured the first test at 17.8s when green and 20.8–21.6s when
// the global 20s limit wins (for example Actions run 31758047258). Keep the extra headroom
// local to that deliberately heavier composition test; it is not a product performance gate.
const DOUBLE_PANE_COMPOSITION_TIMEOUT_MS = 40_000

describe('transcript route composition', () => {
  it('renders two live panes from one run snapshot and exposes the shared compare pin', async () => {
    const run = detail([agent(0), agent(1)])
    const records = {
      0: [
        { t: 1, kind: 'meta', attempt: 1, prompt: 'alpha' },
        { t: 2, kind: 'tool', name: 'Read', input: { path: 'a' }, id: 'a' },
        { t: 3, kind: 'tool-result', toolUseId: 'a', output: 'ok' },
      ],
      1: [
        { t: 1, kind: 'meta', attempt: 1, prompt: 'beta' },
        { t: 2, kind: 'tool', name: 'Read', input: { path: 'b' }, id: 'b' },
        { t: 3, kind: 'tool-result', toolUseId: 'b', output: 'ok' },
      ],
    }
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    const source = dataApi(run, records)
    const view = render(<TranscriptRoute runId="run-1" agentIndex={0} compare={1} dataApi={source} />)
    await screen.findByRole('heading', { name: 'worker 0' })
    expect(screen.getByRole('heading', { name: 'worker 1' })).toBeTruthy()
    expect(screen.getByRole('tablist', { name: 'Cockpit views' })).toBeTruthy()
    expect(view.container.querySelector('.agent-route-split')).toBeTruthy()
    expect(screen.getByRole('separator', { name: 'Resize transcript panel' })).toBeTruthy()
    expect(source.runDetail).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('.transcript-route.comparing')).toBeTruthy()
    expect(view.container.querySelectorAll('.tp')).toHaveLength(2)
    expect(screen.getByText('Pin a step in either panel to align both transcripts')).toBeTruthy()
    expect(screen.getAllByText('Working…')).toHaveLength(2)

    const pins = await screen.findAllByRole('button', { name: 'Pin both panes to this step' })
    scrollTo.mockClear()
    fireEvent.click(pins[0]!)
    expect(await screen.findByText(/pinned to/)).toBeTruthy()
    await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThanOrEqual(2))

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize transcript panel' }), { key: 'ArrowLeft' })
    expect(JSON.parse(localStorage.getItem('flowition.transcript.split.width')!)).toBe(584)
  }, DOUBLE_PANE_COMPOSITION_TIMEOUT_MS)

  it('selects execution attempts without conflating them with provider turns', async () => {
    const run = detail([agent(0, { attempts: 2 })])
    render(<TranscriptRoute runId="run-1" agentIndex={0} dataApi={dataApi(run, {
      0: [
        { t: 1, kind: 'meta', attempt: 1, prompt: 'first' },
        { t: 2, kind: 'text', text: 'one' },
        { t: 3, kind: 'attempt', n: 2 },
        { t: 3, kind: 'meta', attempt: 2, prompt: 'second' },
        { t: 4, kind: 'text', text: 'two' },
      ],
    })} />)
    await waitFor(() => expect(document.querySelector('.attempt-bar .lt')?.textContent).toContain('2 of 2'))
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    expect(document.querySelector('.attempt-bar .lt')?.textContent).toContain('1 of 2')
    expect(document.querySelector('.attempt-bar .lt')?.textContent).toContain('this attempt metrics are not exposed')
    expect(document.querySelector('.attempt-bar .lt')?.textContent).toContain('lifetime 20 out')
  })

  it('pins a failed-agent error card below the transcript and never shows working', async () => {
    const failed = agent(0, {
      state: 'failed',
      displayState: 'failed',
      error: 'provider exploded',
      errorCode: 'provider_error',
      retryable: true,
      endedAt: 10,
    })
    const run = detail([failed], {
      state: 'failed',
      endedAt: 10,
      agentCounts: { total: 1, done: 0, failed: 1, running: 0, cached: 0 },
    })
    const view = render(<TranscriptRoute runId="run-1" agentIndex={0} dataApi={dataApi(run, {
      0: [{ t: 1, kind: 'meta', attempt: 1, prompt: 'fail' }, { t: 2, kind: 'text', text: 'last word' }],
    })} />)
    await waitFor(() => expect(view.container.querySelector('[data-timeline-row-id="agent-failure"]')).toBeTruthy())
    expect(screen.getByText('provider exploded')).toBeTruthy()
    expect(screen.getByText(/code provider_error · retryable/)).toBeTruthy()
    expect(screen.queryByText('Working…')).toBeNull()
  })

  it('keeps Thinking… for a redacted-reasoning frontier and renders it without a disclosure', async () => {
    // Claude ≥2.1 headless withholds thinking text; the records still carry the
    // liveness signal (#95 parity: Thinking… vs Working…), so they must not be dropped.
    const run = detail([agent(0)])
    const view = render(<TranscriptRoute runId="run-1" agentIndex={0} dataApi={dataApi(run, {
      0: [
        { t: 1, kind: 'meta', attempt: 1, prompt: 'think' },
        { t: 2, kind: 'reasoning', text: '' },
        { t: 3, kind: 'reasoning', text: '', redacted: true },
      ],
    })} />)
    await screen.findByText('Thinking…')
    expect(screen.getByText('text withheld by the CLI')).toBeTruthy()
    expect(view.container.querySelectorAll('.reason')).toHaveLength(1)
    expect(view.container.querySelector('.reason button')).toBeNull()
  })

  it('renders an old journal of unmarked empty reasoning without asserting a redaction', async () => {
    // Pre-marker journals hold plain {kind:'reasoning', text:''} with no recorded cause;
    // the row stays compact and non-expandable but claims nothing, and Thinking… holds.
    const run = detail([agent(0)])
    const view = render(<TranscriptRoute runId="run-1" agentIndex={0} dataApi={dataApi(run, {
      0: [
        { t: 1, kind: 'meta', attempt: 1, prompt: 'think' },
        { t: 2, kind: 'reasoning', text: '' },
        { t: 3, kind: 'reasoning', text: '' },
      ],
    })} />)
    await screen.findByText('Thinking…')
    expect(screen.getByText('no reasoning text recorded')).toBeTruthy()
    expect(screen.queryByText('text withheld by the CLI')).toBeNull()
    expect(view.container.querySelectorAll('.reason')).toHaveLength(1)
    expect(view.container.querySelector('.reason button')).toBeNull()
  })

  it('uses the narrow replacement while keeping compare in the stacked-selector state', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 899px'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
    const run = detail([agent(0), agent(1)])
    const view = render(<TranscriptRoute runId="run-1" agentIndex={0} compare={1} dataApi={dataApi(run, {
      0: [{ t: 1, kind: 'text', text: 'left' }],
      1: [{ t: 1, kind: 'text', text: 'right' }],
    })} />)
    await screen.findByRole('heading', { name: 'worker 0' })
    expect(view.container.querySelector('.agent-route-split')).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Cockpit views' })).toBeNull()
    expect(view.container.querySelector('.transcript-route.comparing')).toBeTruthy()
    expect(view.container.querySelector('.compare-panes[data-layout="side-by-side"]')).toBeTruthy()
  })
})
