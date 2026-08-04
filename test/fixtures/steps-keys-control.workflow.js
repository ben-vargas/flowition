// Control for the key-independence test: the SAME agent call as
// steps.workflow.js, with no step() calls before it. Both must derive the
// identical agent resume key — steps use their own counter.
export const meta = { name: 'steps-keys-control', description: 'agent call without preceding steps' }

export default async function ({ agent }) {
  return agent('ECHO after-steps', { adapter: 'mock' })
}
