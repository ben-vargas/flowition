import type { RunCommand } from './lib'
import { describe, expect, test } from 'claude-code/testing'

import {
  deepLink,
  extractRunId,
  badgeSvg,
  fmtDuration,
  isFlowitionLaunch,
  dayLabel,
  fmtTime,
  groupByDay,
  laneSpan,
  laneSvg,
  laneText,
  buildStructure,
  filterRuns,
  foldRepeats,
  catchUpTimeline,
  emptyTimeline,
  stateColor,
  lifetimeWorkers,
  reconcileWorkers,
  staleDetailIds,
  foldTimeline,
  parseTimeline,
  readStatus,
  shouldWake,
  stateTally,
  parseTranscript,
  phaseGroups,
  sameDetail,
  sliceLines,
  summarizeInput,
  toMarkdown,
  parseRuns,
  parseStatus,
  placeholder,
  statusLine,
  transitions,
} from './lib'

const STATUS = JSON.stringify({
  runId: 'flo_abc',
  state: 'running',
  result: null,
  phases: ['Draft', 'Verify'],
  agents: [
    { index: 1, label: 'sol', adapter: 'codex', model: 'gpt-5.6-sol', state: 'running', tool: 'Write', outputTokens: 4200 },
    { index: 0, label: 'opus', adapter: 'claude', model: 'claude-opus-5-5', state: 'done', durationMs: 167957, usage: { output: 15964, cost: 1.6 } },
  ],
  steps: [{ key: 'k1', name: 'build', state: 'running' }],
  questions: [{ qid: 'q1', question: 'Ship it?' }],
  live: { ok: true, spentOutputTokens: 20164 },
})

describe('parsing', () => {
  test('runs --json keeps the rows it can read', async () => {
    const runs = parseRuns(JSON.stringify([{ runId: 'flo_1', state: 'completed', file: 'a.workflow.js', createdAt: 5 }, { nope: 1 }]))
    expect(runs).toEqual([{ runId: 'flo_1', state: 'completed', file: 'a.workflow.js', createdAt: 5 }])
  })

  test('status --json becomes agents in index order, then steps', async () => {
    const d = parseStatus(STATUS, 10)
    expect(d.workers.map((w) => w.id)).toEqual(['a:0', 'a:1', 's:k1'])
    expect(d.workers[0]?.adapter).toBe('claude')
    expect(d.workers[0]?.model).toBe('claude-opus-5-5')
    expect(d.workers[0]?.outputTokens).toBe(15964)
    expect(d.cost).toBe(1.6)
    expect(d.spentOutputTokens).toBe(20164)
    expect(d.questions).toEqual([{ qid: 'q1', question: 'Ship it?', t: null, isOpen: true, wasOpen: true }])
  })

  test('a completed run carries its result preview', async () => {
    const d = parseStatus(JSON.stringify({ runId: 'flo_x', state: 'completed', result: { status: 'completed', result: { ok: true } } }), 0)
    expect(d.resultMarkdown).toBe('- **ok:** `true`')
  })
})

describe('launch detection', () => {
  test('matches flo and flowition run/resume, not status', async () => {
    expect(isFlowitionLaunch('flo run review.workflow.mjs --detach')).toBe(true)
    expect(isFlowitionLaunch('cd x && flowition resume flo_1 --json')).toBe(true)
    expect(isFlowitionLaunch('node bin/flowition.js run hello.workflow.js')).toBe(true)
    expect(isFlowitionLaunch('flowition status flo_1')).toBe(false)
    expect(isFlowitionLaunch('overflo run')).toBe(false)
  })

  test('reads the runId from detached text, --json and the foreground line', async () => {
    expect(extractRunId('started detached run flo_ab12cd34\n  status: …')).toBe('flo_ab12cd34')
    expect(extractRunId('{"runId":"my-audit","pid":1}')).toBe('my-audit')
    expect(extractRunId('run flo_99\n…')).toBe('flo_99')
    expect(extractRunId('nothing here')).toBe(null)
  })
})

describe('changes between polls', () => {
  test('a launched run toasts its new question and its end', async () => {
    const asked = parseStatus(STATUS, 1)
    expect(transitions(placeholder('flo_abc', 0), asked)).toEqual(['flo_abc asks: Ship it?'])
    expect(transitions(asked, asked)).toEqual([])
    const done = { ...asked, state: 'completed', questions: asked.questions }
    expect(transitions(asked, done)).toEqual(['flo_abc completed'])
  })

  test('the status line counts live runs and their questions', async () => {
    const d = parseStatus(STATUS, 1)
    expect(statusLine([{ runId: 'flo_abc', state: 'running', file: 'f', createdAt: 0 }], { flo_abc: d })).toBe('flo · 1 running · 1 question waiting')
    expect(statusLine([{ runId: 'flo_abc', state: 'completed', file: 'f', createdAt: 0 }], {})).toBe(undefined)
  })
})

test('deep links and durations', async () => {
  expect(deepLink('http://127.0.0.1:4646/#/?t=abc', 'flo_1')).toBe('http://127.0.0.1:4646/#/run/flo_1?t=abc')
  expect(fmtDuration(167957)).toBe('2m 48s')
  expect(fmtDuration(42_000)).toBe('42s')
})

describe('results as Markdown', () => {
  test('a panel of headline lists becomes headings and linked items', async () => {
    const md = toMarkdown({
      'codex:gpt-6.1-sol': [{ headline: 'Oil falls [again]', source: 'Reuters', url: 'https://x.test/a(b)', summary: 'Brent and US crude futures declined on Friday after comments on the talks.' }],
      'claude:sonnet-5.5': [],
    })
    expect(md).toContain('### codex:gpt-6.1-sol')
    expect(md).toContain('- **[Oil falls \\[again\\]](https://x.test/a%28b%29)**')
    expect(md).toContain('_source: Reuters_')
    expect(md).toContain('Brent and US crude futures declined')
    expect(md).toContain('### claude:sonnet-5.5\n\n_none_')
  })

  test('a string result is already Markdown', async () => {
    expect(toMarkdown('# Report\n\nAll good.')).toBe('# Report\n\nAll good.')
  })
})

test('a badge is an escaped SVG pill sized to its text', async () => {
  const b = badgeSvg('done')
  expect(b.source.startsWith('<svg')).toBe(true)
  expect(b.source).toContain('>done</text>')
  expect(badgeSvg('<x>').source).toContain('&lt;x&gt;')
})

describe('agent transcripts', () => {
  const LINES = [
    { t: 1, kind: 'meta', index: 0, label: 'opus', prompt: 'Do the thing' },
    { t: 2, kind: 'tool', name: 'Bash', input: '{"command":"sleep 60","description":"wait"}', id: 'tu1' },
    { t: 3, kind: 'tool-result', output: 'ok', isError: false, toolUseId: 'tu1' },
    { t: 4, kind: 'mail-in', text: 'focus on auth', id: 'm1' },
    { t: 5, kind: 'text', text: 'Done.' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n'

  test('records become numbered events with tool summaries', async () => {
    const ev = parseTranscript(LINES, 10)
    expect(ev.map((e) => e.kind)).toEqual(['meta', 'tool', 'tool-result', 'mail-in', 'text'])
    expect(ev[0]?.seq).toBe(10)
    expect(ev[0]?.text).toBe('Do the thing')
    expect(ev[1]?.summary).toBe('sleep 60')
    expect(ev[1]?.toolId).toBe('tu1')
    expect(ev[2]?.toolUseId).toBe('tu1')
  })

  test('a read keeps whole lines and says where the next read starts', async () => {
    const size = LINES.length + 7
    const { body, consumed } = sliceLines(LINES + '{"t":6,', 0, size, true)
    expect(body).toBe(LINES)
    expect(consumed).toBe(LINES.length)
    const mid = sliceLines('d":1}\n' + LINES, 100, 100 + 6 + LINES.length, false)
    expect(mid.body).toBe(LINES)
  })

  test('tool inputs summarize by the field a person names them by', async () => {
    expect(summarizeInput('{"query":"news today","mode":"extended"}')).toBe('news today')
    expect(summarizeInput({ command: ['git', 'status'] })).toBe('git status')
    expect(summarizeInput('plain text input')).toBe('plain text input')
  })
})

test('polls that differ only in when they ran, or in a live agent\'s event time, compare equal', async () => {
  const a = parseStatus(STATUS, 1)
  const later = JSON.parse(STATUS)
  later.agents[0].t = 999
  expect(sameDetail(a, parseStatus(JSON.stringify(later), 2))).toBe(true)
  later.agents[0].tool = 'Bash'
  expect(sameDetail(a, parseStatus(JSON.stringify(later), 3))).toBe(false)
})

test('recent runs group under local day headings, newest first', async () => {
  const now = new Date(2026, 9, 9, 10, 0).getTime()
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 5).getTime()
  expect(dayLabel(at(9, 1), now)).toBe('Today')
  expect(dayLabel(at(8, 23), now)).toBe('Yesterday')
  expect(dayLabel(at(1, 12), now)).toBe('Thu, Oct 1')
  expect(dayLabel(new Date(2025, 11, 29, 9).getTime(), now)).toBe('Mon, Dec 29, 2025')
  expect(fmtTime(at(9, 9))).toBe('09:05')
  const groups = groupByDay([{ createdAt: at(9, 9) }, { createdAt: at(8, 20) }, { createdAt: at(8, 7) }], now)
  expect(groups.map((g) => [g.label, g.runs.length])).toEqual([['Today', 1], ['Yesterday', 2]])
})

describe('timeline and phases', () => {
  const EVENTS = [
    { t: 1000, type: 'run', state: 'started', phases: [{ title: 'Ask' }, { title: 'Panel' }, { title: 'Verdict' }] },
    { t: 1000, type: 'phase', phaseIndex: 0, title: 'Ask' },
    { t: 5000, type: 'phase', phaseIndex: 1, title: 'Panel' },
    { t: 5000, type: 'agent', index: 0, label: 'a', adapter: 'claude', state: 'queued', phaseIndex: 1 },
    { t: 5000, type: 'agent', index: 1, label: 'b', adapter: 'codex', state: 'queued', phaseIndex: 1 },
    { t: 5001, type: 'agent', index: 0, state: 'running', phaseIndex: 1 },
    { t: 7000, type: 'agent', index: 1, state: 'running', phaseIndex: 1 },
    { t: 9000, type: 'agent', index: 0, state: 'done', phaseIndex: 1 },
  ].map((r) => JSON.stringify(r)).join('\n')

  test('events fold into lanes with their own queue, start and end times', async () => {
    const tl = parseTimeline(EVENTS, 'flo_x', 99)
    expect(tl.declaredPhases).toEqual(['Ask', 'Panel', 'Verdict'])
    expect(tl.phases.map((p) => p.title)).toEqual(['Ask', 'Panel'])
    expect(tl.lanes.map((l) => [l.id, l.state, l.queuedAt, l.startedAt, l.endedAt])).toEqual([
      ['a:0', 'done', 5000, 5001, 9000],
      ['a:1', 'running', 5000, 7000, null],
    ])
  })

  test('an open bar reaches now only while the run lives', async () => {
    const lane = parseTimeline(EVENTS, 'flo_x', 99).lanes[1]!
    expect(laneSpan(lane, 20_000, true)).toEqual({ waitFrom: 5000, from: 7000, to: 20_000 })
    expect(laneSpan(lane, 20_000, false)).toEqual({ waitFrom: 5000, from: 7000, to: 7000 })
    const bar = laneText(lane, 1000, 21_000, 20, 21_000, true)
    expect([bar.lead.length, bar.wait.length, bar.run.length]).toEqual([4, 2, 14])
  })

  test('a step at the run\'s last instant still draws inside the chart', async () => {
    const closing = [
      { t: 9000, type: 'step', key: 'k', name: 'record', state: 'running' },
      { t: 9000, type: 'step', key: 'k', state: 'done' },
    ].map((r) => JSON.stringify(r)).join('\n')
    const step = parseTimeline(EVENTS + '\n' + closing, 'flo_x', 99).lanes.find((l) => l.kind === 'step')!
    const bar = laneText(step, 1000, 9000, 20, 9000, false)
    expect(bar.lead.length + bar.wait.length + bar.run.length).toBe(20)
    expect(bar.run.length).toBe(1)
    const rect = /<rect x="([0-9.]+)" y="0" width="([0-9.]+)"/.exec(laneSvg(step, 1000, 9000, 9000, false))!
    expect(Number(rect[1]) + Number(rect[2])).toBeLessThanOrEqual(1000)
    expect(Number(rect[2])).toBeGreaterThan(0)
  })

  test('a resume keeps a cached lane where it ran, and restarts a failed one', async () => {
    const resumed = [
      { t: 9500, type: 'run', state: 'failed' },
      { t: 60_000, type: 'run', state: 'started' },
      { t: 60_001, type: 'agent', index: 0, state: 'cached', phaseIndex: 1 },
      { t: 60_002, type: 'agent', index: 1, state: 'queued', phaseIndex: 1 },
      { t: 60_003, type: 'agent', index: 1, state: 'running', phaseIndex: 1 },
    ].map((r) => JSON.stringify(r)).join('\n')
    const tl = parseTimeline(EVENTS + '\n' + resumed, 'flo_x', 99)
    expect(tl.endedAt).toBe(null)
    expect(tl.lanes.map((l) => [l.state, l.queuedAt, l.startedAt, l.endedAt])).toEqual([
      ['cached', 5000, 5001, 9000],
      ['running', 60_002, 60_003, null],
    ])
  })

  test('phases list declared ones in order, with their agents, and unreached ones', async () => {
    const tl = parseTimeline(EVENTS, 'flo_x', 99)
    const workers = parseStatus(STATUS, 1).workers.map((w, i) => ({ ...w, id: `a:${i}`, phaseIndex: i < 2 ? 1 : null }))
    const groups = phaseGroups(tl, workers, [])
    expect(groups.map((g) => [g.title, g.state, g.workers.length])).toEqual([
      ['Ask', 'done', 0],
      ['Panel', 'running', 2],
      ['Verdict', 'pending', 0],
      ['Outside any phase', 'running', 1],
    ])
  })
})

describe('structure, folding and filtering', () => {
  const seg = (o: object) => ({ kind: '?', ordinal: null, count: null, stages: null, i: null, s: null, ...o })
  const lane = (id: string, at: number, path: object[]) => ({
    id, kind: 'agent' as const, index: Number(id.slice(2)), label: id, adapter: null, state: 'done', phaseIndex: null,
    queuedAt: at, startedAt: at, endedAt: at + 1, lastSeenAt: at + 1, path: path.map(seg), cost: 0, outputTokens: 0, lastPaidAt: null,
  })
  const pipe = (i: number, s: number) => [{ kind: 'pipeline', ordinal: 0, count: 2, stages: 2 }, { kind: 'item', i }, { kind: 'stage', s }]

  test('lanes fold into a tree: top-level work, then fan-outs, items in order, stages left to right', async () => {
    const tree = buildStructure([lane('a:3', 30, pipe(1, 1)), lane('a:0', 0, []), lane('a:2', 20, pipe(0, 1)), lane('a:1', 10, pipe(0, 0)), lane('a:4', 15, pipe(1, 0))])
    expect(tree.map((n) => (n.type === 'lane' ? n.lane.id : n.key))).toEqual(['a:0', '/pipeline#0'])
    const fan = tree[1]
    if (fan?.type !== 'fanout') throw new Error('expected a fan-out')
    expect(fan.items.map((it) => [it.i, it.children.map((c) => (c.type === 'lane' ? c.lane.id : '?'))])).toEqual([
      [0, ['a:1', 'a:2']],
      [1, ['a:4', 'a:3']],
    ])
  })

  test('back-to-back runs of one workflow fold; filters and search keep what they say', async () => {
    const run = (runId: string, file: string, state: string) => ({ runId, file, state, createdAt: 0 })
    const runs = [run('r1', 'a.mjs', 'completed'), run('r2', 'a.mjs', 'failed'), run('r3', 'b.mjs', 'completed'), run('r4', 'a.mjs', 'running')]
    expect(foldRepeats(runs).map((x) => (x.type === 'group' ? x.runs.map((r) => r.runId) : x.run.runId))).toEqual([['r1', 'r2'], 'r3', 'r4'])
    expect(stateTally(runs.slice(0, 2))).toBe('1 completed · 1 failed')
    expect(filterRuns(runs, 'attention', '', {}).map((r) => r.runId)).toEqual(['r2'])
    expect(filterRuns(runs, 'live', '', {}).map((r) => r.runId)).toEqual(['r4'])
    expect(filterRuns(runs, 'all', 'B.MJS', {}).map((r) => r.runId)).toEqual(['r3'])
  })
})

describe('reading a run incrementally', () => {
  const LINES = [
    { t: 1, type: 'run', state: 'started', workflowFile: '/w.mjs', phases: [{ title: 'A' }] },
    { t: 2, type: 'agent', index: 0, label: 'x', state: 'queued', phaseIndex: 0, path: [] },
    { t: 3, type: 'agent', index: 0, state: 'progress', tool: 'Bash' },
    { t: 4, type: 'agent', index: 0, state: 'running', phaseIndex: 0 },
    { t: 5, type: 'log', message: 'halfway' },
    { t: 6, type: 'agent', index: 0, state: 'done', durationMs: 2, phaseIndex: 0 },
    { t: 7, type: 'run', state: 'completed' },
  ].map((r) => JSON.stringify(r) + '\n')

  test('folding a run in pieces gives what folding it at once does', async () => {
    const whole = foldTimeline(emptyTimeline('r'), LINES.join(''))
    for (let cut = 1; cut < LINES.length; cut++) {
      const pieces = foldTimeline(foldTimeline(emptyTimeline('r'), LINES.slice(0, cut).join('')), LINES.slice(cut).join(''))
      expect(pieces).toEqual(whole)
    }
    expect(whole.lanes.map((l) => [l.state, l.queuedAt, l.startedAt, l.endedAt])).toEqual([['done', 2, 4, 6]])
    expect(whole.entries.map((en) => en.text)).toEqual(['run started', 'x started', 'halfway', 'x done in 0s', 'run completed'])
    expect(whole.endedAt).toBe(7)
  })

  test('an armed run wakes Claude when it ends, or when a first look finds it ended', async () => {
    const live = parseStatus(STATUS, 1)
    const done = { ...live, state: 'completed' }
    expect(shouldWake(live, done, true)).toBe(true)
    expect(shouldWake(undefined, done, true)).toBe(true)
    expect(shouldWake(undefined, live, true)).toBe(false)
    expect(shouldWake(done, done, true)).toBe(true) // armed just as it ended: still owed a wake
    expect(shouldWake(live, done, false)).toBe(false)
    // Not ended: a detached launch before its journal, or a status that could not be read.
    expect(shouldWake(undefined, { ...live, state: 'unknown' }, true)).toBe(false)
    expect(shouldWake(live, readStatus('not json', false, undefined, 'flo_x', 2), true)).toBe(false)
    for (const state of ['failed', 'interrupted', 'stale', 'corrupt', 'corrupt-result']) expect(shouldWake(live, { ...live, state }, true)).toBe(true)
  })
})

describe('the third review round', () => {
  test('an agent\'s cost sums every attempt, not just the last', async () => {
    const ev = [
      { t: 1, type: 'agent', index: 0, label: 'x', state: 'queued' },
      { t: 2, type: 'agent', index: 0, state: 'running' },
      { t: 3, type: 'agent', index: 0, state: 'failed', usage: { output: 10, cost: 0.25 } },
      { t: 4, type: 'agent', index: 0, state: 'queued' },
      { t: 5, type: 'agent', index: 0, state: 'running' },
      { t: 6, type: 'agent', index: 0, state: 'done', usage: { output: 30, cost: 0.5 } },
      { t: 7, type: 'agent', index: 0, state: 'cached' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n'
    const lane = foldTimeline(emptyTimeline('r'), ev).lanes[0]!
    expect([lane.cost, lane.outputTokens]).toEqual([0.75, 40])
  })

  test('a status cut at the 4 MiB cap still yields the run\'s state', async () => {
    const prev = parseStatus(STATUS, 1)
    const cut = '{"runId":"flo_abc","state":"completed","result":{"status":"completed","result":"' + 'x'.repeat(50)
    const read = readStatus(cut, true, prev, 'flo_abc', 2)
    expect(read.state).toBe('completed')
    expect(read.workers.length).toBe(prev.workers.length)
    expect(read.resultMarkdown).toContain('too large')
    expect(readStatus('not json', false, undefined, 'flo_x', 2).state).toBe('unknown')
    expect(readStatus(STATUS, false, undefined, 'flo_abc', 2).state).toBe('running')
  })

  test('only a live run\'s question needs attention', async () => {
    const d = parseStatus(STATUS, 1)
    const run = (state: string) => ({ runId: 'flo_abc', file: 'f', state, createdAt: 0 })
    expect(filterRuns([run('running')], 'attention', '', { flo_abc: d }).length).toBe(1)
    expect(filterRuns([run('completed')], 'attention', '', { flo_abc: d }).length).toBe(0)
  })
})

describe('reading events.jsonl by raw byte offsets', () => {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  // tail -c +N | head -c L, and the awk line measure, over raw bytes; stdout decoded as
  // $.process.run decodes it (a split multibyte character becomes U+FFFD).
  const fakeRun = (bytes: Uint8Array): RunCommand => async (argv) => {
    const start = Number(argv[4]) - 1
    if (argv[2]!.includes('awk')) {
      const nl = bytes.indexOf(10, start)
      return { exitCode: 0, stdout: `${nl < 0 ? bytes.length - start + 1 : nl - start + 1}\n`, isStdoutTruncated: false }
    }
    return { exitCode: 0, stdout: dec.decode(bytes.subarray(start, start + Number(argv[6]))), isStdoutTruncated: false }
  }
  const line = (o: object) => JSON.stringify(o) + '\n'
  const TEXT =
    line({ t: 1, type: 'run', state: 'started' }) +
    line({ t: 2, type: 'log', message: 'café crème brûlée'.repeat(3) }) +
    line({ t: 3, type: 'log', message: 'é'.repeat(150) }) + // 300+ bytes: longer than a chunk
    line({ t: 4, type: 'agent', index: 0, label: 'naïve', state: 'queued' }) +
    line({ t: 5, type: 'agent', index: 0, state: 'done', usage: { cost: 0.1, output: 5 } }) +
    line({ t: 6, type: 'log', message: 'ünïcödé at the end' })
  const bytes = enc.encode(TEXT)
  const strip = (t: object) => JSON.stringify({ ...t, consumed: 0, total: 0 })

  test('odd-sized chunks that split multibyte characters fold to exactly the one-shot result', async () => {
    for (const chunk of [37, 64, 101]) {
      const tl = await catchUpTimeline(emptyTimeline('r'), bytes.length, 'f', fakeRun(bytes), chunk, 1000, 4096)
      expect(tl.consumed).toBe(bytes.length)
      expect(strip(tl)).toBe(strip(foldTimeline(emptyTimeline('r'), TEXT)))
    }
  })

  test('a line too long to read is stepped over exactly, with a note, and what follows still folds', async () => {
    const tl = await catchUpTimeline(emptyTimeline('r'), bytes.length, 'f', fakeRun(bytes), 64, 1000, 200)
    expect(tl.consumed).toBe(bytes.length)
    expect(tl.entries.some((en) => en.text.includes('too large for the pane'))).toBe(true)
    expect(tl.entries.some((en) => en.text === 'ünïcödé at the end')).toBe(true)
    expect(tl.lanes[0]?.cost).toBe(0.1)
  })

  test('a last line still being written is left for the next poll', async () => {
    const partial = enc.encode(TEXT + '{"t":7,"type":"log","mess')
    const tl = await catchUpTimeline(emptyTimeline('r'), partial.length, 'f', fakeRun(partial), 64, 1000, 4096)
    expect(tl.consumed).toBe(bytes.length)
  })

  test('a malformed result.json (corrupt-result) is an error that needs attention', async () => {
    expect(stateColor('corrupt-result')).toBe('error')
    expect(filterRuns([{ runId: 'r', file: 'f', state: 'corrupt-result', createdAt: 0 }], 'attention', '', {}).length).toBe(1)
  })
})

test('a resumed run\'s current phase is the one it last entered, not a count of replays', async () => {
  const ev = [
    { t: 1, type: 'phase', phaseIndex: 0, title: 'Scout' },
    { t: 2, type: 'phase', phaseIndex: 1, title: 'Build' },
    { t: 3, type: 'run', state: 'failed' },
    { t: 4, type: 'run', state: 'resumed' },
    { t: 5, type: 'phase', phaseIndex: 0, title: 'Scout' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n'
  const tl = foldTimeline(emptyTimeline('r'), ev)
  expect(tl.currentPhase).toEqual({ index: 0, title: 'Scout' })
  expect(tl.phases.length).toBe(2)
})

describe('review loop round 1 (gpt-6.1-sol)', () => {
  test('F4: a runs listing cut at the 4 MiB cap keeps its complete rows', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ runId: `flo_${i}`, state: 'completed', file: 'w.mjs', createdAt: 100 - i }))
    const json = JSON.stringify(rows)
    const cut = json.slice(0, json.indexOf('flo_3') + 3) // mid-row
    expect(parseRuns(cut).map((r) => r.runId)).toEqual(['flo_0', 'flo_1', 'flo_2'])
    expect(parseRuns('not json')).toEqual([])
  })

  test('F1: a cached detail the list contradicts is polled again', async () => {
    const d = parseStatus(STATUS, 1)
    const list = [
      { runId: 'flo_abc', state: 'completed', file: 'f', createdAt: 0 },
      { runId: 'flo_x', state: 'running', file: 'f', createdAt: 0 },
    ]
    expect(staleDetailIds(list, { flo_abc: { ...d, state: 'failed' } })).toEqual(['flo_abc'])
    expect(staleDetailIds(list, { flo_abc: { ...d, state: 'completed' } })).toEqual([])
  })

  test('F5: fan-outs nested in different pipeline stages stay separate containers', async () => {
    const lane = (id: string, at: number, path: object[]) => ({
      id, kind: 'agent' as const, index: Number(id.slice(2)), label: id, adapter: null, state: 'done', phaseIndex: null,
      queuedAt: at, startedAt: at, endedAt: at + 1, lastSeenAt: at + 1, cost: 0, outputTokens: 0, lastPaidAt: null,
      path: path.map((o) => ({ kind: '?', ordinal: null, count: null, stages: null, i: null, s: null, ...o })),
    })
    const inStage = (s: number) => [
      { kind: 'pipeline', ordinal: 0, count: 1, stages: 2 }, { kind: 'item', i: 0 }, { kind: 'stage', s },
      { kind: 'parallel', ordinal: 0, count: 1 }, { kind: 'item', i: 0 },
    ]
    const tree = buildStructure([lane('a:0', 0, inStage(0)), lane('a:1', 10, inStage(1))])
    const pipe = tree[0]
    if (pipe?.type !== 'fanout') throw new Error('expected the pipeline')
    const nested = pipe.items[0]!.children.filter((c) => c.type === 'fanout')
    expect(nested.length).toBe(2)
  })

  test('F6: a resumed agent counts its last attempt once until the new attempt produces output', async () => {
    const lanes = parseTimeline(
      [
        { t: 1, type: 'agent', index: 0, label: 'a', state: 'queued' },
        { t: 2, type: 'agent', index: 0, state: 'running' },
        { t: 3, type: 'agent', index: 0, state: 'done', usage: { output: 100, cost: 1 } },
        { t: 10, type: 'agent', index: 0, state: 'queued' },
        { t: 11, type: 'agent', index: 0, state: 'running' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
      'r',
      0,
    ).lanes
    const worker = { ...parseStatus(STATUS, 1).workers[0]!, id: 'a:0', state: 'running', outputTokens: 100, lastOutputAt: 3 }
    expect(lifetimeWorkers([worker], lanes)[0]?.outputTokens).toBe(100)
    expect(lifetimeWorkers([{ ...worker, outputTokens: 20, lastOutputAt: 12 }], lanes)[0]?.outputTokens).toBe(120)
    // A final status too large to read leaves an old worker on the detail (isPartial): it
    // is reconciled with the lanes, so its stale live count is never added.
    const stale = reconcileWorkers([{ ...worker, outputTokens: 20, lastOutputAt: 12 }], lanes)
    expect(lifetimeWorkers(stale, lanes)[0]?.outputTokens).toBe(100)
  })
})
