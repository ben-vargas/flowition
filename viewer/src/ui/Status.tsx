// §3.2 status marks and chips, §3.6 "state is never carried by color alone".
//
// Both components emit a text label: the chip visibly, the glyph as an adjacent
// visually-hidden span. That is what makes the vocabulary legible to a screen reader and
// to anyone who cannot separate the green from the red.

import { Icon } from './Icon.js'
import { lookUpState, spins } from './icons.js'
import { ADAPTER_MONO } from './tokens.js'

export function StatusGlyph({ state, orphaned = false }: { state: string; orphaned?: boolean }) {
  // §6.4 step 8 / parity #58: an agent stranded in a dead run gets its OWN mark and never
  // a spinner — a dead run must not look busy.
  const effective = orphaned ? 'orphaned' : state
  const [cls, glyph, text] = lookUpState(effective)
  return (
    <span className={`g ${cls}${orphaned ? ' orphan' : ''}`}>
      <Icon name={glyph} spin={!orphaned && spins(state)} />
      <span className="vh">{orphaned ? `orphaned (${lookUpState(state)[2]})` : text}</span>
    </span>
  )
}

export function StatusChip(
  { state, label, orphaned = false }: { state: string; label?: string; orphaned?: boolean },
) {
  const effective = orphaned ? 'orphaned' : state
  const [cls, glyph, text] = lookUpState(effective)
  return (
    <span className={`chip ${cls}`}>
      <Icon name={glyph} spin={!orphaned && spins(state)} />
      {label ?? text}
    </span>
  )
}

/**
 * §3.2 adapter badge: a two-letter monogram in the adapter's hue. Never a vendor brand
 * mark (parity #57). An adapter the table does not know renders the `unknown` dot rather
 * than inventing a monogram from the name.
 */
export function AdapterBadge({ name }: { name: string }) {
  const known = Object.prototype.hasOwnProperty.call(ADAPTER_MONO, name)
  const key = known ? name : 'unknown'
  return (
    <span className={`ad ad-${key}`} title={name || 'unknown adapter'}>
      {ADAPTER_MONO[key]}
      <span className="vh">adapter {name || 'unknown'}</span>
    </span>
  )
}

/**
 * §2.3: the deduped adapter cluster, max 4 + "+n". The API already returns distinct
 * adapters in first-seen order (§6.2 RunSummary.adapters).
 */
export function AdapterCluster({ names, max = 4 }: { names: readonly string[]; max?: number }) {
  const shown = names.slice(0, max)
  const more = names.length - shown.length
  return (
    <span className="ad-cluster">
      {shown.map((n) => <AdapterBadge key={n} name={n} />)}
      {more > 0 ? <span className="more">+{more}</span> : null}
    </span>
  )
}
