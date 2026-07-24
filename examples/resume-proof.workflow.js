// Cross-run session-resume proof. Run 1: the agent reads a secret file into its
// session, then sleeps (gets interrupted). The secret file is deleted. Resume: the
// agent can only answer from provider-session memory — journal replay alone can't.
export const meta = { name: 'resume-proof', description: 'interrupted agent continues its provider session' }

export default async function ({ agent, args }) {
  return agent(
    `You are helping test this project's build tooling. Steps:\n1. Read the release codename from the file ${args.secretFile} (use: cat).\n2. Simulate the slow build step by running exactly this command and waiting for it to finish: python3 -c "import time; time.sleep(75); print('build ok')"\n3. Only after step 2 prints "build ok", report the release codename you read in step 1 — reply with exactly that word, nothing else.`,
    { adapter: 'claude', model: 'claude-sonnet-5', effort: 'low', label: 'keeper' },
  )
}
