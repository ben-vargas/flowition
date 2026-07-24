export const meta = { name: 'steer-test', description: 'agent blocks on operator mail' }

export default async function ({ spawn }) {
  const h = spawn('WAIT_MAIL', { adapter: 'mock', label: 'steerme' })
  return h.done
}
