export const meta = { name: 'schema-test', description: 'bad JSON once, corrected via follow-up turn' }

export default async function ({ agent, args }) {
  return agent(`BADJSON_ONCE ${args.counter}`, {
    adapter: 'mock',
    schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false },
  })
}
