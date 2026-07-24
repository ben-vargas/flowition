export const meta = { name: 'basic', description: 'exercise agent/parallel/pipeline/phase/log' }

export default async function ({ agent, parallel, pipeline, phase, log, args, now, random }) {
  phase('One')
  const single = await agent('ECHO hello', { adapter: 'mock' })
  phase('Two')
  const par = await parallel([1, 2, 3].map((n) => () => agent(`ECHO p${n}`, { adapter: 'mock', label: `par${n}` })))
  const piped = await pipeline(
    ['a', 'b'],
    (x) => agent(`ECHO s1-${x}`, { adapter: 'mock' }),
    (prev, item) => agent(`ECHO s2-${prev}-${item}`, { adapter: 'mock' }),
  )
  log('all done')
  const t = now()
  const r = random()
  return { single, par, piped, args: args ?? null, tOk: typeof t === 'number', rOk: r >= 0 && r < 1 }
}
