// The SLEEP→WAIT_MAIL cancel window (H1): the agent is sleeping when the cancel
// arrives, so `AgentJob.cancel()` drains an EMPTY waiter list; the adapter then
// wakes from the sleep and registers its WAIT_MAIL waiter a tick later. Without
// the closed-waiter-list fix nothing ever resolves it, the control socket has
// already answered `{ok:true}`, and the run stays live forever.
export const meta = { name: 'cancel-waitmail-test', description: 'sleeper that waits for mail after waking' }

export default async function ({ agent }) {
  return agent('SLEEP 60000\nWAIT_MAIL\nECHO never', { adapter: 'mock', label: 'sleepwaiter' })
}
