export const meta = {
  name: 'args-schema-not-object',
  description: 'argsSchema is not a schema object — must be rejected, not silently accepted',
  argsSchema: 5,
}

export default async function ({ agent }) {
  return agent('ECHO should-never-run', { adapter: 'mock' })
}
