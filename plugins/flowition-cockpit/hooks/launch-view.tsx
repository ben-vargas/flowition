// The new-run form: pick a workflow file from ~/.flowition/workflows, give it args if
// it takes any, and start it detached. Its agents run with full permissions in the
// session's folder, which the form says before the button.
import type { RenderElement } from 'claude-code'

import type { FlowitionCockpitWorkflowFile as WorkflowFile } from '../types'
import type { Ctx } from './ctx'
import { fmtAge } from './lib'

export type LaunchState = { file: string | null; args: string; error: string | null; query: string; limit: number; isStarting?: boolean; cwd?: string | null; failures?: number }

export function launchView(
  c: Ctx,
  launch: LaunchState,
  workflows: WorkflowFile[],
  cwd: string,
  actions: {
    pick: (file: string) => unknown
    filter: (query: string) => unknown
    more: () => unknown
    args: (text: string) => unknown
    start: () => unknown
    close: () => unknown
  },
): RenderElement {
  const { Box, Text, Input } = c
  const chosen = workflows.find((w) => w.path === launch.file)
  // Every workflow is reachable: a filter by name or project, then more on request.
  const q = (launch.query ?? '').trim().toLowerCase()
  const matching = q ? workflows.filter((w) => `${w.project}/${w.name}`.toLowerCase().includes(q)) : workflows
  const shown = matching.slice(0, launch.limit ?? 20)
  return (
    <Box key="launch" flexDirection="column" gap={1} width="100%">
      <Box gap={1} alignItems="center">
        {c.btn('launch-close', '‹ Runs', actions.close)}
        <Text bold>New run</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>Workflow</Text>
        {workflows.length ? null : <Text dimColor>No workflow files under ~/.flowition/workflows yet.</Text>}
        {Input && workflows.length > 10 ? (
          <Box marginTop={1}>
            <Input key="launch-filter" placeholder="Filter workflows" onInput={(text) => actions.filter(text)} onSubmit={(text) => actions.filter(text)} />
          </Box>
        ) : null}
        {q && !matching.length ? <Text dimColor>No workflow matches “{launch.query}”.</Text> : null}
        {shown.map((w) => {
          const isChosen = w.path === launch.file
          return (
            <Box
              key={`wf:${w.path}`}
              borderStyle="round"
              {...(isChosen ? { borderColor: 'suggestion' as const } : { borderDimColor: true })}
              hover={{ borderColor: 'suggestion' }}
              paddingX={1}
              marginTop={1}
            >
              {c.face(`wf:${w.path}`, { title: `${isChosen ? '● ' : ''}${w.name}`, subtitle: `${w.project} · edited ${fmtAge(c.now, w.mtimeMs)}`, lines: [] }, () => actions.pick(w.path), () =>
                c.btn(`wf-pick:${w.path}`, `${w.project}/${w.name}`, () => actions.pick(w.path), 'plain'),
              )}
            </Box>
          )
        })}
        {matching.length > shown.length ? (
          <Box gap={1} alignItems="center" marginTop={1}>
            {c.btn('launch-more', 'Show more', actions.more)}
            <Text dimColor>{matching.length - shown.length} more</Text>
          </Box>
        ) : null}
      </Box>
      {chosen ? (
        <Box key="launch-form" flexDirection="column" gap={1}>
          {Input ? (
            <Input
              key={`launch-args:${chosen.path}:${launch.failures ?? 0}`}
              // Bound to the form's args, which Start and Enter launch with: what the
              // field shows is what runs, whatever draft a surface kept under this key.
              // A failed launch draws the field afresh (a new key): a surface that cleared
              // it on submit shows the args the form still holds for the retry.
              value={launch.args}
              label="Args (JSON, optional)"
              placeholder='{"topic": "..."}'
              submitLabel="Start"
              onInput={(text) => actions.args(text)}
              onSubmit={() => actions.start()}
            />
          ) : null}
          {launch.error ? (
            <Text color="error" wrap="wrap">
              {launch.error}
            </Text>
          ) : null}
          <Text dimColor wrap="wrap">
            Its agents run with full permissions in {cwd}, detached: the run goes on if this session ends.
          </Text>
          <Box gap={1}>
            {c.btn('launch-start', launch.isStarting ? 'Starting…' : `Start ${chosen.name}`, actions.start, 'primary')}
            {c.btn('launch-cancel', 'Cancel', actions.close)}
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}
