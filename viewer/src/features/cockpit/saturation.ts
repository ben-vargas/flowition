/**
 * The concurrency-saturation strip (DESIGN §2.4, Q5) — pure, like `gantt.ts`, and on the
 * SAME percentage axis so the two cannot drift apart.
 *
 * The strip is the Timeline tab's argument. A Gantt shows you that agents waited; only the
 * saturation trace tells you whether they waited because the semaphore was full — which is
 * the difference between "raise `--concurrency`" and "the provider was slow". So the model
 * computes the conclusion too (`pinnedMs`, `maxQueued`, `suggestion`) rather than leaving a
 * reader to integrate a step chart by eye.
 *
 * Two series, never stacked (the comp's own note): the plot answers "am I at the ceiling",
 * the rail beneath answers "how deep is the queue". Stacking buries the ceiling rule, which
 * is the one line the chart exists to show.
 */

export interface SaturationSample { t: number; active: number; queued: number }

export interface SatStep {
  left: number
  width: number
  active: number
  queued: number
  /** Height as a fraction of the plot, `active / ceiling`, clamped to 1. */
  height: number
  /** `active >= concurrency` — the semaphore had nothing left to give. */
  pinned: boolean
  ms: number
}

export interface SatBand { left: number; width: number; ms: number }

export interface SatQueue {
  left: number
  width: number
  queued: number
  /** Depth as a fraction of the rail; 3+ queued fills it. */
  depth: number
}

export interface SaturationModel {
  steps: SatStep[]
  /** Merged intervals where the run sat at the ceiling — adjacent samples read as one. */
  bands: SatBand[]
  queue: SatQueue[]
  concurrency: number
  ceiling: number
  maxActive: number
  maxQueued: number
  pinnedMs: number
  totalMs: number
  /** `concurrency + maxQueued` — the width that would have emptied the queue. */
  suggestion: number | null
  empty: boolean
}

/** 3 queued fills the depth rail; deeper is still full rather than overflowing it. */
export const QUEUE_RAIL_DEPTH = 3

export interface SaturationOptions {
  start: number
  end: number
  concurrency: number | null
}

/**
 * Fold E4's `{t, active, queued}` samples into drawable steps.
 *
 * Each sample holds until the next one; the last holds to the end of the window (the
 * engine emits on change, so silence means "unchanged", not "unknown"). Samples outside
 * the window are clamped rather than dropped — a run resumed inside a longer lineage has
 * samples from before this window's start, and dropping them would lose the state the
 * window opens in.
 */
export function saturationModel(
  samples: readonly SaturationSample[] | null | undefined,
  options: SaturationOptions,
): SaturationModel {
  const { start, end } = options
  const spanMs = end > start ? end - start : 1
  const concurrency = Number.isFinite(options.concurrency) && (options.concurrency as number) > 0
    ? options.concurrency as number
    : 0

  const clean = (samples ?? [])
    .filter((s): s is SaturationSample => s != null && Number.isFinite(s.t))
    .map((s) => ({
      t: s.t,
      active: Number.isFinite(s.active) ? Math.max(0, s.active) : 0,
      queued: Number.isFinite(s.queued) ? Math.max(0, s.queued) : 0,
    }))
    .sort((a, b) => a.t - b.t)

  const maxActive = clean.reduce((m, s) => Math.max(m, s.active), 0)
  const maxQueued = clean.reduce((m, s) => Math.max(m, s.queued), 0)
  // The plot's ceiling is the configured concurrency, unless the run somehow exceeded it
  // (a resumed run whose `--concurrency` changed between attempts). Drawing bars past the
  // top of the plot would hide exactly that.
  const ceiling = Math.max(concurrency, maxActive, 1)

  const pct = (t: number): number => {
    const raw = ((t - start) / spanMs) * 100
    return raw < 0 ? 0 : raw > 100 ? 100 : raw
  }

  const steps: SatStep[] = []
  const queue: SatQueue[] = []
  const bands: SatBand[] = []
  let pinnedMs = 0

  for (let i = 0; i < clean.length; i++) {
    const sample = clean[i]!
    const until = i + 1 < clean.length ? clean[i + 1]!.t : end
    if (until <= start || sample.t >= end) {
      // Entirely outside the window — but a sample that STARTS before it still describes
      // the window's opening state, so only a sample that also ends before it is dropped.
      if (until <= start) continue
    }
    const left = pct(sample.t)
    const width = Math.max(0, pct(until) - left)
    if (width <= 0) continue
    const ms = (width / 100) * spanMs
    const pinned = concurrency > 0 && sample.active >= concurrency
    steps.push({
      left,
      width,
      active: sample.active,
      queued: sample.queued,
      height: Math.min(1, sample.active / ceiling),
      pinned,
      ms,
    })
    if (sample.queued > 0) {
      queue.push({
        left,
        width,
        queued: sample.queued,
        depth: Math.min(1, sample.queued / QUEUE_RAIL_DEPTH),
      })
    }
    if (pinned) {
      pinnedMs += ms
      const last = bands[bands.length - 1]
      // Adjacent pinned samples are ONE band: three samples that each keep both slots busy
      // is one 13-minute saturation, not three separate ones.
      if (last && Math.abs(last.left + last.width - left) < 0.01) {
        last.width += width
        last.ms += ms
      } else {
        bands.push({ left, width, ms })
      }
    }
  }

  return {
    steps,
    bands,
    queue,
    concurrency,
    ceiling,
    maxActive,
    maxQueued,
    pinnedMs,
    totalMs: spanMs,
    suggestion: concurrency > 0 && maxQueued > 0 ? concurrency + maxQueued : null,
    empty: steps.length === 0,
  }
}
