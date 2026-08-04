export const meta = {
  name: 'args-schema-unsupported',
  description: 'argsSchema uses a keyword the validator does not implement — must fail loudly',
  argsSchema: {
    type: 'object',
    properties: { target: { type: 'string', pattern: '^x' } },
  },
}

export default async function ({ agent }) {
  return agent('ECHO should-never-run', { adapter: 'mock' })
}
