// Regressions from the adversarial review loop (gpt-6.1-sol, round 1): each test fails
// on the code before its fix.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
  await ui.input({ key: `launch-args:${root}a.workflow.mjs`, text: '{"target":"A"}', kind: 'change' })
  await ui.press({ key: `wf-pick:${root}b.workflow.mjs` })
  w.calls.length = 0
  await ui.press({ key: 'launch-start' })
  expect(w.calls).toContain(`run ${root}b.workflow.mjs --detach --json`)
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
