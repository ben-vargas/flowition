import { expect, mock, test } from 'claude-code/testing'

const RUNS = JSON.stringify([
  { runId: 'flo_live', state: 'running', file: 'review.workflow.mjs', createdAt: 1000 },
  { runId: 'flo_old', state: 'completed', file: 'hello.workflow.js', createdAt: 500 },
])
const STATUS = JSON.stringify({
  runId: 'flo_live',
  state: 'running',
  result: null,
  phases: ['Verify'],
  agents: [{ index: 0, label: 'opus', adapter: 'claude', model: 'claude-opus-5-5', state: 'running', tool: 'Read' }],
  steps: [],
  questions: [{ qid: 'q1', question: 'Ship it?' }],
  live: { ok: true, spentOutputTokens: 1200 },
})

const TRANSCRIPT =
  [
    { t: 1, kind: 'meta', index: 0, label: 'opus', prompt: 'Review the auth module' },
    { t: 2, kind: 'tool', name: 'Bash', input: '{"command":"sleep 60"}', id: 'tu1' },
    { t: 3, kind: 'tool-result', output: 'slept', isError: false, toolUseId: 'tu1' },
    { t: 4, kind: 'text', text: 'Reviewing **auth** now.' },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n'

const EVENTS =
  [
    { t: 1, type: 'run', state: 'started', phases: [{ title: 'Verify' }, { title: 'Ship' }] },
    { t: 1, type: 'phase', phaseIndex: 0, title: 'Verify' },
    { t: 2, type: 'agent', index: 0, label: 'opus', adapter: 'claude', state: 'queued', phaseIndex: 0 },
    { t: 3, type: 'agent', index: 0, state: 'running', phaseIndex: 0 },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n'

const PANE = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'flowition-cockpit',
    surface,
    component: 'Pane',
    requestId: 'flo',
    props: { title: 'Flowition', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: 160, rows: 40 },
  }) as const

test('the pane lists runs, drills into one, and answers, steers and cancels through the CLI', async ($, on) => {
  const calls: string[] = []
  mock.clock(on)
  mock.env(on, { HOME: '/home/t', FLOWITION_HOME: '/home/t/.flowition', FLOWITION_BIN: '/bin/flowition', PATH: '/usr/bin' })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: e.path.endsWith('.jsonl') ? TRANSCRIPT.length : 0, mtimeMs: 1, isLink: false } }))
  on('fs.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    if (e.argv[0] === '/bin/sh') {
      const stdout = e.argv[2]?.includes('grep') ? EVENTS : TRANSCRIPT
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const args = e.argv.slice(1).join(' ')
    calls.push(args)
    const stdout =
      args === 'runs --json'
        ? RUNS
        : args.startsWith('status flo_live')
          ? STATUS
          : args.startsWith('send')
            ? '{"ok":true,"delivery":"live"}'
            : args.startsWith('answer') || args.startsWith('cancel')
              ? '{"ok":true}'
              : '[]'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.command.run({ command: 'flo', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    const isDesktop = surface === 'desktop'
    // The desktop draws controls as Client faces, clicked by pointer (down, then up
    // inside); the terminal draws native Buttons, pressed by key.
    const click = async (key: string) => {
      await ui.pointer({ in: key, type: 'down', x: 1, y: 0, button: 'left' })
      await ui.pointer({ in: key, type: 'up', x: 1, y: 0, button: 'left' })
    }
    const press = (key: string) => (isDesktop ? click(key) : ui.press({ key }).then(() => undefined))
    const findText = (key: string, text: RegExp) => (isDesktop ? ui.find({ in: key, text }) : ui.find({ key, text }))
    const runKey = (id: string) => (isDesktop ? `card:${id}` : `open:${id}`)
    const agentKey = (i: number) => (isDesktop ? `agentcard:${i}` : `agent:${i}`)
    // A sent field is redrawn under a new key (so it draws empty): find it by prefix.
    const field = async (prefix: string) => {
      const found = (await ui.findAll({ type: 'Input' })).find((f) => f.key?.startsWith(prefix))
      expect(found).toBeDefined()
      return found?.key ?? ''
    }

    await press('refresh')
    expect(await ui.find({ text: /1 live · 2 total/ })).toBeDefined()
    expect(await ui.find({ key: runKey('flo_old') })).toBeDefined()
    if (isDesktop) {
      // A release dragged outside the card cancels; a trackpad tap (down and up at once,
      // no redraw between) still presses — see the click() helper's own down/up.
      await ui.pointer({ in: runKey('flo_old'), type: 'down', x: 1, y: 0, button: 'left' })
      await ui.pointer({ in: runKey('flo_old'), type: 'leave', x: -5, y: 0 })
      await ui.pointer({ in: runKey('flo_old'), type: 'up', x: -5, y: 0, button: 'left' })
      expect(await ui.find({ key: runKey('flo_old') })).toBeDefined()
      // A hover alone opens nothing.
      await ui.pointer({ in: runKey('flo_live'), type: 'enter', x: 1, y: 0 })
      expect(await ui.find({ text: /1 live · 2 total/ })).toBeDefined()
    }
    await press(runKey('flo_live'))
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(await findText(agentKey(0), /#0\s+opus/)).toBeDefined()
    // On the desktop the agent's stats are inside its clickable face too.
    if (isDesktop) expect(await ui.find({ in: agentKey(0), text: /using Read/ })).toBeDefined()
    expect(await ui.find({ text: /Ship it\?/ })).toBeDefined()

    calls.length = 0
    await ui.input({ key: await field('answer:q1:'), text: 'yes, ship' })
    expect(calls).toContain('answer flo_live q1 -- yes, ship')

    await press('steer:flo_live:0')
    await ui.input({ key: await field('steer-input:flo_live:0:'), text: '--focus on auth' })
    expect(calls).toContain('send flo_live 0 -- --focus on auth')

    await press('cancel:flo_live:0')
    expect(await ui.find({ text: /Stop opus now\?/ })).toBeDefined()
    expect(calls.some((c) => c.startsWith('cancel'))).toBe(false)
    await press('cancel-yes:flo_live:0')
    expect(calls).toContain('cancel flo_live --agent 0')

    await press('wake')
    expect(await findText('wake', /Claude will be told/)).toBeDefined()
    await press('wake')

    // The agent's thread: its task, its tool call (expandable), its reply, a composer.
    await press(agentKey(0))
    expect(await ui.find({ text: /Review the auth module/ })).toBeDefined()
    expect(await findText('tool:1', /Bash\s+sleep 60/)).toBeDefined()
    await press('tool:1')
    expect(await ui.find({ text: /slept/ })).toBeDefined()
    expect(await ui.find({ text: /Reviewing \*\*auth\*\* now/ })).toBeDefined()
    calls.length = 0
    await ui.input({ key: await field('composer:flo_live:0:'), text: 'wrap up' })
    expect(calls).toContain('send flo_live 0 -- wrap up')
    await press('back-run')
    expect(await ui.find({ key: agentKey(0) })).toBeDefined()

    // The Timeline and Phases tabs.
    await press('tab:timeline')
    expect(await ui.find({ key: 'lane:a:0' })).toBeDefined()
    expect(await ui.find({ text: /waiting for a slot/ })).toBeDefined()
    await press('tab:phases')
    expect(await ui.find({ key: 'phase:0' })).toBeDefined()
    expect(await ui.find({ text: /1\. Verify/ })).toBeDefined()
    expect(await ui.find({ text: /2\. Ship/ })).toBeDefined()
    expect(await ui.find({ text: /Not reached\./ })).toBeDefined()
    await press('tab:agents')
    expect(await ui.find({ key: agentKey(0) })).toBeDefined()

    // One click on Back returns to the list.
    await press('back')
    expect(await ui.find({ key: runKey('flo_old') })).toBeDefined()
    await ui.unmount()
  }
})
