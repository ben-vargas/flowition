// Durable steps + an input contract. --args is validated against meta.argsSchema
// before ANY work starts; each completed step() callback's JSON result is
// journaled, so `flowition resume` replays completed steps instead of re-running
// their side effects (incomplete or failed steps re-run). Try: run it, kill it mid-run, then resume — completed steps
// report "replayed from journal".
//
//   flowition run examples/durable-steps.workflow.js --args '{"name":"demo"}'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const meta = {
  name: 'durable-steps',
  description: 'journaled side-effect steps with a validated input contract',
  argsSchema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1 } },
    required: ['name'],
    additionalProperties: false,
  },
}

export default async function ({ step, agent, log, args }) {
  // A side effect wrapped in step(): completed results replay on resume.
  const workspace = await step('make-workspace', { name: args.name }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flo-${args.name}-`))
    return { dir }
  })
  log(`workspace: ${workspace.dir}`)

  const plan = await agent(
    `Write a one-line haiku about durable workflows. Reply with the haiku only.`,
    { label: 'poet' },
  )

  // Steps see agent results; changed args would be a DIFFERENT step.
  await step('save-plan', { dir: workspace.dir }, () => {
    fs.writeFileSync(path.join(workspace.dir, 'haiku.txt'), String(plan))
    // a void callback is fine — it resolves to null
  })

  return { workspace: workspace.dir, plan }
}
