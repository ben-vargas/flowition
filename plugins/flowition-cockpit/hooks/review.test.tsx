// Regressions from the adversarial review loop (gpt-6.1-sol, round 1): each test fails
// on the code before its fix.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { appendEvents, boundDetails, boundTimeline, emptyTimeline, runDuration, filterRuns, foldTimeline, lifetimeWorkers, parseStatus, parseTimeline, RUNS_FILTER_JS, STATUS_SLIM_JS, statusLine, transitions } from './lib'

type World = { states: Record<string, string>; listFails: boolean; transcriptFails: boolean; transcriptGrowth: number; calls: string[]; submitted: string[] }

const runsJson = (w: World) =>
  JSON.stringify([
    { runId: 'flo_live', state: w.states.flo_live, file: 'review.workflow.mjs', createdAt: 3000 },
    { runId: 'flo_old', state: w.states.flo_old, file: 'hello.workflow.js', createdAt: 1000 },
  ])
const status = (runId: string, state: string) =>
  JSON.stringify({
    runId,
    state,
    result: null,
    phases: [],
    agents: [{ index: 0, label: 'a', adapter: 'claude', model: 'm', state: state === 'running' ? 'running' : 'done' }],
    steps: [],
    questions: [],
    live: null,
  })
const TRANSCRIPT = `${JSON.stringify({ t: 1, kind: 'meta', index: 0, label: 'a', prompt: 'p' })}\n`
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On): World {
  const w: World = { states: { flo_live: 'running', flo_old: 'completed' }, listFails: false, transcriptFails: false, transcriptGrowth: 0, calls: [], submitted: [] }
  mock.clock(on)
  mock.env(on, { HOME: '/home/t', FLOWITION_HOME: '/home/t/.flowition', FLOWITION_BIN: '/bin/flowition', PATH: '/usr/bin' })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: e.path.includes('/agents/') ? TRANSCRIPT.length + w.transcriptGrowth : 0, mtimeMs: 1, isLink: false } }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', ($, e) => {
    const [bin, ...rest] = e.argv
    if (bin === '/bin/sh') {
      if (e.argv[5]?.includes('/agents/')) return w.transcriptFails ? { deny: 'transcript read refused' } : ok(TRANSCRIPT)
      return ok('')
    }
    const args = rest.join(' ')
    w.calls.push(args)
    if (args === 'runs --json') return w.listFails ? { value: { exitCode: 1, stdout: '', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false } } : ok(runsJson(w))
    for (const id of Object.keys(w.states)) if (args.startsWith(`status ${id}`)) return ok(status(id, w.states[id] ?? 'unknown'))
    return ok('[]')
  })
  return w
}

const PANE = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'flowition-cockpit',
    surface,
    component: 'Pane',
    requestId: 'flo',
    props: { title: 'Flowition', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: 160, rows: 40 },
  }) as const

test('F3: an armed run wakes Claude even when the open thread cannot be read', async ($, on) => {
  const w = world(on)
  await $.command.run({ command: 'flo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'open:flo_live' })
  await ui.press({ key: 'wake' })
  await ui.press({ key: 'agent:0' })
  // The transcript grows (so the open thread reads it again), and that read fails.
  w.transcriptGrowth = 50
  w.transcriptFails = true
  w.states.flo_live = 'completed'
  await ui.press({ key: 'refresh' })
  expect(w.submitted.some((text) => text.includes('flo_live'))).toBe(true)
  await ui.unmount()
})

test('F4: a run listing that fails still polls watched runs, and says why', async ($, on) => {
  const w = world(on)
  await $.command.run({ command: 'flo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'open:flo_live' })
  await ui.press({ key: 'wake' })
  w.listFails = true
  w.states.flo_live = 'completed'
  await ui.press({ key: 'refresh' })
  expect(w.submitted.some((text) => text.includes('flo_live'))).toBe(true)
  expect(await ui.find({ text: /Listing runs failed: boom/ })).toBeDefined()
  await ui.unmount()
})

test('F7: a terminal pane redrawing never strands the controls a desktop pane shows', async ($, on) => {
  const w = world(on)
  await $.command.run({ command: 'flo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const desktop = await $.ui.mount(PANE('desktop'))
  const terminal = await $.ui.mount(PANE('terminal'))
  for (let k = 0; k < 3; k++) await terminal.redraw()
  w.calls.length = 0
  await desktop.pointer({ in: 'refresh', type: 'down', x: 1, y: 0, button: 'left' })
  await desktop.pointer({ in: 'refresh', type: 'up', x: 1, y: 0, button: 'left' })
  expect(w.calls).toContain('runs --json')
  await terminal.unmount()
  await desktop.unmount()
})

test('F2: dragging off a desktop control before releasing presses nothing, with or without a leave', async ($, on) => {
  const w = world(on)
  await $.command.run({ command: 'flo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const ui = await $.ui.mount(PANE('desktop'))
  w.calls.length = 0
  // Captured moves arrive from outside with no leave event; then the release, outside.
  await ui.pointer({ in: 'refresh', type: 'down', x: 1, y: 0, button: 'left' })
  await ui.pointer({ in: 'refresh', type: 'move', x: -5, y: 0, button: 'left' })
  await ui.pointer({ in: 'refresh', type: 'up', x: -5, y: 0, button: 'left' })
  expect(w.calls).not.toContain('runs --json')
  // A tap (down and up at once) still presses.
  await ui.pointer({ in: 'refresh', type: 'down', x: 1, y: 0, button: 'left' })
  await ui.pointer({ in: 'refresh', type: 'up', x: 1, y: 0, button: 'left' })
  expect(w.calls).toContain('runs --json')
  await ui.unmount()
})

// ---- round 2: a session started for real, so the poll timer runs on the mocked clock ----

type World2 = {
  states: Record<string, string>
  errors: Record<string, string>
  calls: string[]
  submitted: string[]
  statusDenied: string | null
  workflows: string[]
  transcript: string
  agents: unknown[]
  eventsGrowth: number
}

function started(on: On) {
  const clock = mock.clock(on, { now: 100_000 })
  const w: World2 = {
    states: { flo_bad: 'failed', flo_live: 'running' },
    errors: { flo_bad: 'FIRST failure' },
    calls: [],
    submitted: [],
    statusDenied: null,
    workflows: [],
    transcript: '',
    agents: [],
    eventsGrowth: 0,
  }
  mock.env(on, { HOME: '/home/t', FLOWITION_HOME: '/home/t/.flowition', FLOWITION_BIN: '/bin/flowition', PATH: '/usr/bin' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', ($, e) => ({
    value: { kind: 'file', size: e.path.includes('/agents/') ? w.transcript.length : e.path.endsWith('events.jsonl') ? w.eventsGrowth : 0, mtimeMs: 1, isLink: false },
  }))
  on('fs.list', ($, e) => ({ value: e.path.endsWith('/workflows') ? w.workflows.map((name) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) : [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    w.calls.push(args)
    if (e.argv[0] === '/bin/sh') {
      const from = Number(e.argv[4]) - 1
      return ok(e.argv[5]?.includes('/agents/') ? w.transcript.slice(from, from + Number(e.argv[6])) : '')
    }
    if (e.argv[0] === 'pwd') return ok('/home/t')
    if (args.startsWith('run ')) return ok('{"runId":"flo_new","detached":true}')
    if (args === 'runs --json')
      return ok(JSON.stringify(Object.entries(w.states).map(([runId, state], i) => ({ runId, state, file: 'w.workflow.mjs', createdAt: 1000 - i }))))
    if (args.startsWith('status ')) {
      const runId = e.argv[2] as string
      const state = w.states[runId]
      if (w.statusDenied === runId) return { deny: 'status could not start' }
      return ok(JSON.stringify({ runId, state, result: state === 'failed' ? { status: 'failed', error: w.errors[runId] } : null, phases: [], agents: w.agents, steps: [], questions: [], live: null }))
    }
    return ok('{"ok":true}')
  })
  return { w, clock }
}

const flo = (args: string) => ({ command: 'flo', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } })

test('R2-F1: a resume ending in the same state still refreshes a cached failed run (the poll timer)', async ($, on) => {
  const { w, clock } = started(on)
  await $.session.start({ cwd: '/home/t', surface: 'terminal', isInteractive: true })
  await $.command.run(flo('flo_bad'))
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /FIRST failure/ })).toBeDefined()
  // Resumed elsewhere and failed again: the state is the same, the error is new.
  w.calls.length = 0
  w.errors.flo_bad = 'SECOND failure'
  await clock.advance(120_000)
  await ui.redraw()
  expect(w.calls).toContain('status flo_bad --json')
  expect(await ui.find({ type: 'Text', text: /SECOND failure/ })).toBeDefined()
  await ui.unmount()
})

test('R2-F1: growth of a cached run\'s events.jsonl (a resume) re-reads it at the next tick', async ($, on) => {
  const { w, clock } = started(on)
  await $.session.start({ cwd: '/home/t', surface: 'terminal', isInteractive: true })
  await $.command.run(flo('flo_bad'))
  const ui = await $.ui.mount(PANE('terminal'))
  await clock.advance(3_000)
  w.calls.length = 0
  w.errors.flo_bad = 'SECOND failure'
  w.eventsGrowth = 500
  await clock.advance(3_000)
  await ui.redraw()
  expect(w.calls).toContain('status flo_bad --json')
  expect(await ui.find({ type: 'Text', text: /SECOND failure/ })).toBeDefined()
  await ui.unmount()
})

test('R2-F8: a status that cannot run for one run never stops another run\'s wake', async ($, on) => {
  const { w } = started(on)
  w.states.flo_bad = 'running'
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'wake' })
  w.statusDenied = 'flo_bad'
  w.states.flo_live = 'completed'
  for (let i = 0; i < 3; i++) await ui.press({ key: 'refresh' })
  expect(w.submitted.length).toBe(1)
  await ui.unmount()
})

test('R2-F2: a captured release one cell outside a confirmation does not fire it', async ($, on) => {
  const { w } = started(on)
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('desktop'))
  const click = async (key: string) => {
    await ui.pointer({ in: key, type: 'down', x: 1, y: 0, button: 'left' })
    await ui.pointer({ in: key, type: 'up', x: 1, y: 0, button: 'left' })
  }
  await click('cancel-run')
  w.calls.length = 0
  await ui.pointer({ in: 'cancel-run-yes', type: 'down', x: 1, y: 0, button: 'left' })
  await ui.pointer({ in: 'cancel-run-yes', type: 'move', x: -1, y: 0, button: 'left' })
  await ui.pointer({ in: 'cancel-run-yes', type: 'up', x: -1, y: 0, button: 'left' })
  expect(w.calls).not.toContain('cancel flo_live')
  await click('cancel-run-yes')
  expect(w.calls).toContain('cancel flo_live')
  await ui.unmount()
})

test('R2-F9: another workflow starts without the last one\'s args', async ($, on) => {
  const { w } = started(on)
  w.workflows = ['a.workflow.mjs', 'b.workflow.mjs']
  await $.command.run(flo(''))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'new' })
  const root = '/home/t/.flowition/workflows/'
  await ui.press({ key: `wf-pick:${root}a.workflow.mjs` })
  await ui.input({ key: `launch-args:${root}a.workflow.mjs:0`, text: '{"target":"A"}', kind: 'change' })
  await ui.press({ key: `wf-pick:${root}b.workflow.mjs` })
  w.calls.length = 0
  await ui.press({ key: 'launch-start' })
  expect(w.calls.find((c) => c.startsWith('run '))?.replace(/ --cwd \S+/, '')).toBe(`run ${root}b.workflow.mjs --detach --json`)
  await ui.unmount()
})

test('R2-F10: a resumed attempt reusing a tool id never takes an earlier call\'s output', async ($, on) => {
  const { w } = started(on)
  w.agents = [{ index: 0, label: 'p', adapter: 'pi', state: 'done' }]
  w.transcript = [
    { t: 1, kind: 'meta', prompt: 'p', attempt: 1 },
    { t: 2, kind: 'tool', name: 'Read', input: '{"path":"A"}', id: 't1-tool1' },
    { t: 3, kind: 'tool-result', toolUseId: 't1-tool1', output: 'FIRST OUTPUT', isError: true },
    { t: 4, kind: 'attempt', n: 2 },
    { t: 5, kind: 'meta', prompt: 'p', attempt: 2 },
    { t: 6, kind: 'tool', name: 'Read', input: '{"path":"B"}', id: 't1-tool1' },
    { t: 7, kind: 'tool-result', toolUseId: 't1-tool1', output: 'SECOND OUTPUT', isError: false },
  ]
    .map((r) => `${JSON.stringify(r)}\n`)
    .join('')
  await $.command.run(flo('flo_bad'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'agent:0' })
  await ui.press({ key: 'tool:1' })
  expect((await ui.findAll({ type: 'Code' })).filter((c) => c.text.endsWith('OUTPUT')).map((c) => c.text)).toEqual(['FIRST OUTPUT'])
  await ui.unmount()
})

// ---- round 3: the session harness, with events.jsonl, prompt refusals, capped status ----

type World3 = World2 & {
  dropPrompt: boolean
  submitCalls: number
  events: string
  capCompleted: boolean
  eventsDenied: boolean
  statusGate: Promise<void> | null
  statusEntered: (() => void) | null
}

function started3(on: On) {
  const clock = mock.clock(on, { now: 100_000 })
  const w: World3 = {
    states: { flo_bad: 'failed', flo_live: 'running' },
    errors: { flo_bad: 'FIRST failure' },
    calls: [],
    submitted: [],
    statusDenied: null,
    workflows: [],
    transcript: '',
    agents: [],
    eventsGrowth: 0,
    dropPrompt: false,
    submitCalls: 0,
    events: '',
    capCompleted: false,
    eventsDenied: false,
    statusGate: null,
    statusEntered: null,
  }
  mock.env(on, { HOME: '/home/t', FLOWITION_HOME: '/home/t/.flowition', FLOWITION_BIN: '/bin/flowition', PATH: '/usr/bin' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', ($, e) => ({
    value: { kind: 'file', size: e.path.includes('/agents/') ? w.transcript.length : e.path.endsWith('events.jsonl') ? w.events.length : 0, mtimeMs: 1, isLink: false },
  }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('prompt.submit', ($, e) => {
    w.submitCalls++
    if (w.dropPrompt) return { drop: 'temporary prompt block' }
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', async ($, e) => {
    const args = e.argv.slice(1).join(' ')
    w.calls.push(args)
    if (e.argv[0] === '/bin/sh') {
      if (w.eventsDenied && e.argv[5]?.endsWith('events.jsonl')) return { deny: 'event read denied' }
      const from = Number(e.argv[4]) - 1
      return ok((e.argv[5]?.includes('/agents/') ? w.transcript : w.events).slice(from, from + Number(e.argv[6])))
    }
    if (e.argv[0] === 'pwd') return ok('/home/t')
    if (args === 'runs --json')
      return ok(JSON.stringify(Object.entries(w.states).map(([runId, state], i) => ({ runId, state, file: 'w.workflow.mjs', createdAt: 1000 - i }))))
    if (args.startsWith('status ')) {
      const runId = e.argv[2] as string
      const state = w.states[runId]
      if (runId === 'flo_live' && w.statusGate) {
        w.statusEntered?.()
        await w.statusGate
      }
      if (state === 'completed' && w.capCompleted)
        return {
          value: {
            exitCode: 0,
            stderr: '',
            stdout: `{"runId":"${runId}","state":"completed","result":{"status":"completed","result":"`.padEnd(4_194_304, 'x'),
            isStdoutTruncated: true,
            isStderrTruncated: false,
          },
        }
      return ok(JSON.stringify({ runId, state, result: state === 'failed' ? { status: 'failed', error: w.errors[runId] } : null, phases: [], agents: w.agents, steps: [], questions: [], live: null }))
    }
    return ok('{"ok":true}')
  })
  return { w, clock }
}
const lines = (rows: object[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('')

test('R3-F2: a release with no press on the face (or a second release) fires nothing', async ($, on) => {
  const { w } = started3(on)
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('desktop'))
  await ui.pointer({ in: 'cancel-run', type: 'down', x: 1, y: 0, button: 'left' })
  await ui.pointer({ in: 'cancel-run', type: 'up', x: 1, y: 0, button: 'left' })
  w.calls.length = 0
  await ui.pointer({ in: 'cancel-run-yes', type: 'up', x: 1, y: 0, button: 'left' })
  expect(w.calls).not.toContain('cancel flo_live')
  // A whole press fires once; a repeated release after it does not fire again.
  await ui.pointer({ in: 'cancel-run-yes', type: 'down', x: 1, y: 0, button: 'left' })
  await ui.pointer({ in: 'cancel-run-yes', type: 'up', x: 1, y: 0, button: 'left' })
  expect(w.calls.filter((c) => c === 'cancel flo_live').length).toBe(1)
  await ui.unmount()
})

test('R3-F2: a card opens only on its own press, never on a stray release', async ($, on) => {
  const { w } = started3(on)
  await $.command.run(flo(''))
  const ui = await $.ui.mount(PANE('desktop'))
  await ui.pointer({ in: 'refresh', type: 'down', x: 1, y: 0, button: 'left' })
  await ui.pointer({ in: 'refresh', type: 'up', x: 1, y: 0, button: 'left' })
  void w
  await ui.pointer({ in: 'card:flo_live', type: 'up', x: 1, y: 0, button: 'left' })
  expect(await ui.find({ key: 'card:flo_live' })).toBeDefined()
  await ui.unmount()
})

test('R3-F13: a refused wake prompt is tried again at the next poll, once accepted it stops', async ($, on) => {
  const { w } = started3(on)
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'wake' })
  w.dropPrompt = true
  w.states.flo_live = 'completed'
  await ui.press({ key: 'refresh' })
  w.dropPrompt = false
  for (let i = 0; i < 3; i++) await ui.press({ key: 'refresh' })
  expect([w.submitCalls, w.submitted.length]).toEqual([2, 1])
  await ui.unmount()
})

test('R3: disarming while the completing status runs means no wake', async ($, on) => {
  const { w } = started3(on)
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'wake' })
  let release!: () => void
  let entered!: () => void
  w.statusGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const inStatus = new Promise<void>((resolve) => {
    entered = resolve
  })
  w.statusEntered = entered
  w.states.flo_live = 'completed'
  const refreshing = ui.press({ key: 'refresh' })
  await inStatus
  await ui.press({ key: 'wake' })
  release()
  await refreshing
  w.statusGate = null
  expect(w.submitted).toEqual([])
  await ui.unmount()
})

test('R3-F12: an ended (stale) run shows its abandoned phase and agent as interrupted', async ($, on) => {
  const { w } = started3(on)
  w.states.flo_live = 'stale'
  w.agents = [{ index: 0, label: 'abandoned', adapter: 'claude', state: 'running', phaseIndex: 0 }]
  w.events = lines([
    { t: 1000, type: 'run', state: 'started', phases: [{ title: 'Verify' }] },
    { t: 1100, type: 'phase', phaseIndex: 0, title: 'Verify' },
    { t: 1200, type: 'agent', index: 0, label: 'abandoned', adapter: 'claude', state: 'running', phaseIndex: 0 },
  ])
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'tab:phases' })
  const phase = (await ui.find({ key: 'phase:0' }))?.text ?? ''
  expect(phase).not.toContain('running')
  expect(phase).toContain('interrupted')
  await ui.unmount()
})

test('R3-F6: a final status too large to read never double-counts output the events folded', async ($, on) => {
  const { w } = started3(on)
  w.agents = [{ index: 0, label: 'a', state: 'running', outputTokens: 100, lastOutputAt: 3 }]
  w.events = lines([
    { t: 1, type: 'run', state: 'started' },
    { t: 2, type: 'agent', index: 0, label: 'a', state: 'running' },
    { t: 3, type: 'agent', index: 0, state: 'progress', outputTokens: 100, lastOutputAt: 3 },
  ])
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  w.capCompleted = true
  w.states.flo_live = 'completed'
  w.events += lines([
    { t: 4, type: 'agent', index: 0, state: 'done', usage: { output: 100, cost: 1 }, lastOutputAt: 3 },
    { t: 5, type: 'run', state: 'completed' },
  ])
  await ui.press({ key: 'refresh' })
  await ui.redraw()
  expect((await ui.find({ key: 't:tokens' }))?.text).toContain('100 tokens')
  await ui.unmount()
})

test('R3-F11: an unreadable, older timeline never undercounts what status reports', async ($, on) => {
  const { w } = started3(on)
  w.states.flo_live = 'failed'
  w.agents = [{ index: 0, label: 'a', state: 'failed', t: 4, lastOutputAt: 3, usage: { output: 100, cost: 1 } }]
  w.events = lines([
    { t: 1, type: 'run', state: 'started' },
    { t: 2, type: 'agent', index: 0, label: 'a', state: 'running' },
    { t: 4, type: 'agent', index: 0, state: 'failed', usage: { output: 100, cost: 1 } },
    { t: 5, type: 'run', state: 'failed' },
  ])
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  // Resumed elsewhere and finished: status knows the new attempt; the events cannot be read.
  w.states.flo_live = 'completed'
  w.agents = [{ index: 0, label: 'a', state: 'done', t: 10, lastOutputAt: 9, usage: { output: 200, cost: 2 } }]
  w.events += lines([
    { t: 6, type: 'run', state: 'resumed' },
    { t: 7, type: 'agent', index: 0, state: 'running' },
    { t: 10, type: 'agent', index: 0, state: 'done', usage: { output: 200, cost: 2 } },
    { t: 11, type: 'run', state: 'completed' },
  ])
  w.eventsDenied = true
  for (let i = 0; i < 3; i++) await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 't:tokens' }))?.text).toContain('300 tokens')
  expect((await ui.find({ key: 't:cost' }))?.text).toContain('$3.00')
  expect(await ui.find({ text: /events could not be read just now/ })).toBeDefined()
  await ui.unmount()
})

// ---- round 4 -----------------------------------------------------------------------

type World4 = {
  states: Record<string, string>
  agents: object[]
  events: string
  transcript: string
  eventsDenied: boolean
  calls: string[]
  submits: number
  // A history too long for one read: `runs --json` comes back cut at 4 MiB, and the
  // node filter (when it can run) gets the whole listing.
  bigList: object[] | null
  filterFails: boolean
  filterEnv: string | undefined
  // The filtered listing's temp file, and whether reads of it past the first chunk fail.
  listFile: string | null
  listReadsFail: boolean
  removed: string[]
  // A completed result too large for one status read, and whether the slim re-read works.
  hugeResult: boolean
  slimFails: boolean
  slimEnv: string | undefined
  questions: object[]
  // The engine's live status (its pending questions), or null when none answers.
  liveQuestions: object[] | null
  toasts: string[]
}

function world4(on: On) {
  const clock = mock.clock(on, { now: 100_000 })
  const w: World4 = {
    states: { flo_a: 'failed', flo_b: 'running' },
    agents: [],
    events: '',
    transcript: '',
    eventsDenied: false,
    calls: [],
    submits: 0,
    bigList: null,
    filterFails: false,
    filterEnv: undefined,
    listFile: null,
    listReadsFail: false,
    removed: [],
    hugeResult: false,
    slimFails: false,
    slimEnv: undefined,
    questions: [],
    liveQuestions: null,
    toasts: [],
  }
  const TEMP = '/tmp/flowition-cockpit-runs.TEST'
  const statusOf = (runId: string) => ({ runId, state: w.states[runId], agents: w.agents, steps: [], questions: w.questions, phases: [], result: w.hugeResult ? { status: 'completed', result: 'x'.repeat(4_200_000) } : null, live: w.liveQuestions ? { ok: true, questions: w.liveQuestions } : null })
  mock.env(on, { HOME: '/home/t', FLOWITION_HOME: '/home/t/.flowition', FLOWITION_BIN: '/bin/flowition', PATH: '/usr/bin' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: e.path.endsWith('events.jsonl') ? w.events.length : e.path.includes('/agents/') ? w.transcript.length : 0, mtimeMs: 1, isLink: false } }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('prompt.submit', ($, e) => {
    w.submits++
    return { text: e.text }
  })
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    w.calls.push(args)
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('runs --json | node')) {
      w.filterEnv = e.init?.env?.FLOWITION_COCKPIT_JS
      if (w.filterFails || !w.bigList) return { value: { exitCode: 1, stdout: '', stderr: 'node: not found', isStdoutTruncated: false, isStderrTruncated: false } }
      // What the filter writes: the count, then every unfinished run and the newest N, a row a line.
      const n = Number(e.argv[4])
      const pin: string[] = JSON.parse(e.argv[5] ?? '[]')
      const kept = w.bigList.filter((r, i) => i < n || pin.includes((r as { runId: string }).runId) || !['completed', 'failed', 'cancelled', 'interrupted', 'stale', 'corrupt', 'corrupt-result'].includes((r as { state: string }).state))
      w.listFile = `${[String(w.bigList.length), ...kept.map((r) => JSON.stringify(r))].join('\n')}\n`
      return ok(`${TEMP}\n   ${w.listFile.length}\n`)
    }
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('status "$1" --json | node')) {
      w.slimEnv = e.init?.env?.FLOWITION_COCKPIT_JS
      if (w.slimFails) return { value: { exitCode: 1, stdout: '', stderr: 'node: not found', isStdoutTruncated: false, isStderrTruncated: false } }
      return ok(JSON.stringify({ ...statusOf(e.argv[4] as string), result: { status: 'completed', result: null }, resultOmitted: true }))
    }
    if (e.argv[0] === '/bin/sh' && e.argv[5] === TEMP) {
      const from = Number(e.argv[4]) - 1
      if (w.listReadsFail && from > 0) return { deny: 'read refused' }
      return ok((w.listFile ?? '').slice(from, from + Number(e.argv[6])))
    }
    if (e.argv[0] === 'rm') {
      w.removed.push(e.argv[2] as string)
      return ok('')
    }
    if (e.argv[0] === 'head') return ok(`${w.events.split('\n')[0] ?? ''}\n`)
    if (e.argv[0] === '/bin/sh') {
      if (w.eventsDenied && e.argv[5]?.endsWith('events.jsonl')) return { deny: 'event read denied' }
      const from = Number(e.argv[4]) - 1
      return ok((e.argv[5]?.includes('/agents/') ? w.transcript : w.events).slice(from, from + Number(e.argv[6])))
    }
    if (args === 'runs --json' && w.bigList)
      return { value: { exitCode: 0, stdout: JSON.stringify(w.bigList).slice(0, 4_194_304), stderr: '', isStdoutTruncated: true, isStderrTruncated: false } }
    if (args === 'runs --json') return ok(JSON.stringify(Object.entries(w.states).map(([runId, state]) => ({ runId, state, file: `${runId}.workflow.mjs`, createdAt: 1000 }))))
    if (args.startsWith('status ')) {
      const text = JSON.stringify(statusOf(e.argv[2] as string))
      return { value: { exitCode: 0, stdout: text.slice(0, 4_194_304), stderr: '', isStdoutTruncated: text.length > 4_194_304, isStderrTruncated: false } }
    }
    return ok('{"ok":true}')
  })
  return { w, clock }
}

test('R4-F11: a cached replay is not another paid attempt, even with the events unreadable', async ($, on) => {
  const { w } = world4(on)
  w.agents = [{ index: 0, label: 'a', state: 'done', t: 4, outputTokens: 100, usage: { output: 100, cost: 1 }, lastOutputAt: 3 }]
  w.events = lines([{ t: 1, type: 'run', state: 'started' }, { t: 2, type: 'agent', index: 0, state: 'running' }, { t: 4, type: 'agent', index: 0, state: 'done', outputTokens: 100, usage: { output: 100, cost: 1 } }, { t: 5, type: 'run', state: 'failed' }])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  // Resumed and replayed from the journal: status keeps the replayed result's usage.
  w.states.flo_a = 'completed'
  w.agents = [{ index: 0, label: 'a', state: 'cached', t: 7, outputTokens: 100, usage: { output: 100, cost: 1 }, lastOutputAt: 3 }]
  w.events += lines([{ t: 6, type: 'run', state: 'resumed' }, { t: 7, type: 'agent', index: 0, state: 'cached' }, { t: 8, type: 'run', state: 'completed' }])
  w.eventsDenied = true
  await ui.press({ key: 'refresh' })
  expect([(await ui.find({ key: 't:tokens' }))?.text, (await ui.find({ key: 't:cost' }))?.text]).toEqual(['Output100 tokens', 'Cost$1.00'])
  await ui.unmount()
})

test('R4-F11: output from a resumed attempt the events have not shown yet is counted', async ($, on) => {
  const { w } = world4(on)
  w.agents = [{ index: 0, label: 'a', state: 'failed', t: 4, usage: { output: 100, cost: 1 }, lastOutputAt: 3 }]
  w.events = lines([{ t: 1, type: 'run', state: 'started' }, { t: 2, type: 'agent', index: 0, state: 'running' }, { t: 4, type: 'agent', index: 0, state: 'failed', usage: { output: 100, cost: 1 } }, { t: 5, type: 'run', state: 'failed' }])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  w.states.flo_a = 'running'
  w.agents = [{ index: 0, label: 'a', state: 'running', t: 9, outputTokens: 200, usage: { output: 100, cost: 1 }, lastOutputAt: 9 }]
  w.events += lines([{ t: 6, type: 'run', state: 'resumed' }, { t: 7, type: 'agent', index: 0, state: 'running' }, { t: 9, type: 'agent', index: 0, state: 'progress', outputTokens: 200, lastOutputAt: 9 }])
  w.eventsDenied = true
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 't:tokens' }))?.text).toContain('300 tokens')
  await ui.unmount()
})

test('R4-F11: spend is matched to terminal events, not to timestamps alone', async () => {
  // A terminal sharing its running event's millisecond is still unread.
  const open = parseTimeline(lines([{ t: 10, type: 'agent', index: 0, state: 'running' }]), 'r', 0).lanes
  const done = parseStatus(JSON.stringify({ runId: 'r', state: 'completed', agents: [{ index: 0, state: 'done', t: 10, usage: { output: 100, cost: 1 } }] }), 11).workers
  expect(lifetimeWorkers(done, open)[0]?.outputTokens).toBe(100)
  // The events read ahead of status (a resume began after it): its done is counted once.
  const ahead = parseTimeline(
    lines([{ t: 2, type: 'agent', index: 0, state: 'running' }, { t: 4, type: 'agent', index: 0, state: 'done', usage: { output: 100, cost: 1 } }, { t: 6, type: 'agent', index: 0, state: 'running' }]),
    'r',
    0,
  ).lanes
  const behind = parseStatus(JSON.stringify({ runId: 'r', state: 'running', agents: [{ index: 0, state: 'done', t: 4, usage: { output: 100, cost: 1 } }] }), 7).workers
  expect([lifetimeWorkers(behind, ahead)[0]?.outputTokens, lifetimeWorkers(behind, ahead)[0]?.cost]).toEqual([100, 1])
})

test('R4-F12: an agent thread of an ended run shows its abandoned work as interrupted', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'stale'
  w.agents = [{ index: 0, label: 'abandoned', state: 'running' }]
  w.transcript = lines([{ t: 1, kind: 'meta', prompt: 'p' }])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('desktop'))
  await ui.post({ press: true }, { in: 'agentcard:0' })
  expect((await ui.findAll({ type: 'Svg' }))[0]?.props.alt).toBe('interrupted')
  await ui.unmount()
})

test('R4-F14: a detached launch still `unknown` stays armed and wakes once it completes', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_b = 'unknown'
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'mock detached launch', text: 'started detached run flo_b' }))
  await $.tool.call({ tool: 'Bash', command: 'flowition run pending.workflow.mjs --detach --json' })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'wake' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'refresh' })
  const before = w.submits
  w.calls.length = 0
  w.states.flo_b = 'completed'
  await ui.press({ key: 'refresh' })
  expect([before, w.submits, w.calls.includes('status flo_b --json')]).toEqual([0, 1, true])
  await ui.unmount()
})

const longHistory = () => [
  ...Array.from({ length: 11_000 }, (_, i) => ({ runId: `flo_${i}_${'r'.repeat(95)}`, state: 'completed', file: `${'w'.repeat(240)}.mjs`, createdAt: 20_000 - i })),
  { runId: 'flo_b', state: 'running', file: 'old.workflow.mjs', createdAt: 1 },
]

test('R4-F4: a history too long for one read still finds an older live run, and says what it leaves out', async ($, on) => {
  const { w } = world4(on)
  w.bigList = longHistory()
  expect(JSON.stringify(w.bigList).length).toBeGreaterThan(4_194_304)
  await $.command.run(flo(''))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  expect([w.calls.includes('status flo_b --json'), !!(await ui.find({ key: 'open:flo_b' })), w.filterEnv === RUNS_FILTER_JS]).toEqual([true, true, true])
  expect(await ui.find({ text: 'Showing every unfinished run and the newest 2,000 of 11,001 runs.' })).toBeDefined()
  expect(w.removed.length > 0 && w.removed.every((f) => f === '/tmp/flowition-cockpit-runs.TEST')).toBe(true)
  await ui.unmount()
})

test('R4-F4: when the filter cannot run, the newest rows show and the list says history is cut', async ($, on) => {
  const { w } = world4(on)
  w.bigList = longHistory()
  w.filterFails = true
  await $.command.run(flo(''))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  // The newest rows that were read still list (folded: one workflow, repeated).
  expect(await ui.find({ text: /0 live · \d+ shown/ })).toBeDefined()
  expect(await ui.find({ text: /too long to list in full/ })).toBeDefined()
  await ui.unmount()
})

// ---- round 5 -----------------------------------------------------------------------

const firstAttempt = () =>
  lines([
    { t: 1, type: 'run', state: 'started' },
    { t: 2, type: 'agent', index: 0, state: 'running' },
    { t: 3, type: 'agent', index: 0, state: 'progress', outputTokens: 100, lastOutputAt: 3 },
    { t: 4, type: 'agent', index: 0, state: 'failed', usage: { output: 100, cost: 1 } },
    { t: 5, type: 'run', state: 'failed' },
  ])

test('R5-F11: an unread failed attempt counts its final usage, not the progress counter status kept', async ($, on) => {
  const { w } = world4(on)
  w.agents = [{ index: 0, label: 'a', state: 'failed', t: 4, outputTokens: 100, usage: { output: 100, cost: 1 }, lastOutputAt: 3 }]
  w.events = firstAttempt()
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  // As src/events.js folds it: the resumed attempt's usage merged over the old outputTokens.
  w.agents = [{ index: 0, label: 'a', state: 'failed', t: 10, outputTokens: 100, usage: { output: 200, cost: 2 }, lastOutputAt: 9 }]
  w.events += lines([{ t: 6, type: 'run', state: 'resumed' }, { t: 8, type: 'agent', index: 0, state: 'running' }, { t: 10, type: 'agent', index: 0, state: 'failed', usage: { output: 200, cost: 2 } }, { t: 11, type: 'run', state: 'failed' }])
  w.eventsDenied = true
  await ui.press({ key: 'refresh' })
  expect([(await ui.find({ key: 't:tokens' }))?.text, (await ui.find({ key: 't:cost' }))?.text]).toEqual(['Output300 tokens', 'Cost$3.00'])
  await ui.unmount()
})

test('R5-F11: an attempt cancelled before it started (usage: null) spends nothing', async ($, on) => {
  const { w } = world4(on)
  w.agents = [{ index: 0, label: 'a', state: 'failed', t: 4, outputTokens: 100, usage: { output: 100, cost: 1 }, lastOutputAt: 3 }]
  w.events = firstAttempt()
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  w.agents = [{ index: 0, label: 'a', state: 'cancelled', t: 10, outputTokens: 100, usage: null, lastOutputAt: null }]
  w.events += lines([{ t: 6, type: 'run', state: 'resumed' }, { t: 7, type: 'agent', index: 0, state: 'queued' }, { t: 10, type: 'agent', index: 0, state: 'cancelled', usage: null }, { t: 11, type: 'run', state: 'failed' }])
  w.eventsDenied = true
  await ui.press({ key: 'refresh' })
  expect([(await ui.find({ key: 't:tokens' }))?.text, (await ui.find({ key: 't:cost' }))?.text]).toEqual(['Output100 tokens', 'Cost$1.00'])
  await ui.unmount()
})

const unfinishedFlood = () => [
  ...Array.from({ length: 30_000 }, (_, i) => ({ runId: `flo_${String(i).padStart(5, '0')}_${'r'.repeat(95)}`, state: 'unknown', file: '?', createdAt: 0 })),
  { runId: 'flo_b', state: 'running', file: '?', createdAt: 0 },
]

test('R5-F4: a filtered listing itself over the stdout cap is read whole, in chunks', async ($, on) => {
  const { w } = world4(on)
  w.bigList = unfinishedFlood()
  await $.command.run(flo(''))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  expect((w.listFile ?? '').length).toBeGreaterThan(4_194_304)
  const listings = w.calls.filter((c) => c.includes('runs --json | node')).length
  expect([w.calls.includes('status flo_b --json'), !!(await ui.find({ key: 'open:flo_b' })), w.removed.length === listings]).toEqual([true, true, true])
  // $.state holds 4 MiB a value: rows past its budget are left out, and the list says so.
  expect(await ui.find({ text: /too large to list in full: some unfinished runs may not be shown/ })).toBeDefined()
  await ui.unmount()
})

test('R5-F4: a filtered listing that cannot be read to its end never claims every unfinished run', async ($, on) => {
  const { w } = world4(on)
  w.bigList = unfinishedFlood()
  w.listReadsFail = true
  await $.command.run(flo(''))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ text: /too large to list in full: some unfinished runs may not be shown/ })).toBeDefined()
  expect(await ui.find({ text: /Showing every unfinished run/ })).toBeUndefined()
  expect(w.removed.length).toBe(w.calls.filter((c) => c.includes('runs --json | node')).length)
  await ui.unmount()
})

test('R5-F15: first opening a run with a huge result still shows its workers and totals', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'completed'
  w.hugeResult = true
  w.agents = [{ index: 0, label: 'a', adapter: 'claude', state: 'done', t: 4, usage: { output: 100, cost: 1 } }]
  w.events = lines([{ t: 1, type: 'run', state: 'started' }, { t: 2, type: 'agent', index: 0, label: 'a', state: 'running' }, { t: 4, type: 'agent', index: 0, state: 'done', usage: { output: 100, cost: 1 } }, { t: 5, type: 'run', state: 'completed' }])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  for (let i = 0; i < 3; i++) await ui.press({ key: 'refresh' })
  expect(w.slimEnv).toBe(STATUS_SLIM_JS)
  expect([(await ui.find({ key: 't:agents' }))?.text, (await ui.find({ key: 't:tokens' }))?.text, (await ui.find({ key: 't:cost' }))?.text]).toEqual(['Agents1/1 done', 'Output100 tokens', 'Cost$1.00'])
  expect(await ui.find({ text: /too large for the pane to read/ })).toBeDefined()
  await ui.unmount()
})

test('R5-F15: when no whole status can be read, the agents are unknown, not none', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'completed'
  w.hugeResult = true
  w.slimFails = true
  w.agents = [{ index: 0, label: 'a', state: 'done', t: 4, usage: { output: 100, cost: 1 } }]
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 't:agents' }))?.text).toBe('Agents—')
  expect(await ui.find({ text: /agents are not known here yet/ })).toBeDefined()
  expect(await ui.find({ text: 'No agents yet.' })).toBeUndefined()
  await ui.unmount()
})

test('R5-F15: with no whole status at all, the agents come from the run\'s events', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'completed'
  w.hugeResult = true
  w.slimFails = true
  w.events = lines([{ t: 1, type: 'run', state: 'started' }, { t: 2, type: 'agent', index: 0, label: 'a', adapter: 'claude', state: 'running' }, { t: 4, type: 'agent', index: 0, state: 'done', usage: { output: 100, cost: 1 } }, { t: 5, type: 'run', state: 'completed' }])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  for (let i = 0; i < 3; i++) await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab:timeline' })
  expect(await ui.find({ key: 'lane:a:0' })).toBeDefined()
  await ui.press({ key: 'tab:agents' })
  expect([(await ui.find({ key: 't:agents' }))?.text, (await ui.find({ key: 't:tokens' }))?.text, (await ui.find({ key: 't:cost' }))?.text]).toEqual(['Agents1/1 done', 'Output100 tokens', 'Cost$1.00'])
  await ui.unmount()
})

// ---- round 6 -----------------------------------------------------------------------

test('R6-F15: an auto-attached run whose first status is too large shows the agents its events name', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'completed'
  w.hugeResult = true
  w.slimFails = true
  w.events = lines([{ t: 1, type: 'run', state: 'started' }, { t: 2, type: 'agent', index: 0, label: 'a', state: 'running' }, { t: 4, type: 'agent', index: 0, state: 'done', usage: { output: 100, cost: 1 } }, { t: 5, type: 'run', state: 'completed' }])
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'mock launch', text: 'started detached run flo_a' }))
  await $.tool.call({ tool: 'Bash', command: 'flowition run a.workflow.mjs --detach' })
  const ui = await $.ui.mount(PANE('terminal'))
  for (let i = 0; i < 3; i++) await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab:timeline' })
  await ui.press({ key: 'tab:agents' })
  expect([(await ui.find({ key: 't:agents' }))?.text, (await ui.find({ key: 't:tokens' }))?.text, (await ui.find({ key: 't:cost' }))?.text]).toEqual(['Agents1/1 done', 'Output100 tokens', 'Cost$1.00'])
  await ui.unmount()
})

test('R6-F15: a cached earlier worker list never hides an agent a later attempt journaled', async ($, on) => {
  const { w } = world4(on)
  w.agents = [{ index: 0, label: 'a', state: 'failed', t: 4, usage: { output: 100, cost: 1 } }]
  w.events = firstAttempt()
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  w.states.flo_a = 'completed'
  w.hugeResult = true
  w.slimFails = true
  w.events += lines([{ t: 6, type: 'run', state: 'resumed' }, { t: 7, type: 'agent', index: 0, state: 'cached' }, { t: 8, type: 'agent', index: 1, label: 'b', state: 'running' }, { t: 10, type: 'agent', index: 1, state: 'done', usage: { output: 200, cost: 2 } }, { t: 11, type: 'run', state: 'completed' }])
  for (let i = 0; i < 3; i++) await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab:timeline' })
  await ui.press({ key: 'tab:agents' })
  expect([(await ui.find({ key: 't:agents' }))?.text, (await ui.find({ key: 't:tokens' }))?.text, (await ui.find({ key: 't:cost' }))?.text]).toEqual(['Agents2/2 done', 'Output300 tokens', 'Cost$3.00'])
  await ui.unmount()
})

for (const filterFails of [false, true]) {
  test(`R6-F16: this session's older finished run survives a long history (${filterFails ? 'filter unavailable' : 'filtered'})`, async ($, on) => {
    const { w } = world4(on)
    w.states.flo_a = 'completed'
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'mock launch', text: 'started detached run flo_a' }))
    await $.tool.call({ tool: 'Bash', command: 'flowition run a.workflow.mjs --detach' })
    const ui = await $.ui.mount(PANE('terminal'))
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'back' })
    const before = !!(await ui.find({ key: 'open:flo_a' }))
    w.bigList = [...longHistory(), { runId: 'flo_a', state: 'completed', file: 'a.workflow.mjs', createdAt: 0 }]
    w.filterFails = filterFails
    await ui.press({ key: 'refresh' })
    expect([before, !!(await ui.find({ key: 'open:flo_a' }))]).toEqual([true, true])
    await ui.unmount()
  })
}

test('R6-F11: an ended run keeps the output its abandoned agent was known to make', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'running'
  w.agents = [{ index: 0, label: 'a', state: 'running', t: 3, outputTokens: 100, lastOutputAt: 3 }]
  w.events = lines([{ t: 1, type: 'run', state: 'started' }, { t: 2, type: 'agent', index: 0, label: 'a', state: 'running' }, { t: 3, type: 'agent', index: 0, state: 'progress', outputTokens: 100, lastOutputAt: 3 }])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ key: 't:tokens' }))?.text).toBe('Output100 tokens')
  w.states.flo_a = 'stale'
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 't:tokens' }))?.text).toBe('Output100 tokens')
  await ui.unmount()
})

test('R6-F17: details too large for $.state together never stop a completion wake', async ($, on) => {
  const { w, clock } = started(on)
  // Two runs whose statuses each fit a read but together pass $.state's 4 MiB.
  w.agents = Array.from({ length: 1500 }, (_, i) => ({ index: i, label: `agent ${i}`, state: 'done', error: 'E'.repeat(1_500) }))
  w.errors.flo_bad = 'E'.repeat(2_150_000)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'mock launch', text: 'started detached run flo_bad' }))
  await $.session.start({ cwd: '/home/t', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'flowition run a.workflow.mjs --detach' })
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'wake' })
  w.errors.flo_live = 'F'.repeat(2_150_000)
  w.states.flo_live = 'failed'
  await clock.advance(10_000)
  await ui.redraw()
  const texts = (await ui.findAll({ type: 'Text' })).map((n) => n.text)
  expect(w.submitted.some((text) => text.includes('flo_live'))).toBe(true)
  expect(texts.some((t) => /\$\.state|over the 4194304 limit/.test(t))).toBe(false)
  // The run's own error draws, held to what a pane can draw beside its controls.
  expect(texts.some((t) => t.startsWith('FFFF') && t.length < 5_000)).toBe(true)
  expect(!!(await ui.find({ key: 'refresh' }))).toBe(true)
  await ui.unmount()
})

test('R6-F18: a long run error never pushes the run\'s controls out of the drawing', async ($, on) => {
  const { w } = started(on)
  w.errors.flo_bad = 'E'.repeat(120_000)
  await $.command.run(flo('flo_bad'))
  const ui = await $.ui.mount(PANE('terminal'))
  expect([!!(await ui.find({ key: 'refresh' })), !!(await ui.find({ key: 'resume' }))]).toEqual([true, true])
  await ui.unmount()
})

test('R6-F18: a long thread draws its newest reply and its controls, saying what it leaves out', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'running'
  w.agents = [{ index: 0, label: 'a', adapter: 'claude', state: 'running' }]
  w.transcript = lines([{ t: 1, kind: 'meta', prompt: 'p' }, ...Array.from({ length: 20 }, (_, i) => [{ t: 2 + i, kind: 'text', text: `reply ${i}: `.padEnd(6000, 'x') }, { t: 2 + i, kind: 'status', text: `turn ${i} done` }]).flat(), { t: 30, kind: 'text', text: 'LATEST REPLY' }])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'agent:0' })
  expect([!!(await ui.find({ text: /LATEST REPLY/ })), !!(await ui.find({ key: 'follow' })), (await ui.findAll({ type: 'Input' })).some((n) => n.key?.startsWith('composer:'))]).toEqual([true, true, true])
  expect(await ui.find({ text: /earlier events are not drawn here/ })).toBeDefined()
  await ui.unmount()
})

test('R6-F18: many agents, or a long log, never push the run\'s controls out of the drawing', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'failed'
  w.agents = Array.from({ length: 600 }, (_, i) => ({ index: i, label: `agent ${i} `.padEnd(300, 'l'), state: 'failed', error: 'E'.repeat(5_000) }))
  w.events = lines([{ t: 1, type: 'run', state: 'started' }, ...Array.from({ length: 300 }, (_, i) => ({ t: 2 + i, type: 'log', message: `log ${i} `.padEnd(2_000, 'm') })), { t: 400, type: 'run', state: 'failed' }])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  expect([!!(await ui.find({ key: 'resume' })), !!(await ui.find({ text: /more not drawn here/ }))]).toEqual([true, true])
  await ui.press({ key: 'tab:log' })
  expect([!!(await ui.find({ key: 'resume' })), !!(await ui.find({ text: /log 299 / }))]).toEqual([true, true])
  await ui.press({ key: 'tab:timeline' })
  expect(!!(await ui.find({ key: 'resume' }))).toBe(true)
  await ui.unmount()
})

test('P2: the Phases tab draws its agents within the budget, so the run\'s controls still draw', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'failed'
  w.agents = Array.from({ length: 600 }, (_, i) => ({ index: i, label: `agent ${i} `.padEnd(300, 'l'), state: 'done', phase: 'Fan out', phaseIndex: 0 }))
  w.events = lines([
    { t: 1, type: 'run', state: 'started' },
    { t: 2, type: 'phase', title: 'Fan out', phaseIndex: 0 },
    ...Array.from({ length: 600 }, (_, i) => ({ t: 3, type: 'agent', index: i, label: `agent ${i} `.padEnd(300, 'l'), state: 'done', phaseIndex: 0 })),
    { t: 400, type: 'run', state: 'failed' },
  ])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'tab:phases' })
  expect([!!(await ui.find({ key: 'resume' })), !!(await ui.find({ key: 'delete' })), !!(await ui.find({ text: /more not drawn here/ }))]).toEqual([true, true, true])
  await ui.unmount()
})

test('P2: a resumed run toasts a question, and offers to answer it, only once it asks it again', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'stale'
  w.questions = [{ qid: 'q0', question: 'Ship it?', t: 5 }]
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'mock resume', text: 'started detached run flo_a' }))
  await $.tool.call({ tool: 'Bash', command: 'flowition run a.workflow.mjs --resume flo_a --detach' })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  const asked = () => w.toasts.filter((t) => t.includes('Ship it?')).length
  const answerField = async () => (await ui.findAll({ type: 'Input' })).some((n) => n.key?.startsWith('answer:q0:'))
  const before = asked()
  // Resuming: status says starting, and still lists the earlier attempt's record of q0.
  w.states.flo_a = 'starting'
  await ui.press({ key: 'refresh' })
  const whileStarting = [asked() - before, await answerField(), !!(await ui.find({ text: /once the run asks it again/ }))]
  // Running, but the engine has not reached ask() yet: still not open.
  w.states.flo_a = 'running'
  w.liveQuestions = []
  await ui.press({ key: 'refresh' })
  const beforeAsk = [asked() - before, await answerField()]
  // The engine asks it: a new question event, pending in the live status.
  w.questions = [{ qid: 'q0', question: 'Ship it?', t: 20 }]
  w.liveQuestions = [{ qid: 'q0', question: 'Ship it?' }]
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'refresh' })
  expect([whileStarting, beforeAsk, [asked() - before, await answerField()]]).toEqual([[0, false, true], [0, false], [1, true]])
  await ui.unmount()
})

// ---- Codex bot review of ff013c3 ---------------------------------------------------

test('P2: a completed run offers Replay, as the viewer does, and replays through run --resume', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'completed'
  w.events = lines([{ t: 1, type: 'run', state: 'started', workflowFile: '/home/t/wf/a.workflow.mjs' }, { t: 5, type: 'run', state: 'completed' }])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ key: 'resume' }))?.props.label).toBe('Replay…')
  await ui.press({ key: 'resume' })
  expect((await ui.find({ key: 'resume-yes' }))?.props.label).toBe('Yes, replay')
  expect(await ui.find({ text: /finished agents replay from the journal/ })).toBeDefined()
  await ui.press({ key: 'resume-yes' })
  expect(w.calls).toContain('run /home/t/wf/a.workflow.mjs --resume flo_a --detach --json')
  await ui.unmount()
})

test('P2: thousands of phases count against the Phases tab budget, so the run\'s controls still draw', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'failed'
  w.events = lines([
    { t: 1, type: 'run', state: 'started' },
    ...Array.from({ length: 3000 }, (_, i) => ({ t: 2 + i, type: 'phase', title: `phase ${i} `.padEnd(60, 'p'), phaseIndex: i })),
    { t: 4000, type: 'run', state: 'failed' },
  ])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'tab:phases' })
  expect([!!(await ui.find({ key: 'resume' })), !!(await ui.find({ key: 'delete' })), !!(await ui.find({ text: /more phases not drawn here/ }))]).toEqual([true, true, true])
  await ui.unmount()
})

test('P2: an ended run\'s unanswered question is no new request after a reload (no toast)', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'stale'
  w.questions = [{ qid: 'q0', question: 'Ship it?', t: 5 }]
  // A reload clears the cached details and keeps the attached ids: the first poll has no prev.
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'mock launch', text: 'started detached run flo_a' }))
  await $.tool.call({ tool: 'Bash', command: 'flowition run a.workflow.mjs --detach' })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'refresh' })
  expect(w.toasts.filter((t) => t.includes('Ship it?'))).toEqual([])
  await ui.unmount()
})

test('P2: only questions the engine waits on count as needing attention or waiting', () => {
  const status = (state: string, live: object | null) =>
    parseStatus(JSON.stringify({ runId: 'flo_a', state, agents: [], steps: [], questions: [{ qid: 'q0', question: 'Ship it?', t: 5 }], phases: [], result: null, live }), 1)
  const run = { runId: 'flo_a', state: 'starting', file: 'a.workflow.mjs', createdAt: 1 }
  // Resumed, not asked again yet: starting with no live status, or running with none pending.
  for (const d of [status('starting', null), status('running', { ok: true, questions: [] })]) {
    const r = { ...run, state: d.state }
    expect([filterRuns([r], 'attention', '', { flo_a: d }).length, /question/.test(statusLine([r], { flo_a: d }) ?? ''), transitions(undefined, d)]).toEqual([0, false, []])
  }
  // Asked: pending in the live status.
  const asked = status('running', { ok: true, questions: [{ qid: 'q0', question: 'Ship it?' }] })
  const r = { ...run, state: 'running' }
  expect([filterRuns([r], 'attention', '', { flo_a: asked }).length, /1 question waiting/.test(statusLine([r], { flo_a: asked }) ?? ''), transitions(undefined, asked)]).toEqual([1, true, ['flo_a asks: Ship it?']])
})

test('P2: a question is announced once, even when a poll cannot read the live status', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_b = 'running'
  w.questions = [{ qid: 'q0', question: 'Ship it?', t: 5 }]
  w.liveQuestions = [{ qid: 'q0', question: 'Ship it?' }]
  // Launched here, so watched from its first poll: its toasts are owed.
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'mock launch', text: 'started detached run flo_b' }))
  await $.tool.call({ tool: 'Bash', command: 'flowition run b.workflow.mjs --detach' })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'refresh' })
  // One poll whose control socket did not answer: the question reads closed.
  w.liveQuestions = null
  await ui.press({ key: 'refresh' })
  w.liveQuestions = [{ qid: 'q0', question: 'Ship it?' }]
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'refresh' })
  // A question first seen with no live status is announced once it is seen open.
  w.questions = [...w.questions, { qid: 'q1', question: 'Really?', t: 9 }]
  w.liveQuestions = null
  await ui.press({ key: 'refresh' })
  w.liveQuestions = [{ qid: 'q0', question: 'Ship it?' }, { qid: 'q1', question: 'Really?' }]
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'refresh' })
  expect([w.toasts.filter((t) => t.includes('Ship it?')).length, w.toasts.filter((t) => t.includes('Really?')).length]).toEqual([1, 1])
  await ui.unmount()
})

test('P2: many long questions draw within a budget, the run\'s controls and the open ones first', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_b = 'running'
  w.questions = Array.from({ length: 40 }, (_, i) => ({ qid: `q${i}`, question: `question ${i} `.padEnd(3_900, 'x'), t: 5 + i }))
  w.liveQuestions = w.questions.slice(30)
  await $.command.run(flo('flo_b'))
  const ui = await $.ui.mount(PANE('terminal'))
  const fields = (await ui.findAll({ type: 'Input' })).filter((n) => n.key?.startsWith('answer:')).map((n) => n.key?.split(':')[1])
  expect([!!(await ui.find({ key: 'refresh' })), !!(await ui.find({ key: 'cancel-run' })), !!(await ui.find({ text: /more questions not drawn here/ }))]).toEqual([true, true, true])
  // The open questions (q30–q39) come first, so they can be answered.
  expect(fields.slice(0, 3)).toEqual(['q30', 'q31', 'q32'])
  await ui.unmount()
})

test('P2: a deeply nested Structure draws within the budget, says what it leaves out, and keeps the controls', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'failed'
  // 300 agents, each under its own item of a parallel(300), five fan-outs deep.
  const chain = (k: number) => [
    { kind: 'parallel', ordinal: 0, count: 300 },
    { kind: 'item', i: k },
    ...Array.from({ length: 5 }, () => [{ kind: 'parallel', ordinal: 0, count: 1 }, { kind: 'item', i: 0 }]).flat(),
  ]
  w.events = lines([
    { t: 1, type: 'run', state: 'started' },
    ...Array.from({ length: 300 }, (_, k) => [
      { t: 2, type: 'agent', index: k, label: `a${k}`, state: 'running', path: chain(k) },
      { t: 3, type: 'agent', index: k, state: 'done' },
    ]).flat(),
    { t: 9, type: 'run', state: 'failed' },
  ])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'tab:structure' })
  expect([!!(await ui.find({ key: 'resume' })), !!(await ui.find({ key: 'delete' })), !!(await ui.find({ text: /more agents and steps not drawn here/ }))]).toEqual([true, true, true])
  await ui.unmount()
})

test('P2: a live fan-out with unfinished work spans to now, not to its last finished lane', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_b = 'running'
  const path = (i: number) => [{ kind: 'parallel', ordinal: 0, count: 2 }, { kind: 'item', i }]
  w.events = lines([
    { t: 40_000, type: 'run', state: 'started' },
    { t: 40_000, type: 'agent', index: 0, label: 'a', state: 'running', path: path(0) },
    { t: 40_000, type: 'agent', index: 1, label: 'b', state: 'running', path: path(1) },
    { t: 41_000, type: 'agent', index: 0, state: 'done' },
  ])
  await $.command.run(flo('flo_b'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'tab:structure' })
  // The mocked clock reads 100s: a minute in, the fan-out has run 1m so far (not 1s).
  expect(await ui.find({ text: '1/2 done · 1m 00s so far' })).toBeDefined()
  await ui.unmount()
})

test('P2: a status slimmed by cutting its lists is partial, its workers then from the events', () => {
  const d = parseStatus(JSON.stringify({ runId: 'flo_a', state: 'running', agents: [], steps: [], questions: [], phases: [], result: null, live: null, listsCut: true }), 1)
  expect(d.isPartial).toBe(true)
  expect(parseStatus(JSON.stringify({ runId: 'flo_a', state: 'running', agents: [], steps: [], questions: [], phases: [], result: null, live: null }), 1).isPartial).toBeUndefined()
})

test('P2: a watched run whose detail alone passes the cache budget is kept trimmed, its questions answerable and announced once', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_b = 'running'
  // About 3.1 MB of status (under the read cap), over the cache's 3 MiB once parsed.
  w.questions = Array.from({ length: 780 }, (_, i) => ({ qid: `q${i}`, question: `question ${i} `.padEnd(3_990, 'x'), t: 5 + i }))
  w.liveQuestions = w.questions.map((q) => ({ qid: (q as { qid: string }).qid }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'mock launch', text: 'started detached run flo_b' }))
  await $.tool.call({ tool: 'Bash', command: 'flowition run b.workflow.mjs --detach' })
  const ui = await $.ui.mount(PANE('terminal'))
  for (let i = 0; i < 3; i++) await ui.press({ key: 'refresh' })
  const fields = (await ui.findAll({ type: 'Input' })).filter((n) => n.key?.startsWith('answer:'))
  expect([fields.length > 0, w.toasts.filter((t) => t.startsWith('flo_b asks: question 0 ')).length]).toEqual([true, 1])
  await ui.unmount()
})

test('P2: a crashed run\'s agent spans to its last progress, not its start', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'stale'
  w.agents = [{ index: 0, label: 'worker', state: 'running' }]
  w.events = lines([
    { t: 1_000, type: 'run', state: 'started' },
    { t: 1_000, type: 'agent', index: 0, label: 'worker', state: 'running' },
    { t: 1_801_000, type: 'agent', index: 0, state: 'progress', outputTokens: 50, lastOutputAt: 1_801_000 },
    { t: 3_601_000, type: 'agent', index: 0, state: 'progress', outputTokens: 90, lastOutputAt: 3_601_000 },
  ])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'tab:timeline' })
  // The axis ends at the last progress (1h), and so does the lane's own duration.
  expect((await ui.findAll({ type: 'Text' })).filter((t) => t.text === '1h 00m').length).toBe(2)
  await ui.unmount()
})

test('P2: watched runs that together pass the cache budget keep their notice baseline: no question announced twice', () => {
  const status = (runId: string) =>
    parseStatus(
      JSON.stringify({
        runId,
        state: 'running',
        agents: [],
        steps: [],
        questions: Array.from({ length: 300 }, (_, i) => ({ qid: `q${i}`, question: `question ${i} `.padEnd(500, 'x'), t: 5 + i })),
        phases: [],
        result: null,
        live: { ok: true, questions: Array.from({ length: 300 }, (_, i) => ({ qid: `q${i}` })) },
      }),
      1,
    )
  const ids = ['flo_r0', 'flo_r1', 'flo_r2']
  const details = Object.fromEntries(ids.map((id) => [id, status(id)]))
  // A budget the three only fit together trimmed, the last as its baseline.
  const kept = boundDetails(details, ids, 250_000)
  expect(ids.map((id) => kept[id]?.questions.length ?? 0)).toEqual([300, 300, 300])
  // Polled again, a run kept only as its baseline announces nothing it announced before.
  expect(ids.map((id) => transitions(kept[id], status(id)).length)).toEqual([0, 0, 0])
  expect(transitions(kept.flo_r2, status('flo_r2')).length).toBe(0)
})

test('P2: a huge nested timeline is bounded for $.state, its lanes and spend kept, the Structure tab told', () => {
  const chain = (k: number) => [
    { kind: 'parallel', ordinal: 0, count: 4096 },
    { kind: 'item', i: k },
    ...Array.from({ length: 6 }, () => [{ kind: 'pipeline', ordinal: 0, count: 1, stages: 3 }, { kind: 'item', i: 0 }, { kind: 'stage', s: 1 }]).flat(),
  ]
  const text = Array.from({ length: 4096 }, (_, k) => [
    { t: 2, type: 'agent', index: k, label: `agent ${k}`, state: 'running', path: chain(k) },
    { t: 3, type: 'agent', index: k, state: 'done', usage: { output: 10, cost: 0.01 } },
  ])
    .flat()
    .map((r) => `${JSON.stringify(r)}\n`)
    .join('')
  const whole = foldTimeline(emptyTimeline('r'), text)
  expect(JSON.stringify(whole).length).toBeGreaterThan(4_194_304)
  const kept = boundTimeline(whole)
  expect([JSON.stringify(kept).length <= 3 << 20, kept.isPathsCut, kept.lanes.length, kept.lanes.reduce((n, l) => n + l.outputTokens, 0)]).toEqual([true, true, 4096, 40_960])
})

test('P2: a wake taken resets its refusals, so a later completion of the same run gets its retries', async ($, on) => {
  const { w } = started3(on)
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  // Three completions of one run (resumed in between), each refused twice, then taken.
  for (let k = 0; k < 3; k++) {
    w.states.flo_live = 'running'
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'wake' })
    w.states.flo_live = 'completed'
    w.dropPrompt = true
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'refresh' })
    w.dropPrompt = false
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'refresh' })
  }
  expect(w.submitted.length).toBe(3)
  await ui.unmount()
})

test('P2: every watched run keeps at least its baseline, however the cache is spent', () => {
  const big = (runId: string, n: number) =>
    parseStatus(JSON.stringify({ runId, state: 'running', agents: [], steps: [], questions: Array.from({ length: n }, (_, i) => ({ qid: `q${i}`, question: 'x'.repeat(400), t: i })), phases: [], result: null, live: { ok: true, questions: [] } }), 1)
  // The selected run whole fills the budget but for 1,000 characters; four watched runs come after it.
  const details = { sel: big('sel', 600), w1: big('w1', 50), w2: big('w2', 50), w3: big('w3', 50), w4: big('w4', 50) }
  const kept = boundDetails(details, ['sel', 'w1', 'w2', 'w3', 'w4'], JSON.stringify(details.sel).length + 1_000)
  expect(['sel', 'w1', 'w2', 'w3', 'w4'].map((id) => kept[id]?.questions.length ?? 0)).toEqual([600, 50, 50, 50, 50])
})

test('P2: thousands of long phase titles still leave the timeline within the $.state budget', () => {
  const text = Array.from({ length: 20_000 }, (_, i) => `${JSON.stringify({ t: i, type: 'phase', title: `phase ${i} `.padEnd(400, 'p'), phaseIndex: i })}\n`).join('')
  const whole = foldTimeline(emptyTimeline('r'), text)
  expect(JSON.stringify(whole).length).toBeGreaterThan(4_194_304)
  expect(JSON.stringify(boundTimeline(whole)).length).toBeLessThanOrEqual(3 << 20)
})

test('P2: a phase with more agents than the tab draws still spans every one of them', async ($, on) => {
  const { w } = world4(on)
  w.states.flo_a = 'completed'
  w.agents = Array.from({ length: 400 }, (_, i) => ({ index: i, label: `a${i}`, state: 'done', phase: 'Fan out', phaseIndex: 0, t: i === 399 ? 601_000 : 2_000 }))
  w.events = lines([
    { t: 1_000, type: 'run', state: 'started' },
    { t: 1_000, type: 'phase', title: 'Fan out', phaseIndex: 0 },
    ...Array.from({ length: 400 }, (_, i) => [
      { t: 1_000, type: 'agent', index: i, label: `a${i}`, state: 'running', phaseIndex: 0 },
      { t: i === 399 ? 601_000 : 2_000, type: 'agent', index: i, state: 'done', phaseIndex: 0 },
    ]).flat(),
    { t: 601_500, type: 'run', state: 'completed' },
  ])
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'tab:phases' })
  // The last agent (ending 10 minutes in) is past the tab's drawing budget, not its span.
  expect(await ui.find({ text: /^400 agents · 10m 00s/ })).toBeDefined()
  await ui.unmount()
})

// ---- Astra (gpt-6-astra xhigh) round 1 ---------------------------------------------

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function astra(on: On) {
  const clock = mock.clock(on, { now: 100_000 })
  const w = {
    states: { flo_live: 'running' } as Record<string, string>,
    toasts: [] as string[],
    startGate: null as ReturnType<typeof deferred> | null,
    statusGate: null as ReturnType<typeof deferred> | null,
    entered: null as ReturnType<typeof deferred> | null,
    starts: 0,
    transcript: '',
    events: '',
    agents: [] as object[],
  }
  mock.env(on, { HOME: '/home/t', FLOWITION_HOME: '/home/t/.flowition', FLOWITION_BIN: '/bin/flowition', PATH: '/usr/bin' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: e.path.includes('/agents/') ? w.transcript.length : e.path.endsWith('events.jsonl') ? w.events.length : 0, mtimeMs: 1, isLink: false } }))
  on('fs.list', ($, e) => ({ value: e.path.endsWith('/workflows') ? [{ name: 'demo.workflow.mjs', kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }] : [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.scroll', () => ({}))
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'mock detached launch', text: 'started detached run flo_new' }))
  on('process.run', async ($, e) => {
    const args = e.argv.slice(1).join(' ')
    if (e.argv[0] === 'pwd') return ok('/home/t')
    if (e.argv[0] === '/bin/sh') {
      const from = Number(e.argv[4]) - 1
      return ok((e.argv[5]?.includes('/agents/') ? w.transcript : w.events).slice(from, from + Number(e.argv[6])))
    }
    if (args === 'runs --json') return ok(JSON.stringify(Object.entries(w.states).map(([runId, state]) => ({ runId, state, file: 'demo.workflow.mjs', createdAt: 1000 }))))
    if (args.startsWith('status ')) {
      const runId = e.argv[2] as string
      if (runId === 'flo_live' && w.statusGate) {
        w.entered?.resolve()
        await w.statusGate.promise
      }
      return ok(JSON.stringify({ runId, state: w.states[runId], result: null, phases: [], agents: w.agents, steps: [], questions: [], live: null }))
    }
    if (args.startsWith('run ')) {
      const n = ++w.starts
      w.entered?.resolve()
      if (w.startGate) await w.startGate.promise
      w.states[`flo_started_${n}`] = 'running'
      return ok(JSON.stringify({ runId: `flo_started_${n}`, detached: true, status: 'started' }))
    }
    return ok('{"ok":true}')
  })
  return { w, clock }
}
const DEMO = '/home/t/.flowition/workflows/demo.workflow.mjs'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`A1: a second Start while the first launch is pending starts nothing more (${surface})`, async ($, on) => {
    const { w, clock } = astra(on)
    await $.command.run(flo(''))
    const ui = await $.ui.mount(PANE(surface))
    const press = async (key: string) => {
      if (surface === 'terminal') return ui.press({ key })
      await ui.pointer({ in: key, type: 'down', x: 1, y: 0, button: 'left' })
      await ui.pointer({ in: key, type: 'up', x: 1, y: 0, button: 'left' })
    }
    await press('new')
    await press(surface === 'terminal' ? `wf-pick:${DEMO}` : `wf:${DEMO}`)
    w.startGate = deferred()
    w.entered = deferred()
    const first = press('launch-start')
    await w.entered.promise
    const second = press('launch-start')
    await clock.settle()
    const pending = [w.starts, (await ui.find({ key: 'launch-start' }))?.props.label]
    w.startGate.resolve()
    await Promise.all([first, second])
    expect(pending).toEqual([1, surface === 'terminal' ? 'Starting…' : undefined])
    expect(w.starts).toBe(1)
    await ui.unmount()
  })
}

test('A2: a poll in flight never erases a run attached meanwhile, so its end is still announced', async ($, on) => {
  const { w } = astra(on)
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  w.statusGate = deferred()
  w.entered = deferred()
  const refreshing = ui.press({ key: 'refresh' })
  await w.entered.promise
  await $.tool.call({ tool: 'Bash', command: 'flowition run demo.workflow.mjs --detach' })
  w.states.flo_new = 'completed'
  w.statusGate.resolve()
  await refreshing
  w.statusGate = null
  await ui.press({ key: 'refresh' })
  expect(w.toasts.filter((t) => t.includes('flo_new') && t.includes('completed'))).toHaveLength(1)
  await ui.unmount()
})

test('A3: an ended run took from its start to its last run event, not its last agent; with none recorded, unknown', () => {
  const run = { runId: 'flo_x', state: 'completed', file: 'demo.workflow.mjs', createdAt: 1000 }
  const detail = parseStatus(JSON.stringify({ runId: 'flo_x', state: 'completed', result: { status: 'completed', result: 'ok' }, agents: [{ index: 0, state: 'done', t: 2000 }], steps: [], questions: [], phases: [] }), 700_000)
  // An operator answered ask() ten minutes after the last agent finished.
  const tl = foldTimeline(emptyTimeline('flo_x'), lines([{ t: 1000, type: 'run', state: 'started' }, { t: 1000, type: 'agent', index: 0, state: 'running' }, { t: 2000, type: 'agent', index: 0, state: 'done' }, { t: 601_000, type: 'run', state: 'completed' }]))
  expect(runDuration(run, detail, 700_000, tl)).toBe(600_000)
  // A crashed (stale) run recorded no end: unknown, not its last agent's time.
  const stale = foldTimeline(emptyTimeline('flo_x'), lines([{ t: 1000, type: 'run', state: 'started' }, { t: 2000, type: 'agent', index: 0, state: 'done' }]))
  expect(runDuration({ ...run, state: 'stale' }, { ...detail, state: 'stale' }, 700_000, stale)).toBeNull()
})

test('A4: a quiet live run on screen keeps its Elapsed moving on the poll timer alone', async ($, on) => {
  const { clock } = astra(on)
  await $.session.start({ cwd: '/home/t', surface: 'terminal', isInteractive: true })
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  await clock.advance(1000)
  const before = (await ui.find({ key: 't:time' }))?.text
  await clock.advance(30_000)
  expect((await ui.find({ key: 't:time' }))?.text).not.toBe(before)
  await ui.unmount()
})

test('A5: streamed text fragments read as one reply, and a long one keeps its newest part', async ($, on) => {
  const { w } = astra(on)
  w.agents = [{ index: 0, label: 'OpenCode', adapter: 'opencode', state: 'running' }]
  w.transcript = lines(['Hello', ' **world', '**.'].map((text, i) => ({ t: i + 1, kind: 'text', text })))
  await $.command.run(flo('flo_live'))
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'agent:0' })
  expect((await ui.findAll({ type: 'Markdown' })).map((m) => m.text)).toEqual(['Hello **world**.'])
  await ui.unmount()
  // Across reads, and past the cap: one event, its newest text kept.
  const ev = (seq: number, text: string, kind = 'text') => ({ seq, t: seq, kind, text, name: null, summary: null, input: null, output: null, isError: false, toolId: null, toolUseId: null, redacted: false, attempt: null })
  const joined = appendEvents([ev(0, 'a'.repeat(15_000))], [ev(1, 'b'.repeat(10_000)), ev(2, 'END')])
  expect([joined.length, joined[0]?.text?.endsWith('END'), joined[0]?.text?.startsWith('[… ')]).toEqual([1, true, true])
  // An attempt boundary or another kind is never joined over.
  expect(appendEvents([ev(0, 'x')], [ev(1, null as unknown as string, 'attempt'), ev(2, 'y')]).length).toBe(3)
})
