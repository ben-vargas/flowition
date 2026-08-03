// The saturation strip's model (§2.4, Q5). The chart's whole value is its conclusion, so
// the conclusion is what these assert: how long the run sat on the ceiling, how deep the
// queue got, and what width would have emptied it.

import { describe, expect, it } from 'vitest'
import { QUEUE_RAIL_DEPTH, saturationModel } from './saturation.js'
import { CONCURRENCY, NOW, SATURATION, SPAN_MS, T0 } from './fixtures.js'

const model = () => saturationModel(SATURATION, { start: T0, end: NOW, concurrency: CONCURRENCY })

describe('the comps\' trace', () => {
  it('holds every sample until the next one, and the last to the end of the window', () => {
    const m = model()
    expect(m.steps).toHaveLength(SATURATION.length)
    expect(m.steps[0]!.left).toBe(0)
    const last = m.steps[m.steps.length - 1]!
    expect(last.left + last.width).toBeCloseTo(100, 6)
  })

  it('reports the run pinned at the ceiling for 13 of its 14 minutes', () => {
    const m = model()
    // The only unpinned interval is 1m58s → 2m14s, where survey:routes had finished and
    // review:* had not been admitted yet: 16s of 842s.
    expect(Math.round(m.pinnedMs / 1000)).toBe(842 - 16)
    expect(m.totalMs).toBe(SPAN_MS)
  })

  it('merges adjacent pinned samples into ONE band', () => {
    const m = model()
    // Four consecutive pinned samples after 2m14s are one saturation, not four.
    expect(m.bands).toHaveLength(2)
    expect(m.bands[0]!.left).toBe(0)
    expect(Math.round(m.bands[1]!.ms / 1000)).toBe(842 - 134)
  })

  it('states the width that would have emptied the queue', () => {
    const m = model()
    expect(m.maxQueued).toBe(3)
    expect(m.suggestion).toBe(CONCURRENCY + 3)
  })

  it('draws queue depth on its own rail, capped rather than overflowing', () => {
    const m = saturationModel(
      [{ t: T0, active: 2, queued: 9 }],
      { start: T0, end: NOW, concurrency: 2 },
    )
    expect(m.queue[0]!.depth).toBe(1)
    expect(QUEUE_RAIL_DEPTH).toBe(3)
  })
})

describe('edges', () => {
  it('is empty — and says so — for a run with no E4 samples', () => {
    const m = saturationModel([], { start: T0, end: NOW, concurrency: 2 })
    expect(m.empty).toBe(true)
    expect(m.steps).toHaveLength(0)
    expect(m.suggestion).toBeNull()
  })

  it('raises the plot ceiling when a resumed run exceeded its configured concurrency', () => {
    const m = saturationModel(
      [{ t: T0, active: 5, queued: 0 }],
      { start: T0, end: NOW, concurrency: 2 },
    )
    // The bar must not be drawn past the top of the plot: the ceiling rule moves instead.
    expect(m.ceiling).toBe(5)
    expect(m.steps[0]!.height).toBe(1)
    expect(m.steps[0]!.pinned).toBe(true)
  })

  it('keeps a sample that opens BEFORE the window — it describes the opening state', () => {
    const m = saturationModel(
      [{ t: T0 - 500_000, active: 2, queued: 1 }, { t: T0 + 100_000, active: 1, queued: 0 }],
      { start: T0, end: NOW, concurrency: 2 },
    )
    expect(m.steps).toHaveLength(2)
    expect(m.steps[0]!.left).toBe(0)
  })

  it('drops a sample that ends before the window opens', () => {
    const m = saturationModel(
      [{ t: T0 - 900_000, active: 2, queued: 0 }, { t: T0 - 500_000, active: 1, queued: 0 }],
      { start: T0, end: NOW, concurrency: 2 },
    )
    expect(m.steps).toHaveLength(1)
    expect(m.steps[0]!.active).toBe(1)
  })

  it('tolerates junk samples without throwing (§6.5: nothing throws)', () => {
    const m = saturationModel(
      [
        { t: Number.NaN, active: 1, queued: 0 },
        { t: T0 + 10, active: -3, queued: Number.NaN },
      ] as never,
      { start: T0, end: NOW, concurrency: 2 },
    )
    expect(m.steps).toHaveLength(1)
    expect(m.steps[0]!.active).toBe(0)
    expect(m.steps[0]!.queued).toBe(0)
  })

  it('never claims a ceiling for a run whose concurrency is unknown (old runs)', () => {
    const m = saturationModel(SATURATION, { start: T0, end: NOW, concurrency: null })
    expect(m.concurrency).toBe(0)
    expect(m.pinnedMs).toBe(0)
    expect(m.suggestion).toBeNull()
  })
})
