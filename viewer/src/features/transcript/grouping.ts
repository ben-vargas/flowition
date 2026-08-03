import type {
  OrphanResultItem,
  TimelineItem,
  TimelineUnit,
  ToolItem,
} from './types.js'

const work = (item: TimelineItem): item is ToolItem | OrphanResultItem =>
  item.kind === 'tool' || item.kind === 'orphan-result'

/** Text/reasoning/mail (and every other non-work row) closes a step (§9.6). */
export function groupTimeline(items: readonly TimelineItem[]): TimelineUnit[] {
  const units: TimelineUnit[] = []
  let current: (ToolItem | OrphanResultItem)[] = []

  const flush = () => {
    if (!current.length) return
    const first = current[0]!
    units.push({
      kind: 'step',
      id: `step:${first.id}`,
      items: current,
      t: first.t,
      attempt: first.attempt,
      pending: current.some((item) => item.kind === 'tool' && item.result == null),
    })
    current = []
  }

  for (const item of items) {
    if (work(item)) {
      if (current.length && current[0]!.attempt !== item.attempt) flush()
      current.push(item)
      continue
    }
    flush()
    units.push({ kind: 'row', id: item.id, item, t: item.t, attempt: item.attempt })
  }
  flush()
  return units
}

export function autoStepExpanded(unit: TimelineUnit, index: number, total: number, live: boolean): boolean {
  if (unit.kind !== 'step') return true
  return unit.items.length === 1 || unit.pending || (live && index === total - 1)
}

/**
 * IDs that may own a manual disclosure choice in the retained window. Prompt records are
 * hoisted within each attempt exactly as TranscriptPane renders them. Step IDs are derived
 * without constructing a second TimelineUnit tree on every live append.
 */
export function retainedManualIds(items: readonly TimelineItem[]): Set<string> {
  const retained = new Set<string>()
  const attempts = new Map<number, TimelineItem[]>()
  for (const item of items) {
    retained.add(item.id)
    if (item.kind === 'tool' && item.card === 'file') {
      const count = Math.max(1, item.files.length)
      for (let index = 0; index < count; index++) retained.add(`${item.id}:file:${index}`)
    }
    const list = attempts.get(item.attempt)
    if (list) list.push(item)
    else attempts.set(item.attempt, [item])
  }
  for (const attemptItems of attempts.values()) {
    const ordered = [
      ...attemptItems.filter((item) => item.kind === 'prompt'),
      ...attemptItems.filter((item) => item.kind !== 'prompt' && item.kind !== 'attempt'),
    ]
    let inStep = false
    for (const item of ordered) {
      const isWork = work(item)
      if (isWork && !inStep) retained.add(`step:${item.id}`)
      inStep = isWork
    }
  }
  return retained
}
