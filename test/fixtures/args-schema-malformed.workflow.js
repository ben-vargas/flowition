export const meta = {
  name: 'args-schema-malformed',
  description: 'argsSchema with a malformed shape (non-array anyOf) — must be rejected loudly, not crash the validator',
  argsSchema: { anyOf: { type: 'string' } },
}

export default async function ({ agent }) {
  return agent('ECHO should-never-run', { adapter: 'mock' })
}
