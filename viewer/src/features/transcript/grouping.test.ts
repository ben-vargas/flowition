import { describe, expect, it } from 'vitest'

import { autoStepExpanded, groupTimeline, retainedManualIds } from './grouping.js'
import type { TimelineItem, ToolItem } from './types.js'

const text = (id: string): TimelineItem => ({ id, kind: 'text', text: id, t: 1, o: 1, attempt: 1 })
const tool = (id: string, pending = false): ToolItem => ({
  id, kind: 'tool', card: 'generic', name: 'tool', input: {}, inputText: '{}',
  toolId: null, result: pending ? null : { text: 'ok', isError: false, t: 2, exitCode: null },
  approximate: false, command: null, files: [], t: 1, o: 1, attempt: 1,
})

describe('step grouping', () => {
  it('groups consecutive work and closes on text/reasoning/mail boundaries', () => {
    const units = groupTimeline([tool('a'), tool('b'), text('answer'), tool('c')])
    expect(units.map((unit) => [unit.kind, unit.kind === 'step' ? unit.items.length : 1])).toEqual([
      ['step', 2], ['row', 1], ['step', 1],
    ])
  })

  it('closes a step when the attempt changes', () => {
    const second = tool('b')
    second.attempt = 2
    expect(groupTimeline([tool('a'), second]).map((unit) => unit.attempt)).toEqual([1, 2])
  })

  it('auto-expands single, pending and live-frontier steps only', () => {
    const single = groupTimeline([tool('a')])[0]!
    const pending = groupTimeline([tool('a'), tool('b', true)])[0]!
    const settled = groupTimeline([tool('a'), tool('b')])[0]!
    expect(autoStepExpanded(single, 0, 2, false)).toBe(true)
    expect(autoStepExpanded(pending, 0, 2, false)).toBe(true)
    expect(autoStepExpanded(settled, 0, 2, false)).toBe(false)
    expect(autoStepExpanded(settled, 1, 2, true)).toBe(true)
  })

  it('retains independent file-row manual ids only while their tool remains in the window', () => {
    const fileTool = {
      ...tool('files'),
      card: 'file' as const,
      files: [
        { action: 'edited' as const, path: 'a', movePath: null, diff: '+a', additions: 1, deletions: 0 },
        { action: 'edited' as const, path: 'b', movePath: null, diff: '+b', additions: 1, deletions: 0 },
      ],
    }
    const retained = retainedManualIds([fileTool])
    expect(retained.has('files:file:0')).toBe(true)
    expect(retained.has('files:file:1')).toBe(true)
    expect(retainedManualIds([]).has('files:file:0')).toBe(false)
  })
})
