import { describe, expect, it } from 'vitest'

import {
  buildFileChanges,
  diffStats,
  extractCommand,
  OLD_ATTEMPT_SENTINEL,
  synthesizeDiff,
  toItems,
} from './toItems.js'
import type { SourceRecord, ToolItem } from './types.js'

let offset = 0
const r = (kind: string, fields: Record<string, unknown> = {}): SourceRecord => ({
  o: (offset += 100),
  rec: { t: 1_700_000_000_000 + offset, kind, ...fields },
})

describe('toItems projection (§9.6)', () => {
  it('coalesces consecutive text', () => {
    offset = 0
    const p = toItems([r('text', { text: 'a' }), r('text', { text: 'b' })])
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toMatchObject({ kind: 'text', text: 'ab' })
  })

  it('coalesces consecutive reasoning', () => {
    offset = 0
    const p = toItems([r('reasoning', { text: 'a' }), r('reasoning', { text: 'b' })])
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toMatchObject({ kind: 'reasoning', text: 'ab' })
  })

  it('coalesces a run of textless reasoning records into one textless item', () => {
    // old journals hold {kind:'reasoning', text:''}; the engine now also marks redacted:true
    offset = 0
    const p = toItems([r('reasoning', { text: '' }), r('reasoning', { text: '', redacted: true })])
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toMatchObject({ kind: 'reasoning', text: '' })
  })

  it('a redaction marker coalesces into adjacent reasoning text without erasing it', () => {
    offset = 0
    const p = toItems([r('reasoning', { text: '', redacted: true }), r('reasoning', { text: 'real' })])
    expect(p.items).toHaveLength(1)
    expect(p.items[0]).toMatchObject({ kind: 'reasoning', text: 'real' })
  })

  it('cross-flushes interleaved text and reasoning', () => {
    offset = 0
    const p = toItems([r('text', { text: 'a' }), r('reasoning', { text: 'b' }), r('text', { text: 'c' })])
    expect(p.items.map((item) => item.kind)).toEqual(['text', 'reasoning', 'text'])
  })

  it('pairs parallel tool results by toolUseId → id', () => {
    offset = 0
    const p = toItems([
      r('tool', { name: 'Grep', input: '{}', id: 'A' }),
      r('tool', { name: 'Read', input: '{}', id: 'B' }),
      r('tool-result', { toolUseId: 'B', output: 'read' }),
      r('tool-result', { toolUseId: 'A', output: 'grep' }),
    ])
    const tools = p.items.filter((item): item is ToolItem => item.kind === 'tool')
    expect(tools.map((item) => item.result?.text)).toEqual(['grep', 'read'])
    expect(tools.every((item) => !item.approximate)).toBe(true)
  })

  it('uses LIFO positional fallback only for id-less old records', () => {
    offset = 0
    const p = toItems([
      r('tool', { name: 'A' }), r('tool', { name: 'B' }),
      r('tool-result', { output: 'b' }), r('tool-result', { output: 'a' }),
    ])
    const tools = p.items.filter((item): item is ToolItem => item.kind === 'tool')
    expect(tools.map((item) => item.result?.text)).toEqual(['a', 'b'])
    expect(tools.every((item) => item.approximate)).toBe(true)
  })

  it('does not let an unknown id clobber an unrelated call', () => {
    offset = 0
    const p = toItems([
      r('tool', { name: 'A', id: 'known' }),
      r('tool-result', { toolUseId: 'unknown', output: 'orphan' }),
    ])
    expect((p.items[0] as ToolItem).result).toBeNull()
    expect(p.items[1]).toMatchObject({ kind: 'orphan-result', toolUseId: 'unknown' })
  })

  it('surfaces a fully orphan id-less result', () => {
    offset = 0
    expect(toItems([r('tool-result', { output: 'orphan' })]).items[0]).toMatchObject({
      kind: 'orphan-result', result: { text: 'orphan' },
    })
  })

  it('consumes pairings so a second result becomes an orphan', () => {
    offset = 0
    const p = toItems([
      r('tool', { id: 'A' }),
      r('tool-result', { toolUseId: 'A', output: 'one' }),
      r('tool-result', { toolUseId: 'A', output: 'two' }),
    ])
    expect(p.items.map((item) => item.kind)).toEqual(['tool', 'orphan-result'])
  })

  it('keeps an adapter-reported exit code', () => {
    offset = 0
    const p = toItems([r('tool', { name: 'shell' }), r('tool-result', { output: '', exitCode: 7 })])
    expect((p.items[0] as ToolItem).result?.exitCode).toBe(7)
  })

  it('never fabricates an exit code from isError', () => {
    offset = 0
    const p = toItems([r('tool', { name: 'shell' }), r('tool-result', { output: '', isError: true })])
    expect((p.items[0] as ToolItem).result).toMatchObject({ isError: true, exitCode: null })
  })

  it('coalesces raw provider lines but not status lines', () => {
    offset = 0
    const p = toItems([r('raw', { text: 'a' }), r('raw', { text: 'b' }), r('status', { text: 's' })])
    expect(p.items).toHaveLength(2)
    expect(p.items[0]).toMatchObject({ kind: 'raw', lines: ['a', 'b'] })
  })

  it('maps mail-in and mail-out as distinct steering markers', () => {
    offset = 0
    const p = toItems([r('mail-in', { text: 'down' }), r('mail-out', { text: 'up' })])
    expect(p.items).toMatchObject([
      { kind: 'mail', direction: 'in', text: 'down' },
      { kind: 'mail', direction: 'out', text: 'up' },
    ])
  })

  it('surfaces unknown future kinds as raw objects', () => {
    offset = 0
    expect(toItems([r('future', { success: true })]).items[0]).toMatchObject({
      kind: 'unknown', value: { kind: 'future', success: true },
    })
  })

  it('maps each meta prompt and detects the explicit cap marker', () => {
    offset = 0
    const p = toItems([r('meta', { prompt: 'x… [+14 chars]', attempt: 1 })])
    expect(p.items[0]).toMatchObject({ kind: 'prompt', truncated: true })
  })

  it('splits structured attempt segments', () => {
    offset = 0
    const p = toItems([
      r('meta', { prompt: 'one', attempt: 1 }),
      r('text', { text: 'a' }),
      r('attempt', { n: 2 }),
      r('meta', { prompt: 'two', attempt: 2 }),
      r('text', { text: 'b' }),
    ])
    expect(p.attempts.map((attempt) => [attempt.n, attempt.approximate])).toEqual([[1, false], [2, false]])
    expect(p.items.at(-1)?.attempt).toBe(2)
  })

  it('does not double-split the compatibility sentinel after a structured marker', () => {
    offset = 0
    const p = toItems([
      r('text', { text: 'a' }),
      r('attempt', { n: 2 }),
      r('status', { text: OLD_ATTEMPT_SENTINEL }),
      r('text', { text: 'b' }),
    ])
    expect(p.attempts.map((attempt) => attempt.n)).toEqual([1, 2])
  })

  it('falls back to the old sentinel and labels it approximate', () => {
    offset = 0
    const p = toItems([
      r('text', { text: 'a' }),
      r('status', { text: OLD_ATTEMPT_SENTINEL }),
      r('text', { text: 'b' }),
    ])
    expect(p.attempts.at(-1)).toMatchObject({ n: 2, approximate: true })
  })

  it('uses the supplied tail attempt when a page starts after its meta record', () => {
    offset = 0
    const p = toItems([r('text', { text: 'tail' })], { initialAttempt: 4 })
    expect(p.items[0]?.attempt).toBe(4)
  })

  it('lets an observed meta attempt override a tail hint', () => {
    offset = 0
    const p = toItems([r('meta', { prompt: 'full', attempt: 1 }), r('text', { text: 'x' })], { initialAttempt: 4 })
    expect(p.items.every((item) => item.attempt === 1)).toBe(true)
  })

  it('counts backward from a structured marker when a tail page crosses attempts', () => {
    offset = 0
    const p = toItems([
      r('text', { text: 'end of three' }),
      r('attempt', { n: 4 }),
      r('meta', { prompt: 'four', attempt: 4 }),
      r('text', { text: 'four' }),
    ], { initialAttempt: 4 })
    expect(p.items.filter((item) => item.kind === 'text').map((item) => item.attempt)).toEqual([3, 4])
  })

  it('counts old sentinels backward from the snapshot attempt total', () => {
    offset = 0
    const p = toItems([
      r('text', { text: 'two' }),
      r('status', { text: OLD_ATTEMPT_SENTINEL }),
      r('text', { text: 'three' }),
      r('status', { text: OLD_ATTEMPT_SENTINEL }),
      r('text', { text: 'four' }),
    ], { initialAttempt: 4 })
    expect(p.items.filter((item) => item.kind === 'text').map((item) => item.attempt)).toEqual([2, 3, 4])
  })

  it('never pairs a result backward across an attempt boundary', () => {
    offset = 0
    const p = toItems([
      r('tool', { name: 'Read', input: '{}', id: 'reused' }),
      r('attempt', { n: 2 }),
      r('tool-result', { name: 'Read', output: 'late', toolUseId: 'reused' }),
    ])
    expect(p.items.some((item) => item.kind === 'orphan-result')).toBe(true)
    expect(p.items.find((item) => item.kind === 'tool')).toMatchObject({ result: null })
  })
})

describe.each([
  ['bash argv', ['/bin/bash', '-lc', 'echo hi'], 'echo hi'],
  ['zsh argv', ['zsh', '-c', 'pwd'], 'pwd'],
  ['non-shell argv', ['python3', '-c', 'print(1)'], 'python3 -c print(1)'],
  ['object command', { command: 'rg thing' }, 'rg thing'],
  ['object argv', { argv: ['sh', '-lc', 'ls'] }, 'ls'],
  ['plain string', 'git status', 'git status'],
])('command extraction: %s', (_name, input, expected) => {
  it(`extracts ${String(expected)}`, () => {
    expect(extractCommand(input)).toBe(expected)
  })
})

describe('file-change projection', () => {
  it('counts unified diff additions/deletions without metadata', () => {
    expect(diffStats('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new')).toEqual({ additions: 1, deletions: 1 })
  })

  it('synthesizes Edit diffs', () => {
    expect(synthesizeDiff({ old_string: 'old', new_string: 'new' }, 'edited')).toBe('-old\n+new')
  })

  it('synthesizes Write/create diffs', () => {
    expect(synthesizeDiff({ content: 'a\nb' }, 'created')).toBe('+a\n+b')
  })

  it('counts a whole-file create body without patch prefixes', () => {
    expect(buildFileChanges({ path: 'new.txt', kind: 'create', diff: 'alpha\n\nbeta\n' })[0])
      .toMatchObject({ action: 'created', additions: 2, deletions: 0 })
  })

  it('counts a whole-file delete body without patch prefixes', () => {
    expect(buildFileChanges({ path: 'old.txt', kind: 'delete', patch: 'alpha\nbeta' })[0])
      .toMatchObject({ action: 'deleted', additions: 0, deletions: 2 })
  })

  it('accepts a pre-shaped bare changes array', () => {
    const files = buildFileChanges([{ path: 'a', kind: 'create', diff: '+x' }, { path: 'b', kind: 'delete', diff: '-y' }])
    expect(files.map((file) => [file.action, file.path])).toEqual([['created', 'a'], ['deleted', 'b']])
  })

  it('accepts object-wrapped changes and rename destinations', () => {
    const files = buildFileChanges({ changes: [{ path: 'a', movePath: 'b' }] })
    expect(files[0]).toMatchObject({ action: 'renamed', path: 'a', movePath: 'b' })
  })

  it('produces an explicit no-diff model when no body can be derived', () => {
    expect(buildFileChanges({ path: 'a', kind: 'edit' })[0]).toMatchObject({ diff: null, additions: 0, deletions: 0 })
  })
})
