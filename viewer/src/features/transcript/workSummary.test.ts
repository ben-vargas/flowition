import { describe, expect, it } from 'vitest'

import { buildWorkSummaryLabel, classifyCommand, tokenizeShell } from './workSummary.js'
import type { ToolItem } from './types.js'

let id = 0
function tool(name: string, commandOrInput: string | Record<string, unknown>): ToolItem {
  const terminal = name === 'shell'
  return {
    id: `t${id++}`, kind: 'tool', card: terminal ? 'terminal' : 'generic',
    name, input: commandOrInput,
    inputText: typeof commandOrInput === 'string' ? commandOrInput : JSON.stringify(commandOrInput),
    command: terminal ? String(commandOrInput) : null,
    files: [], toolId: null, result: null, approximate: false,
    t: 1, o: id, attempt: 1,
  }
}

describe('shell work classification', () => {
  it.each([
    ['rg needle src', false, 1],
    ['grep -C 3 needle src/file.js', false, 1],
    ['find src -maxdepth 2 -name "*.js"', false, 1],
    ['cat src/a.js', false, 1],
    ['head -n 20 src/a.js', false, 1],
    ['tail -c 4 src/a.js', false, 1],
    ['sed -n "1,20p" src/a.js', false, 1],
    ['ls src', false, 1],
    ['VAR=x rg needle src', false, 1],
    ['rg needle src 2>/dev/null', false, 1],
    ['rg needle src 2>&1', false, 1],
    ['rg needle src >&2', false, 1],
    ['rg needle src 1>>log', true, 0],
    ['rg needle src >out', true, 0],
    ['cat src/a | tee copy', true, 0],
    ['sed -i "s/a/b/" src/a', true, 0],
    ['sed --in-place=.bak "s/a/b/" src/a', true, 0],
    ['cat src/a && printf x >out', true, 0],
  ])('%s → write=%s, explorations=%s', (command, write, explorations) => {
    const result = classifyCommand(command)
    expect(result.write).toBe(write)
    expect(result.explorations).toHaveLength(explorations)
  })

  it('keeps quoted pipes and escaped whitespace inside tokens', () => {
    const tokens = tokenizeShell('rg "a|b" path\\ with\\ spaces | head -n 2 x')
    expect(tokens.slice(0, 5)).toEqual([
      { value: 'rg', quoted: false, redirect: false },
      { value: 'a|b', quoted: true, redirect: false },
      { value: 'path with spaces', quoted: false, redirect: false },
      { break: '|' },
      { value: 'head', quoted: false, redirect: false },
    ])
  })
})

describe('work summary labels', () => {
  it('dedupes explored files and preserves first-seen category order', () => {
    const label = buildWorkSummaryLabel([
      tool('Read', { file_path: 'a' }),
      tool('Grep', { pattern: 'x', path: 'src' }),
      tool('Read', { file_path: 'a' }),
    ])
    expect(label).toBe('Explored 1 file, searched 1 time')
  })

  it('summarizes commands, files and searches', () => {
    const label = buildWorkSummaryLabel([
      tool('shell', 'cat a'),
      tool('shell', 'rg x src'),
      tool('shell', 'git status'),
    ])
    expect(label).toBe('Ran 3 commands, explored 1 file, searched 1 time')
  })

  it('uses active gerunds at the live frontier', () => {
    expect(buildWorkSummaryLabel([tool('shell', 'cat a')], true)).toBe('Running 1 command, exploring 1 file')
  })

  it('falls back honestly for opaque tools', () => {
    expect(buildWorkSummaryLabel([tool('Mystery', {})])).toBe('Ran 1 tool')
    expect(buildWorkSummaryLabel([], false)).toBe('Worked')
  })

  it('uses honest tense for one file action and collapses mixed actions to edited', () => {
    const item = tool('fileChange', {}) as ToolItem
    item.card = 'file'
    item.files = [
      { action: 'created', path: 'a', movePath: null, diff: '+x', additions: 1, deletions: 0 },
    ]
    expect(buildWorkSummaryLabel([item])).toBe('Created 1 file')
    expect(buildWorkSummaryLabel([item], true)).toBe('Creating 1 file')

    item.files.push(
      { action: 'deleted', path: 'b', movePath: null, diff: '-x', additions: 0, deletions: 1 },
    )
    expect(buildWorkSummaryLabel([item])).toBe('Edited 2 files')
  })
})
