// DESIGN §6.3 formatting rules. USD only — `cost` is whatever the journal's field carried;
// there is no locale conversion, deliberately.
//
// The absent-value rule (parity #53/#114) is enforced by TYPE here: every formatter that
// can receive an absent number returns `null` for `null`/`undefined`/NaN, and the render
// layer turns `null` into a blank cell. A fabricated `0`, `—` or `$0.00` for a number the
// engine never wrote is the specific bug these signatures make hard.

/** `41k`, `1.2M`. Exact below 1,000. */
export function fmtTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null
  const v = Math.abs(n)
  if (v < 1000) return String(Math.round(n))
  if (v < 1_000_000) {
    const k = n / 1000
    return `${Math.abs(k) < 100 ? trim1(k) : Math.round(k)}k`
  }
  return `${trim1(n / 1_000_000)}M`
}

const trim1 = (n: number) => {
  const s = n.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/**
 * `820ms`, `4.2s`, `3m7s`.
 *
 * §6.3 says "match src/util.js:137–141 so CLI and viewer agree", and this is that
 * function byte-for-byte. NOTE: §6.3's own example writes `3m07s` (zero-padded seconds),
 * which the engine does not produce. The instruction to match the engine governs; the
 * example is a spec defect, reported with this unit.
 */
export function fmtDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * `$1.23` at $1+, `$0.014` at ≥$0.01, `$0.0004` below.
 *
 * Parity #114: NEVER `$0.00` for a nonzero cost. A real zero is `$0`; an absent cost is
 * `null` and renders blank.
 */
export function fmtCost(usd: number | null | undefined): string | null {
  if (usd == null || !Number.isFinite(usd)) return null
  if (usd === 0) return '$0'
  const v = Math.abs(usd)
  const dp = v >= 1 ? 2 : v >= 0.01 ? 3 : 4
  const text = v.toFixed(dp)
  // Below the smallest representable step, say so rather than rounding to zero.
  const rendered = Number(text) === 0 ? `<$${(10 ** -dp).toFixed(dp)}` : `$${text}`
  return usd < 0 ? `-${rendered}` : rendered
}

/**
 * The cost of a run SUMMARY — `null` when the run has no cost to show.
 *
 * A summary's `spend.cost` cannot express "no cost was reported": the shared fold coerces
 * a missing cost to zero (`Number(v.cost) || 0`, src/viewer/fold.js:28), so an adapter
 * that reports tokens but no price (the mock adapter, any local model) arrives here as an
 * exact 0. §2.3's "empty ≠ zero" rule (parity #53/#114) is about exactly that case, so a
 * zero in a summary renders BLANK rather than as `$0` — a fabricated measurement is worse
 * than an admitted absence. `fmtCost` itself keeps its literal contract for the places
 * that have a real, journal-sourced zero to state.
 */
export function summaryCost(
  spend: { cost?: number | null } | null | undefined,
): string | null {
  const cost = spend?.cost
  if (cost == null || !Number.isFinite(cost) || cost === 0) return null
  return fmtCost(cost)
}

/** `just now`, `4m ago`, `2h ago`, `3d ago`. `null` when there is no timestamp. */
export function timeAgo(t: number | null | undefined, now = Date.now()): string | null {
  if (t == null || !Number.isFinite(t)) return null
  const s = Math.round((now - t) / 1000)
  if (s < 0) return 'just now'
  if (s < 45) return 'just now'
  if (s < 90) return '1m ago'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`
}

/** Absolute local wall clock, for the gutter and tooltips. */
export function fmtClock(t: number | null | undefined): string | null {
  if (t == null || !Number.isFinite(t)) return null
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Full local timestamp for `title` attributes. */
export function fmtStamp(t: number | null | undefined): string | null {
  if (t == null || !Number.isFinite(t)) return null
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtClock(t)}`
}

/**
 * Elapsed clock for a run: ticks while live, freezes at terminal (parity #46). The caller
 * supplies `now` so a frozen run does not depend on render timing.
 */
export function elapsed(
  startedAt: number | null | undefined,
  endedAt: number | null | undefined,
  now: number,
): number | null {
  if (startedAt == null || !Number.isFinite(startedAt)) return null
  const end = endedAt != null && Number.isFinite(endedAt) ? endedAt : now
  return Math.max(0, end - startedAt)
}

/** Percent of a soft ceiling, or null when there is no ceiling to compare against. */
export function pctOf(value: number | null | undefined, ceiling: number | null | undefined) {
  if (value == null || ceiling == null || !Number.isFinite(value) || !Number.isFinite(ceiling)) return null
  if (ceiling <= 0) return null
  return (value / ceiling) * 100
}
