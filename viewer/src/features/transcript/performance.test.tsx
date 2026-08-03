// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const markdownRenders = vi.hoisted(() => vi.fn())
vi.mock('react-markdown', async () => {
  const React = await import('react')
  return {
    default: ({ children }: { children: string }) => {
      markdownRenders()
      return React.createElement('p', null, children)
    },
  }
})

import { createTranscriptStore } from '../../state/transcriptStore.js'
import { toItems } from './toItems.js'
import type { SourceRecord, TimelineUnit, ToolItem } from './types.js'
import { VirtualTimeline } from './VirtualTimeline.js'

afterEach(cleanup)

function collect() {
  expect(global.gc, 'P6 must run in a Node process started with --expose-gc').toBeTypeOf('function')
  global.gc!()
}

describe('measured transcript budgets', () => {
  it.skipIf(process.env.FLO_PERF !== '1')(
    'P6: worst-case 20k / 8 MiB retained window stays below 150 MB heap',
    () => {
      collect()
      const before = process.memoryUsage().heapUsed
      const records: SourceRecord[] = []
      let o = 0
      for (let i = 0; i < 20_000; i++) {
        const input = `${i}:`.padEnd(330, String(i % 10))
        o += input.length + 80
        records.push({ o, rec: { t: i, kind: 'tool', name: 'Grep', input, id: `id-${i}` } })
      }
      const projected = toItems(records)
      collect()
      const retained = process.memoryUsage().heapUsed - before
      expect(projected.items).toHaveLength(20_000)
      expect(o).toBeLessThanOrEqual(8 * 1024 * 1024)
      console.log(`P6 transcript heap: ${(retained / 1024 / 1024).toFixed(1)} MiB retained`)
      expect(retained).toBeLessThan(150 * 1024 * 1024)
    },
  )

  it('P7: a sparse 500 MB transcript opens and projects its tail within 1 second', async () => {
    const size = 500 * 1024 * 1024
    const pageBytes = 2 * 1024 * 1024
    const items: { o: number; rec: Record<string, unknown> }[] = []
    let o = size - pageBytes
    for (let i = 0; i < 2_000; i++) {
      o += 1024
      items.push({ o, rec: { t: i, kind: 'text', text: `tail-${i}\n` } })
    }
    const handle = createTranscriptStore({
      runId: 'huge', index: 0,
      fetchPage: async () => ({ items, start: size - pageBytes, end: size, size, eof: true }),
    })
    const started = performance.now()
    await handle.loadTail()
    const projected = toItems(handle.store.getSnapshot().items)
    const elapsed = performance.now() - started
    expect(handle.store.getSnapshot().bytes).toBeLessThanOrEqual(pageBytes)
    expect(handle.store.getSnapshot().bytes).toBeGreaterThan(1_900_000)
    expect(projected.items.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('P9: expanding a row in a 5,000-unit virtual transcript commits within 100 ms', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600,
      width: 800, height: 600, toJSON: () => ({}),
    })
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 })
    const units = Array.from({ length: 5_000 }, (_, i): TimelineUnit => {
      const item: ToolItem = {
        id: `tool-${i}`, kind: 'tool', card: 'generic', name: 'Read',
        input: { path: `src/${i}.js` }, inputText: `{"path":"src/${i}.js"}`,
        toolId: `id-${i}`,
        result: { text: 'ok', isError: false, t: i, exitCode: null },
        approximate: false, command: null, files: [], t: i, o: i + 1, attempt: 1,
      }
      return { kind: 'step', id: `step-${i}`, items: [item], t: i, attempt: 1, pending: false }
    })

    function Harness() {
      const [manual, setManual] = useState<Record<string, boolean>>({})
      return (
        <VirtualTimeline
          units={units}
          live={false}
          oldMayBeTruncated={false}
          manual={manual}
          onManual={(id, value) => setManual((current) => ({ ...current, [id]: value }))}
        />
      )
    }

    const view = render(<div style={{ height: 600 }}><Harness /></div>)
    await waitFor(() => expect(view.container.querySelector('.step-toggle')).toBeTruthy())
    const button = view.container.querySelector<HTMLButtonElement>('.step-toggle')!
    const started = performance.now()
    fireEvent.click(button)
    const elapsed = performance.now() - started
    console.log(`P9 expand/collapse: ${elapsed.toFixed(1)} ms on 5,000 rows`)
    expect(elapsed).toBeLessThan(100)
    expect(view.container.querySelectorAll('.virtual-row').length).toBeLessThan(100)
    rect.mockRestore()
    if (height) Object.defineProperty(HTMLElement.prototype, 'clientHeight', height)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
    if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth
  })

  it('P5: live append parses only newly visible markdown rows, not the retained viewport', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600,
      width: 800, height: 600, toJSON: () => ({}),
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 72 })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 })
    const rows = (count: number): TimelineUnit[] => Array.from({ length: count }, (_, i) => ({
      kind: 'row',
      id: `text-${i}`,
      item: { id: `text-${i}`, kind: 'text', text: `answer **${i}**`, t: i, o: i + 1, attempt: 1 },
      t: i,
      attempt: 1,
    }))
    const manual = {}
    const onManual = () => {}
    markdownRenders.mockClear()
    const view = render(
      <VirtualTimeline
        units={rows(4)}
        live
        oldMayBeTruncated={false}
        manual={manual}
        onManual={onManual}
      />,
    )
    await waitFor(() => expect(markdownRenders.mock.calls.length).toBe(4))
    const before = markdownRenders.mock.calls.length
    view.rerender(
      <VirtualTimeline
        units={rows(6)}
        live
        oldMayBeTruncated={false}
        manual={manual}
        onManual={onManual}
      />,
    )
    await waitFor(() => expect(markdownRenders.mock.calls.length - before).toBe(2))
    expect(view.container.querySelectorAll('[data-timeline-row-list]')).toHaveLength(6)
    rect.mockRestore()
  })
})
