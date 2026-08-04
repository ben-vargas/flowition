// The validator itself THROWS on this schema (a getter detonates mid-walk) —
// modeling any validator crash the structural checks did not anticipate. The
// engine's admission gate must convert the throw into the same terminal
// failed-run artifacts as returned validation errors.
export const meta = {
  name: 'args-schema-throwing',
  description: 'argsSchema whose evaluation throws — must still produce terminal run artifacts',
  argsSchema: {
    get type() {
      throw new Error('boom from schema getter')
    },
  },
}

export default async function ({ agent }) {
  return agent('ECHO should-never-run', { adapter: 'mock' })
}
