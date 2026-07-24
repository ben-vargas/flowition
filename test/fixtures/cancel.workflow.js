export const meta = { name: 'cancel-test', description: 'long sleeper for cancel tests' }

export default async function ({ agent }) {
  return agent('SLEEP 60000\nECHO never', { adapter: 'mock', label: 'sleeper' })
}
