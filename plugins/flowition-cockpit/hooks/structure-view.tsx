// The run's Structure tab: its parallel() and pipeline() fan-outs as nested cards, each
// item's agents in stage order, so which work ran side by side reads at a glance.
import type { RenderElement } from 'claude-code'

import type {
  FlowitionCockpitLane as Lane,
  FlowitionCockpitTimeline as Timeline,
  FlowitionCockpitWorker as Worker,
} from '../types'
import type { Ctx } from './ctx'
import { buildStructure, fmtCost, fmtDuration, stateColor, type StructureNode } from './lib'

const lanesOf = (nodes: StructureNode[]): Lane[] =>
  nodes.flatMap((n) => (n.type === 'lane' ? [n.lane] : n.items.flatMap((it) => lanesOf(it.children))))

export function structureView(c: Ctx, tl: Timeline | null, workers: Worker[], openAgent: (index: number) => unknown): RenderElement {
  const { Box, Text } = c
  if (!tl) return <Text dimColor>Loading the structure…</Text>
  const tree = buildStructure(tl.lanes)
  if (!tree.length) return <Text dimColor>No agents have started yet.</Text>
  const costs = new Map(workers.map((w) => [w.id, w.cost]))

  const took = (lane: Lane) => (lane.startedAt !== null && lane.endedAt !== null ? fmtDuration(lane.endedAt - lane.startedAt) : null)

  const chip = (lane: Lane) => (
    <Box key={`chip:${lane.id}`} gap={1} flexShrink={1} minWidth={0}>
      <Text color={stateColor(lane.state)}>●</Text>
      {lane.kind === 'agent' && lane.index !== null ? (
        c.btn(`st:${lane.id}`, lane.label, () => openAgent(lane.index as number), 'plain')
      ) : (
        <Text wrap="truncate-end">⚙ {lane.label}</Text>
      )}
      {took(lane) ? <Text dimColor>{took(lane)}</Text> : null}
    </Box>
  )

  const fanout = (n: Extract<StructureNode, { type: 'fanout' }>): RenderElement => {
    const lanes = lanesOf([n])
    const done = lanes.filter((l) => l.state === 'done' || l.state === 'cached').length
    const starts = lanes.map((l) => l.startedAt ?? l.queuedAt).filter((x): x is number => x !== null)
    const ends = lanes.map((l) => l.endedAt).filter((x): x is number => x !== null)
    const cost = lanes.reduce((sum, l) => sum + (costs.get(l.id) ?? 0), 0)
    const facts = [
      `${done}/${lanes.length} done`,
      starts.length && ends.length ? fmtDuration(Math.max(...ends) - Math.min(...starts)) : null,
      cost ? fmtCost(cost) : null,
    ].filter(Boolean)
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

  return (
    <Box key="structure" flexDirection="column" gap={1}>
      {tree.map((n) => (n.type === 'lane' ? chip(n.lane) : fanout(n)))}
      <Text dimColor wrap="wrap">
        Top-level agents and steps in the order they began; each fan-out's items with their agents{' '}
        {tree.some((n) => n.type === 'fanout' && n.kind === 'pipeline') ? '(a pipeline item’s stages read left to right)' : ''}.
      </Text>
    </Box>
  )
}
