// The run's Structure tab: its parallel() and pipeline() fan-outs as nested cards, each
// item's agents in stage order, so which work ran side by side reads at a glance.
import type { RenderElement } from 'claude-code'

import type {
  FlowitionCockpitLane as Lane,
  FlowitionCockpitTimeline as Timeline,
  FlowitionCockpitWorker as Worker,
} from '../types'
import type { Ctx } from './ctx'
import { buildStructure, clipDraw, fmtCost, fmtDuration, stateColor, TAB_BUDGET, type StructureNode } from './lib'

const lanesOf = (nodes: StructureNode[]): Lane[] =>
  nodes.flatMap((n) => (n.type === 'lane' ? [n.lane] : n.items.flatMap((it) => lanesOf(it.children))))

export function structureView(c: Ctx, tl: Timeline | null, workers: Worker[], openAgent: (index: number) => unknown, now: number, isLive: boolean): RenderElement {
  const { Box, Text } = c
  if (!tl) return <Text dimColor>Loading the structure…</Text>
  const tree = buildStructure(tl.lanes)
  if (!tree.length) return <Text dimColor>No agents have started yet.</Text>
  const costs = new Map(workers.map((w) => [w.id, w.cost]))

  // Every card, item row and chip draws within the tab's text budget, in the order
  // written, so the run's controls below always draw; what does not fit is counted.
  let room = TAB_BUDGET
  let omitted = 0
  const fits = (n: number): boolean => {
    if (n > room) return false
    room -= n
    return true
  }

  const took = (lane: Lane) => (lane.startedAt !== null && lane.endedAt !== null ? fmtDuration(lane.endedAt - lane.startedAt) : null)

  const chip = (lane: Lane) => {
    if (!fits(Math.min(lane.label.length, 200) + 60)) {
      omitted++
      return null
    }
    return (
      <Box key={`chip:${lane.id}`} gap={1} flexShrink={1} minWidth={0}>
        <Text color={stateColor(lane.state)}>●</Text>
        {lane.kind === 'agent' && lane.index !== null ? (
          c.btn(`st:${lane.id}`, clipDraw(lane.label, 200), () => openAgent(lane.index as number), 'plain')
        ) : (
          <Text wrap="truncate-end">⚙ {clipDraw(lane.label, 200)}</Text>
        )}
        {took(lane) ? <Text dimColor>{took(lane)}</Text> : null}
      </Box>
    )
  }

  // A fan-out's span: start to finish once every lane has ended; while one has not, to
  // now on a live run ("so far"), or to the last any lane was heard from on an ended one.
  const span = (lanes: Lane[]): string | null => {
    const starts = lanes.map((l) => l.startedAt ?? l.queuedAt).filter((x): x is number => x !== null)
    if (!starts.length) return null
    const from = Math.min(...starts)
    if (lanes.every((l) => l.endedAt !== null)) return fmtDuration(Math.max(...lanes.map((l) => l.endedAt as number)) - from)
    if (isLive) return `${fmtDuration(now - from)} so far`
    return fmtDuration(Math.max(...lanes.map((l) => l.endedAt ?? l.lastSeenAt)) - from)
  }

  const fanout = (n: Extract<StructureNode, { type: 'fanout' }>): RenderElement | null => {
    const lanes = lanesOf([n])
    if (!fits(120)) {
      omitted += lanes.length
      return null
    }
    const done = lanes.filter((l) => l.state === 'done' || l.state === 'cached').length
    const cost = lanes.reduce((sum, l) => sum + (costs.get(l.id) ?? 0), 0)
    const facts = [`${done}/${lanes.length} done`, span(lanes), cost ? fmtCost(cost) : null].filter(Boolean)
    const isPipeline = n.kind === 'pipeline'
    return (
      <Box key={`fan:${n.key}`} borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
        <Box justifyContent="space-between" gap={1} flexWrap="wrap">
          <Text bold>
            {n.kind}({n.count ?? n.items.length}){isPipeline && n.stages ? ` · ${n.stages} stages` : ''}
          </Text>
          <Text dimColor>{facts.join(' · ')}</Text>
        </Box>
        {n.items.map((it) => {
          if (!fits(40)) {
            omitted += lanesOf(it.children).length
            return null
          }
          const lanesHere = it.children.filter((x): x is Extract<StructureNode, { type: 'lane' }> => x.type === 'lane')
          const nested = it.children.filter((x): x is Extract<StructureNode, { type: 'fanout' }> => x.type === 'fanout')
          return (
            <Box key={`item:${n.key}:${it.i}`} gap={1} alignItems="flex-start">
              <Box minWidth={7} flexShrink={0}>
                <Text dimColor>item {it.i}</Text>
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={1}>
                {lanesHere.length ? (
                  <Box gap={1} flexWrap="wrap" alignItems="center">
                    {lanesHere.flatMap((x, k) =>
                      k > 0 && isPipeline
                        ? [
                            <Box key={`arrow:${x.lane.id}`}>
                              <Text dimColor>→</Text>
                            </Box>,
                            chip(x.lane),
                          ]
                        : [chip(x.lane)],
                    )}
                  </Box>
                ) : null}
                {nested.map(fanout)}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  }

  const drawn = tree.map((n) => (n.type === 'lane' ? chip(n.lane) : fanout(n)))
  return (
    <Box key="structure" flexDirection="column" gap={1}>
      {drawn}
      {omitted ? (
        <Text dimColor wrap="wrap">
          {omitted} more agents and steps not drawn here (a pane draws so much text); the viewer shows the whole structure.
        </Text>
      ) : null}
      <Text dimColor wrap="wrap">
        Top-level agents and steps in the order they began; each fan-out's items with their agents{' '}
        {tree.some((n) => n.type === 'fanout' && n.kind === 'pipeline') ? '(a pipeline item’s stages read left to right)' : ''}.
      </Text>
    </Box>
  )
}
