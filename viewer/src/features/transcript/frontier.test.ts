// §3.6's live-region logic, pure. The DOM half is `LiveFrontier.test.tsx`.
import { describe, expect, it } from 'vitest'

import {
  FRONTIER_THROTTLE_MS,
  MAX_ANNOUNCEMENT,
  MAX_IDENTIFIER,
  frontierAnnouncement,
  initialThrottle,
  speakableIdentifier,
  statusActivity,
  throttleStep,
} from './frontier.js'
import type { TimelineItem } from './types.js'

const base = { id: 'i', t: 1, o: 0, attempt: 1 }
const tool = (name: string): TimelineItem => ({
  ...base, kind: 'tool', card: 'generic', name, input: null, inputText: '',
  toolId: null, result: null, approximate: false, command: null, files: [],
})

describe('§3.6 frontier summary', () => {
  it('produces the spec’s own example sentence', () => {
    expect(frontierAnnouncement({
      agent: 'agent 3', state: 'running', live: true, latest: tool('Bash'),
    })).toBe('agent 3: running Bash')
  })

  it('never emits provider text — a text or reasoning item says only what is happening', () => {
    const text: TimelineItem = { ...base, kind: 'text', text: 'SECRET TOKEN sk-abc' }
    const reasoning: TimelineItem = { ...base, kind: 'reasoning', text: 'SECRET TOKEN sk-abc' }
    const say = (latest: TimelineItem) =>
      frontierAnnouncement({ agent: 'a', state: 'running', live: true, latest })!
    expect(say(text)).toBe('a: writing')
    expect(say(reasoning)).toBe('a: thinking')
    expect(say(text)).not.toContain('sk-abc')
    expect(say(reasoning)).not.toContain('sk-abc')
  })

  it('announces a settled agent’s outcome once and says nothing about a settled queue', () => {
    expect(frontierAnnouncement({
      agent: 'agent 1', state: 'completed', live: false, latest: tool('Read'),
    })).toBe('agent 1: completed')
    expect(frontierAnnouncement({
      agent: 'agent 1', state: 'failed', live: false, latest: null,
    })).toBe('agent 1: failed')
    // A queued agent in a dead run has no outcome to report and must not claim one.
    expect(frontierAnnouncement({
      agent: 'agent 1', state: 'queued', live: false, latest: null,
    })).toBeNull()
  })

  it('covers every projected item kind with a summary, never a dump', () => {
    const kinds: [TimelineItem, string][] = [
      [tool('Bash'), 'a: running Bash'],
      [{ ...base, kind: 'orphan-result', name: 'Read', toolUseId: null,
         result: { text: 'x', isError: false, t: 1, exitCode: null } }, 'a: Read returned'],
      [{ ...base, kind: 'prompt', text: 'p', truncated: false }, 'a: prompt sent'],
      [{ ...base, kind: 'mail', direction: 'in', text: 'go', origin: null, delivery: null }, 'a: steer received'],
      [{ ...base, kind: 'mail', direction: 'out', text: 'done', origin: null, delivery: null }, 'a: reported progress'],
      [{ ...base, kind: 'attempt', approximate: false }, 'a: new attempt'],
      [{ ...base, kind: 'raw', lines: ['x'] }, 'a: running'],
      [{ ...base, kind: 'unknown', value: {} }, 'a: running'],
    ]
    for (const [latest, expected] of kinds) {
      expect(frontierAnnouncement({ agent: 'a', state: 'running', live: true, latest }))
        .toBe(expected)
    }
  })

  it('never reads a status line’s text — every engine status maps to a fixed activity', () => {
    // The left column is what the engine actually writes (src/engine.js:994, 1060, 1073;
    // src/agent-proc.js:143, 161, 221, 232, 245, 418, 432, 528). Each tail below is the
    // part that carries provider or operator text.
    const cases: [string, string][] = [
      ['completed', 'a: completed'],
      ['cancelled: Error: sk-live-SECRET leaked', 'a: cancelled'],
      ['failed: 401 from api.example sk-live-SECRET', 'a: failed'],
      ['error: rate limited, key sk-live-SECRET', 'a: provider error'],
      ['parser exception (event skipped): sk-live-SECRET', 'a: output parse error'],
      ['parser exception at EOF: sk-live-SECRET', 'a: output parse error'],
      ['schema validation failed, requesting correction: /x sk-live-SECRET',
        'a: retrying for a valid result'],
      ['delivering 3 queued message(s) via follow-up turn', 'a: delivering queued steers'],
      ['mail dropped — agent already settled: sk-live-SECRET', 'a: steer dropped'],
      ['mail DROPPED undelivered because the provider session cannot take a follow-up turn: sk-live-SECRET',
        'a: steer dropped'],
      ['workflow mail replay-suppressed — already delivered before the interruption: sk-live-SECRET',
        'a: steer already delivered'],
      ['workflow mail replay-suppressed — the restored pending copy carries the delivery: sk-live-SECRET',
        'a: steer already delivered'],
      ['— resumed run: new attempt below —', 'a: new attempt'],
    ]
    for (const [text, expected] of cases) {
      const said = frontierAnnouncement({
        agent: 'a', state: 'running', live: true, latest: { ...base, kind: 'status', text },
      })!
      expect(said).toBe(expected)
      expect(said).not.toContain('sk-live-SECRET')
    }
  })

  it('falls back to the vaguest phrase for a status line it does not recognize', () => {
    // A newer engine's status, or an old run's: an unknown shape is still not readable.
    for (const text of [
      'quantum flux capacitor drained: sk-live-SECRET',
      'sk-live-SECRET',
      '',
      'x'.repeat(5_000),
    ]) {
      const said = frontierAnnouncement({
        agent: 'a', state: 'running', live: true, latest: { ...base, kind: 'status', text },
      })!
      expect(said).toBe('a: status update')
    }
  })

  it('bounds every announcement it can produce — nothing scales with record size', () => {
    // Every branch, every dynamic slot, at 64 KiB. Two markers, because the two kinds of
    // slot have two different contracts:
    //
    //   BODY  — a record's text, its result, its steer. §3.6 says NEVER, so `SECRET` goes
    //           here and must not appear in any sentence at all.
    //   NAME  — the agent's name and a tool's name. §3.6's own example announces one
    //           ("agent 3: running Bash"), so these are spoken — but `AgentView.label` is
    //           whatever the workflow author passed to `agent({label})` and a tool's `name`
    //           is the provider's own, so both must arrive CUT to `MAX_IDENTIFIER`. That is
    //           the regression: unbounded, a hostile label made the announcement as long as
    //           the record, which is the raw stream through a different door.
    const SECRET = 'sk-live-SECRET'
    const BODY = `${SECRET} ${'x'.repeat(64 * 1024)}`
    const NAME = 'N'.repeat(64 * 1024)
    const result = { text: BODY, isError: false, t: 1, exitCode: null }
    const kinds: TimelineItem[] = [
      { ...base, kind: 'tool', card: 'generic', name: NAME, input: null, inputText: BODY,
        toolId: BODY, result, approximate: false, command: BODY, files: [BODY] },
      { ...base, kind: 'orphan-result', name: NAME, toolUseId: BODY, result },
      { ...base, kind: 'text', text: BODY },
      { ...base, kind: 'reasoning', text: BODY },
      { ...base, kind: 'prompt', text: BODY, truncated: false },
      { ...base, kind: 'mail', direction: 'in', text: BODY, origin: null, delivery: null },
      { ...base, kind: 'mail', direction: 'out', text: BODY, origin: null, delivery: null },
      { ...base, kind: 'status', text: `cancelled: ${BODY}` },
      { ...base, kind: 'status', text: `failed: ${BODY}` },
      { ...base, kind: 'status', text: BODY },
      { ...base, kind: 'attempt', approximate: false },
      { ...base, kind: 'raw', lines: [BODY] },
      { ...base, kind: 'unknown', value: { leak: BODY } },
    ] as TimelineItem[]

    // The agent's name and the state are the remaining slots, so each item is announced with
    // an ordinary agent and with a hostile one, live and settled, including a hostile state.
    const inputs = kinds.flatMap((latest) => [
      { agent: 'a', state: 'running', live: true, latest },
      { agent: NAME, state: 'running', live: true, latest },
      { agent: NAME, state: BODY, live: false, latest },
      { agent: NAME, state: 'failed', live: false, latest },
    ])
    let seen = 0
    for (const input of [...inputs, { agent: NAME, state: BODY, live: false, latest: null }]) {
      const said = frontierAnnouncement(input)
      if (said == null) continue
      seen++
      const where = `${input.latest?.kind ?? 'no item'} / agent ${input.agent.length}ch`
      expect(said.length, `unbounded for ${where}`).toBeLessThanOrEqual(MAX_ANNOUNCEMENT)
      expect(said, `leaked a body for ${where}`).not.toContain(SECRET)
      expect(said, `leaked body text for ${where}`).not.toContain('xxxxxxxxxx')
      // A spoken NAME is spoken cut, never at length: the run of N's can be at most one
      // identifier long, and there are at most two identifiers in a sentence.
      const longest = Math.max(0, ...said.split(/[^N]+/).map((run) => run.length))
      expect(longest, `an unbounded identifier survived for ${where}`)
        .toBeLessThanOrEqual(MAX_IDENTIFIER)
    }
    // Every branch above really did produce a sentence; a silent one would prove nothing.
    expect(seen).toBe(kinds.length * 4 + 1)
  })

  it('speaks a settled state only from displayState’s own vocabulary', () => {
    const say = (state: string) =>
      frontierAnnouncement({ agent: 'a', state, live: false, latest: null })
    // `AgentState | 'orphaned'` (src/viewer/fold.d.ts:114) — each is spoken as itself.
    for (const state of ['done', 'failed', 'cancelled', 'cached', 'orphaned']) {
      expect(say(state)).toBe(`a: ${state}`)
    }
    // Anything else is an older or newer server's word, and is not repeated.
    for (const state of ['exploded: sk-live-SECRET', 'x'.repeat(9_000), '?']) {
      expect(say(state)).toBe('a: settled')
    }
  })

  it('speaks a bounded, flattened identifier or the caller’s fallback — never the raw one', () => {
    // Flattening is not cosmetic: a newline, a paragraph separator or a bidi override in a
    // label turns one announcement into something a screen reader reads as several, or reads
    // backwards. The sentence's shape belongs to this module.
    const cases: [unknown, string][] = [
      ['Bash', 'Bash'],
      ['  spaced   out\tname ', 'spaced out name'],
      ['line\none\r\ntwo', 'line one two'],
      ['left\u202Eright', 'left right'],
      ['zero\u200Bwidth', 'zero width'],
      ['\u2028\u2029\u0000', 'fb'],
      ['\u200B\u200B\u200B', 'fb'],
      ['', 'fb'],
      ['   ', 'fb'],
      [null, 'fb'],
      [undefined, 'fb'],
      [42, 'fb'],
      [{ toString: () => 'nope' }, 'fb'],
    ]
    for (const [raw, expected] of cases) {
      expect(speakableIdentifier(raw, 'fb'), `for ${JSON.stringify(raw)}`).toBe(expected)
    }
    // Long ones are cut, with the ellipsis inside the ceiling rather than beyond it.
    const long = speakableIdentifier('n'.repeat(10_000), 'fb')
    expect(long.length).toBe(MAX_IDENTIFIER)
    expect(long.endsWith('…')).toBe(true)
    // A cut never leaves half an astral character behind.
    const astral = speakableIdentifier('🙂'.repeat(10_000), 'fb')
    expect(astral.length).toBeLessThanOrEqual(MAX_IDENTIFIER)
    expect([...astral].every((ch) => ch === '🙂' || ch === '…')).toBe(true)
  })

  it('still names the tool and the agent when they are ordinary', () => {
    // The ceiling must not have cost the sentence its content: §3.6's own example survives,
    // and a real label is spoken in full.
    expect(frontierAnnouncement({
      agent: 'reviewer', state: 'running', live: true, latest: tool('Bash'),
    })).toBe('reviewer: running Bash')
    expect(frontierAnnouncement({
      agent: 'agent 3', state: 'running', live: true, latest: tool('mcp__github__list_prs'),
    })).toBe('agent 3: running mcp__github__list_prs')
  })

  it('falls back to a neutral word rather than announcing an empty name', () => {
    expect(frontierAnnouncement({
      agent: '​', state: 'running', live: true, latest: tool('\n\n'),
    })).toBe('agent: running a tool')
    expect(frontierAnnouncement({
      agent: '', state: 'running', live: true,
      latest: { ...base, kind: 'orphan-result', name: '', toolUseId: null,
        result: { text: 'x', isError: false, t: 1, exitCode: null } },
    })).toBe('agent: a tool returned')
  })

  it('maps a status text directly, so the vocabulary is testable on its own', () => {
    expect(statusActivity('  ERROR:  boom  ')).toBe('provider error')
    expect(statusActivity('completed')).toBe('completed')
    expect(statusActivity('nonsense')).toBe('status update')
  })

  it('says the agent is running before any record has arrived', () => {
    expect(frontierAnnouncement({ agent: 'a', state: 'running', live: true, latest: null }))
      .toBe('a: running')
  })
})

describe('§3.6 throttle — one announcement per 5 s', () => {
  it('fixes the window at the spec’s value', () => {
    expect(FRONTIER_THROTTLE_MS).toBe(5_000)
  })

  it('announces the first candidate immediately', () => {
    const step = throttleStep(initialThrottle(), 'a: running Bash', 1_000)
    expect(step.next.announced).toBe('a: running Bash')
    expect(step.waitMs).toBeNull()
  })

  it('holds a burst and keeps the NEWEST sentence, not the first', () => {
    let state = throttleStep(initialThrottle(), 'a: running Bash', 1_000).next
    let step = throttleStep(state, 'a: running Read', 1_500)
    expect(step.next.announced).toBe('a: running Bash')
    expect(step.next.pending).toBe('a: running Read')
    expect(step.waitMs).toBe(4_500)
    state = step.next
    step = throttleStep(state, 'a: running Grep', 2_000)
    expect(step.next.pending).toBe('a: running Grep')
    expect(step.waitMs).toBe(4_000)
    // The window opens: the held sentence is the last one, and Read never spoke.
    const opened = throttleStep(step.next, step.next.pending, 6_000)
    expect(opened.next.announced).toBe('a: running Grep')
    expect(opened.next.pending).toBeNull()
  })

  it('re-announces once the window has elapsed', () => {
    const first = throttleStep(initialThrottle(), 'one', 1_000).next
    const later = throttleStep(first, 'two', 6_000)
    expect(later.next.announced).toBe('two')
    expect(later.waitMs).toBeNull()
  })

  it('never re-announces identical text — an unchanged region is a silent one', () => {
    const first = throttleStep(initialThrottle(), 'same', 1_000).next
    const again = throttleStep(first, 'same', 90_000)
    expect(again.next.announced).toBe('same')
    expect(again.next.at).toBe(first.at)
    expect(again.waitMs).toBeNull()
  })

  it('drops a pending sentence when there is nothing left to say', () => {
    const held = throttleStep(
      throttleStep(initialThrottle(), 'one', 1_000).next, 'two', 1_100,
    ).next
    expect(held.pending).toBe('two')
    const cleared = throttleStep(held, null, 1_200)
    expect(cleared.next.pending).toBeNull()
    expect(cleared.next.announced).toBe('one')
    expect(cleared.waitMs).toBeNull()
  })
})
