/**
 * Frame scheduling — the mechanism behind parity #104 and budget P5.
 *
 * A live run can deliver thousands of records per second (P5: 5,000/s sustained); the
 * store must fold every one of them and commit at most once per animation frame. Both
 * halves matter: coalescing that DROPS frames would be a lie about the data, and a commit
 * per record freezes the tab. So the coalescer is "accumulate always, commit on the next
 * frame", never "sample".
 *
 * **A frame is not a rate.** P5's budget is `≤ 60 store commits/s`, and
 * `requestAnimationFrame` fires at the DISPLAY's refresh rate — 120 Hz on a ProMotion Mac,
 * 144 Hz on a gaming monitor — so "one commit per frame" is 120–144 commits/s on exactly
 * the hardware this product is developed on. The coalescer therefore carries a wall-clock
 * floor of `MIN_COMMIT_INTERVAL_MS` (16.67 ms) as well: a frame that arrives inside the
 * floor re-arms itself instead of committing, and every queued record simply waits one
 * more frame. Nothing is sampled away — the budget bounds COMMITS, not ingestion.
 *
 * The floor applies to `requestNow()` too, which is how the low-frequency signals (status
 * changes, `sys/state`, resets) enter: they are low-frequency by convention, not by
 * construction, and a server that emits one per record would otherwise walk straight
 * through the budget.
 *
 * The scheduler and the clock are both injected so the latch and throughput tests can
 * drive frames deterministically under fake timers — a rAF that never fires in jsdom would
 * otherwise make every one of them a timeout.
 */

/** Schedule `fn` for the next frame; the returned function cancels it. */
export type FrameScheduler = (fn: () => void) => () => void

/** P5: `≤ 60 store commits/s`. */
export const MIN_COMMIT_INTERVAL_MS = 1000 / 60

/**
 * The floor is compared with a nanosecond of slack, because `16.666666666666668 * 3` is
 * `50` and `50 - 33.333333333333336` is `16.666666666666664` — a float ulp SHORT of the
 * interval. Without the slack a plain 60 Hz display would drop every third commit for
 * arithmetic reasons, which is a visible stutter bought for nothing. A nanosecond cannot
 * lift the achievable rate above 60/s in any real second.
 */
const FLOOR_SLACK_MS = 1e-9

/** `requestAnimationFrame`, or a ~60 Hz timeout where it does not exist (node, jsdom). */
export function defaultFrames(): FrameScheduler {
  const raf = typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : null
  const caf = typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : null
  if (raf) {
    return (fn) => {
      const id = raf(() => fn())
      return () => caf?.(id)
    }
  }
  return (fn) => {
    const id = setTimeout(fn, 16)
    return () => clearTimeout(id)
  }
}

export interface ManualFrames {
  schedule: FrameScheduler
  /** Run every pending frame callback. Returns how many ran. */
  flush(): number
  /** The virtual clock, in ms. Advanced by one frame interval per `flush()`. */
  now(): number
  /** Advance the clock without running a frame. */
  advance(ms: number): void
  readonly pending: number
  /** Frames flushed so far. */
  readonly frames: number
}

/**
 * A hand-driven scheduler for tests: nothing runs until `flush()`.
 *
 * It owns a virtual clock because the commit floor is a RATE, and a rate cannot be
 * asserted against a frozen clock — the review that produced this file found exactly that
 * hole ("the benchmark manually flushes exactly 60 frames and never advances a simulated
 * second, so it cannot fail when production exceeds 60 commits/s"). `frameMs` is the
 * display's refresh interval: pass `1000/120` or `1000/144` to test the fast-display case
 * that a per-frame commit gets wrong.
 */
export function manualFrames(options: { frameMs?: number } = {}): ManualFrames {
  const frameMs = options.frameMs ?? 1000 / 60
  let queue: (() => void)[] = []
  let clock = 0
  let frames = 0
  const schedule: FrameScheduler = (fn) => {
    queue.push(fn)
    return () => { queue = queue.filter((f) => f !== fn) }
  }
  return {
    schedule,
    flush() {
      clock += frameMs
      frames++
      const run = queue
      queue = []
      for (const fn of run) fn()
      return run.length
    },
    now() { return clock },
    advance(ms) { clock += ms },
    get pending() { return queue.length },
    get frames() { return frames },
  }
}

export interface Coalescer {
  /** Ask for a commit on the next frame. Idempotent within a frame — that is the point. */
  request(): void
  /**
   * Ask for a commit NOW — granted only if the P5 floor has elapsed, otherwise it degrades
   * to `request()`. For the low-frequency signals where a frame of latency shows up as a
   * visibly wrong connection chip.
   */
  requestNow(): void
  /**
   * Commit a pending request immediately, floor and all. Teardown and explicit `flush()`
   * calls only: this is the one door that is allowed to exceed 60/s, because it is driven
   * by the operator (or by `stop()`), never by the stream.
   */
  flush(): void
  /** Drop a pending commit without running it. */
  cancel(): void
  /** A commit has been asked for and has not run yet. */
  readonly pending: boolean
  /** Commits actually performed — the assertion surface for P5. */
  readonly commits: number
}

export interface CoalescerOptions {
  schedule?: FrameScheduler
  /** Wall clock for the commit floor. Injected so tests can assert a RATE. */
  now?: () => number
  /** Defaults to `MIN_COMMIT_INTERVAL_MS`. `0` disables the floor. */
  minIntervalMs?: number
}

export function createCoalescer(commit: () => void, options: CoalescerOptions = {}): Coalescer {
  const schedule = options.schedule ?? defaultFrames()
  const now = options.now ?? (() => Date.now())
  const minIntervalMs = options.minIntervalMs ?? MIN_COMMIT_INTERVAL_MS

  let cancelFrame: (() => void) | null = null
  let commits = 0
  let last = -Infinity
  /** A commit is WANTED. Records stay queued until it happens — never dropped. */
  let armed = false

  const due = () => now() - last >= minIntervalMs - FLOOR_SLACK_MS

  const fire = () => {
    armed = false
    last = now()
    commits++
    commit()
  }

  const run = () => {
    cancelFrame = null
    if (!armed) return
    // Inside the floor: hold everything and take the next frame instead. On a 120 Hz
    // display this is what turns 120 commits/s into 60.
    if (!due()) { cancelFrame = schedule(run); return }
    fire()
  }

  const arm = () => {
    armed = true
    if (!cancelFrame) cancelFrame = schedule(run)
  }

  return {
    request() { arm() },
    requestNow() {
      armed = true
      if (!due()) { arm(); return }
      cancelFrame?.()
      cancelFrame = null
      fire()
    },
    flush() {
      if (!armed) return
      cancelFrame?.()
      cancelFrame = null
      fire()
    },
    cancel() {
      cancelFrame?.()
      cancelFrame = null
      armed = false
    },
    get pending() { return armed },
    get commits() { return commits },
  }
}
