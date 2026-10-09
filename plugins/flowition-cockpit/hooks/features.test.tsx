import { expect, mock, test } from 'claude-code/testing'

const WF = '/home/t/.flowition/workflows/demo/broken.workflow.mjs'
const RUNS = JSON.stringify([
  { runId: 'flo_live', state: 'running', file: 'review.workflow.mjs', createdAt: 3000 },
  { runId: 'flo_bad', state: 'failed', file: 'broken.workflow.mjs', createdAt: 2000 },
  { runId: 'flo_old', state: 'completed', file: 'hello.workflow.js', createdAt: 1000 },
])
const status = (runId: string, state: string) =>
  JSON.stringify({
    runId,
    state,
    result: state === 'failed' ? { status: 'failed', error: 'agent [0] boom' } : null,
    phases: ['Fan'],
    agents: [{ index: 0, label: 'a', adapter: 'claude', model: 'm', state: state === 'running' ? 'running' : 'done', phaseIndex: 0 }],
    steps: [],
    questions: [],
    live: null,
  })
const PATH = (i: number, s: number) => [{ kind: 'pipeline', ordinal: 0, count: 2, stages: 2 }, { kind: 'item', i }, { kind: 'stage', s }]
const EVENTS = [
  { t: 1, type: 'run', state: 'started', workflowFile: WF, phases: [{ title: 'Fan' }] },
  { t: 1, type: 'phase', phaseIndex: 0, title: 'Fan' },
  { t: 2, type: 'agent', index: 0, label: 'research:0', adapter: 'claude', state: 'queued', phaseIndex: 0, path: PATH(0, 0) },
  { t: 3, type: 'agent', index: 0, state: 'running', phaseIndex: 0, path: PATH(0, 0) },
  { t: 4, type: 'mail', agent: 0, dir: 'out', message: 'halfway there' },
  { t: 5, type: 'agent', index: 0, state: 'done', durationMs: 2000, phaseIndex: 0, path: PATH(0, 0) },
  { t: 6, type: 'agent', index: 1, label: 'verify:0', adapter: 'codex', state: 'queued', phaseIndex: 0, path: PATH(0, 1) },
  { t: 7, type: 'log', message: 'one claim held up' },
]
  .map((r) => JSON.stringify(r))
  .join('\n') + '\n'

const slice = (text: string, argv: readonly string[]) => text.slice(Number(argv[4]) - 1, Number(argv[4]) - 1 + Number(argv[6]))

const PANE = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'flowition-cockpit',
    surface,
    component: 'Pane',
    requestId: 'flo',
    props: { title: 'Flowition', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: 160, rows: 40 },
  }) as const

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const entry = (name: string, kind: 'file' | 'dir', mtimeMs = 5) => ({ name, kind, size: 1, mtimeMs, isLink: false })
// More workflows than the form lists at first: the filter and Show more must reach them all.
const MANY = Array.from({ length: 25 }, (_, i) => entry(`wf-${String(i).padStart(2, '0')}.workflow.mjs`, 'file'))

test('log, structure, filters, search, new run, resume and delete', async ($, on) => {
  const calls: string[] = []
  mock.clock(on)
  mock.env(on, { HOME: '/home/t', FLOWITION_HOME: '/home/t/.flowition', FLOWITION_BIN: '/bin/flowition', PATH: '/usr/bin' })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: e.path.endsWith('events.jsonl') ? EVENTS.length : 0, mtimeMs: 1, isLink: false } }))
  on('fs.list', ($, e) => ({
    value: e.path === '/home/t/.flowition/workflows' ? [entry('demo', 'dir')] : e.path.endsWith('/workflows/demo') ? [entry('broken.workflow.mjs', 'file', 10), ...MANY] : [],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const [bin, ...rest] = e.argv
    if (bin === '/bin/sh') return ok(e.argv[5]?.endsWith('events.jsonl') ? slice(EVENTS, e.argv) : '')
    if (bin === 'head') return ok(EVENTS.split('\n')[0] ?? '')
    if (bin === 'pwd') return ok('/home/t/proj\n')
    const args = rest.join(' ')
    calls.push(args)
    if (args === 'runs --json') return ok(RUNS)
    for (const [id, state] of [['flo_live', 'running'], ['flo_bad', 'failed'], ['flo_old', 'completed'], ['flo_new', 'running']] as const) {
      if (args.startsWith(`status ${id}`)) return ok(status(id, state))
    }
    if (args.startsWith('run ')) return ok(JSON.stringify({ runId: args.includes('--resume') ? 'flo_bad' : 'flo_new', detached: true, status: 'started' }))
    if (args.startsWith('rm ')) return ok('{}')
    return ok('[]')
  })

  await $.command.run({ command: 'flo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    const isDesktop = surface === 'desktop'
    const click = async (key: string) => {
      await ui.pointer({ in: key, type: 'down', x: 1, y: 0, button: 'left' })
      await ui.pointer({ in: key, type: 'up', x: 1, y: 0, button: 'left' })
    }
    const press = (key: string) => (isDesktop ? click(key) : ui.press({ key }).then(() => undefined))
    const runKey = (id: string) => (isDesktop ? `card:${id}` : `open:${id}`)
    const has = async (key: string) => (await ui.find({ key })) !== undefined
    await press('refresh')

    // Filters and search narrow the list.
    expect(await ui.find({ text: /1 live · 3 total/ })).toBeDefined()
    await press('filter:attention')
    expect(await has(runKey('flo_bad'))).toBe(true)
    expect(await has(runKey('flo_old'))).toBe(false)
    await press('filter:all')
    await ui.input({ key: 'search', text: 'hello', kind: 'change' })
    expect(await has(runKey('flo_old'))).toBe(true)
    expect(await has(runKey('flo_bad'))).toBe(false)
    await ui.input({ key: 'search', text: '', kind: 'change' })

    // Log and Structure, on the failed run.
    await press(runKey('flo_bad'))
    await press('tab:log')
    expect(await ui.find({ text: /one claim held up/ })).toBeDefined()
    expect(await ui.find({ text: /research:0: halfway there/ })).toBeDefined()
    await press('tab:structure')
    expect(await ui.find({ key: 'fan:/pipeline#0' })).toBeDefined()
    expect(await ui.find({ text: /pipeline\(2\) · 2 stages/ })).toBeDefined()
    await press('tab:agents')

    // Resume (two presses) relaunches it detached from its workflow file.
    calls.length = 0
    await press('resume')
    expect(calls.some((c) => c.includes('--resume'))).toBe(false)
    await press('resume-yes')
    expect(calls).toContain(`run ${WF} --resume flo_bad --detach --json`)

    // Delete (two presses) moves it to the trash and goes back to the list.
    await press('delete')
    await press('delete-yes')
    expect(calls).toContain('rm flo_bad --json')
    expect(await has('new')).toBe(true)

    // Many redraws later, every control still answers its first press.
    for (let k = 0; k < 6; k++) await press(k % 2 ? 'filter:all' : 'filter:completed')

    // New run: every workflow is reachable (a filter, then Show more), then pick, start.
    await press('new')
    const wfKey = (name: string) => (isDesktop ? `wf:/home/t/.flowition/workflows/demo/${name}` : `wf-pick:/home/t/.flowition/workflows/demo/${name}`)
    expect(await has(wfKey('wf-24.workflow.mjs'))).toBe(false)
    expect(await has('launch-more')).toBe(true)
    await ui.input({ key: 'launch-filter', text: 'wf-24', kind: 'change' })
    expect(await has(wfKey('wf-24.workflow.mjs'))).toBe(true)
    expect(await has(wfKey('wf-03.workflow.mjs'))).toBe(false)
    await ui.input({ key: 'launch-filter', text: '', kind: 'change' })
    await press('launch-more')
    expect(await has(wfKey('wf-24.workflow.mjs'))).toBe(true)
    await press(isDesktop ? `wf:${WF}` : `wf-pick:${WF}`)
    expect(await ui.find({ text: /full permissions in \/home\/t\/proj/ })).toBeDefined()
    calls.length = 0
    await press('launch-start')
    expect(calls).toContain(`run ${WF} --detach --json`)
    expect(await ui.find({ text: /flo_new/ })).toBeDefined()
    await press('back')
    await ui.unmount()
  }
})
