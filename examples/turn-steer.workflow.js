// Turn-steering smoke: codex can't take stdin mid-turn, so the queued message is
// delivered as a `codex exec resume` follow-up turn after the first turn completes.
export const meta = { name: 'turn-steer-smoke', description: 'queued mail → session-resume follow-up turn on codex' }

export default async function ({ spawn }) {
  const h = spawn('Reply with exactly: ready', {
    adapter: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'low',
    label: 'worker',
  })
  h.send('Follow-up: append the word "starlight" to your previous answer and reply with both words.')
  return h.done
}
