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
