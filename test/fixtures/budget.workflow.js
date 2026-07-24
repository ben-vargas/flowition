export const meta = { name: 'budget', description: 'two sequential agents for budget-ceiling tests' }

export default async function ({ agent }) {
  const a = await agent('ECHO a')
  const b = await agent('ECHO b')
  return a + b
}
