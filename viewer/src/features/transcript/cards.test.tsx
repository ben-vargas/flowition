// @vitest-environment jsdom

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DisclosureBody,
  FileChangeCard,
  GenericToolCard,
  RawGroup,
  ReasoningCard,
  TerminalCard,
  UnknownRow,
} from './Cards.js'
import type { RawItem, ReasoningItem, ToolItem, UnknownItem } from './types.js'

afterEach(cleanup)

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 't1', kind: 'tool', card: 'generic', name: 'Grep',
    input: { pattern: 'needle', nested: { a: 1 } },
    inputText: '{"pattern":"needle","nested":{"a":1}}',
    toolId: 'toolu_123456789012345',
    result: { text: 'one match', isError: false, t: 2, exitCode: null },
    approximate: false, command: null, files: [], t: 1, o: 1, attempt: 1,
    ...overrides,
  }
}

describe('transcript cards (§2.5.1)', () => {
  it('mounts a newly opened disclosure closed, then animates it open on the next frame', () => {
    let nextFrame: FrameRequestCallback | null = null
    const request = vi.spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => { nextFrame = callback; return 1 })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    function Harness() {
      const [expanded, setExpanded] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setExpanded(true)}>open disclosure</button>
          <DisclosureBody expanded={expanded}><div>animated body</div></DisclosureBody>
        </>
      )
    }

    try {
      const view = render(<Harness />)
      fireEvent.click(screen.getByText('open disclosure'))
      const body = view.container.querySelector('.collapse-body')
      expect(body).toBeTruthy()
      expect(body?.classList.contains('open')).toBe(false)
      expect(nextFrame).toBeTruthy()
      act(() => { (nextFrame as FrameRequestCallback)(0) })
      expect(view.container.querySelector('.collapse-body')?.classList.contains('open')).toBe(true)
    } finally {
      request.mockRestore()
      cancel.mockRestore()
    }
  })

  it('renders object arguments by key and pretty-prints nested values', () => {
    render(<GenericToolCard item={tool()} expanded={false} onExpanded={() => {}} />)
    expect(screen.getByText('pattern')).toBeTruthy()
    expect(screen.getByText('needle')).toBeTruthy()
    expect(screen.getByText(/"a": 1/)).toBeTruthy()
    expect(screen.getByText('one match')).toBeTruthy()
  })

  it('clamps long argument headers and persists the caller-owned expansion', () => {
    const onExpanded = vi.fn()
    const view = render(<GenericToolCard item={tool({ inputText: 'x\n'.repeat(5) })} expanded={false} onExpanded={onExpanded} />)
    expect(view.container.querySelector('.clamp3')).toBeTruthy()
    fireEvent.click(screen.getByText('Show more'))
    expect(onExpanded).toHaveBeenCalledWith(true)
  })

  it('does not fabricate a terminal exit code', () => {
    render(<TerminalCard item={tool({ card: 'terminal', command: 'false', name: 'shell', result: { text: 'bad', isError: true, t: 2, exitCode: null } })} expanded onExpanded={() => {}} />)
    expect(screen.queryByText(/exit code/)).toBeNull()
    expect(screen.getByText('command reported an error')).toBeTruthy()
  })

  it('renders an adapter-reported terminal exit code', () => {
    render(<TerminalCard item={tool({ card: 'terminal', command: 'false', name: 'shell', result: { text: 'bad', isError: true, t: 2, exitCode: 7 } })} expanded onExpanded={() => {}} />)
    expect(screen.getByText('exit code 7')).toBeTruthy()
  })

  it('shows terminal-well fades only in directions clipped by scroll metrics', async () => {
    const view = render(<TerminalCard item={tool({
      card: 'terminal',
      command: 'printf output',
      name: 'shell',
      result: { text: 'line\n'.repeat(100), isError: false, t: 2, exitCode: 0 },
    })} expanded onExpanded={() => {}} />)
    const well = view.container.querySelector<HTMLElement>('.well-b')!
    let scrollTop = 0
    Object.defineProperties(well, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 500 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })

    fireEvent.scroll(well)
    await waitFor(() => {
      expect(well.classList.contains('fade-t')).toBe(false)
      expect(well.classList.contains('fade-b')).toBe(true)
    })
    scrollTop = 200
    fireEvent.scroll(well)
    await waitFor(() => {
      expect(well.classList.contains('fade-t')).toBe(true)
      expect(well.classList.contains('fade-b')).toBe(true)
    })
    scrollTop = 400
    fireEvent.scroll(well)
    await waitFor(() => {
      expect(well.classList.contains('fade-t')).toBe(true)
      expect(well.classList.contains('fade-b')).toBe(false)
    })
  })

  it('a mouseup after text selection does not toggle a terminal card', () => {
    const onExpanded = vi.fn()
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'selected',
    } as Selection)
    const view = render(<TerminalCard item={tool({ card: 'terminal', command: 'echo selected', name: 'shell' })} expanded={false} onExpanded={onExpanded} />)
    fireEvent.mouseUp(view.container.querySelector('.well-h')!)
    fireEvent.click(view.container.querySelector('.well-h')!)
    expect(onExpanded).not.toHaveBeenCalled()
    selection.mockRestore()
  })

  it('keeps the terminal disclosure keyboard-operable', () => {
    const onExpanded = vi.fn()
    render(<TerminalCard item={tool({ card: 'terminal', command: 'pwd', name: 'shell' })} expanded={false} onExpanded={onExpanded} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onExpanded).toHaveBeenCalledWith(true)
  })

  it('renders one file row with computed stats and classified diff lines', () => {
    const item = tool({
      card: 'file',
      name: 'Edit',
      files: [{
        action: 'edited', path: 'src/a.js', movePath: null,
        diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1,
      }],
    })
    const view = render(<FileChangeCard item={item} expanded onExpanded={() => {}} />)
    expect(screen.getByText('src/a.js')).toBeTruthy()
    expect(screen.getByText('+1')).toBeTruthy()
    expect(screen.getByText('−1')).toBeTruthy()
    expect(view.container.querySelectorAll('.dl.add')).toHaveLength(1)
    expect(view.container.querySelectorAll('.dl.del')).toHaveLength(1)
  })

  it('renders an explicit no-diff card', () => {
    render(<FileChangeCard item={tool({ card: 'file', files: [{ action: 'edited', path: 'a', movePath: null, diff: null, additions: 0, deletions: 0 }] })} expanded onExpanded={() => {}} />)
    expect(screen.getByText('no diff available')).toBeTruthy()
  })

  it('records and renders each file-row disclosure independently', async () => {
    const item = tool({
      card: 'file',
      files: [
        { action: 'edited', path: 'src/a.js', movePath: null, diff: '+first-file-change', additions: 1, deletions: 0 },
        { action: 'edited', path: 'src/b.js', movePath: null, diff: '+second-file-change', additions: 1, deletions: 0 },
      ],
    })
    function Harness() {
      const [manual, setManual] = useState<Record<string, boolean>>({})
      return (
        <FileChangeCard
          item={item}
          expanded={false}
          onExpanded={() => {}}
          manual={manual}
          onManual={(id, expanded) => setManual((current) => ({ ...current, [id]: expanded }))}
        />
      )
    }
    const view = render(<Harness />)
    const first = screen.getByText('src/a.js').closest('button')!
    const second = screen.getByText('src/b.js').closest('button')!
    expect(screen.queryByText('+first-file-change')).toBeNull()
    expect(screen.queryByText('+second-file-change')).toBeNull()

    fireEvent.click(first)
    expect(await screen.findByText('+first-file-change')).toBeTruthy()
    expect(screen.queryByText('+second-file-change')).toBeNull()
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(second.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(second)
    expect(await screen.findByText('+second-file-change')).toBeTruthy()
    expect(screen.getByText('+first-file-change')).toBeTruthy()
    fireEvent.click(first)
    expect(screen.getByText('+first-file-change')).toBeTruthy()
    fireEvent.transitionEnd(first.nextElementSibling!)
    await waitFor(() => expect(screen.queryByText('+first-file-change')).toBeNull())
    expect(screen.getByText('+second-file-change')).toBeTruthy()
    await waitFor(() => expect(view.container.querySelectorAll('.collapse-body.open')).toHaveLength(1))
  })

  it('reasoning is collapsed with a one-line preview', () => {
    const item: ReasoningItem = { id: 'r', kind: 'reasoning', text: 'line one\nline two', t: 1, o: 1, attempt: 1 }
    const view = render(<ReasoningCard item={item} expanded={false} onExpanded={() => {}} />)
    expect(view.container.querySelector('.prev')?.textContent).toBe('line one line two')
    expect(screen.getByText('2 lines')).toBeTruthy()
    expect(view.container.querySelector('.reason .prose')).toBeNull()
  })

  it('textless reasoning renders as a compact non-expandable redaction row', () => {
    // Claude ≥2.1 headless redacts thinking; old journals hold {kind:'reasoning', text:''}
    const item: ReasoningItem = { id: 'r', kind: 'reasoning', text: '', t: 1, o: 1, attempt: 1 }
    const view = render(<ReasoningCard item={item} expanded={false} onExpanded={() => {}} />)
    expect(screen.getByText('text withheld by the CLI')).toBeTruthy()
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
    expect(screen.queryByText(/line/)).toBeNull()
  })

  it('whitespace-only reasoning is treated as textless, not an expandable blank', () => {
    const item: ReasoningItem = { id: 'r', kind: 'reasoning', text: '\n \n', t: 1, o: 1, attempt: 1 }
    const view = render(<ReasoningCard item={item} expanded={false} onExpanded={() => {}} />)
    expect(screen.getByText('text withheld by the CLI')).toBeTruthy()
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('raw lines render as one collapsed group', () => {
    const item: RawItem = { id: 'r', kind: 'raw', lines: ['a', 'b'], t: 1, o: 1, attempt: 1 }
    render(<RawGroup item={item} expanded={false} onExpanded={() => {}} />)
    expect(screen.getByText('2 unparsed provider lines')).toBeTruthy()
    expect(screen.queryByText(/^a\nb$/)).toBeNull()
  })

  it('unknown future records are neutral and inspectable', () => {
    const item: UnknownItem = { id: 'u', kind: 'unknown', value: { kind: 'future', ok: true }, t: 1, o: 1, attempt: 1 }
    render(<UnknownRow item={item} expanded onExpanded={() => {}} />)
    expect(screen.getByText('unknown transcript kind — newer engine?')).toBeTruthy()
    expect(screen.getByText(/"ok": true/)).toBeTruthy()
  })
})
