export const meta = { name: 'resume-test', description: 'first agent must replay, second recovers on resume' }

export default async function ({ agent }) {
  const a = await agent('FAILN acounter 0', { adapter: 'mock', label: 'stable' })
  const b = await agent('FAILN bcounter 1', { adapter: 'mock', label: 'flaky' })
  return { a, b }
}
