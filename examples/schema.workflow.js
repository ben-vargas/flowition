// Structured-output smoke: same schema across the three enforcement modes
// (claude: native --json-schema, codex: native --output-schema file, opencode/pi/amp/droid: prompt contract)
export const meta = { name: 'schema-smoke', description: 'structured output across adapters' }

const SCHEMA = {
  type: 'object',
  required: ['language', 'reason'],
  additionalProperties: false,
  properties: {
    language: { type: 'string' },
    reason: { type: 'string' },
  },
}

export default async function ({ agent, parallel, args }) {
  const adapters = args?.adapters ?? ['claude', 'codex', 'opencode']
  const results = await parallel(
    adapters.map((a) => () =>
      agent('In one short sentence: name your favorite programming language and why.', {
        adapter: a,
        model: a === 'claude' ? 'claude-sonnet-5' : a === 'codex' ? 'gpt-5.6-sol' : undefined,
        effort: 'low',
        schema: SCHEMA,
        label: `schema:${a}`,
      }),
    ),
  )
  return Object.fromEntries(adapters.map((a, i) => [a, results[i]]))
}
