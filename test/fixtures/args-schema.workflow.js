export const meta = {
  name: 'args-schema',
  description: 'validates --args against meta.argsSchema before any work starts',
  argsSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', minLength: 1 },
      dryRun: { type: 'boolean' },
    },
    required: ['target'],
    additionalProperties: false,
  },
}

export default async function ({ agent, args }) {
  const echoed = await agent(`ECHO ${args.target}`, { adapter: 'mock' })
  return { echoed, args }
}
