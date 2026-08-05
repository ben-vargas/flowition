// A FAILED source run still seeds its COMPLETED results (--seed-from accepts any
// settled run). `stable` completes on every execution; `flaky` fails its first
// (FAILN counters persist in $FLOWITION_HOME across runs), so run 1 ends failed
// with one completed record — exactly the shape a seeded retry wants to reuse.
export const meta = { name: 'seed-flaky', description: 'failed source run seeds its completed results' }

export default async function ({ agent, args }) {
  const stable = await agent('ECHO flaky-stable', { adapter: 'mock', label: 'stable' })
  const flaky = await agent(`FAILN ${args.counter} 1`, { adapter: 'mock', label: 'flaky' })
  return { stable, flaky }
}
