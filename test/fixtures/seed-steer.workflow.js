// Target-side steering vs a seed hit. The steering exclusion is SOURCE-side
// only: run 1 (steer: false) never mails the agent, so its key is seedable.
// Run 2 (steer: true, --seed-from run 1) sends through the spawn handle — but
// the seeded result is materialized before the handle can deliver, so the send
// reports 'pending', the queued mail is dropped with a warning at settle, and
// a post-settle send reports 'dropped'. Same semantics as same-run cache replay.
export const meta = { name: 'seed-steer', description: 'target-side steering cannot invalidate a seed hit' }

export default async function ({ spawn, args }) {
  const h = spawn('ECHO steerable', { adapter: 'mock', label: 'steerable' })
  const delivery = args.steer ? h.send('late guidance') : null
  const result = await h.done
  const post = args.steer ? h.send('after settle') : null
  return { result, delivery, post }
}
