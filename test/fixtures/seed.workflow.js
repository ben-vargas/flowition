// Cross-run seeding exercise (--seed-from). Four shapes, one per rule:
//   stable  — derived key, constant call: identical across runs, so it SEEDS.
//   tuned   — derived key with a keyed field (model) taken from args: same args
//             seed, a changed model derives a new key and MISSES.
//   pinned  — explicit o.key: never consults the seed map, always re-executes.
//   bump    — durable step(): steps never seed; the counter file proves the
//             callback re-ran in the target run.
import fs from 'node:fs'

export const meta = { name: 'seed', description: 'cross-run seeding: derived hit, keyed miss, explicit key, durable step' }

export default async function ({ agent, step, args }) {
  const bump = (k) => {
    const c = JSON.parse(fs.readFileSync(args.counterFile, 'utf8'))
    c[k] = (c[k] ?? 0) + 1
    fs.writeFileSync(args.counterFile, JSON.stringify(c))
    return c[k]
  }
  const stable = await agent('ECHO stable', { adapter: 'mock', label: 'stable' })
  const tuned = await agent('ECHO tuned', { adapter: 'mock', model: args.model, label: 'tuned' })
  const pinned = await agent('ECHO pinned', { adapter: 'mock', key: 'pinned-key', label: 'pinned' })
  const stepped = await step('bump', () => ({ ran: bump('step') }))
  return { stable, tuned, pinned, stepped }
}
