/**
 * The budget gauge (DESIGN §2.4) — shared, because Home's live card and the cockpit header
 * must plot the same number the same way or one of them is lying.
 *
 * **What it plots, exactly:** `spend.output` against `budgetTotal`. Both are OUTPUT tokens.
 * The engine's own check is `usageTotal.output >= budget.total` (src/engine.js:913) and
 * `flowition status` prints the same figure (src/cli.js:245). Input tokens and dollars are
 * separate measurements and never enter the bar (critique M19) — they have their own metric
 * cells beside it.
 *
 * **Why the track is scaled to the overshoot:** a bar clipped at 100% cannot tell 101% from
 * 400%. The accent fill runs to the ceiling, the hatched red zone runs past it, and the
 * ceiling rule marks where the soft limit actually sits — so the shape itself carries "how
 * far over".
 *
 * **Why "soft ceiling" is on the label and not in the styling:** the budget is checked
 * before an agent is ADMITTED and a running agent is never killed for exceeding it
 * (ARCHITECTURE.md, Known limitations). A gauge that looked like a hard cap would make the
 * operator expect a stop that is not coming.
 */

import { fmtTokens, pctOf } from '../format/fmt.js'

export interface BudgetGaugeProps {
  /** `spend.output` — output tokens. */
  spent: number | null | undefined
  /** `budgetTotal` — output tokens. */
  ceiling: number | null | undefined
  /** The legend row; off for the compact card variant. */
  legend?: boolean
  labelId?: string
}

export function BudgetGauge({ spent, ceiling, legend = true, labelId }: BudgetGaugeProps) {
  const pct = pctOf(spent ?? null, ceiling ?? null)
  if (pct == null) {
    return (
      <div className="gauge">
        <div className="gauge-legend">
          <span className="dim">
            {spent != null ? `${fmtTokens(spent)} out` : 'no usage yet'} · no ceiling set
          </span>
        </div>
      </div>
    )
  }
  const over = pct > 100
  const scale = Math.max(pct, 100)
  const fillPct = (Math.min(pct, 100) / scale) * 100
  const ceilingPct = (100 / scale) * 100
  const overshoot = over && ceiling != null && spent != null ? spent - ceiling : null

  return (
    <div className="gauge">
      <div
        className="gauge-bar"
        role="img"
        {...(labelId ? { 'aria-labelledby': labelId } : {})}
        aria-label={labelId
          ? undefined
          : `${fmtTokens(spent)} of ${fmtTokens(ceiling)} output tokens, `
            + `${pct.toFixed(1)} percent of the soft ceiling`}
      >
        <div className="fill" style={{ width: `${fillPct}%` }} />
        {over ? <div className="over" style={{ left: `${ceilingPct}%`, right: 0 }} /> : null}
        <div className="ceiling" style={{ left: `${ceilingPct}%` }} />
      </div>
      {legend ? (
        <div className="gauge-legend">
          <b>{fmtTokens(spent)}</b>
          <span>/ {fmtTokens(ceiling)} out</span>
          <span className={over ? 'over-l' : undefined}>
            · {pct.toFixed(1)}%{overshoot != null ? ` · +${fmtTokens(overshoot)} over` : ''}
          </span>
          <span
            className="soft"
            style={{ marginLeft: 'auto' }}
            title="the engine checks the budget before admitting an agent; a running agent is never killed for exceeding it"
          >
            soft ceiling
          </span>
        </div>
      ) : null}
    </div>
  )
}
