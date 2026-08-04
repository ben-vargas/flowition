// Durable step() exercise. Side effects are counted in a file (args.counterFile)
// so a resumed run — a fresh module instance — can prove which callbacks re-ran.
import fs from 'node:fs'

export const meta = { name: 'steps', description: 'step(): memoization, void result, parallel branches, failure re-run' }

export default async function ({ step, agent, parallel, args }) {
  const bump = (k) => {
    const c = JSON.parse(fs.readFileSync(args.counterFile, 'utf8'))
    c[k] = (c[k] ?? 0) + 1
    fs.writeFileSync(args.counterFile, JSON.stringify(c))
    return c[k]
  }
  const a = await step('alpha', { n: 1 }, () => ({ ran: bump('alpha') }))
  const v = await step('void-step', () => { bump('void') })
  const par = await parallel([1, 2].map((n) => () => step(`par-${n}`, { n }, () => ({ n, ran: bump(`par${n}`) }))))
  const echoed = await agent('ECHO after-steps', { adapter: 'mock' })
  // Fails on its first execution, succeeds on the next — a failed step must
  // re-run on resume while every completed step above replays from the journal.
  const flaky = await step('flaky', {}, () => {
    const n = bump('flaky')
    if (n === 1) throw new Error('flaky boom')
    return { n }
  })
  return { a, v, par, echoed, flaky }
}
