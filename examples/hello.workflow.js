// Single-agent smoke test: flowition run examples/hello.workflow.js --args '{"adapter":"codex"}'
export const meta = { name: 'hello', description: 'one tiny agent on the chosen adapter' }

export default async function ({ agent, args }) {
  const a = args ?? {}
  return agent('Reply with exactly the single word: pong', {
    adapter: a.adapter,
    model: a.model,
    effort: a.effort,
  })
}
