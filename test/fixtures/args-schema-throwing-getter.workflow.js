// The `meta.argsSchema` PROPERTY READ itself throws — the admission gate's
// exception boundary must cover the retrieval, not just the validation.
export const meta = {
  name: 'args-schema-throwing-getter',
  description: 'meta.argsSchema getter throws — must still produce terminal run artifacts',
  get argsSchema() {
    throw new Error('boom from meta getter')
  },
}

export default async function ({ agent }) {
  return agent('ECHO should-never-run', { adapter: 'mock' })
}
