// The run's Log tab: its narrative in order, from the events the timeline already reads:
// the workflow's log() lines, phases, messages in and out, questions and answers, and
// each agent's start and end.
import type { RenderElement } from 'claude-code'

import type { FlowitionCockpitTimeline as Timeline } from '../types'
import type { Ctx } from './ctx'
import { fmtClock } from './lib'

const TAG: Record<Timeline['entries'][number]['kind'], string> = {
  log: 'log',
  'mail-in': 'you →',
  'mail-out': 'post',
  question: 'asks',
  answer: 'answer',
  phase: 'phase',
  run: 'run',
  agent: 'agent',
}

export function logView(c: Ctx, tl: Timeline | null): RenderElement {
  const { Box, Text } = c
  if (!tl) return <Text dimColor>Loading the log…</Text>
  if (!tl.entries.length) return <Text dimColor>Nothing logged yet.</Text>
  return (
    <Box key="log" flexDirection="column">
      {tl.isEntriesCut ? <Text dimColor>Showing the newest {tl.entries.length} entries; the viewer has the rest.</Text> : null}
      {tl.entries.map((en, i) => (
        <Box key={`log:${i}`} gap={1}>
          <Box minWidth={9} flexShrink={0}>
            <Text dimColor>{fmtClock(en.t)}</Text>
          </Box>
          <Box minWidth={7} flexShrink={0}>
            <Text bold {...(en.tone ? { color: en.tone } : { dimColor: true })}>
              {TAG[en.kind]}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="wrap" {...(en.tone === 'inactive' ? { dimColor: true } : {})}>
              {en.text}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}
