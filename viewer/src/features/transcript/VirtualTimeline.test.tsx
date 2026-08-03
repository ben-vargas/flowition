// @vitest-environment jsdom

import { useEffect, useMemo, useState } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { groupTimeline, retainedManualIds } from './grouping.js'
import type { TimelineItem, TimelineUnit, ToolItem } from './types.js'
import { observeElementOffsetCancellable } from './observeOffset.js'
import { VirtualTimeline } from './VirtualTimeline.js'

const nativeScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')

afterEach(() => {
  cleanup()
  if (nativeScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', nativeScrollTo)
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo
})

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600,
    width: 800, height: 600, toJSON: () => ({}),
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 92,
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 800,
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, leftOrOptions?: number | ScrollToOptions, top?: number) {
      if (!this.classList.contains('step-body-virtual')) return
      this.scrollTop = typeof leftOrOptions === 'object'
        ? leftOrOptions.top ?? this.scrollTop
        : top ?? this.scrollTop
      queueMicrotask(() => this.dispatchEvent(new Event('scroll')))
    },
  })
})

function tool(id: string): ToolItem {
  return {
    id, kind: 'tool', card: 'generic', name: 'Read',
    input: { path: id }, inputText: `{"path":"${id}"}`, toolId: id,
    result: { text: 'ok', isError: false, t: 2, exitCode: null },
    approximate: false, command: null, files: [], t: 1, o: Number(id.slice(1)) + 1, attempt: 1,
  }
}

function step(id: string, count = 2): Extract<TimelineUnit, { kind: 'step' }> {
  const items = Array.from({ length: count }, (_, index) => tool(`t${Number(id.slice(1)) * 10 + index}`))
  return { kind: 'step', id, items, t: 1, attempt: 1, pending: false }
}

function textUnit(text: string): TimelineUnit {
  return {
    kind: 'row',
    id: 'text-stream',
    item: { id: 'text-stream', kind: 'text', text, t: 1, o: 1, attempt: 1 },
    t: 1,
    attempt: 1,
  }
}

function Harness({ units }: { units: TimelineUnit[] }) {
  const [manual, setManual] = useState<Record<string, boolean>>({})
  return (
    <VirtualTimeline
      units={units}
      live
      oldMayBeTruncated={false}
      manual={manual}
      onManual={(id, expanded) => setManual((current) => ({ ...current, [id]: expanded }))}
    />
  )
}

function ManualWindowHarness({ items }: { items: TimelineItem[] }) {
  const units = useMemo(() => groupTimeline(items), [items])
  const retained = useMemo(() => retainedManualIds(items), [items])
  const [manual, setManual] = useState<Record<string, boolean>>({})
  useEffect(() => {
    setManual((current) => Object.fromEntries(
      Object.entries(current).filter(([id]) => retained.has(id)),
    ))
  }, [retained])
  return (
    <VirtualTimeline
      units={units}
      live={false}
      oldMayBeTruncated={false}
      manual={manual}
      onManual={(id, expanded) => setManual((current) => ({ ...current, [id]: expanded }))}
    />
  )
}

describe('sticky transcript follow intent and scroll fades (§9.5 / #105–107)', () => {
  it('ignores plain pointer clicks, pauses only after an intent-driven scroll, and re-arms within 4px', async () => {
    const view = render(<Harness units={[step('s1'), step('s2')]} />)
    const body = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('.tp-body')
      expect(found).toBeTruthy()
      return found!
    })
    let scrollTop = 300
    Object.defineProperties(body, {
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => 1_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })

    const toggle = view.container.querySelector<HTMLButtonElement>('.step-toggle')!
    fireEvent.pointerDown(toggle)
    fireEvent.click(toggle)
    fireEvent.pointerUp(toggle)
    expect(body.dataset.follow).toBe('tail')

    fireEvent.wheel(body)
    fireEvent.scroll(body)
    await waitFor(() => expect(body.dataset.follow).toBe('paused'))
    expect(view.container.querySelector('.virtual-frame')?.classList.contains('fade-top')).toBe(true)
    expect(view.container.querySelector('.virtual-frame')?.classList.contains('fade-bottom')).toBe(true)

    scrollTop = 797
    fireEvent.scroll(body)
    await waitFor(() => expect(body.dataset.follow).toBe('tail'))
    expect(view.container.querySelector('.virtual-frame')?.classList.contains('fade-top')).toBe(true)
    expect(view.container.querySelector('.virtual-frame')?.classList.contains('fade-bottom')).toBe(false)

    scrollTop = 0
    fireEvent.scroll(body)
    await waitFor(() => {
      expect(view.container.querySelector('.virtual-frame')?.classList.contains('fade-top')).toBe(false)
      expect(view.container.querySelector('.virtual-frame')?.classList.contains('fade-bottom')).toBe(true)
    })
  })

  it('does not mistake the tail-follow virtualizer scroll for operator intent', async () => {
    const first = [step('s1')]
    const view = render(<Harness units={first} />)
    const body = await waitFor(() => view.container.querySelector<HTMLElement>('.tp-body')!)
    let scrollTop = 600
    let scrollHeight = 800
    Object.defineProperties(body, {
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })
    expect(body.dataset.follow).toBe('tail')
    fireEvent.pointerDown(body)
    scrollHeight = 1_000
    view.rerender(<Harness units={[...first, step('s2')]} />)
    fireEvent.scroll(body)
    expect(body.dataset.follow).toBe('tail')
    fireEvent.pointerUp(body)
  })

  it('re-follows when streaming text grows the trailing row without changing row count', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
    const scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    try {
      const view = render(<Harness units={[textUnit('short')]} />)
      await waitFor(() => expect(scrollTo).toHaveBeenCalled())
      scrollTo.mockClear()
      view.rerender(<Harness units={[textUnit('short answer that is now streaming across several more lines'.repeat(8))]} />)
      await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo
    }
  })
})

describe('manual disclosure overrides and retained-window eviction (#93)', () => {
  it('keeps manual expansion/collapse across append-shaped rerenders', async () => {
    const collapsed = step('s1', 2)
    const boundary: TimelineUnit = {
      kind: 'row',
      id: 'status-0',
      item: { id: 'status-0', kind: 'status', text: 'boundary', t: 2, o: 90, attempt: 1 },
      t: 2,
      attempt: 1,
    }
    const view = render(<Harness units={[collapsed, boundary]} />)
    const toggle = await waitFor(() => view.container.querySelector<HTMLButtonElement>('.step-toggle')!)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    view.rerender(<Harness units={[step('s1', 2), boundary, {
      kind: 'row',
      id: 'status-1',
      item: { id: 'status-1', kind: 'status', text: 'append', t: 3, o: 99, attempt: 1 },
      t: 3,
      attempt: 1,
    }]} />)
    expect(view.container.querySelector('.step-toggle')?.getAttribute('aria-expanded')).toBe('true')

    view.rerender(<Harness units={[step('s2', 1)]} />)
    const single = view.container.querySelector<HTMLButtonElement>('.step-toggle')!
    expect(single.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(single)
    expect(single.getAttribute('aria-expanded')).toBe('false')
    view.rerender(<Harness units={[step('s2', 1), step('s3', 2)]} />)
    expect(view.container.querySelector('.step-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('clears a manual step choice once its records leave the retained window', async () => {
    const items = [tool('t10'), tool('t11')]
    const view = render(<ManualWindowHarness items={items} />)
    const toggle = await waitFor(() => view.container.querySelector<HTMLButtonElement>('.step-toggle')!)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    view.rerender(<ManualWindowHarness items={[]} />)
    await waitFor(() => expect(view.container.querySelector('.step-toggle')).toBeNull())
    view.rerender(<ManualWindowHarness items={[tool('t10'), tool('t11')]} />)
    await waitFor(() => expect(
      view.container.querySelector('.step-toggle')?.getAttribute('aria-expanded'),
    ).toBe('false'))
  })

  it('does not mount a collapsed step body and retains a closing body only through its transition', async () => {
    const collapsed = step('s1', 2)
    collapsed.items[0]!.result!.text = 'hidden tool output'
    const boundary: TimelineUnit = {
      kind: 'row',
      id: 'status-end',
      item: { id: 'status-end', kind: 'status', text: 'done', t: 2, o: 99, attempt: 1 },
      t: 2,
      attempt: 1,
    }
    const view = render(<Harness units={[collapsed, boundary]} />)
    const toggle = await waitFor(() => view.container.querySelector<HTMLButtonElement>('.step-toggle')!)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('hidden tool output')).toBeNull()

    fireEvent.click(toggle)
    expect(await view.findByText('hidden tool output')).toBeTruthy()
    fireEvent.click(toggle)
    expect(view.queryByText('hidden tool output')).toBeTruthy()
    fireEvent.transitionEnd(view.container.querySelector('.step-collapse')!)
    await waitFor(() => expect(view.queryByText('hidden tool output')).toBeNull())
  })

  it('virtualizes a large expanded step instead of materializing every tool card', async () => {
    const pending = step('s1', 5_000)
    pending.pending = true
    for (const item of pending.items) if (item.kind === 'tool') item.result = null
    const view = render(<Harness units={[pending]} />)
    const toggle = await waitFor(() => view.container.querySelector<HTMLButtonElement>('.step-toggle')!)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toContain('5000 rows')
    const viewport = view.container.querySelector<HTMLElement>('.step-body-virtual')!
    expect(viewport).toBeTruthy()
    expect(viewport.getAttribute('aria-label')).toContain('5,000 tool records')
    expect(view.container.querySelectorAll('.step-item-virtual').length).toBeGreaterThan(0)
    expect(view.container.querySelectorAll('.step-item-virtual').length).toBeLessThan(100)
    expect(view.container.querySelectorAll('.tcard').length).toBeLessThan(100)
    expect(Number.parseFloat(
      view.container.querySelector<HTMLElement>('.step-items-spacer')!.style.height,
    )).toBeGreaterThan(600 * 10)
    await waitFor(() => expect(
      view.container.querySelector('[data-step-item-id="t5009"]'),
    ).toBeTruthy())
  })

  it('jumps a large settled step to the searched inner record', async () => {
    const settled = step('s1', 5_000)
    const target = settled.items[4_200]!
    const view = render(
      <VirtualTimeline
        units={[settled]}
        live={false}
        oldMayBeTruncated={false}
        manual={{}}
        onManual={() => {}}
        searchTarget={{ offset: target.o, index: 0, itemId: target.id }}
      />,
    )
    expect(await waitFor(() => view.container.querySelector(
      `[data-step-item-id="${target.id}"]`,
    ))).toBeTruthy()
    expect(view.container.querySelector('.step-toggle')?.getAttribute('aria-expanded')).toBe('true')
  })
})

/**
 * The teardown race that made a full `npm test` exit 1 with all 906 assertions passing
 * (W12 review round 1, B7).
 *
 * `@tanstack/virtual-core` debounces a "scrolling has stopped" callback through
 * `targetWindow.setTimeout(…, 150)` and its unsubscribe removes the scroll LISTENER while
 * leaving that timer armed — true in the installed 3.13.12 and still true in 3.17.7, the
 * newest published build, so there is no version to bump to. When it fires after unmount it
 * re-renders a dead tree; when it fires after vitest has torn the jsdom environment down,
 * react-dom throws `ReferenceError: window is not defined` out of the event loop and the
 * run fails with no failing test.
 *
 * `observeOffset.ts` supplies the same observer with a cancelling unsubscribe. This asserts
 * the cancellation directly — no pending timers survive unmount, and nothing fires
 * afterwards — and repeats the mount/scroll/unmount cycle, because a leak that only shows up
 * on the last iteration of a suite is exactly the shape of the original defect.
 */
describe('the virtualizer cancels its scheduled work on unmount (§11.3)', () => {
  const scrollableBody = (view: ReturnType<typeof render>) => {
    const body = view.container.querySelector<HTMLElement>('.tp-body')!
    let scrollTop = 0
    Object.defineProperties(body, {
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => 1_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value },
      },
    })
    return body
  }

  it('accumulates NO scheduled work over repeated mount/scroll/unmount cycles', () => {
    vi.useFakeTimers()
    try {
      for (let round = 0; round < 5; round++) {
        const view = render(<Harness units={[step(`a${round}`), step(`b${round}`)]} />)
        const body = scrollableBody(view)
        fireEvent.scroll(body)
        fireEvent.wheel(body)
        fireEvent.scroll(body)
        // The scroll-stop debounce is armed right now — the 150 ms window the defect
        // lives in.
        expect(vi.getTimerCount()).toBeGreaterThan(0)

        view.unmount()
        // Draining the clock after unmount must be a no-op, not a re-render of a dead
        // tree. What the LIBRARY leaves behind at this point is one guarded
        // `requestAnimationFrame` from `scrollToIndex`, whose callbacks all bail on
        // `!targetWindow` — and `Virtualizer.cleanup()` nulls exactly that on unmount, so
        // it cannot reach React. The debounce, which is NOT guarded, is gone because
        // `observeOffset.ts` clears it.
        vi.advanceTimersByTime(5_000)
        expect(
          vi.getTimerCount(),
          'work outlived the component — round ' + round,
        ).toBe(0)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops calling back once unsubscribed', () => {
    vi.useFakeTimers()
    try {
      const seen: boolean[] = []
      const element = document.createElement('div')
      document.body.appendChild(element)
      const instance = {
        scrollElement: element,
        targetWindow: window,
        options: { horizontal: false, isRtl: false, isScrollingResetDelay: 150, useScrollendEvent: false },
      }
      const stop = observeElementOffsetCancellable(
        instance as never,
        (_offset, isScrolling) => { seen.push(isScrolling) },
      )!
      expect(seen).toEqual([false])          // the priming call
      element.dispatchEvent(new Event('scroll'))
      expect(seen).toEqual([false, true])

      stop()
      vi.advanceTimersByTime(5_000)
      // Without the cancel, the debounce would have appended a trailing `false` here —
      // long after the component that owned it stopped existing.
      expect(seen).toEqual([false, true])
      element.dispatchEvent(new Event('scroll'))
      expect(seen).toEqual([false, true])
      element.remove()
    } finally {
      vi.useRealTimers()
    }
  })
})
