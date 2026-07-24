// Live-steering smoke: the workflow injects a second user message into a live
// claude agent while its first turn is still running.
export const meta = { name: 'steer-smoke', description: 'live mid-run steering of a claude agent' }

export default async function ({ spawn }) {
  const h = spawn(
    'You will receive a follow-up message containing a codeword. First reply "waiting". When the follow-up message arrives, reply with exactly the codeword and nothing else.',
    { adapter: 'claude', model: 'claude-sonnet-5', effort: 'low', label: 'listener' },
  )
  h.send('The codeword is: thimbleberry')
  return h.done
}
