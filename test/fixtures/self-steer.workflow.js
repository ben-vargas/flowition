export const meta = { name: 'self-steer', description: 'workflow steers its own agent' }

export default async function ({ spawn }) {
  const h = spawn('WAIT_MAIL', { adapter: 'mock', label: 'listener' })
  h.send('from-workflow')
  return h.done
}
