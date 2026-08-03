/**
 * The two primitives the data layer is built on: the store snapshot contract and the
 * frame coalescer that parity #104 and budget P5 rest on.
 */

import { describe, expect, it, vi } from 'vitest'

import { createCoalescer, defaultFrames, manualFrames } from './frames.js'
import { createStore } from './store.js'

/** The coalescer under a scheduler and a clock the test owns completely. */
function harness(options: { frameMs?: number } = {}) {
  const frames = manualFrames(options)
  const commit = vi.fn()
  const coalescer = createCoalescer(commit, { schedule: frames.schedule, now: frames.now })
  return { frames, commit, coalescer }
}

describe('createCoalescer (parity #104)', () => {
  it('collapses any number of requests inside one frame into one commit', () => {
    const { frames, commit, coalescer } = harness()
    for (let i = 0; i < 1000; i++) coalescer.request()
    expect(frames.pending).toBe(1)
    expect(commit).not.toHaveBeenCalled()
    frames.flush()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(coalescer.commits).toBe(1)
  })

  it('re-arms after a commit — coalescing is per frame, not once ever', () => {
    const { frames, commit, coalescer } = harness()
    coalescer.request(); frames.flush()
    coalescer.request(); frames.flush()
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('flush() runs a pending commit early and does nothing when idle', () => {
    const { frames, commit, coalescer } = harness()
    coalescer.flush()
    expect(commit).not.toHaveBeenCalled()
    coalescer.request()
    coalescer.flush()
    expect(commit).toHaveBeenCalledTimes(1)
    // The scheduled callback was cancelled, so the frame does not double-commit.
    expect(frames.flush()).toBe(0)
  })

  it('cancel() drops a pending commit without running it', () => {
    const { frames, commit, coalescer } = harness()
    coalescer.request()
    coalescer.cancel()
    frames.flush()
    expect(commit).not.toHaveBeenCalled()
    expect(coalescer.pending).toBe(false)
  })

  it('falls back to a ~60 Hz timeout where requestAnimationFrame does not exist', () => {
    vi.useFakeTimers()
    try {
      expect(globalThis.requestAnimationFrame).toBeUndefined()
      const commit = vi.fn()
      const coalescer = createCoalescer(commit, { schedule: defaultFrames() })
      coalescer.request()
      coalescer.request()
      vi.advanceTimersByTime(16)
      expect(commit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * P5's budget is `≤ 60 store commits/s`, and a frame is not a second. These are the cases
 * a per-frame-only coalescer gets wrong, and they are the ones the hardware this is built
 * on actually presents: every current Mac laptop drives its own display at 120 Hz.
 */
describe('createCoalescer — the ≤60 commits/s floor (P5)', () => {
  // A frame is taken only once the floor has cleared: every 2nd frame at 120 Hz, every 3rd
  // at 144 Hz — 53 and 48 respectively, the 120 Hz figure landing under 60 rather than on
  // it because two 8.333 ms frames fall a float ulp short of a 16.667 ms floor. The
  // assertion is the budget itself: a ceiling of 60, and not a throttle down to nothing.
  for (const hz of [120, 144]) {
    it(`commits at most 60 times in a simulated second at ${hz} Hz`, () => {
      const { frames, commit, coalescer } = harness({ frameMs: 1000 / hz })
      for (let frame = 0; frame < hz; frame++) {
        coalescer.request()
        frames.flush()
      }
      expect(frames.now()).toBeCloseTo(1000, 6)
      expect(commit.mock.calls.length).toBeLessThanOrEqual(60)
      expect(commit.mock.calls.length).toBeGreaterThanOrEqual(45)
    })
  }

  it('requestNow() is bounded too — a signal per record cannot buy extra commits', () => {
    const { frames, commit, coalescer } = harness({ frameMs: 1000 / 120 })
    coalescer.requestNow()                        // the commit that starts the clock at t=0
    const before = commit.mock.calls.length
    for (let frame = 0; frame < 120; frame++) {
      // 40 "low-frequency" signals per frame: 4,800 in the second.
      for (let i = 0; i < 40; i++) coalescer.requestNow()
      frames.flush()
    }
    expect(frames.now()).toBeCloseTo(1000, 6)
    expect(commit.mock.calls.length - before).toBeLessThanOrEqual(60)
  })

  it('a request made inside the floor is held, never dropped', () => {
    const { frames, commit, coalescer } = harness({ frameMs: 4 })
    coalescer.request()
    frames.flush()                       // t=4: the first commit; the floor starts here
    expect(commit).toHaveBeenCalledTimes(1)
    coalescer.request()
    frames.flush()                       // t=8  — inside the floor, held
    frames.flush()                       // t=12 — still inside
    frames.flush()                       // t=16 — still inside (12 < 16.67)
    frames.flush()                       // t=20 — still inside (16 < 16.67)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(coalescer.pending).toBe(true) // the ask survived four frames
    frames.flush()                       // t=24: 20 ms since the last commit — it runs
    expect(commit).toHaveBeenCalledTimes(2)
    expect(coalescer.pending).toBe(false)
  })

  it('flush() is the one door past the floor — teardown must not lose a commit', () => {
    const { frames, commit, coalescer } = harness()
    coalescer.request()
    frames.flush()
    coalescer.request()
    coalescer.flush()
    expect(commit).toHaveBeenCalledTimes(2)
  })
})

describe('createStore', () => {
  it('notifies on change and never on a reference-equal set', () => {
    const state = { n: 1 }
    const store = createStore(state)
    const listener = vi.fn()
    store.subscribe(listener)
    store.set(state)
    expect(listener).not.toHaveBeenCalled()
    store.set({ n: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toEqual({ n: 2 })
  })

  it('a listener that unsubscribes during notification does not skip the next one', () => {
    const store = createStore(0)
    const seen: string[] = []
    const off = store.subscribe(() => { seen.push('first'); off() })
    store.subscribe(() => seen.push('second'))
    store.set(1)
    expect(seen).toEqual(['first', 'second'])
    store.set(2)
    expect(seen).toEqual(['first', 'second', 'second'])
  })

  it('update() derives the next snapshot from the current one', () => {
    const store = createStore({ n: 1 })
    store.update((s) => ({ n: s.n + 1 }))
    expect(store.getSnapshot()).toEqual({ n: 2 })
    expect(store.listenerCount).toBe(0)
  })
})
